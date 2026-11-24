//! Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
//! org-presence-busy-orange-when-no-org-inbox-holde): each org tells the hubs
//! it is connected to whether it is busy (`POST /api/presence {busy, dnd}`):
//! online, but none of its org-mailbox holders can start a turn
//! (`orginbox::busy`), and whether its outside mail is set to Do not disturb
//! (`dnd`, a part of busy; user 2026-10-31 08:51Z, `presence_of`). The
//! network pass (every 3 s, or at once on a kick)
//! works it out and says it when it changed, the first time on a connection
//! (the hub keeps it in memory only, so a connection that went down says it
//! again), and after `REFRESH`. A hub older than 2.3.0 answers 404 and is not
//! asked again until its connection comes back.
//!
//! Last active (Mail hub 2.6.0; docket hubchat-last-seen-time-for-orgs-people-and-indep,
//! USER 2026-11-24 11:44Z me20294def375 and med2518611a95 "last seen should
//! basically be the org sending a "last seen" event every time an agent with
//! an org inbox audience's turn ends"): the same post carries `active`, one
//! of the agents in charge of the org mailbox is mid-turn now, and
//! `active_at`, when they last finished a turn (`last_active`). In charge
//! (`orginbox::in_charge`): the live agent holders, and for a project holder
//! the live agents whose armed fair_queue listener targets it. A turn of one
//! of them starting or ending kicks the pass at once (`turn_edge`, from the
//! agent's runtime publish), so every turn end is said: turn ends between two
//! passes are said together, with the newest end. Posts are serialized (one
//! pass at a time); a failed post leaves `Said` as it was, so the next pass
//! says the current state again if it differs, and the refresh repeats the
//! whole body. The body carries this engine's `now`, so the hub corrects
//! its clock. A hub older than 2.6.0 ignores the three fields.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{connected, request, Part, HTTP};
use crate::engine::Engine;

/// How long an unchanged busy stands before it is said again: the hub keeps
/// it in memory only, so one that restarted unnoticed hears it within this.
pub(crate) const REFRESH: Duration = Duration::from_secs(5 * 60);

/// What an org says to a hub.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Says {
    pub(crate) busy: bool,
    /// its outside mail set to Do not disturb (a part of busy)
    pub(crate) dnd: bool,
    /// an agent in charge of its org mailbox is mid-turn (Mail hub 2.6.0)
    pub(crate) active: bool,
    /// when those agents last finished a turn, unix milliseconds; None: none
    /// of them ever did (Mail hub 2.6.0)
    pub(crate) active_at: Option<i64>,
}

/// What an org last told one hub.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Said {
    pub(crate) says: Says,
    pub(crate) at: Instant,
    /// the hub answered 404: older than Mail hub 2.3.0
    pub(crate) unsupported: bool,
}

/// What each org last told each hub: (org id, hub id) → `Said`; and which
/// agents are in charge of an org mailbox now (agent id → org id), as the
/// last pass found them: their turns starting and ending kick the pass.
#[derive(Default)]
pub(crate) struct State {
    said: papaya::HashMap<(i64, String), Said>,
    in_charge: papaya::HashMap<i64, i64>,
}

impl State {
    /// The org's connection to this hub went down: say it again once it is
    /// back (a hub that restarted has forgotten it).
    #[nolog]
    pub(crate) fn forget(&self, org_id: i64, hub_id: &str) {
        self.said.pin().remove(&(org_id, hub_id.to_string()));
    }
}

/// Whether to tell the hub now: never told on this connection, changed (busy,
/// DND, active or the last turn end), or told `REFRESH` ago; never a hub
/// older than busy.
#[nolog]
pub(crate) fn due(last: Option<Said>, says: Says, now: Instant) -> bool {
    match last {
        None => true,
        Some(s) if s.unsupported => false,
        Some(s) => s.says != says || now.saturating_duration_since(s.at) >= REFRESH,
    }
}

/// From each agent in charge of the org mailbox: whether it is mid-turn now,
/// and when its last finished turn ended (unix ms): the org is active while
/// any of them is mid-turn, and was last active at the newest of those ends
/// (an agent still running keeps it active while another's end moves the
/// time on).
#[nolog]
pub(crate) fn last_active(agents: &[(bool, Option<i64>)]) -> (bool, Option<i64>) {
    (agents.iter().any(|a| a.0), agents.iter().filter_map(|a| a.1).max())
}

