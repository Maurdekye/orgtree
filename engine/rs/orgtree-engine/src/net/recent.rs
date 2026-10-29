//! The Connections lists' order, and this computer's hub's registrations.
//!
//! Org settings → Connections and App settings → Mail hub list connections
//! online first, then by the newest mail exchanged with each, either way;
//! none last, A-Z (USER 2026-10-29 m3e3829f0bf18: "sorted online first then
//! offline below, and also within those groups ordered by most recent
//! correspondence with the org"). The renderer sorts: the rosters already
//! reach it whole in the tree's net block, and presence moves rows between the
//! groups, so paging here would skip or repeat rows. This module supplies only
//! the times. Each is one backward probe of ot.org_inbox (org_id, peer, at)
//! (migration 0078), so a read is bounded by the addresses listed, never by
//! the mail history.
//!
//! App settings → Mail hub lists everyone registered on this computer's hub
//! (USER m12a433749fda), from the hub's own read-only operator view
//! (`GET /ui/data` on its main port: no credential is sent, nothing changes).
//! Its order uses the newest mail the orgs here that use that hub exchanged
//! with each address, and for one of those orgs' own address, its own newest
//! mail with the others. Mail between two outside parties is the hub's own
//! record, which Orgtree does not read.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::engine::Engine;

/// Addresses one read covers at most; a list longer than this sorts the rest A-Z.
pub const MAX_ADDRESSES: usize = 5000;
/// Probes (orgs × addresses) one read makes at most.
pub const MAX_PROBES: usize = 50_000;
/// How long the hub's operator view may take to answer.
const UI_DATA_TIMEOUT: Duration = Duration::from_secs(5);
/// The roster fields a connection row carries to the renderer.
const ROW_FIELDS: [&str; 9] = ["slug", "org_name", "username", "blurb", "online", "last_seen", "kind", "picture", "picture_owner"];

/// Each (org, address) pair's newest mail: one backward probe of
/// `org_inbox_peer_at` per pair; a pair with none gives no row.
pub(crate) const NEWEST_SQL: &str = "SELECT o.id, p.slug, x.at
       FROM unnest($1::bigint[]) AS o(id)
      CROSS JOIN unnest($2::text[]) AS p(slug)
      CROSS JOIN LATERAL (SELECT i.at FROM ot.org_inbox i
                           WHERE i.org_id = o.id AND i.peer = '@net:' || p.slug
                           ORDER BY i.at DESC LIMIT 1) x";

/// The newest mail between each org in `orgs` and each address in `slugs`
/// (bare hub slugs), either direction: one row per pair that has any.
#[logged]
pub async fn newest_mail(client: &tokio_postgres::Client, orgs: &[i64], slugs: &[String]) -> Result<Vec<(i64, String, DateTime<Utc>)>> {
    if orgs.is_empty() || slugs.is_empty() {
        return Ok(Vec::new());
    }
    let rows = client.query(NEWEST_SQL, &[&orgs, &slugs]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect())
}

/// Each address's order time (lowercased bare slug → newest mail): the newest
/// mail any of the orgs exchanged with it, and, for an address that is one of
/// those orgs' own (`own`: org id → its address), also that org's newest mail
/// with any address read.
#[logged]
pub fn newest_by_address(rows: &[(i64, String, DateTime<Utc>)], own: &HashMap<i64, String>) -> HashMap<String, DateTime<Utc>> {
    let mut out: HashMap<String, DateTime<Utc>> = HashMap::new();
    let mut note = |address: &str, at: DateTime<Utc>| {
        let seen = out.entry(address.to_lowercase()).or_insert(at);
        if at > *seen {
            *seen = at;
        }
    };
    for (org, slug, at) in rows {
        note(slug, *at);
        if let Some(address) = own.get(org) {
            note(address, *at);
        }
    }
    out
}

/// The wire form: `{ slug: ISO time }`.
#[logged]
fn recent_json(times: &HashMap<String, DateTime<Utc>>) -> Value {
    let mut keys: Vec<&String> = times.keys().collect();
    keys.sort();
    Value::Object(keys.into_iter().map(|k| (k.clone(), json!(crate::util::iso(times[k])))).collect())
}

