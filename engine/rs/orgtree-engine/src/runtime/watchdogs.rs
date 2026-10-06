//! Watchdog runners: one task per armed watchdog. A runner checks its target
//! (a file, a command, a pid or port, a long-running stream, or an agent's
//! turns and tool calls), mails the owner on a match (or on silence), and
//! keeps its progress in the row so it survives restarts. Runners are found
//! through lock-free maps: pausing or removing a watchdog cancels its token,
//! and activity dogs listen on a per-agent fan-out the actor publishes to.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::domain::scope;
use crate::engine::Engine;
use crate::refuse;
use crate::util::{gist, iso, uid};

pub const MAX_PER_AGENT: i64 = 8;
pub const MAX_PER_ORG: i64 = 32;
/// The pause an archive writes and a rehire undoes.
pub const ARCHIVE_PAUSE: &str = "its owner was archived";
const NOT_BELOW: &str = "its activity target is no longer itself or a descendant";
const FLOOR_S: i64 = 15;
const STREAM_FLOOR_S: i64 = 5;
const COMMAND_TIMEOUT_S: u64 = 60;
const SMOKE_TIMEOUT_S: u64 = 8;
const EVENTS_KEEP: i64 = 50;
const OUT_KEEP: usize = 400;
const QUIET_CHECKS: i64 = 20;
const QUIET_AGE_S: i64 = 2 * 3600;
const NEVER_RAN_AGE_S: i64 = 300;
const STALE_CHECKS: i64 = 60;
const STALE_AGE_S: i64 = 3600;
const BROKEN_STREAK: i64 = 3;
const SPENT_CHECKS: i64 = 20;
const SHELL_ERRORS: &[&str] = &[
    "is not recognized as an internal or external command",
    "is not recognized as the name of a cmdlet",
    "command not found",
    "no such file or directory",
];

type ActivityTx = UnboundedSender<(String, DateTime<Utc>)>;

/// The running watchdogs: each runner's cancellation token, and the
/// activity dogs listening to each agent.
#[derive(Default)]
pub struct Registry {
    runners: papaya::HashMap<String, CancellationToken>,
    activity: papaya::HashMap<i64, papaya::HashMap<String, ActivityTx>>,
}

#[derive(Debug, Clone)]
struct Dog {
    uid: String,
    org_id: i64,
    owner: i64,
    owner_name: String,
    owner_live: bool,
    workdir: Option<String>,
    name: String,
    kind: String,
    target: String,
    pattern: Option<String>,
    shell: Option<String>,
    interval_s: i64,
    fire_mode: String,
    quiet_s: Option<i64>,
    once: bool,
    state: String,
    fired: i64,
    created_at: DateTime<Utc>,
    last_fired: Option<DateTime<Utc>>,
    silence_since: Option<DateTime<Utc>>,
    exit: Option<Value>,
    memo: Value,
    /// the runner's own progress (`memo.run`): offsets, counters, last output
    run: Value,
}

#[logged]
impl Dog {
    #[nolog]
    fn silence(&self) -> bool {
        self.fire_mode == "silence"
    }

    #[nolog]
    fn notice(&self) -> bool {
        self.memo["notice"].as_bool().unwrap_or(false)
    }

    fn regex(&self) -> Option<Regex> {
        self.pattern.as_deref().and_then(|p| Regex::new(p).ok())
    }

    /// Seconds until a silence dog is due (zero or less: due now).
    #[nolog]
    fn due_in(&self) -> Option<i64> {
        if !self.silence() {
            return None;
        }
        let quiet = self.quiet_s.unwrap_or(600);
        let since = self.silence_since.unwrap_or(self.created_at);
        Some(quiet - (Utc::now() - since).num_seconds())
    }

    #[nolog]
    fn run_i64(&self, key: &str) -> i64 {
        self.run[key].as_i64().unwrap_or(0)
    }
}

const DOG_COLS: &str = "w.uid, w.org_id, w.owner_agent_id, a.name, a.state = 'live', a.scratch_dir, w.name, w.kind, w.target,
    w.pattern, w.shell, w.interval_s, w.fire_mode, w.quiet_period_s, w.once, w.state, w.fired, w.created_at, w.last_fired,
    w.silence_since, w.exit, w.memo";

fn dog_of(r: &tokio_postgres::Row) -> Dog {
    let memo: Value = r.get(21);
    Dog {
        uid: r.get(0),
        org_id: r.get(1),
        owner: r.get(2),
        owner_name: r.get(3),
        owner_live: r.get(4),
        workdir: r.get(5),
        name: r.get(6),
        kind: r.get(7),
        target: r.get(8),
        pattern: r.get(9),
        shell: r.get(10),
        interval_s: r.get::<_, i32>(11) as i64,
        fire_mode: r.get(12),
        quiet_s: r.get::<_, Option<i32>>(13).map(|q| q as i64),
        once: r.get(14),
        state: r.get(15),
        fired: r.get::<_, i32>(16) as i64,
        created_at: r.get(17),
        last_fired: r.get(18),
        silence_since: r.get(19),
        exit: r.get(20),
        run: memo.get("run").cloned().filter(Value::is_object).unwrap_or_else(|| json!({})),
        memo,
    }
}

#[logged]
async fn load(engine: &Engine, uid: &str) -> Result<Option<Dog>> {
    let client = engine.db.get().await?;
    let sql = format!("SELECT {DOG_COLS} FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id WHERE w.uid = $1");
    Ok(client.query_opt(&sql, &[&uid]).await?.map(|r| dog_of(&r)))
}

// ------------------------------------------------------------ arming

/// Arm every armed watchdog whose owner is live (engine start).
#[logged]
pub async fn start(engine: &Arc<Engine>) {
    let Ok(client) = engine.db.get().await else { return };
    let ids: Vec<String> = client
        .query(
            "SELECT w.uid FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id JOIN ot.orgs o ON o.id = w.org_id
              WHERE w.state = 'armed' AND a.state = 'live' AND o.state <> 'trashed'",
            &[],
        )
        .await
        .map(|rows| rows.iter().map(|r| r.get(0)).collect())
        .unwrap_or_default();
    drop(client);
    for id in ids {
        arm(engine, &id);
    }
}

/// Start the runner for `uid` unless one already runs.
#[logged]
pub fn arm(engine: &Arc<Engine>, uid: &str) {
    if engine.is_stopping() {
        return;
    }
    let token = engine.shutdown.child_token();
    {
        let map = engine.dogs.runners.pin();
        if map.get(uid).map(|t| !t.is_cancelled()).unwrap_or(false) {
            return;
        }
        map.insert(uid.to_string(), token.clone());
    }
    let engine = engine.clone();
    let id = uid.to_string();
    tokio::spawn(tracing::Instrument::instrument(
        async move {
            let r = run(&engine, &id, &token).await;
            if let Err(e) = &r {
                tracing::warn!(watchdog = %id, error = %format!("{e:#}"), "watchdog runner stopped");
            }
            let left_alone = !token.is_cancelled();
            token.cancel();
            // a resume can land while this runner is on its way out
            if r.is_ok() && left_alone && !engine.is_stopping() {
                if let Ok(Some(d)) = load(&engine, &id).await {
                    let dead_stream = d.kind == "stream" && d.exit.is_some() && !d.silence();
                    if d.state == "armed" && d.owner_live && !dead_stream {
                        arm(&engine, &id);
                    }
                }
            }
        },
        crate::trace::request(&format!("dog:{uid}")),
    ));
}

#[logged]
pub fn disarm(engine: &Engine, uid: &str) {
    if let Some(t) = engine.dogs.runners.pin().remove(uid) {
        t.cancel();
    }
}

