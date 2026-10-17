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
//! The same change fires the watchdog events `session.signed_in` and
//! `session.signed_out`, and at sign-in working agents idle in Session 0 get
//! their checkup at once (`reminders::checkups_at_sign_in`; the user,
//! 2026-10-16 12:12Z, 2c). While the user is signed in and no helper
//! connects, the engine starts the helper's own task, less and less often
//! (`keepalive_wait`, 2d).

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

/// Placement decisions shared by the watcher and its focused regression tests.
struct Placement {
    told: bool,
    seen: Option<bool>,
    count: u32,
}

#[logged]
impl Placement {
    fn new(signed_in: bool) -> Self { Self { told: signed_in, seen: None, count: 0 } }

    fn observe(&mut self, hosting: bool, _at: std::time::Instant) -> Option<bool> {
        if self.seen == Some(hosting) { self.count += 1; }
        else { self.seen = Some(hosting); self.count = 1; }
        if self.count < STEADY || self.told == hosting { return None; }
        self.told = hosting;
        Some(hosting)
    }
}

pub const SIGNED_IN_NOTICE: &str = "[ORGTREE SIGN-IN NOTICE] The user signed in and Orgtree's sign-in helper connected: your next turn runs in their signed-in Windows session, with access to their desktop and apps. orgtree_session shows where you run.";
pub const SIGNED_IN_KEPT_NOTICE: &str = "[ORGTREE SIGN-IN NOTICE] The user signed in and Orgtree's sign-in helper connected, but your session preference keeps your next turn in Windows Session 0. orgtree_session shows where you run and sets the preference.";
pub const SIGNED_IN_HELD_NOTICE: &str = "[ORGTREE SIGN-IN NOTICE] The user signed in and Orgtree's sign-in helper connected, but your CLI still runs background work, so your next turn stays in Windows Session 0; a later turn moves once that work is done. orgtree_session shows where you run.";
pub const SIGNED_IN_USE_NOTICE: &str = "[ORGTREE SIGN-IN NOTICE] The user signed in and Orgtree's sign-in helper connected, but you picked Windows Session 0 for your next turn (orgtree_session `use`); the turns after it follow your preference. orgtree_session shows where you run.";
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
    let mut placement = Placement::new(told == SIGNED_IN);
    let mut keep = Keepalive::default();
    #[cfg(windows)]
    let mut sessions = crate::core_process::Sessions::new();
    let mut ticks = 0u64;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = engine.shutdown.cancelled() => break,
            _ = tick.tick() => {}
        }
        ticks += 1;
        let hosting = engine.credential_bridge.can_host();
        // the user is signed in (read as the core monitor reads it) and no helper
        #[cfg(windows)]
        if ticks.is_multiple_of(5) {
            let signed_in = crate::core_state::sessions(&engine.cfg.data_root, &mut sessions).map(|s| !s.is_empty());
            keepalive(&engine, &mut keep, signed_in == Some(true) && !hosting).await;
        }
        #[cfg(not(windows))]
        let _ = (&mut keep, ticks);
        let now = if hosting { SIGNED_IN } else { SESSION0 };
        let Some(up) = placement.observe(hosting, std::time::Instant::now()) else { continue };
        told = now.to_string();
        write(&path, &told);
        tracing::info!(to = now, "where new turns run changed; every agent is told");
        if let Err(e) = tell(&engine, up).await {
            tracing::warn!(error = %format!("{e:#}"), "the sign-in or sign-out notice could not be sent");
        }
        // watchdogs may wait for it (2c), and working agents idle in Session 0
        // get their checkup now, after the notice, so they move at once
        crate::runtime::watchdogs::events::machine(&engine, if up { "session.signed_in" } else { "session.signed_out" }, json!({ "to": now }));
        if up {
            crate::runtime::reminders::checkups_at_sign_in(&engine).await;
        }
    }
}

/// One passive line to every live agent of every active organization. At
/// sign-in it says where the agent's next turn runs: as its own runtime would
/// start that turn now (`view_of`), else by its stored preference.
#[logged]
async fn tell(engine: &Arc<Engine>, up: bool) -> anyhow::Result<()> {
    use crate::runtime::session_host as sh;
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "SELECT a.id, a.org_id, a.scope->'session' FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
              WHERE a.state = 'live' AND a.kind = 'agent' AND o.state = 'active' ORDER BY a.id",
            &[],
        )
        .await?;
    drop(client);
    let sessions = sh::host_sessions(engine);
    let agents: Vec<(i64, i64, sh::Pref)> = rows
        .iter()
        .map(|r| {
            let pref: Option<serde_json::Value> = r.get(2);
            (r.get(0), r.get(1), sh::parse_pref(pref.as_ref().unwrap_or(&serde_json::Value::Null)).unwrap_or(sh::Pref::SignedIn))
        })
        .collect();
    let views = futures::future::join_all(agents.iter().map(|(agent, _, pref)| async move {
        if up {
            view_of(engine, *agent, pref).await
        } else {
            None
        }
    }))
    .await;
    for ((agent, org, pref), view) in agents.into_iter().zip(views) {
        let text = if up { sign_in_line(sh::choose(&sessions, &pref, None).is_some(), view.as_ref()) } else { SIGNED_OUT_NOTICE };
        if let Err(e) = crate::domain::mail::system_event(engine, org, agent, text, true, None).await {
            tracing::warn!(agent, error = %format!("{e:#}"), "the sign-in or sign-out notice could not be sent to an agent");
        }
    }
    Ok(())
}

