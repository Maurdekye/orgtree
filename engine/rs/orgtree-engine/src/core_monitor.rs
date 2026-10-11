//! Engine-owned lifecycle monitor. Bounded mailbox, no database lease or global
//! lock; all process observations are read-only. Shutdown uses runtime's drain.
use crate::{core_process::{self, Identity, Life}, core_state::{self, Snapshot}, engine::Engine};
use arc_swap::ArcSwapOption;
use std::{path::Path, sync::Arc, time::{Duration, Instant}};
use tokio::sync::{mpsc, oneshot};

pub enum Command {
    Member { desktop: bool, who: Identity, reply: oneshot::Sender<bool> },
    Transition { who: Identity, finish: bool, installing: bool, reply: oneshot::Sender<bool> },
}
pub struct Core {
    send: mpsc::Sender<Command>,
    pub state: Arc<ArcSwapOption<Snapshot>>,
    pub enabled: bool,
}
#[nolog]
impl Core {
    pub fn channel() -> (Self, mpsc::Receiver<Command>) {
        let (send, recv) = mpsc::channel(16);
        let enabled = cfg!(windows) && matches!(std::env::var("ORGTREE_CORE_MODE").as_deref(), Ok("boot" | "managed"));
        (Self { send, state: Arc::new(ArcSwapOption::empty()), enabled }, recv)
    }
    pub async fn member(&self, desktop: bool, pid: u32) -> bool {
        if !self.enabled { return true; }
        let Some(who) = core_process::identity(pid) else { return false };
        let (reply, answer) = oneshot::channel();
        if self.send.try_send(Command::Member { desktop, who, reply }).is_err() { return false; }
        tokio::time::timeout(Duration::from_secs(5), answer).await.ok().and_then(Result::ok).unwrap_or(false)
    }
    pub async fn transition(&self, pid: u32, finish: bool, installing: bool) -> bool {
        if !self.enabled { return true; }
        let Some(who) = core_process::identity(pid) else { return false };
        let (reply, answer) = oneshot::channel();
        if self.send.try_send(Command::Transition { who, finish, installing, reply }).is_err() { return false; }
        tokio::time::timeout(Duration::from_secs(5), answer).await.ok().and_then(Result::ok).unwrap_or(false)
    }
}

#[nolog]
pub fn start(engine: &Arc<Engine>, recv: mpsc::Receiver<Command>) {
    if !engine.core.enabled { return; }
    #[cfg(windows)] {
        let engine = engine.clone();
        tokio::spawn(async move { monitor(engine, recv).await; });
    }
    #[cfg(not(windows))] let _ = recv;
}

