//! In-memory, local-only bridge to the signed-in desktop. Secret paths never trace.
use crate::engine::Engine;
use arc_swap::ArcSwapOption;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub mod askpass;

const NO_DESKTOP: &str = "Orgtree credential bridge: nothing in a signed-in Windows session is serving credentials: ask the user to sign in to Windows, or to open the Orgtree app if they are signed in [no-desktop].";
pub const UNAVAILABLE: &str = "Open Orgtree in your signed-in Windows session to restore git/GitHub access. Agents keep running; no engine restart is needed.";
const MAX: usize = 65536;
const PIPE_WAIT: Duration = Duration::from_secs(1);
const SLOT_WAIT: Duration = Duration::from_secs(2);
#[derive(Clone, PartialEq)]
enum ExchangeError {
    Busy,
    Unavailable,
    /// Fixed, secret-free code from the desktop (for example `gh-exit-1`).
    Lookup(String),
}
/// Why a bridge request failed. Every variant is safe to show and log.
enum Fail {
    Denied,
    Busy,
    Unavailable,
    Lookup(String),
    /// Another live broker holds the lease (registration only).
    Held,
    /// A sign-in helper with other administrator rights than the engine's
    /// (host registration only; decision 94, invariant 7).
    Rights,
}
impl From<()> for Fail {
    #[nolog]
    fn from(_: ()) -> Self {
        Fail::Denied
    }
}
/// Last real desktop lookup, for the app. Never holds credential data.
pub struct LookupStatus {
    pub ok: bool,
    pub kind: &'static str,
    pub reason: Option<String>,
    pub at_ms: i64,
}
const REGISTER: &str = "/api/desktop/credential-bridge";
const REQUEST: &str = "/api/agent-credential";

