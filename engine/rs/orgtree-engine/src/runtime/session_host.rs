//! Where an agent's CLI runs (docket
//! option-to-run-the-background-engine-in-the-user-s; the user, 2026-10-16
//! 09:37Z: "agents always start at boot, and then automatically get upgraded
//! when signed in"). The engine starts at boot, in Windows Session 0. While
//! the operator is signed in, the sign-in helper (credential_broker_host.rs)
//! starts every harness's CLI in their session instead, with the same program,
//! arguments, folder and environment, so each agent's folder, tool and
//! permission limits are the same in both sessions. Where a turn's CLI runs is
//! chosen when it starts (`wanted`); the actor moves an agent at its next turn,
//! never during one. Since decision 68 the helper started sandboxed Codex
//! seats only.
//!
//! A launcher, not a relay: the engine serves the child's three stdio pipes;
//! the helper, proven to be the interactive operator by the bridge, connects
//! them, starts the CLI with them in the user's session and keeps it in a job
//! that ends with the helper or with this engine. The request carries the
//! child's environment, so nothing here logs more than pids and fixed codes.
//! Signing out ends the helper and its jobs, and with them every hosted CLI.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, Command};

use crate::engine::Engine;
use crate::winproc;

/// Whether bypassPermissions seats move into the signed-in session too. The
/// user, 2026-10-16 09:43Z: "Yes, all agents", superseding decision 68's
/// ruling Q1 (an unsandboxed seat stayed in Session 0); false restores Q1.
pub const HOST_BYPASS_SEATS: bool = true;

/// Whether a CLI that starts now runs in the operator's signed-in session:
/// only from an engine in Session 0, while the sign-in helper hosts.
#[logged]
pub fn wanted(engine: &Engine, bypass: bool) -> bool {
    crate::runtime::codex::session0() && engine.credential_bridge.can_host() && (HOST_BYPASS_SEATS || !bypass)
}

/// An agent's preference over the engine user's signed-in sessions, kept in
/// its own scope as `session` (absent: `signed-in`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum Pref {
    /// any signed-in session, an active one first (the default)
    SignedIn,
    /// always Session 0
    Session0,
    /// sessions of these kinds, in this order (`console`, `remote`, or
    /// `signed-in` for any), then Session 0
    Kinds(Vec<String>),
}

/// One of the engine user's sessions where a sign-in helper hosts.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct HostSession {
    pub id: u32,
    /// `console` or `remote`
    pub kind: String,
    /// connected, as opposed to disconnected (signed in, nothing shown)
    pub active: bool,
}

/// A stored or requested preference: so far there is none.
#[logged]
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_pref(v: &serde_json::Value) -> std::result::Result<Pref, String> {
    let _ = v;
    Ok(Pref::SignedIn)
}

/// Where a CLI that starts now runs among `sessions`: a session id, or None
/// for Session 0. So far: the helper's session whenever one hosts.
#[logged]
#[cfg_attr(not(test), allow(dead_code))]
pub fn choose(sessions: &[HostSession], pref: &Pref, use_id: Option<u32>) -> Option<u32> {
    let _ = (pref, use_id);
    sessions.first().map(|s| s.id)
}

/// A CLI's stdio, whoever started it.
pub struct Io {
    pub stdin: Box<dyn AsyncWrite + Unpin + Send>,
    pub stdout: Box<dyn AsyncRead + Unpin + Send>,
    pub stderr: Box<dyn AsyncRead + Unpin + Send>,
}

/// A started CLI: this engine's child, or one the sign-in helper started in
/// the user's session.
pub struct Launched {
    kind: Kind,
}

enum Kind {
    Local(Box<Child>),
    Hosted(Hosted),
}

/// A CLI that has just started, and how to reach it.
pub struct Started {
    pub io: Io,
    pub launched: Launched,
    /// its tree in a kill-on-close job of this engine (for a hosted CLI only
    /// when Windows lets the engine hold one; the helper's job ends it anyway)
    pub job: Option<winproc::ChildJob>,
    pub pid: u32,
}