/// Distinct non-empty slugs in order, at most `max`.
#[logged]
fn distinct_slugs<'a>(rows: impl Iterator<Item = &'a Value>, max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for slug in rows.filter_map(|r| r["slug"].as_str()).filter(|s| !s.is_empty()) {
        if out.len() >= max {
            break;
        }
        if seen.insert(slug.to_string()) {
            out.push(slug.to_string());
        }
    }
    out
}

/// `GET /api/orgs/{slug}/net/recent`: this org's newest mail with each address
/// its hubs list, exactly the rosters its net block shows.
#[logged]
pub async fn org_recent(engine: &Engine, org_id: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    let org = crate::feed::compute::org_row(&client, org_id).await?;
    let block = super::block(engine, &client, &org).await?;
    let rosters = block["hubs"].as_array().into_iter().flatten().flat_map(|h| h["roster"].as_array().into_iter().flatten());
    let slugs = distinct_slugs(rosters, MAX_ADDRESSES);
    let rows = newest_mail(&client, &[org_id], &slugs).await?;
    Ok(json!({ "recent": recent_json(&newest_by_address(&rows, &HashMap::new())) }))
}

/// The hub's operator view: every registered address with its presence.
#[logged]
async fn ui_data(address: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::builder().timeout(UI_DATA_TIMEOUT).no_proxy().build().map_err(|e| e.to_string())?;
    let r = client.get(format!("{}/ui/data", address.trim_end_matches('/'))).send().await
        .map_err(|e| format!("the hub did not answer ({e})"))?;
    if !r.status().is_success() {
        return Err(format!("the hub answered {}", r.status()));
    }
    let v: Value = r.json().await.map_err(|e| format!("the hub's answer could not be read ({e})"))?;
    Ok(v["orgs"].as_array().cloned().unwrap_or_default())
}

/// A connection row with only the roster's own fields.
#[logged]
fn connection_row(raw: &Value) -> Option<Value> {
    raw["slug"].as_str().filter(|s| !s.is_empty())?;
    let mut row = Map::new();
    for key in ROW_FIELDS {
        if let Some(v) = raw.get(key).filter(|v| !v.is_null()) {
            row.insert(key.to_string(), v.clone());
        }
    }
    Some(Value::Object(row))
}

/// `GET /api/desktop/hub/connections`: everyone registered on this computer's
/// hub, from its operator view on the main port, and the newest mail each
/// address exchanged with an org here that uses the hub. A hub that is not
/// running lists nothing; one that does not answer says why.
#[logged]
pub async fn hub_connections(engine: &Arc<Engine>) -> Value {
    let Some(address) = engine.hub.address.load_full() else {
        return json!({ "running": false, "connections": [], "recent": {} });
    };
    let raw = match ui_data(&address).await {
        Ok(raw) => raw,
        Err(error) => return json!({ "running": true, "connections": [], "recent": {}, "error": error }),
    };
    let rows: Vec<Value> = raw.iter().filter_map(connection_row).collect();
    // the orgs here registered on this hub, and their own addresses
    let local = super::normalize_address(&address);
    let mut orgs = Vec::new();
    let mut own = HashMap::new();
    for p in engine.net.parts.load().iter() {
        if p.hubs.iter().any(|(hid, addr)| p.registered.contains(hid) && super::normalize_address(addr) == local) {
            orgs.push(p.org_id);
            own.insert(p.org_id, p.net_slug.clone());
        }
    }
    let per_org = (MAX_PROBES / orgs.len().max(1)).min(MAX_ADDRESSES);
    let slugs = distinct_slugs(rows.iter(), per_org);
    // no org here uses the hub: nothing to read
    let recent = if orgs.is_empty() || slugs.is_empty() {
        json!({})
    } else {
        match engine.db.get().await {
            Ok(client) => match newest_mail(&client, &orgs, &slugs).await {
                Ok(found) => recent_json(&newest_by_address(&found, &own)),
                Err(error) => {
                    tracing::warn!(%error, "hub connections: newest mail not read");
                    json!({})
                }
            },
            Err(error) => {
                tracing::warn!(%error, "hub connections: no database connection");
                json!({})
            }
        }
    };
    json!({ "running": true, "connections": rows, "recent": recent })
}

#[cfg(test)]
#[path = "recent_tests.rs"]
mod tests;
