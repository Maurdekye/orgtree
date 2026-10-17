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

/// Which of the operator's signed-in sessions a CLI that starts now runs in
/// (None: here, which is Session 0 for an engine there): only from an engine
/// in Session 0, while a sign-in helper hosts, chosen by `choose` from the
/// agent's preference and on-demand pick (the user, 2026-10-16 12:12Z and
/// 12:13Z).
#[logged]
pub fn wanted(engine: &Engine, bypass: bool, pref: &Pref, use_id: Option<u32>) -> Option<u32> {
    if !crate::runtime::codex::session0() || (bypass && !HOST_BYPASS_SEATS) {
        return None;
    }
    choose(&host_sessions(engine), pref, use_id)
}

/// The Windows session this engine runs in: 0 for the boot task (and a rig
/// engine that stands for it), and outside Windows.
#[logged]
pub fn engine_session() -> u32 {
    if crate::runtime::codex::session0() {
        return 0;
    }
    #[cfg(windows)]
    {
        let mut id = 0u32;
        if unsafe { windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(), &mut id) } != 0 {
            return id;
        }
    }
    0
}

/// The engine user's sessions where a sign-in helper hosts, by id.
#[logged]
pub fn host_sessions(engine: &Engine) -> Vec<HostSession> {
    let stand_in = rig_sessions(engine);
    engine
        .credential_bridge
        .placement_hosting()
        .into_iter()
        .map(|(id, _)| {
            let (kind, active, _) = stand_in.get(&id).cloned().unwrap_or_else(|| session_info(id));
            HostSession { id, kind, active }
        })
        .collect()
}

/// One hosting session for orgtree_session: id, kind, state and user.
#[logged]
pub fn describe(engine: &Engine, id: u32) -> serde_json::Value {
    let (kind, active, user) = rig_sessions(engine).get(&id).cloned().unwrap_or_else(|| session_info(id));
    serde_json::json!({ "id": id, "kind": kind, "state": if active { "active" } else { "disconnected" }, "user": user })
}

/// A debug rig engine's synthetic sessions, `<data>\rig-sessions.json`:
/// {"7": {"kind": "remote", "active": true, "user": "rig"}}.
#[nolog]
fn rig_sessions(engine: &Engine) -> std::collections::HashMap<u32, (String, bool, String)> {
    let mut out = std::collections::HashMap::new();
    #[cfg(debug_assertions)]
    if crate::rig::active() {
        let file = engine.cfg.data_root.join("rig-sessions.json");
        if let Some(map) = std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
            for (id, v) in map.as_object().into_iter().flatten() {
                if let Ok(id) = id.parse::<u32>() {
                    let kind = if v["kind"] == "remote" { "remote" } else { "console" };
                    out.insert(id, (kind.to_string(), v["active"].as_bool().unwrap_or(true), v["user"].as_str().unwrap_or("").to_string()));
                }
            }
        }
    }
    let _ = engine;
    out
}

/// (kind, connected, user) of a Windows session: `remote` for RDP, else
/// `console`.
#[cfg(windows)]
#[nolog]
fn session_info(id: u32) -> (String, bool, String) {
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSClientProtocolType, WTSConnectState, WTSFreeMemory, WTSQuerySessionInformationW, WTSUserName, WTS_CURRENT_SERVER_HANDLE,
        WTS_INFO_CLASS,
    };
    let query = |class: WTS_INFO_CLASS| -> Option<Vec<u8>> {
        let mut buf = std::ptr::null_mut();
        let mut len = 0u32;
        unsafe {
            if WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, id, class, &mut buf, &mut len) == 0 || buf.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(buf as *const u8, len as usize).to_vec();
            WTSFreeMemory(buf.cast());
            Some(bytes)
        }
    };
    let protocol = query(WTSClientProtocolType).and_then(|b| b.get(0..2).map(|x| u16::from_le_bytes([x[0], x[1]])));
    // WTS_CONNECTSTATE_CLASS: 0 is WTSActive
    let state = query(WTSConnectState).and_then(|b| b.get(0..4).map(|x| i32::from_le_bytes([x[0], x[1], x[2], x[3]])));
    let user = query(WTSUserName)
        .map(|b| {
            let wide: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|c| *c != 0).collect();
            String::from_utf16_lossy(&wide)
        })
        .unwrap_or_default();
    let kind = if protocol == Some(2) { "remote" } else { "console" };
    (kind.to_string(), state == Some(0), user)
}

