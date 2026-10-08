//! The org inbox: the organization's one face to the outside world (other
//! orgs on this machine, and hosts reached through the mail hub).

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::domain::mail::{self, From, Outgoing, Sent};
use crate::domain::tree::ts;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::util::uid;

/// An `org_inbox` row → `OrgInboxEntry`.
pub fn entry(r: &Value) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), r["uid"].clone());
    o.insert("dir".into(), r["dir"].clone());
    o.insert("peer".into(), r["peer"].clone());
    o.insert("body".into(), r["body"].clone());
    o.insert("at".into(), ts(&r["at"]));
    if let Some(b) = r.get("by_name").filter(|v| !v.is_null()) {
        o.insert("by".into(), b.clone());
    }
    if let Some(s) = r.get("state").filter(|v| !v.is_null()) {
        o.insert("state".into(), s.clone());
    }
    if let Some(s) = r.get("state_at").filter(|v| !v.is_null()) {
        o.insert("state_at".into(), ts(s));
    }
    if let Some(n) = r.get("net_id").filter(|v| !v.is_null()) {
        o.insert("net_id".into(), n.clone());
    }
    let tries = r["tries"].as_i64().unwrap_or(0);
    if tries > 0 {
        o.insert("tries".into(), json!(tries));
    }
    if let Some(e) = r.get("last_err").filter(|v| !v.is_null()) {
        o.insert("last_err".into(), e.clone());
    }
    let att = r.get("attachments").cloned().unwrap_or(json!([]));
    if att.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        o.insert("attachments".into(), att);
    }
    if let Some(q) = r.get("reply_to").filter(|v| v.is_object()) {
        o.insert("reply_to".into(), q.clone());
    }
    Value::Object(o)
}

/// The columns a reply's quote is made from (`inbox_quote`).
const QUOTE_COLS: &str = "uid, dir, peer, by_name, at, body, net_id";

/// What a reply quotes of an org-inbox row: who wrote it, when and a gist
/// (the recipient's `↩ IN REPLY TO`), the row (the desk's link) and its hub
/// id (`net_id`: the reference a reply over the mail hub carries).
#[logged]
fn inbox_quote(r: &tokio_postgres::Row) -> Value {
    let from = if r.get::<_, String>(1) == "in" {
        r.get::<_, String>(2)
    } else {
        match r.get::<_, Option<String>>(3) {
            Some(by) if !by.is_empty() && by != "user" => by,
            _ => "the user".to_string(),
        }
    };
    let mut q = json!({ "kind": "mail", "box": "org", "id": r.get::<_, String>(0), "from": from,
                        "at": crate::util::iso(r.get(4)), "gist": crate::util::gist(&r.get::<_, String>(5), 600) });
    if let Some(n) = r.get::<_, Option<String>>(6) {
        q["net_id"] = json!(n);
    }
    q
}

/// The org-inbox row the user answers from the panel (its id).
#[logged]
pub async fn quote_of(engine: &Engine, org_id: i64, uid: &str) -> Result<Value> {
    let client = engine.db.get().await?;
    let r = client.query_opt(&format!("SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE org_id = $1 AND uid = $2"), &[&org_id, &uid]).await?;
    match r {
        Some(r) => Ok(inbox_quote(&r)),
        None => crate::refuse!(NotFound, "the message being answered is no longer in the org inbox"),
    }
}

/// An outside message an agent sent from the org inbox (the id
/// orgtree_message reported), for that agent's reply.
#[logged]
pub async fn sent_quote(client: &tokio_postgres::Client, org_id: i64, uid: &str, by: &str) -> Result<Option<Value>> {
    let r = client
        .query_opt(&format!("SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE org_id = $1 AND uid = $2 AND dir = 'out' AND by_name = $3"), &[&org_id, &uid, &by])
        .await?;
    Ok(r.as_ref().map(inbox_quote))
}

/// This org's own record of the message a hub reply names (one it sent or
/// received), quoted; `None` when the org never saw it.
#[logged]
async fn net_quote(client: &tokio_postgres::Client, org_id: i64, net_id: &str) -> Result<Option<Value>> {
    let r = client
        .query_opt(
            &format!(
                "(SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE dir = 'out' AND net_id = $2 AND org_id = $1 LIMIT 1)
                 UNION ALL
                 (SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE dir = 'in' AND org_id = $1 AND net_id = $2 LIMIT 1)
                 LIMIT 1"
            ),
            &[&org_id, &net_id],
        )
        .await?;
    Ok(r.as_ref().map(inbox_quote))
}

