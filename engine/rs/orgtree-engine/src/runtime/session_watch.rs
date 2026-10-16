//! Sign-in and sign-out notices (docket
//! let-agents-query-machine-sign-in-state-and-which; the user, 2026-10-16
//! 12:07Z: at sign-in and at sign-out every running turn is told, at its next
//! tool boundary, where its next turn will run; idle agents are told without
//! being woken). An engine in Session 0 watches whether the sign-in helper
//! hosts, which is where new turns run. A change that holds for `STEADY`
//! readings, from what agents were last told (kept in `FILE`, so an engine
//! restart while the user stays signed in tells nobody anything), sends every
//! live agent one passive line. `mail::send` wakes an agent whose actor runs,
//! so a running turn takes the line at its next tool boundary (Claude's hook,
//! Codex's and Muse's steer, Antigravity's hook) and an idle one at its next
//! turn. The move notices of the turn where an agent really moves
//! (`runtime_notices::SESSION_UPGRADE`, `SESSION_DOWNGRADE`) are unchanged.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::engine::Engine;

const SIGNED_IN: &str = "signed-in";
const SESSION0: &str = "session0";
/// What agents were last told, in the data folder.
const FILE: &str = "session-placement.json";
/// Readings, a second apart, that must agree before a change counts.
const STEADY: u32 = 2;

pub const SIGNED_IN_NOTICE: &str = "[ORGTREE SIGN-IN NOTICE] The user signed in and Orgtree's sign-in helper connected: your next turn runs in their signed-in Windows session, with access to their desktop and apps. orgtree_session shows where you run.";
pub const SIGNED_OUT_NOTICE: &str = "[ORGTREE SIGN-OUT NOTICE] The user signed out, or Orgtree's sign-in helper stopped: your next turn runs in Windows Session 0, without their desktop and apps. orgtree_session shows where you run.";

/// Whether a steady reading of where new turns run (`signed-in` while the
/// sign-in helper hosts, else `session0`) is news to agents last told `last`:
/// Some(true) for the signed-in session, Some(false) for Session 0.
#[logged]
pub fn announce(last: &str, now: &str) -> Option<bool> {
    (last != now).then_some(now == SIGNED_IN)
}

/// Start watching (an engine in Session 0 only: elsewhere every turn runs in
/// the signed-in session and nothing moves).
#[logged]
pub fn start(engine: &Arc<Engine>) {
    if !crate::runtime::codex::session0() {
        return;
    }
    let engine = engine.clone();
    tokio::spawn(async move { watch(engine).await });
}

#[logged]
async fn watch(engine: Arc<Engine>) {
    let path = engine.cfg.data_root.join(FILE);
    let mut told = read(&path).unwrap_or_else(|| SESSION0.to_string());
    // after a restart the helper registers again within the actors' settle time
    let elapsed = (chrono::Utc::now() - engine.boot.started_at).to_std().unwrap_or_default();
    tokio::select! {
        _ = engine.shutdown.cancelled() => return,
        _ = tokio::time::sleep(crate::runtime::actor::SESSION_SETTLE.saturating_sub(elapsed)) => {}
    }
    let (mut seen, mut count) = (String::new(), 0u32);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = engine.shutdown.cancelled() => break,
            _ = tick.tick() => {}
        }
        let now = if engine.credential_bridge.can_host() { SIGNED_IN } else { SESSION0 };
        if seen == now {
            count += 1;
        } else {
            (seen, count) = (now.to_string(), 1);
        }
        if count < STEADY {
            continue;
        }
        let Some(up) = announce(&told, now) else { continue };
        told = now.to_string();
        write(&path, &told);
        tracing::info!(to = now, "where new turns run changed; every agent is told");
        if let Err(e) = tell(&engine, up).await {
            tracing::warn!(error = %format!("{e:#}"), "the sign-in or sign-out notice could not be sent");
        }
    }
}

