//! Background AGY authentication. Credential metadata is a change detector,
//! never proof of validity. Only the CLI's silent, zero-argument check validates.
//! The check/use race remains: a later OAuth attempt is killed and latched.
//! A clean silent refusal is revalidated silently (check mode only): on a
//! user's forced read and on a bounded cadence, because a token refreshed in
//! place by the user's own AGY keeps the credential metadata unchanged.
//!
//! Extra Antigravity accounts (4.4.0, docket `antigravity-multi-account-
//! support-via-isolated-p`): a registered Antigravity subscription row that is
//! not the user's own sign-in is its own [`Login`], run with `USERPROFILE` and
//! `HOME` at the row's folder, its own latch and stamp. A folder does NOT
//! isolate AGY 1.3.5: measured 2026-10-16 (two user-approved probes), a fresh
//! empty home still reads the shared Windows Credential Manager entry
//! (`gemini:antigravity`, a fixed target), with or without the home's
//! `antigravity-keyring-unavailable` marker. So a profile login is run only
//! when its silent check names an account AND the default sign-in, asked right
//! then, does not name the same one; otherwise it is refused
//! (`Refusal::NotIsolated`) and never silently runs on the default sign-in.
//! Fail closed. Today that refuses every profile; a future AGY that keeps
//! sign-ins per home passes the same check with no code change.

use std::{collections::HashMap, path::{Path, PathBuf}, process::{Output, Stdio}, sync::Mutex, time::{Duration, SystemTime}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use futures::future::BoxFuture;
use tokio::{io::AsyncReadExt, process::Command};
use crate::engine::Engine;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp(pub u64);

/// Which Antigravity sign-in a command runs on: the user's own (`Primary`:
/// the OS user's home and keyring, exactly as before) or a registered
/// account's profile folder (`Profile`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Login { Primary, Profile { id: String, home: PathBuf } }

#[logged]
impl Login {
    /// The environment an AGY process for this login runs with. Empty for the
    /// default sign-in: its launches are byte-identical to before.
    #[nolog]
    pub fn env(&self) -> Vec<(String, String)> {
        match self {
            Login::Primary => Vec::new(),
            Login::Profile { home, .. } => {
                let h = home.to_string_lossy().to_string();
                vec![("USERPROFILE".into(), h.clone()), ("HOME".into(), h)]
            }
        }
    }
    /// The registry account id of a profile login; None for the default sign-in.
    #[nolog]
    pub fn account(&self) -> Option<&str> {
        match self { Login::Primary => None, Login::Profile { id, .. } => Some(id) }
    }
    /// Point a command at this login, after everything else so nothing
    /// inherited can point it back at the user's own home. No-op for the
    /// default sign-in.
    #[nolog]
    pub fn apply(&self, cmd: &mut Command) {
        for (k, v) in self.env() { cmd.env(k, v); }
    }
}

/// The login an Antigravity seat bound to `account` runs on: a registered
/// subscription row with its own folder (not an API key, not a row pointing at
/// the user's own sign-in) is a profile login; everything else is the default.
#[logged]
pub fn login_of(view: &crate::accounts::AccountsView, account: Option<&str>) -> Login {
    account.and_then(|id| view.get(id))
        .filter(|a| a.provider == crate::providers::catalog::GOOGLE && !a.is_apikey() && !a.ambient)
        .and_then(|a| a.config_dir.as_deref().filter(|d| !d.trim().is_empty())
            .map(|d| Login::Profile { id: a.id.clone(), home: PathBuf::from(d) }))
        .unwrap_or(Login::Primary)
}

/// How a credential came to be latched. `Refused` is the measured clean
/// signed-out answer of the silent check (non-zero exit, no output): safe to
/// ask again silently. `Untrusted` is an auth prompt or output the check is
/// not known to produce: never re-run until the credential itself changes.
/// `NotIsolated` (profile logins only): the profile's check named the same
/// account as the default sign-in, so the two are not separate; held, like
/// `Untrusted`, until the profile's credential metadata changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal { Refused, Untrusted, NotIsolated }

/// Latch file. Builds up to 4.3.0-alpha.3 wrote the bare stamp; such a latch
/// counts as `Refused`, so it is revalidated instead of holding forever.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum LatchFile { Kind { stamp: Stamp, kind: Refusal }, Legacy(Stamp) }

/// A forced read revalidates a `Refused` latch at most this often.
const FORCED_RECHECK: Duration = Duration::from_secs(30);
/// Without user action a `Refused` latch is revalidated after this long
/// (the usage loop's own five-minute cadence then performs the check).
const CADENCE_RECHECK: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct AuthGate {
    // Per engine, never a global lock. No database transaction spans a check.
    check: tokio::sync::Mutex<()>,
    observed: Mutex<Option<Option<Stamp>>>,
    refused: Mutex<Option<(Stamp, Refusal, SystemTime)>>,
    // Last user-forced read; it may revalidate a `Refused` latch written before it.
    forced: Mutex<Option<SystemTime>>,
    // A profile login's in-memory latch, by account id (its file wins, as for
    // the default sign-in's).
    profiles: Mutex<HashMap<String, (Stamp, Refusal, SystemTime)>>,
}

#[derive(Debug, Clone, Copy)]
pub enum Failure { SignedOut, Unavailable, Timeout, OutputLimit, NotIsolated }
impl std::fmt::Display for Failure {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SignedOut => "Antigravity is signed out or its sign-in could not be validated; sign in through Antigravity",
            Self::Unavailable => "Antigravity authentication could not be checked",
            Self::Timeout => "Antigravity background command timed out",
            Self::OutputLimit => "Antigravity background output exceeded its limit",
            Self::NotIsolated => "this Antigravity account is signed in as the same Google account as the default Antigravity sign-in: \
                Antigravity did not keep the two sign-ins apart, so Orgtree will not run it; sign this account in again in its own terminal",
        })
    }
}
impl std::error::Error for Failure {}
impl Failure {
    #[nolog]
    pub fn transient(self) -> bool {
        matches!(self, Self::Unavailable | Self::Timeout)
    }

