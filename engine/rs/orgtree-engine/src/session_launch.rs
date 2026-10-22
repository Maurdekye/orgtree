//! The engine's launcher in the operator's signed-in session (docket
//! after-an-update-or-engine-restart-while-the-user; user and coordinator
//! rulings 2026-10-21). While the operator is signed in at the console, a
//! restart or an update starts the engine (and with it the mail hub) in their
//! session, never in Session 0:
//!
//! - `session-launch signin`: the "Orgtree User Session Engine" task's
//!   command (through the broker's windowless `session-engine`). Windows
//!   starts it in the operator's session with the task's run level, highest
//!   while "Run as admin" is on, so no prompt is ever shown. The desktop, the
//!   boot host and the task's logon trigger run it.
//! - `session-launch prepare <request>`: the one-off "Run this session as
//!   admin", started by the desktop through one UAC prompt.
//!
//! Either one hands the engine over itself: it takes the handover lock, asks
//! the running engine for a bounded native admission, stops it the graceful
//! way and waits until its tree has released the data root, then hosts the
//! new engine here (`host::run_in_session`). Every step before the stop leaves
//! the old engine untouched. A replacement that fails after the stop records
//! the failure and runs the boot task once: its host makes the one rollback
//! into Session 0 (src/boot_supervisor.rs). The data root and UI folder are
//! the fixed ones the boot host uses; nothing in a request can move them.
use std::{io::Read, path::{Path, PathBuf}, process::ExitCode, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::core_process::{Identity, Life};
use crate::session_handover::{self as handover, why, Phase, Record};

/// How long a launcher waits for an attempt already running.
const LOCK_WAIT: Duration = Duration::from_secs(200);
/// The old engine's graceful stop: its agents' CLIs end first. Inside the
/// admission's 180 s allowance, so the new engine can still take it over.
const STOP_WAIT: Duration = Duration::from_secs(150);
/// A dead engine's tree that still holds the data root.
const RELEASE_WAIT: Duration = Duration::from_secs(30);
/// The desktop's or the boot host's ask, read once and only while fresh.
const ASK: &str = "session-launch-request.json";
const ASK_FRESH_MS: i64 = 120_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    pub session: Option<u32>,
    pub console: Option<u32>,
    pub owns_console: bool,
    pub known: bool,
    pub operator_sid: Option<String>,
    pub elevated: bool,
}

#[nolog]
pub(crate) fn context() -> Context {
    let (operator_sid, elevated) = crate::host::launch_identity();
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let mut id = 0;
        let session = (unsafe { ProcessIdToSessionId(std::process::id(), &mut id) } != 0).then_some(id);
        let console = console_session();
        let sessions = crate::core_process::Sessions::new().and_then(|mut s| s.read());
        let owns_console = console.is_some_and(|c| sessions.as_ref().is_some_and(|rows| rows.iter().any(|s| s.id == c)));
        let known = session.is_some() && sessions.is_some() && operator_sid.is_some();
        Context { session, console, owns_console, known, operator_sid, elevated }
    }
    #[cfg(not(windows))]
    Context { session: None, console: None, owns_console: false, known: false, operator_sid, elevated }
}

/// The active console session, if a user session holds it.
#[nolog]
pub(crate) fn console_session() -> Option<u32> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
        let console = unsafe { WTSGetActiveConsoleSessionId() };
        (console != u32::MAX && console != 0).then_some(console)
    }
    #[cfg(not(windows))]
    None
}

/// This process runs in the operator's own signed-in console session.
#[nolog]
fn at_console(here: &Context) -> bool {
    here.known && here.session.is_some_and(|s| s != 0) && here.session == here.console && here.owns_console
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    nonce: String,
    session: u32,
    operator_sid: String,
    parent: Identity,
    data_root: PathBuf,
    ui_directory: PathBuf,
    admin: bool,
}