/// One passive line to every live agent of every active organization.
#[logged]
async fn tell(engine: &Arc<Engine>, up: bool) -> anyhow::Result<()> {
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "SELECT a.id, a.org_id FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
              WHERE a.state = 'live' AND o.state = 'active' ORDER BY a.id",
            &[],
        )
        .await?;
    drop(client);
    let text = if up { SIGNED_IN_NOTICE } else { SIGNED_OUT_NOTICE };
    for r in rows {
        let (agent, org): (i64, i64) = (r.get(0), r.get(1));
        if let Err(e) = crate::domain::mail::system_event(engine, org, agent, text, true, None).await {
            tracing::warn!(agent, error = %format!("{e:#}"), "the sign-in or sign-out notice could not be sent to an agent");
        }
    }
    Ok(())
}

/// How long the user may be signed in with no sign-in helper before the engine
/// starts the helper's own task, by attempts made: so far never.
#[logged]
pub fn keepalive_wait(attempts: u32) -> Duration {
    let _ = attempts;
    Duration::MAX
}

/// The helper's scheduled task the engine may start: so far none.
#[logged]
pub fn helper_task(rig: bool, rig_named: Option<&str>) -> Option<String> {
    let _ = (rig, rig_named);
    None
}

#[logged]
fn read(path: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    v["placement"].as_str().filter(|p| *p == SIGNED_IN || *p == SESSION0).map(str::to_owned)
}

#[logged]
fn write(path: &Path, placement: &str) {
    let tmp = path.with_extension("json.tmp");
    let body = json!({ "placement": placement, "at": crate::util::iso(chrono::Utc::now()) }).to_string();
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_change_from_what_agents_were_last_told_is_announced() {
        assert_eq!(announce("session0", "signed-in"), Some(true));
        assert_eq!(announce("signed-in", "session0"), Some(false));
        assert_eq!(announce("signed-in", "signed-in"), None);
        assert_eq!(announce("session0", "session0"), None);
    }

    /// The user, 2026-10-16 12:12Z (2d): when the user is signed in and no
    /// helper connects, the engine starts the helper's task after 30 s, then
    /// waits 2, 5 and 10 minutes between attempts.
    #[test]
    fn the_helper_is_started_after_30_s_then_less_and_less_often() {
        let s = |n| keepalive_wait(n).as_secs();
        assert_eq!((s(0), s(1), s(2), s(3), s(9)), (30, 120, 300, 600, 600));
    }

    /// A rig engine never starts the machine's own helper task, only one a
    /// proof names.
    #[test]
    fn a_rig_engine_starts_only_the_task_a_proof_names() {
        assert_eq!(helper_task(false, None).as_deref(), Some("\\Orgtree Credential Helper"));
        assert_eq!(helper_task(false, Some("x")).as_deref(), Some("\\Orgtree Credential Helper"));
        assert_eq!(helper_task(true, None), None);
        assert_eq!(helper_task(true, Some(" ")), None);
        assert_eq!(helper_task(true, Some("OrgtreeRigProof-1")).as_deref(), Some("\\OrgtreeRigProof-1"));
    }

    #[test]
    fn what_agents_were_told_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("orgtree-session-watch-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        assert_eq!(read(&path), None, "nothing told yet: the caller starts from Session 0");
        write(&path, SIGNED_IN);
        assert_eq!(read(&path).as_deref(), Some(SIGNED_IN));
        std::fs::write(&path, r#"{"placement":"elsewhere"}"#).unwrap();
        assert_eq!(read(&path), None, "an unknown value counts as nothing told");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_notice_is_one_line_and_names_where_the_next_turn_runs() {
        assert!(!SIGNED_IN_NOTICE.contains('\n') && SIGNED_IN_NOTICE.contains("your next turn runs in their signed-in Windows session"));
        assert!(!SIGNED_OUT_NOTICE.contains('\n') && SIGNED_OUT_NOTICE.contains("your next turn runs in Windows Session 0"));
    }
}