    #[nolog]
    pub fn reading(self) -> Value {
        let mut v = json!({"available":false,"error":self.to_string(),"provider":"google","account":"google/primary"});
        if matches!(self, Self::SignedOut) {
            v["reauth_required"] = json!(true);
            v["reauth_evidence"] = json!("not_connected");
        }
        if matches!(self, Self::NotIsolated) {
            v["not_isolated"] = json!(true);
        }
        v
    }
}

#[cfg(windows)]
#[nolog] // No CredentialBlob, UserName or other credential content is read.
fn system_stamp() -> Result<Option<Stamp>, Failure> {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::{CredEnumerateW, CredFree, CREDENTIALW}};
    let target: Vec<u16> = "gemini:antigravity\0".encode_utf16().collect();
    let mut count = 0;
    let mut entries: *mut *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        if CredEnumerateW(target.as_ptr(), 0, &mut count, &mut entries) == 0 {
            return if GetLastError() == ERROR_NOT_FOUND { Ok(None) } else { Err(Failure::Unavailable) };
        }
        let result = if count > 0 && !entries.is_null() && !(*entries).is_null() {
            let t = (**entries).LastWritten;
            Some(Stamp(((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64))
        } else { None };
        if !entries.is_null() { CredFree(entries.cast()); }
        Ok(result)
    }
}

#[cfg(not(windows))]
#[nolog]
fn system_stamp() -> Result<Option<Stamp>, Failure> {
    // No guessed keyring target on other platforms. Their silent check still
    // guards launches; a periodic check can observe external sign-in there.
    Ok(Some(Stamp(0)))
}

#[nolog]
fn metadata(engine: &Engine) -> Result<Option<Stamp>, Failure> {
    if crate::rig::active() {
        // Rig fixtures never enumerate the real vault. Missing fixture retains
        // the pre-existing fake CLI's signed-in default.
        let p = engine.cfg.data_root.join("agy-auth-metadata.json");
        if !p.exists() { return Ok(Some(Stamp(1))); }
        let v: Value = serde_json::from_slice(&std::fs::read(p).map_err(|_| Failure::Unavailable)?).map_err(|_| Failure::Unavailable)?;
        return match v["stamp"].as_u64() {
            Some(n) => Ok(Some(Stamp(n))),
            None if v["present"] == false => Ok(None),
            _ => Err(Failure::Unavailable),
        };
    }
    system_stamp()
}

/// A profile login's credential metadata: the modification times and sizes of
/// the token files in its own `.gemini` folder (never their contents).
/// No token file: signed out. A change detector only, like the default's.
#[nolog]
fn profile_stamp(home: &Path) -> Result<Option<Stamp>, Failure> {
    let entries = match std::fs::read_dir(home.join(".gemini")) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Failure::Unavailable),
    };
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.contains("token") { continue; }
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() { continue; }
        let t = m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
        files.push((name, t, m.len()));
    }
    if files.is_empty() { return Ok(None); }
    files.sort();
    // FNV-1a over names, times and sizes; never 0
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (n, t, l) in files {
        for b in n.bytes().chain(t.to_le_bytes()).chain(l.to_le_bytes()) { h ^= b as u64; h = h.wrapping_mul(0x0100_0000_01b3); }
    }
    Ok(Some(Stamp(h | 1)))
}

/// One login's credential metadata.
#[nolog]
fn metadata_for(engine: &Engine, login: &Login) -> Result<Option<Stamp>, Failure> {
    match login {
        Login::Primary => metadata(engine),
        Login::Profile { home, .. } => profile_stamp(home),
    }
}

#[nolog]
fn latch_path(engine: &Engine) -> std::path::PathBuf {
    engine.cfg.path("diagnostics").join("agy-auth-latch.json")
}

