//! `orgtree-engine-host`: the windowless launcher of the "Orgtree Sign-in
//! Engine" scheduled task (Windows only; docket
//! option-to-run-the-background-engine-in-the-user-s, user 2026-10-15).
//!
//! With "At sign-in, in my session" chosen, that task starts this program at
//! the operator's sign-in, with their interactive token, in their own
//! session (tools/boot-engine-task.ps1). It starts `orgtree-engine host`
//! beside it, the same host the boot task runs (src/host.rs), and waits for
//! it, so the task runs exactly as long as the host does.
//!
//! It exists only because `orgtree-engine` is a console program: started by
//! an interactive-token task it would open a console window at every
//! sign-in. Started from here it gets none (`CREATE_NO_WINDOW`), and neither
//! does the engine it starts. The credential broker is a separate windowless
//! binary for the same reason (DECISIONS 68).
//!
//! Ending the task ends this launcher only. The host watches it
//! (`ORGTREE_HOST_LAUNCHER_PID`) and then stops the engine the graceful way,
//! with its own token, as on a console stop.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[macro_use]
extern crate orgtree_logged;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The engine binary beside this launcher.
#[nolog]
fn engine_beside(launcher: &Path) -> PathBuf {
    let name = if cfg!(windows) { "orgtree-engine.exe" } else { "orgtree-engine" };
    launcher.parent().map(|dir| dir.join(name)).unwrap_or_else(|| PathBuf::from(name))
}

/// The host's exit code as this launcher's: what Task Scheduler records as
/// the task's last result (0 a requested stop, 75 another engine owns the
/// data folder, 1 a failure; src/host.rs).
#[nolog]
fn exit_code(code: Option<i32>) -> u8 {
    code.and_then(|c| u8::try_from(c).ok()).unwrap_or(1)
}

#[cfg(not(windows))]
#[nolog]
fn main() -> ExitCode {
    let _ = (engine_beside, exit_code);
    eprintln!("orgtree-engine-host runs on Windows only; elsewhere the login registration runs `orgtree-engine host`");
    ExitCode::from(2)
}

#[cfg(windows)]
#[nolog]
fn main() -> ExitCode {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(launcher) = std::env::current_exe() else { return ExitCode::from(1) };
    let engine = engine_beside(&launcher);
    let mut host = Command::new(&engine);
    host.arg("host")
        .env("ORGTREE_HOST_LAUNCHER_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = engine.parent() {
        host.current_dir(dir);
    }
    match host.spawn().and_then(|mut child| child.wait()) {
        Ok(status) => ExitCode::from(exit_code(status.code())),
        Err(_) => ExitCode::from(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launcher_starts_the_engine_beside_it() {
        let dir = Path::new("resources").join("engine");
        let engine = if cfg!(windows) { "orgtree-engine.exe" } else { "orgtree-engine" };
        assert_eq!(engine_beside(&dir.join("orgtree-engine-host.exe")), dir.join(engine));
    }

    #[test]
    fn the_task_result_is_the_host_exit_code() {
        assert_eq!(exit_code(Some(0)), 0);
        assert_eq!(exit_code(Some(75)), 75);
        assert_eq!(exit_code(Some(-1)), 1);
        assert_eq!(exit_code(Some(300)), 1);
        assert_eq!(exit_code(None), 1);
    }
}