/// Publish an agent's activity (`turn_started`, `turn_done`, `tool_call NAME`)
/// to the activity dogs watching it. One map lookup when nothing listens.
pub fn activity(engine: &Engine, agent: i64, line: &str) {
    let outer = engine.dogs.activity.pin();
    let Some(inner) = outer.get(&agent) else { return };
    let now = Utc::now();
    for (_, tx) in inner.pin().iter() {
        let _ = tx.send((line.to_string(), now));
    }
}

#[logged]
async fn run(engine: &Arc<Engine>, uid: &str, cancel: &CancellationToken) -> Result<()> {
    let Some(dog) = load(engine, uid).await? else { return Ok(()) };
    if dog.state != "armed" {
        return Ok(());
    }
    if !dog.owner_live {
        pause(engine, &dog, ARCHIVE_PAUSE).await?;
        return Ok(());
    }
    match dog.kind.as_str() {
        "stream" => run_stream(engine, dog, cancel).await,
        "activity" => run_activity(engine, dog, cancel).await,
        _ => run_poll(engine, uid, cancel).await,
    }
}

// ------------------------------------------------------------ polling dogs

#[logged]
async fn run_poll(engine: &Arc<Engine>, uid: &str, cancel: &CancellationToken) -> Result<()> {
    loop {
        let span = crate::trace::request(&format!("dog:{uid}"));
        let next = tracing::Instrument::instrument(poll_once(engine, uid), span).await?;
        let Some(wait) = next else { return Ok(()) };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = cancel.cancelled() => return Ok(()),
        }
    }
}

/// One check of a file, command or process dog: how long until the next
/// one, or `None` when the dog is done.
#[logged]
async fn poll_once(engine: &Arc<Engine>, uid: &str) -> Result<Option<Duration>> {
    let Some(mut dog) = load(engine, uid).await? else { return Ok(None) };
    if dog.state != "armed" {
        return Ok(None);
    }
    if !dog.owner_live {
        pause(engine, &dog, ARCHIVE_PAUSE).await?;
        return Ok(None);
    }
    let cwd = workdir(engine, &dog);
    let (events, alive) = check(&mut dog, cwd.as_deref()).await;
    note_life(&mut dog.run, alive);
    let matched = !events.is_empty();
    save_run(engine, &mut dog, matched).await?;
    if dog.silence() {
        if dog.due_in().map(|s| s <= 0).unwrap_or(false) {
            if fire(engine, &dog, &[silence_line(&dog)], " WENT QUIET —").await? {
                return Ok(None);
            }
            dog.silence_since = Some(Utc::now());
        }
    } else if matched && fire(engine, &dog, &events, "").await? {
        return Ok(None);
    }
    if let Some(lost) = subject_lost(&dog) {
        if dog.run["alerted"].as_str() != Some(lost.why) {
            alert(engine, &dog, &lost).await?;
        }
        if lost.pause {
            return Ok(None);
        }
    }
    let mut wait = dog.interval_s.max(FLOOR_S);
    if let Some(d) = dog.due_in() {
        wait = wait.min(d.max(1));
    }
    Ok(Some(Duration::from_secs(wait as u64)))
}

/// Check the target once: the matching event lines, and whether the subject
/// showed a sign of life (the file grew, the command ran, the process answered).
#[logged]
async fn check(dog: &mut Dog, cwd: Option<&Path>) -> (Vec<String>, bool) {
    let re = dog.regex();
    let hit = |line: &str| !line.trim().is_empty() && re.as_ref().map(|r| r.is_match(line)).unwrap_or(true);
    let kind = dog.kind.clone();
    let target = dog.target.clone();
    let shell = dog.shell.clone();
    let run = &mut dog.run;
    run["checks_run"] = json!(run["checks_run"].as_i64().unwrap_or(0) + 1);
    match kind.as_str() {
        "file" => {
            let path = Path::new(&target);
            let md = match std::fs::metadata(path) {
                Ok(m) if m.is_file() => m,
                _ => {
                    run["missing"] = json!(true);
                    return (Vec::new(), false);
                }
            };
            run["missing"] = json!(false);
            let len = md.len();
            let mut from = run["offset"].as_u64().unwrap_or(0);
            if len < from {
                // truncated or replaced: read it again from the start
                from = 0;
            }
            if len == from {
                return (Vec::new(), false);
            }
            const WINDOW: usize = 1 << 20;
            let take = ((len - from) as usize).min(WINDOW);
            let Ok(buf) = read_at(path, from, take) else { return (Vec::new(), false) };
            // stop at the last complete line, unless one line fills the window
            // or an unterminated tail sat unchanged for a whole interval
            let cut = match buf.iter().rposition(|b| *b == b'\n') {
                Some(i) => i + 1,
                None if buf.len() == WINDOW || run["partial"].as_u64() == Some(buf.len() as u64) => buf.len(),
                None => {
                    run["partial"] = json!(buf.len());
                    return (Vec::new(), false);
                }
            };
            if let Some(o) = run.as_object_mut() {
                o.remove("partial");
            }
            let text = String::from_utf8_lossy(&buf[..cut]).to_string();
            run["offset"] = json!(from + cut as u64);
            run["last_output"] = json!(tail(&text, OUT_KEEP));
            (text.lines().filter(|l| hit(l)).map(|l| gist(l.trim_end(), 300)).collect(), true)
        }
        "command" => {
            let out = run_command(&target, shell.as_deref(), cwd, COMMAND_TIMEOUT_S).await;
            run["last_output"] = json!(tail(&out.output, OUT_KEEP));
            run["last_exit"] = json!(out.code);
            let broken = !out.ran || broken_sig(&out.output).is_some();
            run["broken"] = json!(if broken { run["broken"].as_i64().unwrap_or(0) + 1 } else { 0 });
            let mut ev: Vec<String> = out.output.lines().filter(|l| hit(l)).map(|l| gist(l.trim_end(), 300)).collect();
            if out.timed_out {
                ev.push(format!("(the command did not exit within {COMMAND_TIMEOUT_S} s and was stopped)"));
            }
            (ev, !broken)
        }
        "process" => {
            let up = target_up(&target).await;
            let was_up = run["up"].as_bool().unwrap_or(true);
            run["up"] = json!(up);
            let ev = if was_up && !up { vec![format!("{target} went DOWN")] } else { Vec::new() };
            (ev, up)
        }
        _ => (Vec::new(), false),
    }
}

fn read_at(path: &Path, from: u64, take: usize) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(from))?;
    let mut buf = vec![0u8; take];
    let mut got = 0;
    while got < take {
        let n = f.read(&mut buf[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    buf.truncate(got);
    Ok(buf)
}

fn tail(text: &str, keep: usize) -> String {
    let t = text.trim_end();
    if t.len() <= keep {
        return t.to_string();
    }
    let mut start = t.len() - keep;
    while !t.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &t[start..])
}

fn broken_sig(out: &str) -> Option<&'static str> {
    let low = out.to_lowercase();
    SHELL_ERRORS.iter().copied().find(|s| low.contains(s))
}

/// Count consecutive checks without a sign of life.
fn note_life(run: &mut Value, alive: bool) {
    if alive {
        run["quiet"] = json!(0);
        run["alive_at"] = json!(iso(Utc::now()));
        if let Some(o) = run.as_object_mut() {
            o.remove("alerted");
        }
    } else {
        run["quiet"] = json!(run["quiet"].as_i64().unwrap_or(0) + 1);
        if run["alive_at"].is_null() {
            run["alive_at"] = json!(iso(Utc::now()));
        }
    }
}