/// Start a CLI: in the user's session when `host` and the helper starts it,
/// else here. `build(hosted)` makes the command for where it runs (Codex's
/// and Muse's sandboxes depend on it); a hosted start that fails is logged and
/// made here instead. `cleared`: `build` called `env_clear`, so its own
/// variables are the child's whole environment.
#[nolog]
pub async fn spawn(
    engine: &Arc<Engine>,
    host: bool,
    cleared: bool,
    agent: i64,
    what: &str,
    mut build: impl FnMut(bool) -> Result<Command>,
) -> Result<(Started, bool)> {
    if host {
        let cmd = build(true)?;
        match request(&cmd, cleared) {
            Ok(r) => match start_hosted(engine, &r.exe, &r.args, &r.cwd, &r.env).await {
                Ok((io, h)) => {
                    let job = h.job();
                    let pid = h.pid;
                    tracing::info!(agent, pid, cli = what, "CLI started by the sign-in helper in the user's session");
                    return Ok((Started { io, launched: Launched { kind: Kind::Hosted(h) }, job, pid }, true));
                }
                Err(code) => tracing::warn!(agent, cli = what, reason = %code,
                    "the sign-in helper could not start the CLI; starting it in Session 0"),
            },
            Err(code) => tracing::warn!(agent, cli = what, reason = %code,
                "the CLI cannot be started by the sign-in helper; starting it in Session 0"),
        }
    }
    let started = spawn_local(build(false)?).with_context(|| format!("could not start {what}"))?;
    Ok((started, false))
}

/// Start a command here, its three stdio piped (the caller set that up) and
/// its tree in this engine's job.
#[nolog]
pub fn spawn_local(mut cmd: Command) -> Result<Started> {
    let mut child = cmd.spawn()?;
    let job = winproc::child_job(&child);
    let pid = child.id().unwrap_or(0);
    let io = Io {
        stdin: Box::new(child.stdin.take().context("no stdin")?),
        stdout: Box::new(child.stdout.take().context("no stdout")?),
        stderr: Box::new(child.stderr.take().context("no stderr")?),
    };
    Ok(Started { io, launched: Launched { kind: Kind::Local(Box::new(child)) }, job, pid })
}

/// What the helper is asked to start.
struct Request {
    exe: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
}

/// The command's program, arguments, folder and whole environment (the
/// engine's own unless `cleared`, with the command's changes; Windows names
/// are matched without case). Fixed codes.
#[nolog]
fn request(cmd: &Command, cleared: bool) -> std::result::Result<Request, String> {
    let std = cmd.as_std();
    let text = |s: &std::ffi::OsStr| s.to_str().map(str::to_string).ok_or_else(|| "host-invalid".to_string());
    let exe = text(std.get_program())?;
    let args = std.get_args().map(text).collect::<std::result::Result<Vec<_>, _>>()?;
    let cwd = std.get_current_dir().map(|d| text(d.as_os_str())).transpose()?.ok_or("host-invalid")?;
    let mut env: Vec<(String, String)> = if cleared { Vec::new() } else { std::env::vars().collect() };
    for (k, v) in std.get_envs() {
        let k = text(k)?;
        env.retain(|(e, _)| !e.eq_ignore_ascii_case(&k));
        if let Some(v) = v {
            env.push((k, text(v)?));
        }
    }
    Ok(Request { exe, args, cwd, env })
}

#[nolog]
impl Launched {
    pub fn hosted(&self) -> bool {
        matches!(self.kind, Kind::Hosted(_))
    }

    pub fn alive(&mut self) -> bool {
        match &mut self.kind {
            Kind::Local(c) => matches!(c.try_wait(), Ok(None)),
            Kind::Hosted(h) => h.alive(),
        }
    }

    /// End it now, without waiting: a hosted CLI's helper is asked to end its
    /// tree (or, if the helper is gone, the process itself is ended here).
    pub fn start_kill(&mut self) {
        match &mut self.kind {
            Kind::Local(c) => {
                let _ = c.start_kill();
            }
            Kind::Hosted(h) => h.start_kill(),
        }
    }

    pub async fn wait_exit(&mut self, pid: u32, process: uuid::Uuid, reason: &str, timeout: Duration) -> String {
        match &mut self.kind {
            Kind::Local(c) => super::wait_exit(c, pid, process, reason, timeout).await,
            Kind::Hosted(h) => h.wait_exit(process, reason, timeout).await,
        }
    }

    /// `super::stop_gracefully` for either kind: the CALLER HAS ALREADY CLOSED
    /// ITS STDIN, it gets `grace` to exit by itself, and only then are its job
    /// and the process ended. Either outcome goes to the durable kill record.
    pub async fn stop_gracefully(&mut self, job: Option<&winproc::ChildJob>, who: &str, reason: &str, grace: Duration) -> String {
        let h = match &mut self.kind {
            Kind::Local(c) => return super::stop_gracefully(c, job, who, reason, grace).await,
            Kind::Hosted(h) => h,
        };
        let started = std::time::Instant::now();
        let status = h.wait_exit(uuid::Uuid::nil(), reason, grace).await;
        let waited = started.elapsed().as_millis() as u64;
        if !status.starts_with("exit status unavailable") {
            crate::codex_kills::graceful(h.pid, who, reason, waited);
            return status;
        }
        crate::codex_kills::force(h.pid, true, who, &format!("{reason} (hosted by the sign-in helper)"), true, waited);
        if let Some(job) = job {
            job.terminate();
        }
        h.kill().await;
        h.wait_exit(uuid::Uuid::nil(), "close required termination", Duration::from_secs(1)).await
    }
}