#[nolog]
fn latch_path_for(engine: &Engine, login: &Login) -> std::path::PathBuf {
    match login {
        Login::Primary => latch_path(engine),
        Login::Profile { id, .. } => {
            let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            engine.cfg.path("diagnostics").join(format!("agy-auth-latch-{safe}.json"))
        }
    }
}

/// The latch for this exact credential: its kind and when it was written.
/// The persisted file (and its modification time) wins over memory.
#[nolog]
fn latch_of(engine: &Engine, login: &Login, stamp: Stamp) -> Option<(Refusal, SystemTime)> {
    let path = latch_path_for(engine, login);
    let persisted = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<LatchFile>(&b).ok())
        .and_then(|f| match f {
            LatchFile::Kind { stamp: s, kind } if s == stamp => Some(kind),
            LatchFile::Legacy(s) if s == stamp => Some(Refusal::Refused),
            _ => None,
        });
    if let Some(kind) = persisted {
        let at = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or_else(|_| SystemTime::now());
        return Some((kind, at));
    }
    let gate = &engine.providers.agy_auth;
    let memory = match login {
        Login::Primary => *gate.refused.lock().unwrap_or_else(|p| p.into_inner()),
        Login::Profile { id, .. } => gate.profiles.lock().unwrap_or_else(|p| p.into_inner()).get(id).copied(),
    };
    match memory {
        Some((s, kind, at)) if s == stamp => Some((kind, at)),
        _ => None,
    }
}

/// The kind of a latch that still holds this credential, if one does.
#[nolog]
fn holding(engine: &Engine, login: &Login, stamp: Stamp) -> Option<Refusal> {
    let (kind, at) = latch_of(engine, login, stamp)?;
    let age = at.elapsed().unwrap_or_default();
    if !cfg!(windows) && !crate::rig::active() {
        // No verified metadata detector on this platform. Revalidate silently
        // at most every five minutes; never allow the actual command first.
        return (age < CADENCE_RECHECK).then_some(kind);
    }
    if kind == Refusal::Untrusted || kind == Refusal::NotIsolated { return Some(kind); }
    let forced: Option<SystemTime> = *engine.providers.agy_auth.forced.lock().unwrap_or_else(|p| p.into_inner());
    let forced = forced.is_some_and(|t| t > at);
    (!(age >= CADENCE_RECHECK || (forced && age >= FORCED_RECHECK))).then_some(kind)
}

#[nolog]
fn latched(engine: &Engine, login: &Login, stamp: Stamp) -> bool {
    holding(engine, login, stamp).is_some()
}

/// A user asked for a fresh reading: a `Refused` latch at least
/// `FORCED_RECHECK` old may be revalidated by the next silent check.
#[nolog]
pub fn user_recheck(engine: &Engine) {
    *engine.providers.agy_auth.forced.lock().unwrap_or_else(|p| p.into_inner()) = Some(SystemTime::now());
}

/// Poll only metadata, not the CLI. Used to invalidate cached usage after an
/// external sign-in/sign-out and to release a latch only for a new credential.
#[nolog]
pub fn changed(engine: &Engine) -> bool {
    let Ok(now) = metadata(engine) else { return false };
    let mut prev = engine.providers.agy_auth.observed.lock().unwrap_or_else(|p| p.into_inner());
    let changed = *prev != Some(now);
    *prev = Some(now);
    changed
}

#[nolog]
pub fn blocked(engine: &Engine) -> Option<Failure> {
    blocked_for(engine, &Login::Primary)
}

/// Whether a login is known not to run now (metadata only, never the CLI).
#[nolog]
pub fn blocked_for(engine: &Engine, login: &Login) -> Option<Failure> {
    let failure = match metadata_for(engine, login) {
        Ok(None) => Some(Failure::SignedOut),
        Ok(Some(stamp)) => match holding(engine, login, stamp) {
            Some(Refusal::NotIsolated) => Some(Failure::NotIsolated),
            Some(_) => Some(Failure::SignedOut),
            None => None,
        },
        Err(e) => Some(e),
    };
    if failure.is_some() && *login == Login::Primary { connected(engine, false); }
    failure
}

#[nolog]
fn connected(engine: &Engine, yes: bool) {
    if engine.providers.state.load().agy.connected == yes { return; }
    engine.providers.state.rcu(|old| {
        let mut state = (**old).clone();
        state.agy.connected = yes;
        if !yes { state.agy.email = None; state.agy.kind = None; }
        state
    });
    crate::providers::publish(engine);
}

#[nolog]
pub fn refuse(engine: &Engine, stamp: Stamp, kind: Refusal) {
    refuse_for(engine, &Login::Primary, stamp, kind)
}