/// `root` is the fixed data root this launcher serves: the desktop's request
/// must name the same folder (a desktop on another folder cannot use the
/// one-off button), and only for the installation's own UI.
#[nolog]
fn validate(request: &Request, here: &Context, parent: Life, root: &Path) -> Result<(), &'static str> {
    if request.nonce.len() != 64 || !request.nonce.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid request nonce"); }
    if !here.known || request.session == 0 || here.session != Some(request.session) || here.console != Some(request.session) || !here.owns_console {
        return Err(why::NOT_CONSOLE);
    }
    if here.operator_sid.as_deref() != Some(request.operator_sid.as_str()) { return Err("the elevated launcher belongs to a different operator"); }
    if request.admin && !here.elevated { return Err("administrator launch was not elevated"); }
    if parent != Life::Alive { return Err("the requesting desktop identity is no longer live"); }
    if !request.data_root.is_absolute() || !request.ui_directory.is_absolute() || !request.ui_directory.join("index.html").is_file()
        || crate::host::canon(&request.data_root) != crate::host::canon(root) {
        return Err("invalid launch paths");
    }
    Ok(())
}

#[nolog]
fn read_request(file: &Path) -> Result<Request, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(file).map_err(|_| "cannot read launch request")?.take(16385)
        .read_to_end(&mut bytes).map_err(|_| "cannot read launch request")?;
    if bytes.len() > 16384 { return Err("launch request is too large".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "invalid launch request".into())
}

#[nolog]
fn write_receipt(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    let temp = dir.join(format!("{name}.tmp"));
    std::fs::write(&temp, value.to_string()).map_err(|_| "cannot write launcher receipt")?;
    std::fs::rename(temp, dir.join(name)).map_err(|_| "cannot publish launcher receipt".into())
}

/// What the desktop or the boot host asks of the next `signin` before it
/// runs the task: who asks, and whether an engine already in place restarts.
/// Fixed words only; the elevated task never takes a path from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ask {
    pub by: String,
    pub restart: bool,
    pub at_ms: i64,
}

#[nolog]
pub(crate) fn write_ask(root: &Path, by: &str, restart: bool) {
    let ask = Ask { by: by.into(), restart, at_ms: crate::core_state::now() };
    if let Ok(bytes) = serde_json::to_vec(&ask) { let _ = crate::core_state::write_file(root, ASK, &bytes); }
}

/// Read and remove the ask: honoured once, only while fresh, only fixed words.
#[nolog]
fn take_ask(root: &Path) -> Option<Ask> {
    let path = root.join(ASK);
    let mut bytes = Vec::new();
    let read = std::fs::File::open(&path).ok().and_then(|f| f.take(4097).read_to_end(&mut bytes).ok());
    let _ = std::fs::remove_file(&path);
    read?;
    let ask: Ask = serde_json::from_slice(&bytes).ok()?;
    let fresh = crate::core_state::now().saturating_sub(ask.at_ms) <= ASK_FRESH_MS;
    (fresh && matches!(ask.by.as_str(), "desktop" | "boot-host")).then_some(ask)
}

/// The engine that serves the data root now, as its identity answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Current {
    pub session: Option<u32>,
    pub elevated: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// The engine already runs in this session with these rights.
    Nothing,
    /// No engine runs: start one here.
    Start,
    /// Hand the running engine over: stop it gracefully, then start here.
    Replace,
}

/// A launch (sign-in, desktop start, the boot host's delegation) moves an
/// engine that runs elsewhere or with other rights, and starts one when none
/// runs; only an explicit restart replaces an engine already in place.
#[nolog]
pub(crate) fn plan(current: Option<Current>, session: u32, elevated: bool, restart: bool) -> Plan {
    match current {
        None => Plan::Start,
        Some(c) if c.session == Some(session) && c.elevated == Some(elevated) && !restart => Plan::Nothing,
        Some(_) => Plan::Replace,
    }
}

/// The engine behind the attach descriptor, if it answers as this root.
struct Serving {
    at: Current,
    port: u16,
    token: String,
    engine: Identity,
    generation: String,
}