#[cfg(windows)]
#[nolog]
async fn monitor(engine: Arc<Engine>, mut recv: mpsc::Receiver<Command>) {
    use crate::core_policy::{Decision, Policy};
    let root = &engine.cfg.data_root;
    let Some(identity) = core_process::identity(std::process::id()) else { engine.request_shutdown(); return };
    let boot = std::env::var("ORGTREE_CORE_MODE").as_deref() == Ok("boot");
    let parent = engine.cfg.parent_pid.and_then(core_process::identity);
    let previous = core_state::read(root);
    let mut state = Snapshot { generation: engine.boot.id.clone(), engine: identity, host: if boot { parent.clone() } else { None },
        desktop: if boot { None } else { parent }, helper: None, sessions: vec![], transition_until: 0, transition_desktop: None, installing: false };
    if let Some(old) = previous.as_ref().filter(|s| core_state::transition(s)) {
        state.desktop = old.desktop.clone();
        state.transition_until = old.transition_until;
        state.transition_desktop = old.transition_desktop.clone();
        state.installing = old.installing;
    }
    let mut sessions = core_process::Sessions::new();
    if let Some(found) = sessions.as_mut().and_then(|s| s.read()) {
        if core_state::blocked(root, &found) { engine.request_shutdown(); return; }
        state.sessions = found;
    }
    if core_state::write(root, &state).is_err() { engine.request_shutdown(); return; }
    engine.core.state.store(Some(Arc::new(state.clone())));
    let began = Instant::now(); let mut policy = Policy::new(boot);
    let mut desktop_gone = None; let mut helper_gone = None;
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = engine.shutdown.cancelled() => {
                // Quit/fault must suppress task recovery too. Sign-out and an
                // authenticated replacement are the only background exceptions.
                if sessions.as_mut().and_then(|s| s.read()).is_some_and(|s| !s.is_empty()) && !core_state::transition(&state) {
                    let _ = core_state::stop(root, &state, "engine shutdown");
                }
                break;
            }
            cmd = recv.recv() => {
                let Some(cmd) = cmd else { break };
                let stopped = core_state::stopped(root, &state);
                let accepted = match &cmd {
                    Command::Member { desktop, who, .. } => {
                        let replacement = *desktop && state.installing && core_state::transition(&state);
                        let member = if *desktop { &mut state.desktop } else { &mut state.helper };
                        if !stopped && (replacement || member.as_ref().is_none_or(|old| old == who)) {
                            *member = Some(who.clone()); true
                        } else { false }
                    }
                    Command::Transition { who, finish, installing, .. } => {
                        if stopped || state.desktop.as_ref() != Some(who) { false }
                        else if *finish {
                            state.transition_until = 0; state.transition_desktop = None; state.installing = false; true
                        } else if state.transition_until == 0 {
                            state.transition_until = core_state::now() + crate::core_policy::TRANSITION_MAX_MS as i64;
                            state.transition_desktop = Some(who.clone());
                            state.installing = *installing; true
                        } else { false }
                    }
                };
                let ok = accepted && core_state::write(root, &state).is_ok();
                if ok { engine.core.state.store(Some(Arc::new(state.clone()))); }
                match cmd { Command::Member { reply, .. } | Command::Transition { reply, .. } => { let _ = reply.send(ok); } }
            }
            _ = timer.tick() => {
                let current = sessions.as_mut().and_then(|s| s.read());
                if let Some(current) = &current {
                    if *current != state.sessions {
                        // A new interactive logon cannot reuse dead identities from
                        // the old one; startup grace restarts for the new epoch.
                        state.sessions = current.clone();
                        state.desktop = if boot { None } else { engine.cfg.parent_pid.and_then(core_process::identity) };
                        state.helper = None; state.transition_until = 0; state.transition_desktop = None; state.installing = false;
                        desktop_gone = None; helper_gone = None; policy = Policy::new(boot);
                        let _ = core_state::write(root, &state);
                        engine.core.state.store(Some(Arc::new(state.clone())));
                    }
                }
                let signed_in = current.as_ref().map(|s| !s.is_empty());
                let decision = if core_state::stopped(root, &state) { Decision::Stop("core shutdown already requested") }
                    else if state.transition_until != 0 && signed_in == Some(true) {
                        if core_state::transition(&state) { Decision::Keep } else { Decision::Stop("intentional transition timed out or desktop exited") }
                    } else {
                        policy.tick(began.elapsed().as_millis() as u64, signed_in,
                            presence(state.desktop.as_ref(), &mut desktop_gone), presence(state.helper.as_ref(), &mut helper_gone))
                    };
                if let Decision::Stop(reason) = decision {
                    let _ = core_state::stop(root, &state, reason);
                    tracing::warn!(reason, "Core application process lost; requesting coordinated shutdown");
                    engine.request_shutdown(); break;
                }
            }
        }
    }
}

#[cfg(windows)]
#[nolog]
fn presence(who: Option<&Identity>, gone: &mut Option<Instant>) -> crate::core_policy::Presence {
    use crate::core_policy::Presence;
    let Some(who) = who else { *gone = None; return Presence::Missing };
    match core_process::life(who) {
        Life::Alive => { *gone = None; Presence::Alive },
        Life::Unknown => Presence::Unknown,
        Life::Gone => {
            // Windows tears down interactive processes during sign-out before
            // WTS necessarily drops the logon. Allow that bounded reconciliation.
            if gone.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(5) { Presence::Gone } else { Presence::Unknown }
        }
    }
}

/// Native read-only process check for the desktop after HTTP fails; a process
/// exit (not a network timeout) latches shutdown. `begin` is startup-only.
#[nolog]
pub fn cli(args: &[String]) -> std::process::ExitCode {
    #[cfg(windows)] {
        if args.len() != 2 || !Path::new(&args[1]).is_absolute() { return std::process::ExitCode::from(2); }
        let root = Path::new(&args[1]);
        if args[0] == "begin" {
            return match core_state::begin(root) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(message) => { eprintln!("{message}"); std::process::ExitCode::from(1) },
            };
        }
        if args[0] != "status" { return std::process::ExitCode::from(2); }
        let mut session = core_process::Sessions::new();
        let active = session.as_mut().and_then(|s| s.read());
        let stopped = core_state::read(root).is_some_and(|s| active.as_ref().is_some_and(|a| core_state::observe_engine(root, &s, a)));
        println!("{}", serde_json::json!({"stopped":stopped}));
    }
    #[cfg(not(windows))] let _ = args;
    std::process::ExitCode::SUCCESS
}