/// An agent's runtime view changed (`runtime::actor` publish): when its turn
/// started or ended (`busy` flipped) and it is in charge of an org mailbox,
/// run the network pass at once, so the org says it (USER med2518611a95).
#[nolog]
pub(crate) fn turn_edge(engine: &Engine, agent_id: i64, old: &Value, new: &Value) {
    if old.get("busy") != new.get("busy") && engine.net.presence.in_charge.pin().contains_key(&agent_id) {
        super::kick(engine);
    }
}

/// What an org says to its hubs, from its settings and whether its org-mailbox
/// holders are busy (`orginbox::busy`): (busy, dnd). Do not disturb is its
/// outside mail's mode, `orginbox::mode` "dnd" (a closed inbox is not DND and
/// keeps today's presence, coordinator 2026-10-31 09:00Z). A DND org is busy
/// too, so a hub or client that knows busy but not DND shows it busy.
#[nolog]
pub(crate) fn presence_of(settings: &Value, holders_busy: bool) -> (bool, bool) {
    let dnd = crate::domain::orginbox::mode(settings) == "dnd";
    (holders_busy || dnd, dnd)
}

/// Whether the org is busy now, whether its outside mail is set to Do not
/// disturb (its settings also say whether several may hold its org mailbox),
/// and whether and when it was last active. Notes the agents in charge, so
/// their turns kick the pass.
#[logged]
async fn org_presence(engine: &Engine, org_id: i64) -> anyhow::Result<Says> {
    let client = engine.db.get().await?;
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    let holders_busy = crate::domain::orginbox::busy(&**client, org_id, multi).await?;
    let (busy, dnd) = presence_of(&raw, holders_busy);
    let ends = crate::domain::orginbox::in_charge_turn_ends(&**client, org_id, multi).await?;
    {
        let map = engine.net.presence.in_charge.pin();
        let stale: Vec<i64> = map.iter().filter(|(id, org)| **org == org_id && !ends.iter().any(|e| e.0 == **id)).map(|(id, _)| *id).collect();
        for id in stale {
            map.remove(&id);
        }
        for (id, _) in &ends {
            map.insert(*id, org_id);
        }
    }
    // mid-turn: the agent's live runtime (what the chart shows), not a turn
    // row that an engine stop may have left open
    let agents: Vec<(bool, Option<i64>)> = ends
        .iter()
        .map(|(id, end)| {
            let running = engine.agents.get(*id).is_some_and(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false));
            (running, end.map(|t| t.timestamp_millis()))
        })
        .collect();
    let (active, active_at) = last_active(&agents);
    Ok(Says { busy, dnd, active, active_at })
}

/// The body of the post: busy and dnd as ever, and (Mail hub 2.6.0) active,
/// active_at and this engine's clock now (the hub moves active_at onto its
/// own clock by the difference); an older hub ignores the three.
#[nolog]
pub(crate) fn body(net_slug: &str, says: Says, now: chrono::DateTime<chrono::Utc>) -> Value {
    let at = says.active_at.and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis).map(crate::util::iso);
    json!({ "slug": net_slug, "busy": says.busy, "dnd": says.dnd, "active": says.active, "active_at": at, "now": crate::util::iso(now) })
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
        let says = match org_presence(engine, p.org_id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(org = %p.slug, error = %format!("{e:#}"), "could not tell whether the org is busy");
                continue;
            }
        };
        for (hid, addr) in hubs {
            let key = (p.org_id, hid.clone());
            let now = Instant::now();
            if !due(engine.net.presence.said.pin().get(&key).copied(), says, now) {
                continue;
            }
            let res = request(
                engine,
                &[p.org_id],
                HTTP.post(format!("{addr}/api/presence"))
                    .timeout(Duration::from_secs(10))
                    .header("X-Org-Auth", p.auth())
                    .json(&body(&p.net_slug, says, chrono::Utc::now())),
            )
            .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    engine.net.presence.said.pin().insert(key, Said { says, at: now, unsupported: false });
                }
                // a hub older than 2.3.0: no such route; its addresses show online, as before
                Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                    engine.net.presence.said.pin().insert(key, Said { says, at: now, unsupported: true });
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
