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
//! its clock.
//!
//! The time never goes back (@coordinator-opus 2026-11-24 13:27Z, on USER
//! med2518611a95: each turn end is an event; a time said is never unsaid):
//! a per-org high-water mark kept in `ot.orgs.net` (`last_active_at`,
//! `orginbox::raise_last_active`) is raised by each newer end and never
//! lowered or cleared, so a holder change, a retirement or a revoked
//! audience leaves it, and an engine restart keeps it. Turns the engine's
//! start-up recovery closed are no turn ends (`orginbox::last_turn_ends`).
//! Only hubs that list the feature `last_active` (read from `/healthz` once
//! per connection and again at each refresh) get the three fields, and turn edges kick the pass only
//! for orgs with such a hub: older hubs keep exactly today's traffic.

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

/// What each org last told each hub: (org id, hub id) → `Said`; whether each
/// hub lists `last_active` (read once per connection); and which agents are
/// in charge of an org mailbox now (agent id → org id) for orgs with such a
/// hub, as the last pass found them: their turns starting and ending kick
/// the pass.
#[derive(Default)]
pub(crate) struct State {
    said: papaya::HashMap<(i64, String), Said>,
    last_active: papaya::HashMap<(i64, String), (bool, Instant)>,
    in_charge: papaya::HashMap<i64, i64>,
}

impl State {
    /// The org's connection to this hub went down: say it again once it is
    /// back (a hub that restarted has forgotten it), and read its features
    /// again (it may have been upgraded meanwhile).
    #[nolog]
    pub(crate) fn forget(&self, org_id: i64, hub_id: &str) {
        self.said.pin().remove(&(org_id, hub_id.to_string()));
        self.last_active.pin().remove(&(org_id, hub_id.to_string()));
    }

    /// The agents in charge of `org_id`'s org mailbox are now `ids` (none:
    /// the org has no hub with `last_active`): the others of that org leave
    /// the map, other orgs' entries stay.
    #[nolog]
    pub(crate) fn set_in_charge(&self, org_id: i64, ids: &[i64]) {
        let map = self.in_charge.pin();
        let stale: Vec<i64> = map.iter().filter(|(id, org)| **org == org_id && !ids.contains(id)).map(|(id, _)| *id).collect();
        for id in stale {
            map.remove(&id);
        }
        for id in ids {
            map.insert(*id, org_id);
        }
    }