struct Broker {
    pipe: String,
    secret: String,
    pid: u32,
    /// The broker process's creation time, so a reused PID is not the holder.
    created: u64,
    expires: Instant,
}
#[nolog]
fn live(b: &Broker) -> bool {
    b.expires > Instant::now() && b.created != 0 && process_stamp(b.pid) == Some(b.created)
}
#[nolog]
fn same_holder(b: &Broker, pipe: &str, secret: &str, pid: u32) -> bool {
    b.pipe == pipe && b.pid == pid && equal(&b.secret, secret)
}
/// The sign-in helpers holding the host role, by the Windows session each
/// runs in: the engine user's sessions are hosted side by side, one helper
/// each (the user, 2026-10-16 12:12Z and 12:13Z). A live lease keeps its
/// session; another helper there retries on its next poll, so no flapping.
#[derive(Default)]
struct HostLeases(std::sync::Mutex<Vec<(u32, Arc<Broker>)>>);
#[nolog]
impl HostLeases {
    /// Whether another live helper holds `session`.
    fn held(&self, session: u32, pipe: &str, secret: &str, pid: u32) -> bool {
        let v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        v.iter().any(|(s, c)| *s == session && !same_holder(c, pipe, secret, pid) && live(c))
    }
    /// Admit `b`, which runs in `session`, unless another live helper holds
    /// that session; its own renewal replaces its lease. True when newly
    /// admitted rather than renewed.
    fn admit(&self, session: u32, b: Arc<Broker>) -> Result<bool, Fail> {
        let mut v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if v.iter().any(|(s, c)| *s == session && !same_holder(c, &b.pipe, &b.secret, b.pid) && live(c)) {
            return Err(Fail::Held);
        }
        let renewed = v.iter().any(|(s, c)| *s == session && same_holder(c, &b.pipe, &b.secret, b.pid) && live(c));
        v.retain(|(s, c)| live(c) && *s != session && !same_holder(c, &b.pipe, &b.secret, b.pid));
        v.push((session, b));
        Ok(!renewed)
    }
    /// The live lease of `session`.
    fn get(&self, session: u32) -> Option<Arc<Broker>> {
        let v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        v.iter().find(|(s, c)| *s == session && live(c)).map(|(_, c)| c.clone())
    }
    /// Its holder, proven by pipe, secret and pid, gives a lease back.
    fn release(&self, pipe: &str, secret: &str, pid: u32) -> bool {
        let mut v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let before = v.len();
        v.retain(|(_, c)| !same_holder(c, pipe, secret, pid));
        v.len() != before
    }
    /// The live leases: (session, helper pid), by session.
    fn hosting(&self) -> Vec<(u32, u32)> {
        let v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<(u32, u32)> = v.iter().filter(|(_, c)| live(c)).map(|(s, c)| (*s, c.pid)).collect();
        out.sort();
        out
    }
    /// The live leases with their holders: (session, (helper pid, process
    /// creation stamp)), by session.
    fn helpers(&self) -> Vec<(u32, (u32, u64))> {
        let v = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<(u32, (u32, u64))> = v.iter().filter(|(_, c)| live(c)).map(|(s, c)| (*s, (c.pid, c.created))).collect();
        out.sort();
        out
    }
}
/// A credential a signed-in broker served (the user's Q3, 2026-10-22 07:38Z:
/// "MEMORY CACHE of the credentials already served while signed in, for
/// Session 0 turns after sign-out"). In this engine's memory only: no Debug,
/// no Serialize, never written or logged, zeroed when dropped, and gone with
/// the engine. Kept exactly as served: kind, host, path and username.
struct Served(Vec<u8>);
impl Drop for Served {
    #[nolog]
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
type ServedKey = (&'static str, String, String, String);
#[derive(Default)]
pub(crate) struct ServedCache(std::sync::Mutex<std::collections::HashMap<ServedKey, Served>>);
#[nolog]
impl ServedCache {
    /// Keep what a live broker just served.
    pub(crate) fn keep(&self, kind: &'static str, host: &str, path: &str, username: &str, answer: &[u8]) {
        let key = (kind, host.to_string(), path.to_string(), username.to_string());
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(key, Served(answer.to_vec()));
    }
    /// What was served for exactly this request, if anything.
    pub(crate) fn served(&self, kind: &'static str, host: &str, path: &str, username: &str) -> Option<Vec<u8>> {
        let key = (kind, host.to_string(), path.to_string(), username.to_string());
        self.0.lock().unwrap_or_else(|p| p.into_inner()).get(&key).map(|s| s.0.clone())
    }
    /// A live broker no longer serves this request: drop what it served.
    pub(crate) fn forget(&self, kind: &'static str, host: &str, path: &str, username: &str) {
        let key = (kind, host.to_string(), path.to_string(), username.to_string());
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
    }
    pub(crate) fn len(&self) -> usize {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

struct Grant {
    secret: String,
    org: i64,
    generation: i32,
    pid: AtomicU32,
    created: AtomicU64,
}
pub struct Bridge {
    broker: ArcSwapOption<Broker>,
    /// Independent leases, one per Windows session of the engine's user: the
    /// desktop can serve credentials while helpers host agents' CLIs.
    hosts: HostLeases,
    /// Watcher's debounced placement only. Never authorizes a credential or
    /// host operation: those still require a live authenticated lease.
    placement_hosts: ArcSwapOption<Vec<(u32, u32)>>,
    grants: papaya::HashMap<i64, Arc<Grant>>,
    slots: tokio::sync::Semaphore,
    reported_ready: AtomicBool,
    last_lookup: ArcSwapOption<LookupStatus>,
    /// Credentials served while signed in, for Session 0 turns after sign-out.
    pub(crate) served: ServedCache,
    /// A request was last answered from `served` (logged once per stretch).
    answered_from_memory: AtomicBool,
    /// The session watch's last reading: 0 not read, 1 signed out, 2 signed in.
    signed_in: AtomicU8,
    /// When the session watch last saw a helper host (Unix ms; 0: not since
    /// the engine started), for `session_host::turn_waits_for_helper`.
    last_hosting_ms: AtomicI64,
    /// A turn started in Session 0 after waiting the grace out (logged once
    /// per stretch without a helper).
    fallback_logged: AtomicBool,
    /// A sign-in helper refused for other administrator rights: its pid and
    /// process stamp, until it has left (invariant 7).
    rights_refused: std::sync::Mutex<Option<(u32, u64)>>,
    /// The administrator rights the last admitted helper and the last refused
    /// one said they hold, for the restart notice: 0 none, 1 not elevated, 2
    /// elevated.
    admitted_rights: AtomicU8,
    refused_reading: AtomicU8,
}
#[nolog]
impl Bridge {
    pub fn new() -> Self {
        Self {
            broker: ArcSwapOption::empty(),
            hosts: HostLeases::default(),
            placement_hosts: ArcSwapOption::empty(),
            grants: papaya::HashMap::new(),
            slots: tokio::sync::Semaphore::new(16),
            reported_ready: AtomicBool::new(false),
            last_lookup: ArcSwapOption::empty(),
            served: ServedCache::default(),
            answered_from_memory: AtomicBool::new(false),
            signed_in: AtomicU8::new(0),
            last_hosting_ms: AtomicI64::new(0),
            fallback_logged: AtomicBool::new(false),
            rights_refused: std::sync::Mutex::new(None),
            admitted_rights: AtomicU8::new(0),
            refused_reading: AtomicU8::new(0),
        }
    }
    /// The session watch's reading at each check: whether the engine's user
    /// is signed in (None: unread) and whether a sign-in helper hosts.
    pub(crate) fn note_reading(&self, signed_in: Option<bool>, hosting: bool) {
        self.signed_in.store(match signed_in { None => 0, Some(false) => 1, Some(true) => 2 }, Ordering::Relaxed);
        if hosting {
            self.last_hosting_ms.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
            self.fallback_logged.store(false, Ordering::Relaxed);
        }
    }
    /// Whether the engine's user is signed in, by the session watch's last
    /// reading (None: not read yet, or not on Windows).
    pub(crate) fn user_signed_in(&self) -> Option<bool> {
        match self.signed_in.load(Ordering::Relaxed) {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }
    /// When the session watch last saw a helper host (Unix ms; 0: never).
    pub(crate) fn last_hosting_ms(&self) -> i64 {
        self.last_hosting_ms.load(Ordering::Relaxed)
    }
    /// True once per stretch without a helper: a turn start that waited the
    /// grace out logs it.
    pub(crate) fn first_fallback(&self) -> bool {
        !self.fallback_logged.swap(true, Ordering::Relaxed)
    }
    /// The rights a hosting sign-in helper said it holds (None: no helper
    /// hosts), for the restart notice.
    pub(crate) fn hosting_rights(&self) -> Option<bool> {
        if self.placement_hosting().is_empty() {
            return None;
        }
        rights_of(self.admitted_rights.load(Ordering::Relaxed))
    }
    /// The rights the last helper refused for them said it holds (None:
    /// none was refused).
    pub(crate) fn refused_rights(&self) -> Option<bool> {
        rights_of(self.refused_reading.load(Ordering::Relaxed))
    }
    /// A sign-in helper was refused for its administrator rights.
    fn refused_for_rights(&self, pid: u32, elevated: bool) {
        self.refused_reading.store(if elevated { 2 } else { 1 }, Ordering::Relaxed);
        let mut refused = self.rights_refused.lock().unwrap_or_else(|p| p.into_inner());
        if refused.map(|(p, _)| p) != Some(pid) {
            tracing::warn!(pid, engine_elevated = crate::host::elevated(),
                "Sign-in helper refused: it runs with other administrator rights than the engine; it leaves, and its task starts one with the engine's");
        }
        *refused = Some((pid, process_stamp(pid).unwrap_or(0)));
    }
    /// Whether a helper refused for its rights has left since: then the
    /// session watch starts the helper's task at once. True once per refusal.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn rights_refusal_ended(&self) -> bool {
        let mut refused = self.rights_refused.lock().unwrap_or_else(|p| p.into_inner());
        match *refused {
            Some((pid, stamp)) if stamp == 0 || process_stamp(pid) != Some(stamp) => {
                *refused = None;
                true
            }
            _ => false,
        }
    }
    /// `untested` until a real git/gh lookup has gone through the desktop;
    /// a successful ping or registration is not a lookup.
    pub fn lookup_view(&self) -> Value {
        match self.last_lookup.load_full() {
            None => json!({"status": "untested"}),
            Some(l) => json!({
                "status": if l.ok { "succeeded" } else { "failed" },
                "kind": l.kind,
                "reason": l.reason,
                "message": l.reason.as_deref().map(describe),
                "at_ms": l.at_ms,
            }),
        }
    }
    /// A request was answered from the credentials served while signed in:
    /// logged once per stretch, never the credential.
    fn answered_from_memory(&self, kind: &'static str, host: &str) {
        if !self.answered_from_memory.swap(true, Ordering::Relaxed) {
            tracing::info!(kind, host, "Credential bridge answered from the credentials a signed-in broker served earlier: no signed-in broker now");
        }
    }
    fn record(&self, kind: &'static str, host: &str, reason: Option<&str>) {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let previous = self.last_lookup.swap(Some(Arc::new(LookupStatus {
            ok: reason.is_none(),
            kind,
            reason: reason.map(str::to_string),
            at_ms,
        })));
        match reason {
            Some(reason) => tracing::warn!(
                kind,
                host,
                reason,
                "Credential bridge lookup failed: {}",
                describe(reason)
            ),
            // Log the first success and every recovery, not every lookup.
            None if previous.map(|p| !p.ok).unwrap_or(true) => {
                tracing::info!(kind, host, "Credential bridge lookup succeeded")
            }
            None => {}
        }
    }
    pub fn ready(&self) -> bool {
        self.broker
            .load()
            .as_ref()
            .map(|b| b.expires > Instant::now())
            .unwrap_or(false)
    }
    /// Whether a live sign-in helper can start CLIs in a session of the user.
    pub fn can_host(&self) -> bool {
        !self.hosts.hosting().is_empty()
    }
    /// The live helpers: (Windows session, helper pid), by session.
    pub fn hosting(&self) -> Vec<(u32, u32)> {
        self.hosts.hosting()
    }
    pub(crate) fn set_placement_hosts(&self, hosts: Vec<(u32, u32)>) {
        self.placement_hosts.store(Some(Arc::new(hosts)));
    }
    pub(crate) fn placement_hosting(&self) -> Vec<(u32, u32)> {
        self.placement_hosts.load_full().map(|h| (*h).clone()).unwrap_or_else(|| self.hosting())
    }
    pub(crate) fn placement_pending(&self, session: u32) -> bool {
        self.placement_hosting().iter().any(|(id,_)| *id==session) && !self.hosting().iter().any(|(id,_)| *id==session)
    }
    /// The live helpers with their process creation stamps: (Windows
    /// session, (helper pid, stamp)), by session. The stamp tells a helper
    /// from a later process with the same pid.
    pub fn helpers(&self) -> Vec<(u32, (u32, u64))> {
        self.hosts.helpers()
    }
    /// The pid of the helper hosting `session`, which connects the pipes of
    /// a CLI it starts.
    pub fn host_pid_in(&self, session: u32) -> Option<u32> {
        self.hosts.get(session).map(|b| b.pid)
    }
    /// A spawn or kill request to the sign-in helper of `session`. A spawn
    /// carries the child's environment (its API key), so nothing here is
    /// logged; the answer is the helper's reply or a fixed, secret-free code.
    pub async fn host_in(&self, session: u32, mut request: Value) -> Result<Vec<u8>, String> {
        let broker = self.hosts.get(session).ok_or_else(|| "host-gone".to_string())?;
        request["diagnostics"] = json!(1);
        match exchange(&broker, request).await {
            Ok(reply) => Ok(reply),
            Err(ExchangeError::Lookup(code)) => Err(code),
            Err(ExchangeError::Busy) => Err("host-busy".into()),
            Err(ExchangeError::Unavailable) => Err("host-gone".into()),
        }
    }
    pub fn revoke(&self, agent: i64) {
        self.grants.pin().remove(&agent);
    }
    pub fn bind(&self, agent: i64, pid: u32) {
        if let Some(g) = self.grants.pin().get(&agent) {
            g.created
                .store(process_stamp(pid).unwrap_or(0), Ordering::SeqCst);
            g.pid.store(pid, Ordering::SeqCst);
        }
    }
    pub fn environment(
        &self,
        engine: &Engine,
        agent: i64,
        org: i64,
        generation: i32,
    ) -> Vec<(String, String)> {
        if !needs_adapter(
            cfg!(windows),
            engine.credentials.state.load().warning.is_some(),
        ) {
            return vec![];
        }
        let Ok(exe) = std::env::current_exe() else {
            return vec![];
        };
        // Per-boot static adapters contain no secrets. Startup reclaims stale
        // boot folders; locked binaries are retained until a later startup.
        let dir = engine.cfg.path("credential-adapters").join(&engine.boot.id);
        if std::fs::create_dir_all(&dir).is_err() {
            return vec![];
        }
        for name in ["gh.exe", "orgtree-git-askpass.exe"] {
        let shim = dir.join(name);
        if !shim.exists() && std::fs::hard_link(&exe, &shim).is_err() && !shim.exists() {
            // Cross-volume installs: publish only a complete copy. Concurrent
            // agents may race the rename, but never observe a partial binary.
            let tmp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            if std::fs::copy(&exe, &tmp).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return vec![];
            }
            let result = std::fs::rename(&tmp, &shim);
            let _ = std::fs::remove_file(&tmp);
            if result.is_err() && !shim.exists() {
                return vec![];
            }
        }
        }
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.grants.pin().insert(
            agent,
            Arc::new(Grant {
                secret: secret.clone(),
                org,
                generation,
                pid: AtomicU32::new(0),
                created: AtomicU64::new(0),
            }),
        );
        adapter_environment(&exe, dir, agent, engine.boot.port, secret)
    }
}