/// Mail to the outside: `@org:<slug>` (another org on this machine: one
/// transaction into both inboxes, then the receiving org's holders are
/// woken) or `@net:<slug>` (the mail hub).
#[logged]
pub async fn send_extern(engine: &Arc<Engine>, org_id: i64, out: &Outgoing) -> Result<Sent> {
    let to = out.to.trim().trim_start_matches('@');
    let Some(src) = engine.orgs.by_id(org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let by = match &out.from { From::User => "user".to_string(), f => f.name() };
    if let From::Agent { id, name, .. } = &out.from {
        ensure_holders(engine, org_id, Some((*id, name.as_str()))).await?;
    }
    if let Some(peer) = to.strip_prefix("net:") {
        let (uid, to) = crate::net::queue(engine, org_id, peer, &out.body, &by, &out.kind, &out.attachments, out.reply_to.as_ref()).await?;
        changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
        return Ok(Sent {
            uid,
            to,
            recipient_state: "remote".into(),
            delivery: "Queued for the mail hub; it leaves as soon as a hub accepts it (the org inbox shows its progress).".into(),
            deferred: false,
        });
    }
    let slug = to.strip_prefix("org:").unwrap_or(to).trim();
    let Some(dst) = engine.orgs.get(slug) else {
        crate::refuse!(NotFound, "no organization @org:{slug} on this machine (orgtree_list_orgs lists them)");
    };
    if dst.id == org_id {
        crate::refuse!(BadRequest, "@org:{slug} is this organization; write to the agent directly");
    }
    let client = engine.db.get().await?;
    let attachments = Value::Array(out.attachments.clone());
    let out_uid = uid("x");
    let in_uid = uid("x");
    let src_peer = format!("@org:{}", src.slug);
    let dst_peer = format!("@org:{}", dst.slug);
    // a reply's quote travels with it (the receiving org has no ids of ours)
    let reply_here = crate::util::pg_json_option(&out.reply_to).into_owned();
    let reply_there = reply_here
        .as_ref()
        .map(|q| Value::Object(["from", "at", "gist"].iter().filter_map(|k| q.get(*k).filter(|v| !v.is_null()).map(|v| (k.to_string(), v.clone()))).collect()))
        .filter(|q| q.get("gist").is_some());
    client
        .execute(
            "WITH o AS (INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, attachments, reply_to)
                        VALUES ($1, $2, 'out', $3, $4, $5, 'delivered', now(), $6, $10))
             INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, reply_to) VALUES ($7, $8, 'in', $9, $4, $6, $11)",
            &[&out_uid, &org_id, &dst_peer, &out.body, &by, &attachments, &in_uid, &dst.id, &src_peer, &reply_here, &reply_there],
        )
        .await?;
    let holders = ensure_holders(engine, dst.id, None).await?;
    drop(client);
    // the spark rides from the sender to the mailbox here, and from the mailbox to each holder there
    changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
    changes::notify(engine, &dst, vec![Change::OrgInbox]);
    for h in &holders {
        let mut m = Outgoing::new(From::Extern(src_peer.clone()), h, &out.body);
        m.kind = out.kind.clone();
        m.attachments = out.attachments.clone();
        m.reply_to = reply_there.clone();
        if let Err(e) = mail::send(engine, dst.id, m).await {
            tracing::warn!(error = %format!("{e:#}"), holder = %h, "org inbox delivery failed");
        }
    }
    if holders.is_empty() {
        super::runtime_notices::external_unroutable(engine,dst.id,&dst.slug,&src_peer,&out.body).await?;
    }
    let delivery = if holders.is_empty() {
        format!("Stored in {}'s org inbox; it has no live agent to read it yet.", dst.slug)
    } else {
        format!("Delivered to {}'s org inbox and to {}.", dst.slug, holders.join(", "))
    };
    Ok(Sent { uid: out_uid, to: dst_peer, recipient_state: "live".into(), delivery, deferred: holders.is_empty() })
}