#[nolog]
pub fn refuse_for(engine: &Engine, login: &Login, stamp: Stamp, kind: Refusal) {
    // An old process must not latch a different login that just replaced it.
    if metadata_for(engine, login).ok().flatten() != Some(stamp) { return; }
    let gate = &engine.providers.agy_auth;
    match login {
        Login::Primary => *gate.refused.lock().unwrap_or_else(|p| p.into_inner()) = Some((stamp, kind, SystemTime::now())),
        Login::Profile { id, .. } => { gate.profiles.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), (stamp, kind, SystemTime::now())); }
    }
    // The file contains only last-write metadata and the refusal kind, never
    // a token, prompt or account name.
    let path = latch_path_for(engine, login);
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(bytes) = serde_json::to_vec(&LatchFile::Kind { stamp, kind }) {
        if std::fs::write(path, bytes).is_err() { tracing::error!("could not persist AGY auth latch"); }
    }
    if *login == Login::Primary {
        connected(engine, false);
        crate::usage::record_agy_auth_failure(engine, Failure::SignedOut.reading());
    }
}

/// Clear a login's latch after its silent check passed.
#[nolog]
fn release(engine: &Engine, login: &Login) {
    let gate = &engine.providers.agy_auth;
    match login {
        Login::Primary => *gate.refused.lock().unwrap_or_else(|p| p.into_inner()) = None,
        Login::Profile { id, .. } => { gate.profiles.lock().unwrap_or_else(|p| p.into_inner()).remove(id); }
    }
    let _ = std::fs::remove_file(latch_path_for(engine, login));
}

/// The silent check's success reply. Measured on AGY 1.3.5 signed in
/// (2026-10-14): exit 0, stdout `Already authenticated as <account>` and a
/// newline, empty stderr. Empty output is accepted too. Any other output is
/// not a reply this guard knows, so it never authorizes a launch.
#[nolog]
fn check_passed(output: &Output) -> bool {
    if !output.status.success() || !output.stderr.iter().all(u8::is_ascii_whitespace) { return false; }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    match (lines.next(), lines.next()) {
        (None, _) => true,
        (Some(line), None) => line.starts_with("Already authenticated as "),
        _ => false,
    }
}

/// The account a passing silent check names (`Already authenticated as <x>`);
/// None for the empty reply, or any reply the guard does not accept.
#[nolog]
fn check_identity(output: &Output) -> Option<String> {
    if !check_passed(output) { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().map(str::trim).find_map(|l| l.strip_prefix("Already authenticated as "))
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether two check replies name the same account (case-insensitive).
#[nolog]
fn same_account(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Defense in depth only: OAuth may start BEFORE the CLI prints its prompt.
/// Ignore ordinary model JSON; inspect only actual error results or plain CLI
/// output, so an assistant discussing authentication is not a sign-out signal.
#[nolog]
pub fn auth_prompt(bytes: &[u8]) -> bool {
    let raw = String::from_utf8_lossy(bytes);
    let text = if raw.trim_start().starts_with('{') {
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { return false };
        let r = v.get("result").unwrap_or(&v);
        if r["status"] != "ERROR" && r["is_error"] != true { return false; }
        r["error"].as_str().unwrap_or("").to_owned()
    } else { raw.into_owned() };
    let lower = text.to_lowercase();
    ["authentication required", "not authenticated", "starting oauth", "enter the authorization code",
     "enter authorization code", "enter the code", "accounts.google.com/o/oauth", "oauth2/auth",
     "please sign in", "please log in", "waiting for authentication"].iter().any(|p| lower.contains(p))
}

#[nolog]
pub fn configure(cmd: &mut Command) {
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .env_remove("AGY_CLI_CDE_AUTH_ACTION")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    crate::winproc::no_window(cmd);
}

#[nolog]
fn capture(cmd: Command, timeout: Duration) -> BoxFuture<'static, Result<Output, Failure>> {
    Box::pin(capture_inner(cmd, timeout))
}

/// Only fixed stage names and failure classes; never process output or OS
/// error strings, which may contain paths or credential material.
#[nolog]
fn check_failure(stage: &'static str, failure: Failure) -> Failure {
    tracing::warn!(stage, reason = ?failure, "Antigravity guarded check failed");
    failure
}

#[nolog]
async fn capture_inner(mut cmd: Command, timeout: Duration) -> Result<Output, Failure> {
    let mut child = cmd.spawn().map_err(|_| check_failure("spawn", Failure::Unavailable))?;
    let job = crate::winproc::child_job(&child);
    drop(child.stdin.take());
    let stdout = child.stdout.take().ok_or_else(|| check_failure("stdout_pipe", Failure::Unavailable))?;
    let stderr = child.stderr.take().ok_or_else(|| check_failure("stderr_pipe", Failure::Unavailable))?;
    async fn read(mut stream: impl tokio::io::AsyncRead + Unpin, stage: &'static str) -> Result<Vec<u8>, Failure> {
        let mut all = Vec::new();
        let mut buf = vec![0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.map_err(|_| check_failure(stage, Failure::Unavailable))?;
            if n == 0 { return Ok(all); }
            all.extend_from_slice(&buf[..n]);
            // Scan each line (including an unfinished prompt with no newline).
            if all.split(|b| *b == b'\n').any(auth_prompt) { return Err(Failure::SignedOut); }
            if all.len() > 4 * 1024 * 1024 { return Err(Failure::OutputLimit); }
        }
    }
    let result = tokio::time::timeout(timeout, async {
        let (stdout, stderr, status) = tokio::try_join!(read(stdout, "stdout_read"), read(stderr, "stderr_read"), async {
            child.wait().await.map_err(|_| check_failure("wait_exit", Failure::Unavailable))
        })?;
        Ok(Output { status, stdout, stderr })
    }).await.unwrap_or_else(|_| Err(check_failure("capture_timeout", Failure::Timeout)));
    if result.is_err() {
        if let Some(job) = &job { job.terminate(); }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

/// The installed version for Settings → Harnesses: `agy --version`, the one
/// AGY launch that is NOT preceded by the silent check, so a signed-out or
/// latched install still shows its version. Measured on AGY 1.3.5
/// (2026-10-14): exit 0 in 94 ms, stdout `1.3.5`, no CLI log written (no
/// language server or auth stack started), credential untouched. It is still
/// bounded, windowless, updater-disabled and watched for an auth prompt.
#[nolog]
pub fn version(exe: &Path) -> BoxFuture<'static, Option<String>> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    configure(&mut cmd);
    Box::pin(async move {
        capture(cmd, Duration::from_secs(8)).await.ok()
            .filter(|o| o.status.success())
            .and_then(|o| version_line(&o.stdout))
    })
}

/// One short line starting with a digit, as AGY prints it; anything else is
/// not a version and is never shown as one.
#[nolog]
fn version_line(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines.next()?;
    (lines.next().is_none() && line.len() <= 80 && line.starts_with(|c: char| c.is_ascii_digit()))
        .then(|| line.to_string())
}

/// The default sign-in, for the wrappers that keep its callers unchanged.
static PRIMARY: Login = Login::Primary;

#[nolog]
pub fn preflight<'a>(engine: &'a Engine, exe: &'a Path) -> BoxFuture<'a, Result<Stamp, Failure>> {
    preflight_for(engine, exe, &PRIMARY)
}

#[nolog]
pub fn preflight_for<'a>(engine: &'a Engine, exe: &'a Path, login: &'a Login) -> BoxFuture<'a, Result<Stamp, Failure>> {
    // A concrete async state propagates through ensure_agy/start_turn and the
    // actor's select branches. Keep this boundary heap-owned and type-erased:
    // otherwise its nested pipe readers multiply the debug actor stack frame.
    Box::pin(async move { preflight_inner(engine, exe, login).await.map(|(stamp, _)| stamp) })
}

/// Agent admission/launch only: retry one inconclusive check, not a known
/// refusal. Each attempt reacquires the guard and reads current metadata.
/// The sleep holds neither the guard's mutex nor a database transaction.
#[nolog]
pub fn launch_preflight_for<'a>(engine: &'a Engine, exe: &'a Path, login: &'a Login) -> BoxFuture<'a, Result<Stamp, Failure>> {
    Box::pin(retry_launch(|| preflight_for(engine, exe, login)))
}