#[nolog]
fn adapter_environment(
    _exe: &std::path::Path,
    dir: std::path::PathBuf,
    agent: i64,
    port: u16,
    secret: String,
) -> Vec<(String, String)> {
    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let real_gh = std::env::split_paths(&old_path)
        .map(|p| p.join("gh.exe"))
        .find(|p| p.is_file() && !adapter_path(p));
    let path = std::env::join_paths(std::iter::once(dir.clone()).chain(std::env::split_paths(&old_path)))
        .unwrap_or(old_path);
    let n = git_config_slot(std::env::var("GIT_CONFIG_COUNT").ok().as_deref());
    let mut env = vec![
        ("ORGTREE_CREDENTIAL_AUTH".into(), secret),
        (
            "ORGTREE_CREDENTIAL_URL".into(),
            format!("http://127.0.0.1:{}{REQUEST}", port),
        ),
        ("ORGTREE_CREDENTIAL_AGENT".into(), agent.to_string()),
    ];
    // Never replace malformed/oversized inherited configuration with slot zero.
    // Git retains its native behavior; gh bridging remains independently usable.
    if let Some(n) = n {
        env.extend([
            ("GIT_CONFIG_COUNT".into(), (n + 1).to_string()),
            (format!("GIT_CONFIG_KEY_{n}"), "credential.sanitizePrompt".into()),
            (
                format!("GIT_CONFIG_VALUE_{n}"),
                "true".into(),
            ),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GIT_ASKPASS".into(), dir.join("orgtree-git-askpass.exe").to_string_lossy().into_owned()),
        ]);
    }
    if let Ok(original) = std::env::var("GIT_ASKPASS") {
        env.push(("ORGTREE_ORIGINAL_GIT_ASKPASS".into(), original));
    }
    if let Some(real) = real_gh {
        env.push(("PATH".into(), path.to_string_lossy().into_owned()));
        env.push((
            "ORGTREE_REAL_GH".into(),
            real.to_string_lossy().into_owned(),
        ));
    }
    env
}

/// All registration, failed-ping and lease-expiry availability notifications
/// pass here. Payload is a boolean; never publish broker or grant contents.
#[nolog]
pub fn publish_availability(engine: &Engine) {
    let ready = engine.credential_bridge.ready();
    if engine
        .credential_bridge
        .reported_ready
        .swap(ready, Ordering::SeqCst)
        == ready
    {
        return;
    }
    crate::runtime::watchdogs::events::condition(engine,
        if ready {"credentials.bridge.available"} else {"credentials.bridge.unavailable"},
        if ready {"credentials.bridge.unavailable"} else {"credentials.bridge.available"},
        serde_json::json!({"reason":if ready {"signed-in broker registered"} else {"broker disconnected or lease expired"}}));
    if ready {
        tracing::info!("Signed-in desktop git/GitHub credential bridge ready; general Windows vault remains isolated");
    } else {
        tracing::warn!("{UNAVAILABLE}");
    }
}

/// Preserve Git's nonsecret config KEY names on Codex versions that apply
/// the *KEY* shell filter. The opaque capability uses AUTH (not *TOKEN*) and
/// remains environment-only; never put it in -c argv or config files.
#[nolog]
pub fn codex_overrides(env: &[(String, String)]) -> Vec<String> {
    if !env.iter().any(|(k, _)| k == "ORGTREE_CREDENTIAL_AUTH") {
        return vec![];
    }
    let mut entries: std::collections::BTreeMap<String, String> = std::env::vars()
        .filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_"))
        .collect();
    entries.extend(
        env.iter()
            .filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_"))
            .cloned(),
    );
    let mut args = Vec::new();
    for (key, value) in entries {
        if key
            .strip_prefix("GIT_CONFIG_KEY_")
            .map(|n| n.parse::<u8>().is_ok())
            .unwrap_or(false)
        {
            args.push("-c".into());
            args.push(format!(
                "shell_environment_policy.set.{}={}",
                key,
                toml::Value::String(value)
            ));
        }
    }
    args
}

#[nolog]
pub fn route(path: &str) -> bool {
    path == REGISTER || path == REQUEST
}