/// How long the sign-in line waits for an agent's runtime to say where its
/// next turn runs.
const ASK: Duration = Duration::from_secs(5);

/// Where an agent's own runtime would start its next turn now (its
/// orgtree_session view), given its stored preference `pref` as that turn
/// will read it: None when its runtime does not run, or does not answer
/// within `ASK`.
#[logged]
async fn view_of(engine: &Arc<Engine>, agent: i64, pref: &crate::runtime::session_host::Pref) -> Option<serde_json::Value> {
    let h = engine.agents.get(agent)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !h.send(crate::runtime::AgentMsg::Session { pref: Some(pref.clone()), use_id: None, reply: tx }) {
        return None;
    }
    tokio::time::timeout(ASK, rx).await.ok()?.ok()
}

/// The sign-in line for one agent: where its own runtime would start its next
/// turn (`view`, its orgtree_session view, in which its on-demand `use` and a
/// CLI held by background work count; rig-sol-b, 2026-10-16), else where its
/// stored preference puts it (`by_pref`: one of the user's sessions).
#[logged]
fn sign_in_line(by_pref: bool, view: Option<&serde_json::Value>) -> &'static str {
    let Some(v) = view else {
        return if by_pref { SIGNED_IN_NOTICE } else { SIGNED_IN_KEPT_NOTICE };
    };
    if v["next_turn"] == SIGNED_IN {
        SIGNED_IN_NOTICE
    } else if v["held_by_background_work"] == true {
        SIGNED_IN_HELD_NOTICE
    } else if v["use"] == 0 {
        SIGNED_IN_USE_NOTICE
    } else {
        SIGNED_IN_KEPT_NOTICE
    }
}

/// How long the user may be signed in with no sign-in helper before the engine
/// starts the helper's own task, by attempts made (the user, 2026-10-16
/// 12:12Z, 2d): 30 s, then 2, 5 and 10 minutes, then every 10 minutes.
#[logged]
pub fn keepalive_wait(attempts: u32) -> Duration {
    Duration::from_secs(match attempts {
        0 => 30,
        1 => 120,
        2 => 300,
        _ => 600,
    })
}

/// The installer's sign-in helper task (tools/boot-engine-task.ps1).
const HELPER_TASK: &str = "Orgtree Credential Helper";
/// A rig proof's own stand-in for it, named in the rig's data folder.
const RIG_HELPER_TASK: &str = "rig-helper-task.txt";

/// The helper's scheduled task the engine may start: the installer's; in a
/// rig engine only a task a proof names, never the machine's own.
#[logged]
pub fn helper_task(rig: bool, rig_named: Option<&str>) -> Option<String> {
    if !rig {
        return Some(format!("\\{HELPER_TASK}"));
    }
    rig_named.map(str::trim).filter(|n| !n.is_empty()).map(|n| format!("\\{}", n.trim_start_matches('\\')))
}

/// The user is signed in and no helper connects: how long, and how often the
/// helper's task was started since.
#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Keepalive {
    since: Option<std::time::Instant>,
    attempts: u32,
}

/// Start the helper's task when the user has been signed in without a helper
/// for `keepalive_wait`. A disabled task (Run on boot off) refuses, which is
/// logged like any other result. Windows only: elsewhere nothing hosts.
#[cfg(windows)]
#[logged]
async fn keepalive(engine: &Arc<Engine>, k: &mut Keepalive, missing: bool) {
    if !missing {
        *k = Keepalive::default();
        return;
    }
    let since = *k.since.get_or_insert_with(std::time::Instant::now);
    if since.elapsed() < keepalive_wait(k.attempts) {
        return;
    }
    let rig = crate::rig::active();
    let named = if rig { std::fs::read_to_string(engine.cfg.data_root.join(RIG_HELPER_TASK)).ok() } else { None };
    let Some(task) = helper_task(rig, named.as_deref()) else { return };
    k.attempts += 1;
    k.since = Some(std::time::Instant::now());
    let result = run_task(&task).await;
    tracing::info!(task = %task, attempt = k.attempts, result = %result,
        "the user is signed in but no sign-in helper connected: started the helper's task");
}