/// Persist the runner's progress; a match restarts a silence dog's clock.
#[logged]
async fn save_run(engine: &Engine, dog: &mut Dog, matched: bool) -> Result<()> {
    let reset = matched && dog.silence();
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.watchdogs SET last_check = now(), memo = jsonb_set(memo, '{run}', $2),
                    silence_since = CASE WHEN $3 THEN now() ELSE silence_since END
              WHERE uid = $1 AND state = 'armed'",
            &[&dog.uid, &dog.run, &reset],
        )
        .await?;
    if reset {
        dog.silence_since = Some(Utc::now());
    }
    Ok(())
}

#[logged]
async fn target_up(target: &str) -> bool {
    if let Some(pid) = target.strip_prefix("pid:").and_then(|p| p.trim().parse::<u32>().ok()) {
        return crate::winproc::process_alive(pid);
    }
    if let Some(port) = target.strip_prefix("port:").and_then(|p| p.trim().parse::<u16>().ok()) {
        return tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", port)))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
    }
    false
}

fn silence_line(dog: &Dog) -> String {
    let since = dog.silence_since.unwrap_or(dog.created_at);
    format!("no matching event for {} s (since {})", dog.quiet_s.unwrap_or(600), iso(since))
}

/// The owner's working folder, where command and stream dogs run.
fn workdir(engine: &Engine, dog: &Dog) -> Option<PathBuf> {
    let p = match &dog.workdir {
        Some(d) => PathBuf::from(d),
        None => engine.cfg.scratch_root(&engine.orgs.by_id(dog.org_id)?.slug).join(&dog.owner_name),
    };
    p.is_dir().then_some(p)
}

// ------------------------------------------------------------ shells

/// A real bash for `shell: "bash"`, or None. On Windows the System32
/// `bash.exe` is the WSL launcher and would run the command in a Linux VM,
/// so Git for Windows' fixed locations go first and System32 is skipped.
#[logged]
pub fn resolve_bash() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let mut cands = vec![
            PathBuf::from(env("ProgramFiles", r"C:\Program Files")).join(r"Git\bin\bash.exe"),
            PathBuf::from(env("ProgramFiles(x86)", r"C:\Program Files (x86)")).join(r"Git\bin\bash.exe"),
        ];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            cands.push(PathBuf::from(local).join(r"Programs\Git\bin\bash.exe"));
        }
        if let Some(p) = cands.into_iter().find(|p| p.is_file()) {
            return Some(p);
        }
        let sys32 = PathBuf::from(env("SystemRoot", r"C:\Windows")).join("System32").to_string_lossy().to_lowercase();
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .filter(|d| d.to_string_lossy().trim_end_matches('\\').to_lowercase() != sys32)
            .map(|d| d.join("bash.exe"))
            .find(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path).map(|d| d.join("bash")).find(|p| p.is_file())
    }
}

fn shell_cmd(target: &str, shell: Option<&str>, cwd: Option<&Path>) -> std::io::Result<tokio::process::Command> {
    let mut cmd = if shell == Some("bash") {
        let bash = resolve_bash().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no bash is installed"))?;
        let mut c = tokio::process::Command::new(bash);
        c.arg("-lc").arg(target);
        c
    } else {
        native_cmd(target)
    };
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.env_remove("ELECTRON_RUN_AS_NODE");
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null());
    crate::winproc::no_window(&mut cmd);
    Ok(cmd)
}

#[cfg(windows)]
fn native_cmd(target: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("cmd.exe");
    c.raw_arg(format!("/S /C \"{target}\""));
    c
}

#[cfg(not(windows))]
fn native_cmd(target: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("sh");
    c.arg("-c").arg(target);
    c
}

#[derive(Debug, serde::Serialize)]
pub struct CmdOut {
    pub code: Option<i32>,
    pub output: String,
    pub ran: bool,
    pub timed_out: bool,
}

/// Run a command once, stdout and stderr together, stopping its whole tree
/// at the deadline.
#[logged]
pub async fn run_command(target: &str, shell: Option<&str>, cwd: Option<&Path>, timeout_s: u64) -> CmdOut {
    let failed = |e: String| CmdOut { code: None, output: format!("could not run: {e}"), ran: false, timed_out: false };
    let mut cmd = match shell_cmd(target, shell, cwd) {
        Ok(c) => c,
        Err(e) => return failed(e.to_string()),
    };
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(e.to_string()),
    };
    let job = crate::winproc::child_job(&child);
    let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else {
        return failed("its output could not be read".into());
    };
    let finished = tokio::time::timeout(Duration::from_secs(timeout_s.max(1)), async {
        let (mut a, mut b) = (BufReader::new(out), BufReader::new(err));
        let (mut la, mut lb) = (Vec::new(), Vec::new());
        let (mut text, mut ea, mut eb) = (String::new(), false, false);
        while !(ea && eb) {
            tokio::select! {
                l = next_line(&mut a, &mut la), if !ea => match l { Some(l) => push_capped(&mut text, &l), None => ea = true },
                l = next_line(&mut b, &mut lb), if !eb => match l { Some(l) => push_capped(&mut text, &l), None => eb = true },
            }
        }
        (child.wait().await.ok().and_then(|s| s.code()), text)
    })
    .await;
    match finished {
        Ok((code, text)) => CmdOut { code, output: text, ran: true, timed_out: false },
        Err(_) => {
            if let Some(j) = &job {
                j.terminate();
            }
            CmdOut { code: None, output: String::new(), ran: true, timed_out: true }
        }
    }
}

fn push_capped(text: &mut String, line: &str) {
    if text.len() < 256 * 1024 {
        text.push_str(line);
        text.push('\n');
    }
}

/// One line, decoded leniently (console output is rarely clean UTF-8).
/// `buf` carries a partial line across a cancelled read (`select!`), so it
/// is cleared only once a whole line is handed out.
async fn next_line<R: AsyncRead + Unpin>(r: &mut BufReader<R>, buf: &mut Vec<u8>) -> Option<String> {
    let _ = r.read_until(b'\n', buf).await;
    if buf.is_empty() {
        return None;
    }
    let line = String::from_utf8_lossy(buf).trim_end_matches(['\r', '\n']).to_string();
    buf.clear();
    Some(line)
}

// ------------------------------------------------------------ streams