/// Entire route, including auth failures, bypasses generic body/header tracing.
#[nolog]
pub async fn dispatch(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let result = tokio::time::timeout(Duration::from_secs(10), handle(&engine, req))
        .await
        .unwrap_or(Err(Fail::Busy));
    match result {
        Ok(bytes) => (
            StatusCode::OK,
            [
                ("content-type", "application/octet-stream"),
                ("cache-control", "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(fail) => (
            match fail {
                Fail::Held => StatusCode::CONFLICT,
                Fail::Rights => StatusCode::PRECONDITION_FAILED,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            },
            [("cache-control", "no-store")],
            match fail {
                Fail::Denied => "Orgtree credential bridge: this process's credential capability is no longer valid; a new turn or CLI process gets a fresh one [denied].".to_string(),
                Fail::Busy => "Orgtree credential bridge: busy or timed out; retry in a moment [busy].".to_string(),
                Fail::Unavailable => NO_DESKTOP.to_string(),
                Fail::Lookup(reason) => describe(&reason),
                Fail::Held => "Orgtree credential bridge: another signed-in broker holds the bridge [held].".to_string(),
                Fail::Rights => "Orgtree credential bridge: this sign-in helper runs with other administrator rights than the engine; Orgtree starts one with the engine's [rights].".to_string(),
            },
        )
            .into_response(),
    }
}
/// A stored rights reading: 0 none, 1 not elevated, 2 elevated.
#[nolog]
fn rights_of(stored: u8) -> Option<bool> {
    match stored {
        1 => Some(false),
        2 => Some(true),
        _ => None,
    }
}

/// Whether a sign-in helper that says it runs with `helper_elevated` rights may
/// host the agents of an engine with `engine_elevated` rights.
/// A helper that does not say runs without them.
#[nolog]
pub(crate) fn same_rights(engine_elevated: bool, helper_elevated: Option<bool>) -> bool {
    helper_elevated.unwrap_or(false) == engine_elevated
}

/// A sign-in helper takes, renews or gives back the host role for the Windows
/// session it runs in (the user, 2026-10-16 12:12Z and 12:13Z: the engine
/// user's sessions side by side, one helper each). The first helper is the
/// core's helper member; a second session's helper hosts beside it.
#[nolog]
async fn register_host(engine: &Engine, value: &Value, pipe: &str, secret: &str, pid: u32) -> Result<Vec<u8>, Fail> {
    let hosts = &engine.credential_bridge.hosts;
    if value["release"].as_bool() == Some(true) {
        if hosts.release(pipe, secret, pid) {
            tracing::info!(pid, "Sign-in helper released its host role");
        }
        return Ok(b"released".to_vec());
    }
    // Both elevated or neither (decision 94, invariant 7): a helper with other
    // rights leaves, and its task starts one at the engine's.
    let elevated = value["elevated"].as_bool();
    if !same_rights(crate::host::elevated(), elevated) {
        engine.credential_bridge.refused_for_rights(pid, elevated.unwrap_or(false));
        return Err(Fail::Rights);
    }
    let session = helper_session(value, pid).ok_or(Fail::Denied)?;
    if hosts.held(session, pipe, secret, pid) {
        return Err(Fail::Held);
    }
    let mut broker = Broker {
        pipe: pipe.into(),
        secret: secret.into(),
        pid,
        created: 0,
        expires: Instant::now() + Duration::from_secs(20),
    };
    if exchange(&broker, json!({"kind":"ping"})).await.map_err(|_| Fail::Unavailable)? != b"ready" {
        return Err(Fail::Denied);
    }
    // The ping proved `pid` serves the pipe as the interactive operator.
    broker.created = process_stamp(pid).unwrap_or(0);
    let first = hosts.hosting().iter().all(|(_, p)| *p == pid);
    if first && !engine.core.member(false, pid).await {
        return Err(Fail::Denied);
    }
    if hosts.admit(session, Arc::new(broker))? {
        tracing::info!(pid, session, "Sign-in helper took the Codex host slot");
    }
    engine.credential_bridge.admitted_rights.store(if elevated.unwrap_or(false) { 2 } else { 1 }, Ordering::Relaxed);
    Ok(b"ready".to_vec())
}
/// The Windows session a helper runs in. A debug rig engine lets a proof's
/// helper name a synthetic one (`rig_session`), so two helpers in one real
/// session stand for two sessions.
#[nolog]
fn helper_session(value: &Value, pid: u32) -> Option<u32> {
    #[cfg(debug_assertions)]
    if crate::rig::active() {
        if let Some(s) = value["rig_session"].as_u64().and_then(|s| u32::try_from(s).ok()).filter(|s| *s != 0) {
            return Some(s);
        }
    }
    let _ = value;
    process_session(pid)
}
#[cfg(windows)]
#[nolog]
fn process_session(pid: u32) -> Option<u32> {
    let mut session = 0;
    (unsafe { windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(pid, &mut session) } != 0 && session != 0)
        .then_some(session)
}
#[cfg(not(windows))]
#[nolog]
fn process_session(_pid: u32) -> Option<u32> {
    None
}
#[nolog]
async fn handle(engine: &Engine, req: Request) -> Result<Vec<u8>, Fail> {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .ok_or(())?;
    if !peer.0.ip().is_loopback() || req.method() != axum::http::Method::POST {
        return Err(Fail::Denied);
    }
    let register = req.uri().path() == REGISTER;
    let token = req
        .headers()
        .get(if register {
            crate::http::TOKEN_HEADER
        } else {
            "x-orgtree-credential-token"
        })
        .and_then(|v| v.to_str().ok())
        .ok_or(())?
        .to_string();
    if register
        && (engine.cfg.desktop_token.is_empty() || !equal(&token, &engine.cfg.desktop_token))
    {
        return Err(Fail::Denied);
    }
    let header_agent = req
        .headers()
        .get("x-orgtree-credential-agent")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    if !register {
        let agent = header_agent.ok_or(())?;
        let grants = engine.credential_bridge.grants.pin();
        if !grants
            .get(&agent)
            .map(|g| equal(&token, &g.secret))
            .unwrap_or(false)
        {
            return Err(Fail::Denied);
        }
    }
    let _slot = tokio::time::timeout(SLOT_WAIT, engine.credential_bridge.slots.acquire())
        .await
        .map_err(|_| Fail::Busy)?
        .map_err(|_| Fail::Busy)?;
    let bytes = axum::body::to_bytes(req.into_body(), MAX)
        .await
        .map_err(|_| ())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if register {
        let pipe = value["pipe"].as_str().ok_or(())?;
        let secret = value["secret"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or(())?;
        if !pipe
            .strip_prefix(r"\\.\pipe\orgtree-credentials-")
            .map(|s| {
                !s.is_empty()
                    && s.len() < 100
                    && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            .unwrap_or(false)
        {
            return Err(Fail::Denied);
        }
        let pid = u32::try_from(value["pid"].as_u64().ok_or(())?).map_err(|_| ())?;
        if let Some(action) = value.get("core").and_then(Value::as_str) {
            // Core membership is independent of credential ownership. Even when
            // the helper holds that lease, prove the desktop's pipe/SID/session.
            if !matches!(action, "desktop" | "transition" | "install" | "complete") { return Err(Fail::Denied); }
            let probe = Broker { pipe: pipe.into(), secret: secret.into(), pid, created: 0,
                expires: Instant::now() + Duration::from_secs(20) };
            if exchange(&probe, json!({"kind":"ping"})).await.map_err(|_| Fail::Unavailable)? != b"ready" {
                return Err(Fail::Denied);
            }
            let accepted = if action == "desktop" { engine.core.member(true, pid).await }
                else { engine.core.transition(pid, action == "complete", action == "install").await };
            let stopping = engine.is_stopping() || engine.core.state.load().as_ref()
                .is_some_and(|s| crate::core_state::stopped(&engine.cfg.data_root, s));
            if !accepted && !stopping { return Err(Fail::Denied); }
            return Ok(json!({"stopped":stopping}).to_string().into_bytes());
        }
        let host_only = match value.get("role").and_then(Value::as_str) {
            None if value.get("role").is_none() => false,
            Some("credentials") => false,
            Some("host") if value["caps"].as_array().is_some_and(|c| c.iter().any(|v| v == "spawn")) => true,
            _ => return Err(Fail::Denied),
        };
        if host_only {
            return register_host(engine, &value, pipe, secret, pid).await;
        }
        let slot = &engine.credential_bridge.broker;
        let current = slot.load_full();
        // Each role has its own lease. Only its holder, proven by its
        // pipe and secret, may release that role; the other stays unchanged.
        if value["release"].as_bool() == Some(true) {
            if let Some(c) = current
                .as_ref()
                .filter(|c| c.pipe == pipe && c.pid == pid && equal(&c.secret, secret))
            {
                let previous = slot.compare_and_swap(&current, None);
                if previous.as_ref().map(|p| Arc::ptr_eq(p, c)).unwrap_or(false) {
                    tracing::info!(pid, "Signed-in broker released its role");
                    publish_availability(engine);
                }
            }
            return Ok(b"released".to_vec());
        }
        // A live lease whose broker process still runs keeps the slot; the
        // other broker retries on its next poll. No flapping between the two.
        if current.as_ref().is_some_and(|c| {
            !same_holder(c, pipe, secret, pid) && live(c)
        }) {
            return Err(Fail::Held);
        }
        let mut broker = Broker {
            pipe: pipe.into(),
            secret: secret.into(),
            pid,
            created: 0,
            expires: Instant::now() + Duration::from_secs(20),
        };
        if exchange(&broker, json!({"kind":"ping"}))
            .await
            .map_err(|_| Fail::Unavailable)?
            != b"ready"
        {
            return Err(Fail::Denied);
        }
        // The ping proved `pid` serves the pipe as the interactive operator.
        broker.created = process_stamp(pid).unwrap_or(0);
        let fresh = Arc::new(broker);
        let previous = slot.compare_and_swap(&current, Some(fresh.clone()));
        let swapped = match (&*previous, &current) {
            (Some(p), Some(c)) => Arc::ptr_eq(p, c),
            (None, None) => true,
            _ => false,
        };
        if !swapped {
            return Err(Fail::Held);
        }
        if current.as_ref().map(|c| c.pipe != fresh.pipe).unwrap_or(true) {
            tracing::info!(pid, "Credential broker took the bridge");
        }
        publish_availability(engine);
        return Ok(b"ready".to_vec());
    }
    let agent = value["agent"].as_i64().ok_or(())?;
    if header_agent != Some(agent) {
        return Err(Fail::Denied);
    }
    let grant = engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .cloned()
        .ok_or(())?;
    if !equal(&token, &grant.secret) {
        return Err(Fail::Denied);
    }
    let pid = grant.pid.load(Ordering::SeqCst);
    let stamp = grant.created.load(Ordering::SeqCst);
    if stamp == 0 || process_stamp(pid) != Some(stamp) {
        return Err(Fail::Denied);
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    let exists=db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_some();
    drop(db);
    if !exists {
        return Err(Fail::Denied);
    }
    let kind: &'static str = match value["kind"].as_str() {
        Some("git") => "git",
        Some("gh") => "gh",
        _ => return Err(Fail::Denied),
    };
    let host = value["host"].as_str().filter(|h| valid_host(h)).ok_or(())?;
    let path = value["path"].as_str().unwrap_or("");
    let username = value["username"].as_str().unwrap_or("");
    if !safe_field(path) || !safe_field(username) {
        return Err(Fail::Denied);
    }
    // With no signed-in broker, what one served while the user was signed in,
    // exactly as served (the user's Q3, 2026-10-22); nothing kept: the clear
    // [no-desktop] refusal.
    let bridge = &engine.credential_bridge;
    let Some(broker) = bridge.broker.load_full().filter(|b| b.expires > Instant::now()) else {
        let answer = bridge.served.served(kind, host, path, username).ok_or(Fail::Unavailable)?;
        bridge.answered_from_memory(kind, host);
        return revalidated(engine, agent, &grant, pid, stamp, answer).await;
    };
    let answer = match exchange(
        &broker,
        json!({"kind":kind,"host":host,"path":path,"username":username,"diagnostics":1}),
    )
    .await
    {
        Ok(answer) => {
            bridge.record(kind, host, None);
            bridge.served.keep(kind, host, path, username, &answer);
            bridge.answered_from_memory.store(false, Ordering::Relaxed);
            answer
        }
        Err(ExchangeError::Busy) => return Err(Fail::Busy),
        Err(ExchangeError::Lookup(reason)) => {
            bridge.record(kind, host, Some(&reason));
            bridge.served.forget(kind, host, path, username);
            return Err(Fail::Lookup(reason));
        }
        Err(ExchangeError::Unavailable) => {
            // A missing credential is not a dead broker. Probe the channel
            // without reading a secret before withdrawing availability.
            if exchange(&broker, json!({"kind":"ping"})).await == Err(ExchangeError::Unavailable) {
                let previous = engine
                    .credential_bridge
                    .broker
                    .compare_and_swap(&Some(broker.clone()), None);
                if previous
                    .as_ref()
                    .map(|b| Arc::ptr_eq(b, &broker))
                    .unwrap_or(false)
                {
                    publish_availability(engine);
                }
                engine.credential_bridge.record(kind, host, Some("broker-gone"));
                let answer = bridge.served.served(kind, host, path, username).ok_or(Fail::Unavailable)?;
                bridge.answered_from_memory(kind, host);
                return revalidated(engine, agent, &grant, pid, stamp, answer).await;
            }
            // Older desktops close the pipe without a reason.
            engine.credential_bridge.record(kind, host, Some("broker-failed"));
            return Err(Fail::Lookup("broker-failed".into()));
        }
    };
    revalidated(engine, agent, &grant, pid, stamp, answer).await
}
/// `answer` for `agent`, once its grant, its CLI process and the agent itself
/// are re-checked after the lookup: a revoked grant or an ended process gets
/// nothing, from a broker or from memory alike.
#[nolog]
async fn revalidated(engine: &Engine, agent: i64, grant: &Arc<Grant>, pid: u32, stamp: u64, answer: Vec<u8>) -> Result<Vec<u8>, Fail> {
    if !engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .map(|g| Arc::ptr_eq(g, grant))
        .unwrap_or(false)
    {
        return Err(Fail::Denied);
    }
    if process_stamp(pid) != Some(stamp) {
        return Err(Fail::Denied);
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    if db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_none() {return Err(Fail::Denied);}
    if !engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .map(|g| Arc::ptr_eq(g, grant))
        .unwrap_or(false)
    {
        return Err(Fail::Denied);
    }
    Ok(answer)
}
#[nolog]
fn needs_adapter(windows: bool, isolated: bool) -> bool {
    windows && isolated
}
#[nolog]
fn adapter_path(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("credential-adapters")
    })
}
#[nolog]
fn find_gh() -> Option<std::path::PathBuf> {
    let cached = std::env::var_os("ORGTREE_REAL_GH")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file() && !adapter_path(p));
    cached.or_else(|| {
        std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("gh.exe"))
                .find(|p| p.is_absolute() && p.is_file() && !adapter_path(p))
        })
    })
}
#[nolog]
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
}
#[nolog]
fn safe_field(s: &str) -> bool {
    s.len() <= 4096 && !s.chars().any(|c| c.is_control())
}
#[nolog]
fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c))
        && !s.starts_with(['-', '.'])
}