/// `super::exit_status` for either kind.
#[nolog]
pub async fn exit_status(child: &mut Option<Launched>, pid: u32, process: uuid::Uuid, reason: &str) -> String {
    match child.as_mut() {
        Some(c) => c.wait_exit(pid, process, reason, Duration::from_secs(1)).await,
        None => "exit status unavailable (process already reaped)".to_string(),
    }
}

#[cfg(windows)]
pub use win::{start_hosted, Hosted};

#[cfg(windows)]
mod win {
    use super::*;
    use serde_json::{json, Value};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub struct Hosted {
        pub pid: u32,
        created: u64,
        /// SYNCHRONIZE + query (+ terminate and set-quota when granted); 0 if none
        process: usize,
        engine: Arc<Engine>,
    }

    impl Drop for Hosted {
        #[nolog]
        fn drop(&mut self) {
            if self.process != 0 {
                unsafe { CloseHandle(self.process as HANDLE) };
            }
        }
    }

    #[nolog]
    fn serve(name: &str, inbound: bool) -> std::result::Result<NamedPipeServer, String> {
        ServerOptions::new()
            .first_pipe_instance(true)
            .max_instances(1)
            .reject_remote_clients(true)
            .access_inbound(inbound)
            .access_outbound(!inbound)
            .create(name)
            .map_err(|_| "host-pipe".to_string())
    }