/// A persistent command: matching lines fire at once (at most one mail per
/// `interval_s`), or restart a silence dog's clock.
#[logged]
async fn run_stream(engine: &Arc<Engine>, dog: Dog, cancel: &CancellationToken) -> Result<()> {
    if dog.exit.is_some() {
        // an exited stream respawns only on resume; a silence dog keeps its clock
        return if dog.silence() { silence_clock(engine, &dog.uid, cancel).await } else { Ok(()) };
    }
    let re = dog.regex();
    let cwd = workdir(engine, &dog);
    let spawned = shell_cmd(&dog.target, dog.shell.as_deref(), cwd.as_deref()).and_then(|mut c| {
        c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        c.spawn()
    });
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            let lost = Lost {
                why: "broken",
                headline: format!("the stream could not start: {e}"),
                advice: "fix the target and resume it (or re-create it). It is PAUSED so its evidence stays readable in `orgtree_watchdog list`.",
                pause: true,
            };
            alert(engine, &dog, &lost).await?;
            return Ok(());
        }
    };
    let _job = crate::winproc::child_job(&child);
    let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else { return Ok(()) };
    let (mut a, mut b) = (BufReader::new(out), BufReader::new(err));
    let (mut la, mut lb) = (Vec::new(), Vec::new());
    let (mut ea, mut eb) = (false, false);
    let gap = Duration::from_secs(dog.interval_s.max(STREAM_FLOOR_S) as u64);
    let mut pending: Vec<String> = Vec::new();
    let mut last_fire: Option<Instant> = None;
    let mut run = dog.run.clone();
    let mut lines_read = run["checks_run"].as_i64().unwrap_or(0);
    let mut recent = String::new();
    let mut dirty = false;
    let mut matched_at: Option<DateTime<Utc>> = None;
    let mut last_save = Instant::now();
    let mut d = dog;
    while !(ea && eb) {
        let line = tokio::select! {
            l = next_line(&mut a, &mut la), if !ea => { if l.is_none() { ea = true; } l }
            l = next_line(&mut b, &mut lb), if !eb => { if l.is_none() { eb = true; } l }
            _ = tokio::time::sleep(Duration::from_secs(1)) => None,
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                return Ok(());
            }
        };
        if let Some(line) = line {
            lines_read += 1;
            dirty = true;
            recent.push_str(&line);
            recent.push('\n');
            if recent.len() > 4 * OUT_KEEP {
                recent = tail(&recent, OUT_KEEP);
                recent.push('\n');
            }
            if !line.trim().is_empty() && re.as_ref().map(|r| r.is_match(&line)).unwrap_or(true) {
                if d.silence() {
                    matched_at = Some(Utc::now());
                    d.silence_since = matched_at;
                } else if pending.len() < 200 {
                    pending.push(gist(&line, 300));
                }
            }
        }
        if !pending.is_empty() && last_fire.map(|t| t.elapsed() >= gap).unwrap_or(true) {
            let ev = std::mem::take(&mut pending);
            last_fire = Some(Instant::now());
            if fire(engine, &d, &ev, "").await? {
                let _ = child.start_kill();
                return Ok(());
            }
        }
        let since_save = last_save.elapsed();
        if dirty && (since_save >= Duration::from_secs(10) || (matched_at.is_some() && since_save >= Duration::from_secs(2))) {
            run["checks_run"] = json!(lines_read);
            run["last_output"] = json!(tail(&recent, OUT_KEEP));
            save_stream(engine, &d.uid, &run, matched_at.take()).await?;
            match load(engine, &d.uid).await? {
                Some(fresh) if fresh.state == "armed" => d = fresh,
                _ => {
                    let _ = child.start_kill();
                    return Ok(());
                }
            }
            dirty = false;
            last_save = Instant::now();
        }
        if d.due_in().map(|s| s <= 0).unwrap_or(false) {
            if fire(engine, &d, &[silence_line(&d)], " WENT QUIET —").await? {
                let _ = child.start_kill();
                return Ok(());
            }
            d.silence_since = Some(Utc::now());
        }
    }
    // the stream ended
    let code = child.wait().await.ok().and_then(|s| s.code());
    run["checks_run"] = json!(lines_read);
    run["last_output"] = json!(tail(&recent, OUT_KEEP));
    save_stream(engine, &d.uid, &run, None).await?;
    let client = engine.db.get().await?;
    let n = client
        .execute(
            "UPDATE ot.watchdogs SET exit = $2, state = CASE WHEN fire_mode = 'silence' THEN state ELSE 'exited' END
              WHERE uid = $1 AND state = 'armed'",
            &[&d.uid, &json!({ "code": code, "at": iso(Utc::now()) })],
        )
        .await?;
    drop(client);
    if n == 0 {
        return Ok(());
    }
    changes::notify_id(engine, d.org_id, vec![Change::Watchdogs]);
    if d.silence() {
        return silence_clock(engine, &d.uid, cancel).await;
    }
    pending.push(format!("(stream exited with code {})", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())));
    // the dog is `exited` now; this fire is its last word
    fire_exited(engine, &d, &pending).await?;
    Ok(())
}

#[logged]
async fn save_stream(engine: &Engine, uid: &str, run: &Value, matched_at: Option<DateTime<Utc>>) -> Result<()> {
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.watchdogs SET last_check = now(), memo = jsonb_set(memo, '{run}', $2),
                    silence_since = coalesce($3, silence_since)
              WHERE uid = $1 AND state = 'armed'",
            &[&uid, run, &matched_at],
        )
        .await?;
    Ok(())
}

/// A silence dog with nothing left to listen to: fire each full quiet period.
#[logged]
async fn silence_clock(engine: &Arc<Engine>, uid: &str, cancel: &CancellationToken) -> Result<()> {
    loop {
        let Some(d) = load(engine, uid).await? else { return Ok(()) };
        if d.state != "armed" || !d.silence() {
            return Ok(());
        }
        let due = d.due_in().unwrap_or(60);
        if due <= 0 {
            if fire(engine, &d, &[silence_line(&d)], " WENT QUIET —").await? {
                return Ok(());
            }
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(due.clamp(1, 300) as u64)) => {}
            _ = cancel.cancelled() => return Ok(()),
        }
    }
}

// ------------------------------------------------------------ activity

#[logged]
async fn run_activity(engine: &Arc<Engine>, dog: Dog, cancel: &CancellationToken) -> Result<()> {
    let Some(target) = dog.memo["target_id"].as_i64() else {
        pause(engine, &dog, "its activity target is unknown").await?;
        return Ok(());
    };
    let (tx, mut rx) = unbounded_channel();
    engine.dogs.activity.pin().get_or_insert_with(target, papaya::HashMap::new).pin().insert(dog.uid.clone(), tx);
    let uid = dog.uid.clone();
    let r = activity_loop(engine, dog, target, &mut rx, cancel).await;
    if let Some(inner) = engine.dogs.activity.pin().get(&target) {
        inner.pin().remove(&uid);
    }
    r
}

#[logged]
async fn activity_loop(
    engine: &Arc<Engine>,
    mut d: Dog,
    target: i64,
    rx: &mut UnboundedReceiver<(String, DateTime<Utc>)>,
    cancel: &CancellationToken,
) -> Result<()> {
    let re = d.regex();
    let gap = Duration::from_secs(d.interval_s.max(STREAM_FLOOR_S) as u64);
    let mut pending: Vec<String> = Vec::new();
    let mut last_fire: Option<Instant> = None;
    loop {
        let wait = match d.due_in() {
            Some(s) => Duration::from_secs(s.max(1) as u64),
            None if !pending.is_empty() => last_fire.map(|t| gap.saturating_sub(t.elapsed())).unwrap_or_default(),
            None => Duration::from_secs(3600),
        };
        let mut seen: Vec<String> = Vec::new();
        tokio::select! {
            m = rx.recv() => {
                let Some((line, at)) = m else { return Ok(()) };
                if at >= d.created_at {
                    seen.push(line);
                }
                while let Ok((line, at)) = rx.try_recv() {
                    if at >= d.created_at {
                        seen.push(line);
                    }
                }
            }
            _ = tokio::time::sleep(wait) => {}
            _ = cancel.cancelled() => return Ok(()),
        }
        let hits: Vec<String> = seen.iter().filter(|l| re.as_ref().map(|r| r.is_match(l)).unwrap_or(true)).cloned().collect();
        if !seen.is_empty() {
            let Some(fresh) = load(engine, &d.uid).await? else { return Ok(()) };
            if fresh.state != "armed" {
                return Ok(());
            }
            d = fresh;
            d.run["checks_run"] = json!(d.run_i64("checks_run") + seen.len() as i64);
            d.run["last_output"] = json!(tail(&seen.join("\n"), OUT_KEEP));
            note_life(&mut d.run, true);
            save_run(engine, &mut d, !hits.is_empty()).await?;
        }
        if d.silence() {
            if d.due_in().map(|s| s <= 0).unwrap_or(false) {
                if !below(engine, d.owner, target).await? {
                    pause(engine, &d, NOT_BELOW).await?;
                    return Ok(());
                }
                if fire(engine, &d, &[silence_line(&d)], " WENT QUIET —").await? {
                    return Ok(());
                }
                d.silence_since = Some(Utc::now());
            }
            continue;
        }
        for h in hits {
            if pending.last() != Some(&h) && pending.len() < 200 {
                pending.push(h);
            }
        }
        if !pending.is_empty() && last_fire.map(|t| t.elapsed() >= gap).unwrap_or(true) {
            if !below(engine, d.owner, target).await? {
                pause(engine, &d, NOT_BELOW).await?;
                return Ok(());
            }
            let ev = std::mem::take(&mut pending);
            last_fire = Some(Instant::now());
            if fire(engine, &d, &ev, "").await? {
                return Ok(());
            }
        }
    }
}