#[cfg(not(windows))]
#[nolog]
fn session_info(_id: u32) -> (String, bool, String) {
    ("console".into(), true, String::new())
}

/// How a preference is stored in the agent's scope: absent for the default.
#[logged]
pub fn pref_value(p: &Pref) -> serde_json::Value {
    match p {
        Pref::SignedIn => serde_json::Value::Null,
        Pref::Session0 => serde_json::json!("session0"),
        Pref::Kinds(k) if k.len() == 1 => serde_json::json!(k[0]),
        Pref::Kinds(k) => serde_json::json!(k),
    }
}

/// An agent's preference over the engine user's signed-in sessions, kept in
/// its own scope as `session` (absent: `signed-in`).
#[derive(Debug, Clone, PartialEq, Eq)]
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
pub struct HostSession {
    pub id: u32,
    /// `console` or `remote`
    pub kind: String,
    /// connected, as opposed to disconnected (signed in, nothing shown)
    pub active: bool,
}

/// The sign-in helper that started a CLI: the user's session the CLI runs in,
/// and the helper's pid and process creation stamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Host {
    pub session: u32,
    pub helper: (u32, u64),
}

/// A stored or requested preference: `signed-in` (or nothing), `session0`, a
/// kind (`console`, `remote`), or an ordered list of kinds, which may name
/// `signed-in` for any; a comma-separated string is a list too.
#[logged]
pub fn parse_pref(v: &serde_json::Value) -> std::result::Result<Pref, String> {
    use serde_json::Value;
    const KINDS: &[&str] = &["console", "remote", "signed-in"];
    let refuse = || "session must be signed-in, session0, console, remote, or an ordered list of console, remote and signed-in".to_string();
    let list: Vec<String> = match v {
        Value::Null => return Ok(Pref::SignedIn),
        Value::String(s) if s == "signed-in" => return Ok(Pref::SignedIn),
        Value::String(s) if s == "session0" => return Ok(Pref::Session0),
        Value::String(s) => s.split(',').map(|k| k.trim().to_string()).collect(),
        Value::Array(a) => a.iter().map(|k| k.as_str().map(str::to_string).ok_or_else(refuse)).collect::<std::result::Result<_, _>>()?,
        _ => return Err(refuse()),
    };
    if list.is_empty() || list.iter().any(|k| !KINDS.contains(&k.as_str())) {
        return Err(refuse());
    }
    Ok(Pref::Kinds(list))
}