    /// Whether the agent is in charge of an org mailbox (tests and turn_edge).
    #[nolog]
    pub(crate) fn is_in_charge(&self, agent_id: i64) -> bool {
        self.in_charge.pin().contains_key(&agent_id)
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

/// What a hub is told: all of it for a hub that lists `last_active`; busy and
/// DND alone for an older one, so its traffic stays as it was.
#[nolog]
pub(crate) fn for_hub(says: Says, last_active: bool) -> Says {
    if last_active { says } else { Says { active: false, active_at: None, ..says } }
}

/// Whether the agent is mid-turn: its live runtime view (what the chart
/// shows), not a turn row an engine stop may have left open.
#[nolog]
pub(crate) fn running(engine: &Engine, agent_id: i64) -> bool {
    engine.agents.get(agent_id).is_some_and(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false))
}

/// An agent's runtime view changed (`runtime::actor` publish): when its turn
/// started or ended (`busy` flipped) and it is in charge of the org mailbox
/// of an org with a hub that lists `last_active`, run the network pass at
/// once, so the org says it (USER med2518611a95).
#[nolog]
pub(crate) fn turn_edge(engine: &Engine, agent_id: i64, old: &Value, new: &Value) {
    if old.get("busy") != new.get("busy") && engine.net.presence.is_in_charge(agent_id) {
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
/// and, when one of its hubs lists `last_active`, whether and when it was
/// last active. Notes the agents in charge, so their turns kick the pass.
#[logged]
async fn org_presence(engine: &Engine, org_id: i64, any_last_active: bool) -> anyhow::Result<Says> {
    let client = engine.db.get().await?;
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    let holders_busy = crate::domain::orginbox::busy(&**client, org_id, multi).await?;
    let (busy, dnd) = presence_of(&raw, holders_busy);
    if !any_last_active {
        engine.net.presence.set_in_charge(org_id, &[]);
        return Ok(Says { busy, dnd, ..Says::default() });
    }
    let ids = crate::domain::orginbox::in_charge(&**client, org_id, multi).await?;
    engine.net.presence.set_in_charge(org_id, &ids);
    // the flags first, then the ends: a turn ending in between is said as
    // still running with its end, never as idle with the end before it
    let flags: Vec<bool> = ids.iter().map(|id| running(engine, *id)).collect();
    let ends = crate::domain::orginbox::last_turn_ends(&**client, &ids).await?;
    let agents: Vec<(bool, Option<i64>)> =
        ids.iter().zip(flags).map(|(id, run)| (run, ends.iter().find(|e| e.0 == *id).and_then(|e| e.1).map(|t| t.timestamp_millis()))).collect();
    let (active, newest) = last_active(&agents);
    // never back: the org's mark, raised by a newer end
    let newest = newest.and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis);
    let mark = crate::domain::orginbox::raise_last_active(&**client, org_id, newest).await?;
    Ok(Says { busy, dnd, active, active_at: mark.map(|t| t.timestamp_millis()) })
}

/// The body of the post: busy and dnd as ever; for a hub that lists
/// `last_active` (Mail hub 2.6.0) also active, active_at and this engine's
/// clock now (the hub moves active_at onto its own clock by the difference).
#[nolog]
pub(crate) fn body(net_slug: &str, says: Says, last_active: bool, now: chrono::DateTime<chrono::Utc>) -> Value {
    if !last_active {
        return json!({ "slug": net_slug, "busy": says.busy, "dnd": says.dnd });
    }
    let at = says.active_at.and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis).map(crate::util::iso);
    json!({ "slug": net_slug, "busy": says.busy, "dnd": says.dnd, "active": says.active, "active_at": at, "now": crate::util::iso(now) })
}

/// How long a pass waits on a hub's `/healthz` for its features: short, so a
/// hub that can't be read never holds the serialized pass for long
/// (@coordinator-opus 2026-11-24 13:47Z, R5).
pub(crate) const FEATURES_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether the cached answer on a hub's features is to be read again: never
/// read on this connection, or read `REFRESH` ago (a hub upgraded in place
/// while the connection stayed up; R2).
#[nolog]
pub(crate) fn features_due(cached: Option<(bool, Instant)>, now: Instant) -> bool {
    cached.is_none_or(|(_, at)| now.saturating_duration_since(at) >= REFRESH)
}

/// What a read of the features leaves (`read`: None when `/healthz` could
/// not be read): the answer, and what to cache. A failed read keeps the
/// cached answer until the next refresh; with none cached the hub counts as
/// without the feature, and the next pass reads again.
#[nolog]
pub(crate) fn after_read(cached: Option<(bool, Instant)>, read: Option<bool>, now: Instant) -> (bool, Option<(bool, Instant)>) {
    match (read, cached) {
        (Some(yes), _) => (yes, Some((yes, now))),
        (None, Some((yes, _))) => (yes, Some((yes, now))),
        (None, None) => (false, None),
    }
}

/// Whether the hub lists `last_active` (Mail hub 2.6.0): read from its
/// `/healthz` once per connection (`State::forget` clears it) and again at
/// each `REFRESH`, waiting `FEATURES_TIMEOUT` at most (`after_read`).
#[logged]
pub(crate) async fn hub_last_active(engine: &Engine, org_id: i64, hub_id: &str, addr: &str) -> bool {
    let key = (org_id, hub_id.to_string());
    let cached = engine.net.presence.last_active.pin().get(&key).copied();
    let now = Instant::now();
    if !features_due(cached, now) {
        return cached.is_some_and(|c| c.0);
    }
    let read = super::transport::healthz(addr, FEATURES_TIMEOUT)
        .await
        .map(|health| health["features"].as_array().is_some_and(|f| f.iter().any(|x| x == "last_active")));
    let (yes, keep) = after_read(cached, read, now);
    if let Some(keep) = keep {
        engine.net.presence.last_active.pin().insert(key, keep);
    }
    yes
}

/// Tell each of these hubs (hub id, address, whether it lists `last_active`)
/// what the org says, when due.
#[logged]
pub(crate) async fn tell(engine: &Engine, p: &Part, hubs: &[(&str, &str, bool)], says: Says) {
    for (hid, addr, last_active) in hubs {
        let key = (p.org_id, hid.to_string());
        let says = for_hub(says, *last_active);
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
                .json(&body(&p.net_slug, says, *last_active, chrono::Utc::now())),
        )
        .await;
        // `Said` keeps what this engine sent, never the hub's answer (it
        // echoes the time moved onto its clock)
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

/// Tell each connected hub of each org whether the org is busy (and, to a
/// hub that lists `last_active`, whether and when it was last active), when
/// due.
#[logged]
pub(super) async fn declare(engine: &Engine, parts: &[Part]) {
    for p in parts {
        let mut hubs: Vec<(&str, &str, bool)> = Vec::new();
        for (hid, addr) in p.hubs.iter().filter(|(hid, _)| p.registered.contains(hid) && connected(engine, p.org_id, hid)) {
            hubs.push((hid.as_str(), addr.as_str(), hub_last_active(engine, p.org_id, hid, addr).await));
        }
        if hubs.is_empty() {
            engine.net.presence.set_in_charge(p.org_id, &[]);
            continue;
        }
        let says = match org_presence(engine, p.org_id, hubs.iter().any(|h| h.2)).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(org = %p.slug, error = %format!("{e:#}"), "could not tell whether the org is busy");
                continue;
            }
        };
        tell(engine, p, &hubs, says).await;
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