/// Is `node` live, and the owner itself or one of its descendants?
#[logged]
async fn below(engine: &Engine, owner: i64, node: i64) -> Result<bool> {
    let client = engine.db.get().await?;
    let r = client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2 AND state = 'live'
               UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = $1)",
            &[&owner, &node],
        )
        .await?;
    Ok(r.get(0))
}

// ------------------------------------------------------------ fires and alerts

/// Record the fire and mail the owner. Returns whether the dog is done
/// (a one-shot dog is spent by its fire; a dog changed underneath is left be).
#[logged]
async fn fire(engine: &Arc<Engine>, dog: &Dog, events: &[String], prefix: &str) -> Result<bool> {
    let now = Utc::now();
    let ring: Vec<Value> = events.iter().take(20).map(|e| json!({ "at": iso(now), "gist": gist(e, 200) })).collect();
    let client = engine.db.get().await?;
    let row = client
        .query_opt(
            "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now(),
                    silence_since = CASE WHEN fire_mode = 'silence' THEN now() ELSE silence_since END,
                    events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                        SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                         ORDER BY n DESC LIMIT $3) s),
                    spent_at = CASE WHEN once THEN now() ELSE spent_at END,
                    state = CASE WHEN once THEN 'spent' ELSE state END
              WHERE uid = $1 AND state = 'armed'
              RETURNING once, fired",
            &[&dog.uid, &json!(ring), &EVENTS_KEEP],
        )
        .await?;
    drop(client);
    let Some(row) = row else { return Ok(true) };
    let once: bool = row.get(0);
    let fired: i32 = row.get(1);
    let body = fire_body(dog, events, prefix, once, fired);
    deliver(engine, dog, body).await;
    if once {
        disarm(engine, &dog.uid);
    }
    Ok(once)
}

/// The fire of a stream dog that has just moved to `exited`.
#[logged]
async fn fire_exited(engine: &Arc<Engine>, dog: &Dog, events: &[String]) -> Result<()> {
    let client = engine.db.get().await?;
    let fired: i32 = client
        .query_one("UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now() WHERE uid = $1 RETURNING fired", &[&dog.uid])
        .await?
        .get(0);
    drop(client);
    let mut body = fire_body(dog, events, " STREAM EXITED —", false, fired);
    body.push_str("The stream is not restarted; resume the watchdog to start it again.\n");
    deliver(engine, dog, body).await;
    Ok(())
}

fn fire_body(dog: &Dog, events: &[String], prefix: &str, once: bool, fired: i32) -> String {
    let mut body = format!("Watchdog \"{}\" fired{} ({} · {}), fire #{fired}:\n", dog.name, prefix, dog.kind, dog.target);
    for e in events.iter().take(40) {
        body.push_str("  ");
        body.push_str(e);
        body.push('\n');
    }
    if events.len() > 40 {
        body.push_str(&format!("  … and {} more\n", events.len() - 40));
    }
    if once {
        body.push_str("This was a ONE-SHOT watchdog: it removed itself with this fire and will not appear in `list` again.\n");
    }
    body
}

/// Mail from the dog to its owner (a notice dog's mail starts no turn).
#[logged]
async fn deliver(engine: &Arc<Engine>, dog: &Dog, body: String) {
    let mut out = Outgoing::new(From::Watchdog { uid: dog.uid.clone(), name: dog.name.clone() }, &dog.owner_name, &body);
    out.kind = "watchdog".into();
    out.notice = dog.notice();
    if let Err(e) = mail::send(engine, dog.org_id, out).await {
        tracing::warn!(watchdog = %dog.uid, error = %format!("{e:#}"), "watchdog mail failed");
    }
    changes::notify_id(engine, dog.org_id, vec![Change::Watchdogs]);
}

/// The subject this dog watches stopped producing.
#[derive(Debug)]
struct Lost {
    why: &'static str,
    headline: String,
    advice: &'static str,
    pause: bool,
}

fn hours(sec: i64) -> String {
    if sec < 3600 {
        format!("{} min", (sec / 60).max(1))
    } else {
        format!("{:.1} h", sec as f64 / 3600.0)
    }
}

fn subject_lost(dog: &Dog) -> Option<Lost> {
    if dog.state != "armed" {
        return None;
    }
    let quiet = dog.run_i64("quiet");
    match dog.kind.as_str() {
        "command" => {
            let broken = dog.run_i64("broken");
            (broken >= BROKEN_STREAK).then(|| Lost {
                why: "broken",
                headline: format!("its target could not be run at all on {broken} consecutive checks"),
                advice: "this dog cannot fire and never could — fix the target and re-create it. It is PAUSED rather than removed so its own evidence stays readable in `orgtree_watchdog list`.",
                pause: true,
            })
        }
        "process" if !dog.silence() => {
            let spent = dog.target.starts_with("pid:") && dog.fired > 0 && dog.run["up"].as_bool() == Some(false) && quiet >= SPENT_CHECKS;
            spent.then(|| Lost {
                why: "spent",
                headline: format!(
                    "it already fired on {} going DOWN, and a pid cannot come back — {quiet} checks since have found nothing and never will",
                    dog.target
                ),
                advice: "this dog has done its job. It is PAUSED, not removed, so its record of the event it caught survives; remove it when you have read this.",
                pause: true,
            })
        }
        "file" if !dog.silence() => {
            let since = dog.run["alive_at"].as_str().and_then(crate::util::parse_ts).map(|t| (Utc::now() - t).num_seconds());
            (quiet >= STALE_CHECKS && since.map(|s| s >= STALE_AGE_S).unwrap_or(false)).then(|| Lost {
                why: "stale",
                headline: format!("{} has not grown through {quiet} consecutive checks over {}", dog.target, hours(since.unwrap_or(0))),
                advice: "this is STALENESS, not proof of death: a quiet file and a dead writer look identical from here. If you expected something to be writing it, go and check that it is still alive. The dog is left ARMED and will fire normally if the file grows.",
                pause: false,
            })
        }
        _ => None,
    }
}

/// Tell the owner its dog can no longer answer (not a fire: `fired` stays).
#[logged]
async fn alert(engine: &Arc<Engine>, dog: &Dog, lost: &Lost) -> Result<()> {
    let age = (Utc::now() - dog.created_at).num_seconds();
    let mut body = format!("Watchdog \"{}\" went quiet: {}.\n", dog.name, lost.headline);
    body.push_str(&format!("  watching   : {} · {}\n", dog.kind, dog.target));
    body.push_str(&format!("  armed      : {} ago\n", hours(age)));
    body.push_str(&format!("  checks run : {}\n", dog.run_i64("checks_run")));
    body.push_str(&format!("  last fired : {}\n", dog.last_fired.map(iso).unwrap_or_else(|| "never".into())));
    if let Some(o) = dog.run["last_output"].as_str().filter(|o| !o.is_empty()) {
        body.push_str(&format!("  last output: {}\n", gist(o, 200)));
    }
    body.push_str(lost.advice);
    body.push('\n');
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.watchdogs SET memo = jsonb_set(memo || jsonb_build_object('run', coalesce(memo->'run', '{}'::jsonb)),
                                             '{run,alerted}', to_jsonb($2::text))
                    || CASE WHEN $3 THEN jsonb_build_object('paused_why', $4::text) ELSE '{}'::jsonb END,
                    state = CASE WHEN $3 THEN 'paused' ELSE state END
              WHERE uid = $1 AND state = 'armed'",
            &[&dog.uid, &lost.why, &lost.pause, &lost.headline],
        )
        .await?;
    drop(client);
    deliver(engine, dog, body).await;
    Ok(())
}