/// One actionable line an agent can relay to the user. Codes are fixed
/// strings from the desktop broker and never contain tool output.
#[nolog]
fn describe(code: &str) -> String {
    let tool = code.split('-').next().unwrap_or("");
    let what = match code {
        "gh-empty" => "GitHub sign-in missing in the signed-in Windows session: ask the user to run `gh auth login` in their Windows session".to_string(),
        "git-empty" => "no saved git login for this host in the signed-in Windows session: ask the user to sign in there once (for github.com: `gh auth login`)".to_string(),
        "gh-missing" | "git-missing" => format!("{tool}.exe is not on the PATH of the signed-in Windows session: ask the user to install {tool}, then sign out of Windows and back in"),
        "gh-timeout" | "git-timeout" => format!("{tool} timed out in the signed-in Windows session: ask the user to check that `{tool}` works in their own terminal"),
        "broker-gone" | "broker-failed" => "the signed-in credential helper stopped answering: ask the user to sign out of Windows and back in, or to open the Orgtree app".to_string(),
        "invalid-request" => "the signed-in credential helper rejected this request (unsupported host or field)".to_string(),
        c => match c.split_once("-exit-") {
            Some(("gh", n)) => format!("gh failed in the signed-in Windows session (exit {n}), usually because GitHub sign-in is missing: ask the user to run `gh auth status` and `gh auth login` in their Windows session"),
            Some((tool, n)) => format!("{tool} failed in the signed-in Windows session (exit {n}), usually because no login is saved for this host: ask the user to sign in there once (for github.com: `gh auth login`)"),
            None => "the signed-in lookup failed: ask the user to open the Orgtree app".to_string(),
        },
    };
    format!("Orgtree credential bridge: {what} [{code}].")
}

