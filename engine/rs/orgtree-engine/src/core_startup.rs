//! Observe already-known core identities while database startup/conversion is
//! still running. Missing membership is not a fault until control is ready.
use crate::{config::Config, core_process::{self, Life}, core_state};
use tokio_util::sync::CancellationToken;

pub struct Startup {
    pub generation: String,
    pub cancelled: CancellationToken,
    watcher: Option<tokio::task::JoinHandle<()>>,
}

#[nolog]
impl Startup {
    pub fn begin(cfg: &Config) -> anyhow::Result<Self> {
        let mut out = Self { generation: uuid::Uuid::new_v4().simple().to_string(),
            cancelled: CancellationToken::new(), watcher: None };
        #[cfg(windows)]
        if matches!(std::env::var("ORGTREE_CORE_MODE").as_deref(), Ok("boot" | "managed")) {
            let boot = std::env::var("ORGTREE_CORE_MODE").as_deref() == Ok("boot");
            let identity = core_process::identity(std::process::id()).ok_or_else(|| anyhow::anyhow!("cannot inspect engine identity"))?;
            let parent = cfg.parent_pid.and_then(core_process::identity);
            let old = core_state::read(&cfg.data_root);
            let mut sessions = core_process::Sessions::new();
            // An unreadable session query is not a fresh logon and cannot
            // discard a stopped generation's automatic-restart suppression.
            let active = core_state::sessions(&cfg.data_root, &mut sessions)
                .unwrap_or_else(|| old.as_ref().map(|s| s.sessions.clone()).unwrap_or_default());
            if core_state::blocked(&cfg.data_root, &active) { anyhow::bail!("core session is stopped"); }
            let mut state = core_state::Snapshot { generation: out.generation.clone(), engine: identity,
                host: if boot { parent.clone() } else { None }, desktop: if boot { None } else { parent },
                helper: None, sessions: active, transition_until: 0, transition_desktop: None, installing: false };
            if let Some(old) = old.filter(core_state::transition) {
                state.desktop = old.desktop; state.helper = old.helper;
                state.transition_until = old.transition_until; state.transition_desktop = old.transition_desktop;
                state.installing = old.installing;
            }
            core_state::write(&cfg.data_root, &state)?;
            let root = cfg.data_root.clone(); let cancel = out.cancelled.clone();
            out.watcher = Some(tokio::spawn(async move {
                let mut gone_since = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let Some(active) = core_state::sessions(&root, &mut sessions) else { continue };
                    if active != state.sessions {
                        state.sessions = active.clone();
                        let _ = core_state::write(&root, &state);
                    }
                    if active.is_empty() { gone_since = None; continue; }
                    let gone = [&state.host, &state.desktop, &state.helper].into_iter().flatten()
                        .any(|who| core_process::life(who) == Life::Gone);
                    if core_state::stopped(&root, &state) {
                        cancel.cancel(); break;
                    }
                    if gone && !core_state::transition(&state) {
                        let since = gone_since.get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() >= std::time::Duration::from_secs(5) {
                            let _ = core_state::stop(&root, &state, "known core process exited before readiness");
                            cancel.cancel(); break;
                        }
                    } else { gone_since = None; }
                }
            }));
        }
        #[cfg(not(windows))] let _ = cfg;
        Ok(out)
    }

    pub fn finish(&mut self) { if let Some(task) = self.watcher.take() { task.abort(); } }
}

#[nolog]
impl Drop for Startup {
    fn drop(&mut self) { self.finish(); }
}