#[logged]
async fn pause(engine: &Engine, dog: &Dog, why: &str) -> Result<()> {
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.watchdogs SET state = 'paused', memo = memo || jsonb_build_object('paused_why', $2::text)
              WHERE uid = $1 AND state = 'armed'",
            &[&dog.uid, &why],
        )
        .await?;
    drop(client);
    changes::notify_id(engine, dog.org_id, vec![Change::Watchdogs]);
    Ok(())
}

// ------------------------------------------------------------ the tool and the user

/// May `actor` (an agent; `None` is the user) manage a dog `owner` keeps?
/// Its owner and the owner's superiors.
#[logged]
async fn may_manage(engine: &Engine, actor: Option<i64>, owner: i64) -> Result<bool> {
    let Some(a) = actor else { return Ok(true) };
    if a == owner {
        return Ok(true);
    }
    let client = engine.db.get().await?;
    let r = client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
               UNION ALL SELECT x.id, x.parent_id, up.depth + 1 FROM ot.agents x JOIN up ON x.id = up.parent_id WHERE up.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = $1 AND depth > 0)",
            &[&a, &owner],
        )
        .await?;
    Ok(r.get(0))
}

/// Does `agent` hold bash, all the way up its chain?
#[logged]
async fn holds_bash(engine: &Engine, agent: i64) -> Result<bool> {
    let client = engine.db.get().await?;
    let org: Value = client
        .query_one("SELECT o.settings FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id = $1", &[&agent])
        .await?
        .get(0);
    let chain = client
        .query(
            "WITH RECURSIVE chain(id, parent_id, scope, depth) AS (
               SELECT id, parent_id, scope, 0 FROM ot.agents WHERE id = $1
               UNION ALL SELECT a.id, a.parent_id, a.scope, c.depth + 1 FROM ot.agents a JOIN chain c ON a.id = c.parent_id
                WHERE c.depth < 1024)
             SELECT scope FROM chain ORDER BY depth DESC",
            &[&agent],
        )
        .await?;
    let settings = crate::feed::groups::effective_settings(&org, &engine.settings.defaults());
    let mut eff = scope::org_ceiling(&settings["dirs"]);
    for s in &chain {
        eff = scope::clamp(&s.get::<_, Value>(0), &eff);
    }
    Ok(eff["tools"]["bash"].as_bool().unwrap_or(false))
}

/// What the target says right now, through the same spawn the runner uses.
#[logged]
async fn smoke(kind: &str, target: &str, pattern: Option<&Regex>, shell: Option<&str>, cwd: Option<&Path>) -> Value {
    let shell_name = if shell == Some("bash") { "bash" } else if cfg!(windows) { "cmd.exe" } else { "sh" };
    let note = if shell == Some("bash") {
        "target runs in `bash -lc` with the engine's environment — your interactive shell's aliases, rc files and PATH additions are not there."
    } else if cfg!(windows) {
        "target runs in cmd.exe with the engine's PATH: grep, sed, awk, tr, $(...), $VAR and /tmp do not work and `find` is FIND.EXE. Use findstr, dir /b, %VAR% and %TEMP%, or pass shell: \"bash\"."
    } else {
        "target runs in sh with the engine's environment."
    };
    let mut res = json!({ "shell": shell_name, "note": note });
    match kind {
        "file" => {
            match std::fs::metadata(target) {
                Ok(md) => {
                    res["ran"] = json!(format!("{target} exists, {} bytes", md.len()));
                    res["note"] = json!("only content APPENDED after now can fire this dog — what is already in the file will not.");
                }
                Err(_) => {
                    res["ran"] = json!(format!("{target} does not exist yet"));
                    res["note"] = json!("that is fine — the dog starts watching when it appears; but a typo in the path looks identical.");
                }
            }
            return res;
        }
        "activity" => {
            res["ran"] = json!(format!("watching turns and tool calls of {target}"));
            res["note"] = json!("event lines: turn_started, turn_done, tool_call NAME; no tool arguments or output");
            return res;
        }
        "process" => {
            let up = target_up(target).await;
            res["ran"] = json!(format!("{target} is {} right now", if up { "UP" } else { "DOWN" }));
            res["note"] = json!(if up {
                "this dog fires on the DOWN EDGE only."
            } else {
                "this dog fires on the DOWN EDGE only — and the target is ALREADY DOWN, so it will not fire until it comes UP and goes down again."
            });
            return res;
        }
        _ => {}
    }
    let out = run_command(target, shell, cwd, SMOKE_TIMEOUT_S).await;
    if !out.ran {
        res["ran"] = json!(format!("FAILED TO START: {}", out.output));
        res["exit_code"] = Value::Null;
        res["broken"] = json!(true);
        return res;
    }
    res["exit_code"] = json!(out.code);
    res["output"] = json!(if out.output.trim().is_empty() { "(no output)".to_string() } else { gist(out.output.trim(), OUT_KEEP) });
    if let Some(sig) = broken_sig(&out.output) {
        res["broken"] = json!(true);
        res["ran"] = json!(format!(
            "⚠ THE TARGET DID NOT RUN — the shell answered \"{sig}\". Fix the command: this dog would sit armed and never fire, which looks exactly like the condition never happening."
        ));
        return res;
    }
    if kind == "stream" {
        res["ran"] = json!(if out.timed_out {
            format!("still running after {SMOKE_TIMEOUT_S}s — good, a stream is supposed to keep listening")
        } else {
            format!("⚠ EXITED IMMEDIATELY with code {:?} — a stream dog whose command exits cannot listen for anything", out.code)
        });
        res["broken"] = json!(!out.timed_out);
    } else {
        res["ran"] = json!(if out.timed_out {
            format!(
                "⚠ still running after {SMOKE_TIMEOUT_S}s — a command dog's target must EXIT; the engine stops it at {COMMAND_TIMEOUT_S}s and fires that as the event"
            )
        } else {
            format!("exited with code {:?}", out.code)
        });
    }
    if let Some(re) = pattern {
        let hits = out.output.lines().filter(|l| re.is_match(l)).count();
        res["matched"] = json!(hits > 0);
        res["matched_note"] = json!(if hits > 0 {
            format!("the pattern matched {hits} line(s) — this dog would fire NOW")
        } else {
            "the pattern matched nothing in this output — expected if the condition has not happened yet, but check the output above is the shape you think it is.".to_string()
        });
    }
    res
}

/// The short name a dog is known by: lowercase letters, digits and dashes.
fn dog_name(raw: &str) -> String {
    let mut name = String::new();
    for c in raw.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            name.push(c);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    let name: String = name.chars().take(24).collect();
    name.trim_matches('-').to_string()
}

