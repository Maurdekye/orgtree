//! Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
//! org-presence-busy-orange-when-no-org-inbox-holde): each org tells the hubs
//! it is connected to whether it is busy (`POST /api/presence {busy}`):
//! online, but none of its org-inbox holders can start a turn
//! (`orginbox::busy`). The network pass (every 3 s, or at once on a kick)
//! works it out and says it when it changed, the first time on a connection
//! (the hub keeps it in memory only, so a connection that went down says it
//! again), and after `REFRESH`. A hub older than 2.3.0 answers 404 and is not
//! asked again until its connection comes back.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{connected, request, Part, HTTP};
use crate::engine::Engine;

/// How long an unchanged busy stands before it is said again: the hub keeps
/// it in memory only, so one that restarted unnoticed hears it within this.
pub(crate) const REFRESH: Duration = Duration::from_secs(5 * 60);

/// What an org last told one hub.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Said {
    pub(crate) busy: bool,
    pub(crate) at: Instant,
    /// the hub answered 404: older than Mail hub 2.3.0
    pub(crate) unsupported: bool,
}

/// What each org last told each hub: (org id, hub id) → `Said`.
#[derive(Default)]
pub(crate) struct State {
    said: papaya::HashMap<(i64, String), Said>,
}

impl State {
    /// The org's connection to this hub went down: say it again once it is
    /// back (a hub that restarted has forgotten it).
    #[nolog]
    pub(crate) fn forget(&self, org_id: i64, hub_id: &str) {
        self.said.pin().remove(&(org_id, hub_id.to_string()));
    }
}

/// Whether to tell the hub now: never told on this connection, changed, or
/// told `REFRESH` ago; never a hub older than busy.
#[nolog]
pub(crate) fn due(last: Option<Said>, busy: bool, now: Instant) -> bool {
    match last {
        None => true,
        Some(s) if s.unsupported => false,
        Some(s) => s.busy != busy || now.saturating_duration_since(s.at) >= REFRESH,
    }
}

/// Whether the org is busy now (its settings say whether several may hold
/// its org inbox).
#[logged]
async fn org_busy(engine: &Engine, org_id: i64) -> anyhow::Result<bool> {
    let client = engine.db.get().await?;
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    crate::domain::orginbox::busy(&**client, org_id, multi).await
}

/// Tell each connected hub of each org whether the org is busy, when due.
#[logged]
pub(super) async fn declare(engine: &Engine, parts: &[Part]) {
    for p in parts {
        let hubs: Vec<&(String, String)> =
            p.hubs.iter().filter(|(hid, _)| p.registered.contains(hid) && connected(engine, p.org_id, hid)).collect();
        if hubs.is_empty() {
            continue;
        }
        let busy = match org_busy(engine, p.org_id).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(org = %p.slug, error = %format!("{e:#}"), "could not tell whether the org is busy");
                continue;
            }
        };
        for (hid, addr) in hubs {
            let key = (p.org_id, hid.clone());
            let now = Instant::now();
            if !due(engine.net.presence.said.pin().get(&key).copied(), busy, now) {
                continue;
            }
            let res = request(
                engine,
                &[p.org_id],
                HTTP.post(format!("{addr}/api/presence"))
                    .timeout(Duration::from_secs(10))
                    .header("X-Org-Auth", p.auth())
                    .json(&json!({ "slug": p.net_slug, "busy": busy })),
            )
            .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    engine.net.presence.said.pin().insert(key, Said { busy, at: now, unsupported: false });
                }
                // a hub older than 2.3.0: no such route; its addresses show online, as before
                Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                    engine.net.presence.said.pin().insert(key, Said { busy, at: now, unsupported: true });
                }
                Ok(r) => tracing::warn!(org = %p.slug, hub = %hid, status = r.status().as_u16(), "the hub refused the org's busy"),
                Err(e) => tracing::debug!(org = %p.slug, hub = %hid, error = %format!("{e:#}"), "could not tell the hub whether the org is busy"),
            }
        }
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