#[nolog]
async fn retry_launch<C, F>(mut check: C) -> Result<Stamp, Failure>
where C: FnMut() -> F, F: std::future::Future<Output = Result<Stamp, Failure>> {
    let first = check().await;
    if let Err(failure) = first {
        if failure.transient() {
            tracing::warn!(reason = ?failure, attempt = 1, retry_ms = 500,
                "Antigravity launch check inconclusive; retrying once");
            tokio::time::sleep(Duration::from_millis(500)).await;
            return check().await;
        }
    }
    first
}

/// Who a login is signed in as, by the same guarded silent check a launch
/// runs (the identity read of a registered account). Never logged: the
/// answer names an account.
#[nolog]
pub fn identity_for<'a>(engine: &'a Engine, exe: &'a Path, login: &'a Login) -> BoxFuture<'a, Result<Option<String>, Failure>> {
    Box::pin(async move { preflight_inner(engine, exe, login).await.map(|(_, who)| who) })
}

/// The silent check's command for a login. IMPORTANT: no args. With any args
/// AGY skips CDE_AUTH_ACTION entirely.
#[nolog]
fn check_command(exe: &Path, login: &Login) -> Command {
    let mut cmd = Command::new(exe);
    configure(&mut cmd);
    cmd.env("AGY_CLI_CDE_AUTH_ACTION", "check");
    for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH"] { cmd.env_remove(key); }
    login.apply(&mut cmd);
    cmd
}