/// `orgtree_watchdog create`: a dog for `owner` (the caller), smoke-run once.
#[logged]
pub async fn create(engine: &Arc<Engine>, org_id: i64, owner: i64, args: &Value) -> Result<Value> {
    let name = dog_name(args["name"].as_str().unwrap_or(""));
    if name.is_empty() {
        refuse!(BadRequest, "a watchdog needs a short name");
    }
    let kind = args["kind"].as_str().unwrap_or("").to_string();
    if !["file", "command", "process", "stream", "activity"].contains(&kind.as_str()) {
        refuse!(BadRequest, "kind must be one of file, command, process, stream, activity");
    }
    let target = args["target"].as_str().map(str::trim).unwrap_or("").to_string();
    if target.is_empty() {
        refuse!(BadRequest, "target is required — the path, command, agent, or pid:N / port:N to watch");
    }
    let client = engine.db.get().await?;
    let owner_row = client.query_one("SELECT name, scratch_dir FROM ot.agents WHERE id = $1", &[&owner]).await?;
    let owner_name: String = owner_row.get(0);
    let owner_dir: Option<String> = owner_row.get(1);
    if (kind == "command" || kind == "stream") && !holds_bash(engine, owner).await? {
        refuse!(
            Forbidden,
            "a command/stream watchdog runs with YOUR hands — it needs the bash you do not hold; ask for it (orgtree_request_scope) or watch a file instead"
        );
    }
    if kind == "process" {
        let ok = Regex::new(r"^(pid|port):\d+$").map(|r| r.is_match(&target)).unwrap_or(false);
        if !ok {
            refuse!(BadRequest, "process targets are `pid:N` or `port:N`");
        }
    }
    let mut memo = json!({ "run": {} });
    if kind == "activity" {
        let t = target.trim_start_matches('@').to_string();
        let row = client
            .query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org_id, &t])
            .await?;
        let Some(row) = row else { refuse!(NotFound, "no live agent named {t} to watch") };
        let tid: i64 = row.get(0);
        if !below(engine, owner, tid).await? {
            refuse!(Forbidden, "activity target must be yourself or a descendant");
        }
        memo["target_id"] = json!(tid);
    }
    let fire_mode = args["fire_mode"].as_str().filter(|s| !s.is_empty()).unwrap_or("event").to_string();
    if fire_mode != "event" && fire_mode != "silence" {
        refuse!(BadRequest, "fire_mode must be event or silence");
    }
    let quiet: Option<i32> = args["quiet_period_s"].as_i64().map(|q| q.clamp(0, i32::MAX as i64) as i32);
    if fire_mode == "silence" && quiet.unwrap_or(0) < 1 {
        refuse!(BadRequest, "fire_mode silence requires quiet_period_s (seconds without a matching event)");
    }
    if fire_mode == "event" && quiet.is_some() {
        refuse!(BadRequest, "quiet_period_s applies only to fire_mode silence");
    }
    let shell = args["shell"].as_str().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).unwrap_or_else(|| "native".into());
    if shell != "native" && shell != "bash" {
        refuse!(BadRequest, "shell must be native or bash");
    }
    if shell != "native" && kind != "command" && kind != "stream" {
        refuse!(BadRequest, "only command/stream watchdogs run a shell at all — file and process dogs have no target to interpret");
    }
    if shell == "bash" && resolve_bash().is_none() {
        refuse!(Unprocessable, "shell \"bash\" was asked for but no bash is installed on this machine; write the command for cmd.exe instead");
    }
    let shell_col: Option<String> = (shell == "bash").then(|| shell.clone());
    let pattern = args["pattern"].as_str().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
    let re = match &pattern {
        Some(p) => match Regex::new(p) {
            Ok(r) => Some(r),
            Err(e) => refuse!(BadRequest, "pattern does not compile: {e}"),
        },
        None => None,
    };
    if kind == "command" && pattern.is_none() {
        refuse!(BadRequest, "a command watchdog needs a pattern — 'ran and printed something' is not an event");
    }
    let floor = if kind == "stream" || kind == "activity" { STREAM_FLOOR_S } else { FLOOR_S };
    let interval = args["interval_s"].as_i64().unwrap_or(60).max(floor).min(i32::MAX as i64) as i32;
    let once = args["once"].as_bool().unwrap_or(false);
    let notice = args["notice"].as_bool().unwrap_or(false);
    memo["notice"] = json!(notice);
    let counts = client
        .query_one(
            "SELECT count(*) FILTER (WHERE owner_agent_id = $2), count(*) FROM ot.watchdogs
              WHERE org_id = $1 AND state IN ('armed', 'paused', 'exited')",
            &[&org_id, &owner],
        )
        .await?;
    if counts.get::<_, i64>(0) >= MAX_PER_AGENT {
        refuse!(Conflict, "you already keep {MAX_PER_AGENT} watchdogs — remove one first");
    }
    if counts.get::<_, i64>(1) >= MAX_PER_ORG {
        refuse!(Conflict, "the org already keeps {MAX_PER_ORG} watchdogs");
    }
    drop(client);
    // where the runner starts: a file from its current end, a process from its current state
    match kind.as_str() {
        "file" => memo["run"]["offset"] = json!(std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0)),
        "process" => memo["run"]["up"] = json!(target_up(&target).await),
        _ => {}
    }
    let cwd = {
        let p = match &owner_dir {
            Some(d) => PathBuf::from(d),
            None => engine.cfg.scratch_root(&engine.orgs.by_id(org_id).map(|o| o.slug.clone()).unwrap_or_default()).join(&owner_name),
        };
        p.is_dir().then_some(p)
    };
    let smoked = smoke(&kind, &target, re.as_ref(), shell_col.as_deref(), cwd.as_deref()).await;
    let id = uid("wd");
    let client = engine.db.get().await?;
    client
        .execute(
            "INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, pattern, shell, interval_s, fire_mode,
                                       quiet_period_s, once, state, memo, silence_since)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'armed', $13, CASE WHEN $10 = 'silence' THEN now() END)",
            &[&id, &org_id, &owner, &name, &kind, &target, &pattern, &shell_col, &interval, &fire_mode, &quiet, &once, &memo],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'watchdog_create', $2, $3, $4)",
            &[&org_id, &owner_name, &owner, &json!({ "id": id, "name": name, "kind": kind, "notice": notice, "once": once })],
        )
        .await?;
    drop(client);
    arm(engine, &id);
    changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Events]);
    let cadence = match kind.as_str() {
        "stream" => " (realtime stream)".to_string(),
        "activity" => String::new(),
        _ => format!(" every {interval}s"),
    };
    let mut status = format!("{}{kind} watchdog{cadence}", if once { "armed — ONE-SHOT " } else { "armed — " });
    status.push_str(&if fire_mode == "silence" {
        format!(". Silence for {}s arrives as mail from \"{name}\"", quiet.unwrap_or(0))
    } else {
        format!(". A matching event arrives as mail from \"{name}\"")
    });
    status.push_str(if notice {
        " and waits in your mailbox WITHOUT starting a turn — you read it whenever you next run"
    } else {
        " and wakes you"
    });
    if once {
        status.push_str(". It then REMOVES ITSELF — one fire, then gone, so you will not see it again and `list` will not show it");
    }
    status.push_str("; it costs no credits.");
    if smoked["broken"].as_bool().unwrap_or(false) {
        status = format!(
            "⚠ ARMED BUT ITS TARGET DOES NOT WORK — see `smoke`. This dog will sit `armed, fired: 0` forever, which looks exactly like the condition never happening. Fix the target and re-create it. {status}"
        );
    }
    let mut out = json!({ "id": id, "name": name, "notice": notice, "shell": shell, "fire_mode": fire_mode, "once": once,
                          "status": status, "smoke": smoked });
    if let Some(q) = quiet {
        out["quiet_period_s"] = json!(q);
    }
    Ok(out)
}