/// Effective live audience holders; newest grant wins in single-holder mode.
#[logged]
pub async fn live_holders<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<String>> {
    let rows = client.query(
        "SELECT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live'
         GROUP BY au.grantee ORDER BY max(au.id) DESC LIMIT $2", &[&org_id, &(if multi { 10000i64 } else { 1i64 })]).await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Serialize only this org's short audience update; never hold the transaction over sending or IO.
#[logged]
async fn ensure_holders(engine: &Arc<Engine>, org_id: i64, sender: Option<(i64, &str)>) -> Result<Vec<String>> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let raw: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR UPDATE", &[&org_id]).await?.get(0);
    let settings = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults());
    let multi = settings["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    let mut holders = live_holders(&*tx, org_id, multi).await?;
    let target = if let Some((id, name)) = sender {
        if holders.iter().any(|h| h == name) { None } else {
            let top = tx.query_opt("SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND parent_id IS NULL", &[&id, &org_id]).await?.is_some();
            if !top { crate::refuse!(Forbidden, "outside mail needs the org-inbox audience; ask your superior"); }
            Some((id, name.to_string(), "auto-granted: top-level agent messaged an outside party"))
        }
    } else if holders.is_empty() {
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND parent_id IS NULL AND state = 'live' ORDER BY sibling_order, id LIMIT 1", &[&org_id]).await?
            .map(|r| (r.get(0), r.get(1), "auto-granted: outside mail arrived with no live org-inbox holder"))
    } else { None };
    let mut changed = false;
    if let Some((id, name, reason)) = target {
        if !multi {
            tx.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern' AND revoked_at IS NULL", &[&org_id]).await?;
            holders.clear();
        }
        tx.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, '@extern', $3)", &[&org_id, &name, &reason]).await?;
        tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', '@system', $2, $3)",
            &[&org_id, &id, &json!({"grantee": name, "grantor": "@extern", "reason": reason})]).await?;
        holders.push(name);
        changed = true;
    }
    tx.commit().await?;
    if changed { changes::notify_id(engine, org_id, vec![Change::Audiences, Change::OrgInbox, Change::Events]); }
    Ok(holders)
}

/// Mail that arrived over the mail hub: stored once (keyed by its hub id),
/// then handed to the org's outside-mail holders. Answers whether it was new.
/// `reply_to` is the hub id of the message it answers: quoted when this org
/// has that message, kept as the bare reference otherwise.
#[allow(clippy::too_many_arguments)]
#[logged]
pub async fn deliver_inbound(
    engine: &Arc<Engine>,
    org_id: i64,
    peer: &str,
    body: &str,
    attachments: Vec<Value>,
    net_id: &str,
    hub: &str,
    reply_to: Option<&str>,
) -> Result<bool> {
    let Some(org) = engine.orgs.by_id(org_id) else { return Ok(false) };
    let client = engine.db.get().await?;
    let quote = match reply_to {
        Some(r) => net_quote(&client, org_id, r).await?,
        None => None,
    };
    let stored = quote.clone().or_else(|| reply_to.map(|r| json!({ "net_id": r })));
    let n = client
        .execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, net_id, hub, reply_to)
             SELECT $1, $2, 'in', $3, $4, $5, $6, $7, $8
              WHERE NOT EXISTS (SELECT 1 FROM ot.org_inbox WHERE org_id = $2 AND dir = 'in' AND net_id = $6)",
            &[&uid("x"), &org_id, &peer, &crate::util::pg_text(&body).as_ref(), &crate::util::pg_json(&Value::Array(attachments.clone())).as_ref(), &net_id, &hub,
              &crate::util::pg_json_option(&stored).as_ref()],
        )
        .await?;
    if n == 0 {
        return Ok(false);
    }
    let holders = ensure_holders(engine, org_id, None).await?;
    drop(client);
    changes::notify(engine, &org, vec![Change::OrgInbox]);
    for h in &holders {
        let mut m = Outgoing::new(From::Extern(peer.to_string()), h, body);
        m.attachments = attachments.clone();
        m.net_id = Some(net_id.to_string());
        m.net_hub = Some(hub.to_string());
        // a holder answered by its own message reads "your message"
        m.reply_to = quote.clone().map(|mut q| {
            if q["from"].as_str() == Some(h.as_str()) {
                if let Some(o) = q.as_object_mut() {
                    o.remove("from");
                }
            }
            q
        });
        if let Err(e) = mail::send(engine, org_id, m).await {
            tracing::warn!(error = %format!("{e:#}"), holder = %h, "org inbox delivery failed");
        }
    }
    if holders.is_empty() {
        super::runtime_notices::external_unroutable(engine,org_id,&org.slug,peer,body).await?;
    }
    Ok(true)
}
