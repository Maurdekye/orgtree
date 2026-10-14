//! Background AGY authentication. Credential metadata is a change detector,
//! never proof of validity. Only the CLI's silent, zero-argument check validates.
//! The check/use race remains: a later OAuth attempt is killed and latched.
//! A clean silent refusal is revalidated silently (check mode only): on a
//! user's forced read and on a bounded cadence, because a token refreshed in
//! place by the user's own AGY keeps the credential metadata unchanged.

use std::{path::Path, process::{Output, Stdio}, sync::Mutex, time::{Duration, SystemTime}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use futures::future::BoxFuture;
use tokio::{io::AsyncReadExt, process::Command};
use crate::engine::Engine;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp(pub u64);

/// How a credential came to be latched. `Refused` is the measured clean
/// signed-out answer of the silent check (non-zero exit, no output): safe to
/// ask again silently. `Untrusted` is an auth prompt or output the check is
/// not known to produce: never re-run until the credential itself changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal { Refused, Untrusted }

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
}

#[derive(Debug, Clone, Copy)]
pub enum Failure { SignedOut, Unavailable, Timeout, OutputLimit }
impl std::fmt::Display for Failure {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SignedOut => "Antigravity is signed out or its sign-in could not be validated; sign in through Antigravity",
            Self::Unavailable => "Antigravity authentication could not be checked",
            Self::Timeout => "Antigravity background command timed out",
            Self::OutputLimit => "Antigravity background output exceeded its limit",
        })
    }
}
impl std::error::Error for Failure {}
impl Failure {
    #[nolog]
    pub fn reading(self) -> Value {
        let mut v = json!({"available":false,"error":self.to_string(),"provider":"google","account":"google/primary"});
        if matches!(self, Self::SignedOut) {
            v["reauth_required"] = json!(true);
            v["reauth_evidence"] = json!("not_connected");
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

#[nolog]
fn latch_path(engine: &Engine) -> std::path::PathBuf {
    engine.cfg.path("diagnostics").join("agy-auth-latch.json")
}

/// The latch for this exact credential: its kind and when it was written.
/// The persisted file (and its modification time) wins over memory.
#[nolog]
fn latch_of(engine: &Engine, stamp: Stamp) -> Option<(Refusal, SystemTime)> {
    let path = latch_path(engine);
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
    match *engine.providers.agy_auth.refused.lock().unwrap_or_else(|p| p.into_inner()) {
        Some((s, kind, at)) if s == stamp => Some((kind, at)),
        _ => None,
    }
}

#[nolog]
fn latched(engine: &Engine, stamp: Stamp) -> bool {
    let Some((kind, at)) = latch_of(engine, stamp) else { return false };
    let age = at.elapsed().unwrap_or_default();
    if !cfg!(windows) && !crate::rig::active() {
        // No verified metadata detector on this platform. Revalidate silently
        // at most every five minutes; never allow the actual command first.
        return age < CADENCE_RECHECK;
    }
    if kind == Refusal::Untrusted { return true; }
    let forced: Option<SystemTime> = *engine.providers.agy_auth.forced.lock().unwrap_or_else(|p| p.into_inner());
    let forced = forced.is_some_and(|t| t > at);
    !(age >= CADENCE_RECHECK || (forced && age >= FORCED_RECHECK))
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
    let failure = match metadata(engine) {
        Ok(None) => Some(Failure::SignedOut),
        Ok(Some(stamp)) if latched(engine, stamp) => Some(Failure::SignedOut),
        Ok(Some(_)) => None,
        Err(e) => Some(e),
    };
    if failure.is_some() { connected(engine, false); }
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
    // An old process must not latch a different login that just replaced it.
    if metadata(engine).ok().flatten() != Some(stamp) { return; }
    *engine.providers.agy_auth.refused.lock().unwrap_or_else(|p| p.into_inner()) = Some((stamp, kind, SystemTime::now()));
    // The file contains only last-write metadata and the refusal kind, never
    // a token, prompt or account name.
    let path = latch_path(engine);
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(bytes) = serde_json::to_vec(&LatchFile::Kind { stamp, kind }) {
        if std::fs::write(path, bytes).is_err() { tracing::error!("could not persist AGY auth latch"); }
    }
    connected(engine, false);
    crate::usage::record_agy_auth_failure(engine, Failure::SignedOut.reading());
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

#[nolog]
async fn capture_inner(mut cmd: Command, timeout: Duration) -> Result<Output, Failure> {
    let mut child = cmd.spawn().map_err(|_| Failure::Unavailable)?;
    let job = crate::winproc::child_job(&child);
    drop(child.stdin.take());
    let stdout = child.stdout.take().ok_or(Failure::Unavailable)?;
    let stderr = child.stderr.take().ok_or(Failure::Unavailable)?;
    async fn read(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, Failure> {
        let mut all = Vec::new();
        let mut buf = vec![0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.map_err(|_| Failure::Unavailable)?;
            if n == 0 { return Ok(all); }
            all.extend_from_slice(&buf[..n]);
            // Scan each line (including an unfinished prompt with no newline).
            if all.split(|b| *b == b'\n').any(auth_prompt) { return Err(Failure::SignedOut); }
            if all.len() > 4 * 1024 * 1024 { return Err(Failure::OutputLimit); }
        }
    }
    let result = tokio::time::timeout(timeout, async {
        let (stdout, stderr, status) = tokio::try_join!(read(stdout), read(stderr), async {
            child.wait().await.map_err(|_| Failure::Unavailable)
        })?;
        Ok(Output { status, stdout, stderr })
    }).await.unwrap_or(Err(Failure::Timeout));
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

#[nolog]
pub fn preflight<'a>(engine: &'a Engine, exe: &'a Path) -> BoxFuture<'a, Result<Stamp, Failure>> {
    // A concrete async state propagates through ensure_agy/start_turn and the
    // actor's select branches. Keep this boundary heap-owned and type-erased:
    // otherwise its nested pipe readers multiply the debug actor stack frame.
    Box::pin(preflight_inner(engine, exe))
}

#[nolog]
async fn preflight_inner(engine: &Engine, exe: &Path) -> Result<Stamp, Failure> {
    let _check = engine.providers.agy_auth.check.lock().await;
    let stamp = match metadata(engine) {
        Ok(Some(s)) => s,
        Ok(None) => { connected(engine, false); return Err(Failure::SignedOut); }
        Err(e) => return Err(e),
    };
    if latched(engine, stamp) { return Err(Failure::SignedOut); }
    // IMPORTANT: no args. With any args AGY skips CDE_AUTH_ACTION entirely.
    let mut cmd = Command::new(exe);
    configure(&mut cmd);
    cmd.env("AGY_CLI_CDE_AUTH_ACTION", "check");
    for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH"] { cmd.env_remove(key); }
    let result = capture(cmd, Duration::from_secs(8)).await;
    match result {
        Ok(output) if check_passed(&output) => {
            // A credential changed while checking: don't authorize the old result.
            if metadata(engine)? != Some(stamp) { return Err(Failure::Unavailable); }
            if cfg!(windows) && latched(engine, stamp) { return Err(Failure::SignedOut); }
            *engine.providers.agy_auth.refused.lock().unwrap_or_else(|p| p.into_inner()) = None;
            let _ = std::fs::remove_file(latch_path(engine));
            connected(engine, true);
            Ok(stamp)
        }
        // The measured clean signed-out answer: non-zero exit, no output.
        Ok(output) if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() => {
            refuse(engine, stamp, Refusal::Refused); Err(Failure::SignedOut)
        }
        Ok(_) | Err(Failure::SignedOut) => { refuse(engine, stamp, Refusal::Untrusted); Err(Failure::SignedOut) }
        Err(e) => Err(e),
    }
}

#[nolog]
pub fn checked_output<'a>(engine: &'a Engine, exe: &'a Path, cmd: Command, timeout: Duration) -> BoxFuture<'a, Result<Output, Failure>> {
    Box::pin(checked_output_inner(engine, exe, cmd, timeout))
}

#[nolog]
async fn checked_output_inner(engine: &Engine, exe: &Path, mut cmd: Command, timeout: Duration) -> Result<Output, Failure> {
    let stamp = preflight(engine, exe).await?;
    configure(&mut cmd);
    // Recheck the latch/metadata at the launch edge as another caller may have
    // observed auth failure while this caller was awaiting its silent check.
    if metadata(engine)? != Some(stamp) { return Err(Failure::Unavailable); }
    if latched(engine, stamp) { return Err(Failure::SignedOut); }
    let result = capture(cmd, timeout).await;
    if matches!(result, Err(Failure::SignedOut)) { refuse(engine, stamp, Refusal::Untrusted); }
    result
}

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
}