#[nolog]
async fn preflight_inner(engine: &Engine, exe: &Path, login: &Login) -> Result<(Stamp, Option<String>), Failure> {
    let _check = engine.providers.agy_auth.check.lock().await;
    let stamp = match metadata_for(engine, login) {
        Ok(Some(s)) => s,
        Ok(None) => { if *login == Login::Primary { connected(engine, false); } return Err(Failure::SignedOut); }
        Err(e) => return Err(check_failure("metadata_before_check", e)),
    };
    if let Some(kind) = holding(engine, login, stamp) {
        return Err(if kind == Refusal::NotIsolated { Failure::NotIsolated } else { Failure::SignedOut });
    }
    let result = capture(check_command(exe, login), Duration::from_secs(8)).await;
    match result {
        Ok(output) if check_passed(&output) => {
            // A credential changed while checking: don't authorize the old result.
            if metadata_for(engine, login).map_err(|e| check_failure("metadata_after_check", e))? != Some(stamp) {
                return Err(check_failure("metadata_changed_during_check", Failure::Unavailable));
            }
            if cfg!(windows) && latched(engine, login, stamp) { return Err(Failure::SignedOut); }
            let who = check_identity(&output);
            if *login != Login::Primary {
                // Fail closed: a profile runs only when its check names an
                // account and the default sign-in, asked right now, does not
                // name the same one (shared keyring, measured 2026-10-16).
                let Some(me) = who.as_deref() else { return Err(check_failure("profile_identity_missing", Failure::Unavailable)) };
                if default_identity(engine, exe).await.map_err(|e| check_failure("default_identity_check", e))?.is_some_and(|d| same_account(&d, me)) {
                    refuse_for(engine, login, stamp, Refusal::NotIsolated);
                    return Err(Failure::NotIsolated);
                }
            }
            release(engine, login);
            if *login == Login::Primary { connected(engine, true); }
            Ok((stamp, who))
        }
        // The measured clean signed-out answer: non-zero exit, no output.
        Ok(output) if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() => {
            refuse_for(engine, login, stamp, Refusal::Refused); Err(Failure::SignedOut)
        }
        Ok(_) | Err(Failure::SignedOut) => { refuse_for(engine, login, stamp, Refusal::Untrusted); Err(Failure::SignedOut) }
        Err(e) => Err(e),
    }
}

/// The account the default sign-in names right now, for a profile's isolation
/// comparison (called with the check lock held; never changes the default's
/// latch or state). None when the default is signed out (no credential entry,
/// a clean refusal latch, or the measured signed-out reply): a profile then
/// cannot be reading it. A default the guard must not run (an untrusted
/// latch) or whose reply names nobody fails closed.
#[nolog]
async fn default_identity(engine: &Engine, exe: &Path) -> Result<Option<String>, Failure> {
    let Some(stamp) = metadata(engine)? else { return Ok(None) };
    match holding(engine, &PRIMARY, stamp) {
        Some(Refusal::Refused) => return Ok(None),
        Some(_) => return Err(Failure::Unavailable),
        None => {}
    }
    match capture(check_command(exe, &PRIMARY), Duration::from_secs(8)).await {
        Ok(output) if check_passed(&output) => check_identity(&output).map(Some).ok_or(Failure::Unavailable),
        Ok(output) if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() => Ok(None),
        _ => Err(Failure::Unavailable),
    }
}

#[nolog]
pub fn checked_output<'a>(engine: &'a Engine, exe: &'a Path, cmd: Command, timeout: Duration) -> BoxFuture<'a, Result<Output, Failure>> {
    checked_output_for(engine, exe, cmd, timeout, &PRIMARY)
}

#[nolog]
pub fn checked_output_for<'a>(engine: &'a Engine, exe: &'a Path, cmd: Command, timeout: Duration, login: &'a Login)
    -> BoxFuture<'a, Result<Output, Failure>> {
    Box::pin(checked_output_inner(engine, exe, cmd, timeout, login))
}

#[nolog]
async fn checked_output_inner(engine: &Engine, exe: &Path, mut cmd: Command, timeout: Duration, login: &Login) -> Result<Output, Failure> {
    let stamp = preflight_for(engine, exe, login).await?;
    configure(&mut cmd);
    login.apply(&mut cmd);
    // Recheck the latch/metadata at the launch edge as another caller may have
    // observed auth failure while this caller was awaiting its silent check.
    if metadata_for(engine, login)? != Some(stamp) { return Err(Failure::Unavailable); }
    if latched(engine, login, stamp) { return Err(Failure::SignedOut); }
    let result = capture(cmd, timeout).await;
    if matches!(result, Err(Failure::SignedOut)) { refuse_for(engine, login, stamp, Refusal::Untrusted); }
    result
}