#[cfg(windows)]
#[nolog]
async fn exchange(broker: &Broker, mut request: Value) -> Result<Vec<u8>, ExchangeError> {
    use std::os::windows::io::AsRawHandle;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::ClientOptions,
    };
    let started = Instant::now();
    let mut pipe = loop {
        match ClientOptions::new().open(&broker.pipe) {
            Ok(pipe) => break pipe,
            Err(error) if pipe_busy(error.raw_os_error()) => {
                if started.elapsed() >= PIPE_WAIT {
                    return Err(ExchangeError::Busy);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(_) => return Err(ExchangeError::Unavailable),
        }
    };
    let mut pid = 0;
    if unsafe {
        windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(
            pipe.as_raw_handle() as _,
            &mut pid,
        )
    } == 0
        || pid != broker.pid
        || !interactive_same_user(pid)
    {
        return Err(ExchangeError::Unavailable);
    }
    request["secret"] = Value::String(broker.secret.clone());
    let mut raw = serde_json::to_vec(&request).map_err(|_| ExchangeError::Unavailable)?;
    raw.push(b'\n');
    let written = pipe.write_all(&raw).await;
    // a spawn request carries the child's environment (its API key)
    raw.fill(0);
    written.map_err(|_| ExchangeError::Unavailable)?;
    let mut result = Vec::new();
    pipe.take((MAX + 1) as u64)
        .read_to_end(&mut result)
        .await
        .map_err(|_| ExchangeError::Unavailable)?;
    if result == b"orgtree-credential-busy\n" {
        Err(ExchangeError::Busy)
    } else if let Some(code) = result
        .strip_prefix(b"orgtree-credential-error ")
        .and_then(|c| c.strip_suffix(b"\n"))
    {
        let code = std::str::from_utf8(code).unwrap_or("");
        let valid = !code.is_empty()
            && code.len() <= 40
            && code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
        Err(ExchangeError::Lookup(
            if valid { code } else { "broker-failed" }.into(),
        ))
    } else if result.len() > MAX || result.is_empty() {
        Err(ExchangeError::Unavailable)
    } else {
        Ok(result)
    }
}
#[cfg(not(windows))]
#[nolog]
async fn exchange(_: &Broker, _: Value) -> Result<Vec<u8>, ExchangeError> {
    Err(ExchangeError::Unavailable)
}

#[cfg(windows)]
#[nolog]
fn process_stamp(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut code = 0;
        let mut c: FILETIME = std::mem::zeroed();
        let mut e = c;
        let mut k = c;
        let mut u = c;
        let ok = GetExitCodeProcess(h, &mut code) != 0
            && code == STILL_ACTIVE as u32
            && GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
        CloseHandle(h);
        ok.then_some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }
}
#[cfg(not(windows))]
#[nolog]
fn process_stamp(_: u32) -> Option<u64> {
    None
}

#[cfg(windows)]
#[nolog]
fn interactive_same_user(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::*, Security::*, System::RemoteDesktop::*, System::Threading::*,
    };
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(pid, &mut session) == 0 || session == 0 {
            return false;
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut token = std::ptr::null_mut();
        let ok = OpenProcessToken(h, TOKEN_QUERY, &mut token);
        CloseHandle(h);
        if ok == 0 {
            return false;
        }
        let mut ours = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut ours) == 0 {
            CloseHandle(token);
            return false;
        }
        let a = token_sid(token);
        let b = token_sid(ours);
        let interactive = token_interactive(token);
        CloseHandle(token);
        CloseHandle(ours);
        interactive && a.is_some() && a == b
    }
}
#[cfg(windows)]
#[nolog]
unsafe fn token_interactive(token: windows_sys::Win32::Foundation::HANDLE) -> bool {
    use windows_sys::Win32::Security::*;
    let mut len = 0;
    GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut len);
    if len == 0 || len > 65536 {
        return false;
    }
    let mut buffer = vec![0u64; (len as usize + 7) / 8];
    if GetTokenInformation(
        token,
        TokenGroups,
        buffer.as_mut_ptr().cast(),
        len,
        &mut len,
    ) == 0
    {
        return false;
    }
    const SE_GROUP_ENABLED: u32 = 0x00000004; // winnt.h
    let groups = &*(buffer.as_ptr() as *const TOKEN_GROUPS);
    let offset = groups.Groups.as_ptr() as usize - buffer.as_ptr() as usize;
    if offset + groups.GroupCount as usize * std::mem::size_of::<SID_AND_ATTRIBUTES>()
        > len as usize
    {
        return false;
    }
    let mut sid = [0u64; 9];
    let mut size = std::mem::size_of_val(&sid) as u32;
    if CreateWellKnownSid(
        WinInteractiveSid,
        std::ptr::null_mut(),
        sid.as_mut_ptr().cast(),
        &mut size,
    ) == 0
    {
        return false;
    }
    // INTERACTIVE is stamped into a genuine interactive logon token (also RDP).
    // Querying TokenGroups needs TOKEN_QUERY, not cross-logon LSA privileges.
    std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        .iter()
        .any(|g| {
            g.Attributes & SE_GROUP_ENABLED != 0 && EqualSid(g.Sid, sid.as_mut_ptr().cast()) != 0
        })
}
#[cfg(windows)]
#[nolog]
unsafe fn token_sid(token: windows_sys::Win32::Foundation::HANDLE) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::*;
    let mut len = 0;
    GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
    if len == 0 || len > 65536 {
        return None;
    }
    let mut buf = vec![0u64; (len as usize + 7) / 8];
    if GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) == 0 {
        return None;
    }
    let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
    if IsValidSid(sid) == 0 {
        return None;
    }
    let n = GetLengthSid(sid) as usize;
    Some(std::slice::from_raw_parts(sid as *const u8, n).to_vec())
}