/// Where a CLI that starts now runs among `sessions`: a session id, or None
/// for Session 0. An on-demand pick wins while its session hosts (0 is
/// Session 0); then the preference, an active session before a disconnected
/// one, the lowest id first; then Session 0.
#[logged]
pub fn choose(sessions: &[HostSession], pref: &Pref, use_id: Option<u32>) -> Option<u32> {
    if let Some(id) = use_id {
        if id == 0 {
            return None;
        }
        if sessions.iter().any(|s| s.id == id) {
            return Some(id);
        }
    }
    let best = |kind: Option<&str>| {
        let mut fit: Vec<&HostSession> = sessions.iter().filter(|s| kind.is_none_or(|k| s.kind == k)).collect();
        fit.sort_by_key(|s| (!s.active, s.id));
        fit.first().map(|s| s.id)
    };
    match pref {
        Pref::Session0 => None,
        Pref::SignedIn => best(None),
        Pref::Kinds(kinds) => kinds.iter().find_map(|k| best((k != "signed-in").then_some(k.as_str()))),
    }
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
    host: Option<u32>,
    cleared: bool,
    agent: i64,
    what: &str,
    mut build: impl FnMut(bool) -> Result<Command>,
) -> Result<(Started, bool)> {
    if let Some(session) = host {
        let cmd = build(true)?;
        match request(&cmd, cleared) {
            Ok(r) => match start_hosted(engine, session, &r.exe, &r.args, &r.cwd, &r.env).await {
                Ok((io, h)) => {
                    let job = h.job();
                    let pid = h.pid;
                    tracing::info!(agent, pid, session, cli = what, "CLI started by the sign-in helper in the user's session");
                    return Ok((Started { io, launched: Launched { kind: Kind::Hosted(h) }, job, pid }, true));
                }
                Err(code) => {
                    if engine.credential_bridge.placement_pending(session) {
                        // Keep the signed-in choice during the bounded loss
                        // debounce. The actor requeues this unsent turn; never
                        // silently launch it in Session 0 on a transient miss.
                        tracing::info!(agent,session,"host lease temporarily missing; deferring CLI start during placement debounce");
                        anyhow::bail!("signed-in helper is temporarily unavailable during placement debounce");
                    }
                    tracing::warn!(agent, cli = what, reason = %code,
                        "the sign-in helper could not start the CLI; starting it in Session 0");
                },
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

    /// The user's session the helper started it in.
    pub fn session(&self) -> Option<u32> {
        match &self.kind {
            Kind::Hosted(h) => Some(h.session),
            Kind::Local(_) => None,
        }
    }

    /// The sign-in helper that started it.
    pub fn host(&self) -> Option<Host> {
        match &self.kind {
            Kind::Hosted(h) => Some(h.host()),
            Kind::Local(_) => None,
        }
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
        /// the user's session it runs in, whose helper started it
        pub session: u32,
        /// that helper: its pid and process creation stamp
        helper: (u32, u64),
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
        session: u32,
        exe: &str,
        args: &[String],
        cwd: &str,
        env: &[(String, String)],
    ) -> std::result::Result<(Io, Hosted), String> {
        let bridge = &engine.credential_bridge;
        let helper = bridge.helpers().into_iter().find(|(s, _)| *s == session).map(|(_, h)| h).ok_or("host-gone")?;
        let names = crate::hosted_pipes::names(&uuid::Uuid::new_v4().simple().to_string());
        let stdin = serve(&names[0], false)?;
        let stdout = serve(&names[1], true)?;
        let stderr = serve(&names[2], true)?;
        let env: serde_json::Map<String, Value> = env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
        let request = json!({ "kind": "spawn", "exe": exe, "args": args, "cwd": cwd, "env": env,
                              "pipes": { "stdin": names[0], "stdout": names[1], "stderr": names[2] } });
        let reply = bridge.host_in(session, request).await?;
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
        let hosted = Hosted { pid, session, helper, created, process: process as usize, engine: engine.clone() };
        let connected = async {
            if hosted.process == 0 {
                return Err("host-process".to_string());
            }
            for p in [&stdin, &stdout, &stderr] {
                accept(p, helper.0).await?;
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
        /// The helper that started it.
        pub fn host(&self) -> Host {
            Host { session: self.session, helper: self.helper }
        }

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
                .host_in(self.session, json!({ "kind": "kill", "pid": self.pid, "created": self.created }))
                .await;
            if asked.is_err() && self.process != 0 {
                unsafe { TerminateProcess(self.process as HANDLE, 1) };
            }
        }

        /// `kill` without waiting for the helper's answer.
        pub fn start_kill(&self) {
            let (engine, pid, created, process, session) = (self.engine.clone(), self.pid, self.created, self.process, self.session);
            // a duplicate keeps the handle valid after this Hosted is dropped
            let own = if process == 0 { 0 } else { duplicate(process) };
            tokio::spawn(async move {
                let asked = engine.credential_bridge.host_in(session, json!({ "kind": "kill", "pid": pid, "created": created })).await;
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
        pub session: u32,
        pub helper: (u32, u64),
    }
    #[nolog]
    pub async fn start_hosted(_: &Arc<Engine>, _: u32, _: &str, _: &[String], _: &str, _: &[(String, String)]) -> std::result::Result<(Io, Hosted), String> {
        Err("host-unsupported".into())
    }
    #[nolog]
    impl Hosted {
        pub fn host(&self) -> Host {
            Host { session: self.session, helper: self.helper }
        }
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