    /// The helper must be the pipe's client (it opens all three before it
    /// starts the child, so `connect` returns at once).
    #[nolog]
    async fn accept(p: &NamedPipeServer, helper: u32) -> std::result::Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        tokio::time::timeout(Duration::from_secs(5), p.connect())
            .await
            .map_err(|_| "host-pipe".to_string())?
            .map_err(|_| "host-pipe".to_string())?;
        let mut client = 0;
        if unsafe { GetNamedPipeClientProcessId(p.as_raw_handle() as _, &mut client) } == 0 || client != helper {
            return Err("host-pipe".into());
        }
        Ok(())
    }

    /// Have the sign-in helper start `exe` in the user's session, its stdio
    /// three pipes this engine serves. Fixed failure codes only.
    #[nolog]
    pub async fn start_hosted(
        engine: &Arc<Engine>,
        exe: &str,
        args: &[String],
        cwd: &str,
        env: &[(String, String)],
    ) -> std::result::Result<(Io, Hosted), String> {
        let bridge = &engine.credential_bridge;
        let helper = bridge.host_pid().ok_or("host-gone")?;
        let base = format!(r"\\.\pipe\orgtree-cli-{}", uuid::Uuid::new_v4().simple());
        let names = [format!("{base}-in"), format!("{base}-out"), format!("{base}-err")];
        let stdin = serve(&names[0], false)?;
        let stdout = serve(&names[1], true)?;
        let stderr = serve(&names[2], true)?;
        let env: serde_json::Map<String, Value> = env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
        let request = json!({ "kind": "spawn", "exe": exe, "args": args, "cwd": cwd, "env": env,
                              "pipes": { "stdin": names[0], "stdout": names[1], "stderr": names[2] } });
        let reply = bridge.host(request).await?;
        let r: Value = serde_json::from_slice(&reply).map_err(|_| "host-failed".to_string())?;
        let (pid, created) = match (r["pid"].as_u64(), r["created"].as_u64()) {
            (Some(p), Some(c)) if p > 0 => (p as u32, c),
            _ => return Err("host-failed".into()),
        };
        let wait = PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
        let mut process = unsafe { OpenProcess(wait | PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid) };
        if process.is_null() {
            process = unsafe { OpenProcess(wait, 0, pid) };
        }
        let hosted = Hosted { pid, created, process: process as usize, engine: engine.clone() };
        let connected = async {
            if hosted.process == 0 {
                return Err("host-process".to_string());
            }
            for p in [&stdin, &stdout, &stderr] {
                accept(p, helper).await?;
            }
            Ok(())
        }
        .await;
        if let Err(code) = connected {
            // its pipes close first: it gets the chance to exit by itself
            drop((stdin, stdout, stderr));
            let who = "CLI launch by the sign-in helper";
            let started = std::time::Instant::now();
            let status = hosted.wait_exit(uuid::Uuid::nil(), "the engine could not connect its pipes", Duration::from_secs(3)).await;
            let waited = started.elapsed().as_millis() as u64;
            if status.starts_with("exit status unavailable") {
                crate::codex_kills::force(pid, true, who, "the engine could not connect its pipes", true, waited);
                hosted.kill().await;
            } else {
                crate::codex_kills::graceful(pid, who, "the engine could not connect its pipes", waited);
            }
            return Err(code);
        }
        Ok((Io { stdin: Box::new(stdin), stdout: Box::new(stdout), stderr: Box::new(stderr) }, hosted))
    }

    #[nolog]
    impl Hosted {
        /// Its tree in an engine job too, when Windows lets this engine hold
        /// one (the helper's job ends it either way).
        pub fn job(&self) -> Option<winproc::ChildJob> {
            (self.process != 0).then(|| winproc::ChildJob::for_process(self.process as HANDLE)).flatten()
        }

        /// The helper ends it with everything it started; if the helper is
        /// gone, the process itself is ended here when Windows allows it.
        pub async fn kill(&self) {
            let asked = self
                .engine
                .credential_bridge
                .host(json!({ "kind": "kill", "pid": self.pid, "created": self.created }))
                .await;
            if asked.is_err() && self.process != 0 {
                unsafe { TerminateProcess(self.process as HANDLE, 1) };
            }
        }

        /// `kill` without waiting for the helper's answer.
        pub fn start_kill(&self) {
            let (engine, pid, created, process) = (self.engine.clone(), self.pid, self.created, self.process);
            // a duplicate keeps the handle valid after this Hosted is dropped
            let own = if process == 0 { 0 } else { duplicate(process) };
            tokio::spawn(async move {
                let asked = engine.credential_bridge.host(json!({ "kind": "kill", "pid": pid, "created": created })).await;
                if own != 0 {
                    if asked.is_err() {
                        unsafe { TerminateProcess(own as HANDLE, 1) };
                    }
                    unsafe { CloseHandle(own as HANDLE) };
                }
            });
        }

        pub fn alive(&self) -> bool {
            self.process != 0 && unsafe { WaitForSingleObject(self.process as HANDLE, 0) } != WAIT_OBJECT_0
        }

        pub async fn wait_exit(&self, process: uuid::Uuid, reason: &str, timeout: Duration) -> String {
            let handle = self.process;
            let ms = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
            let status = tokio::task::spawn_blocking(move || unsafe {
                if handle == 0 {
                    return "exit status unavailable: no process handle".to_string();
                }
                if WaitForSingleObject(handle as HANDLE, ms) != WAIT_OBJECT_0 {
                    return "exit status unavailable: process has not exited".to_string();
                }
                let mut code = 0u32;
                if GetExitCodeProcess(handle as HANDLE, &mut code) == 0 || code == STILL_ACTIVE as u32 {
                    return "exit status unavailable".to_string();
                }
                format!("exit code: {code}")
            })
            .await
            .unwrap_or_else(|_| "exit status unavailable".to_string());
            tracing::info!(pid = self.pid, %process, reason, %status, hosted = true, "CLI exit observation");
            status
        }
    }

    #[nolog]
    fn duplicate(process: usize) -> usize {
        use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut out: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(GetCurrentProcess(), process as HANDLE, GetCurrentProcess(), &mut out, 0, 0, DUPLICATE_SAME_ACCESS)
        };
        if ok == 0 { 0 } else { out as usize }
    }
}

/// No sign-in helper outside Windows: every CLI starts here.
#[cfg(not(windows))]
pub use other::{start_hosted, Hosted};