/// `schtasks /Run` by its absolute path; its exit code and first line.
#[cfg(windows)]
#[logged]
async fn run_task(task: &str) -> String {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let exe = std::path::PathBuf::from(root).join("System32").join("schtasks.exe");
    let task = task.to_string();
    tokio::task::spawn_blocking(move || {
        match std::process::Command::new(&exe).args(["/Run", "/TN", &task]).creation_flags(0x0800_0000).output() {
            Ok(o) => {
                let text = String::from_utf8_lossy(if o.status.success() { &o.stdout } else { &o.stderr }).trim().to_string();
                format!("exit {}: {}", o.status.code().unwrap_or(-1), text.lines().next().unwrap_or(""))
            }
            Err(e) => format!("schtasks could not start: {e}"),
        }
    })
    .await
    .unwrap_or_else(|e| format!("schtasks could not start: {e}"))
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
    fn session_blip_one_miss_then_recovery_stays_signed_in() {
        let at = std::time::Instant::now();
        let mut p = Placement::new(true);
        assert_eq!(p.observe(false,at),None);
        assert_eq!(p.observe(true,at+Duration::from_secs(2)),None);
        assert!(p.told);
    }

    #[test]
    fn session_blip_real_signout_needs_three_checks() {
        let at = std::time::Instant::now();
        let mut p = Placement::new(true);
        assert_eq!(p.observe(false,at),None);
        assert_eq!(p.observe(false,at+Duration::from_secs(2)),None);
        assert!(p.told,"placement must stay signed in during debounce");
        assert_eq!(p.observe(false,at+Duration::from_secs(4)),Some(false));
        assert_eq!(p.observe(false,at+Duration::from_secs(6)),None);
    }

    #[test]
    fn session_blip_recovery_is_immediate_and_clears_misses() {
        let at = std::time::Instant::now();
        let mut p = Placement::new(false);
        assert_eq!(p.observe(true,at),Some(true));
        assert_eq!(p.observe(false,at+Duration::from_secs(2)),None);
        assert_eq!(p.observe(true,at+Duration::from_secs(4)),None);
        assert_eq!(p.observe(false,at+Duration::from_secs(6)),None);
        assert_eq!(p.observe(false,at+Duration::from_secs(8)),None);
        assert_eq!(p.observe(false,at+Duration::from_secs(10)),Some(false));
    }

    #[test]
    fn session_blip_overdue_timer_burst_cannot_confirm_signout() {
        let at = std::time::Instant::now();
        let mut p = Placement::new(true);
        for _ in 0..10 { assert_eq!(p.observe(false,at),None); }
        assert!(p.told);
    }

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
        assert!(!SIGNED_IN_KEPT_NOTICE.contains('\n') && SIGNED_IN_KEPT_NOTICE.contains("keeps your next turn in Windows Session 0"));
        assert!(!SIGNED_IN_HELD_NOTICE.contains('\n') && SIGNED_IN_HELD_NOTICE.contains("your next turn stays in Windows Session 0"));
        assert!(!SIGNED_IN_USE_NOTICE.contains('\n') && SIGNED_IN_USE_NOTICE.contains("you picked Windows Session 0 for your next turn"));
        assert!(!SIGNED_OUT_NOTICE.contains('\n') && SIGNED_OUT_NOTICE.contains("your next turn runs in Windows Session 0"));
    }

    // sign_in_line(by preference, the runtime's view): rig-sol-b's finding on
    // 0bc97a4 (2026-10-16 13:27Z): the line says where the agent's own
    // runtime will start its next turn, as orgtree_session reports it.

    #[test]
    fn a_cli_held_by_background_work_keeps_the_next_turn_in_session0_and_the_line_says_so() {
        let held = json!({ "next_turn": "session0", "held_by_background_work": true, "use": null });
        assert!(sign_in_line(true, Some(&held)).contains("background work"));
    }

    #[test]
    fn a_pick_of_session0_for_the_next_turn_keeps_it_there_and_the_line_says_so() {
        let picked = json!({ "next_turn": "session0", "held_by_background_work": false, "use": 0 });
        assert!(sign_in_line(true, Some(&picked)).contains("you picked Windows Session 0 for your next turn"));
    }

    #[test]
    fn a_session_picked_for_the_next_turn_wins_over_a_session0_preference() {
        let picked = json!({ "next_turn": "signed-in", "held_by_background_work": false, "use": 7 });
        assert_eq!(sign_in_line(false, Some(&picked)), SIGNED_IN_NOTICE);
    }

    /// With no runtime answering, the stored preference decides, as before.
    #[test]
    fn without_a_runtime_the_preference_decides() {
        assert_eq!(sign_in_line(true, None), SIGNED_IN_NOTICE);
        assert_eq!(sign_in_line(false, None), SIGNED_IN_KEPT_NOTICE);
        let kept = json!({ "next_turn": "session0", "held_by_background_work": false, "use": null });
        assert_eq!(sign_in_line(false, Some(&kept)), SIGNED_IN_KEPT_NOTICE);
    }
}