#[nolog]
fn serving(root: &Path) -> Option<Serving> {
    let d = crate::host::read_descriptor(root)?;
    let port = d["port"].as_u64().filter(|p| (1..=65535).contains(p))? as u16;
    let token = d["token"].as_str()?.to_string();
    let pid = d["enginePid"].as_u64().and_then(|p| u32::try_from(p).ok())?;
    let a = crate::host::http(port, "GET", "/api/desktop/identity", &token, Duration::from_secs(4)).ok()?;
    let same = a.status == 200 && a.body["protocol"] == json!(1) && a.body["pid"] == json!(pid)
        && a.body["dataRootId"].as_str().is_some_and(|r| crate::host::canon(Path::new(r)) == crate::host::canon(root));
    if !same { return None; }
    Some(Serving {
        at: Current { session: a.body["session"].as_u64().and_then(|s| u32::try_from(s).ok()), elevated: a.body["elevated"].as_bool() },
        port, token, engine: crate::core_process::identity(pid)?, generation: a.body["generation"].as_str()?.to_string(),
    })
}

#[nolog]
fn admission(port: u16, token: &str, generation: &str, who: &Identity, action: handover::Action) -> bool {
    let Ok(body) = serde_json::to_value(handover::Admission { generation: generation.into(), who: who.clone(), action }) else { return false };
    crate::host::http_body(port, "POST", "/api/desktop/session-handover", token, Some(&body), Duration::from_secs(10))
        .is_ok_and(|a| a.status == 200 && a.body["ok"] == json!(true))
}

/// Write the attempt record, trying again briefly when the atomic replace
/// fails (a reader may hold the file without delete sharing): the error, if
/// it still fails, for the caller to act on.
#[nolog]
fn record_attempt(root: &Path, record: &Record) -> std::io::Result<()> {
    let mut result = handover::write(root, record);
    for wait in [100, 200, 400] {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(wait));
        result = handover::write(root, record);
    }
    result
}

/// The old engine is gone and its tree has released the data root.
#[nolog]
fn stopped(root: &Path, engine: &Identity, within: Duration) -> bool {
    let until = Instant::now() + within;
    loop {
        if crate::core_process::life(engine) == Life::Gone && crate::host::root_released(root, Duration::ZERO) { return true; }
        if Instant::now() >= until { return false; }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Run a task by name: in a debug rig run, the proof's stand-in command
/// (`rig-<file>.json`: exe, args, env); otherwise Task Scheduler.
#[nolog]
pub(crate) fn run_task(root: &Path, task: &str, rig_file: &str) -> bool {
    if crate::core_state::rig_root(root) {
        return rig_task(root, rig_file).is_some_and(|mut cmd| cmd.spawn().is_ok());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let schtasks = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32").join("schtasks.exe");
        std::process::Command::new(schtasks).args(["/Run", "/TN", &format!("\\{task}")])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000).status().is_ok_and(|s| s.success())
    }
    #[cfg(not(windows))]
    { let _ = task; false }
}

/// Whether a task can be run: the rig's stand-in exists, or Task Scheduler knows it.
#[nolog]
pub(crate) fn task_installed(root: &Path, task: &str, rig_file: &str) -> bool {
    if crate::core_state::rig_root(root) { return root.join(format!("rig-{rig_file}.json")).is_file(); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let schtasks = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32").join("schtasks.exe");
        std::process::Command::new(schtasks).args(["/Query", "/TN", &format!("\\{task}")])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000).status().is_ok_and(|s| s.success())
    }
    #[cfg(not(windows))]
    { let _ = task; false }
}