#[cfg(not(windows))]
mod other {
    use super::*;
    pub struct Hosted {
        pub pid: u32,
    }
    #[nolog]
    pub async fn start_hosted(_: &Arc<Engine>, _: &str, _: &[String], _: &str, _: &[(String, String)]) -> std::result::Result<(Io, Hosted), String> {
        Err("host-unsupported".into())
    }
    #[nolog]
    impl Hosted {
        pub fn job(&self) -> Option<winproc::ChildJob> {
            None
        }
        pub async fn kill(&self) {}
        pub fn start_kill(&self) {}
        pub fn alive(&self) -> bool {
            false
        }
        pub async fn wait_exit(&self, _: uuid::Uuid, _: &str, _: Duration) -> String {
            "exit status unavailable".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper starts what the engine would have: the command's program,
    /// arguments and folder, and the engine's environment with the command's
    /// changes applied (a removal matches any casing), or with `env_clear`
    /// only the command's own variables.
    #[test]
    fn a_hosted_launch_is_the_same_command() {
        std::env::set_var("ORGTREE_SESSION_HOST_TEST_KEEP", "kept");
        std::env::set_var("ORGTREE_SESSION_HOST_TEST_DROP", "secret");
        let mut cmd = Command::new(std::env::temp_dir().join("claude.exe"));
        cmd.args(["-p", "--model", "m"]).current_dir(std::env::temp_dir());
        cmd.env_remove("orgtree_session_host_test_drop").env("ORGTREE_SESSION_HOST_TEST_ADD", "added");
        let Request { exe, args, cwd, env } = request(&cmd, false).unwrap();
        assert!(exe.ends_with("claude.exe"), "{exe}");
        assert_eq!(args, ["-p", "--model", "m"]);
        assert_eq!(cwd, std::env::temp_dir().to_str().unwrap());
        let get = |k: &str| env.iter().find(|(e, _)| e.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
        assert_eq!(get("ORGTREE_SESSION_HOST_TEST_KEEP"), Some("kept"));
        assert_eq!(get("ORGTREE_SESSION_HOST_TEST_ADD"), Some("added"));
        assert_eq!(get("ORGTREE_SESSION_HOST_TEST_DROP"), None, "a removed variable stays removed whatever its casing");
        cmd.env_clear().env("ONLY", "this");
        let Request { env, .. } = request(&cmd, true).unwrap();
        assert_eq!(env, [("ONLY".to_string(), "this".to_string())]);
        // a command without its folder cannot be hosted (it would start in the helper's)
        let bare = Command::new("codex.exe");
        assert_eq!(request(&bare, false).err().as_deref(), Some("host-invalid"));
    }
}

#[cfg(test)]
mod choice_tests {
    use super::*;
    use serde_json::json;

    #[nolog]
    fn s(id: u32, kind: &str, active: bool) -> HostSession {
        HostSession { id, kind: kind.into(), active }
    }

    /// The user, 2026-10-16 12:12Z and 12:13Z: an agent's preference over
    /// the user's own sessions, by kind; "signed-in" is the default and
    /// Session 0 the fallback.
    #[test]
    fn a_preference_is_one_kind_an_ordered_list_any_or_session0() {
        assert_eq!(parse_pref(&json!(null)), Ok(Pref::SignedIn));
        assert_eq!(parse_pref(&json!("signed-in")), Ok(Pref::SignedIn));
        assert_eq!(parse_pref(&json!("session0")), Ok(Pref::Session0));
        assert_eq!(parse_pref(&json!("console")), Ok(Pref::Kinds(vec!["console".into()])));
        assert_eq!(parse_pref(&json!(["remote", "console"])), Ok(Pref::Kinds(vec!["remote".into(), "console".into()])));
        assert!(parse_pref(&json!("elsewhere")).is_err());
        assert!(parse_pref(&json!(["remote", 3])).is_err());
        assert!(parse_pref(&json!([])).is_err());
        assert!(parse_pref(&json!(["session0", "console"])).is_err(), "Session 0 is the fallback, not a list entry");
    }

    #[test]
    fn the_choice_follows_the_request_then_the_preference_then_session0() {
        let both = [s(3, "remote", false), s(1, "console", true), s(4, "remote", true)];
        assert_eq!(choose(&both, &Pref::SignedIn, None), Some(1), "any: an active one first, lowest id");
        assert_eq!(choose(&[s(3, "remote", false)], &Pref::SignedIn, None), Some(3), "a disconnected one rather than none");
        assert_eq!(choose(&both, &Pref::Session0, None), None);
        assert_eq!(choose(&both, &Pref::Kinds(vec!["remote".into()]), None), Some(4), "active before disconnected");
        assert_eq!(choose(&both, &Pref::Kinds(vec!["remote".into(), "console".into()]), None), Some(4));
        assert_eq!(choose(&[s(1, "console", true)], &Pref::Kinds(vec!["remote".into()]), None), None, "no such kind: Session 0");
        assert_eq!(choose(&[s(1, "console", true)], &Pref::Kinds(vec!["remote".into(), "signed-in".into()]), None), Some(1));
        assert_eq!(choose(&both, &Pref::Session0, Some(3)), Some(3), "an on-demand choice wins while its session hosts");
        assert_eq!(choose(&both, &Pref::SignedIn, Some(0)), None, "on demand, Session 0");
        assert_eq!(choose(&both, &Pref::Kinds(vec!["remote".into()]), Some(9)), Some(4), "a gone session lapses");
        assert_eq!(choose(&[], &Pref::SignedIn, Some(3)), None);
    }
}