#[cfg(test)]
mod launch_retry_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agy_auth_capture_future_has_bounded_inline_size() {
        // Construct only: never poll or spawn this deliberately invalid CLI.
        // This same assertion on the unboxed predecessor is the red control.
        let future = capture(Command::new("not-a-real-agy-executable"), Duration::from_secs(1));
        let bytes = std::mem::size_of_val(&future);
        eprintln!("AGY capture inline future bytes: {bytes}");
        assert!(bytes <= 64, "capture leaked {bytes} bytes into its caller's async state");
    }
    #[test]
    fn agy_auth_prompt_detects_split_plain_prompt_and_error_only() {
        assert!(auth_prompt(b"Starting OAuth process"));
        assert!(auth_prompt(b"Enter the authorization code:"));
        assert!(auth_prompt(br#"{"event":"result","result":{"status":"ERROR","error":"authentication required"}}"#));
        assert!(!auth_prompt(br#"{"event":"step_update","text":"please sign in"}"#));
        assert!(!auth_prompt(b"Tokens used: 0"));
    }
    fn output(code: u32, stdout: &[u8], stderr: &[u8]) -> Output {
        #[cfg(windows)]
        let status = std::os::windows::process::ExitStatusExt::from_raw(code);
        #[cfg(not(windows))]
        let status = std::os::unix::process::ExitStatusExt::from_raw((code as i32) << 8);
        Output { status, stdout: stdout.to_vec(), stderr: stderr.to_vec() }
    }
    #[test]
    fn agy_auth_check_accepts_measured_signed_in_reply_only() {
        // The measured AGY 1.3.5 reply (account redacted) and the empty reply.
        assert!(check_passed(&output(0, b"Already authenticated as someone@example.invalid\n", b"")));
        assert!(check_passed(&output(0, b"Already authenticated as someone@example.invalid\r\n", b"")));
        assert!(check_passed(&output(0, b"", b"")));
        assert!(!check_passed(&output(1, b"", b"")));
        assert!(!check_passed(&output(1, b"Already authenticated as someone@example.invalid\n", b"")));
        assert!(!check_passed(&output(0, b"unknown environment action\n", b"")));
        assert!(!check_passed(&output(0, b"Already authenticated as a\nsecond line\n", b"")));
        assert!(!check_passed(&output(0, b"Already authenticated as a\n", b"warning\n")));
    }
    #[test]
    fn agy_auth_latch_file_reads_legacy_stamp_as_refused() {
        let legacy: LatchFile = serde_json::from_slice(b"134364694863512016").unwrap();
        assert!(matches!(legacy, LatchFile::Legacy(Stamp(134364694863512016))));
        let kind: LatchFile = serde_json::from_slice(&serde_json::to_vec(
            &LatchFile::Kind { stamp: Stamp(11), kind: Refusal::Untrusted }).unwrap()).unwrap();
        assert!(matches!(kind, LatchFile::Kind { stamp: Stamp(11), kind: Refusal::Untrusted }));
        assert_eq!(serde_json::to_string(&LatchFile::Kind { stamp: Stamp(11), kind: Refusal::Refused }).unwrap(),
            r#"{"stamp":11,"kind":"refused"}"#);
    }
    #[test]
    fn agy_auth_version_line_accepts_measured_output_only() {
        assert_eq!(version_line(b"1.3.5\n").as_deref(), Some("1.3.5"));
        assert_eq!(version_line(b"1.3.5\r\n").as_deref(), Some("1.3.5"));
        assert_eq!(version_line(b"1.99.0 (Antigravity fake)\n").as_deref(), Some("1.99.0 (Antigravity fake)"));
        assert_eq!(version_line(b""), None);
        assert_eq!(version_line(b"Already authenticated as someone@example.invalid\n"), None);
        assert_eq!(version_line(b"1.3.5\nupdate available\n"), None);
        assert_eq!(version_line(b"Enter the authorization code:"), None);
    }
    #[test]
    fn agy_auth_failure_is_signed_out_not_zero_usage() {
        let v = Failure::SignedOut.reading();
        assert_eq!(v["reauth_required"], true);
        assert_eq!(v["available"], false);
        assert!(v.get("limits").is_none());
        assert!(Failure::Unavailable.reading().get("reauth_required").is_none());
    }
    #[test]
    fn agy_auth_command_disables_update_and_check_action_inheritance() {
        let mut cmd = Command::new("fake-agy");
        configure(&mut cmd);
        let env: Vec<_> = cmd.as_std().get_envs().collect();
        assert!(env.iter().any(|(k,v)| *k == "AGY_CLI_DISABLE_AUTO_UPDATE" && *v == Some(std::ffi::OsStr::new("true"))));
        assert!(env.iter().any(|(k,v)| *k == "AGY_CLI_CDE_AUTH_ACTION" && v.is_none()));
        assert_eq!(cmd.as_std().get_args().count(), 0);
    }

    fn account(id: &str, provider: &str, kind: &str, dir: Option<&str>, ambient: bool) -> crate::accounts::AccountInfo {
        crate::accounts::AccountInfo {
            id: id.into(), provider: provider.into(), kind: kind.into(), label: id.into(), email: None,
            tint_ordinal: 1, auth: "unobserved".into(), config_dir: dir.map(str::to_string), enabled: true,
            origin_org: None, marks: HashMap::new(), ord: 1, ambient, credential: 0, harness: None,
        }
    }

    /// An Antigravity subscription row with its own folder is its own login;
    /// the user's own sign-in, an API key, another provider's row or no
    /// binding at all stay on the default sign-in, exactly as before.
    #[test]
    fn agy_profile_login_of_a_registered_subscription_row_only() {
        let rows = [
            account("google-2", "google", "managed", Some("C:/data/profiles/google-ab"), false),
            account("google-3", "google", "managed", Some("C:/Users/u/.gemini-home"), true),
            account("google-4", "google", "apikey", None, false),
            account("google-5", "google", "imported", Some("  "), false),
            account("claude-2", "claude", "managed", Some("C:/data/profiles/claude-ab"), false),
        ];
        let view = crate::accounts::AccountsView(std::sync::Arc::new(crate::accounts::Inner {
            by_id: rows.into_iter().map(|a| (a.id.clone(), a)).collect(),
        }));
        assert_eq!(login_of(&view, Some("google-2")),
            Login::Profile { id: "google-2".into(), home: PathBuf::from("C:/data/profiles/google-ab") });
        for id in [None, Some("google-3"), Some("google-4"), Some("google-5"), Some("claude-2"), Some("missing")] {
            assert_eq!(login_of(&view, id), Login::Primary, "{id:?} stays on the default sign-in");
        }
    }

    /// A profile process points both home variables at the profile folder,
    /// after anything inherited; the default sign-in's command is untouched.
    #[test]
    fn agy_profile_env_points_home_at_the_profile_only() {
        let login = Login::Profile { id: "google-2".into(), home: PathBuf::from("C:/data/profiles/google-ab") };
        assert_eq!(login.env(), vec![("USERPROFILE".to_string(), "C:/data/profiles/google-ab".to_string()),
            ("HOME".to_string(), "C:/data/profiles/google-ab".to_string())]);
        let mut cmd = Command::new("fake-agy");
        cmd.env("USERPROFILE", "C:/Users/someone");
        login.apply(&mut cmd);
        let env: HashMap<_, _> = cmd.as_std().get_envs().collect();
        assert_eq!(env.get(std::ffi::OsStr::new("USERPROFILE")).copied().flatten(), Some(std::ffi::OsStr::new("C:/data/profiles/google-ab")));
        assert_eq!(login.account(), Some("google-2"));
        let mut plain = Command::new("fake-agy");
        Login::Primary.apply(&mut plain);
        assert_eq!(plain.as_std().get_envs().count(), 0, "the default sign-in's launch is unchanged");
        assert!(Login::Primary.env().is_empty());
    }

    /// The isolation guard compares the accounts the silent checks name.
    #[test]
    fn agy_profile_check_identity_and_same_account() {
        assert_eq!(check_identity(&output(0, b"Already authenticated as someone@example.invalid\r\n", b"")).as_deref(), Some("someone@example.invalid"));
        assert_eq!(check_identity(&output(0, b"", b"")), None, "the empty reply names nobody");
        assert_eq!(check_identity(&output(1, b"Already authenticated as someone@example.invalid\n", b"")), None);
        assert_eq!(check_identity(&output(0, b"Already authenticated as a\nsecond line\n", b"")), None);
        assert!(same_account("Someone@Example.invalid ", "someone@example.invalid"));
        assert!(!same_account("someone@example.invalid", "other@example.invalid"));
    }

    /// A profile's stamp follows its own token files' metadata (never their
    /// contents); no token file is signed out.
    #[test]
    fn agy_profile_stamp_follows_its_own_token_files() {
        let home = std::env::temp_dir().join(format!("orgtree-agy-profile-{}", crate::util::random_hex(6)));
        assert_eq!(profile_stamp(&home).unwrap(), None, "no folder: signed out");
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::write(home.join(".gemini").join("settings.json"), b"{}").unwrap();
        assert_eq!(profile_stamp(&home).unwrap(), None, "no token file: signed out");
        std::fs::write(home.join(".gemini").join("jetski-standalone-oauth-token"), b"x").unwrap();
        let first = profile_stamp(&home).unwrap().expect("a token file is a credential");
        assert_ne!(first, Stamp(0));
        std::fs::write(home.join(".gemini").join("jetski-standalone-oauth-token"), b"xyz").unwrap();
        assert_ne!(profile_stamp(&home).unwrap(), Some(first), "a replaced token is a new credential");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn agy_profile_not_isolated_latch_round_trips_and_reads_plainly() {
        assert_eq!(serde_json::to_string(&LatchFile::Kind { stamp: Stamp(7), kind: Refusal::NotIsolated }).unwrap(),
            r#"{"stamp":7,"kind":"not_isolated"}"#);
        let back: LatchFile = serde_json::from_slice(br#"{"stamp":7,"kind":"not_isolated"}"#).unwrap();
        assert!(matches!(back, LatchFile::Kind { stamp: Stamp(7), kind: Refusal::NotIsolated }));
        let v = Failure::NotIsolated.reading();
        assert_eq!(v["not_isolated"], true);
        assert!(v.get("reauth_required").is_none(), "not isolated is not a sign-out");
        assert!(Failure::NotIsolated.to_string().contains("same Google account"));
    }
}