/// A rig proof's stand-in for a scheduled task: its own command, started
/// detached with this process's environment plus the file's.
#[nolog]
fn rig_task(root: &Path, rig_file: &str) -> Option<std::process::Command> {
    let mut bytes = Vec::new();
    std::fs::File::open(root.join(format!("rig-{rig_file}.json"))).ok()?.take(65537).read_to_end(&mut bytes).ok()?;
    let spec: Value = serde_json::from_slice(&bytes).ok()?;
    let mut cmd = std::process::Command::new(spec["exe"].as_str()?);
    for arg in spec["args"].as_array()? { cmd.arg(arg.as_str()?); }
    if let Some(env) = spec["env"].as_object() {
        for (k, v) in env { cmd.env(k, v.as_str()?); }
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // no window and its own group; it stays in the proof's job, so the
        // proof's cleanup still reaches it
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    Some(cmd)
}

pub(crate) const USER_SESSION_TASK: &str = "Orgtree User Session Engine";
pub(crate) const BOOT_TASK: &str = "Orgtree Background Engine";

/// The handover and the host in this session. `by` is who asked (fixed
/// words), `admin` the rights this launcher's engine keeps, `restart` whether
/// an engine already in place is replaced, `receipts` the one-off's folder.
#[nolog]
fn launch(root: &Path, by: &str, session: u32, admin: bool, restart: bool, receipts: Option<&Path>) -> ExitCode {
    let say = |m: &str| crate::host::say(Some(root), &format!("session launch ({by}): {m}"));
    let receipt = |name: &str, value: Value| { if let Some(dir) = receipts { let _ = write_receipt(dir, name, &value); } };
    let Some(me) = crate::core_process::identity(std::process::id()) else {
        say("cannot stamp this launcher; nothing changed");
        receipt("error.json", json!({"error": "cannot stamp launcher identity"}));
        return ExitCode::from(1);
    };
    let Some(lock) = handover::lock_within(root, LOCK_WAIT) else {
        say("another start in the signed-in session is still running; leaving it to finish");
        receipt("error.json", json!({"error": "another start in the signed-in session is still running"}));
        return ExitCode::SUCCESS;
    };
    let current = serving(root);
    let planned = plan(current.as_ref().map(|s| s.at), session, admin, restart);
    if planned == Plan::Nothing {
        say("the engine already runs in this session with these rights");
        receipt("done.json", json!({"unchanged": true}));
        return ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    let epoch = crate::core_process::Sessions::new().and_then(|mut s| s.read()).unwrap_or_default();
    #[cfg(not(windows))]
    let epoch = Vec::new();
    let mut record = Record { id: crate::util::random_hex(16), phase: Phase::Begun, by: by.into(), owner: me.clone(), session,
        admin, stopped_old: false, at_ms: crate::core_state::now(), epoch, error: None, rollback: None, reported: None };
    // The boot host's rollback and the desktop's wait read this record, so a
    // write that fails is never only a log line (save says so and answers false).
    let save = |r: &Record| match record_attempt(root, r) {
        Ok(()) => true,
        Err(e) => {
            crate::host::say(Some(root), &format!("session launch: could not record the attempt ({:?}): {e}", r.phase));
            false
        }
    };
    let fail = |record: &mut Record, error: &'static str| {
        record.phase = Phase::Failed;
        record.error = Some(error.into());
        let recorded = save(record);
        crate::host::say(Some(root), &format!("session launch ({by}): {error}"));
        if !recorded && record.stopped_old {
            crate::host::say(Some(root), "session launch: the boot host cannot read this failure, so its 120 s backstop recovers the engine instead of the immediate rollback");
        }
        receipt("error.json", json!({"error": error, "stoppedOld": record.stopped_old, "recorded": recorded}));
    };
    // Nothing is stopped before the attempt is on disk: the old engine stays
    // as it is (decision 93: a failure before the stop leaves it untouched).
    if !save(&record) {
        fail(&mut record, why::UNRECORDED);
        return ExitCode::from(1);
    }
    match (planned, &current) {
        (Plan::Replace, Some(old)) => {
            record.phase = Phase::Stopping;
            if !save(&record) {
                fail(&mut record, why::UNRECORDED);
                return ExitCode::from(1);
            }
            if !admission(old.port, &old.token, &old.generation, &me, handover::Action::Begin) {
                fail(&mut record, why::REFUSED);
                return ExitCode::from(1);
            }
            say(&format!("handing over the engine (pid {}, session {:?})", old.engine.pid, old.at.session));
            let _ = crate::host::http(old.port, "POST", "/api/desktop/shutdown", &old.token, Duration::from_secs(5));
            if !stopped(root, &old.engine, STOP_WAIT) {
                record.stopped_old = crate::core_process::life(&old.engine) == Life::Gone;
                if !record.stopped_old { let _ = admission(old.port, &old.token, &old.generation, &me, handover::Action::Cancel); }
                fail(&mut record, why::NOT_STOPPED);
                drop(lock);
                if record.stopped_old { rollback(root, &record); }
                return ExitCode::from(1);
            }
            record.stopped_old = true;
        }
        _ => {
            if !crate::host::root_released(root, RELEASE_WAIT) {
                fail(&mut record, why::NOT_STOPPED);
                return ExitCode::from(1);
            }
        }
    }
    record.phase = Phase::Starting;
    if !save(&record) {
        say("starting the engine anyway: the old one is stopped, and until a later record lands the boot host and the desktop see the previous phase");
    }
    say(&format!("starting the engine in this session (admin: {admin})"));
    let mut lock = Some(lock);
    let mut became_ready = false;
    let code = crate::host::run_in_session(admin, &mut |ready| {
        if became_ready { return; }
        became_ready = true;
        // The new engine copied the admission from the old snapshot; end it.
        if let Some(generation) = crate::host::http(ready.port, "GET", "/api/desktop/identity", ready.token, Duration::from_secs(4)).ok()
            .and_then(|a| a.body["generation"].as_str().map(String::from)) {
            let _ = admission(ready.port, ready.token, &generation, &me, handover::Action::Complete);
        }
        record.phase = Phase::Ready;
        let recorded = save(&record);
        receipt("done.json", json!({"enginePid": ready.pid, "recorded": recorded}));
        crate::host::say(Some(root), &format!("session launch ({by}): the engine is ready in this session (pid {})", ready.pid));
        lock.take();
    });
    if !became_ready {
        fail(&mut record, why::NOT_READY);
        drop(lock);
        if record.stopped_old { rollback(root, &record); }
    }
    code
}

/// After the stop the old engine cannot come back by itself: run the boot
/// task once. Its host makes the one rollback (a host already running sees
/// the record; Task Scheduler ignores the extra run).
#[nolog]
fn rollback(root: &Path, record: &Record) {
    let ran = run_task(root, BOOT_TASK, "boot-task");
    crate::host::say(Some(root), &format!("session launch: {} the boot task for the one rollback into Session 0 (attempt {})",
        if ran { "ran" } else { "could not run" }, record.id));
}

#[nolog]
fn signin() -> ExitCode {
    let root = match crate::host::data_root() { Ok(r) => r, Err(e) => { crate::host::say(None, &e); return ExitCode::from(1); } };
    let here = context();
    if !at_console(&here) {
        crate::host::say(Some(&root), &format!("session launch: {}; nothing started", why::NOT_CONSOLE));
        return ExitCode::from(1);
    }
    let ask = take_ask(&root);
    let by = ask.as_ref().map_or("sign-in", |a| if a.by == "boot-host" { "boot-host" } else { "desktop" });
    launch(&root, by, here.session.unwrap_or(0), here.elevated, ask.is_some_and(|a| a.restart), None)
}

/// The one-off "Run this session as admin": a rig run may stand in for the
/// UAC prompt with ORGTREE_RIG_FAKE_ELEVATED=1 on its own root only.
#[nolog]
fn prepared(file: &Path) -> Result<ExitCode, String> {
    let request = read_request(file)?;
    let dir = file.parent().ok_or("request has no parent directory")?;
    let root = crate::host::data_root()?;
    let mut here = context();
    if crate::core_state::rig_root(&root) && std::env::var("ORGTREE_RIG_FAKE_ELEVATED").as_deref() == Ok("1") { here.elevated = true; }
    validate(&request, &here, crate::core_process::life(&request.parent), &root)?;
    let own = crate::core_process::identity(std::process::id()).ok_or("cannot stamp launcher identity")?;
    write_receipt(dir, "ready.json", &json!({"nonce": request.nonce, "identity": own, "session": request.session, "admin": request.admin}))?;
    Ok(launch(&root, "one-off", request.session, request.admin, true, Some(dir)))
}

#[nolog]
pub fn cli(args: &[String]) -> ExitCode {
    if args.first().map(String::as_str) == Some("inspect") && args.len() <= 2 {
        let mut value = serde_json::to_value(context()).unwrap();
        if let Some(pid) = args.get(1).and_then(|v| v.parse::<u32>().ok()) {
            value["parent"] = serde_json::json!(crate::core_process::identity(pid));
        }
        println!("{value}");
        return ExitCode::SUCCESS;
    }
    if args.first().map(String::as_str) == Some("signin") && args.len() == 1 {
        return signin();
    }
    if args.first().map(String::as_str) == Some("prepare") && args.len() == 2 {
        let file = Path::new(&args[1]);
        match prepared(file) {
            Ok(code) => return code,
            Err(error) => {
                if let Some(dir) = file.parent() { let _ = write_receipt(dir, "error.json", &serde_json::json!({"error":error})); }
                eprintln!("session launch refused: {error}");
                return ExitCode::from(1);
            }
        }
    }
    eprintln!("usage: session-launch inspect [pid] | signin | prepare <request.json>");
    ExitCode::from(2)
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    const HERE: u32 = 1;
    fn at(session: Option<u32>, elevated: Option<bool>) -> Option<Current> { Some(Current { session, elevated }) }

    #[test]
    fn nothing_running_starts_one() {
        assert_eq!(plan(None, HERE, false, false), Plan::Start);
        assert_eq!(plan(None, HERE, true, true), Plan::Start);
    }

    #[test]
    fn an_engine_elsewhere_or_with_other_rights_is_handed_over() {
        assert_eq!(plan(at(Some(0), Some(false)), HERE, false, false), Plan::Replace, "the Session 0 engine moves up");
        assert_eq!(plan(at(Some(2), Some(false)), HERE, false, false), Plan::Replace);
        assert_eq!(plan(at(Some(HERE), Some(false)), HERE, true, false), Plan::Replace, "Run as admin: elevate in place");
        assert_eq!(plan(at(Some(HERE), Some(true)), HERE, false, false), Plan::Replace, "toggle off: drop the rights");
        assert_eq!(plan(at(None, Some(false)), HERE, false, false), Plan::Replace, "an unknown session is not this one");
        assert_eq!(plan(at(Some(HERE), None), HERE, false, false), Plan::Replace, "unknown rights are not these");
    }

    #[test]
    fn an_engine_already_in_place_is_kept_unless_a_restart_was_asked_for() {
        assert_eq!(plan(at(Some(HERE), Some(false)), HERE, false, false), Plan::Nothing,
            "a second launch racing the first, or a sign-in start that found its engine");
        assert_eq!(plan(at(Some(HERE), Some(true)), HERE, true, false), Plan::Nothing);
        assert_eq!(plan(at(Some(HERE), Some(false)), HERE, false, true), Plan::Replace, "the user asked to restart");
    }

    #[test]
    fn the_ask_is_taken_once_and_only_while_fresh() {
        let dir = std::env::temp_dir().join(format!("orgtree-ask-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        write_ask(&dir, "desktop", true);
        assert_eq!(take_ask(&dir).map(|a| (a.by, a.restart)), Some(("desktop".into(), true)));
        assert_eq!(take_ask(&dir), None, "taken once");
        let stale = Ask { by: "desktop".into(), restart: true, at_ms: crate::core_state::now() - ASK_FRESH_MS - 1 };
        std::fs::write(dir.join(ASK), serde_json::to_vec(&stale).unwrap()).unwrap();
        assert_eq!(take_ask(&dir), None, "an old ask is not a restart now");
        assert!(!dir.join(ASK).exists(), "and is removed");
        std::fs::write(dir.join(ASK), br#"{"by":"C:\\elsewhere","restart":true,"atMs":0}"#).unwrap();
        assert_eq!(take_ask(&dir), None, "only fixed words");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Request, Context) {
        (Request { nonce:"a".repeat(64), session:7, operator_sid:"operator".into(), parent:Identity {pid:42,created:"123".into()},
            data_root:PathBuf::from("relative"), ui_directory:PathBuf::from("relative"), admin:true },
         Context {session:Some(7),console:Some(7),owns_console:true,known:true,operator_sid:Some("operator".into()),elevated:true})
    }
    fn root() -> PathBuf { std::env::temp_dir() }
    #[test] fn no_console_refuses() { let (r,mut c)=fixture();c.console=None;assert!(validate(&r,&c,Life::Alive,&root()).unwrap_err().contains("console")); }
    #[test] fn unknown_session_probe_refuses() { let (r,mut c)=fixture();c.known=false;assert!(validate(&r,&c,Life::Alive,&root()).unwrap_err().contains("console")); }
    #[test] fn other_operator_refuses() { let (r,mut c)=fixture();c.operator_sid=Some("other".into());assert!(validate(&r,&c,Life::Alive,&root()).unwrap_err().contains("different operator")); }
    #[test] fn absent_elevation_refuses() { let (r,mut c)=fixture();c.elevated=false;assert!(validate(&r,&c,Life::Alive,&root()).unwrap_err().contains("not elevated")); }
    #[test] fn reused_or_unknown_parent_refuses() { let (r,c)=fixture();for life in [Life::Gone,Life::Unknown] {assert!(validate(&r,&c,life,&root()).unwrap_err().contains("desktop identity"));} }
    #[test] fn malformed_nonce_refuses() { let (mut r,c)=fixture();r.nonce="x".repeat(64);assert!(validate(&r,&c,Life::Alive,&root()).unwrap_err().contains("nonce")); }
    #[test] fn no_path_or_ui_validation_bypass() { let (r,c)=fixture();assert_eq!(validate(&r,&c,Life::Alive,&root()),Err("invalid launch paths")); }
    #[test] fn only_the_fixed_data_root_is_served() {
        let ui = std::env::temp_dir().join(format!("orgtree-ui-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
        let (mut r,c)=fixture(); r.ui_directory=ui.clone();
        r.data_root=ui.join("elsewhere");
        assert_eq!(validate(&r,&c,Life::Alive,&root()),Err("invalid launch paths"), "a request cannot move the elevated engine's data");
        r.data_root=root();
        assert_eq!(validate(&r,&c,Life::Alive,&root()),Ok(()));
        std::fs::remove_dir_all(ui).unwrap();
    }

    /// A record a reader holds without delete sharing cannot be replaced: an
    /// error for the launcher to act on, after the short retry; released, it
    /// lands and reads back.
    #[cfg(windows)]
    #[test]
    fn an_unwritable_record_is_an_error_the_launcher_sees() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("orgtree-record-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(handover::RECORD), "{}").unwrap();
        // FILE_SHARE_READ only: no delete (replace) sharing
        let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(dir.join(handover::RECORD)).unwrap();
        let record = Record { id: "d".repeat(32), phase: Phase::Begun, by: "desktop".into(), owner: Identity { pid: 30, created: "300".into() },
            session: 1, admin: false, stopped_old: false, at_ms: 5_000, epoch: Vec::new(), error: None, rollback: None, reported: None };
        let started = Instant::now();
        assert!(record_attempt(&dir, &record).is_err(), "the held record was replaced");
        assert!(started.elapsed() >= Duration::from_millis(700), "it tried again before giving up");
        drop(held);
        record_attempt(&dir, &record).expect("the released record is written");
        assert_eq!(handover::read(&dir).map(|r| r.id), Some(record.id.clone()));
        std::fs::remove_dir_all(dir).ok();
    }
}