/// pause / resume / remove / supersede, by the owner, a superior, or the user (`actor: None`).
#[logged]
pub async fn act(engine: &Arc<Engine>, org_id: i64, actor: Option<i64>, id: &str, action: &str, reason: Option<&str>) -> Result<Value> {
    let Some(dog) = load(engine, id).await? else { refuse!(NotFound, "no watchdog {id}") };
    if dog.org_id != org_id || dog.state == "removed" {
        refuse!(NotFound, "no watchdog {id}");
    }
    if !may_manage(engine, actor, dog.owner).await? {
        refuse!(Forbidden, "only its owner and the owner's superiors manage this watchdog");
    }
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    let client = engine.db.get().await?;
    let state = match action {
        "pause" => {
            if dog.state == "spent" {
                refuse!(Conflict, "a spent one-shot watchdog has nothing left to pause");
            }
            client
                .execute("UPDATE ot.watchdogs SET state = 'paused', memo = memo - 'paused_why' WHERE uid = $1", &[&id])
                .await?;
            "paused"
        }
        "resume" => {
            if dog.state == "spent" {
                refuse!(Conflict, "a spent one-shot watchdog cannot be resumed; create a new one");
            }
            if !dog.owner_live {
                refuse!(Conflict, "its owner {} is not live; rehire it first", dog.owner_name);
            }
            client
                .execute(
                    "UPDATE ot.watchdogs SET state = 'armed', exit = NULL,
                            silence_since = CASE WHEN fire_mode = 'silence' THEN now() ELSE silence_since END,
                            memo = (memo - 'paused_why' - 'paused_by') #- '{run,alerted}' #- '{run,broken}'
                      WHERE uid = $1",
                    &[&id],
                )
                .await?;
            "armed"
        }
        "remove" => {
            client
                .execute(
                    "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', $2::text) WHERE uid = $1",
                    &[&id, &reason],
                )
                .await?;
            "removed"
        }
        "supersede" => {
            let Some(why) = reason else { refuse!(BadRequest, "supersede requires a reason explaining why this wait is obsolete") };
            if !dog.once {
                refuse!(Conflict, "only a one-shot watchdog can be superseded; remove a persistent watchdog");
            }
            client
                .execute(
                    "UPDATE ot.watchdogs SET state = 'spent', spent_at = now(),
                            memo = memo || jsonb_build_object('reason', $2::text, 'superseded', true) WHERE uid = $1",
                    &[&id, &why],
                )
                .await?;
            "superseded"
        }
        other => refuse!(BadRequest, "action must be pause|resume|remove|supersede, not {other}"),
    };
    let by = match actor {
        Some(a) => client.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&a]).await?.get::<_, String>(0),
        None => "@user".to_string(),
    };
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, $2, $3, $4, $5)",
            &[&org_id, &format!("watchdog_{action}"), &by, &dog.owner, &json!({ "id": id, "name": dog.name, "reason": reason })],
        )
        .await?;
    drop(client);
    if state == "armed" {
        disarm(engine, id);
        arm(engine, id);
    } else {
        disarm(engine, id);
    }
    changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Events]);
    let mut out = json!({ "id": id, "name": dog.name, "state": state });
    if let Some(r) = reason {
        out["reason"] = json!(r);
    }
    Ok(out)
}

/// `orgtree_watchdog list`: the caller's dogs and its team's, with the
/// evidence that tells a quiet dog from a broken one.
#[logged]
pub async fn list(engine: &Engine, agent: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    let sql = format!(
        "WITH RECURSIVE down(id, depth) AS (SELECT $1::bigint, 0 UNION ALL
           SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id WHERE d.depth < 1024)
         SELECT {DOG_COLS}, w.last_check FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
          WHERE w.owner_agent_id IN (SELECT id FROM down) AND w.state IN ('armed', 'paused', 'exited')
          ORDER BY w.id"
    );
    let rows = client.query(&sql, &[&agent]).await?;
    let dogs: Vec<Value> = rows
        .iter()
        .map(|r| {
            let d = dog_of(r);
            let last_check: Option<DateTime<Utc>> = r.get(22);
            let mut v = json!({
                "id": d.uid, "owner": d.owner_name, "name": d.name, "kind": d.kind, "target": d.target,
                "interval_s": d.interval_s, "state": d.state, "fired": d.fired, "once": d.once, "notice": d.notice(),
                "shell": d.shell.clone().unwrap_or_else(|| "native".into()), "fire_mode": d.fire_mode,
                "checks_run": d.run_i64("checks_run"),
            });
            let mut put = |k: &str, x: Value| {
                if !x.is_null() {
                    v[k] = x;
                }
            };
            put("pattern", json!(d.pattern));
            put("last_fired", json!(d.last_fired.map(iso)));
            put("last_check", json!(last_check.map(iso)));
            put("last_output", d.run["last_output"].clone());
            put("last_exit", d.run["last_exit"].clone());
            put("paused_why", d.memo["paused_why"].clone());
            put("exit", json!(d.exit));
            put("quiet_period_s", json!(d.quiet_s));
            put("silence_since", json!(d.silence_since.map(iso)));
            put("health", json!(health(&d)));
            v
        })
        .collect();
    Ok(json!({ "watchdogs": dogs }))
}

/// A plain-words warning about a dog that is quietly not working.
fn health(d: &Dog) -> Option<String> {
    if d.state != "armed" {
        return None;
    }
    let runs = d.run_i64("checks_run");
    let age = (Utc::now() - d.created_at).num_seconds();
    let out = d.run["last_output"].as_str().unwrap_or("");
    if d.silence() {
        return Some(format!(
            "on silence: {}s without a matching event{}",
            d.quiet_s.unwrap_or(0),
            if d.exit.is_some() { "; stream exited — resume to restart the listener" } else { "" }
        ));
    }
    if let Some(sig) = broken_sig(out) {
        return Some(format!(
            "⚠ BROKEN — the target does not run: its output says \"{sig}\". This dog can never fire. Its last output was: {:?}",
            gist(out, 200)
        ));
    }
    if let Some(lost) = subject_lost(d) {
        return Some(format!("⚠ {} — {}", lost.headline, lost.advice));
    }
    match d.kind.as_str() {
        "stream" => (runs == 0 && age >= QUIET_AGE_S).then(|| {
            format!(
                "⚠ armed {} ago and has read ZERO output lines — verify the command actually streams (and that it is still alive; a stream that EXITS moves to state 'exited').",
                hours(age)
            )
        }),
        "activity" => None,
        _ if runs == 0 => (age >= NEVER_RAN_AGE_S)
            .then(|| format!("⚠ armed {} ago but has NEVER RUN A CHECK — the engine has not picked it up; report this.", hours(age))),
        _ => (d.fired == 0 && runs >= QUIET_CHECKS && age >= QUIET_AGE_S).then(|| {
            format!(
                "⚠ {runs} checks over {} and NEVER matched. Either the condition genuinely has not happened, or the target/pattern is wrong — `last_output` is what this dog actually sees: {}",
                hours(age),
                if out.is_empty() { "NOTHING AT ALL (the target produces no output).".to_string() } else { format!("{:?}", gist(out, 200)) }
            )
        }),
    }
}

/// Pause the armed dogs of agents leaving the tree (archive); returns their ids.
#[logged]
pub async fn pause_owned(tx: &tokio_postgres::Transaction<'_>, owners: &[i64]) -> Result<Vec<String>> {
    let rows = tx
        .query(
            "UPDATE ot.watchdogs SET state = 'paused', memo = memo || jsonb_build_object('paused_why', $2::text)
              WHERE owner_agent_id = ANY($1) AND state = 'armed' RETURNING uid",
            &[&owners, &ARCHIVE_PAUSE],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Re-arm the dogs an archive paused (rehire); returns (id, name) pairs.
#[logged]
pub async fn resume_owned(tx: &tokio_postgres::Transaction<'_>, owner: i64) -> Result<Vec<(String, String)>> {
    let rows = tx
        .query(
            "UPDATE ot.watchdogs SET state = 'armed', memo = memo - 'paused_why',
                    silence_since = CASE WHEN fire_mode = 'silence' THEN now() ELSE silence_since END
              WHERE owner_agent_id = $1 AND state = 'paused' AND memo->>'paused_why' = $2 RETURNING uid, name",
            &[&owner, &ARCHIVE_PAUSE],
        )
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}