// CLI adapters run before engine tracing initializes. Never echo credential failures.
#[nolog]
pub fn cli(kind: &str, args: &[String]) -> std::process::ExitCode {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(rt) = rt else {
        return std::process::ExitCode::FAILURE;
    };
    match rt.block_on(cli_async(kind, args)) {
        Ok(code) => std::process::ExitCode::from(code),
        Err(_) if kind == "git" => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("{UNAVAILABLE}");
            std::process::ExitCode::FAILURE
        }
    }
}
#[nolog]
async fn cli_async(kind: &str, args: &[String]) -> Result<u8, ()> {
    let real = if kind == "gh" {
        let Some(real) = find_gh() else {
            eprintln!("GitHub CLI (gh.exe) is not on this process's PATH. Install it and reopen the agent process to refresh PATH.");
            return Ok(127);
        };
        Some(real)
    } else {
        None
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut host = std::env::var("GH_HOST").unwrap_or_else(|_| "github.com".into());
    let mut path = String::new();
    let mut username = String::new();
    let mut bridge_target = true;
    if kind == "git" {
        if args.first().map(|s| s.as_str()) != Some("get") {
            return Ok(0);
        }
        let mut raw = String::new();
        tokio::io::stdin()
            .take(MAX as u64)
            .read_to_string(&mut raw)
            .await
            .map_err(|_| ())?;
        let fields: std::collections::HashMap<&str, &str> =
            raw.lines().filter_map(|l| l.split_once('=')).collect();
        if fields.get("protocol") != Some(&"https") {
            return Err(());
        }
        host = fields.get("host").ok_or(())?.to_string();
        path = fields.get("path").unwrap_or(&"").to_string();
        username = fields.get("username").unwrap_or(&"").to_string();
    } else {
        if std::env::var("GH_HOST").is_err() {
            let mut git = tokio::process::Command::new("git");
            git.args(["remote", "get-url", "origin"]);
            #[cfg(windows)]
            {
                git.creation_flags(crate::winproc::CREATE_NO_WINDOW);
            }
            git.kill_on_drop(true);
            if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(2), git.output()).await {
                if out.status.success() {
                    let remote = String::from_utf8_lossy(&out.stdout);
                    if let Ok(url) = reqwest::Url::parse(remote.trim()) {
                        if let Some(h) = url.host_str() {
                            host = h.into();
                        }
                    } else if let Some((userhost, _)) = remote.trim().split_once(':') {
                        if let Some((_, h)) = userhost.split_once('@') {
                            host = h.into();
                        }
                    }
                }
            }
        }
        match gh_bridge_host(host.clone(), args) {
            Some(target) => host = target,
            None => bridge_target = false,
        }
    }
    if !valid_host(&host)
        || host.matches(':').count() > 1
        || !safe_field(&path)
        || !safe_field(&username)
    {
        if kind == "git" {
            return Err(());
        }
        bridge_target = false;
    }
    let enterprise = host != "github.com" && !host.ends_with(".ghe.com");
    let token_env = if enterprise {
        "GH_ENTERPRISE_TOKEN"
    } else {
        "GH_TOKEN"
    };
    let fallback_env = if enterprise {
        "GITHUB_ENTERPRISE_TOKEN"
    } else {
        "GITHUB_TOKEN"
    };
    let explicit = kind == "gh"
        && [token_env, fallback_env]
            .iter()
            .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
    let answer = if explicit || !bridge_target {
        vec![]
    } else {
        // Broker absence never disables the native credential path. An empty
        // Git helper answer allows the configured chain to continue; gh runs
        // its real executable below without an injected token.
        // Every failure prints one secret-free line to stderr; the native
        // credential path still runs afterwards.
        lookup(kind, &host, &path, &username).await
    };
    if kind == "git" {
        tokio::io::stdout()
            .write_all(&answer)
            .await
            .map_err(|_| ())?;
        return Ok(0);
    }
    let native = gh_command(&real.ok_or(())?, args, token_env, &answer, explicit)?;
    let mut cmd = tokio::process::Command::from(native);
    #[cfg(windows)]
    {
        cmd.creation_flags(crate::winproc::CREATE_NO_WINDOW);
    }
    let status = cmd.status().await.map_err(|_| ())?;
    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}

#[nolog]
async fn lookup(kind: &str, host: &str, path: &str, username: &str) -> Vec<u8> {
        const MISCONFIGURED: &str = "Orgtree credential bridge: this process's bridge settings are missing or invalid; a new turn or CLI process gets fresh ones [misconfigured].";
        let lookup = async {
            let endpoint = std::env::var("ORGTREE_CREDENTIAL_URL").map_err(|_| MISCONFIGURED.to_string())?;
            let url = reqwest::Url::parse(&endpoint).map_err(|_| MISCONFIGURED.to_string())?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.path() != REQUEST
                || !url.username().is_empty()
                || url.query().is_some()
            {
                return Err(MISCONFIGURED.to_string());
            }
            let agent = std::env::var("ORGTREE_CREDENTIAL_AGENT")
                .ok()
                .and_then(|a| a.parse::<i64>().ok())
                .ok_or_else(|| MISCONFIGURED.to_string())?;
            let token = std::env::var("ORGTREE_CREDENTIAL_AUTH").map_err(|_| MISCONFIGURED.to_string())?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| MISCONFIGURED.to_string())?;
            let response = client
                .post(url)
                .header("x-orgtree-credential-token", token)
                .header("x-orgtree-credential-agent", agent.to_string())
                .json(&json!({"agent":agent,"kind":kind,"host":host,"path":path,"username":username}))
                .send()
                .await
                .map_err(|_| "Orgtree credential bridge: the Orgtree engine did not answer; retry in a moment [no-engine].".to_string())?;
            if !response.status().is_success() {
                // The engine's 503 body is a fixed, secret-free sentence.
                let body = response.bytes().await.unwrap_or_default();
                let line: String = String::from_utf8_lossy(&body[..body.len().min(600)])
                    .chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect();
                return Err(if line.trim().is_empty() {
                    "Orgtree credential bridge: the request failed [failed].".to_string()
                } else {
                    line.trim().to_string()
                });
            }
            let result = response
                .bytes()
                .await
                .map_err(|_| "Orgtree credential bridge: the answer was cut off; retry [truncated].".to_string())?;
            if result.is_empty() || result.len() > MAX {
                return Err("Orgtree credential bridge: the answer was empty; retry [empty].".to_string());
            }
            Ok::<Vec<u8>, String>(result.to_vec())
        }
        .await;
        match lookup {
            Ok(answer) => answer,
            Err(line) => {
                if kind == "gh" {
                    eprintln!("{line} Running gh with its own sign-in only.");
                } else {
                    eprintln!("{line}");
                }
                vec![]
            }
        }
}

/// Keep native gh unchanged when the broker is absent or an explicit token wins.
#[nolog]
fn gh_command(
    real: &std::path::Path,
    args: &[String],
    token_env: &str,
    answer: &[u8],
    explicit: bool,
) -> Result<std::process::Command, ()> {
    let mut cmd = std::process::Command::new(real);
    cmd.args(args);
    if !explicit && !answer.is_empty() {
        let token = std::str::from_utf8(answer).map_err(|_| ())?;
        if !safe_field(token.trim()) {
            return Err(());
        }
        cmd.env(token_env, token.trim());
    }
    Ok(cmd)
}

#[nolog]
fn pipe_busy(code: Option<i32>) -> bool {
    code == Some(231)
} // ERROR_PIPE_BUSY

#[nolog]
fn git_config_slot(value: Option<&str>) -> Option<usize> {
    match value {
        None => Some(0),
        Some(value) => value.parse::<usize>().ok().filter(|n| *n < 128),
    }
}

/// Only delete known static files in UUID boot folders, without following links.
/// An in-use Windows executable is left for the next startup; never recurse.
#[logged]
pub fn cleanup_adapters(engine: &Engine) {
    let root = engine.cfg.path("credential-adapters");
    if root
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.take(256).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == engine.boot.id || uuid::Uuid::parse_str(&name).is_err() {
            continue;
        }
        if !entry
            .file_type()
            .map(|t| t.is_dir() && !t.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        let dir = entry.path();
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.take(256).flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            let known = name == "gh.exe" || name == "orgtree-git-askpass.exe"
                || name
                    .strip_suffix(".tmp")
                    .map(|s| uuid::Uuid::parse_str(s).is_ok())
                    .unwrap_or(false);
            if known
                && file
                    .file_type()
                    .map(|t| t.is_file() && !t.is_symlink())
                    .unwrap_or(false)
            {
                let _ = std::fs::remove_file(file.path());
            }
        }
        let _ = std::fs::remove_dir(dir);
    }
}

#[nolog]
fn gh_bridge_host(mut host: String, args: &[String]) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--hostname" | "--repo" | "-R") {
            let Some(value) = args
                .get(i + 1)
                .filter(|v| !v.is_empty() && !v.starts_with('-'))
            else {
                return None;
            };
            if arg == "--hostname" {
                host = value.clone();
            } else if value.split('/').count() == 3 {
                host = value.split('/').next().unwrap().to_string();
            }
        } else if let Some(h) = arg.strip_prefix("--hostname=") {
            host = h.into();
        } else if let Some(repo) = arg.strip_prefix("--repo=") {
            if repo.split('/').count() == 3 {
                host = repo.split('/').next().unwrap().to_string();
            }
        }
    }
    (valid_host(&host) && host.matches(':').count() <= 1).then_some(host)
}

#[cfg(all(test, windows))]
mod host_slot_tests {
    use super::*;

    #[nolog]
    fn lease(expired: bool, wrong_stamp: bool) -> Arc<Broker> {
        let pid = std::process::id();
        Arc::new(Broker { pipe: "test-pipe".into(), secret: "test-only".into(), pid,
            created: process_stamp(pid).unwrap() + u64::from(wrong_stamp),
            expires: if expired { Instant::now() - Duration::from_secs(1) }
                else { Instant::now() + Duration::from_secs(20) } })
    }

    #[test]
    #[nolog]
    fn host_and_credential_lifetimes_are_independent() {
        let bridge = Bridge::new();
        bridge.broker.store(Some(lease(false, false)));
        assert!(bridge.ready());
        assert!(!bridge.can_host());
        assert!(bridge.hosts.admit(1, lease(false, false)).is_ok());
        assert!(bridge.can_host());
        assert_eq!(bridge.host_pid_in(1), Some(std::process::id()));
        assert_eq!(bridge.host_pid_in(2), None);
        bridge.broker.store(None);
        assert!(!bridge.ready());
        assert!(bridge.can_host());
        bridge.broker.store(Some(lease(false, false)));
        for host in [lease(true, false), lease(false, true)] {
            assert!(bridge.hosts.admit(1, host).is_ok());
            assert!(!bridge.can_host());
            assert_eq!(bridge.host_pid_in(1), None);
            assert!(bridge.ready());
        }
        bridge.hosts.release("test-pipe", "test-only", std::process::id());
        assert!(bridge.ready());
        assert!(!bridge.can_host());
    }

    #[test]
    #[nolog]
    fn session_blip_placement_does_not_extend_authenticated_leases() {
        let bridge=Bridge::new();
        assert!(bridge.hosts.admit(1,lease(false,false)).is_ok());
        bridge.set_placement_hosts(bridge.hosting());
        assert!(!bridge.placement_pending(1));
        assert!(bridge.hosts.admit(1,lease(true,false)).is_ok());
        assert!(!bridge.can_host() && !bridge.ready());
        assert_eq!(bridge.placement_hosting(),vec![(1,std::process::id())]);
        assert!(bridge.placement_pending(1));
        assert_eq!(bridge.host_pid_in(1),None,"cached placement cannot authorize spawning");
        bridge.set_placement_hosts(Vec::new());
        assert!(bridge.placement_hosting().is_empty() && !bridge.placement_pending(1));
    }
}

#[cfg(all(test, windows))]
mod host_lease_tests {
    use super::*;

    #[nolog]
    fn holder(pipe: &str) -> Arc<Broker> {
        let pid = std::process::id();
        Arc::new(Broker { pipe: pipe.into(), secret: "test-only".into(), pid, created: process_stamp(pid).unwrap(),
            expires: Instant::now() + Duration::from_secs(20) })
    }

    /// The user, 2026-10-16 12:12Z and 12:13Z: the engine user's sessions are
    /// each hosted by their own sign-in helper, side by side; one per session.
    #[test]
    #[nolog]
    fn one_helper_per_session_and_sessions_side_by_side() {
        let hosts = HostLeases::default();
        assert!(hosts.admit(1, holder("pipe-a")).is_ok());
        assert!(hosts.admit(2, holder("pipe-b")).is_ok(), "another session's helper is admitted beside the first");
        assert!(matches!(hosts.admit(1, holder("pipe-c")), Err(Fail::Held)), "one helper per session");
        assert!(hosts.admit(1, holder("pipe-a")).is_ok(), "its own renewal");
        assert_eq!(hosts.hosting().iter().map(|h| h.0).collect::<Vec<_>>(), vec![1, 2]);
        assert!(hosts.release("pipe-a", "test-only", std::process::id()));
        assert_eq!(hosts.hosting().iter().map(|h| h.0).collect::<Vec<_>>(), vec![2]);
        assert!(!hosts.release("pipe-a", "test-only", std::process::id()), "released once");
    }

    #[test]
    fn a_served_credential_is_kept_exactly_as_served() {
        // invariant 9 and the user's Q3: what a signed-in broker served stays
        // usable by Session 0 turns after sign-out, and only for that request
        let cache = ServedCache::default();
        cache.keep("git", "github.com", "", "alice", b"password=served-secret\n");
        assert_eq!(cache.served("git", "github.com", "", "alice").as_deref(), Some(&b"password=served-secret\n"[..]));
        for (kind, host, path, user) in [("gh", "github.com", "", "alice"), ("git", "gitlab.com", "", "alice"),
                                         ("git", "github.com", "org/repo", "alice"), ("git", "github.com", "", "bob")] {
            assert_eq!(cache.served(kind, host, path, user), None, "{kind} {host} {path} {user}");
        }
        assert_eq!(Bridge::new().served.len(), 0, "an engine starts with nothing: the cache is lost at a restart");
    }

    #[tokio::test]
    async fn a_kept_credential_never_reaches_the_log_or_the_bridges_views() {
        let canary = format!("canary-{}", crate::util::random_hex(16));
        let capture = crate::trace::LogCapture::start().await;
        let bridge = Bridge::new();
        bridge.served.keep("git", "github.com", "", "alice", format!("password={canary}\n").as_bytes());
        assert_eq!(bridge.served.served("git", "github.com", "", "alice").as_deref(),
            Some(format!("password={canary}\n").as_bytes()), "the cache holds it while the log is captured");
        bridge.record("git", "github.com", None);
        let view = bridge.lookup_view().to_string();
        let log = capture.finish().await;
        assert!(!log.contains(&canary), "the secret reached the log");
        assert!(!view.contains(&canary), "the secret reached a view: {view}");
    }

    /// Nothing formats or serializes a kept credential: this compiles only
    /// while neither `Served` nor its cache implements Debug or Serialize.
    #[test]
    fn a_kept_credential_cannot_be_formatted_or_serialized() {
        trait NotDebug<A> { fn check() {} }
        impl<T: ?Sized> NotDebug<()> for T {}
        impl<T: ?Sized + std::fmt::Debug> NotDebug<u8> for T {}
        trait NotSerialize<A> { fn check() {} }
        impl<T: ?Sized> NotSerialize<()> for T {}
        impl<T: ?Sized + serde::Serialize> NotSerialize<u8> for T {}
        <Served as NotDebug<_>>::check();
        <ServedCache as NotDebug<_>>::check();
        <Served as NotSerialize<_>>::check();
        <ServedCache as NotSerialize<_>>::check();
    }

    #[test]
    fn a_helper_hosts_only_with_the_engines_own_administrator_rights() {
        // invariant 7 (the user, 2026-10-22 07:29:35Z): both elevated or neither
        assert!(same_rights(false, Some(false)));
        assert!(same_rights(true, Some(true)));
        assert!(!same_rights(true, Some(false)), "an elevated engine refuses an unelevated helper");
        assert!(!same_rights(false, Some(true)), "an unelevated engine refuses an elevated helper");
        assert!(same_rights(false, None), "a helper that does not say is an unelevated one");
        assert!(!same_rights(true, None));
    }
}
