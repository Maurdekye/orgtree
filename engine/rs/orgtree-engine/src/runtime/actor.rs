//! One agent's actor: its turns, its CLI process, its live state. Everything
//! about a running agent is owned here and changed only by messages on its
//! channel; the rest of the engine reads the snapshot it publishes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::time::sleep_until;

use crate::domain::scope;
use crate::engine::Engine;
use crate::changes::Change;
use crate::orgs::OrgHandle;
use crate::providers::catalog;
use crate::runtime::claude::{self, ClaudeProc, SpawnSpec};
use crate::runtime::codex::{self as codexrt, CodexProc, CodexSpec};
use crate::runtime::agy::{self as agyrt, AgyProc, AgySpec};
use crate::runtime::muse::{self as musert, MuseProc, MuseSpec};
use crate::runtime::opencode::{self as opencodert, OpenCodeProc};
use crate::runtime::acp_scope;
use crate::runtime::convo::{self, ConvoWriter};
use crate::runtime::prompt::{self, Mail};
use crate::runtime::sched::Slot;
use crate::runtime::startup;
use crate::runtime::{freeze, keepalive, recovery, tasks, AgentHandle, AgentMsg, AgentTx, Caller, Envelope, Post};
use crate::util::{gist, iso, now_iso};

/// What `/chat` needs from a running actor.
#[derive(Clone, Default, Debug)]
pub struct LiveView {
    pub busy: bool,
    /// when the running turn was admitted (`turn_started_at`): every call of
    /// that turn starts after it, so the desk times only those live
    pub turn_started_at: Option<String>,
    pub turn_activity: bool,
    pub draft_epoch: String,
    pub init: Value,
    pub last_error: Option<String>,
    pub transient: Vec<Value>,
    pub mcp_waiting: bool,
    pub mcp_state: Option<String>,
    pub mcp_reason: Option<String>,
}

const KEEP_ALIVE: Duration = Duration::from_secs(600);
const ACTOR_IDLE_EXIT: Duration = Duration::from_secs(60);
const MCP_WAIT: Duration = Duration::from_secs(30);
/// The language-server lane's own Claude config folder and Codex home
/// (under `<data>\profiles`): no login lives there, so none can reach a server.
const LANGSERVER_CLAUDE_CONFIG: &str = "langserver-claude";
const LANGSERVER_CODEX_HOME: &str = crate::langserver::CODEX_HOME_DIR;

#[logged]
pub fn spawn(engine: Arc<Engine>, handle: Arc<AgentHandle>, rx: mpsc::UnboundedReceiver<Envelope>) {
    let cause = crate::trace::current_rq();
    let origin = tracing::Span::current();
    tokio::spawn(tracing::Instrument::instrument(async move {
        let id = handle.id;
        // Read the existing startup row before entering the actor's named request.
        // No second identity query, and no connection is kept by the running actor.
        let loaded: Result<_> = async {
            let client = engine.db.get().await?;
            let row = client
                .query_one(
                    "SELECT name, coalesce((extra->>'cost_seen')::float8, 0), tier, extra->'cache_receipt', kind FROM ot.agents WHERE id = $1",
                    &[&handle.id],
                )
                .await?;
            Ok((client, row))
        }.await;
        match loaded {
            // a project node runs no turns, whatever asked for its actor
            // (docs/rust-engine/PROJECT-NODES.md): its queued messages drop
            // with the channel, and their reply senders with them
            Ok((_, row)) if row.get::<_, String>(4) == crate::domain::projects::KIND => {
                tracing::info!(agent = id, "a project node has no actor; the request is dropped");
                engine.agents.remove_if(id, &handle);
            }
            Ok((client, row)) => {
                let name: String = row.get(0);
                let span = crate::trace::request_from(&crate::trace::agent_client(id, &name), cause.as_deref());
                tracing::Instrument::instrument(async {
                    match Actor::new(engine.clone(), handle.clone(), Startup { connection: client, row }).await {
                        Ok(actor) => actor.run(rx).await,
                        Err(e) => tracing::warn!(agent = id, error = %format!("{e:#}"), "agent actor could not start"),
                    }
                    engine.agents.remove_if(id, &handle);
                }, span).await;
            }
            Err(e) => {
                tracing::warn!(agent = id, error = %format!("{e:#}"), "agent identity could not be read");
                engine.agents.remove_if(id, &handle);
            }
        }
    }, origin));
}

/// Everything about the agent a turn needs, read fresh before each spawn.
#[derive(Clone)]
struct Ctx {
    org_name: String,
    org_slug: String,
    killswitch: bool,
    name: String,
    title: String,
    tier: String,
    model: String,
    provider: String,
    account: Option<String>,
    api_key: Option<String>,
    effective: Value,
    charter: Option<String>,
    /// the superior's team charter (what binds this agent's team)
    team_charter: Option<String>,
    /// this agent's own team charter (what it gives its team)
    own_team_charter: Option<String>,
    /// ancestors' team charters, root first: (name, charter)
    cascade: Vec<(String, String)>,
    /// the superior's name (None: top-level)
    superior: Option<String>,
    /// holds the org-inbox audience
    extern_holder: bool,
    org_md: Option<String>,
    /// the org's shared notes folder (`Config::org_notes_dir`) and its
    /// AGENTS.md as read now; a CLI is given the text when it starts
    org_notes_dir: PathBuf,
    org_notes: Option<String>,
    /// each team workspace's AGENTS.md as read now, nearest first: (file, label, text)
    team_notes: Vec<(PathBuf, String, Option<String>)>,
    session_id: Option<String>,
    session_provider: Option<String>,
    /// its preference over the user's sessions (scope `session`)
    session_pref: crate::runtime::session_host::Pref,
    generation: i32,
    state: String,
    halted: bool,
    frozen: bool,
    top_level: bool,
    scratch: PathBuf,
    effort: String,
    fallback: bool,
    /// an OpenRouter seat's harness: claude-code or codex-cli (the one its
    /// session runs on: its stamp, else the one it should run on)
    harness: Option<String>,
    /// an OpenRouter seat: its stamp (`extra.harness`) and the harness it
    /// should run on (`openrouter::seat_harness`: its pin, else its key's);
    /// `start_turn` moves it across when they differ
    harness_stamp: Option<String>,
    harness_want: Option<String>,
    /// the org's compaction threshold, a fraction of the context window:
    /// the CLI compacts the session when its context passes it
    compact_at: f64,
    /// "reset a session before a known-cold turn" (agent override, else the
    /// org's): the context occupancy above which it applies
    cold_reset: Option<f64>,
    occupancy: Option<i32>,
    context_window: Option<i32>,
    context_measured: bool,
    limit_locked: bool,
    /// the earlier session could not be carried over: why (the next turn
    /// starts with a handoff note)
    handoff_due: Option<String>,
}

/// How a gateway seat reaches its endpoint: OpenRouter, or one of the
/// user's language servers (`local`). The key never prints.
struct OrRoute {
    key: String,
    codex: bool,
    reasoning: bool,
    local: Option<crate::langserver::Route>,
}

impl std::fmt::Debug for OrRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OrRoute {{ key: *****, codex: {}, reasoning: {}, local: {:?} }}", self.codex, self.reasoning, self.local)
    }
}

impl std::fmt::Debug for Ctx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ctx")
            .field("name", &self.name)
            .field("org", &self.org_slug)
            .field("tier", &self.tier)
            .field("model", &self.model)
            .field("provider", &self.provider)
            .field("account", &self.account)
            .field("api_key", &self.api_key.as_ref().map(|_| "*****"))
            .field("state", &self.state)
            .field("halted", &self.halted)
            .field("frozen", &self.frozen)
            .field("killswitch", &self.killswitch)
            .field("session_id", &self.session_id)
            .field("generation", &self.generation)
            .field("effort", &self.effort)
            .field("fallback", &self.fallback)
            .field("harness", &self.harness)
            .field("harness_want", &self.harness_want)
            .field("scratch", &self.scratch)
            .field("effective", &self.effective)
            .finish()
    }
}

/// The launch of a CLI process for an agent, before anything is written.
struct Plan {
    skills: crate::providers::skills::Registry,
    identity: String,
    settings: Value,
    mcp: Value,
    disallowed: Vec<String>,
    allowed: Vec<String>,
    add_dirs: Vec<String>,
    external: Vec<String>,
    print: Fingerprint,
    /// the org's shared notes block, the end of `identity`
    notes: String,
    /// where the standing notes begin in `identity`: everything before is
    /// engine-written rules (a lane with a per-file limit splits there)
    rules_len: usize,
}

/// A plan as the log shows it: granted MCP servers by name only (their
/// configuration can hold environment, headers and arguments that are
/// credentials), never their values.
impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let servers: Vec<&String> = self.mcp["mcpServers"].as_object().map(|m| m.keys().collect()).unwrap_or_default();
        f.debug_struct("Plan")
            .field("identity", &self.identity.len())
            .field("settings", &self.settings)
            .field("mcp_servers", &servers)
            .field("disallowed", &self.disallowed)
            .field("allowed", &self.allowed)
            .field("add_dirs", &self.add_dirs)
            .field("external", &self.external)
            .field("print", &self.print)
            .field("notes", &self.notes.len())
            .field("rules_len", &self.rules_len)
            .finish()
    }
}

/// A running prompt-cache keepalive (`keepalive.rs`): a forked CLI making one
/// disposable read of the agent's session prefix.
struct Keepalive {
    proc: ClaudeProc,
    process: uuid::Uuid,
    /// the session it forked
    session: String,
    /// the fork the CLI made, once it says (its transcript is removed after)
    fork: Option<String>,
    started: Instant,
    /// the CLI's folder of session transcripts for this agent
    sessions_dir: PathBuf,
    account: Option<String>,
    apikey: bool,
    print: Fingerprint,
    result: Option<Value>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

/// How a keepalive ended.
enum KeepaliveEnd {
    /// its CLI answered (well or not)
    Done,
    /// real work needed the agent (not a failure: no backoff)
    Cancelled,
    Failed(&'static str),
}

/// Muse: one tool call of the running turn that has not settled.
#[derive(Debug, Clone)]
struct MuseTool {
    name: String,
    /// Muse moved it to the background: the turn no longer waits on it
    background: bool,
    /// when Orgtree asked the host to stop it, and the silence limit (s) it passed
    stop_asked: Option<(Instant, u64)>,
}

/// Muse: a tool call Muse moved to the background. It can outlive its turn,
/// so it is followed by the actor until its item settles or its host ends.
#[derive(Debug, Clone)]
struct MuseBg {
    /// the transcript row its chip is drawn in
    seq: i64,
    name: String,
    /// the chip's argument (the command)
    arg: String,
}

/// Claude: a background task of the agent's CLI (a command run in the
/// background, a background subagent) whose call's chip is known. It can
/// outlive its turn, so it is followed by the actor until the CLI reports its
/// end or the CLI ends.
#[derive(Debug, Clone)]
struct ClaudeBg {
    /// the transcript row its chip is drawn in
    seq: i64,
    /// the call's tool-use id: its chip's id
    tool: String,
    name: String,
    /// the chip's label
    arg: String,
    /// a shell command: what it printed is in the CLI's `.output` file
    shell: bool,
}

/// How often at most the cancels of turns a CLI or Muse host started by
/// itself are warned about: a Muse host holding a background result for an
/// idle agent starts one again at once after each cancel (measured on Muse
/// 1.4.6: every ~55 ms, 332 times in 19 s); Claude Code starts one per
/// notification and does not retry it (2.1.292).
const OWN_TURN_WARN_EVERY: Duration = Duration::from_secs(60);

/// How long after a turn ends a turn the CLI or Muse host starts by itself
/// shows that a background result which settled during that turn was not
/// taken by it (its last model step had begun): each starts one at once when
/// it holds a result and no turn runs (measured: Muse 15-40 ms after the
/// result, Claude Code 40-110 ms).
const BG_GRACE: Duration = Duration::from_secs(3);

/// A turn whose CLI ran in the user's signed-in session and ended with it
/// (docket option-to-run-the-background-engine-in-the-user-s): the error that
/// gives a turn with no output its mail back, and the transcript's row.
const SESSION_ENDED: &str = "the user's Windows session ended";
const SESSION_ENDED_ROW: &str = "The user's Windows session ended during this turn, which stopped there; a new turn continues it.";
/// How long a hosted CLI's exit waits for its sign-in helper to go too:
/// Windows can end the CLI a moment before the helper at sign-out.
const SESSION_GONE_WAIT: Duration = Duration::from_secs(2);

/// Whether a CLI's exit may be the user's Windows session ending under a turn
/// (if its sign-in helper is gone too), which a new turn then continues at
/// once wherever the turn-start rule places it: only a CLI a helper started,
/// during a turn that nobody ended on purpose (the user, 2026-10-16 11:03Z:
/// no resume after an interrupt, halt or retirement).
#[logged]
fn may_be_session_end(hosted: bool, in_turn: bool, deliberate: bool) -> bool {
    hosted && in_turn && !deliberate
}

/// Whether the sign-in helper that started a CLI (`host`) has gone, given
/// the live helpers (`live`: session, then the helper's pid and process
/// creation stamp): its own lease, so a CLI whose session ended counts while
/// another of the user's sessions stays hosted (rig-sol-b, 2026-10-16), and a
/// later helper in its session is not the one that started it.
#[logged]
fn helper_gone(host: crate::runtime::session_host::Host, live: &[(u32, (u32, u64))]) -> bool {
    !live.iter().any(|&(session, helper)| session == host.session && helper == host.helper)
}

/// Where an agent's last turn ran (`ot.agents.extra->>'session'`).
const SIGNED_IN: &str = "signed-in";
const SESSION0: &str = "session0";
/// How long after the engine's start a first turn waits for the sign-in
/// helper to register again (coordinator ruling D, 2026-10-16).
pub(crate) const SESSION_SETTLE: Duration = Duration::from_secs(15);
static SETTLE_EXPIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct Turn {
    id: i64,
    started: Instant,
    admitted_at: DateTime<Utc>,
    serving_account: Option<String>,
    serving_provider: String,
    serving_tier: String,
    limit_signal: bool,
    last_event: Instant,
    /// API message id → (convo seq, the row as built so far)
    rows: HashMap<String, (i64, Value)>,
    /// tool_use_id → API message id
    tools: HashMap<String, String>,
    interrupted: bool,
    killed: bool,
    /// the CLI produced something for this turn (so it holds the prompt)
    activity: bool,
    /// Exact opening batch, settled when this turn first shows CLI activity.
    /// Never include an Antigravity handoff the hook has not consumed.
    opening_mail: Vec<i64>,
    /// Opening text sizes only, for a later provider length refusal.
    input_shape: Option<(usize, usize, usize)>,
    alert_turn: Option<crate::runtime::watchdogs::events::AlertTurn>,
    usage: Value,
    model: Option<String>,
    draft: String,
    thinking: String,
    partial_serial: u64,
    draft_order: Option<u64>,
    thinking_order: Option<u64>,
    tool_writing: super::toolwriting::ToolWriting,
    compact: bool,
    /// the request this turn's CLI stream is logged under
    span: tracing::Span,
    /// cards `orgtree_*` tools attached to their chips, by tool_use_id
    cards: HashMap<String, Value>,
    /// Codex/Muse: this turn's id on the thread (session)
    codex_turn: Option<String>,
    /// Codex: the thread's token total before this turn
    usage_base: Option<Value>,
    /// Codex/Muse: the assistant row tool chips attach to
    codex_row: Option<String>,
    /// Codex: the last error the server reported (it ends with `turn/completed`)
    codex_error: Option<String>,
    /// Muse: the turn's typed failure (kind, the host's retry judgment)
    muse_error: Option<(String, bool)>,
    /// Muse: a typed quota refusal's reset (`error.quota.resetsAtMs`)
    muse_quota: Option<DateTime<Utc>>,
    /// Muse: the kind of each open item, by item id (deltas name only the id)
    muse_items: HashMap<String, String>,
    /// Muse: the turn's tool calls in flight, by item id (MSP: a tool
    /// call's item id is its task id)
    muse_tools: HashMap<String, MuseTool>,
    acp_items: HashMap<String, Value>,
    acp: bool,
    /// One persisted runner-startup diagnostic and steer attempt per turn.
    codex_runner_hint: bool,
    /// approvals declined during the turn
    denials: Vec<Value>,
    /// Antigravity: response text so far, by step
    agy_text: HashMap<i64, String>,
    /// Antigravity: mid-turn mail handed to the steer hook and not yet
    /// emitted: (handoff id, mail ids, the claimed mail rows)
    agy_steer: Option<(String, Vec<i64>, Vec<Value>)>,
    /// the CLI exited before this turn's result (died in flight, P34)
    exited: bool,
    /// its CLI ran in the user's session and ended with it (`on_exit`): the
    /// turn stops cleanly and a new turn continues it, no failure
    session_ended: bool,
    /// the agent ended this turn itself and asked for a new one at once
    /// (orgtree_interrupt on itself with `restart`)
    restart: bool,
    /// Codex/Antigravity: the mail this turn was given, without the envelope;
    /// a usage-limit freeze keeps it for the wake (3.x `resume_texts`)
    replay: String,
}

#[logged]
impl Turn {
    fn new(id: i64, compact: bool) -> Turn {
        Turn {
            id,
            started: Instant::now(),
            admitted_at: Utc::now(),
            serving_account: None,
            serving_provider: String::new(),
            serving_tier: String::new(),
            limit_signal: false,
            last_event: Instant::now(),
            rows: HashMap::new(),
            tools: HashMap::new(),
            interrupted: false,
            killed: false,
            activity: false,
            opening_mail: Vec::new(),
            input_shape: None,
            alert_turn: None,
            usage: Value::Null,
            model: None,
            draft: String::new(),
            thinking: String::new(),
            partial_serial: 0,
            draft_order: None,
            thinking_order: None,
            tool_writing: super::toolwriting::ToolWriting::default(),
            compact,
            cards: HashMap::new(),
            span: tracing::Span::none(),
            codex_turn: None,
            usage_base: None,
            codex_row: None,
            codex_error: None,
            muse_error: None,
            muse_quota: None,
            muse_items: HashMap::new(),
            muse_tools: HashMap::new(),
            acp_items: HashMap::new(),
            acp: false,
            codex_runner_hint: false,
            denials: Vec::new(),
            agy_text: HashMap::new(),
            agy_steer: None,
            exited: false,
            session_ended: false,
            restart: false,
            replay: String::new(),
        }
    }
}

/// The agent's CLI process: Claude Code, the Codex app-server, Antigravity
/// or the Muse Code host.
enum Proc {
    Claude(ClaudeProc),
    Codex(CodexProc),
    Agy(AgyProc),
    Muse(MuseProc),
    Acp(OpenCodeProc),
}

#[logged]
impl Proc {
    #[nolog]
    fn process(&self) -> uuid::Uuid {
        match self {
            Proc::Claude(p) => p.process,
            Proc::Codex(p) => p.process,
            Proc::Agy(p) => p.process,
            Proc::Muse(p) => p.process,
            Proc::Acp(p) => p.process,
        }
    }

    async fn exit_status(&mut self, reason: &str) -> String {
        match self {
            Proc::Claude(p) => p.exit_status(reason).await,
            Proc::Codex(p) => p.exit_status(reason).await,
            Proc::Agy(p) => p.exit_status(reason).await,
            Proc::Muse(p) => p.exit_status(reason).await,
            Proc::Acp(p) => p.exit_status(reason).await,
        }
    }

    #[nolog]
    fn alive(&mut self) -> bool {
        match self {
            Proc::Claude(p) => p.alive(),
            Proc::Codex(p) => p.alive(),
            Proc::Agy(p) => p.alive(),
            Proc::Muse(p) => p.alive(),
            Proc::Acp(p) => p.alive(),
        }
    }

    #[nolog]
    fn pid(&self) -> u32 {
        match self {
            Proc::Claude(p) => p.pid,
            Proc::Codex(p) => p.pid,
            Proc::Agy(p) => p.pid,
            Proc::Muse(p) => p.pid,
            Proc::Acp(p) => p.pid,
        }
    }

    /// The user's session the sign-in helper started it in.
    #[nolog]
    fn hosted_in(&self) -> Option<u32> {
        match self {
            Proc::Claude(p) => p.hosted_in(),
            Proc::Codex(p) => p.hosted_in(),
            Proc::Agy(p) => p.hosted_in(),
            Proc::Muse(p) => p.hosted_in(),
            Proc::Acp(p) => p.hosted_in(),
        }
    }

    /// The sign-in helper that started it.
    #[nolog]
    fn host(&self) -> Option<crate::runtime::session_host::Host> {
        match self {
            Proc::Claude(p) => p.host(),
            Proc::Codex(p) => p.host(),
            Proc::Agy(p) => p.host(),
            Proc::Muse(p) => p.host(),
            Proc::Acp(p) => p.host(),
        }
    }

    /// Started by the sign-in helper in the operator's signed-in session.
    #[nolog]
    fn hosted(&self) -> bool {
        match self {
            Proc::Claude(p) => p.hosted(),
            Proc::Codex(p) => p.hosted(),
            Proc::Agy(p) => p.hosted(),
            Proc::Muse(p) => p.hosted(),
            Proc::Acp(p) => p.hosted(),
        }
    }

    /// Ask the running turn to stop (`codex_turn`: the Codex or Muse turn id).
    fn interrupt(&self, codex_turn: Option<&str>) -> bool {
        match (self, codex_turn) {
            (Proc::Claude(p), _) => p.interrupt(),
            (Proc::Codex(p), Some(t)) => p.interrupt(t),
            (Proc::Muse(p), Some(t)) => p.interrupt(t),
            (Proc::Codex(_) | Proc::Muse(_), None) => false,
            (Proc::Agy(p), _) => p.interrupt(),
            (Proc::Acp(p), _) => p.interrupt(),
        }
    }

    /// A live effort change (Claude only; Codex and Muse take it at the next turn).
    fn set_effort(&self, level: &str) -> bool {
        match self {
            Proc::Claude(p) => p.set_effort(level),
            Proc::Codex(_) | Proc::Agy(_) | Proc::Muse(_) | Proc::Acp(_) => false,
        }
    }

    async fn close(&mut self) {
        match self {
            Proc::Claude(p) => p.close().await,
            Proc::Codex(p) => p.close().await,
            Proc::Agy(p) => p.close().await,
            Proc::Muse(p) => p.close().await,
            Proc::Acp(p) => p.close().await,
        }
    }

    async fn kill(&mut self) {
        match self {
            Proc::Claude(p) => p.kill().await,
            Proc::Codex(p) => p.kill().await,
            Proc::Agy(p) => p.kill().await,
            Proc::Muse(p) => p.kill().await,
            Proc::Acp(p) => p.close().await,
        }
    }

    #[nolog]
    fn is_acp(&self) -> bool { matches!(self, Proc::Acp(_)) }

    #[nolog]
    fn is_codex(&self) -> bool {
        matches!(self, Proc::Codex(_))
    }

    #[nolog]
    fn is_agy(&self) -> bool {
        matches!(self, Proc::Agy(_))
    }

    #[nolog]
    fn is_muse(&self) -> bool {
        matches!(self, Proc::Muse(_))
    }
}

#[derive(Clone, Debug)]
struct Fingerprint {
    parts: Vec<(&'static str, String)>,
    instructions: Option<super::next_turn::Instructions>,
    compact_at: Option<f64>,
    /// the digest of the org's shared notes the launch delivers (None: a
    /// fingerprint saved before it existed). Never part of equality: a warm
    /// CLI keeps the copy it started with (coordinator ruling (b),
    /// 2026-10-13); the forecast compares it when a CLI would start.
    org_notes: Option<String>,
}

/// Equal when a warm CLI may serve the launch: every part but the org's
/// shared notes.
impl PartialEq for Fingerprint {
    fn eq(&self, other: &Fingerprint) -> bool {
        self.parts == other.parts
    }
}

/// The fingerprint's parts, in `plan`'s order. `startup` is the digest of the
/// instruction files the CLI reads when it starts (runtime/startup.rs). A
/// fingerprint saved before it existed reads as unknown, never as changed.
const PRINT_PARTS: [&str; 7] = ["system_prompt", "tools", "model", "permission_mode", "folders", "account", "startup"];
/// The org's shared notes, kept beside the parts (`Fingerprint::org_notes`).
const ORG_NOTES_PART: &str = "org_notes";
/// An idle agent re-reads its startup files this often, so an edit shows in
/// its forecast and its parked CLI is replaced before the next turn.
const STARTUP_RECHECK: Duration = Duration::from_secs(20);
/// A refused admission retries after a quarter second, doubling to a minute
/// while refusals repeat: never at once, so none can spin (decision 62).
const ADMIT_RETRY_FIRST: Duration = Duration::from_millis(250);
const ADMIT_RETRY_MAX: Duration = Duration::from_secs(60);

#[nolog] // private launch metadata: never serialize it to a trace
impl Fingerprint {
    fn to_json(&self) -> Value {
        let notes = self.org_notes.iter().map(|v| json!([ORG_NOTES_PART, v]));
        let files = self.instructions.iter().map(|v| json!(["instruction_files", v]));
        let compact = self.compact_at.iter().map(|v| json!(["compact_at", v]));
        json!(self.parts.iter().map(|(k, v)| json!([k, v])).chain(notes).chain(files).chain(compact).collect::<Vec<_>>())
    }

    fn from_json(v: &Value) -> Option<Fingerprint> {
        let all = v.as_array()?;
        let is_notes = |p: &&Value| p.get(0).and_then(Value::as_str) == Some(ORG_NOTES_PART);
        let org_notes = all.iter().find(is_notes).and_then(|p| p.get(1)?.as_str().map(str::to_string));
        let parts = all
            .iter()
            .filter(|p| !is_notes(p) && !matches!(p.get(0).and_then(Value::as_str), Some("instruction_files" | "compact_at")))
            .map(|p| {
                let name = p.get(0)?.as_str()?;
                let k = PRINT_PARTS.iter().find(|n| **n == name)?;
                Some((*k, p.get(1)?.as_str()?.to_string()))
            })
            .collect::<Option<Vec<_>>>()?;
        let instructions = all.iter().find(|p| p.get(0).and_then(Value::as_str) == Some("instruction_files"))
            .and_then(|p| serde_json::from_value(p[1].clone()).ok());
        let compact_at = all.iter().find(|p| p.get(0).and_then(Value::as_str) == Some("compact_at")).and_then(|p| p[1].as_f64());
        (parts.len() == PRINT_PARTS.len()).then_some(Fingerprint { parts, org_notes, instructions, compact_at })
    }

    fn part(&self, name: &str) -> Option<&str> {
        self.parts.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    fn changed(&self, other: &Fingerprint) -> Vec<String> {
        self.parts
            .iter()
            .zip(other.parts.iter())
            .filter(|(a, b)| a.1 != b.1)
            .map(|(a, _)| a.0.to_string())
            .collect()
    }
}

/// A fingerprint part's digest. Not logged: its input is the launch's own
/// material, the granted MCP servers' configuration (environment, headers,
/// arguments that can be credentials) included; the digest is what is kept.
#[nolog]
fn hash(s: &str) -> String {
    hex::encode(&Sha256::digest(s.as_bytes())[..12])
}

/// Launch, idle recheck and forecast must compare the same startup namespace.
#[nolog]
fn shared_startup_digest(startup_digest: &str, skills: &crate::providers::skills::Registry) -> String {
    hash(&format!("{}|skills:{}", startup_digest, skills.digest))
}

#[nolog]
fn skill_folders(ctx: &Ctx) -> Vec<PathBuf> {
    let mut folders = vec![ctx.scratch.clone()];
    folders.extend(ctx.effective["add_dirs"].as_array().into_iter().flatten()
        .filter_map(|d| d["path"].as_str()).map(PathBuf::from));
    folders
}

#[derive(Default)]
struct McpState {
    waiting: bool,
    state: Option<String>,
    reason: Option<String>,
    count: Option<i64>,
    last_turn_count: Option<i64>,
}

struct Actor {
    engine: Arc<Engine>,
    handle: Arc<AgentHandle>,
    org: Arc<OrgHandle>,
    id: i64,
    org_id: i64,
    name: String,
    tx: AgentTx,
    /// `agent:<id>/<name>`: this agent as a log client
    client: String,
    /// the request stray CLI output is logged under (outside any turn)
    span: tracing::Span,
    proc: Option<Proc>,
    proc_print: Option<Fingerprint>,
    /// the org's shared notes block the running CLI started with: a
    /// keepalive reads that CLI's prefix, not the file as it is now
    proc_notes: Option<String>,
    /// the startup files of the last forecast, and when they were last re-read
    startup_seen: Option<(startup::Inputs, Vec<PathBuf>, String)>,
    startup_checked: Instant,
    proc_effort: Option<String>,
    pending_effort: Option<String>,
    parked: bool,
    slot: Option<Slot>,
    waiting_since: Option<DateTime<Utc>>,
    /// a language server loading this turn's model before its CLI starts (the desk's words)
    loading: Option<String>,
    /// the task that waits for the slot and loads the model first, while one may be loading
    warm_task: Option<tokio::task::AbortHandle>,
    /// Bounded diagnostic IDs only; the durable mailbox owns the messages.
    followup_mail: Vec<String>,
    turn: Option<Turn>,
    convo: ConvoWriter,
    init: Value,
    last_error: Option<String>,
    idle_since: Instant,
    keep_until: Option<Instant>,
    /// this actor's incarnation, the first half of `draft_epoch`
    born: String,
    /// `text` frames emitted (streamed text became durable), second half
    text_frames: u64,
    stopping: bool,
    mcp: McpState,
    forecast: Value,
    /// the fingerprint the last completed turn ran with
    sent_print: Option<Fingerprint>,
    /// (when, ttl seconds) of the last turn that read or wrote the cache
    receipt: Option<(DateTime<Utc>, i64)>,
    reconfigured: bool,
    /// the first turn since the engine started has waited for the sign-in
    /// helper (`session_settle`), and said where it started (`session_notes`)
    settled: bool,
    session_noted: bool,
    /// the seat counted as unsandboxed when its CLI's placement was last
    /// chosen (`session_host::wanted`), for `session_view`
    bypass_seat: bool,
    /// its preference over the user's sessions, as last loaded or saved
    session_pref: crate::runtime::session_host::Pref,
    /// the session it picked for its next turn (orgtree_session `use`; 0:
    /// Session 0), taken when that turn chooses where its CLI runs
    use_session: Option<u32>,
    /// the Codex launch's (may_write, permission mode, sandbox, hosted by the
    /// sign-in helper), chosen once per launch so its prompt matches its mode
    codex_seat: Option<(bool, String, codexrt::Sandbox, Option<u32>)>,
    activity: Option<(String, Option<String>)>,
    rate_limit: Option<Value>,
    /// the CLI's running session cost at the last result (its counter is cumulative)
    cost_seen: f64,
    /// Antigravity: the private folder its steer hook reads mid-turn mail from
    agy_steer_dir: Option<PathBuf>,
    /// the usage board last sent in full: (session, material key, its number)
    board_sent: Option<(Option<String>, String, u32)>,
    provider: String,
    /// Codex: the thread's latest cumulative token counts
    codex_total: Option<Value>,
    /// the CLI's subagents and background tasks (P33/P39)
    tasks: crate::runtime::tasks::Tasks,
    /// Private first-level helper output; never part of the parent's feed.
    helpers: std::collections::BTreeMap<(i64, String), super::helper_transcript::Transcript>,
    helper_due: Option<Instant>,
    /// Muse: the calls Muse moved to the background, by item id, until their
    /// item settles or their host ends
    muse_bg: HashMap<String, MuseBg>,
    /// Claude: background tasks whose chips are followed, by task id, until
    /// the CLI reports their end or the CLI ends
    claude_bg: HashMap<String, ClaudeBg>,
    /// turns the CLI or Muse host started by itself that Orgtree cancelled
    /// since the last warning about them, and when that warning was
    own_cancels: (u32, Option<Instant>),
    /// a background result reached the CLI while no turn ran: the CLI gives
    /// it to the next turn on this process, which is therefore kept for it
    bg_unread: bool,
    /// Claude: wake notes for results that reached an idle CLI, held back
    /// until the turn the CLI starts by itself for them is cancelled (so the
    /// agent's own turn never races it), or until `bg_wake_due` if none comes
    bg_wake: Vec<String>,
    bg_wake_due: Option<Instant>,
    /// Claude: the lines now arriving belong to a turn the CLI started by
    /// itself, cancelled here, until its result or the next turn's start
    claude_own: bool,
    /// A provider compaction in progress: its desk row's seq and body. Set
    /// only by a harness-reported start, never invented.
    compact_open: Option<(i64, Value)>,
    /// Codex: the compaction item closed the row, so `thread/compacted` adds none
    compact_settled: bool,
    /// wake notes for background results that settled while a turn ran: that
    /// turn took them, unless the CLI starts a turn of its own within
    /// `BG_GRACE` of its end (`bg_grace`), which shows it did not
    bg_in_turn: Vec<String>,
    bg_grace: Option<Instant>,
    /// the process is kept open only for its background work (warming off, or
    /// warming switched off or the idle cap asked it to close): not parked,
    /// so the idle cap neither counts nor evicts it (user 2026-10-14, gap 11)
    held: bool,
    /// waking mail arrived while a turn ran: when (the unread-mail check, P36)
    steer_since: Option<Instant>,
    /// mail whose sender was already told it waits unread (this turn)
    late_told: std::collections::HashSet<i64>,
    /// the running prompt-cache keepalive, if any
    keepalive: Option<Keepalive>,
    /// admissions refused in a row for a configuration change, and when the
    /// next try is due (decision 62)
    admit_refusals: u32,
    admit_retry: Option<Instant>,
    /// the message tool call being written, watched for its `metadata`
    /// (typing in Hubchat, `net::typing`)
    typing_probe: Option<TypingProbe>,
}

/// A message tool call's arguments as they stream in, until its `metadata`
/// is whole (typing in Hubchat, 2026-10-13).
struct TypingProbe {
    /// the content block's index in its message
    index: i64,
    /// the call's tool-use id
    call: String,
    buf: String,
    /// done reading: `metadata` seen (or not first, or too long)
    done: bool,
    /// typing was asked for: its block's end stops it
    started: bool,
}

// Opaque to the logging macro: connection internals are never log arguments.
struct Startup {
    connection: deadpool_postgres::Object,
    row: tokio_postgres::Row,
}

#[logged]
impl Actor {
    async fn new(engine: Arc<Engine>, handle: Arc<AgentHandle>, startup: Startup) -> Result<Actor> {
        let Startup { connection: client, row } = startup;
        let org = engine.orgs.by_id(handle.org_id).ok_or_else(|| anyhow!("organization not open"))?;
        let convo = ConvoWriter::load(&client, handle.id).await?;
        drop(client);
        let tier: String = row.get(2);
        let name: String = row.get(0);
        // the last turn's cache receipt and prompt fingerprint, kept across restarts
        let stored: Option<Value> = row.get(3);
        let receipt = stored.as_ref().and_then(|r| {
            Some((r["at"].as_str().and_then(crate::util::parse_ts)?, r["ttl"].as_i64()?))
        });
        let sent_print = stored.as_ref().and_then(|r| Fingerprint::from_json(&r["print"]));
        let client = crate::trace::agent_client(handle.id, &name);
        Ok(Actor {
            span: crate::trace::request(&client),
            client,
            tx: handle.tx.clone(),
            id: handle.id,
            org_id: handle.org_id,
            born: format!("{}.{}", engine.boot.id, crate::util::random_hex(3)),
            engine,
            handle,
            org,
            name,
            proc: None,
            proc_print: None,
            proc_notes: None,
            startup_seen: None,
            startup_checked: Instant::now(),
            proc_effort: None,
            pending_effort: None,
            parked: false,
            slot: None,
            waiting_since: None,
            loading: None,
            warm_task: None,
            followup_mail: Vec::new(),
            turn: None,
            convo,
            init: Value::Null,
            last_error: None,
            idle_since: Instant::now(),
            keep_until: None,
            text_frames: 0,
            stopping: false,
            mcp: McpState::default(),
            forecast: Value::Null,
            sent_print,
            receipt,
            reconfigured: false,
            settled: false,
            session_noted: false,
            bypass_seat: false,
            session_pref: crate::runtime::session_host::Pref::SignedIn,
            use_session: None,
            codex_seat: None,
            activity: None,
            rate_limit: None,
            cost_seen: row.get(1),
            agy_steer_dir: None,
            board_sent: None,
            provider: catalog::provider_of(&tier).to_string(),
            codex_total: None,
            tasks: Default::default(),
            helpers: Default::default(),
            helper_due: None,
            muse_bg: HashMap::new(),
            claude_bg: HashMap::new(),
            own_cancels: (0, None),
            bg_unread: false,
            bg_wake: Vec::new(),
            bg_wake_due: None,
            claude_own: false,
            compact_open: None,
            compact_settled: false,
            bg_in_turn: Vec::new(),
            bg_grace: None,
            held: false,
            steer_since: None,
            late_told: Default::default(),
            keepalive: None,
            admit_refusals: 0,
            admit_retry: None,
            typing_probe: None,
        })
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Envelope>) {
        self.update_forecast().await;
        self.publish();
        loop {
            let deadline = self.next_deadline();
            tokio::select! {
                msg = rx.recv() => {
                    let Some(env) = msg else { break };
                    let res = match env.msg {
                        // a keepalive's CLI is not the agent's: its lines end the keepalive
                        AgentMsg::Claude(process, v) if self.keepalive.as_ref().map(|k| k.process) == Some(process) => {
                            let span = self.span.clone();
                            tracing::Instrument::instrument(self.on_keepalive_event(v), span).await;
                            Ok(())
                        }
                        // the CLI's stream runs under its turn's request
                        AgentMsg::Claude(process, v) => {
                            if !self.owns_process(process) { continue; }
                            let span = self.turn.as_ref().map(|t| t.span.clone()).unwrap_or_else(|| self.span.clone());
                            tracing::Instrument::instrument(self.on_claude(v), span).await
                        }
                        AgentMsg::Codex(process, v) => {
                            if !self.owns_process(process) { continue; }
                            let span = self.turn.as_ref().map(|t| t.span.clone()).unwrap_or_else(|| self.span.clone());
                            tracing::Instrument::instrument(self.on_codex(v), span).await
                        }
                        AgentMsg::Agy(process, v) => {
                            if !self.owns_process(process) { continue; }
                            let span = self.turn.as_ref().map(|t| t.span.clone()).unwrap_or_else(|| self.span.clone());
                            tracing::Instrument::instrument(self.on_agy(v), span).await
                        }
                        AgentMsg::Acp(process, v) => {
                            if !self.owns_process(process) { continue; }
                            let span = self.turn.as_ref().map(|t| t.span.clone()).unwrap_or_else(|| self.span.clone());
                            tracing::Instrument::instrument(self.on_acp(v), span).await
                        }
                        AgentMsg::Muse(process, v) => {
                            if !self.owns_process(process) { continue; }
                            let span = self.turn.as_ref().map(|t| t.span.clone()).unwrap_or_else(|| self.span.clone());
                            tracing::Instrument::instrument(self.on_muse(v), span).await
                        }
                        // every other message is a request of its own, caused by its sender's
                        other => {
                            let span = crate::trace::request_from(&self.client, env.cause.as_deref());
                            tracing::Instrument::instrument(self.handle_msg(other), span).await
                        }
                    };
                    if let Err(e) = res {
                        tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "agent actor error");
                        self.last_error = Some(format!("{e:#}"));
                        self.publish();
                    }
                }
                _ = sleep_until(deadline) => {
                    let span = crate::trace::request(&self.client);
                    if let Err(e) = tracing::Instrument::instrument(self.on_timer(), span).await {
                        tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "agent timer error");
                    }
                }
            }
            if let Err(e) = self.acknowledge_opening().await {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "opening mail acknowledgement will retry");
            }
            if self.stopping {
                break;
            }
            if self.dormant() && self.idle_since.elapsed() > ACTOR_IDLE_EXIT {
                break;
            }
        }
        rx.close();
        self.close_proc().await;
        if !self.stopping {
            self.publish_idle();
        }
    }

    #[nolog]
    fn dormant(&self) -> bool {
        self.turn.is_none() && self.proc.is_none() && self.slot.is_none() && self.waiting_since.is_none() && self.keepalive.is_none()
            && self.admit_retry.is_none()
    }

    /// One acknowledgement at the first positive activity boundary, not at
    /// admission. A launch that fails before producing anything stays replayable.
    #[nolog] // checked on every stream event; the rare DB acknowledgement logs
    async fn acknowledge_opening(&mut self) -> Result<()> {
        let Some(t) = self.turn.as_ref().filter(|t| t.activity && !t.opening_mail.is_empty()) else { return Ok(()) };
        let client = self.engine.db.get().await?;
        let delivered = crate::domain::mail::acknowledge(&self.engine, &client, self.id, t.id, &t.opening_mail).await?;
        crate::runtime::watchdogs::events::mail_delivered(&self.engine,self.org_id,self.id,delivered);
        if let Some(t) = self.turn.as_mut() { t.opening_mail.clear(); }
        self.changed(vec![Change::Mailbox(self.id)]);
        Ok(())
    }

    #[nolog]
    fn next_deadline(&self) -> tokio::time::Instant {
        let now = Instant::now();
        let mut d = now + Duration::from_secs(30);
        if let Some(at) = self.helper_due { d = d.min(at); }
        if let Some(k) = self.keep_until {
            d = d.min(k);
        }
        if let Some(t) = &self.turn {
            let idle_limit = self.engine.settings.turn_idle_s().min(86_400 * 365);
            if idle_limit > 0 {
                d = d.min(t.last_event + Duration::from_secs(idle_limit));
            }
            let total = self.engine.settings.turn_timeout_s().min(86_400 * 365);
            if total > 0 {
                d = d.min(t.started + Duration::from_secs(total));
            }
        }
        if let (Some(_), Some(s)) = (&self.turn, self.steer_since) {
            d = d.min(s + recovery::steer_late_after());
        }
        if let Some(k) = &self.keepalive {
            d = d.min(k.started + Duration::from_secs(keepalive::TIMEOUT_S));
        }
        // an absolute time, so a steady stream of other messages cannot keep
        // pushing the idle startup-file check back (decision 61)
        if self.turn.is_none() && self.keepalive.is_none() && self.startup_seen.is_some() {
            d = d.min(self.startup_checked + STARTUP_RECHECK);
        }
        if let Some(at) = self.admit_retry {
            d = d.min(at);
        }
        for at in [self.bg_wake_due, self.bg_grace].into_iter().flatten() {
            d = d.min(at);
        }
        if self.dormant() {
            d = d.min(self.idle_since + ACTOR_IDLE_EXIT + Duration::from_millis(50));
        }
        tokio::time::Instant::from_std(d.max(now))
    }

    #[nolog]
    async fn on_timer(&mut self) -> Result<()> {
        if self.helper_due.is_some_and(|at| Instant::now() >= at) {
            self.flush_helpers().await;
        }
        if self.keepalive.as_ref().is_some_and(|k| k.started.elapsed() >= Duration::from_secs(keepalive::TIMEOUT_S)) {
            self.end_keepalive(KeepaliveEnd::Failed("the keepalive timed out (its CLI was killed)")).await;
        }
        // an idle agent's startup files (decision 61): after an edit its
        // forecast says so and its parked CLI is replaced now, resuming the
        // same session. A running turn is never touched; its next turn
        // respawns through the fingerprint instead.
        if self.turn.is_none() && self.keepalive.is_none() && self.startup_checked.elapsed() >= STARTUP_RECHECK {
            self.startup_checked = Instant::now();
            if let Some((inputs, folders, seen)) = self.startup_seen.clone() {
                let skills = crate::providers::skills::for_agent(&self.engine.providers.skills_registry(), &folders);
                let now = shared_startup_digest(&startup::digest(&inputs), &skills);
                // stale against what the parked CLI was LAUNCHED with, which
                // an edit during the last turn leaves behind the forecast's
                let stale = self.proc.is_some() && self.proc_print.as_ref().and_then(|p| p.part("startup")) != Some(now.as_str());
                if now != seen || stale {
                    self.reconfigured |= stale;
                    self.update_forecast().await;
                    // a process kept open for its background work is not
                    // replaced for an edit, which would end that work: the
                    // next turn still starts a fresh one (decision 61), and it
                    // closes once the work is over
                    if !self.held {
                        self.replace_idle_process().await;
                    }
                    self.publish();
                }
            }
        }
        if let Some(k) = self.keep_until {
            if Instant::now() >= k && self.turn.is_none() {
                self.keep_until = None;
                self.close_proc().await;
                self.update_forecast().await;
                self.publish();
            }
        }
        if self.bg_wake_due.is_some_and(|due| Instant::now() >= due) {
            // the CLI started no turn of its own for these results: wake the agent anyway
            self.send_held_wakes().await;
        }
        if self.bg_grace.is_some_and(|g| Instant::now() >= g) {
            // no turn of the CLI's own followed: the turn they settled in took them
            self.bg_grace = None;
            self.bg_in_turn.clear();
            self.release_held().await;
        }
        let (silent, over) = self.turn.as_ref().map_or((false, false), |t| {
            let idle_limit = self.engine.settings.turn_idle_s();
            let total = self.engine.settings.turn_timeout_s();
            (idle_limit > 0 && t.last_event.elapsed() >= Duration::from_secs(idle_limit),
             total > 0 && t.started.elapsed() >= Duration::from_secs(total))
        });
        // a Muse turn whose silence is a tool call's: that call ends alone and
        // the turn goes on (user 2026-10-13); the total ceiling still ends it
        let silent = silent && (over || !self.stop_silent_muse_tools().await);
        let expired = if silent {
            Some("the turn produced nothing for too long and was stopped")
        } else if over {
            Some("the turn ran past its time limit and was stopped")
        } else {
            None
        };
        if self.turn.is_some()
            && self.steer_since.map(|s| s.elapsed() >= recovery::steer_late_after()).unwrap_or(false)
        {
            self.steer_late().await;
        }
        if let Some(why) = expired {
            tracing::warn!(agent = %self.name, why, "ending turn");
            if let Some(t) = self.turn.as_mut() {
                t.killed = true;
            }
            self.kill_proc().await;
            self.end_turn(Some(why.to_string()), Value::Null).await?;
        }
        if self.admit_retry.is_some_and(|at| Instant::now() >= at) {
            self.admit_retry = None;
            self.on_wake().await?;
        }
        Ok(())
    }

    /// The turn went silent. When it is a Muse turn waiting on tool calls,
    /// the silence is theirs: each call in flight is stopped by itself (MSP
    /// `task/stop`: its item settles `cancelled` and the model gets that
    /// result), a note naming the limit going into the turn first
    /// (`turn/steer`, measured on Muse 1.4.6 to reach the model with the
    /// call's result), and the silence clock restarts. False, so the turn
    /// ends as before, when the silence is the model's (no call in flight,
    /// or only work Muse moved to the background) or a call Orgtree already
    /// stopped is still in flight a whole limit later.
    async fn stop_silent_muse_tools(&mut self) -> bool {
        let limit = self.engine.settings.turn_idle_s();
        let (turn_id, calls, names) = {
            let Some(t) = self.turn.as_ref() else { return false };
            let Some(turn_id) = t.codex_turn.clone() else { return false };
            let Some(calls) = muse_silent_calls(&t.muse_tools) else {
                if t.muse_tools.values().any(|c| !c.background && c.stop_asked.is_some()) {
                    tracing::warn!(agent = %self.name, "a Muse tool call Orgtree stopped is still running a whole silence limit later; ending the turn");
                }
                return false;
            };
            let names: Vec<String> = calls.iter().map(|id| t.muse_tools[id].name.clone()).collect();
            (turn_id, calls, names)
        };
        let Some(Proc::Muse(m)) = self.proc.as_ref() else { return false };
        tracing::warn!(agent = %self.name, tools = ?names, limit_s = limit, "stopping Muse tool calls that passed the silence limit; the turn goes on");
        if let Err(e) = m.steer_within(&turn_id, &muse_silence_note(&names, limit), Duration::from_secs(10)).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the silence note did not reach the Muse turn");
        }
        for id in &calls {
            if let Err(e) = m.stop_task(id).await {
                tracing::warn!(agent = %self.name, task = %id, error = %format!("{e:#}"), "the Muse host did not take the stop");
            }
        }
        let now = Instant::now();
        if let Some(t) = self.turn.as_mut() {
            for id in &calls {
                if let Some(c) = t.muse_tools.get_mut(id) {
                    c.stop_asked = Some((now, limit));
                }
            }
            t.last_event = now;
        }
        true
    }

    async fn handle_msg(&mut self, msg: AgentMsg) -> Result<()> {
        match msg {
            AgentMsg::Wake => {
                if self.turn.is_some() && self.steer_since.is_none() {
                    self.steer_since = Some(Instant::now());
                }
                self.on_wake().await?
            }
            AgentMsg::WakeIdle(reply) => {
                let idle = !self.stopping && self.turn.is_none() && self.waiting_since.is_none() && self.slot.is_none()
                    && self.keepalive.is_none();
                if idle {
                    self.on_wake().await?;
                }
                let _ = reply.send(idle && self.waiting_since.is_some());
            }
            AgentMsg::CacheKeepalive => self.start_keepalive().await?,
            AgentMsg::Slot(slot) => self.on_slot(slot).await?,
            AgentMsg::Loading(what) => {
                self.loading = what;
                self.publish();
            }
            AgentMsg::WarmFailed(slot, why) => self.on_warm_failed(slot, why).await?,
            AgentMsg::Claude(process, v) => {
                if self.owns_process(process) { self.on_claude(v).await?; }
            }
            AgentMsg::Codex(process, v) => {
                if self.owns_process(process) { self.on_codex(v).await?; }
            }
            AgentMsg::Agy(process, v) => {
                if self.owns_process(process) { self.on_agy(v).await?; }
            }
            AgentMsg::Acp(process, v) => {
                if self.owns_process(process) { self.on_acp(v).await?; }
            }
            AgentMsg::Muse(process, v) => {
                if self.owns_process(process) { self.on_muse(v).await?; }
            }
            AgentMsg::Hook { input, reply } => {
                let out = match self.on_hook(&input).await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "mail hook failed");
                        json!({})
                    }
                };
                let _ = reply.send(out);
            }
            AgentMsg::ProcExited { process, reason } => self.on_exit(process, &reason).await?,
            AgentMsg::Session { pref, use_id, reply } => {
                if let Some(p) = pref {
                    self.session_pref = p;
                }
                if use_id.is_some() {
                    self.use_session = use_id;
                }
                let _ = reply.send(self.session_view());
            }
            AgentMsg::InterruptSelf { restart, reply } => {
                let _ = reply.send(self.interrupt_self(restart));
            }
            AgentMsg::Interrupt(reply) => {
                let r = if self.turn.is_some() {
                    if let Some(t) = self.turn.as_mut() {
                        t.interrupted = true;
                    }
                    let codex_turn = self.turn.as_ref().and_then(|t| t.codex_turn.clone());
                    let sent = self.proc.as_ref().map(|p| p.interrupt(codex_turn.as_deref())).unwrap_or(false);
                    if sent {
                        json!({ "interrupted": true })
                    } else {
                        json!({ "interrupted": false, "reason": "the process could not be reached" })
                    }
                } else {
                    json!({ "interrupted": false, "reason": "no turn is running" })
                };
                let _ = reply.send(r);
            }
            AgentMsg::Halt(reply) => {
                self.cancel_keepalive().await;
                let r = self.halt().await?;
                let _ = reply.send(r);
            }
            AgentMsg::Unhalt(reply) => {
                let client = self.engine.db.get().await?;
                client
                    .execute("UPDATE ot.agents SET halt = NULL, row_version = row_version + 1 WHERE id = $1", &[&self.id])
                    .await?;
                drop(client);
                self.changed(vec![Change::Agent(self.id)]);
                crate::runtime::watchdogs::events::emit(&self.engine,crate::runtime::watchdogs::events::event("agent.unhalted",crate::runtime::watchdogs::events::Scope::Agent(self.org_id,self.id),json!({"agent_id":self.id})));
                let _ = reply.send(json!({ "unhalted": true, "status": "idle" }));
                self.on_wake().await?;
            }
            AgentMsg::Command(text, reply) => {
                self.cancel_keepalive().await;
                let r = match self.command(&text).await {
                    Ok(v) => v,
                    Err(e) => json!({ "started": false, "reason": format!("{e:#}") }),
                };
                let _ = reply.send(r);
            }
            AgentMsg::Effort(previous, reply) => {
                let r = self.effort_saved(&previous).await;
                let _ = reply.send(r);
                self.update_forecast().await;
                self.publish();
            }
            AgentMsg::Process { action, reply } => {
                self.cancel_keepalive().await;
                let r = self.process_control(&action).await;
                self.update_forecast().await;
                self.publish();
                let _ = reply.send(r);
            }
            AgentMsg::Reconfigured => {
                self.reconfigured = self.proc.is_some();
                self.replace_idle_process().await;
                self.update_forecast().await;
                self.publish();
            }
            AgentMsg::ApplyQueued => {
                // a running turn's end applies it; an idle agent takes it now
                if !self.stopping && self.turn.is_none() {
                    self.apply_pending_config().await?;
                }
            }
            AgentMsg::Live(reply) => {
                let _ = reply.send(self.live_view());
            }
            AgentMsg::NextTurn(reply) => {
                let _ = reply.send(self.next_turn().await);
            }
            AgentMsg::Stop(reply) => {
                // engine shutdown: a running turn's mail stays claimed and
                // inflight_at stays set, so the next start resumes it. A seat
                // stopped while the engine runs on (retire, dissolve, delete)
                // settles its cut turn now, as 3.x did before archiving: no
                // turn may stay on record for a seat that runs none (decision 62)
                self.stopping = true;
                self.cancel_warm();
                if self.waiting_since.take().is_some() {
                    self.engine.sched.cancel(self.id);
                }
                self.cancel_keepalive().await;
                self.kill_proc().await;
                if let Some(t) = self.take_turn() {
                    if !self.engine.is_stopping() {
                        self.settle_cut_turn(t.id).await;
                    }
                }
                self.slot = None;
                self.publish_idle();
                let _ = reply.send(());
            }
            AgentMsg::ToolCard(tool_use_id, card) => {
                if let Some(t) = self.turn.as_mut() {
                    t.cards.insert(tool_use_id, card);
                }
            }
            AgentMsg::Warm(reply) => {
                let warm = self.warm().await;
                let _ = reply.send(warm);
            }
            AgentMsg::CloseIdle if self.turn.is_none() && self.proc.is_some() && self.bg_pending() => {
                // warming switched off, or the idle cap evicting it: its
                // background work keeps it open, outside the cap, until it is over
                self.hold();
            }
            AgentMsg::CloseIdle => {
                if self.turn.is_none() && self.proc.is_some() {
                    crate::runtime::watchdogs::events::emit(&self.engine,crate::runtime::watchdogs::events::event("cli.evicted",crate::runtime::watchdogs::events::Scope::Agent(self.org_id,self.id),json!({"agent_id":self.id})));
                    self.keep_until = None;
                    self.close_proc().await;
                    self.update_forecast().await;
                    self.publish();
                }
            }
        }
        Ok(())
    }

    async fn tier(&self) -> String {
        match self.engine.db.get().await {
            Ok(c) => c
                .query_one("SELECT tier FROM ot.agents WHERE id = $1", &[&self.id])
                .await
                .map(|r| r.get(0))
                .unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    /// Warming: start the CLI before the agent's next turn and park it. Quiet
    /// when the agent cannot run now (halted, frozen, its provider or account
    /// off): its next turn says why, as before.
    async fn warm(&mut self) -> bool {
        if self.proc.is_some() || self.turn.is_some() || self.stopping {
            return self.proc.is_some();
        }
        let ctx = match self.load_ctx().await {
            Ok(c) => c,
            Err(_) => return false,
        };
        if ctx.state != "live" || ctx.halted || ctx.frozen || ctx.killswitch {
            return false;
        }
        match self.ensure_proc(&ctx).await {
            Ok(()) => {
                self.park();
                self.publish();
                true
            }
            Err(e) => {
                tracing::info!(agent = %self.name, reason = %format!("{e:#}"), "not warmed");
                false
            }
        }
    }

    /// A saved effort change (3.x `send_live_effort`; `previous` is the level
    /// the agent resolved to before the save). A running Claude turn is sent
    /// `apply_flag_settings {effortLevel}` with the level it resolves to now,
    /// always explicit (a cleared level is sent what it falls back to): its
    /// next model call uses it. Everything else takes it from the next turn.
    /// Either way a process that no longer matches the level is not used for
    /// another turn: a CLI may acknowledge a level it ignores, and Codex keeps
    /// the level it started with, so the next turn starts a fresh process with
    /// the new level (an idle one is replaced now, as a reconfiguration is).
    async fn effort_saved(&mut self, previous: &str) -> Value {
        let ctx = match self.load_ctx().await {
            Ok(ctx) => ctx,
            Err(e) => return json!({ "delivery": "next_turn", "effort": previous, "reason": format!("{e:#}") }),
        };
        let level = ctx.effort.clone();
        if level == previous {
            return json!({ "delivery": "unchanged", "effort": level });
        }
        // Muse takes the level with each turn it starts: its host keeps
        // running and the next turn carries the new level (the level the
        // model's catalog row lists, else its default: never a neighbour)
        if let Some(model) = self.proc.as_ref().and_then(|p| match p { Proc::Muse(m) => Some(m.model.clone()), _ => None }) {
            let row = self.engine.providers.muse_model(&model);
            let (sent, mapped) = catalog::muse_effort(&level, row.as_ref().map(|r| r.variants.as_slice()), row.as_ref().and_then(|r| r.default_effort.as_deref()));
            if let Some(Proc::Muse(m)) = self.proc.as_mut() {
                m.effort = Some(sent.clone());
            }
            self.proc_effort = Some(level.clone());
            let mut out = json!({ "delivery": "next_turn", "effort": level, "reason": "Muse takes an effort change at its next turn" });
            if mapped {
                out["sent_as"] = json!(sent);
            }
            return out;
        }
        if self.proc.is_some() && self.proc_effort.as_deref() != Some(level.as_str()) {
            self.reconfigured = true;
        }
        let next = |reason: &str| json!({ "delivery": "next_turn", "effort": level, "reason": reason });
        let live = catalog::tier(&ctx.tier).map(|t| t.live_effort).unwrap_or(false);
        let out = if ctx.provider != catalog::CLAUDE {
            next("only Claude turns take an effort change mid-turn")
        } else if !live {
            next(&format!("{} has no effort level to change", ctx.tier))
        } else {
            let running = self.turn.is_some();
            match self.proc.as_mut() {
                Some(p @ Proc::Claude(_)) if running => {
                    if !p.alive() {
                        next("the CLI process has exited")
                    } else if p.set_effort(&crate::providers::launch_effort(&self.engine, &ctx.tier, &level).0) {
                        self.proc_effort = Some(level.clone());
                        json!({ "delivery": "sent", "effort": level })
                    } else {
                        next("the running process could not be reached")
                    }
                }
                _ => next("no turn is running"),
            }
        };
        self.replace_idle_process().await;
        out
    }

    /// Reconfiguration waits for a busy turn, but never for the next mail.
    /// A local CLI replacement does not erase a provider cache receipt.
    async fn replace_idle_process(&mut self) {
        if !self.reconfigured || self.proc.is_none() || self.turn.is_some() || self.stopping {
            return;
        }
        self.keep_until = None;
        self.close_proc().await;
        self.reconfigured = false;
        self.publish();
        if super::warming_allowed(&self.engine) && super::memory_for_warming() {
            self.warm().await;
        }
    }

    async fn process_control(&mut self, action: &str) -> Value {
        let had = self.proc.is_some();
        if action == "stop" {
            if self.turn.is_some() {
                return json!({ "ok": false, "action": "stop", "paused": false, "proc_warm": false, "proc_live": true,
                               "error": "a turn is running; interrupt it first" });
            }
            self.keep_until = None;
            self.close_proc().await;
            return json!({ "ok": true, "action": "stop", "already": !had, "paused": false, "proc_warm": false,
                           "proc_live": false, "killed": had });
        }
        if !had {
            let started = match self.load_ctx().await {
                Ok(ctx) => self.ensure_proc(&ctx).await,
                Err(e) => Err(e),
            };
            if let Err(e) = started {
                self.last_error = Some(format!("{e:#}"));
                return json!({ "ok": false, "action": "start", "paused": false, "proc_warm": false,
                               "proc_live": false, "error": format!("{e:#}") });
            }
            self.park();
        }
        json!({ "ok": true, "action": "start", "already": had, "paused": false,
                "proc_warm": self.proc.is_some() && self.turn.is_none(), "proc_live": self.proc.is_some() })
    }

    // ------------------------------------------------------------ turns

    async fn on_wake(&mut self) -> Result<()> {
        self.idle_since = Instant::now();
        if self.turn.is_some() && !self.stopping && self.proc.as_ref().map(|p| p.is_codex() || p.is_muse()).unwrap_or(false) {
            // Codex and Muse take mid-turn mail at once (`turn/steer` on the exact turn)
            return self.steer_codex().await;
        }
        if self.turn.is_some() && !self.stopping && self.proc.as_ref().map(|p| p.is_agy()).unwrap_or(false) {
            // Antigravity takes it at the next invocation boundary (its steer hook)
            return self.steer_agy().await;
        }
        if self.stopping || self.turn.is_some() || self.waiting_since.is_some() || self.slot.is_some() {
            // mail for a running Claude turn is handed over at the next tool boundary
            return Ok(());
        }
        if self.admit_retry.is_some() {
            // a refused admission tries again on its own timer (decision 62)
            return Ok(());
        }
        self.apply_pending_config().await?;
        let client = self.engine.db.get().await?;
        let row = client
            .query_one(
                "SELECT a.state, a.halt IS NOT NULL, a.frozen IS NOT NULL, o.killswitch IS NOT NULL,
                        EXISTS (SELECT 1 FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND m.recipient_agent_id = a.id AND m.state = 'pending' AND (NOT m.notice OR m.extra->>'input_budget_deferred'='true')), a.frozen,
                        a.tier
                   FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id = $1",
                &[&self.id],
            )
            .await?;
        drop(client);
        let state: String = row.get(0);
        let (halted, frozen, killswitch, waking): (bool, bool, bool, bool) = (row.get(1), row.get(2), row.get(3), row.get(4));
        if frozen {
            let rec: Value = row.get(5);
            let wake = freeze::wake_at(&rec);
            let auto_resume = freeze::auto_resume_on(&self.engine, self.org_id).await?;
            tracing::info!(agent = self.id, state = %state, halted, killswitch, waking, auto_resume,
                reset_due = wake.map(|t| t <= Utc::now()).unwrap_or(false),
                wake_at = ?wake, "wake blocked: agent is frozen; automatic timer or manual unstick must release it");
        }
        if state != "live" || halted || frozen || killswitch || !waking {
            return Ok(());
        }
        self.waiting_since = Some(Utc::now());
        // a language-server seat also needs room under its server's agents-at-once cap
        let tier: String = row.get(6);
        let lane = if catalog::is_langserver(&tier) {
            crate::langserver::route_of(&self.engine, &tier).map(|(s, _)| {
                let cap = s["max_agents"].as_i64().unwrap_or(1).clamp(1, 64) as usize;
                (format!("langserver:{}", s["id"].as_str().unwrap_or("")), cap)
            })
        } else {
            None
        };
        let rx = self.engine.sched.want(self.org_id, self.id, lane);
        let tx = self.tx.clone();
        // an Ollama model is loaded before the CLI asks for it: Ollama loads
        // inside the first request and Claude Code gives up on its headers
        // after about 5 minutes (coordinator ruling 2026-10-10)
        let warm = if catalog::is_langserver(&tier) { crate::langserver::warm_plan(&self.engine, &tier).await } else { None };
        let warming = warm.is_some();
        let task = crate::trace::spawn(async move {
            if let Ok(slot) = rx.await {
                if let Some(w) = warm {
                    if crate::langserver::ollama_loaded(&w).await != Ok(true) {
                        let _ = tx.post(AgentMsg::Loading(Some(format!("loading model on {}", w.server))));
                        if let Err(why) = crate::langserver::ollama_load(&w).await {
                            let _ = tx.post(AgentMsg::WarmFailed(slot, why));
                            return;
                        }
                    }
                }
                // if the actor is gone the slot drops here and is freed
                let _ = tx.post(AgentMsg::Slot(slot));
            }
        });
        // a stop or halt aborts a load in flight (cancel_warm)
        self.warm_task = warming.then(|| task.abort_handle());
        self.publish();
        Ok(())
    }

    /// Abort a warm-up load in flight (the agent stops or halts): its request
    /// is dropped, so the connection closes and Ollama gives the load up the
    /// way it does for any client that has gone; the slot the task held is
    /// freed with it.
    fn cancel_warm(&mut self) {
        if let Some(task) = self.warm_task.take() {
            task.abort();
        }
        self.loading = None;
    }

    /// The language server could not load the turn's model: the slot goes
    /// back, and the turn fails the way a CLI that never started does (its
    /// mail stays in the mailbox; the agent and its superior are told).
    async fn on_warm_failed(&mut self, slot: Slot, why: String) -> Result<()> {
        drop(slot);
        self.loading = None;
        self.warm_task = None;
        if self.waiting_since.take().is_none() || self.turn.is_some() || self.stopping {
            self.publish();
            return Ok(());
        }
        self.last_error = Some(why.clone());
        tracing::warn!(agent = %self.name, error = %why, "turn could not start: its model did not load");
        if let Ok(client) = self.engine.db.get().await {
            let _ = client
                .execute("UPDATE ot.agents SET last_error = $2, row_version = row_version + 1 WHERE id = $1", &[&self.id, &self.last_error])
                .await;
        }
        self.launch_failed(&why).await;
        self.publish();
        self.changed(vec![Change::Agent(self.id)]);
        Ok(())
    }

    async fn on_slot(&mut self, slot: Slot) -> Result<()> {
        self.loading = None;
        self.warm_task = None;
        if self.waiting_since.take().is_none() || self.turn.is_some() || self.stopping {
            drop(slot);
            self.publish();
            return Ok(());
        }
        self.slot = Some(slot);
        // Admission is complete before slow process replacement/initialization.
        self.publish();
        match self.start_turn().await {
            Ok(true) => {}
            Ok(false) => {
                self.slot = None;
                self.publish();
            }
            Err(e) => {
                self.slot = None;
                self.last_error = Some(format!("{e:#}"));
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "turn could not start");
                if let Ok(client) = self.engine.db.get().await {
                    let _ = client
                        .execute(
                            "UPDATE ot.agents SET last_error = $2, row_version = row_version + 1 WHERE id = $1",
                            &[&self.id, &self.last_error],
                        )
                        .await;
                }
                self.launch_failed(&format!("{e:#}")).await;
                self.publish();
                self.changed(vec![Change::Agent(self.id)]);
            }
        }
        Ok(())
    }

    /// 3.x's terminal belt (SH-4, user ruling 2026-09-12) for a turn that
    /// failed before its provider ran: its mail is back in the mailbox and
    /// nothing retries it, so the agent and its superior are told once per
    /// run of failures (`hard_fail_run`, cleared by a completed turn). A
    /// freeze, halt, limit lock, killswitch, a seat that is not live and an
    /// engine shutdown own the stopped state and are never announced.
    async fn launch_failed(&self, err: &str) {
        if self.stopping || self.engine.is_stopping() {
            return;
        }
        let Ok(client) = self.engine.db.get().await else { return };
        let owned = client
            .query_opt(
                "SELECT a.state <> 'live' OR a.halt IS NOT NULL OR a.frozen IS NOT NULL OR a.limit_locked OR o.killswitch IS NOT NULL
                   FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id = $1",
                &[&self.id],
            )
            .await;
        drop(client);
        if !matches!(owned, Ok(Some(ref r)) if !r.get::<_, bool>(0)) {
            return;
        }
        let run = recovery::bump(&self.engine, self.id, "hard_fail_run").await.unwrap_or(1);
        // launch failures have no timer retry. Each actual re-drive by a new
        // wake must report a length refusal; generic failures stay once/run.
        let length = prompt::input_length_refusal(err);
        let tell = run == 1 || length;
        let detail = if length { format!("{err}; failed attempt {run}. Waiting mail retained; no automatic retry.") } else { err.to_string() };
        let door = "the turn could not start: its CLI did not start or did not take the turn";
        if let Err(e) = crate::domain::runtime_notices::launch_failed(&self.engine, self.org_id, self.id, door, &detail, tell).await {
            tracing::warn!(agent = self.id, error = %format!("{e:#}"), "the failed launch could not be reported");
        }
    }

    async fn load_ctx(&self) -> Result<Ctx> {
        let client = self.engine.db.get().await?;
        let r = client
            .query_one(
                "SELECT a.name, a.title, a.tier, a.account, a.scope, a.charter, a.session_id, a.provider, a.generation,
                        a.state, a.halt IS NOT NULL, a.frozen IS NOT NULL, ot.superior_of(a.id), a.scratch_dir,
                        p.team_charter, o.name, o.slug, o.settings, o.killswitch IS NOT NULL,
                        (SELECT s.secret FROM ot.account_secrets s JOIN ot.accounts ac ON ac.id = s.account_id
                          WHERE ac.id = a.account AND ac.kind = 'apikey'
                            AND coalesce(ac.origin_org, '') IN ('', o.slug)),
                        a.extra->>'harness', a.extra->>'handoff_due',
                        a.team_charter, p.name,
                        EXISTS (SELECT 1 FROM ot.audiences au WHERE au.org_id = a.org_id AND au.grantee = a.name
                                   AND au.grantor = '@extern' AND au.revoked_at IS NULL),
                        a.occupancy, a.context_window, a.occupancy_est, a.compacted_unrun, a.limit_locked,
                        coalesce((a.extra->>'harness_pin')::boolean, false)
                   FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
                   -- the superior is the nearest AGENT above: a project is
                   -- transparent for reporting (docs/rust-engine/PROJECT-NODES.md)
                   LEFT JOIN ot.agents p ON p.id = ot.superior_of(a.id)
                  WHERE a.id = $1",
                &[&self.id],
            )
            .await?;
        let chain = client
            .query(
                "WITH RECURSIVE chain(id, parent_id, scope, depth) AS (
                   SELECT id, parent_id, scope, 0 FROM ot.agents WHERE id = $1
                   UNION ALL SELECT a.id, a.parent_id, a.scope, c.depth + 1 FROM ot.agents a JOIN chain c ON a.id = c.parent_id
                    WHERE c.depth < 1024)
                 SELECT c.scope, c.depth, a.name, a.team_charter FROM chain c JOIN ot.agents a ON a.id = c.id ORDER BY c.depth DESC",
                &[&self.id],
            )
            .await?;
        drop(client);
        let org_settings: Value = r.get(17);
        let settings = crate::feed::groups::effective_settings(&org_settings, &self.engine.settings.defaults());
        let mut eff = scope::org_ceiling(&settings["dirs"]);
        for s in &chain {
            eff = scope::clamp(&s.get::<_, Value>(0), &eff);
        }
        let configured = scope::normalize(&r.get::<_, Value>(4));
        let tier: String = r.get(2);
        let model = catalog::model_for(&tier, configured.get("model_version").and_then(Value::as_str));
        // an OpenRouter tier runs its favorite's model id
        let openrouter = catalog::is_openrouter(&tier);
        let model = if openrouter {
            crate::openrouter::favorite(&self.engine, &tier).and_then(|f| f["model"].as_str().map(str::to_string)).unwrap_or(model)
        } else {
            model
        };
        // a language-server tier runs its server's model id, on its server's harness
        let local = if catalog::is_langserver(&tier) { crate::langserver::route_of(&self.engine, &tier) } else { None };
        let model = match &local {
            Some((_, m)) => m["id"].as_str().map(str::to_string).unwrap_or(model),
            None => model,
        };
        let harness_stamp: Option<String> = if openrouter { r.get(20) } else { None };
        let harness_want = openrouter.then(|| {
            crate::openrouter::seat_harness(&self.engine, r.get::<_, Option<String>>(3).as_deref(), harness_stamp.as_deref(), r.get(30))
        });
        let harness = if openrouter {
            harness_stamp.clone().or_else(|| harness_want.clone())
        } else if let Some((s, _)) = &local {
            s["harness"].as_str().map(str::to_string)
        } else {
            None
        };
        let local_window = local.as_ref().map(|(_, m)| crate::langserver::context_of(m) as i32);
        let effort = catalog::effective_effort(&configured, &settings);
        let fallback = configured
            .get("account_fallback")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| settings["account_fallback_default"].as_bool().unwrap_or(false));
        let compact_at = crate::feed::groups::compact_frac(&settings["compact_at"]);
        let cold_reset = crate::domain::tree::cheap_compact(&configured, &settings).1;
        let slug: String = r.get(16);
        let name: String = r.get(0);
        let scratch = r
            .get::<_, Option<String>>(13)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.engine.cfg.scratch_root(&slug).join(&name));
        let org_md = std::fs::read_to_string(self.engine.cfg.workspace_dir(&slug).join("org.md")).ok();
        // every agent of the org holds its shared notes folder, without a stored grant
        let org_notes_dir = self.engine.cfg.org_notes_dir(&slug);
        let eff = scope::with_org_notes(&eff, &org_notes_dir.to_string_lossy());
        // and the workspace of every subtree it is inside, read from the tree now
        let teams = crate::domain::teams::held(&self.engine, &slug, self.id).await?;
        // and the folders of the projects below it, which it reaches from above
        // heap-owned: the debug actor future sits near the stack limit (AGENTS.md, round 434)
        let below = Box::pin(crate::domain::teams::projects_below(&self.engine, &slug, self.id)).await?;
        let eff = scope::with_team_workspaces(&eff, &teams);
        let eff = scope::with_team_workspaces(&eff, &below);
        let team_notes: Vec<(PathBuf, String, Option<String>)> = teams.iter().map(|t| {
            let file = t.dir.join(crate::config::ORG_NOTES_FILE);
            let label = if t.own { "your own team".to_string() }
                else if t.project { format!("project {}", t.root) }
                else { format!("{}'s team", t.root) };
            let text = std::fs::read_to_string(&file).ok();
            (file, label, text)
        }).collect();
        let org_notes = std::fs::read_to_string(org_notes_dir.join(crate::config::ORG_NOTES_FILE)).ok();
        // §15 cascade: every ancestor's team charter binds its subtree, root first
        let cascade: Vec<(String, String)> = chain
            .iter()
            .filter(|c| c.get::<_, i32>(1) > 0)
            .filter_map(|c| c.get::<_, Option<String>>(3).filter(|t| !t.trim().is_empty()).map(|t| (c.get::<_, String>(2), t)))
            .collect();
        Ok(Ctx {
            name,
            title: r.get(1),
            provider: catalog::provider_of(&tier).to_string(),
            tier,
            model,
            account: r.get(3),
            api_key: r.get(19),
            effective: eff,
            charter: r.get(5),
            session_id: r.get(6),
            session_pref: crate::runtime::session_host::parse_pref(&configured["session"]).unwrap_or(crate::runtime::session_host::Pref::SignedIn),
            session_provider: r.get(7),
            generation: r.get(8),
            state: r.get(9),
            halted: r.get(10),
            frozen: r.get(11),
            top_level: r.get::<_, Option<i64>>(12).is_none(),
            scratch,
            team_charter: r.get(14),
            org_name: r.get(15),
            org_slug: slug,
            killswitch: r.get(18),
            org_md,
            org_notes_dir,
            org_notes,
            team_notes,
            effort,
            fallback,
            harness,
            harness_stamp,
            harness_want,
            compact_at,
            cold_reset,
            occupancy: r.get(25),
            // a language-server model's window is the one the CLI is told (its setting can change any time)
            context_window: local_window
                .or_else(|| r.get::<_, Option<i32>>(26))
                .or_else(|| catalog::tier(&r.get::<_, String>(2)).and_then(|t| t.context).map(|c| c as i32)),
            context_measured: !r.get::<_, bool>(27) && !r.get::<_, bool>(28),
            limit_locked: r.get(29),
            handoff_due: r.get(21),
            own_team_charter: r.get(22),
            superior: r.get(23),
            extern_holder: r.get(24),
            cascade,
        })
    }

    /// What an OpenRouter seat needs before it can launch: the lane on, its
    /// model known, the key stored, and the harness it was hired on.
    async fn openrouter_route(&self, ctx: &Ctx) -> Result<OrRoute> {
        if !self.engine.settings.provider_enabled(catalog::OPENROUTER) {
            return Err(anyhow!("OpenRouter is turned off in App settings"));
        }
        let fav = crate::openrouter::favorite(&self.engine, &ctx.tier)
            .ok_or_else(|| anyhow!("{} is not an OpenRouter model this app knows; switch this agent to another tier", ctx.tier))?;
        // the seat's own key: the key it is bound to, else the first key
        let id = crate::openrouter::seat_key(&self.engine, ctx.account.as_deref());
        let lane = id.clone();
        if let Some(a) = self.engine.accounts.view().get(&id) {
            if !a.enabled {
                return Err(anyhow!("the OpenRouter key {lane} is inactive (App settings › Providers); activate it or move this agent to another key"));
            }
        }
        if !crate::org_accounts::allowed(Some(&ctx.org_slug), &lane) {
            return Err(anyhow!("{lane} is not used by this org (Org settings › Accounts); the agent moves at its next turn"));
        }
        let key = crate::openrouter::key_of(&self.engine, &id).await.ok_or_else(|| {
            if id.is_empty() {
                anyhow!("this agent runs on an OpenRouter tier and no OpenRouter API key is set (App settings › Providers › OpenRouter)")
            } else {
                anyhow!("this agent's OpenRouter key {lane} is no longer stored; move it to another OpenRouter key (App settings › Providers › OpenRouter)")
            }
        })?;
        // a harness no longer installed refuses, saying so: never a silent
        // switch to another (user 2026-10-13)
        for h in [ctx.harness_want.as_deref(), ctx.harness.as_deref()].into_iter().flatten() {
            if !crate::harnesses::installed(&self.engine, h) {
                return Err(anyhow!("{} (this agent's OpenRouter harness; the key's is chosen in App settings › Providers › OpenRouter)",
                    crate::harnesses::not_installed(h)));
            }
        }
        let codex = ctx.harness.as_deref() == Some("codex-cli");
        Ok(OrRoute { key, codex, reasoning: fav["reasoning"].as_bool().unwrap_or(false), local: None })
    }

    /// What a language-server seat needs before it can launch: the lane on,
    /// its server and model still configured, the server enabled.
    async fn langserver_route(&self, ctx: &Ctx) -> Result<OrRoute> {
        let r = crate::langserver::route(&self.engine, &ctx.tier).await?;
        // no effort is sent: a local model's reasoning switch is its own
        Ok(OrRoute { key: r.key.clone(), codex: r.codex, reasoning: false, local: Some(r) })
    }

    /// The system prompt for this launch (runtime::identity) as (engine rules,
    /// standing notes). Reads the
    /// agent's own and its granted folders' AGENTS.md and legacy CLAUDE.md; no side effects.
    #[nolog] // snapshot and return value contain private instruction text
    fn identity(&self, ctx: &Ctx, external: &[String], own_notes: &startup::Notes, folder_notes: &startup::Notes) -> (String, String) {
        let codex = ctx.provider == catalog::OPENAI || ctx.harness.as_deref() == Some("codex-cli");
        let lane = if ctx.harness.as_deref() == Some("opencode") {
            prompt::Lane::OpenCode
        } else if codex {
            prompt::Lane::Codex
        } else if ctx.provider == catalog::GOOGLE {
            prompt::Lane::Antigravity
        } else if ctx.provider == catalog::MUSE {
            prompt::Lane::Muse
        } else {
            prompt::Lane::Claude
        };
        let tools = &ctx.effective["tools"];
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let may_write = tools.get("edit").and_then(Value::as_bool).unwrap_or(true) && pm != "plan";
        let sb = if lane == prompt::Lane::Codex { self.codex_seat(may_write, pm).0 } else { codexrt::sandbox(may_write, pm, false) };
        // a read-only seat without the OS sandbox is held by the approval policy instead
        let sandbox = if sb.approval == "untrusted" { "untrusted" } else { sb.mode };
        let skills = crate::rig::home_dir().map(|h| h.join(".claude").join("skills").to_string_lossy().to_string()).unwrap_or_default();
        prompt::identity_parts(&prompt::Identity {
            name: &ctx.name,
            title: &ctx.title,
            org_name: &ctx.org_name,
            org_slug: &ctx.org_slug,
            scratch: &ctx.scratch.to_string_lossy(),
            charter: ctx.charter.as_deref(),
            team_charter: ctx.own_team_charter.as_deref(),
            cascade: &ctx.cascade,
            superior: ctx.superior.as_deref(),
            org_md: ctx.org_md.as_deref(),
            lane,
            scope: &ctx.effective,
            codex_sandbox: if lane == prompt::Lane::Codex { Some(sandbox) } else { None },
            mcp_servers: external,
            extern_holder: ctx.extern_holder,
            folder_notes,
            own_notes,
            skills_dir: &skills,
            builtin_skills: prompt::builtin_skills_lane(lane),
        })
    }

    /// Everything a launch needs, computed without side effects (the cache
    /// forecast compares these without starting anything).
    fn plan(&self, ctx: &Ctx) -> Plan {

        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let disallowed = super::tool_policy::claude_disallowed(tools);
        let mut servers = Map::new();
        // the agent's own tools are never deferred behind tool search
        servers.insert("orgtree".into(), json!({ "type": "sdk", "name": "orgtree", "alwaysLoad": true }));
        let granted: Vec<String> = tools["mcp"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut external = Vec::new();
        if !granted.is_empty() {
            let registry = self.engine.providers.mcp_registry();
            for (name, cfg) in registry.servers.iter() {
                if name != "orgtree" && granted.iter().any(|g| g == "*" || g == name) {
                    servers.insert(name.clone(), cfg.clone());
                    external.push(name.clone());
                }
            }
        }
        let startup = startup::snapshot(&self.startup_inputs(ctx));
        let folders: Vec<PathBuf> = ctx.effective["add_dirs"].as_array().into_iter().flatten()
            .filter(|d| !scope::is_shared(d))
            .filter_map(|d| d["path"].as_str()).map(PathBuf::from).collect();
        let (own_notes, folder_notes) = startup.standing_notes(&ctx.scratch, &folders);
        let (rules, standing) = self.identity(ctx, &external, &own_notes, &folder_notes);
        let rules_len = rules.len();
        let base = rules + &standing;
        let mut instructions = startup.instructions.clone();
        for (path, text) in &own_notes { instructions.text(std::path::Path::new(path), "own_scratch", text); }
        for (path, text) in &folder_notes { instructions.text(std::path::Path::new(path), "granted_folder", text); }
        if let Some(text) = &ctx.org_md {
            instructions.text(&self.engine.cfg.workspace_dir(&ctx.org_slug).join("org.md"), "org_notes", text);
        }
        if let Some(text) = &ctx.org_notes {
            instructions.text(&ctx.org_notes_dir.join(crate::config::ORG_NOTES_FILE), "shared_scratch", text);
        }
        for (path, _, text) in &ctx.team_notes {
            if let Some(text) = text { instructions.text(path, "team_scratch", text); }
        }
        let skills = crate::providers::skills::for_agent(&self.engine.providers.skills_registry(), &skill_folders(ctx));
        // the org's shared notes as read now, last in the prompt. A CLI keeps
        // the copy it started with: the text stays out of the system prompt
        // part, so another agent's edit never respawns a warm CLI
        // (coordinator ruling (b), 2026-10-13)
        // each team workspace's notes come first, nearest team first (user
        // 2026-10-14 13:55Z), and share that delivery and that digest
        let notes_file = ctx.org_notes_dir.join(crate::config::ORG_NOTES_FILE);
        let team_notes: String = ctx.team_notes.iter()
            .map(|(file, label, text)| prompt::team_notes(&file.to_string_lossy(), label, text.as_deref())).collect();
        let notes = format!("{team_notes}{}", prompt::org_notes(&notes_file.to_string_lossy(), ctx.org_notes.as_deref()));
        let identity = format!("{base}{}{notes}", startup.global_notes);
        let mcp = json!({ "mcpServers": servers });
        let mut allowed: Vec<String> = servers.keys().map(|k| format!("mcp__{k}")).collect();
        if on("bash") {
            allowed.extend(["Bash".into(), "PowerShell".into()]);
        }
        if on("web") {
            allowed.extend(["WebSearch".into(), "WebFetch".into()]);
        }
        if on("bash") || on("subagents") {
            allowed.push("TaskStop".into());
        }
        let mut add_dirs: Vec<String> = Vec::new();
        let mut deny: Vec<String> = Vec::new();
        let shared_skills = skills.snapshot_path(&self.engine.cfg.path(""));
        add_dirs.push(shared_skills.to_string_lossy().into_owned());
        for tool in ["Edit", "Write", "NotebookEdit", "MultiEdit"] {
            deny.push(format!("{tool}(//{}/**)", shared_skills.to_string_lossy().replace('\\', "/").trim_start_matches('/')));
        }
        for d in ctx.effective["add_dirs"].as_array().cloned().unwrap_or_default() {
            let Some(p) = d["path"].as_str() else { continue };
            add_dirs.push(p.to_string());
            if d["mode"] == "ro" {
                let fp = p.replace('\\', "/");
                for t in ["Edit", "Write", "NotebookEdit", "MultiEdit"] {
                    deny.push(format!("{t}(//{}/**)", fp.trim_start_matches('/')));
                }
            }
        }
        let settings = if deny.is_empty() { json!({}) } else { json!({ "permissions": { "deny": deny } }) };
        let tools_print = format!("{}|{}|{}|{}|{}", disallowed.join(","), allowed.join(","), mcp,
            crate::domain::tool_groups::normalize(tools), json!(crate::tools::defs::scoped(tools)));
        let dirs_print = format!("{}|{}", add_dirs.join(";"), settings);
        let print = Fingerprint {
            instructions: Some(instructions),
            compact_at: Some(ctx.compact_at),
            parts: vec![
                ("system_prompt", hash(&base)),
                ("tools", hash(&tools_print)),
                ("model", ctx.model.clone()),
                ("permission_mode", ctx.effective["permission_mode"].as_str().unwrap_or("").to_string()),
                ("folders", hash(&dirs_print)),
                ("account", self.account_print(ctx)),
                ("startup", shared_startup_digest(&startup.digest, &skills)),
            ],
            org_notes: Some(hash(&notes)),
        };
        Plan { skills, identity, settings, mcp, disallowed, allowed, add_dirs, external, print, notes, rules_len }
    }

    /// The fingerprint's account part: the seat's binding, and once the
    /// secret of the registry row it bills was replaced, that replacement's
    /// generation (`#credential-N`, never the secret), so a warm CLI started
    /// on the old secret is replaced at the next turn boundary. A row never
    /// replaced prints as before.
    fn account_print(&self, ctx: &Ctx) -> String {
        let bound = ctx.account.clone().unwrap_or_default();
        let billed = if ctx.provider == catalog::OPENROUTER {
            Some(crate::openrouter::seat_key(&self.engine, ctx.account.as_deref()))
        } else {
            ctx.account.clone()
        };
        let generation = billed.and_then(|id| self.engine.accounts.view().get(&id).map(|a| a.credential)).unwrap_or(0);
        if generation > 0 { format!("{bound}#credential-{generation}") } else { bound }
    }

    /// Where this launch's CLI finds its startup instruction files: the same
    /// cwd and homes `claude_spec` and `ensure_codex` start it with.
    fn startup_inputs(&self, ctx: &Ctx) -> startup::Inputs {
        startup::with_globals(self.native_startup_inputs(ctx))
    }

    fn native_startup_inputs(&self, ctx: &Ctx) -> startup::Inputs {
        if ctx.harness.as_deref() == Some("opencode") { return startup::Inputs::None; }
        let codex = ctx.provider == catalog::OPENAI || ctx.harness.as_deref() == Some("codex-cli");
        if codex {
            let apikey = ctx.account.as_deref().and_then(|a| self.engine.accounts.view().get(a).map(|a| a.is_apikey())).unwrap_or(false);
            let home = if ctx.provider == catalog::OPENROUTER {
                self.engine.cfg.path("profiles").join("openrouter-codex")
            } else if ctx.provider == catalog::LANGSERVER {
                self.engine.cfg.path("profiles").join(LANGSERVER_CODEX_HOME)
            } else if apikey {
                self.engine.cfg.path("profiles").join(format!("openai-key-{}", ctx.account.clone().unwrap_or_default()))
            } else {
                self.config_dir_of(ctx.account.as_deref()).map(PathBuf::from).unwrap_or_else(codexrt::default_home)
            };
            return startup::Inputs::Codex { cwd: ctx.scratch.clone(), home };
        }
        if ctx.provider == catalog::GOOGLE {
            return startup::Inputs::Agy { home: crate::rig::home_dir().unwrap_or_else(|| PathBuf::from(".")), cwd: ctx.scratch.clone() };
        }
        if ctx.provider == catalog::MUSE {
            // Match muse_account_env without creating profile directories or
            // reading a key. Ambient logins preserve the inherited XDG root.
            let view = self.engine.accounts.view();
            let profile = ctx.account.as_deref().and_then(|id| view.get(id)).and_then(|account| {
                if account.is_apikey() { Some(crate::providers::muse_key_root(&self.engine, &account.id)) }
                else { account.config_dir.as_ref().map(PathBuf::from) }
            });
            let config = profile.map(|root| root.join("config/muse")).unwrap_or_else(|| {
                super::global_instructions::Roots::current().map(|roots| roots.config.join("muse"))
                    .unwrap_or_else(|| PathBuf::from(".config/muse"))
            });
            return startup::Inputs::Muse { cwd: ctx.scratch.clone(), config };
        }
        let config = if ctx.provider == catalog::OPENROUTER {
            None
        } else if ctx.provider == catalog::LANGSERVER {
            Some(self.engine.cfg.path("profiles").join(LANGSERVER_CLAUDE_CONFIG).to_string_lossy().to_string())
        } else {
            self.config_dir_of(ctx.account.as_deref())
        };
        let add_dirs = ctx.effective["add_dirs"].as_array().into_iter().flatten()
            .filter_map(|d| d["path"].as_str()).map(PathBuf::from).collect();
        startup::Inputs::Claude {
            cwd: ctx.scratch.clone(),
            config: config.map(PathBuf::from).unwrap_or_else(claude::default_config_dir),
            home: crate::rig::home_dir().unwrap_or_else(|| PathBuf::from(".")),
            add_dirs,
        }
    }

    /// Resolve only a login this launcher actually uses. OpenRouter routes bill
    /// their own key; Antigravity currently uses only its ambient sign-in.
    fn serving_account_of(&self, ctx: &Ctx) -> Option<String> {
        if ctx.provider == catalog::OPENROUTER { return None; }
        let view = self.engine.accounts.view();
        let account = view.get(ctx.account.as_deref()?)?;
        if account.provider != ctx.provider || (ctx.provider == catalog::GOOGLE && !account.ambient) {
            return None;
        }
        Some(account.id.clone())
    }

    fn config_dir_of(&self, account: Option<&str>) -> Option<String> {
        let acc = account?;
        let view = self.engine.accounts.view();
        let a = view.get(acc)?;
        if a.is_apikey() {
            None
        } else {
            a.config_dir.clone()
        }
    }

    /// An inactive account (App settings › Providers) serves no new turn:
    /// the agent's mail waits, and a running turn finishes.
    fn account_gate(&self, ctx: &Ctx, route: Option<&OrRoute>) -> Result<()> {
        // an OpenRouter seat bills the stored key, not an account
        if route.is_some() {
            return Ok(());
        }
        if catalog::antigravity_claude(&ctx.tier) && !self.engine.settings.antigravity_claude_enabled() {
            return Err(anyhow!("Claude models through Antigravity are turned off in App settings > Runtime"));
        }
        if let Some(reason) = crate::usage::antigravity_limit(&self.engine, &ctx.tier) {
            return Err(anyhow!(reason));
        }
        let view = self.engine.accounts.view();
        let acc = ctx.account.as_deref().and_then(|a| view.get(a));
        if ctx.provider == catalog::GOOGLE {
            if let Some(failure) = crate::providers::agy_auth::blocked(&self.engine) {
                return Err(anyhow!(failure));
            }
            if let Some(until) = acc.and_then(|a| a.limited_for(&ctx.tier, Utc::now())) {
                return Err(anyhow!("Antigravity {} quota is marked exhausted until {until}", catalog::antigravity_pool(&ctx.tier)));
            }
        }
        if ctx.provider == catalog::MUSE {
            if let Some(until) = acc.and_then(|a| a.limited_for(&ctx.tier, Utc::now())) {
                return Err(anyhow!("Muse refused {} for its quota until {until}", ctx.tier));
            }
        }
        // a legacy org key never serves another org's turn (3.x parity F02)
        if let Some(a) = acc.filter(|a| !a.available_origin(&ctx.org_slug)) {
            return Err(anyhow!(
                "the account {} is an org key restricted to another organization; move this agent to another account",
                a.id
            ));
        }
        if let Some(lane) = crate::org_accounts::barred(&self.engine, &ctx.org_slug, &ctx.tier, ctx.account.as_deref()) {
            return Err(anyhow!("{lane} is not used by this org (Org settings › Accounts); the agent moves at its next turn"));
        }
        if crate::accounts::active(&self.engine, &ctx.provider, acc) {
            return Ok(());
        }
        match acc {
            Some(a) if !crate::accounts::is_ambient(a) => Err(anyhow!(
                "the account {} is inactive (App settings › Providers); activate it or move this agent to another account",
                a.id
            )),
            _ => Err(anyhow!(
                "the signed-in {} subscription is inactive (App settings › Providers); activate it or move this agent to another account",
                catalog::provider_label(&ctx.provider)
            )),
        }
    }

    /// The earlier session is gone: the next turn starts with a handoff note.
    async fn flag_handoff(&self, why: &str) {
        if let Ok(client) = self.engine.db.get().await {
            let _ = client
                .execute(
                    "UPDATE ot.agents SET extra = jsonb_set(extra, '{handoff_due}', to_jsonb($2::text))
                      WHERE id = $1 AND NOT (extra ? 'handoff_due')
                        AND EXISTS (SELECT 1 FROM ot.convo c WHERE c.agent_id = $1)",
                    &[&self.id, &why],
                )
                .await;
        }
    }

    /// A due handoff (a provider switch, a session that could not be
    /// resumed): save the desk history to the agent's folder and return the
    /// note this turn starts with.
    async fn take_handoff(&mut self, ctx: &Ctx) -> Result<Option<String>> {
        let client = self.engine.db.get().await?;
        let why: Option<String> = client
            .query_one("SELECT extra->>'handoff_due' FROM ot.agents WHERE id = $1", &[&self.id])
            .await?
            .get(0);
        let Some(why) = why.or_else(|| ctx.handoff_due.clone()) else { return Ok(None) };
        let saved = match convo::save_history(&client, self.id, &ctx.scratch).await {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the earlier conversation could not be saved");
                None
            }
        };
        let note = convo::handoff_note(&client, self.id, &why, saved.as_deref()).await?;
        client
            .execute("UPDATE ot.agents SET extra = extra - 'handoff_due' - 'mooted_ask' WHERE id = $1", &[&self.id])
            .await?;
        tracing::info!(agent = %self.name, why = %why, "handoff note for a fresh session");
        Ok(Some(note))
    }

    /// Move an OpenRouter seat onto the harness it should run on (`want`),
    /// inside `start_turn`'s admission transaction (its row locked), before
    /// any mail is claimed. A seat never stamped is only stamped. A seat with
    /// a session ends it: the next turn starts a fresh session with a summary
    /// (the whole conversation saved in its folder), a new provider cache
    /// namespace, as a model switch across harnesses does.
    async fn cross_harness(&mut self, tx: deadpool_postgres::Transaction<'_>, ctx: &Ctx, want: &str) -> Result<()> {
        let Some(was) = ctx.harness_stamp.clone() else {
            tx.execute("UPDATE ot.agents SET extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('harness', $2::text) WHERE id = $1",
                &[&self.id, &want]).await?;
            tx.commit().await?;
            return Ok(());
        };
        let why = format!("its OpenRouter key now runs on {} (it ran on {})",
            crate::harnesses::label(want), crate::harnesses::label(&was));
        let session = ctx.session_id.clone();
        tx.execute(
            "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true,
                    extra = CASE WHEN $3 THEN jsonb_set(coalesce(extra, '{}'::jsonb) - 'cache_receipt', '{handoff_due}', to_jsonb($4::text))
                                 ELSE coalesce(extra, '{}'::jsonb) END || jsonb_build_object('harness', $2::text),
                    row_version = row_version + 1
              WHERE id = $1",
            &[&self.id, &want, &session.is_some(), &why],
        )
        .await?;
        if session.is_some() {
            tx.execute(
                "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'harness switch' WHERE agent_id = $1 AND ended_at IS NULL",
                &[&self.id],
            )
            .await?;
            crate::domain::asks::moot_for_fresh_session(&tx, self.id,
                "the asking session was replaced by a harness switch; the fresh session never posed it").await?;
        }
        tx.commit().await?;
        tracing::info!(agent = %self.name, from = %was, to = %want, fresh_session = session.is_some(), "OpenRouter harness switch at the turn boundary");
        if session.is_some() {
            let client = self.engine.db.get().await?;
            let row = json!({ "role": "system", "kind": "compact", "ts": now_iso(),
                              "text": format!("Harness switch: {why}, so the agent continues on a fresh session with a summary") });
            self.convo.append(&client, row).await?;
        }
        self.receipt = None;
        self.sent_print = None;
        self.close_proc().await;
        self.reconfigured = true;
        self.changed(vec![Change::Agent(self.id), Change::Asks, Change::Docket]);
        Ok(())
    }

    /// "Reset a session before a known-cold turn" (cheap compact; Org
    /// settings › Policies, or the agent's ⚙): when the prompt cache is known
    /// to be cold and the context is fuller than the setting's occupancy, the
    /// turn starts a fresh session seeded with a digest instead of re-reading
    /// the whole old one at full price. An unknown forecast never resets.
    /// Returns the note the turn's prompt starts with.
    async fn cold_reset(&mut self, ctx: &mut Ctx) -> Result<Option<String>> {
        let Some(session) = ctx.session_id.clone() else { return Ok(None) };
        if self.forecast_for(ctx)["precompact_action"] != "will_compact" {
            return Ok(None);
        }
        // load_ctx just sampled these facts for this admission; use the same
        // measured-context gate as the desk's forecast.
        let used = ctx.occupancy.unwrap_or_default();
        let window = ctx.context_window.unwrap_or_default();
        let client = self.engine.db.get().await?;
        // the whole conversation stays readable in the agent's folder (sign-off I2)
        let saved = match convo::save_history(&client, self.id, &ctx.scratch).await {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the earlier conversation could not be saved");
                None
            }
        };
        let note = convo::handoff_note(
            &client,
            self.id,
            "the prompt cache had expired, so your context was compacted before this turn",
            saved.as_deref(),
        )
        .await?;
        client
            .execute(
                "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true,
                        extra = extra - 'cache_receipt', row_version = row_version + 1
                  WHERE id = $1",
                &[&self.id],
            )
            .await?;
        client
            .execute(
                "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'cheap compact (cold cache)'
                  WHERE agent_id = $1 AND session_id = $2",
                &[&self.id, &session],
            )
            .await?;
        let row = json!({ "role": "system", "kind": "compact", "ts": now_iso(),
                          "text": "Context compacted before this turn: the prompt cache had expired, so the agent continues on a fresh session with a summary" });
        self.convo.append(&client, row).await?;
        drop(client);
        tracing::info!(agent = %self.name, used, window, "cheap compact before a cold-cache turn");
        ctx.session_id = None;
        ctx.occupancy = None;
        ctx.context_measured = false;
        self.receipt = None;
        self.sent_print = None;
        self.forecast = self.forecast_for(ctx);
        self.publish();
        self.changed(vec![Change::Agent(self.id)]);
        self.close_proc().await;
        self.reconfigured = true;
        Ok(Some(note))
    }

    /// The language server's window filled and the CLI could not compact the
    /// conversation: as a cheap compact does, the agent goes on in a fresh
    /// session that starts with a handoff note (the whole conversation saved
    /// in its folder), and a system message wakes it to carry on. `run`: the
    /// how-manieth fresh session in a row; only the first one tells it and
    /// its superior with the fresh-session notice (once, not at every retry).
    async fn fresh_after_full(&mut self, run: i64) -> Result<()> {
        let mut client = self.engine.db.get().await?;
        let tx = client.transaction().await?;
        let session: Option<String> =
            tx.query_one("SELECT session_id FROM ot.agents WHERE id = $1", &[&self.id]).await?.get(0);
        tx.execute(
            "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true, compacted_unrun = true,
                    extra = jsonb_set(extra - 'cache_receipt', '{handoff_due}', to_jsonb($2::text)),
                    row_version = row_version + 1
              WHERE id = $1",
            &[&self.id, &"your context window filled up and your CLI could not compact the conversation"],
        )
        .await?;
        if let Some(s) = &session {
            tx.execute(
                "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'context full (fresh session)'
                  WHERE agent_id = $1 AND session_id = $2 AND ended_at IS NULL",
                &[&self.id, s],
            )
            .await?;
        }
        let told = if run == 1 {
            crate::domain::lifecycle::record(&tx, self.org_id, "cheap_compact", "@system", Some(self.id),
                &json!({ "old_session": session.clone().unwrap_or_default(),
                         "why": "its context window filled up and its CLI could not compact the conversation" }))
            .await?
        } else {
            Vec::new()
        };
        tx.commit().await?;
        let row = json!({ "role": "system", "kind": "compact", "ts": now_iso(),
                          "text": "The context window filled up and the CLI could not compact the conversation: the agent goes on in a fresh session with a summary" });
        self.convo.append(&client, row).await?;
        drop(client);
        crate::changes::notify_id(&self.engine, self.org_id, told.into_iter().map(Change::Mailbox).collect());
        tracing::info!(agent = %self.name, old_session = ?session, "fresh session: the context filled and the CLI could not compact it");
        self.receipt = None;
        self.sent_print = None;
        self.reconfigured = true;
        crate::domain::mail::system_event(&self.engine, self.org_id, self.id,
            "Your context window filled up and your CLI could not compact the conversation, so you now run on a fresh \
             session: the note above has what you were working on. Carry on where you left off.",
            false, None)
        .await
    }

    /// The Claude CLI launch for this agent's next turn: binary, launch
    /// files, environment and session. `keepalive`: the same launch as a
    /// disposable prompt-cache read (`SpawnSpec::keepalive`). Also returns the
    /// config folder the CLI keeps its sessions under (None: the default).
    async fn claude_spec(&self, ctx: &Ctx, route: Option<&OrRoute>, plan: &Plan, keepalive: bool) -> Result<(SpawnSpec, Option<String>)> {
        plan.skills.materialize(&self.engine.cfg.path(""))?;
        let view = self.engine.accounts.view();
        // an OpenRouter seat bills the stored key: no account, no subscription
        let account = if route.is_some() { None } else { ctx.account.as_deref().and_then(|a| view.get(a).cloned()) };
        let apikey = account.as_ref().map(|a| a.is_apikey()).unwrap_or(false);
        // discovery runs in the background after start; do not race it
        let exe = match self.engine.providers.claude_path() {
            Some(p) => p,
            None => tokio::task::spawn_blocking(crate::providers::locate_claude)
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
                .ok_or_else(|| anyhow!("Claude Code is not installed on this machine"))?,
        };
        std::fs::create_dir_all(&ctx.scratch)?;
        let (identity_file, settings_file, mcp_file) =
            claude::write_launch_files(&ctx.scratch, &plan.identity, &plan.settings, &plan.mcp)?;
        // Essential-traffic mode (decision 53): agents share the user's global
        // CLI, so none of them checks for or applies an update mid-run. It also
        // turns off the CLI's server-side feature flags. Those are read from the
        // account's cache instead, the flags the user's own CLI runs with.
        let mut env: Vec<(String, String)> = vec![
            ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
            ("CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF".into(), "1".into()),
            ("ORGTREE_AGENT".into(), ctx.name.clone()),
            // 3.x's name for it: hooks and tools that run inside a CLI tell an
            // orgtree agent by it (the mail hub's SessionStart hook stands down)
            ("ORGTREE_NODE".into(), ctx.name.clone()),
            ("ORGTREE_ORG".into(), ctx.org_slug.clone()),
            // the org's compaction threshold (Org settings › Basic)
            ("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), format!("{}", (ctx.compact_at * 100.0).round() as i64)),
        ];
        // The identity promises Bash and PowerShell with the terminal switch
        // on. With the feature flags off, the CLI offers PowerShell beside Git
        // Bash only when asked. A keepalive asks too: its tool list must match.
        if ctx.effective["tools"].get("bash").and_then(Value::as_bool).unwrap_or(true) {
            env.push(("CLAUDE_CODE_USE_POWERSHELL_TOOL".into(), "1".into()));
        }
        // a keepalive runs no tool, so it needs no git/GitHub credentials
        if !keepalive {
            env.extend(self.engine.credential_bridge.environment(&self.engine,self.id,self.org_id,ctx.generation));
        }
        let mut env_remove: Vec<String> = vec![
            "ORGTREE_V2_TOKEN".into(),
            "ORGTREE_DATA".into(),
            "ELECTRON_RUN_AS_NODE".into(),
            "ANTHROPIC_API_KEY".into(),
            "ANTHROPIC_AUTH_TOKEN".into(),
            "ANTHROPIC_BASE_URL".into(),
            "CLAUDE_CONFIG_DIR".into(),
            "CLAUDECODE".into(),
            "CLAUDE_CODE_ENTRYPOINT".into(),
        ];
        let local = route.and_then(|r| r.local.as_ref());
        let config_dir = if let Some(_l) = local {
            // its own config folder: no saved login to send to the server, and
            // no user settings whose `env` block would override this launch's
            let dir = self.engine.cfg.path("profiles").join(LANGSERVER_CLAUDE_CONFIG);
            std::fs::create_dir_all(&dir)?;
            Some(dir.to_string_lossy().to_string())
        } else if route.is_some() {
            None
        } else {
            self.config_dir_of(ctx.account.as_deref())
        };
        if let Some(l) = local {
            env.extend(crate::langserver::claude_env(l));
            env_remove.extend(crate::langserver::CLAUDE_ENV_REMOVE.iter().map(|v| v.to_string()));
        } else if let Some(r) = &route {
            // OpenRouter's Claude Code recipe: the Anthropic-compatible base, the key
            // as the auth token, ANTHROPIC_API_KEY empty (a set key wins over the
            // token), and every model the CLI could reach for pinned to the hired one
            env.push(("ANTHROPIC_BASE_URL".into(), crate::openrouter::ANTHROPIC_BASE.into()));
            env.push(("ANTHROPIC_AUTH_TOKEN".into(), r.key.clone()));
            env.push(("ANTHROPIC_API_KEY".into(), String::new()));
            for var in [
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                env.push((var.into(), ctx.model.clone()));
            }
        }
        if apikey {
            let key = ctx.api_key.clone().ok_or_else(|| anyhow!("the API-key account has no key stored"))?;
            if key.starts_with("sk-ant-oat") {
                env.push(("CLAUDE_CODE_OAUTH_TOKEN".into(), key));
            } else {
                env.push(("ANTHROPIC_API_KEY".into(), key));
                env_remove.retain(|k| k != "ANTHROPIC_API_KEY");
            }
        }
        if let Some(dir) = &config_dir {
            env.push(("CLAUDE_CONFIG_DIR".into(), dir.clone()));
            env_remove.retain(|k| k != "CLAUDE_CONFIG_DIR");
        }
        // resume the session where this CLI will look for it
        let mut resume = ctx
            .session_id
            .clone()
            .filter(|_| ctx.session_provider.as_deref().map(|p| p == ctx.provider).unwrap_or(true));
        if let Some(sid) = resume.clone() {
            let others: Vec<String> = view.all().into_iter().filter_map(|a| a.config_dir.clone()).collect();
            if !claude::ensure_session(&ctx.scratch, &sid, config_dir.as_deref(), &others) {
                tracing::warn!(agent = %ctx.name, session = %sid, "session transcript not found; starting a new session");
                resume = None;
            }
        }
        // Launch-time effort applies to every Claude harness tier, including
        // Haiku and OpenRouter; live_effort only controls mid-turn changes.
        // Claude Code's own name for the saved level (`launch_effort`: a level
        // another harness names maps to the nearest one Claude Code takes)
        let effort = Some(crate::providers::launch_effort(&self.engine, &ctx.tier, &ctx.effort).0).filter(|e| !e.is_empty());
        let spec = SpawnSpec {
            exe,
            cwd: ctx.scratch.clone(),
            model: ctx.model.clone(),
            permission_mode: ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits").to_string(),
            effort: effort.clone(),
            identity_file,
            settings_file,
            mcp_file,
            disallowed: plan.disallowed.clone(),
            allowed: plan.allowed.clone(),
            add_dirs: plan.add_dirs.iter().filter(|d| std::path::Path::new(d).exists()).cloned().collect(),
            resume: resume.clone(),
            new_session: uuid::Uuid::new_v4().to_string(),
            env,
            env_remove,
            keepalive,
            // a cache read stays here; ensure_proc places the agent's own CLI
            host: None,
        };
        Ok((spec, config_dir))
    }

    async fn ensure_proc(&mut self, ctx: &Ctx) -> Result<()> {
        // The S4U boot warning comes from the cached credential context
        // (probed at start and on session change), never a probe per spawn.
        let route = if ctx.provider == catalog::OPENROUTER {
            Some(self.openrouter_route(ctx).await?)
        } else if ctx.provider == catalog::LANGSERVER {
            Some(self.langserver_route(ctx).await?)
        } else {
            None
        };
        self.account_gate(ctx, route.as_ref())?;
        // the org's shared notes folder exists before a CLI is given it; the
        // file is the agents' to create
        if let Err(e) = std::fs::create_dir_all(&ctx.org_notes_dir) {
            tracing::warn!(agent = %ctx.name, error = %e, "the org's shared notes folder could not be created");
        }
        // and so do the team workspaces it holds
        for dir in ctx.effective["add_dirs"].as_array().into_iter().flatten().filter(|d| scope::is_team_workspace(d)) {
            if let Some(path) = dir["path"].as_str() {
                if let Err(e) = std::fs::create_dir_all(path) {
                    tracing::warn!(agent = %ctx.name, error = %e, path, "a team workspace could not be created");
                }
            }
        }
        if ctx.harness.as_deref() == Some("opencode") {
            let route = route.as_ref().ok_or_else(|| anyhow!("OpenCode requires an OpenRouter or language-server lane"))?;
            return self.ensure_acp(ctx, route).await;
        }
        if ctx.provider == catalog::OPENAI || route.as_ref().map(|r| r.codex).unwrap_or(false) {
            return self.ensure_codex(ctx, route.as_ref()).await;
        }
        if ctx.provider == catalog::GOOGLE {
            return self.ensure_agy(ctx).await;
        }
        if ctx.provider == catalog::MUSE {
            return self.ensure_muse(ctx).await;
        }
        if ctx.provider != catalog::CLAUDE && route.is_none() {
            return Err(anyhow!("{} agents cannot run on this engine build yet", catalog::provider_label(&ctx.provider)));
        }
        if route.is_none() && !self.engine.settings.provider_enabled(catalog::CLAUDE) {
            return Err(anyhow!("Claude is turned off in App settings"));
        }
        let plan = self.plan(ctx);
        let want = self.want_hosted(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => {
                !p.is_codex() && !p.is_agy() && !p.is_muse() && !p.is_acp() && self.proc_print.as_ref() == Some(&plan.print) && !self.reconfigured && p.alive()
                    && p.hosted_in() == want
            }
            None => false,
        };
        if reuse {
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
        let (mut spec, _) = self.claude_spec(ctx, route.as_ref(), &plan, false).await?;
        spec.host = want;
        let resume = spec.resume.clone();
        let effort = spec.effort.clone();
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let proc = ClaudeProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        let session_id = proc.session_id.clone();
        if ctx.session_id.is_some() && resume.as_deref() != Some(session_id.as_str()) {
            self.flag_handoff("its previous session could not be resumed").await;
        }
        if resume.as_deref() != Some(session_id.as_str()) {
            // a new session: its cost counter starts at zero
            self.cost_seen = 0.0;
            let client = self.engine.db.get().await?;
            client
                .execute(
                    "UPDATE ot.agents SET session_id = $2, provider = $3,
                            extra = jsonb_set(extra, '{cost_seen}', '0'::jsonb) WHERE id = $1",
                    &[&self.id, &session_id, &ctx.provider],
                )
                .await?;
            client
                .execute(
                    "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id) VALUES ($1, $2, $3, $4)",
                    &[&self.id, &ctx.generation, &ctx.provider, &session_id],
                )
                .await?;
        }
        self.engine.credential_bridge.bind(self.id,proc.pid);
        self.proc = Some(Proc::Claude(proc));
        self.proc_print = Some(plan.print);
        self.proc_notes = Some(plan.notes);
        self.proc_effort = effort;
        self.provider = ctx.provider.clone();
        self.mcp = McpState { last_turn_count: self.mcp.last_turn_count, ..McpState::default() };
        if !plan.external.is_empty() {
            self.mcp.waiting = true;
            self.mcp.state = Some("connecting".into());
            self.mcp.reason = Some(format!("connecting to {}", plan.external.join(", ")));
        }
        self.publish();
        if !plan.external.is_empty() && self.engine.settings.wait_for_mcp_tools() {
            self.wait_for_mcp(&plan.external).await;
        }
        Ok(())
    }

    /// Where this agent's next CLI starts (`session_host::wanted`): in the
    /// operator's signed-in session while the sign-in helper hosts, else here
    /// in Session 0. A warm CLI elsewhere is replaced at this turn's start,
    /// never during a turn; one that still holds background work stays where
    /// it is, since replacing it would end that work, and moves at a later turn.
    /// (Codex decides in `codex_seat`, with its sandbox.)
    fn want_hosted(&mut self, ctx: &Ctx) -> Option<u32> {
        let bypass = ctx.effective["permission_mode"].as_str() == Some("bypassPermissions");
        self.bypass_seat = bypass;
        self.session_pref = ctx.session_pref.clone();
        let want = crate::runtime::session_host::wanted(&self.engine, bypass, &self.session_pref, self.use_session.take());
        match self.proc.as_ref() {
            Some(p) if self.bg_pending() && p.hosted_in() != want => p.hosted_in(),
            _ => want,
        }
    }

    /// Where this agent's CLI runs now and where its next turn's will, for
    /// orgtree_session (docket let-agents-query-machine-sign-in-state-and-which):
    /// the choice `want_hosted` and `codex_seat` would make if that turn
    /// started now. `this_turn` is null while no CLI runs.
    fn session_view(&self) -> Value {
        let s0 = codexrt::session0();
        let place = |hosted: Option<u32>| if hosted.is_some() || !s0 { SIGNED_IN } else { SESSION0 };
        let own = crate::runtime::session_host::engine_session();
        let want = crate::runtime::session_host::wanted(&self.engine, self.bypass_seat, &self.session_pref, self.use_session);
        let current = self.proc.as_ref().map(|p| p.hosted_in());
        // a CLI holding background work stays where it is (not Codex's)
        let held = self.proc.as_ref().is_some_and(|p| !p.is_codex() && self.bg_pending() && p.hosted_in() != want);
        let next = if held { current.flatten() } else { want };
        json!({
            "this_turn": current.map(place),
            "this_session": current.map(|c| c.unwrap_or(own)),
            "next_turn": place(next),
            "next_session": next.unwrap_or(own),
            "held_by_background_work": held,
            "preference": crate::runtime::session_host::pref_value(&self.session_pref),
            "use": self.use_session,
        })
    }

    /// orgtree_interrupt on itself (the user, 2026-10-16 12:05Z): end the
    /// running turn, a deliberate end, so a sign-out at the same moment adds
    /// no resume; with `restart`, `end_turn` wakes one new turn at once.
    /// Refused while the CLI holds background work, which would be left
    /// running (and keep the CLI where it is).
    fn interrupt_self(&mut self, restart: bool) -> Value {
        if self.turn.is_none() {
            return json!({ "interrupted": false, "reason": "no turn is running" });
        }
        if self.bg_pending() {
            return json!({ "interrupted": false,
                "reason": "your CLI still runs background work: finish or stop it, then call orgtree_interrupt again" });
        }
        let codex_turn = self.turn.as_ref().and_then(|t| t.codex_turn.clone());
        if !self.proc.as_ref().is_some_and(|p| p.interrupt(codex_turn.as_deref())) {
            return json!({ "interrupted": false, "reason": "the process could not be reached" });
        }
        if let Some(t) = self.turn.as_mut() {
            t.interrupted = true;
            t.restart = restart;
        }
        tracing::info!(agent = %self.name, restart, "the agent ended its own turn");
        json!({ "interrupted": true, "restart": restart })
    }

    /// Whether the sign-in helper that started the CLI (`host`) is gone,
    /// given `SESSION_GONE_WAIT` to go: that helper, not the last one.
    async fn session_gone(&self, host: Option<crate::runtime::session_host::Host>) -> bool {
        let Some(host) = host else { return false };
        let until = Instant::now() + SESSION_GONE_WAIT;
        loop {
            if helper_gone(host, &self.engine.credential_bridge.helpers()) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Where the agent's last turn ran (`SIGNED_IN`, `SESSION0`), if it ran one.
    async fn last_session(&self) -> Option<String> {
        let client = self.engine.db.get().await.ok()?;
        client.query_one("SELECT extra->>'session' FROM ot.agents WHERE id = $1", &[&self.id]).await.ok()?.get(0)
    }

    /// After an engine restart while the operator was signed in, the sign-in
    /// helper registers again within seconds. The agent's first turn waits for
    /// it, at most `SESSION_SETTLE` from the engine's start, before it picks
    /// where its CLI runs, so a restart is no move out of the signed-in session
    /// and back. Its expiry is logged once.
    async fn session_settle(&mut self) {
        if std::mem::replace(&mut self.settled, true) || !codexrt::session0() || self.engine.credential_bridge.can_host() {
            return;
        }
        if self.last_session().await.as_deref() != Some(SIGNED_IN) {
            return;
        }
        let elapsed = (Utc::now() - self.engine.boot.started_at).to_std().unwrap_or_default();
        let until = Instant::now() + SESSION_SETTLE.saturating_sub(elapsed);
        while Instant::now() < until {
            if self.engine.credential_bridge.can_host() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !SETTLE_EXPIRED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            tracing::warn!(seconds = SESSION_SETTLE.as_secs(), "the sign-in helper did not register again after the engine's start; agents start in Session 0");
        }
    }

    /// Where this turn's CLI runs, against where the agent's last turn ran
    /// (persisted, so a restart that comes back in the same session is no
    /// move). The first turn since the engine started says it in the restart
    /// notice it delivers ("Session access at start"). A real move between
    /// Session 0 and the operator's signed-in session is told in this turn,
    /// both ways (the user, 2026-10-16 09:37Z, 09:37:53Z and 09:37:58Z). An
    /// engine not in Session 0 runs every CLI in the signed-in session.
    async fn session_notes(&mut self, turn_id: i64, raw: &mut Vec<Value>) {
        let Some(hosted) = self.proc.as_ref().map(|p| p.hosted()) else { return };
        let now = if hosted || !codexrt::session0() { SIGNED_IN } else { SESSION0 };
        if !std::mem::replace(&mut self.session_noted, true) {
            let line = format!("\nSession access at start: {}.", if now == SIGNED_IN { "signed-in session" } else { "Session 0" });
            for m in raw.iter_mut().filter(|m| m["ev"]["variant"] == "runtime.restart_notice") {
                let (Some(id), Some(body)) = (m["id"].as_i64(), m["body"].as_str().map(|b| format!("{b}{line}"))) else { continue };
                if let Ok(client) = self.engine.db.get().await {
                    let _ = client.execute("UPDATE ot.mail SET body = $2 WHERE id = $1", &[&id, &body]).await;
                }
                m["body"] = Value::String(body);
            }
        }
        let before = self.last_session().await;
        if before.as_deref() == Some(now) {
            return;
        }
        if let Ok(client) = self.engine.db.get().await {
            let _ = client
                .execute("UPDATE ot.agents SET extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{session}', to_jsonb($2::text)) WHERE id = $1",
                    &[&self.id, &now])
                .await;
        }
        // an agent's first turn ever is no move
        if before.is_none() {
            return;
        }
        tracing::info!(agent = %self.name, from = before.as_deref().unwrap_or(""), to = now, "the agent moved between sessions at this turn");
        let uid = match crate::domain::runtime_notices::session_moved(&self.engine, self.org_id, self.id, now == SIGNED_IN).await {
            Ok(uid) => uid,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the session notice could not be sent");
                return;
            }
        };
        // into this turn: the move took effect here
        let Ok(client) = self.engine.db.get().await else { return };
        if let Ok(Some(row)) = client
            .query_opt("UPDATE ot.mail SET state = 'delivering', turn_id = $3
                         WHERE uid = $1 AND recipient_agent_id = $2 AND state = 'pending'
                         RETURNING to_jsonb(ot.mail.*)", &[&uid, &self.id, &turn_id])
            .await
        {
            raw.push(row.get(0));
        }
    }

    /// Start (or keep) the agent's Codex app-server on its thread.
    /// The Codex seat's sandbox and whether the sign-in helper hosts it: the
    /// one chosen for this launch while its inputs hold, else a fresh choice.
    fn codex_seat(&self, may_write: bool, pm: &str) -> (codexrt::Sandbox, Option<u32>) {
        match &self.codex_seat {
            Some((w, p, sb, hosted)) if *w == may_write && p == pm => (*sb, *hosted),
            _ => codexrt::seat_sandbox(&self.engine, may_write, pm, &self.session_pref, None),
        }
    }

    async fn ensure_codex(&mut self, ctx: &Ctx, route: Option<&OrRoute>) -> Result<()> {
        if route.is_none() && !self.engine.settings.provider_enabled(catalog::OPENAI) {
            return Err(anyhow!("OpenAI is turned off in App settings"));
        }
        // decided once, before the prompt is built: a changed placement (the
        // helper came or went) changes the prompt, so the Codex is relaunched
        {
            let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
            let may_write = ctx.effective["tools"].get("edit").and_then(Value::as_bool).unwrap_or(true) && pm != "plan";
            self.session_pref = ctx.session_pref.clone();
            let (sb, hosted) = codexrt::seat_sandbox(&self.engine, may_write, pm, &self.session_pref, self.use_session.take());
            self.codex_seat = Some((may_write, pm.to_string(), sb, hosted));
            self.bypass_seat = codexrt::sandbox(may_write, pm, false).mode == "danger-full-access";
        }
        let plan = self.plan(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => p.is_codex() && self.proc_print.as_ref() == Some(&plan.print) && !self.reconfigured && p.alive(),
            None => false,
        };
        if reuse {
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
        let view = self.engine.accounts.view();
        let account = if route.is_some() { None } else { ctx.account.as_deref().and_then(|a| view.get(a).cloned()) };
        let apikey = account.as_ref().map(|a| a.is_apikey()).unwrap_or(false);
        let exe = match self.engine.providers.codex_path() {
            Some(p) => p,
            None => tokio::task::spawn_blocking(crate::providers::locate_codex)
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
                .ok_or_else(|| anyhow!("the Codex CLI is not installed on this machine"))?,
        };
        std::fs::create_dir_all(&ctx.scratch)?;
        // a key account runs in its own empty home, so the ambient login never bills it
        let local = route.and_then(|r| r.local.as_ref());
        let (codex_home, api_key) = if route.is_some() {
            // its own home: the host login never holds OpenRouter (or
            // language-server) threads, and no login is ever sent to a server
            let home = self.engine.cfg.path("profiles").join(if local.is_some() { LANGSERVER_CODEX_HOME } else { "openrouter-codex" });
            std::fs::create_dir_all(&home)?;
            (Some(home.to_string_lossy().to_string()), None)
        } else if apikey {
            let key = ctx.api_key.clone().ok_or_else(|| anyhow!("the API-key account has no key stored"))?;
            let id = ctx.account.clone().unwrap_or_default();
            let home = self.engine.cfg.path("profiles").join(format!("openai-key-{id}"));
            std::fs::create_dir_all(&home)?;
            (Some(home.to_string_lossy().to_string()), Some(key))
        } else {
            (self.config_dir_of(ctx.account.as_deref()), None)
        };
        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let may_write = on("edit") && pm != "plan";
        let (sandbox, hosted) = self.codex_seat(may_write, pm);
        // a hosted seat falls back to Session 0 if the helper cannot start it
        let host = hosted.map(|session| (codexrt::sandbox(may_write, pm, true), session));
        let servers = plan.mcp["mcpServers"].as_object().cloned().unwrap_or_default();
        let external: serde_json::Map<String, Value> = servers.into_iter().filter(|(k, _)| k != "orgtree").collect();
        let (mut config, _attached) = codexrt::mcp_overrides(&external);
        if let Some(l) = local {
            // the server's model catalog (checked against this Codex), its
            // window and the org's compaction threshold come with it
            let catalog = match (crate::langserver::server(&self.engine, &l.server), codex_home.as_deref()) {
                (Some(s), Some(home)) => crate::langserver::codex_catalog_file(&exe, std::path::Path::new(home), &s).await,
                _ => None,
            };
            let mut gateway = crate::langserver::codex_overrides(l, ctx.compact_at, catalog.as_deref());
            gateway.append(&mut config);
            config = gateway;
        } else if route.is_some() {
            let mut gateway = crate::openrouter::codex_overrides(&ctx.model);
            gateway.append(&mut config);
            config = gateway;
        }
        // the org's compaction threshold (Org settings › Basic), in tokens
        let window = catalog::tier(&ctx.tier).and_then(|t| t.context).map(|c| c as f64).or_else(|| {
            crate::openrouter::favorite(&self.engine, &ctx.tier).and_then(|f| f["context"].as_f64()).filter(|c| *c > 0.0)
        });
        if let Some(w) = window.filter(|_| local.is_none()) {
            config.push("-c".into());
            config.push(format!("model_auto_compact_token_limit={}", (w * ctx.compact_at) as i64));
        }
        let resume = ctx
            .session_id
            .clone()
            .filter(|_| ctx.session_provider.as_deref() == Some(ctx.provider.as_str()));
        // the thread may live under another account's Codex home
        if let Some(tid) = &resume {
            let mut others: Vec<std::path::PathBuf> =
                view.all().into_iter().filter(|a| a.provider == catalog::OPENAI).filter_map(|a| a.config_dir.clone()).map(Into::into).collect();
            if let Ok(entries) = std::fs::read_dir(self.engine.cfg.path("profiles")) {
                others.extend(entries.flatten().map(|e| e.path()).filter(|p| p.join("sessions").is_dir()));
            }
            let home = codex_home.clone();
            let tid = tid.clone();
            let _ = tokio::task::spawn_blocking(move || codexrt::ensure_rollout(&tid, home.as_deref(), &others)).await;
        }
        let bridge_env=self.engine.credential_bridge.environment(&self.engine,self.id,self.org_id,ctx.generation);
        config.extend(crate::credential_bridge::codex_overrides(&bridge_env));
        config.extend(super::tool_policy::codex_overrides(tools));
        let spec = CodexSpec {
            skills_root: plan.skills.materialize(&self.engine.cfg.data_root)?.join("skills"),
            exe,
            cwd: ctx.scratch.clone(),
            codex_home,
            api_key,
            model: ctx.model.clone(),
            // a gateway model that takes no reasoning gets no effort
            // the Codex model's own name for the saved level (its model/list levels)
            effort: Some(codexrt::codex_effort(&if route.is_none() {
                crate::providers::launch_effort(&self.engine, &ctx.tier, &ctx.effort).0
            } else {
                ctx.effort.clone()
            }))
            .filter(|_| route.map(|r| r.reasoning).unwrap_or(true)),
            sandbox,
            instructions: plan.identity.clone(),
            dynamic_tools: codexrt::dynamic_tools(tools),
            config,
            resume: resume.clone(),
            may_write,
            may_shell: on("bash"),
            may_subagents: on("subagents"),
            host,
            env: {
                let mut env = vec![("ORGTREE_AGENT".into(), ctx.name.clone()), ("ORGTREE_NODE".into(), ctx.name.clone()),
                                   ("ORGTREE_ORG".into(), ctx.org_slug.clone())];
                env.extend(bridge_env);
                if let Some(r) = route {
                    let var = if r.local.is_some() { crate::langserver::KEY_ENV } else { crate::openrouter::KEY_ENV };
                    env.push((var.into(), r.key.clone()));
                }
                env
            },
        };
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let mut proc = CodexProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        let session_id = proc.session_id.clone();
        if resume.is_some() && resume.as_deref() != Some(session_id.as_str()) {
            self.flag_handoff("its previous Codex thread could not be resumed").await;
        }
        if resume.as_deref() != Some(session_id.as_str()) {
            // a new thread counts from zero: its first turn is every call it
            // made, not only the last (the guess for a resumed thread whose
            // earlier total is unknown, e.g. after an engine restart)
            self.codex_total = Some(json!({}));
            let recorded: Result<()> = async {
                let client = self.engine.db.get().await?;
                client
                    .execute("UPDATE ot.agents SET session_id = $2, provider = $3 WHERE id = $1", &[&self.id, &session_id, &ctx.provider])
                    .await?;
                client
                    .execute(
                        "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id) VALUES ($1, $2, $3, $4)",
                        &[&self.id, &ctx.generation, &ctx.provider, &session_id],
                    )
                    .await?;
                Ok(())
            }
            .await;
            if let Err(e) = recorded {
                // ended gracefully, never by dropping it
                proc.close().await;
                return Err(e);
            }
        }
        self.engine.credential_bridge.bind(self.id,proc.pid);
        self.proc = Some(Proc::Codex(proc));
        self.proc_print = Some(plan.print);
        self.proc_notes = Some(plan.notes);
        self.proc_effort = Some(ctx.effort.clone());
        self.provider = ctx.provider.clone();
        self.mcp = McpState { last_turn_count: self.mcp.last_turn_count, ..McpState::default() };
        self.publish();
        Ok(())
    }

    /// Start (or keep) the agent's Antigravity process on its conversation.
    async fn ensure_agy(&mut self, ctx: &Ctx) -> Result<()> {
        if !self.engine.settings.provider_enabled(catalog::GOOGLE) {
            return Err(anyhow!("Antigravity is turned off in App settings"));
        }
        if let Some(failure) = crate::providers::agy_auth::blocked(&self.engine) {
            self.close_proc().await;
            return Err(anyhow!(failure));
        }
        let exe = match self.engine.providers.agy_path() {
            Some(p) => p,
            None => tokio::task::spawn_blocking(crate::providers::locate_agy).await.ok().flatten()
                .map(|(p, _)| p).ok_or_else(|| anyhow!("the Antigravity CLI is not installed on this machine"))?,
        };
        let stamp = match crate::providers::agy_auth::preflight(&self.engine, &exe).await {
            Ok(stamp) => stamp,
            Err(e) => { self.close_proc().await; return Err(e.into()); }
        };
        let mut plan = self.plan(ctx);
        let want = self.want_hosted(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => {
                matches!(&*p, Proc::Agy(a) if a.auth_stamp == stamp)
                    && self.proc_print.as_ref() == Some(&plan.print)
                    && self.proc_effort.as_deref() == Some(ctx.effort.as_str())
                    && !self.reconfigured
                    && p.alive()
                    && p.hosted_in() == want
            }
            None => false,
        };
        if reuse {
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
        std::fs::create_dir_all(&ctx.scratch)?;
        if agyrt::migrate_generated_identity(&ctx.scratch)? {
            // Removing a native legacy file changes startup, not the identity.
            // Capture the post-migration manifest before saving proc_print.
            plan = self.plan(ctx);
        }
        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let servers = plan.mcp["mcpServers"].as_object().cloned().unwrap_or_default();
        let granted: serde_json::Map<String, Value> = servers.into_iter().filter(|(k, _)| k != "orgtree").collect();
        let conversation = ctx
            .session_id
            .clone()
            .filter(|_| ctx.session_provider.as_deref() == Some(catalog::GOOGLE));
        let spec = AgySpec {
            exe,
            cwd: ctx.scratch.clone(),
            model: catalog::antigravity_model(&ctx.tier, &ctx.model, &ctx.effort),
            effort: Some(catalog::antigravity_effort(&ctx.tier, &ctx.effort).to_string()),
            conversation,
            identity: plan.identity.clone(),
            notes_from: plan.rules_len,
            servers: granted,
            bash: on("bash"),
            edit: on("edit") && pm != "plan",
            web: on("web"),
            subagents: on("subagents"),
            env: { let mut env = self.engine.credential_bridge.environment(&self.engine,self.id,self.org_id,ctx.generation); env.extend(vec![
                ("ORGTREE_AGENT".into(), ctx.name.clone()),
                ("ORGTREE_NODE".into(), ctx.name.clone()),
                ("ORGTREE_ORG".into(), ctx.org_slug.clone()),
                ("ORGTREE_AGY_STEER_DIR".into(), agyrt::steer_dir(&ctx.scratch).to_string_lossy().to_string()),
            ]); env },
            turn_timeout_s: self.engine.settings.turn_timeout_s(),
            host: want,
        };
        self.agy_steer_dir = Some(agyrt::steer_dir(&ctx.scratch));
        plan.skills.workspace(&ctx.scratch)?;
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let proc = AgyProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        self.engine.credential_bridge.bind(self.id,proc.pid);
        self.proc = Some(Proc::Agy(proc));
        self.proc_print = Some(plan.print);
        self.proc_notes = Some(plan.notes);
        self.proc_effort = Some(ctx.effort.clone());
        self.provider = ctx.provider.clone();
        self.mcp = McpState { last_turn_count: self.mcp.last_turn_count, ..McpState::default() };
        self.publish();
        Ok(())
    }

    /// Start (or keep) the agent's Muse host on its session. The model must
    /// be a row of the signed-in account's own catalog (a bundled row offers
    /// nothing, user 2026-10-12); the level goes with each turn, the nearest
    /// one the model lists at or below the saved level when it does not list
    /// the saved one (catalog::launch_effort).
    #[nolog]
    async fn ensure_acp(&mut self, ctx: &Ctx, route: &OrRoute) -> Result<()> {
        let plan = self.plan(ctx);
        let want = self.want_hosted(ctx);
        if self.proc.as_mut().is_some_and(|p| p.is_acp() && p.alive() && p.hosted_in() == want)
            && self.proc_print.as_ref() == Some(&plan.print) && !self.reconfigured { return Ok(()); }
        self.close_proc().await;
        self.reconfigured = false;
        let exe = self.engine.providers.state.load().opencode.path.clone()
            .filter(|p| p.is_file()).ok_or_else(|| anyhow!("OpenCode with ACP is not installed or its discovery has not completed"))?;
        std::fs::create_dir_all(&ctx.scratch)?;
        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let may_write = on("edit") && pm != "plan";
        let skills_snapshot = plan.skills.materialize(&self.engine.cfg.data_root)?;
        let skills_root = skills_snapshot.join("skills");
        let mut read = vec![ctx.scratch.clone(), skills_snapshot];
        let mut write = if may_write { vec![ctx.scratch.clone()] } else { vec![] };
        for dir in ctx.effective["add_dirs"].as_array().into_iter().flatten() {
            let Some(path) = dir["path"].as_str().map(PathBuf::from) else { continue };
            read.push(path.clone());
            if may_write && dir["mode"] != "ro" { write.push(path); }
        }
        let granted = plan.mcp["mcpServers"].as_object().cloned().unwrap_or_default();
        let policy = acp_scope::Policy { cwd:ctx.scratch.clone(),read,write,may_write,
            may_shell:on("bash"),may_web:on("web"),bypass:pm=="bypassPermissions",
            mcp_tools:crate::tools::defs::scoped(tools).iter().filter_map(|d| d["name"].as_str().map(|n| format!("orgtree_{n}"))).collect(),
            mcp_prefixes:granted.keys().filter(|k| k.as_str()!="orgtree").map(|k| format!("{}_",opencodert::server_alias(k))).collect() };
        let context = route.local.as_ref().map(|r| r.context as u64)
            .or_else(|| crate::openrouter::favorite(&self.engine,&ctx.tier).and_then(|f| f["context"].as_u64())).unwrap_or(65536).max(1024);
        let spec = opencodert::Spec { exe,cwd:ctx.scratch.clone(),
            skills_roots: vec![skills_root],
            skill_names: plan.skills.names(),
            profile:self.engine.cfg.path("profiles").join("opencode").join(self.org_id.to_string()).join(self.id.to_string()).join(ctx.generation.to_string()),
            base_url:route.local.as_ref().map(|r| r.base_url.clone()).unwrap_or_else(|| "https://openrouter.ai/api/v1".into()),
            key:route.key.clone(),model:ctx.model.clone(),context,output:(context/4).min(8192),
            identity:plan.identity.clone(),policy,servers:granted,who:format!("{} / {}",ctx.org_slug,ctx.name),host:want };
        let resume = ctx.session_id.clone().filter(|_| ctx.session_provider.as_deref()==Some(ctx.provider.as_str()));
        let actor = self.tx.clone();
        let emit = Arc::new(move |process, event| {
            match event {
                opencodert::SessionEvent::Update { turn,value } => { actor.post(AgentMsg::Acp(process,json!({"turn":turn,"update":value["params"]["update"]}))); },
                opencodert::SessionEvent::Finished { turn,result } => {
                    let message = match result {
                        Ok(result) => json!({"turn":turn,"result":result}),
                        Err(e) => json!({"turn":turn,"error":e.to_string()}),
                    };
                    actor.post(AgentMsg::Acp(process,message));
                },
                opencodert::SessionEvent::Ended(reason) => { actor.post(AgentMsg::ProcExited {process,reason}); },
            }
        });
        let caller = Caller {org_id:self.org_id,org_slug:ctx.org_slug.clone(),agent_id:self.id,name:ctx.name.clone()};
        let mut proc = OpenCodeProc::spawn(spec,self.engine.clone(),caller,resume.clone(),emit).await?;
        if resume.as_deref()!=Some(proc.session_id.as_str()) {
            let recorded: Result<()> = async {
                let client = self.engine.db.get().await?;
                client.execute("UPDATE ot.agents SET session_id=$2, provider=$3 WHERE id=$1",&[&self.id,&proc.session_id,&ctx.provider]).await?;
                client.execute("INSERT INTO ot.agent_sessions (agent_id,generation,provider,session_id) VALUES ($1,$2,$3,$4)",
                    &[&self.id,&ctx.generation,&ctx.provider,&proc.session_id]).await?;
                Ok(())
            }.await;
            if let Err(e)=recorded { proc.close().await;return Err(e); }
        }
        self.init=json!({"model":ctx.model,"session":proc.session_id,"harness":"opencode","protocol":"ACP1",
            "mcp_handshake_observed":proc.mcp_observed,"mid_turn_mail":"queued","effort":"not configured","cost":"unknown; provider usage authoritative"});
        self.mcp=McpState { state:Some(if proc.mcp_observed {"handshake_observed"} else {"unobserved"}.into()),
            reason:Some("OpenCode registers tools asynchronously; handshake plus catalog settle is not a catalog acknowledgement".into()),
            last_turn_count:self.mcp.last_turn_count,..McpState::default() };
        self.proc=Some(Proc::Acp(proc));self.proc_print=Some(plan.print);self.proc_notes=Some(plan.notes);
        self.proc_effort=Some(ctx.effort.clone());self.provider=ctx.provider.clone();self.publish();Ok(())
    }

    async fn on_acp(&mut self, event: Value) -> Result<()> {
        let Some(turn)=self.turn.as_mut() else {return Ok(())};
        if event["turn"].as_str()!=turn.codex_turn.as_deref() {return Ok(())}
        turn.last_event=Instant::now();
        if let Some(result)=event.get("result") {
            let mut usage=super::acp::usage(result);
            for key in ["context_used","context_window"] { usage[key]=turn.usage[key].clone(); }
            turn.usage=usage;
            let error=match result["stopReason"].as_str() {
                Some("end_turn")=>None,
                Some("cancelled") if turn.interrupted=>None,
                Some(reason)=>Some(format!("OpenCode ACP turn stopped: {reason}")),
                None=>Some("OpenCode ACP prompt returned no stop reason".into()),
            };
            return self.end_turn(error,json!({"acp":true})).await;
        }
        if let Some(error)=event["error"].as_str() { return self.end_turn(Some(error.to_string()),json!({"acp":true})).await; }
        let update=&event["update"];
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" | "agent_thought_chunk" => {
                turn.activity=true;
                let thinking=update["sessionUpdate"]=="agent_thought_chunk";
                let Some(text)=update["content"]["text"].as_str() else {return Ok(())};
                let field=if thinking {"thinking"} else {"text"};
                let id=update["messageId"].as_str().map(str::to_string).unwrap_or_else(|| format!("acp-{}-{field}",turn.id));
                let existing=turn.rows.get(&id).cloned();
                let mut row=existing.as_ref().map(|(_,r)|r.clone()).unwrap_or_else(|| json!({"role":"assistant","text":"","tools":[],"ts":now_iso(),"assistant_id":id}));
                let current=row[field].as_str().unwrap_or("");
                row[field]=json!(convo::clip(&format!("{current}{text}"),if thinking {20000} else {64000}).0);
                let client=self.engine.db.get().await?;
                let seq=if let Some((seq,_))=existing {self.convo.update(&client,seq,row.clone()).await?;seq}
                    else {self.convo.append(&client,row.clone()).await?};
                drop(client);
                if let Some(turn)=self.turn.as_mut() {turn.rows.insert(id.clone(),(seq,row));turn.codex_row=Some(id);}
                self.text_landed();
                self.set_activity(if thinking {"thinking"} else {"writing"},None);
                self.stream(if thinking {"thinking"} else {"delta"},json!({"text":text}));
            },
            "tool_call" | "tool_call_update" => {
                turn.activity=true;
                let Some(id)=update["toolCallId"].as_str() else {return Ok(())};
                if turn.acp_items.len()>=512 && !turn.acp_items.contains_key(id) {return Err(anyhow!("ACP turn tool count exceeds limit"));}
                let item=turn.acp_items.entry(id.into()).or_insert_with(|| json!({}));
                if let Some(fields)=update.as_object() { for (k,v) in fields {item[k]=v.clone();} }
                // Transcript previews must not retain frame-sized inputs for
                // hundreds of tools. This affects display only; approvals saw
                // the original complete payload on the transport task.
                for field in ["rawInput","rawOutput","content"] {
                    if item[field].to_string().len()>64_000 {
                        item[field]=if field=="content" { json!([{"type":"content","content":{"type":"text","text":"[tool output exceeds transcript preview limit]"}}]) }
                            else { json!({"truncated":true,"preview":convo::clip(&item[field].to_string(),4000).0}) };
                    }
                }
                let name=item["name"].as_str().or(item["title"].as_str()).unwrap_or("tool");
                let name=name.strip_prefix("orgtree_").map(|n|format!("mcp__orgtree__{n}")).unwrap_or_else(||name.to_string());
                let status=item["status"].as_str().unwrap_or("in_progress");
                let done=matches!(status,"completed"|"failed");
                let output=item["content"].as_array().map(|a|a.iter().filter_map(|v|v.pointer("/content/text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                let display=json!({"itemId":id,"callId":id,"kind":"toolCall","tool":name,"args":item["rawInput"].to_string(),
                    "visibleOutput":output,"status":if done {status} else {"inProgress"}});
                self.on_muse_item(&display,done).await?;
            },
            "usage_update" => {
                if !turn.usage.is_object() {turn.usage=json!({});}
                turn.usage["context_used"]=update["used"].clone();turn.usage["context_window"]=update["size"].clone();
                // cost.amount=0 for custom providers is not a price receipt.
            },
            "plan" => {
                let plan:Vec<Value>=update["entries"].as_array().into_iter().flatten().map(|e|json!({"step":e["content"],"status":e["status"]})).collect();
                self.on_codex_plan(&json!({"plan":plan})).await?;
            },
            _=>{},
        }
        Ok(())
    }

    async fn ensure_muse(&mut self, ctx: &Ctx) -> Result<()> {
        if !self.engine.settings.provider_enabled(catalog::MUSE) {
            return Err(anyhow!("Muse is turned off in App settings"));
        }
        // The catalog is read by discovery at startup. A turn that arrives
        // before that read has landed waits for it (measured on the real
        // Muse 1.4.6, 2026-10-13: a turn 250 ms ahead of discovery was
        // refused as "not offered" and never retried), and when discovery
        // has no catalog Muse is read once more here.
        let deadline = Instant::now() + Duration::from_secs(60);
        while !self.engine.providers.state.load().probed && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // A registered login (a profile, or an API key) is asked for its own
        // catalog: entitlement is never borrowed from the user's own login.
        let account = ctx.account.as_deref().and_then(|a| self.engine.accounts.view().get(a).cloned()).filter(|a| a.provider == catalog::MUSE);
        let row = match &account {
            Some(a) => crate::providers::muse_model_for(&self.engine, Some(a), ctx.api_key.as_deref(), &ctx.model)
                .await
                .map_err(|e| anyhow!("the Muse account {} could not be read ({e:#}); the mail waits in the mailbox for the next turn", a.id))?
                .ok_or_else(|| anyhow!(
                    "the Muse account {} does not offer {} ({}); move this agent to a Muse tier or account that offers it",
                    a.id, ctx.tier, ctx.model
                ))?,
            None => {
                if self.engine.providers.state.load().muse_probe.as_ref().is_none_or(|d| d.probe.catalog.is_none()) {
                    crate::providers::refresh_muse(&self.engine).await;
                }
                self.engine.providers.muse_model(&ctx.model).ok_or_else(|| {
                    let st = self.engine.providers.state.load();
                    match (st.muse_probe.as_ref().and_then(|d| d.probe.catalog.as_ref()), st.muse_error.as_deref()) {
                        (Some(_), _) => anyhow!(
                            "the signed-in Muse account's catalog does not offer {} ({}); move this agent to a Muse tier it offers",
                            ctx.tier, ctx.model
                        ),
                        (None, Some(e)) => anyhow!("Muse's model catalog could not be read ({e}); the mail waits in the mailbox for the next turn"),
                        (None, None) => anyhow!("Muse's model catalog has not been read yet; the mail waits in the mailbox for the next turn"),
                    }
                })?
            }
        };
        let (effort, mapped) = catalog::muse_effort(&ctx.effort, Some(&row.variants), row.default_effort.as_deref());
        if mapped {
            tracing::info!(agent = %self.name, model = %ctx.model, saved = %ctx.effort, sent = %effort,
                "this Muse model does not list the saved effort; the nearest level it lists is sent");
        }
        let plan = self.plan(ctx);
        let want = self.want_hosted(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => p.is_muse() && self.proc_print.as_ref() == Some(&plan.print) && !self.reconfigured && p.alive() && p.hosted_in() == want,
            None => false,
        };
        if reuse {
            if let Some(Proc::Muse(p)) = self.proc.as_mut() {
                p.effort = Some(effort);
            }
            self.proc_effort = Some(ctx.effort.clone());
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
        let exe = match self.engine.providers.muse_path() {
            Some(p) => p,
            None => tokio::task::spawn_blocking(crate::providers::locate_muse)
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
                .ok_or_else(|| anyhow!("Muse Code is not installed on this machine"))?,
        };
        std::fs::create_dir_all(&ctx.scratch)?;
        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let may_write = on("edit") && pm != "plan";
        let servers = plan.mcp["mcpServers"].as_object().cloned().unwrap_or_default();
        let granted: serde_json::Map<String, Value> = servers.into_iter().filter(|(k, _)| k != "orgtree").collect();
        // read/write grants are further workspace roots; a read-only grant
        // never is (Muse gives every root the same write access)
        let (mut roots, mut read_only) = (Vec::new(), Vec::new());
        for d in ctx.effective["add_dirs"].as_array().cloned().unwrap_or_default() {
            let Some(p) = d["path"].as_str().map(PathBuf::from).filter(|p| p.is_dir()) else { continue };
            if d["mode"] == "ro" || !may_write {
                read_only.push(p);
            } else {
                roots.push(p);
            }
        }
        let resume = ctx.session_id.clone().filter(|_| ctx.session_provider.as_deref() == Some(catalog::MUSE));
        let mut env = vec![("ORGTREE_AGENT".into(), ctx.name.clone()), ("ORGTREE_NODE".into(), ctx.name.clone()),
                           ("ORGTREE_ORG".into(), ctx.org_slug.clone())];
        env.extend(self.engine.credential_bridge.environment(&self.engine, self.id, self.org_id, ctx.generation));
        // a registered login runs in its own roots: a profile's, or a key
        // account's own (Muse reads the key from META_API_KEY there and never
        // sees the user's own sign-in or sessions)
        if let Some(a) = &account {
            env.extend(crate::providers::muse_account_env(&self.engine, a, ctx.api_key.as_deref())?);
        }
        let spec = MuseSpec {
            exe,
            cwd: ctx.scratch.clone(),
            roots,
            read_only,
            model: ctx.model.clone(),
            effort: Some(effort),
            developer_prompt: plan.identity.clone(),
            seat: musert::seat(may_write, pm),
            may_write,
            may_shell: on("bash") && may_write,
            sandbox: musert::os_sandbox(codexrt::session0(), may_write, pm),
            host: want,
            may_web: on("web"),
            may_subagents: on("subagents"),
            servers: granted,
            resume: resume.clone(),
            env,
        };
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        plan.skills.workspace(&ctx.scratch)?;
        let mut proc = MuseProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        proc.metered = account.as_ref().is_some_and(|a| a.is_apikey());
        proc.login_root = account.as_ref().filter(|a| !a.is_apikey()).and_then(|a| a.config_dir.clone());
        let session_id = proc.session_id.clone();
        if resume.is_some() && resume.as_deref() != Some(session_id.as_str()) {
            self.flag_handoff("its previous Muse session could not be resumed").await;
        }
        if resume.as_deref() != Some(session_id.as_str()) {
            let recorded: Result<()> = async {
                let client = self.engine.db.get().await?;
                client
                    .execute("UPDATE ot.agents SET session_id = $2, provider = $3 WHERE id = $1", &[&self.id, &session_id, &ctx.provider])
                    .await?;
                client
                    .execute(
                        "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id) VALUES ($1, $2, $3, $4)",
                        &[&self.id, &ctx.generation, &ctx.provider, &session_id],
                    )
                    .await?;
                Ok(())
            }
            .await;
            if let Err(e) = recorded {
                // ended gracefully, never by dropping it
                proc.close().await;
                return Err(e);
            }
        }
        self.engine.credential_bridge.bind(self.id, proc.pid);
        self.init = json!({ "model": proc.model, "session": proc.session_id, "schema_fingerprint": proc.schema_fingerprint,
                            "identity_by_file": proc.prompt_by_file });
        self.proc = Some(Proc::Muse(proc));
        self.proc_print = Some(plan.print);
        self.proc_notes = Some(plan.notes);
        self.proc_effort = Some(ctx.effort.clone());
        self.provider = ctx.provider.clone();
        self.mcp = McpState { last_turn_count: self.mcp.last_turn_count, ..McpState::default() };
        self.publish();
        Ok(())
    }

    #[nolog] // pure per-delivery helper
    fn mail_input_budget(&self) -> usize {
        match self.proc.as_ref() {
            Some(Proc::Codex(_)) => prompt::CODEX_INPUT_BYTES,
            // Claude stream-json, Agy, Muse and OpenCode ACP (including
            // OpenRouter/local routes): conservative, not token-window claims.
            _ => prompt::OTHER_INPUT_BYTES,
        }
    }

    /// Composition happens outside the claiming transaction. Any failure
    /// returns the entire unsent batch; a successful prefix leaves the tail
    /// pending in its original id order. Never acknowledge a deferred row.
    #[nolog]
    async fn mail_batch(&self, turn_id: i64, mut raw: Vec<Value>, context: &str, handoff: Option<&str>,
        steering: bool) -> Result<(Vec<Value>, prompt::Batch)> {
        let mails: Vec<Mail> = raw.iter().map(mail_of).collect();
        let rels = self.rels_of(&mails).await;
        let budget = self.mail_input_budget();
        let result = prompt::batch(&mails, context, &rels, handoff, budget, steering);
        let take = result.as_ref().map(|b| b.mail.len()).unwrap_or(0);
        let deferred: Vec<i64> = raw[take..].iter().filter_map(|m| m["id"].as_i64()).collect();
        if !deferred.is_empty() {
            let client = self.engine.db.get().await?;
            client.execute("UPDATE ot.mail SET state='pending', turn_id=NULL, extra=CASE WHEN $4 THEN extra || '{\"input_budget_deferred\":true}'::jsonb ELSE extra END WHERE recipient_agent_id=$1 AND turn_id=$2 AND id=ANY($3) AND state='delivering'",
                &[&self.id, &turn_id, &deferred, &result.is_ok()]).await?;
            tracing::info!(agent=self.id, turn=turn_id, selected=take, deferred=deferred.len(), budget_bytes=budget,
                candidate_bytes=result.as_ref().ok().map(|b| b.candidate_bytes), selected_bytes=result.as_ref().ok().map(|b| b.text.len()),
                "mail input budget deferred the remaining ordered batch");
        }
        raw.truncate(take);
        Ok((raw, result?))
    }

    /// Mail that arrived during a Codex or Muse turn goes straight in
    /// (`turn/steer`, naming the exact running turn); if the turn does not
    /// take it, it waits for the next turn.
    async fn steer_codex(&mut self) -> Result<()> {
        let Some((turn_id, Some(codex_turn))) = self.turn.as_ref().map(|t| (t.id, t.codex_turn.clone())) else { return Ok(()) };
        let client = self.engine.db.get().await?;
        let claimed = client
            .query(
                "UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending'
                                ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED)
                  RETURNING id, to_jsonb(ot.mail.*)",
                &[&self.id, &turn_id],
            )
            .await?;
        if claimed.is_empty() {
            return Ok(());
        }
        let mut rows: Vec<(i64, Value)> = claimed.iter().map(|r| (r.get(0), r.get(1))).collect();
        rows.sort_by_key(|(id, _)| *id);
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let (raw, batch) = self.mail_batch(turn_id, raw, "", None, true).await?;
        let ids: Vec<i64> = raw.iter().filter_map(|m| m["id"].as_i64()).collect();
        if let Some(guard)=crate::runtime::watchdogs::events::alert_turn(&self.engine,self.org_id,self.id,&self.name,&raw) {
            if let Some(t)=self.turn.as_mut(){t.alert_turn=Some(guard);}
        }
        let text = batch.text;
        let steered = match &self.proc {
            Some(Proc::Codex(p)) => p.steer(&codex_turn, &text).await,
            Some(Proc::Muse(p)) => p.steer(&codex_turn, &text).await,
            _ => Err(anyhow!("no Codex or Muse process")),
        };
        if let Err(e) = steered {
            tracing::info!(agent = %self.name, error = %format!("{e:#}"), "the turn did not take the mail; it waits for the next turn");
            client
                .execute("UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE id = ANY($1) AND state = 'delivering'", &[&ids])
                .await?;
            return Ok(());
        }
        // A successful steer is positive custody even if the model has not
        // emitted its next output yet. An error must not redeliver this batch.
        if let Some(t) = self.turn.as_mut() { t.activity = true; }
        let row = mail_row(&raw, Some("Delivered into the running turn."));
        let seq = self.convo.append(&client, row.clone()).await?;
        let delivered = crate::domain::mail::acknowledge(&self.engine, &client, self.id, turn_id, &ids).await?;
        crate::runtime::watchdogs::events::mail_delivered(&self.engine,self.org_id,self.id,delivered);
        drop(client);
        let mut committed = row;
        committed["seq"] = json!(seq);
        committed["row_id"] = json!(format!("r{seq}"));
        committed["event_id"] = json!(format!("e{seq}"));
        self.changed(vec![Change::Mailbox(self.id)]);
        self.stream("steered", json!({ "committed_row": committed }));
        Ok(())
    }

    /// Mid-turn mail for a running Antigravity turn: claim it into the turn and
    /// leave it for the steer hook, which hands it to the CLI at the next
    /// invocation boundary. One handoff at a time.
    async fn steer_agy(&mut self) -> Result<()> {
        let Some(turn_id) = self.turn.as_ref().filter(|t| t.agy_steer.is_none()).map(|t| t.id) else { return Ok(()) };
        let Some(dir) = self.agy_steer_dir.clone() else { return Ok(()) };
        let client = self.engine.db.get().await?;
        let claimed = client
            .query(
                "UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending'
                                ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED)
                  RETURNING id, to_jsonb(ot.mail.*)",
                &[&self.id, &turn_id],
            )
            .await?;
        if claimed.is_empty() {
            return Ok(());
        }
        let mut rows: Vec<(i64, Value)> = claimed.iter().map(|r| (r.get(0), r.get(1))).collect();
        rows.sort_by_key(|(id, _)| *id);
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let (raw, batch) = self.mail_batch(turn_id, raw, "", None, true).await?;
        let ids: Vec<i64> = raw.iter().filter_map(|m| m["id"].as_i64()).collect();
        if let Some(guard)=crate::runtime::watchdogs::events::alert_turn(&self.engine,self.org_id,self.id,&self.name,&raw) {
            if let Some(t)=self.turn.as_mut(){t.alert_turn=Some(guard);}
        }
        let id = format!("t{turn_id}-m{}", ids[0]);
        let body = json!({ "id": id, "text": batch.text }).to_string();
        let tmp = dir.join("pending.tmp");
        let written = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&tmp, body.as_bytes()))
            .and_then(|_| std::fs::rename(&tmp, dir.join("pending.json")));
        if let Err(e) = written {
            tracing::info!(agent = %self.name, error = %e, "mid-turn mail could not be handed over; it waits for the next turn");
            client
                .execute("UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE id = ANY($1) AND state = 'delivering'", &[&ids])
                .await?;
            return Ok(());
        }
        drop(client);
        if let Some(t) = self.turn.as_mut() {
            t.agy_steer = Some((id, ids, raw));
        }
        Ok(())
    }

    /// The steer hook emitted this turn's handoff: show the mail on the desk
    /// as delivered into the running turn. True when it committed.
    async fn commit_agy_steer(&mut self) -> Result<bool> {
        let (Some(dir), Some((id, _, _))) = (self.agy_steer_dir.clone(), self.turn.as_ref().and_then(|t| t.agy_steer.clone()))
        else {
            return Ok(false);
        };
        let receipt = dir.join("emitted.json");
        let emitted: Option<Value> = std::fs::read(&receipt).ok().and_then(|b| serde_json::from_slice(&b).ok());
        if emitted.as_ref().and_then(|v| v["id"].as_str()) != Some(id.as_str()) {
            return Ok(false);
        }
        let _ = std::fs::remove_file(&receipt);
        let Some(turn_id) = self.turn.as_ref().map(|t| t.id) else { return Ok(false) };
        let Some((_, ids, raw)) = self.turn.as_mut().and_then(|t| t.agy_steer.take()) else { return Ok(false) };
        if let Some(t) = self.turn.as_mut() { t.activity = true; }
        let client = self.engine.db.get().await?;
        let row = mail_row(&raw, Some("Delivered into the running turn."));
        let seq = self.convo.append(&client, row.clone()).await?;
        let delivered = crate::domain::mail::acknowledge(&self.engine, &client, self.id, turn_id, &ids).await?;
        crate::runtime::watchdogs::events::mail_delivered(&self.engine,self.org_id,self.id,delivered);
        drop(client);
        // New tools belong after this mail. Keep tools/rows intact so a tool
        // already in flight still completes on its original assistant row.
        if let Some(t) = self.turn.as_mut() { t.codex_row = None; }
        let mut committed = row;
        committed["seq"] = json!(seq);
        committed["row_id"] = json!(format!("r{seq}"));
        committed["event_id"] = json!(format!("e{seq}"));
        self.changed(vec![Change::Mailbox(self.id)]);
        self.stream("steered", json!({ "committed_row": committed }));
        Ok(true)
    }

    /// The turn is ending: a handoff the hook emitted is delivered; one it
    /// never took goes back to waiting for the next turn.
    async fn settle_agy_steer(&mut self) -> Result<()> {
        if !self.turn.as_ref().map(|t| t.agy_steer.is_some()).unwrap_or(false) {
            return Ok(());
        }
        if self.commit_agy_steer().await? {
            return Ok(());
        }
        let Some(dir) = self.agy_steer_dir.clone() else { return Ok(()) };
        if std::fs::remove_file(dir.join("pending.json")).is_err() {
            // the hook may be emitting it right now
            tokio::time::sleep(Duration::from_millis(300)).await;
            if self.commit_agy_steer().await? {
                return Ok(());
            }
        }
        if let Some((_, ids, _)) = self.turn.as_ref().and_then(|t| t.agy_steer.as_ref()) {
            let client = self.engine.db.get().await?;
            client
                .execute("UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE id = ANY($1) AND state = 'delivering'", &[ids])
                .await?;
            // Retain custody if the database failed, so end_turn can exclude
            // this unconsumed handoff from its delivered batch.
            if let Some(t) = self.turn.as_mut() { t.agy_steer = None; }
        }
        Ok(())
    }

    /// Hold a fresh process's first prompt until its MCP servers connect or
    /// fail (bounded).
    async fn wait_for_mcp(&mut self, servers: &[String]) {
        let deadline = Instant::now() + MCP_WAIT;
        loop {
            let Some(Proc::Claude(p)) = &self.proc else { return };
            let status = p.mcp_status().await;
            let pending: Vec<String> = status
                .as_ref()
                .and_then(|s| {
                    s.pointer("/response/mcpServers").or_else(|| s.get("mcpServers")).and_then(Value::as_array).cloned()
                })
                .map(|a| {
                    a.iter()
                        .filter(|s| s["status"].as_str() == Some("pending"))
                        .filter_map(|s| s["name"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_else(|| servers.to_vec());
            if pending.is_empty() {
                self.mcp.waiting = false;
                self.mcp.state = Some("ready".into());
                self.mcp.reason = None;
                self.publish();
                return;
            }
            if Instant::now() >= deadline {
                self.mcp.waiting = false;
                self.mcp.state = Some("timeout".into());
                self.mcp.reason = Some(format!("{} did not connect in time", pending.join(", ")));
                self.publish();
                return;
            }
            self.mcp.reason = Some(format!("waiting for {}", pending.join(", ")));
            self.publish();
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    fn park(&mut self) {
        if !self.parked && self.proc.is_some() && self.turn.is_none() {
            self.parked = true;
            self.engine.sched.parked(self.id);
        }
        // warming on (as in 3.x): a parked CLI stays until the idle cap or a
        // stop; off: a CLI started by hand stays 10 minutes
        self.keep_until = if self.engine.settings.keep_warm() { None } else { Some(Instant::now() + KEEP_ALIVE) };
    }

    fn unpark(&mut self) {
        if self.parked {
            self.parked = false;
            self.engine.sched.unparked(self.id);
        }
    }

    async fn close_proc(&mut self) {
        self.engine.credential_bridge.revoke(self.id);
        self.unpark();
        if let Some(mut p) = self.proc.take() {
            p.close().await;
        }
        self.proc_print = None;
        self.proc_notes = None;
        self.bg_reset();
        self.claude_own = false;
        self.orphans("the CLI was closed");
        self.claude_lost("the CLI was closed").await;
        self.muse_lost("the host was closed").await;
    }

    async fn kill_proc(&mut self) {
        self.engine.credential_bridge.revoke(self.id);
        self.unpark();
        if let Some(mut p) = self.proc.take() {
            p.kill().await;
        }
        self.proc_print = None;
        self.proc_notes = None;
        self.bg_reset();
        self.claude_own = false;
        self.orphans("the CLI was stopped");
        self.claude_lost("the CLI was stopped").await;
        self.muse_lost("the host was stopped").await;
    }

    /// The CLI is gone: background tasks it still held died with it. Tell
    /// the agent once (3.x `_bg_orphaned`); the counts drop to zero.
    fn orphans(&mut self, reason: &str) {
        let orphans = self.tasks.orphaned();
        if orphans.is_empty() {
            return;
        }
        let session = self.init["session_id"].as_str().map(str::to_string);
        let (engine, org_id, id, reason) = (self.engine.clone(), self.org_id, self.id, reason.to_string());
        let span = tracing::Span::current();
        tokio::spawn(tracing::Instrument::instrument(async move {
            let rows = tokio::task::spawn_blocking(move || tasks::orphan_rows(session.as_deref(), &orphans))
                .await
                .unwrap_or_default();
            recovery::subagent_died(&engine, org_id, id, rows, &reason).await;
        }, span));
        self.publish();
    }

    /// Waking mail has waited unread while this turn runs: tell each sender
    /// once, passively (3.x steer-late; 10 min since 2026-10-10). Re-arms for younger mail.
    async fn steer_late(&mut self) {
        self.steer_since = None;
        let Some(admitted) = self.turn.as_ref().map(|t| t.admitted_at) else { return };
        let rows = match async {
            let client = self.engine.db.get().await?;
            Ok::<_, anyhow::Error>(client
                .query(
                    "SELECT m.id, m.uid, s.name, m.created_at, extract(epoch FROM now() - m.created_at)::float8
                       FROM ot.mail m JOIN ot.agents s ON s.id = m.sender_agent_id AND s.state = 'live'
                      WHERE m.recipient_agent_id = $1 AND m.state = 'pending' AND NOT m.notice
                        AND m.created_at >= $2
                      ORDER BY m.id LIMIT 50",
                    &[&self.id, &admitted],
                )
                .await?)
        }.await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "unread mail could not be read");
                return;
            }
        };
        let late = recovery::steer_late_after();
        for r in rows {
            let id: i64 = r.get(0);
            let waited: f64 = r.get(4);
            if self.late_told.contains(&id) {
                continue;
            }
            if waited < late.as_secs_f64() {
                // re-arm: the oldest younger mail comes due at its own threshold
                let since = Instant::now().checked_sub(Duration::from_secs_f64(waited.max(0.0))).unwrap_or_else(Instant::now);
                self.steer_since = Some(self.steer_since.map_or(since, |s| s.min(since)));
                continue;
            }
            self.late_told.insert(id);
            let (uid, sender, at): (String, String, DateTime<Utc>) = (r.get(1), r.get(2), r.get(3));
            recovery::delivery_unread(&self.engine, self.org_id, &self.org.slug, &sender, &self.name, &uid,
                                      &crate::util::iso(at), waited).await;
        }
    }

    fn begin_turn(&mut self, mut turn: Turn) {
        self.unpark();
        // the CLI gives this turn the background results it holds
        self.bg_reset();
        self.steer_since = None;
        self.late_told.clear();
        turn.span = crate::trace::request_from(&self.client, crate::trace::current_rq().as_deref());
        self.pending_effort = None;
        self.turn = Some(turn);
        self.keep_until = None;
        self.org.turn_delta(&self.engine, 1);
        crate::runtime::watchdogs::activity(&self.engine, self.id, "turn_started");
    }

    fn take_turn(&mut self) -> Option<Turn> {
        let t = self.turn.take();
        self.stream("tool_writing", json!({}));
        self.pending_effort = None;
        self.steer_since = None;
        self.late_told.clear();
        // Cleanup may fail in the database; a finished turn must never retain a slot.
        self.slot = None;
        if t.is_some() {
            self.org.turn_delta(&self.engine, -1);
        }
        t
    }

    /// Claim waiting mail, make sure the CLI runs, send the opening message.
    async fn start_turn(&mut self) -> Result<bool> {
        // real work comes first (3.x `_cancel_working_cache`)
        self.cancel_keepalive().await;
        let admitted_at = Utc::now();
        let mut ctx = self.load_ctx().await?;
        if ctx.state != "live" || ctx.halted || ctx.frozen || ctx.killswitch {
            return Ok(false);
        }
        // Auth refusal is an admission hold, not a failed inference turn.
        // Check before opening the mail-claim transaction; external sign-in
        // wakes this pending mail through the usage loop.
        if ctx.provider == catalog::GOOGLE {
            let failure = if let Some(e) = crate::providers::agy_auth::blocked(&self.engine) {
                Some(e)
            } else if let Some(exe) = self.engine.providers.agy_path() {
                crate::providers::agy_auth::preflight(&self.engine, &exe).await.err()
            } else { None };
            if let Some(e) = failure {
                self.last_error = Some(e.to_string());
                self.close_proc().await;
                return Ok(false);
            }
        }
        // a lane the org switched off serves no new turn: the agent moves to
        // one it allows (or freezes, saying none is left) before any mail is
        // claimed, and admission is tried again (the account list, user 2026-10-10)
        if let Some(lane) = crate::org_accounts::barred(&self.engine, &ctx.org_slug, &ctx.tier, ctx.account.as_deref()) {
            crate::org_accounts::leave(&self.engine, self.org_id, &ctx.org_slug, self.id, &ctx.tier, ctx.account.as_deref(), &lane).await;
            self.reconfigured = self.proc.is_some();
            self.retry_admission();
            return Ok(false);
        }
        let mut client = self.engine.db.get().await?;
        let tx = client.transaction().await?;
        // Serialize configuration changes with admission, not with CLI work.
        // A switch that won this row lock must be loaded before claiming mail;
        // one that loses sees the committed inflight turn and queues its intent.
        // Account removal uses this same lock and may reset an idle session
        // without changing tier; reload that session before admitting its mail.
        let current = tx.query_one(
            "SELECT tier, account, state, halt IS NOT NULL, frozen IS NOT NULL,
                    pending_switch IS NOT NULL OR pending_account IS NOT NULL, session_id
               FROM ot.agents WHERE id = $1 FOR UPDATE", &[&self.id]).await?;
        if current.get::<_, String>(2) != "live" || current.get::<_, bool>(3) || current.get::<_, bool>(4) {
            tx.rollback().await?;
            return Ok(false);
        }
        if current.get::<_, String>(0) != ctx.tier || current.get::<_, Option<String>>(1) != ctx.account
            || current.get::<_, bool>(5) || current.get::<_, Option<String>>(6) != ctx.session_id {
            let queued = current.get::<_, bool>(5);
            tx.rollback().await?;
            drop(client);
            self.reconfigured = self.proc.is_some();
            // this is the boundary: a queued switch or account applies before
            // any mail is claimed, and admission is tried again on a timer,
            // never at once, so a refusal that persists cannot spin (decision 62)
            if queued {
                if let Err(e) = self.apply_pending_config().await {
                    tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the queued configuration could not be applied; admission retries");
                }
            }
            self.retry_admission();
            return Ok(false);
        }
        // an OpenRouter seat whose harness should change (its key's harness
        // changed, or it moved to a key on another harness) moves across here,
        // at the boundary, never mid-turn: neither CLI resumes the other's
        // session, so it goes on in a fresh one that starts with a summary
        // (a harness not installed here is not crossed to: the launch refuses, saying so)
        if let Some(want) = ctx.harness_want.clone().filter(|w| ctx.harness_stamp.as_deref() != Some(w.as_str()))
            .filter(|w| ctx.harness_stamp.is_none() || crate::harnesses::installed(&self.engine, w)) {
            self.cross_harness(tx, &ctx, &want).await?;
            drop(client);
            self.retry_admission();
            return Ok(false);
        }
        self.admit_refusals = 0;
        let turn_id: i64 = tx
            .query_one(
                "INSERT INTO ot.turns (agent_id, started_at, account, api_key, model) VALUES ($1, now(), $2, $3, $4) RETURNING id",
                &[&self.id, &ctx.account, &ctx.api_key.is_some(), &ctx.model],
            )
            .await?
            .get(0);
        // Claim only the oldest prefix. A waking message behind a long run
        // of notices admits that prefix without being delivered out of order.
        let claimed = tx
            .query(
                "WITH oldest AS (SELECT id FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending'
                                  ORDER BY id LIMIT 64 FOR UPDATE SKIP LOCKED)

                 UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM oldest)
                  RETURNING id, to_jsonb(ot.mail.*)",
                &[&self.id, &turn_id],
            )
            .await?;
        let mut rows: Vec<(i64, Value)> = claimed.iter().map(|r| (r.get(0), r.get(1))).collect();
        rows.sort_by_key(|(id, _)| *id);
        if !rows.iter().any(|(_, m)| !m["notice"].as_bool().unwrap_or(false) || m["extra"]["input_budget_deferred"] == true) {
            // A real wake behind >64 notices admits their prefix, without
            // jumping the waking message ahead of intermediate queued rows.
            let waking: bool = tx.query_one("SELECT EXISTS (SELECT 1 FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending' AND (NOT notice OR extra->>'input_budget_deferred'='true'))", &[&self.id]).await?.get(0);
            if rows.is_empty() || !waking { tx.rollback().await?; return Ok(false); }
        }
        tx.execute(
            "UPDATE ot.agents SET inflight_at = now(), last_error = NULL, row_version = row_version + 1 WHERE id = $1",
            &[&self.id],
        )
        .await?;
        tx.commit().await?;
        drop(client);
        let mut raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let reset_note = match self.cold_reset(&mut ctx).await {
            Ok(note) => note,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the cold-cache reset failed; resuming the session");
                None
            }
        };
        self.session_settle().await;
        if let Err(e) = self.ensure_proc(&ctx).await {
            self.return_mail(turn_id, true).await;
            return Err(e);
        }
        self.session_notes(turn_id, &mut raw).await;
        let handoff = match self.take_handoff(&ctx).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the handoff note could not be built");
                None
            }
        };
        let (context, envelope_record) = self.turn_context(&ctx).await;
        let budget = self.mail_input_budget();
        let composed = async {
            // Only generated org state + usage can be persisted here; not the
            // identity, credentials, attachments or arbitrary handoff history.
            let context = prompt::context_reference(&ctx.scratch, &context, budget / 4)?;
            let handoff = reset_note.or(handoff).map(|h| prompt::handoff_reference(&h, budget / 4));
            self.mail_batch(turn_id, raw, &context, handoff.as_deref(), false).await
        }.await;
        let (raw, batch) = match composed {
            Ok(b) => b,
            Err(e) => { self.return_mail(turn_id, true).await; return Err(e); }
        };
        let alert_turn = crate::runtime::watchdogs::events::alert_turn(&self.engine,self.org_id,self.id,&self.name,&raw);
        let mails = batch.mail;
        let text = batch.text;
        let followup: Vec<String> = mails.iter().filter(|m| self.followup_mail.contains(&m.uid))
            .map(|m| m.uid.clone()).collect();
        let rels = self.rels_of(&mails).await;
        // the lanes whose usage-limit freeze replays the request (3.x freeze_provider_limit)
        let replay = match self.proc.as_ref() {
            Some(Proc::Codex(_)) | Some(Proc::Agy(_)) | Some(Proc::Muse(_)) => freeze::replay_tail(&prompt::replay_text(&mails, &rels)),
            _ => String::new(),
        };
        let mut codex_turn: Option<String> = None;
        let mut refused: Option<String> = None;
        let sent = match self.proc.as_ref() {
            Some(Proc::Claude(p)) => p.send_user(&text, images_for(&mails)),
            Some(Proc::Agy(p)) => p.send_user(&text),
            Some(Proc::Codex(p)) => match p.start_turn(&text, codex_images(&mails)).await {
                Ok(t) => {
                    codex_turn = Some(t);
                    true
                }
                Err(e) => {
                    tracing::warn!(agent = %self.name, length_refusal = prompt::input_length_refusal(&format!("{e:#}")), input_bytes=text.len(), "turn/start failed");
                    refused = Some(format!("{e:#}"));
                    false
                }
            },
            Some(Proc::Acp(p)) => match p.start_turn(&text) {
                Ok(id) => { codex_turn = Some(id); true },
                Err(e) => { refused = Some(e.to_string()); false },
            },
            Some(Proc::Muse(p)) => match p.start_turn(&text, musert::images(&attachment_paths(&mails))).await {
                Ok((t, disposition)) => {
                    if disposition != "started" {
                        // the host was busy with a turn Orgtree did not start: ours waits behind it
                        tracing::info!(agent = %self.name, turn = %t, disposition = %disposition, "the Muse turn was queued");
                    }
                    codex_turn = Some(t);
                    true
                }
                Err(e) => {
                    tracing::warn!(agent = %self.name, length_refusal = prompt::input_length_refusal(&format!("{e:#}")), input_bytes=text.len(), "Muse turn/start failed");
                    refused = Some(format!("{e:#}"));
                    false
                }
            },
            None => false,
        };
        if !sent {
            self.return_mail(turn_id, true).await;
            self.close_proc().await;
            let why = refused.map(|r| {
                if prompt::input_length_refusal(&r) {
                    format!(": Input exceeds maximum length; input {} UTF-8 bytes / {} characters; Orgtree budget {budget} bytes; mail {} items",
                        text.len(), text.chars().count(), mails.len())
                } else { format!(": {r}") }
            }).unwrap_or_default();
            return Err(anyhow!("the {} process did not accept the turn{why}", catalog::provider_label(&ctx.provider)));
        }
        if let Some(r) = envelope_record {
            // D-223: the agent now holds this snapshot; later turns may point at it
            if let Err(e) = crate::runtime::envelope::commit(&self.engine, self.id, &r).await {
                tracing::info!(agent = %self.name, error = %format!("{e:#}"), "envelope record not stored");
            }
        }
        let mut turn = Turn::new(turn_id, false);
        turn.alert_turn = alert_turn;
        turn.input_shape = Some((text.len(), text.chars().count(), budget));
        turn.opening_mail = raw.iter().filter_map(|m| m["id"].as_i64()).collect();
        turn.admitted_at = admitted_at;
        turn.serving_account = self.serving_account_of(&ctx);
        turn.serving_provider = ctx.provider.clone();
        turn.serving_tier = ctx.tier.clone();
        turn.codex_turn = codex_turn;
        turn.acp = self.proc.as_ref().is_some_and(Proc::is_acp);
        turn.usage_base = self.codex_total.clone();
        turn.replay = replay;
        self.begin_turn(turn);
        if !followup.is_empty() {
            tracing::info!(agent = self.id, turn = turn_id, mail_ids = ?followup,
                "started follow-up turn for undelivered mid-turn mail");
            self.followup_mail.retain(|id| !followup.contains(id));
        }
        self.last_error = None;
        self.activity = Some(("thinking".into(), None));
        self.sent_print = self.proc_print.clone();
        if let Err(error) = self.save_next_turn_baseline().await {
            tracing::warn!(agent=self.id, %error, "next-turn launch baseline could not be recorded");
        }
        let client = self.engine.db.get().await?;
        client.execute("UPDATE ot.turns SET sent_at = now() WHERE id = $1", &[&turn_id]).await?;
        let row = mail_row(&raw, None);
        self.convo.append(&client, row).await?;
        drop(client);
        self.publish();
        self.changed(vec![Change::Mailbox(self.id)]);
        self.stream("text", json!({}));
        Ok(true)
    }

    /// The PROVIDER USAGE block for this turn: in full (numbered) when it
    /// changed or the session is new, else one line pointing at the last one.
    fn usage_block(&mut self, ctx: &Ctx) -> String {
        let (text, key) = crate::usage::turn_board(&self.engine, &ctx.provider, ctx.account.as_deref(), &ctx.tier, &ctx.org_slug);
        if let Some((session, last, seq)) = &self.board_sent {
            if *session == ctx.session_id && *last == key {
                return format!("[PROVIDER USAGE #{seq} — unchanged since #{seq} earlier in this conversation; read the numbers there]");
            }
        }
        let seq = self.board_sent.as_ref().map(|(_, _, n)| n + 1).unwrap_or(1);
        self.board_sent = Some((ctx.session_id.clone(), key, seq));
        text.replacen("[PROVIDER USAGE", &format!("[PROVIDER USAGE #{seq}"), 1)
    }

    /// The per-turn envelope before the mail (3.x layout, D-181): the
    /// `[ORG STATE]` block, then the provider-usage board. Fast-changing facts
    /// stay out of the system prompt so the provider's cache survives hires
    /// and status changes. Returns the text and the D-223 record to store once
    /// the turn was sent.
    async fn turn_context(&mut self, ctx: &Ctx) -> (String, Option<Value>) {
        let (mut s, record) = match crate::runtime::envelope::org_state(&self.engine, self.id).await {
            Ok(st) => (st.text, st.record),
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "org state block failed");
                (format!("[Orgtree] {} · you are {}", now_iso(), ctx.name), None)
            }
        };
        let usage = self.usage_block(ctx);
        if !usage.is_empty() {
            s.push_str("\n\n");
            s.push_str(&usage);
        }
        (s, record)
    }

    /// How each sender stands to this agent, for the `[MAIL]` headers.
    async fn rels_of(&self, mails: &[Mail]) -> std::collections::HashMap<String, String> {
        let senders: Vec<String> = mails.iter().map(|m| m.sender.clone()).collect();
        crate::runtime::envelope::relationships(&self.engine, self.id, &senders).await.unwrap_or_default()
    }

    /// Give a failed turn's mail back (`requeue`) or settle it as delivered.
    async fn return_mail(&self, turn_id: i64, requeue: bool) {
        if let Ok(client) = self.engine.db.get().await {
            if requeue {
                let _ = client
                    .execute(
                        "UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE turn_id = $1 AND state = 'delivering'",
                        &[&turn_id],
                    )
                    .await;
                let _ = client.execute("DELETE FROM ot.turns WHERE id = $1 AND sent_at IS NULL", &[&turn_id]).await;
            } else {
                let _ = crate::domain::mail::acknowledge_turn(&self.engine, &client, turn_id).await;
            }
            let _ = client
                .execute("UPDATE ot.agents SET inflight_at = NULL, row_version = row_version + 1 WHERE id = $1", &[&self.id])
                .await;
        }
        self.changed(vec![Change::Mailbox(self.id)]);
    }

    /// Mid-turn mail after a tool call (the PostToolUse hook).
    async fn on_hook(&mut self, _input: &Value) -> Result<Value> {
        let Some(turn_id) = self.turn.as_ref().map(|t| t.id) else { return Ok(json!({})) };
        let client = self.engine.db.get().await?;
        let claimed = client
            .query(
                "UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending'
                                ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED)
                  RETURNING id, to_jsonb(ot.mail.*)",
                &[&self.id, &turn_id],
            )
            .await?;
        if claimed.is_empty() {
            return Ok(json!({}));
        }
        let mut rows: Vec<(i64, Value)> = claimed.iter().map(|r| (r.get(0), r.get(1))).collect();
        rows.sort_by_key(|(id, _)| *id);
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let (raw, batch) = self.mail_batch(turn_id, raw, "", None, true).await?;
        if let Some(guard)=crate::runtime::watchdogs::events::alert_turn(&self.engine,self.org_id,self.id,&self.name,&raw) {
            if let Some(t)=self.turn.as_mut(){t.alert_turn=Some(guard);}
        }
        let text = batch.text;
        if let Some(t) = self.turn.as_mut() { t.activity = true; }
        let row = mail_row(&raw, Some("Delivered after a tool call."));
        let seq = self.convo.append(&client, row.clone()).await?;
        let ids: Vec<i64> = raw.iter().filter_map(|m| m["id"].as_i64()).collect();
        let delivered = crate::domain::mail::acknowledge(&self.engine, &client, self.id, turn_id, &ids).await?;
        crate::runtime::watchdogs::events::mail_delivered(&self.engine,self.org_id,self.id,delivered);
        drop(client);
        let mut committed = row;
        committed["seq"] = json!(seq);
        committed["row_id"] = json!(format!("r{seq}"));
        committed["event_id"] = json!(format!("e{seq}"));
        self.changed(vec![Change::Mailbox(self.id)]);
        self.stream("steered", json!({ "committed_row": committed }));
        Ok(json!({ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": text } }))
    }

    /// Announce what this actor changed (see `changes`).
    fn changed(&self, ch: Vec<Change>) {
        // Mailbox bookkeeping must not re-publish watchdog alert delivery as mail.changed.
        let ch=ch.into_iter().map(|c|match c {Change::Mailbox(id)=>Change::MailboxQuiet(id),other=>other}).collect();
        crate::changes::notify(&self.engine, &self.org, ch);
    }

    #[nolog]
    fn stream(&mut self, kind: &str, extra: Value) {
        // Install completed rows and retire their partials in one renderer
        // update, before the next phase can appear. Durable rows carry only the
        // sanitized committed body; writing previews are bounded and ephemeral.
        let mut frame = json!({ "type": "node_stream", "node": self.name, "kind": kind, "text": "" });
        // One ordinal per partial, shared by token frames and HTTP snapshots.
        // Arrival through either transport must not change the display order.
        if matches!(kind, "delta" | "thinking" | "thinking_start") {
            if let Some(t) = self.turn.as_mut() {
                let slot = if kind == "delta" { &mut t.draft_order } else { &mut t.thinking_order };
                if slot.is_none() {
                    t.partial_serial += 1;
                    *slot = Some(t.partial_serial);
                }
                frame["stream_order"] = json!(*slot);
            }
        }
        if !matches!(kind, "delta" | "thinking") {
            frame["convo_rows"] = json!(self.convo.take_pending());
            frame["tool_writing"] = json!(self.turn.as_ref().map(|t| t.tool_writing.active(t.id)).unwrap_or_default());
            frame["draft_clear"] = json!(self.turn.as_ref().is_none_or(|t| t.draft.is_empty()));
            frame["thinking_clear"] = json!(kind != "thinking_start" && self.turn.as_ref().is_none_or(|t| t.thinking.is_empty()));
        }
        if let (Some(f), Some(e)) = (frame.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                f.insert(k.clone(), v.clone());
            }
        }
        self.org.emit_agent(self.id, frame);
    }

    /// A durable row with text landed: tell watching desks, move the epoch.
    #[nolog]
    fn text_landed(&mut self) {
        self.text_frames += 1;
        self.stream("text", json!({}));
    }

    #[nolog]
    async fn on_claude(&mut self, v: Value) -> Result<()> {
        if let Some(t) = self.turn.as_mut() {
            t.last_event = Instant::now();
        }
        let counts = self.tasks.counts();
        let mut reported = None;
        if let Some(stopped) = self.tasks.observe(&v) {
            reported = Some(stopped.task_id.clone());
            let (engine, org_id, id) = (self.engine.clone(), self.org_id, self.id);
            let span = tracing::Span::current();
            tokio::spawn(tracing::Instrument::instrument(async move {
                recovery::task_stopped(&engine, org_id, id, stopped).await;
            }, span));
        }
        let sub = v.get("parent_tool_use_id").map(|p| !p.is_null()).unwrap_or(false);
        if sub {
            // Only a root call already known to this parent turn can own a
            // transcript. Grandchild calls cannot create another view.
            if let Some(tool) = v["parent_tool_use_id"].as_str() {
                let key = self.turn.as_ref().and_then(|t| t.tools.get(tool).and_then(|mid| t.rows.get(mid)))
                    .map(|(seq, _)| (*seq, tool.to_string()));
                if let Some(transcript) = key.and_then(|key| self.helpers.get_mut(&key)) {
                    transcript.observe(&v);
                    if transcript.dirty && self.helper_due.is_none() {
                        self.helper_due = Some(Instant::now() + Duration::from_millis(250));
                    }
                }
            }
            return Ok(());
        }
        if !sub && v["type"] == "system" {
            match v["subtype"].as_str() {
                Some("task_started") => self.follow_claude_background(&v),
                Some("task_notification") => self.on_claude_late(&v, reported.as_deref()).await,
                _ => {}
            }
        }
        if self.tasks.counts() != counts {
            self.publish();
            // a process kept open for its background tasks closes when they are over
            self.release_held().await;
        }
        match v["type"].as_str() {
            Some("system") => match v["subtype"].as_str() {
                Some("init") => {
                    // a query starts: one the CLI started by itself before it is over
                    self.claude_own = false;
                    self.on_init(&v);
                    if !sub && self.turn.is_none() {
                        // a turn the CLI started by itself, to hand the model a
                        // background task's notification (an idle CLI prints
                        // nothing before its input: measured on 2.1.292). The
                        // interrupt ends it before its model call; the
                        // notification stays in the session for the next turn.
                        if let Some(Proc::Claude(p)) = &self.proc {
                            if !p.interrupt() {
                                tracing::warn!(agent = %self.name, "the CLI could not be reached to cancel a turn it started by itself");
                            }
                        }
                        self.claude_own = true;
                        let session = v["session_id"].as_str().unwrap_or("").to_string();
                        self.own_turn_cancelled("Claude Code CLI", &session).await;
                    }
                }
                Some("status") => match v["status"].as_str() {
                    Some("compacting") => self.compact_start().await?,
                    None if v["compact_result"] == "failed" => self.compact_close("failed", Value::Null).await?,
                    _ => {}
                },
                Some("compact_boundary") => {
                    crate::domain::runtime_notices::compacted(&self.engine,self.org_id,self.id,!self.turn.as_ref().map(|t|t.compact).unwrap_or(false)).await?;
                    let pre = v.pointer("/compact_metadata/pre_tokens").cloned().unwrap_or(Value::Null);
                    self.compact_close("done", pre).await?;
                }
                _ => {}
            },
            Some("rate_limit_event") => {
                self.rate_limit = v.get("rate_limit_info").cloned();
                if let Some(turn) = self.turn.as_mut() {
                    turn.limit_signal |= crate::account_marks::limit_signal(&v["rate_limit_info"]);
                }
            }
            // the lines of a turn the CLI started by itself are no turn's of the agent
            Some("stream_event" | "assistant" | "user") if self.claude_own => {}
            Some("stream_event") if !sub => self.on_stream_event(&v["event"]),
            Some("assistant") if !sub => self.on_assistant(&v).await?,
            Some("user") if !sub => self.on_tool_results(&v).await?,
            Some("result") if self.claude_own => {
                self.claude_own = false;
                tracing::info!(agent = %self.name, subtype = ?v["subtype"], "the turn the CLI started by itself ended");
            }
            Some("result") if self.turn.is_some() => self.on_result(&v).await?,
            Some("result") => {
                tracing::info!(agent = %self.name, subtype = ?v["subtype"], "a result outside any turn; ignored");
            }
            _ => {}
        }
        Ok(())
    }

    /// One app-server notification (Codex's stream).
    #[nolog]
    async fn on_codex(&mut self, v: Value) -> Result<()> {
        if let Some(t) = self.turn.as_mut() {
            t.last_event = Instant::now();
        }
        let method = v["method"].as_str().unwrap_or("").to_string();
        let p = &v["params"];
        match method.as_str() {
            "thread/tokenUsage/updated" => {
                let tu = p["tokenUsage"].clone();
                self.codex_total = Some(tu["total"].clone());
                if let Some(t) = self.turn.as_mut() {
                    t.usage = tu;
                }
            }
            "account/rateLimits/updated" => {
                self.rate_limit = Some(p["rateLimits"].clone());
                if let Some(turn) = self.turn.as_mut() {
                    turn.limit_signal |= crate::account_marks::limit_signal(&p["rateLimits"]);
                }
            },
            "item/agentMessage/delta" => {
                let text = p["delta"].as_str().unwrap_or("");
                if let Some(t) = self.turn.as_mut() {
                    t.activity = true;
                    if t.draft.len() < 64_000 {
                        t.draft.push_str(text);
                    }
                }
                self.stream("delta", json!({ "text": text }));
                self.set_activity("writing", None);
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let text = p["delta"].as_str().unwrap_or("");
                if let Some(t) = self.turn.as_mut() {
                    t.activity = true;
                    if t.thinking.len() < 16_000 {
                        t.thinking.push_str(text);
                    }
                }
                self.stream("thinking", json!({ "text": text }));
            }
            "item/started" if p["item"]["type"] == "contextCompaction" => self.compact_start().await?,
            "item/completed" if p["item"]["type"] == "contextCompaction" => {
                self.compact_settled = self.compact_open.is_some();
                if self.compact_settled {
                    self.compact_close("done", Value::Null).await?;
                }
            }
            "item/started" => self.on_codex_item(&p["item"], false).await?,
            "item/completed" => self.on_codex_item(&p["item"], true).await?,
            "turn/plan/updated" => self.on_codex_plan(p).await?,
            "model/rerouted" => {
                if let Some(t) = self.turn.as_mut() {
                    t.model = p["toModel"].as_str().map(str::to_string);
                }
            }
            "error" => {
                if !p["willRetry"].as_bool().unwrap_or(false) {
                    if let Some(t) = self.turn.as_mut() {
                        t.codex_error = p.pointer("/error/message").and_then(Value::as_str).map(|s| gist(s, 600));
                    }
                }
            }
            "orgtree/denied" => {
                if let Some(t) = self.turn.as_mut() {
                    t.denials.push(p.clone());
                }
            }
            "thread/compacted" => {
                crate::domain::runtime_notices::compacted(&self.engine,self.org_id,self.id,true).await?;
                // the compaction item may already have closed its row
                if !std::mem::take(&mut self.compact_settled) {
                    self.compact_close("done", Value::Null).await?;
                }
            }
            "turn/completed" => {
                let turn = &p["turn"];
                // only this turn's completion ends it
                let ours = self.turn.as_ref().and_then(|t| t.codex_turn.clone()).unwrap_or_default();
                if !ours.is_empty() && turn["id"].as_str().map(|id| id != ours).unwrap_or(false) {
                    return Ok(());
                }
                let interrupted = self.turn.as_ref().map(|t| t.interrupted).unwrap_or(false);
                let error = match turn["status"].as_str().unwrap_or("completed") {
                    "failed" => Some(
                        turn.pointer("/error/message")
                            .and_then(Value::as_str)
                            .map(|s| gist(s, 600))
                            .or_else(|| self.turn.as_ref().and_then(|t| t.codex_error.clone()))
                            .unwrap_or_else(|| "the Codex turn failed".into()),
                    ),
                    "interrupted" if !interrupted => Some("the Codex turn was interrupted".into()),
                    _ => None,
                };
                self.end_turn(error, json!({ "codex": true })).await?;
            }
            _ => {}
        }
        Ok(())
    }

    /// One Muse host notification (its session's stream, MSP v1). Only the
    /// running turn's items and usage count, and the settling of a call Muse
    /// moved to the background in an earlier turn; a turn Orgtree did not
    /// start (a scheduled or automatic one, or the one Muse starts to hand
    /// over a background result) is cancelled, because Orgtree admits turns.
    #[nolog]
    async fn on_muse(&mut self, v: Value) -> Result<()> {
        if let Some(t) = self.turn.as_mut() {
            t.last_event = Instant::now();
        }
        let method = v["method"].as_str().unwrap_or("").to_string();
        let p = &v["params"];
        let ours = self.turn.as_ref().and_then(|t| t.codex_turn.clone());
        let of_ours = |turn: &Value| turn.as_str().is_some_and(|id| Some(id) == ours.as_deref());
        match method.as_str() {
            "turn/started" => {
                if let Some(id) = p["turnId"].as_str().filter(|id| Some(*id) != ours.as_deref()) {
                    // a host holding a background result for an idle agent starts
                    // one again at once after each cancel
                    if let Some(Proc::Muse(m)) = &self.proc {
                        m.cancel_turn(id);
                    }
                    self.own_turn_cancelled("Muse host", id).await;
                }
            }
            "item/started" | "item/updated" | "item/completed" => {
                let item = &p["item"];
                let done = method == "item/completed" || item["status"].as_str().is_some_and(|s| s != "inProgress");
                // a compaction may run outside any turn (`/compact`)
                if item["kind"] == "compaction" && item["status"] == "inProgress" {
                    self.compact_start().await?;
                } else if item["kind"] == "compaction" {
                    self.on_muse_compaction(item).await?;
                } else if of_ours(&item["turnId"]) {
                    self.on_muse_item(item, done).await?;
                } else if done && item["itemId"].as_str().is_some_and(|i| self.muse_bg.contains_key(i)) {
                    self.on_muse_late(item).await?;
                }
            }
            "item/delta" => {
                let id = p["itemId"].as_str().unwrap_or("");
                let kind = self.turn.as_ref().and_then(|t| t.muse_items.get(id).cloned()).unwrap_or_default();
                let text = p["delta"].as_str().unwrap_or("");
                let field = p["field"].as_str().unwrap_or("text");
                match (kind.as_str(), field) {
                    ("agentMessage", "text") => {
                        if let Some(t) = self.turn.as_mut() {
                            t.activity = true;
                            if t.draft.len() < 64_000 {
                                t.draft.push_str(text);
                            }
                        }
                        self.stream("delta", json!({ "text": text }));
                        self.set_activity("writing", None);
                    }
                    ("reasoning", f) if f == "text" || f.starts_with("summary.") => {
                        if let Some(t) = self.turn.as_mut() {
                            t.activity = true;
                            if t.thinking.len() < 16_000 {
                                t.thinking.push_str(text);
                            }
                        }
                        self.stream("thinking", json!({ "text": text }));
                    }
                    _ => {}
                }
            }
            "session/tokenUsage" if of_ours(&p["turnId"]) => {
                // one model completion of this turn: summed per turn. Muse's
                // `inputTokens` holds the cached part (measured on 1.4.6);
                // `promptTokens` is the counted-once prompt, the occupancy
                let u = &p["usage"];
                let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
                if let Some(t) = self.turn.as_mut() {
                    let prompt = p["promptTokens"].as_i64().unwrap_or_else(|| n(u, "inputTokens"));
                    let cached = u.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or_else(|| n(u, "cachedTokens")).min(prompt);
                    let acc = &mut t.usage;
                    if !acc.is_object() {
                        *acc = json!({ "input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "last_prompt": 0, "requests": 0 });
                    }
                    acc["input"] = json!(n(acc, "input") + (prompt - cached).max(0));
                    acc["cache_read"] = json!(n(acc, "cache_read") + cached);
                    acc["cache_write"] = json!(n(acc, "cache_write") + n(u, "cacheWriteTokens"));
                    acc["output"] = json!(n(acc, "output") + n(u, "outputTokens"));
                    acc["last_prompt"] = json!(prompt);
                    acc["requests"] = json!(n(acc, "requests") + 1);
                    if let Some(m) = p["modelId"].as_str() {
                        t.model = Some(m.to_string());
                    }
                }
            }
            "session/contextUsage" => {
                if let Some(t) = self.turn.as_mut().filter(|t| t.usage.is_object()) {
                    t.usage["context_used"] = p["usedTokens"].clone();
                    t.usage["context_window"] = p["windowTokens"].clone();
                }
            }
            "usage/changed" => {
                // the login the host runs on (an API key has no usage windows)
                let (model, root) = match &self.proc {
                    Some(Proc::Muse(m)) if !m.metered => (m.model.clone(), m.login_root.clone()),
                    _ => return Ok(()),
                };
                if crate::usage::muse_observed(&self.engine, root.as_deref(), p, Some(&model)).await && root.is_none() {
                    crate::usage::muse_publish(&self.engine);
                }
            }
            "session/todoListChanged" => {
                let plan: Vec<Value> = p["items"].as_array().cloned().unwrap_or_default().iter().map(|i| {
                    json!({ "step": i["text"], "status": i["status"] })
                }).collect();
                // a list a tool call wrote (`sourceTool`: write_todos) goes onto
                // that call's chip; any other onto the plan chip Codex's plan
                // updates draw
                let source = p["sourceTool"].as_str().unwrap_or("");
                if source.is_empty() || !self.muse_todos_on_call(source, &plan).await? {
                    self.on_codex_plan(&json!({ "plan": plan })).await?;
                }
            }
            "session/modelChanged" => {
                let pinned = match &self.proc {
                    Some(Proc::Muse(m)) => m.model.clone(),
                    _ => String::new(),
                };
                if let Some(m) = p["modelId"].as_str().filter(|m| !pinned.is_empty() && *m != pinned) {
                    // the seat's model is asserted, not assumed: a session that moved
                    // off it is not used again
                    tracing::warn!(agent = %self.name, model = m, pinned = %pinned, "the Muse session changed model; its host is replaced");
                    self.reconfigured = true;
                }
            }
            "session/modelRouteUnserved" => {
                tracing::warn!(agent = %self.name, model = ?p["modelId"], "Muse can no longer serve this session's model");
                self.last_error = Some(format!("Muse can no longer serve {}", p["modelId"].as_str().unwrap_or("this model")));
                self.reconfigured = true;
            }
            "turn/retryScheduled" if of_ours(&p["turnId"]) => {
                tracing::info!(agent = %self.name, attempt = ?p["attempt"], max = ?p["maxAttempts"], delay_ms = ?p["retryDelayMs"],
                    kind = ?p["errorKind"], reason = ?p["reason"], "Muse retries a model request");
            }
            "turn/foregroundCompleted" if of_ours(&p["turnId"]) => {
                // reminder agents are switched off for Orgtree hosts; one holding
                // the turn open anyway is recorded, not waited on silently
                tracing::warn!(agent = %self.name, blocking = ?p["blockingAgents"], "background reminder checks hold the Muse turn open");
            }
            "orgtree/denied" => {
                if let Some(t) = self.turn.as_mut() {
                    t.denials.push(p.clone());
                }
            }
            "turn/completed" if of_ours(&p["turnId"]) => {
                let interrupted = self.turn.as_ref().map(|t| t.interrupted).unwrap_or(false);
                let e = &p["error"];
                if let Some(t) = self.turn.as_mut() {
                    if e.is_object() {
                        t.muse_error = Some((e["kind"].as_str().unwrap_or("").to_string(), e["retryable"].as_bool().unwrap_or(false)));
                        t.muse_quota = e.pointer("/quota/resetsAtMs").and_then(Value::as_i64).and_then(DateTime::from_timestamp_millis);
                    }
                    // the turn's own aggregate, when the host reports one
                    if let Some(u) = p.get("usage").filter(|u| u.is_object()) {
                        let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
                        let cached = u.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or_else(|| n("cachedTokens")).min(n("inputTokens"));
                        let last = t.usage["last_prompt"].clone();
                        let mut agg = json!({ "input": (n("inputTokens") - cached).max(0), "cache_read": cached,
                                              "cache_write": n("cacheWriteTokens"), "output": n("outputTokens"), "last_prompt": last });
                        for k in ["context_used", "context_window", "children"] {
                            if !t.usage[k].is_null() {
                                agg[k] = t.usage[k].clone();
                            }
                        }
                        t.usage = agg;
                    }
                }
                let error = match p["terminal"].as_str().unwrap_or("completed") {
                    "completed" => None,
                    "cancelled" if interrupted => None,
                    "cancelled" => Some("the Muse turn was cancelled".to_string()),
                    "failed" => Some(
                        e["message"].as_str().or(p["reason"].as_str()).map(|s| gist(s, 600))
                            .unwrap_or_else(|| "the Muse turn failed".into()),
                    ),
                    other => Some(format!("the Muse turn ended {other}")),
                };
                self.end_turn(error, json!({ "muse": true, "duration_ms": p["durationMs"] })).await?;
            }
            _ => {}
        }
        Ok(())
    }

    /// A Muse item of the running turn started, changed or settled: text
    /// rows, thoughts, tool chips, and the child runs a session starts (a
    /// subagent the scope does not allow is stopped at once; a reminder
    /// child is recorded, its usage kept apart from the turn's).
    async fn on_muse_item(&mut self, item: &Value, done: bool) -> Result<()> {
        if self.turn.is_none() {
            return Ok(());
        }
        let kind = item["kind"].as_str().unwrap_or("").to_string();
        let id = item["itemId"].as_str().unwrap_or("").to_string();
        // a settled tool call Orgtree stopped: the silence limit it passed
        let mut stopped_after: Option<u64> = None;
        if let Some(t) = self.turn.as_mut() {
            t.activity = true;
            if done {
                t.muse_items.remove(&id);
            } else {
                t.muse_items.insert(id.clone(), kind.clone());
            }
            if kind == "toolCall" {
                stopped_after = muse_track_tool(&mut t.muse_tools, &id, item, done).and_then(|c| c.stop_asked).map(|(_, limit)| limit);
            }
        }
        if let Some(limit) = stopped_after {
            tracing::info!(agent = %self.name, item = %id, tool = ?item["tool"], status = ?item["status"], limit_s = limit,
                "a Muse tool call Orgtree stopped at the silence limit has settled");
        }
        match kind.as_str() {
            "userMessage" | "hookRun" | "sideChat" | "compaction" => {}
            "agentMessage" => {
                if !done {
                    if let Some(t) = self.turn.as_mut() {
                        t.draft.clear();
                        t.draft_order = None;
                    }
                    self.set_activity("writing", None);
                    return Ok(());
                }
                let text = item["text"].as_str().unwrap_or("").to_string();
                if text.trim().is_empty() {
                    return Ok(());
                }
                let row = json!({ "role": "assistant", "text": text, "tools": [], "ts": now_iso(), "assistant_id": id });
                let client = self.engine.db.get().await?;
                let seq = self.convo.append(&client, row.clone()).await?;
                drop(client);
                if let Some(t) = self.turn.as_mut() {
                    t.rows.insert(id.clone(), (seq, row));
                    t.codex_row = Some(id);
                    t.draft.clear();
                    t.draft_order = None;
                }
                self.text_landed();
            }
            "reasoning" => {
                if !done {
                    if let Some(t) = self.turn.as_mut() {
                        t.thinking.clear();
                        t.thinking_order = None;
                    }
                    self.stream("thinking_start", json!({}));
                    self.set_activity("thinking", None);
                    return Ok(());
                }
                let parts: Vec<String> = item["summary"].as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .filter(|v: &Vec<String>| !v.is_empty())
                    .or_else(|| item["text"].as_str().map(|s| vec![s.to_string()]))
                    .unwrap_or_default();
                let body = parts.join("\n");
                if body.trim().is_empty() {
                    return Ok(());
                }
                let row = json!({ "role": "assistant", "text": "", "thinking": convo::clip(&body, 20_000).0, "tools": [],
                                  "ts": now_iso(), "assistant_id": id });
                let client = self.engine.db.get().await?;
                let seq = self.convo.append(&client, row.clone()).await?;
                drop(client);
                if let Some(t) = self.turn.as_mut() {
                    t.rows.insert(id.clone(), (seq, row));
                    t.codex_row = Some(id);
                    t.thinking.clear();
                    t.thinking_order = None;
                }
                self.stream("thought", json!({}));
            }
            _ => {
                if kind == "subagent" && !done {
                    let allowed = self.load_ctx().await.map(|c| c.effective["tools"].get("subagents").and_then(Value::as_bool).unwrap_or(true)).unwrap_or(false);
                    if !allowed {
                        if let (Some(Proc::Muse(m)), Some(sub)) = (&self.proc, item["subagentId"].as_str()) {
                            tracing::warn!(agent = %self.name, subagent = sub, "stopping a Muse subagent this agent's scope does not allow");
                            m.stop_subagent(sub, "this agent's scope does not allow subagents");
                        }
                    }
                }
                if kind == "reminderChild" || kind == "workflow" {
                    tracing::warn!(agent = %self.name, kind = %kind, status = ?item["status"], "Muse started a child run Orgtree switched off");
                }
                let (name, input) = muse_tool(item);
                let client = self.engine.db.get().await?;
                let known = self.turn.as_ref().map(|t| t.tools.contains_key(&id)).unwrap_or(false);
                if !known {
                    crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                    let Some(key) = self.codex_row(&client, &id).await? else { return Ok(()) };
                    let update = {
                        let Some(t) = self.turn.as_mut() else { return Ok(()) };
                        let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                        let chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input), "input": input,
                                           "started_at": now_iso(), "refs": convo::tool_refs(&name, &input, None) });
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(chip);
                        }
                        t.tools.insert(id.clone(), key.clone());
                        (*seq, row.clone())
                    };
                    self.convo.update(&client, update.0, update.1).await?;
                    if !done {
                        drop(client);
                        self.follow_muse_background(&id, &name, &input);
                        self.set_activity("tool", Some(name));
                        self.stream("tool", json!({ "id": id }));
                        return Ok(());
                    }
                }
                if !done {
                    self.update_active_input(&client, &id, &name, &input).await?;
                    self.follow_muse_background(&id, &name, &input);
                    return Ok(());
                }
                if let Some(bg) = self.muse_bg.remove(&id) {
                    // it finished inside its own turn, which Muse gives the result
                    // to, unless the turn's last model step had begun (`bg_result`)
                    tracing::info!(agent = %self.name, item = %id, tool = %name, status = ?item["status"],
                        "a Muse call moved to the background settled within its turn");
                    self.bg_in_turn.push(muse_finished_note(&bg, item));
                    self.publish();
                }
                let (text, failed) = muse_result(item);
                let update = {
                    let Some(t) = self.turn.as_mut() else { return Ok(()) };
                    if let Some(u) = item.get("usage").filter(|u| u.is_object()) {
                        // a child's own usage: kept beside the turn's, never in it
                        let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
                        if !t.usage.is_object() {
                            t.usage = json!({});
                        }
                        let c = &mut t.usage["children"];
                        if !c.is_object() {
                            *c = json!({ "input": 0, "output": 0, "runs": 0 });
                        }
                        c["input"] = json!(c["input"].as_i64().unwrap_or(0) + n("inputTokens"));
                        c["output"] = json!(c["output"].as_i64().unwrap_or(0) + n("outputTokens"));
                        c["runs"] = json!(c["runs"].as_i64().unwrap_or(0) + 1);
                    }
                    let Some(key) = t.tools.get(&id).cloned() else { return Ok(()) };
                    let card = t.cards.remove(item["callId"].as_str().unwrap_or(&id)).or_else(|| t.cards.remove(&id));
                    let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                    if let Some(chips) = row["tools"].as_array_mut() {
                        for chip in chips.iter_mut().filter(|c| c["id"].as_str() == Some(id.as_str())) {
                            muse_settle_chip(chip, item, &input, &text, failed);
                            if let Some(limit) = stopped_after {
                                chip["error"] = json!(format!("stopped by Orgtree: no output for {} (the silence limit)", span_text(limit)));
                            }
                            convo::retain_failed_shell_output(chip, &text, failed, item["truncated"] == true);
                            if let Some(extra) = card.as_ref().and_then(|c| c.as_object()) {
                                if let Some(c) = chip.as_object_mut() {
                                    for (k, val) in extra {
                                        c.insert(k.clone(), val.clone());
                                    }
                                }
                            }
                        }
                    }
                    (*seq, row.clone())
                };
                self.convo.update(&client, update.0, update.1).await?;
                drop(client);
                self.set_activity("thinking", None);
                self.stream("tool", json!({}));
            }
        }
        Ok(())
    }

    /// A Muse compaction settled: the transcript and the agent's record say so.
    async fn on_muse_compaction(&mut self, item: &Value) -> Result<()> {
        let outcome = item["outcome"].as_str().unwrap_or("");
        if outcome != "compacted" {
            tracing::info!(agent = %self.name, outcome, reason = ?item["reason"], "Muse compaction did not compact");
            return self.compact_close("failed", Value::Null).await;
        }
        crate::domain::runtime_notices::compacted(&self.engine, self.org_id, self.id, true).await?;
        self.compact_close("done", Value::Null).await
    }

    /// The harness reported a compaction start: the desk gets one live row,
    /// timed from this receipt (the harness reports no earlier time).
    async fn compact_start(&mut self) -> Result<()> {
        if self.compact_open.is_some() {
            return Ok(());
        }
        self.compact_settled = false;
        let mut row = json!({ "role": "system", "text": "Compacting context", "ts": now_iso(), "kind": "compact",
                              "compact_state": "running", "compact_started_at": now_iso() });
        let client = self.engine.db.get().await?;
        let seq = self.convo.append(&client, row.clone()).await?;
        drop(client);
        row["seq"] = json!(seq);
        self.compact_open = Some((seq, row));
        self.text_landed();
        Ok(())
    }

    /// The compaction ended (`done`, `failed`) or was cut off (`interrupted`):
    /// the open row becomes the finished record. With no reported start there
    /// is no row to close, so a finished one is added without a duration.
    async fn compact_close(&mut self, state: &str, pre_tokens: Value) -> Result<()> {
        let text = match state {
            "done" => "Context compacted",
            "failed" => "Context compaction failed",
            _ => "Context compaction interrupted",
        };
        let Some((seq, mut row)) = self.compact_open.take() else {
            if state != "done" {
                return Ok(());
            }
            let mut row = json!({ "role": "system", "text": text, "ts": now_iso(), "kind": "compact" });
            if !pre_tokens.is_null() {
                row["pre_tokens"] = pre_tokens;
            }
            let client = self.engine.db.get().await?;
            self.convo.append(&client, row).await?;
            drop(client);
            self.text_landed();
            return Ok(());
        };
        row["text"] = json!(text);
        row["compact_state"] = json!(state);
        // a cut-off compaction has no reported end, so none is written
        if state != "interrupted" {
            row["compact_ended_at"] = json!(now_iso());
        }
        if !pre_tokens.is_null() {
            row["pre_tokens"] = pre_tokens;
        }
        let client = self.engine.db.get().await?;
        self.convo.update(&client, seq, row).await?;
        drop(client);
        self.text_landed();
        Ok(())
    }

    /// A tool call of the running turn that Muse has moved to the background
    /// (it does that by itself to a shell command still running after about
    /// 10 s) is followed from now on beyond its turn: where its chip is, until
    /// its item settles or its host ends.
    #[nolog] // every unsettled tool item event
    fn follow_muse_background(&mut self, id: &str, name: &str, input: &Value) {
        if self.muse_bg.contains_key(id) {
            return;
        }
        let Some(t) = self.turn.as_ref() else { return };
        if !t.muse_tools.get(id).is_some_and(|c| c.background) {
            return;
        }
        let Some(seq) = t.tools.get(id).and_then(|key| t.rows.get(key)).map(|(seq, _)| *seq) else { return };
        tracing::info!(agent = %self.name, item = id, tool = name, "Muse moved a tool call to the background; it is followed past its turn");
        self.muse_bg.insert(id.to_string(), MuseBg { seq, name: name.to_string(), arg: convo::tool_arg(name, input) });
        self.publish();
    }

    /// A call Muse moved to the background settled after its turn ended.
    /// Muse gives the result to the session itself, once (measured on 1.4.6):
    /// into a turn running now, else into the next turn Orgtree admits (or
    /// into the history just before it, when one of the turns Muse starts
    /// to deliver it, each cancelled here, takes it first). Its chip gets
    /// the result in the row it was drawn in, and an idle agent is woken
    /// through its mailbox (`bg_result`), so admission decides when it runs.
    /// The message names the command and how it ended, never the output (no
    /// second copy).
    async fn on_muse_late(&mut self, item: &Value) -> Result<()> {
        let id = item["itemId"].as_str().unwrap_or("").to_string();
        let Some(bg) = self.muse_bg.remove(&id) else { return Ok(()) };
        let (text, failed) = muse_result(item);
        let (_, input) = muse_tool(item);
        let reason = item["failureReason"].as_str().filter(|r| !r.is_empty()).map(str::to_string);
        tracing::info!(agent = %self.name, item = %id, tool = %bg.name, status = ?item["status"], idle = self.idle_for_wake(),
            "a Muse call moved to the background settled after its turn");
        if let Err(e) = self
            .amend_chip(bg.seq, &id, |chip| {
                muse_settle_chip(chip, item, &input, &text, failed);
                if let (true, Some(r)) = (failed, &reason) {
                    chip["error"] = json!(gist(r, 500));
                }
                convo::retain_failed_shell_output(chip, &text, failed, item["truncated"] == true);
            })
            .await
        {
            tracing::warn!(agent = %self.name, item = %id, error = %format!("{e:#}"), "the late result could not be written to its chip");
        }
        self.bg_result(muse_finished_note(&bg, item), false).await;
        self.publish();
        Ok(())
    }

    /// A background result reached the CLI (a Muse item settling, Claude
    /// Code's task notification) and the CLI gives it to the model itself,
    /// once. A turn running now takes it, unless that turn's last model step
    /// had begun: then the CLI starts a turn of its own right after it ends
    /// (`own_turn_cancelled`), and only then is the agent woken for it. With
    /// no turn running the CLI keeps it for the next turn on this process,
    /// which is kept open for it (`bg_unread`), and an idle agent is woken
    /// through its mailbox with `note`, so admission decides when that turn
    /// runs. A turn already waiting for admission or a slot needs no note.
    /// `defer` (Claude Code): the note waits for the turn the CLI starts by
    /// itself 40-110 ms later to be cancelled; Muse's own turns carry ids, so
    /// its note goes at once.
    async fn bg_result(&mut self, note: String, defer: bool) {
        if self.turn.is_some() {
            self.bg_in_turn.push(note);
            return;
        }
        self.bg_unread = true;
        if !self.idle_for_wake() {
            return;
        }
        if defer {
            self.bg_wake.push(note);
            if self.bg_wake_due.is_none() {
                self.bg_wake_due = Some(Instant::now() + BG_GRACE);
            }
        } else {
            self.wake_for(&note).await;
        }
    }

    /// Send the wake notes held back for a turn the CLI starts by itself:
    /// it was cancelled, or none came in time. Only an agent still idle gets
    /// them; a turn on its way takes the results from the CLI anyway.
    async fn send_held_wakes(&mut self) {
        self.bg_wake_due = None;
        let notes = std::mem::take(&mut self.bg_wake);
        if notes.is_empty() || !self.idle_for_wake() {
            return;
        }
        for note in &notes {
            self.wake_for(note).await;
        }
    }

    /// The agent waits for nothing: no turn runs, none waits for admission or
    /// holds a slot, and the seat is not stopping.
    #[nolog]
    fn idle_for_wake(&self) -> bool {
        !self.stopping && self.turn.is_none() && self.waiting_since.is_none() && self.slot.is_none()
    }

    /// Wake the agent through its mailbox with a system message about its
    /// background work (admission decides when its turn runs).
    async fn wake_for(&self, note: &str) {
        if let Err(e) = crate::domain::mail::system_wake(&self.engine, self.org_id, self.id, note).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "could not wake the agent about its background work");
        }
    }

    /// The CLI or Muse host started a turn of its own, to hand the model a
    /// background result (Claude Code's task notification, Muse's inbox);
    /// the caller has cancelled it, as Orgtree admits turns. The result stays
    /// in the session for the next turn (measured: Claude Code 2.1.292 keeps
    /// the interrupted turn's notification, Muse 1.4.6 its inbox or the
    /// cancelled turn's history). Warned about at most once a minute, with
    /// the count. Results that settled during the turn that just ended were
    /// evidently not taken by it: the agent is woken for them now when idle,
    /// and the process is kept for the turn that takes them.
    async fn own_turn_cancelled(&mut self, harness: &str, turn: &str) {
        let (n, last) = &mut self.own_cancels;
        *n += 1;
        if last.is_none_or(|at| at.elapsed() >= OWN_TURN_WARN_EVERY) {
            tracing::warn!(agent = %self.name, turn, cancelled = *n,
                "cancelling turns the {harness} started by itself (Orgtree admits turns); count since the last such line");
            *n = 0;
            *last = Some(Instant::now());
        }
        if self.turn.is_some() {
            return;
        }
        self.send_held_wakes().await;
        if self.bg_in_turn.is_empty() || self.bg_grace.is_none_or(|g| Instant::now() > g) {
            return;
        }
        let notes = std::mem::take(&mut self.bg_in_turn);
        self.bg_grace = None;
        self.bg_unread = true;
        let idle = self.idle_for_wake();
        tracing::info!(agent = %self.name, results = notes.len(), idle,
            "background results that settled during the last turn were not taken by it");
        if idle {
            for note in &notes {
                self.wake_for(note).await;
            }
        }
    }

    /// Background work keeps the process open instead of closing it (user
    /// 2026-10-14, gap 11): with warming off at its turn's end, and when
    /// warming is switched off or the idle cap asks it to close. It is not
    /// parked, so the idle cap neither counts nor evicts it, and it closes
    /// once the work is over (`release_held`).
    fn hold(&mut self) {
        self.unpark();
        self.keep_until = None;
        if !self.held {
            self.held = true;
            tracing::info!(agent = %self.name, running = self.bg_running(), unread = self.bg_unread, settled_in_turn = self.bg_in_turn.len(),
                "the process stays open for its background work");
        }
        self.publish();
    }

    /// A process kept open for its background work closes once that work is
    /// over, as it would have at its turn's end: nothing runs in the
    /// background, the CLI owes no turn a result, and no result that settled
    /// during the last turn is still unaccounted for.
    async fn release_held(&mut self) {
        if !self.held || self.turn.is_some() || self.bg_pending() {
            return;
        }
        tracing::info!(agent = %self.name, "its background work is over; the process kept open for it closes");
        self.close_proc().await;
        self.update_forecast().await;
        self.publish();
    }

    /// Background tasks and commands running now: Claude Code's (its live set)
    /// and the calls Muse moved to the background.
    #[nolog]
    fn bg_running(&self) -> usize {
        self.tasks.counts().1 + self.muse_bg.len()
    }

    /// Background work the process still holds: something running, a result
    /// the CLI owes the next turn, or results that settled during the last
    /// turn while it is not yet clear that turn took them.
    #[nolog]
    fn bg_pending(&self) -> bool {
        self.bg_running() > 0 || self.bg_unread || !self.bg_in_turn.is_empty()
    }

    /// Nothing is held for background work or owed by the CLI any more: the
    /// process is gone, or a turn starts on it (the CLI gives that turn what
    /// it holds). Commands still running stay followed.
    #[nolog]
    fn bg_reset(&mut self) {
        self.held = false;
        self.bg_unread = false;
        self.bg_wake.clear();
        self.bg_wake_due = None;
        self.bg_in_turn.clear();
        self.bg_grace = None;
    }

    /// Change one tool chip of a transcript row and save the row: the running
    /// turn's own copy when the row is that turn's, else the stored row (an
    /// earlier turn's). Open desks get the row at once.
    async fn amend_chip(&mut self, seq: i64, id: &str, change: impl FnOnce(&mut Value)) -> Result<()> {
        let client = self.engine.db.get().await?;
        let held = self.turn.as_ref().and_then(|t| t.rows.values().find(|(s, _)| *s == seq)).map(|(_, row)| row.clone());
        let mut row = match &held {
            Some(row) => row.clone(),
            None => match client.query_opt("SELECT body FROM ot.convo WHERE agent_id = $1 AND seq = $2", &[&self.id, &seq]).await? {
                Some(r) => r.get(0),
                None => return Ok(()),
            },
        };
        let Some(chip) = row["tools"].as_array_mut().and_then(|chips| chips.iter_mut().find(|c| c["id"].as_str() == Some(id))) else {
            return Ok(());
        };
        change(chip);
        if held.is_some() {
            if let Some((_, r)) = self.turn.as_mut().and_then(|t| t.rows.values_mut().find(|(s, _)| *s == seq)) {
                *r = row.clone();
            }
        }
        self.convo.update(&client, seq, row).await?;
        drop(client);
        self.stream("tool", json!({}));
        Ok(())
    }

    /// The Muse host ended while calls it had moved to the background still
    /// ran. They ended with it: Muse ends a host's commands with the host,
    /// and a resumed session says nothing of them (measured on 1.4.6), so
    /// each chip says so and the agent is told once, with a waking message,
    /// unless the seat itself is going away (retired or deleted).
    async fn muse_lost(&mut self, reason: &str) {
        if self.muse_bg.is_empty() {
            return;
        }
        let mut lost: Vec<(String, MuseBg)> = self.muse_bg.drain().collect();
        lost.sort_by(|a, b| a.1.seq.cmp(&b.1.seq).then_with(|| a.0.cmp(&b.0)));
        tracing::warn!(agent = %self.name, calls = lost.len(), reason, "Muse calls moved to the background ended with their host");
        let why = format!("ended with its Muse host ({reason}) before it finished");
        for (id, bg) in &lost {
            let why = why.clone();
            if let Err(e) = self
                .amend_chip(bg.seq, id, move |chip| {
                    chip["error"] = json!(why);
                    chip["ended_at"] = json!(now_iso());
                })
                .await
            {
                tracing::warn!(agent = %self.name, item = %id, error = %format!("{e:#}"), "the lost background call's chip could not be written");
            }
        }
        // a seat stopping while the engine runs on is being retired or deleted
        if !self.stopping || self.engine.is_stopping() {
            let note = muse_lost_note(&lost, reason);
            if let Err(e) = crate::domain::mail::system_wake(&self.engine, self.org_id, self.id, &note).await {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "could not tell the agent its background commands ended with the host");
            }
        }
        self.publish();
    }

    /// Claude Code started a task (`task_started`): when it runs in the
    /// background and its call's chip is in the running turn, it is followed
    /// from now on, past its turn, until the CLI reports its end or ends.
    /// Foreground calls get a task id too (measured on 2.1.292) and are not.
    #[nolog] // every task start
    fn follow_claude_background(&mut self, v: &Value) {
        let (task, tool) = (v["task_id"].as_str().unwrap_or(""), v["tool_use_id"].as_str().unwrap_or(""));
        if task.is_empty() || tool.is_empty() || self.claude_bg.contains_key(task) {
            return;
        }
        let background = v["is_backgrounded"] == true || v["is_background"] == true
            || self.tasks.is_background(task) || self.tasks.asked_background(tool);
        if !background {
            return;
        }
        let Some(t) = self.turn.as_ref() else { return };
        let Some((seq, row)) = t.tools.get(tool).and_then(|mid| t.rows.get(mid)) else { return };
        let Some(chip) = row["tools"].as_array().and_then(|c| c.iter().find(|c| c["id"].as_str() == Some(tool))) else { return };
        let bg = ClaudeBg {
            seq: *seq,
            tool: tool.to_string(),
            name: chip["name"].as_str().unwrap_or("tool").to_string(),
            arg: chip["arg"].as_str().unwrap_or("").to_string(),
            shell: v["task_type"].as_str() == Some("local_bash"),
        };
        tracing::info!(agent = %self.name, task, tool = %bg.name, "a Claude Code task runs in the background; it is followed past its turn");
        self.claude_bg.insert(task.to_string(), bg);
    }

    /// A background task of the CLI ended (`task_notification`; measured on
    /// 2.1.292: `status` completed, failed, stopped or killed, a `summary`
    /// with the exit code, the `.output` file). The CLI hands the model only
    /// that notification, never the output, once: into a turn running now,
    /// else into a turn it starts by itself (cancelled here; the notification
    /// stays in the session for the next turn). A followed task's chip gets
    /// what the command printed, read from that file, or else the summary;
    /// the agent is woken for it as for Muse (`bg_result`), unless the
    /// stopped-task card (`reported`) already woke it.
    async fn on_claude_late(&mut self, v: &Value, reported: Option<&str>) {
        let task = v["task_id"].as_str().unwrap_or("").to_string();
        let status = v["status"].as_str().unwrap_or("").to_string();
        if task.is_empty() || status.is_empty() || status == "running" || !self.tasks.is_background(&task) {
            return;
        }
        let bg = self.claude_bg.remove(&task);
        let summary = v["summary"].as_str().unwrap_or("").to_string();
        tracing::info!(agent = %self.name, task = %task, status = %status, followed = bg.is_some(), in_turn = self.turn.is_some(),
            "a Claude Code background task ended");
        if let Some(bg) = &bg {
            let file = v["output_file"].as_str().unwrap_or("").to_string();
            let output = if bg.shell && !file.is_empty() {
                let id = task.clone();
                tokio::task::spawn_blocking(move || tasks::command_output(&file, &id)).await.ok().flatten()
            } else {
                None
            };
            let (text, more) = output.unwrap_or_else(|| (summary.clone(), false));
            let (st, sum) = (status.clone(), summary.clone());
            if let Err(e) = self.amend_chip(bg.seq, &bg.tool, move |chip| claude_settle_chip(chip, &text, more, &st, &sum)).await {
                tracing::warn!(agent = %self.name, task = %task, error = %format!("{e:#}"), "the background task's result could not be written to its chip");
            }
        }
        if reported != Some(task.as_str()) {
            self.bg_result(claude_finished_note(bg.as_ref(), v), true).await;
        }
        self.publish();
    }

    /// The CLI ended while background tasks whose chips are followed still
    /// ran: each chip says so. The agent's message about them is the orphan
    /// card (P33, `orphans`).
    async fn claude_lost(&mut self, reason: &str) {
        if self.claude_bg.is_empty() {
            return;
        }
        let mut lost: Vec<(String, ClaudeBg)> = self.claude_bg.drain().collect();
        lost.sort_by(|a, b| a.1.seq.cmp(&b.1.seq).then_with(|| a.0.cmp(&b.0)));
        tracing::warn!(agent = %self.name, tasks = lost.len(), reason, "Claude Code background tasks ended with their CLI");
        let why = format!("ended with its CLI ({reason}) before it finished");
        for (task, bg) in &lost {
            let why = why.clone();
            if let Err(e) = self
                .amend_chip(bg.seq, &bg.tool, move |chip| {
                    chip["error"] = json!(why);
                    chip["ended_at"] = json!(now_iso());
                })
                .await
            {
                tracing::warn!(agent = %self.name, task = %task, error = %format!("{e:#}"), "the lost background task's chip could not be written");
            }
        }
        self.publish();
    }

    /// One Antigravity stream-json event.
    #[nolog]
    async fn on_agy(&mut self, v: Value) -> Result<()> {
        if v.pointer("/result/error").and_then(Value::as_str) == Some("Antigravity sign-in required; background authentication stopped") {
            self.kill_proc().await;
        }
        if let Some(t) = self.turn.as_mut() {
            t.last_event = Instant::now();
        }
        // a handoff the steer hook emitted is delivered; more mail may wait
        if self.turn.as_ref().map(|t| t.agy_steer.is_some()).unwrap_or(false) && self.commit_agy_steer().await? {
            self.steer_agy().await?;
        }
        match v["event"].as_str() {
            Some("init") => {
                let cid = v["conversation_id"].as_str().unwrap_or("").to_string();
                let served = v.pointer("/init/model").and_then(Value::as_str).unwrap_or("").to_string();
                self.init = json!({ "model": served, "cwd": v.pointer("/init/cwd"),
                                    "tools": v.pointer("/init/tools").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0) });
                let pinned = match &self.proc {
                    Some(Proc::Agy(p)) => p.model.clone(),
                    _ => String::new(),
                };
                if !served.is_empty() && !pinned.is_empty() && served != pinned {
                    // the model pin is asserted, not assumed
                    self.kill_proc().await;
                    self.end_turn(Some(format!("model pin refused: the session is serving {served}, not {pinned}")), json!({ "agy": true }))
                        .await?;
                    return Ok(());
                }
                if !cid.is_empty() {
                    let client = self.engine.db.get().await?;
                    let generation: i32 = client.query_one("SELECT generation FROM ot.agents WHERE id = $1", &[&self.id]).await?.get(0);
                    let changed = client
                        .execute(
                            "UPDATE ot.agents SET session_id = $2, provider = $3 WHERE id = $1 AND session_id IS DISTINCT FROM $2",
                            &[&self.id, &cid, &catalog::GOOGLE],
                        )
                        .await?;
                    if changed > 0 {
                        client
                            .execute(
                                "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id) VALUES ($1, $2, $3, $4)",
                                &[&self.id, &generation, &catalog::GOOGLE, &cid],
                            )
                            .await?;
                    }
                }
                self.publish();
            }
            Some("step_update") => self.on_agy_step(&v["step_update"]).await?,
            Some("result") => {
                let r = &v["result"];
                let interrupted = self.turn.as_ref().map(|t| t.interrupted).unwrap_or(false);
                let error = match r["status"].as_str().unwrap_or("SUCCESS") {
                    "SUCCESS" => None,
                    "CANCELED" | "CANCELLED" if interrupted => None,
                    other => Some(
                        r["error"]
                            .as_str()
                            .map(|e| gist(e, 600))
                            .or_else(|| r.pointer("/error/message").and_then(Value::as_str).map(|e| gist(e, 600)))
                            .unwrap_or_else(|| format!("the Antigravity turn ended {}", other.to_lowercase())),
                    ),
                };
                // a response that arrived only in the result still becomes a row
                let text = r["response"].as_str().unwrap_or("").to_string();
                let wrote = self.turn.as_ref().map(|t| t.rows.keys().any(|k| k.starts_with("agy-resp-"))).unwrap_or(true);
                if !wrote && !text.trim().is_empty() {
                    let row = json!({ "role": "assistant", "text": text, "tools": [], "ts": now_iso(), "assistant_id": "agy-result" });
                    let client = self.engine.db.get().await?;
                    self.convo.append(&client, row).await?;
                    drop(client);
                    self.text_landed();
                }
                self.end_turn(error, json!({ "agy": true })).await?;
            }
            _ => {}
        }
        Ok(())
    }

    /// An Antigravity step: response text, a tool call, or the user's input echoed.
    async fn on_agy_step(&mut self, step: &Value) -> Result<()> {
        if self.turn.is_none() {
            return Ok(());
        }
        let kind = step["step_type"].as_str().unwrap_or("");
        let state = step["state"].as_str().unwrap_or("");
        let idx = step["step_index"].as_i64().unwrap_or(-1);
        if let Some(t) = self.turn.as_mut() {
            t.activity = true;
        }
        match kind {
            "agent_response" => {
                if let Some(d) = step["text_delta"].as_str().filter(|d| !d.is_empty()) {
                    if let Some(t) = self.turn.as_mut() {
                        if t.draft.len() < 64_000 {
                            t.draft.push_str(d);
                        }
                        t.agy_text.entry(idx).or_default().push_str(d);
                    }
                    self.stream("delta", json!({ "text": d }));
                    self.set_activity("writing", None);
                }
                if state != "DONE" {
                    return Ok(());
                }
                let u = &step["usage"];
                let n = |k: &str| u[k].as_i64().unwrap_or(0);
                let (inp, cached, out) = (n("input_tokens"), n("cache_read_tokens"), n("output_tokens") + n("thinking_tokens"));
                let model = match &self.proc {
                    Some(Proc::Agy(p)) => p.model.clone(),
                    _ => String::new(),
                };
                let text = {
                    let Some(t) = self.turn.as_mut() else { return Ok(()) };
                    let acc = &mut t.usage;
                    if !acc.is_object() {
                        *acc = json!({ "input": 0, "cached": 0, "output": 0, "cost": 0.0, "last_prompt": 0 });
                    }
                    if u.is_object() {
                        acc["input"] = json!(acc["input"].as_i64().unwrap_or(0) + inp);
                        acc["cached"] = json!(acc["cached"].as_i64().unwrap_or(0) + cached);
                        acc["output"] = json!(acc["output"].as_i64().unwrap_or(0) + out);
                        if !catalog::antigravity_claude(&t.serving_tier) {
                            acc["cost"] = json!(acc["cost"].as_f64().unwrap_or(0.0) + agyrt::request_cost(&model, inp, cached, out));
                        }
                        acc["last_prompt"] = json!(inp + cached);
                    }
                    t.draft.clear();
                    t.draft_order = None;
                    t.agy_text.remove(&idx).unwrap_or_default()
                };
                if text.trim().is_empty() {
                    return Ok(());
                }
                let key = format!("agy-resp-{idx}");
                let row = json!({ "role": "assistant", "text": text, "tools": [], "ts": now_iso(), "assistant_id": key });
                let client = self.engine.db.get().await?;
                let seq = self.convo.append(&client, row.clone()).await?;
                drop(client);
                if let Some(t) = self.turn.as_mut() {
                    t.rows.insert(key.clone(), (seq, row));
                    t.codex_row = Some(key);
                }
                self.text_landed();
            }
            "tool" => {
                let id = format!("agy-step-{idx}");
                let name = step["tool_name"].as_str().unwrap_or("tool").to_string();
                let info = &step["tool_info"];
                let client = self.engine.db.get().await?;
                let known = self.turn.as_ref().map(|t| t.tools.contains_key(&id)).unwrap_or(false);
                if !known {
                    crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                    let Some(key) = self.codex_row(&client, &id).await? else { return Ok(()) };
                    let update = {
                        let Some(t) = self.turn.as_mut() else { return Ok(()) };
                        let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                        let input = info.get("parameters").cloned().unwrap_or_else(|| json!({}));
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input), "input": input, "started_at": now_iso(), "refs": convo::tool_refs(&name, &input, None) }));
                        }
                        t.tools.insert(id.clone(), key.clone());
                        (*seq, row.clone())
                    };
                    self.convo.update(&client, update.0, update.1).await?;
                    self.set_activity("tool", Some(name.clone()));
                    self.stream("tool", json!({ "id": id }));
                }
                if known && state != "DONE" && state != "ERROR" {
                    self.update_active_input(&client, &id, &name, &info["parameters"]).await?;
                }
                if state == "DONE" || state == "ERROR" {
                    let err = info.pointer("/error/message").and_then(Value::as_str).map(str::to_string);
                    let result = ["result", "output", "response"]
                        .iter()
                        .find_map(|k| info.get(*k).filter(|v| !v.is_null()))
                        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                        .or_else(|| err.clone())
                        .unwrap_or_else(|| state.to_lowercase());
                    let update = {
                        let Some(t) = self.turn.as_mut() else { return Ok(()) };
                        if let Some(e) = &err {
                            if e.starts_with(agyrt::HOOK_DENIED) {
                                t.denials.push(json!({ "tool": name, "arg": convo::tool_arg(&name, &info["parameters"]) }));
                            }
                        }
                        let Some(key) = t.tools.get(&id).cloned() else { return Ok(()) };
                        let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                        let (clipped, truncated) = convo::clip(&result, 4000);
                        if let Some(chips) = row["tools"].as_array_mut() {
                            for chip in chips.iter_mut().filter(|c| c["id"].as_str() == Some(id.as_str())) {
                                if let Some(input) = info.get("parameters") {
                                    chip["input"] = input.clone();
                                }
                                chip["result"] = json!(clipped);
                                chip["result_lines"] = json!(result.lines().count());
                                chip["ended_at"] = json!(now_iso());
                                let refs = convo::tool_refs(chip["name"].as_str().unwrap_or(""), &chip["input"], Some(&result));
                                chip["refs"] = refs;
                                if truncated {
                                    chip["truncated"] = json!(true);
                                }
                                if state == "ERROR" {
                                    chip["error"] = json!(gist(&result, 500));
                                }
                                convo::retain_failed_shell_output(chip, &result, state == "ERROR", false);
                            }
                        }
                        (*seq, row.clone())
                    };
                    self.convo.update(&client, update.0, update.1).await?;
                    self.set_activity("thinking", None);
                    self.stream("tool", json!({}));
                }
                drop(client);
            }
            _ => {}
        }
        Ok(())
    }

    /// The row Codex tool chips attach to (a fresh one when there is none).
    #[nolog]
    async fn update_active_input(&mut self, client: &tokio_postgres::Client, id: &str, name: &str, input: &Value) -> Result<()> {
        if input.is_null() || input.as_object().is_some_and(|o| o.is_empty()) { return Ok(()); }
        let update = {
            let Some(t) = self.turn.as_mut() else { return Ok(()) };
            let Some(key) = t.tools.get(id) else { return Ok(()) };
            let Some((seq, row)) = t.rows.get_mut(key) else { return Ok(()) };
            let Some(chip) = row["tools"].as_array_mut().and_then(|a| a.iter_mut().find(|c| c["id"] == id)) else { return Ok(()) };
            // a call shown as the checklist chip keeps that name (`muse_todo_chip`)
            let checklist = chip["native_tool"] == name;
            if chip["input"] == *input && (chip["name"] == name || checklist) { return Ok(()); }
            if !checklist {
                chip["name"] = json!(name);
                chip["arg"] = json!(convo::tool_arg(name, input));
            }
            chip["input"] = input.clone();
            chip["refs"] = convo::tool_refs(name, input, None);
            (*seq, row.clone())
        };
        self.convo.update(client, update.0, update.1).await?;
        self.stream("tool", json!({ "id": id }));
        Ok(())
    }

    async fn codex_row(&mut self, client: &tokio_postgres::Client, key_hint: &str) -> Result<Option<String>> {
        let existing = self.turn.as_ref().and_then(|t| t.codex_row.clone()).filter(|k| {
            // A following tool must not be inserted above an earlier reply by
            // Msg's thought/tool/text layout. Start its own transcript row.
            self.turn.as_ref().and_then(|t| t.rows.get(k))
                .is_some_and(|(_, row)| row["text"].as_str().unwrap_or("").is_empty())
        });
        if existing.is_some() {
            return Ok(existing);
        }
        if self.turn.is_none() {
            return Ok(None);
        }
        let key = format!("row-{key_hint}");
        let row = json!({ "role": "assistant", "text": "", "tools": [], "ts": now_iso(), "assistant_id": key });
        let seq = self.convo.append(client, row.clone()).await?;
        if let Some(t) = self.turn.as_mut() {
            t.rows.insert(key.clone(), (seq, row));
            t.codex_row = Some(key.clone());
        }
        Ok(Some(key))
    }

    /// A Codex item started or completed: text rows, thoughts and tool chips.
    async fn on_codex_item(&mut self, item: &Value, completed: bool) -> Result<()> {
        if self.turn.is_none() {
            return Ok(());
        }
        let typ = item["type"].as_str().unwrap_or("");
        let id = item["id"].as_str().unwrap_or("").to_string();
        if let Some(t) = self.turn.as_mut() {
            t.activity = true;
        }
        if let Err(e) = self.hint_codex_runner(item, completed).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "Codex runner diagnostic could not be persisted");
        }
        match typ {
            "userMessage" | "hookPrompt" | "contextCompaction" | "enteredReviewMode" | "exitedReviewMode" | "functionCallOutput" => {}
            "agentMessage" | "plan" => {
                if !completed {
                    if let Some(t) = self.turn.as_mut() {
                        t.draft.clear();
                        t.draft_order = None;
                    }
                    self.set_activity("writing", None);
                    return Ok(());
                }
                let text = item["text"].as_str().unwrap_or("").to_string();
                if text.trim().is_empty() {
                    return Ok(());
                }
                let row = json!({ "role": "assistant", "text": text, "tools": [], "ts": now_iso(), "assistant_id": id });
                let client = self.engine.db.get().await?;
                let seq = self.convo.append(&client, row.clone()).await?;
                drop(client);
                if let Some(t) = self.turn.as_mut() {
                    t.rows.insert(id.clone(), (seq, row));
                    t.codex_row = Some(id);
                    t.draft.clear();
                    t.draft_order = None;
                }
                self.text_landed();
            }
            "reasoning" => {
                if !completed {
                    if let Some(t) = self.turn.as_mut() {
                        t.thinking.clear();
                        t.thinking_order = None;
                    }
                    self.stream("thinking_start", json!({}));
                    self.set_activity("thinking", None);
                    return Ok(());
                }
                let parts: Vec<String> = item["summary"]
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .or_else(|| item["content"].as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let body = parts.join("\n");
                if body.trim().is_empty() {
                    return Ok(());
                }
                let row = json!({ "role": "assistant", "text": "", "thinking": convo::clip(&body, 20_000).0, "tools": [],
                                  "ts": now_iso(), "assistant_id": id });
                let client = self.engine.db.get().await?;
                let seq = self.convo.append(&client, row.clone()).await?;
                drop(client);
                if let Some(t) = self.turn.as_mut() {
                    t.rows.insert(id.clone(), (seq, row));
                    t.codex_row = Some(id);
                    t.thinking.clear();
                    t.thinking_order = None;
                }
                self.stream("thought", json!({}));
            }
            _ => {
                let Some((name, input)) = codex_tool(item) else { return Ok(()) };
                // Dynamic and MCP events already contain the full arguments.
                // Only normalized built-ins need the native call as a fallback.
                let input_source = if matches!(item["type"].as_str(), Some("dynamicToolCall" | "mcpToolCall")) {
                    None
                } else {
                    self.proc.as_ref().and_then(|p| match p {
                        Proc::Codex(p) => Some(p.input_source(&id)),
                        _ => None,
                    })
                };
                let client = self.engine.db.get().await?;
                if !completed {
                    crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                    let Some(key) = self.codex_row(&client, &id).await? else { return Ok(()) };
                    let update = {
                        let Some(t) = self.turn.as_mut() else { return Ok(()) };
                        let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                        let chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input),
                            "input": input, "input_source": input_source, "started_at": now_iso(),
                            "refs": convo::tool_refs(&name, &input, None) });
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(chip);
                        }
                        t.tools.insert(id.clone(), key.clone());
                        (*seq, row.clone())
                    };
                    self.convo.update(&client, update.0, update.1).await?;
                    drop(client);
                    self.set_activity("tool", Some(name));
                    self.stream("tool", json!({ "id": id }));
                    return Ok(());
                }
                let (text, failed) = codex_result(item);
                let update = {
                    let Some(t) = self.turn.as_mut() else { return Ok(()) };
                    let Some(key) = t.tools.get(&id).cloned() else { return Ok(()) };
                    let card = t.cards.remove(&id);
                    let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                    let (clipped, truncated) = convo::clip(&text, 4000);
                    if let Some(chips) = row["tools"].as_array_mut() {
                        for chip in chips.iter_mut().filter(|c| c["id"].as_str() == Some(id.as_str())) {
                            chip["input"] = input.clone();
                            chip["input_source"] = json!(input_source);
                            chip["result"] = json!(clipped);
                            chip["result_lines"] = json!(text.lines().count());
                            chip["ended_at"] = json!(now_iso());
                                let refs = convo::tool_refs(chip["name"].as_str().unwrap_or(""), &chip["input"], Some(&text));
                                chip["refs"] = refs;
                            if truncated {
                                chip["truncated"] = json!(true);
                            }
                            if failed {
                                chip["error"] = json!(gist(&text, 500));
                            }
                            convo::retain_failed_shell_output(chip, &text, failed, false);
                            if let Some(extra) = card.as_ref().and_then(|c| c.as_object()) {
                                if let Some(c) = chip.as_object_mut() {
                                    for (k, val) in extra {
                                        c.insert(k.clone(), val.clone());
                                    }
                                }
                            }
                        }
                    }
                    (*seq, row.clone())
                };
                self.convo.update(&client, update.0, update.1).await?;
                drop(client);
                self.set_activity("thinking", None);
                self.stream("tool", json!({}));
            }
        }
        Ok(())
    }

    /// A failed shell startup gets one diagnostic; commands are never replayed.
    async fn hint_codex_runner(&mut self, item: &Value, completed: bool) -> Result<()> {
        if !codexrt::runner_startup_failed(item, completed) {
            return Ok(());
        }
        let Some(t) = self.turn.as_mut().filter(|t| !t.codex_runner_hint) else { return Ok(()) };
        // Latch before any await, including failures: no duplicate/repeated steer.
        t.codex_runner_hint = true;
        let (turn_id, codex_turn) = (t.id, t.codex_turn.clone());

        let (can_retry, authority_known) = match self.load_ctx().await {
            Ok(ctx) => {
                let tools = &ctx.effective["tools"];
                let permission_mode = ctx.effective["permission_mode"].as_str().unwrap_or("");
                let allowed = ctx.state == "live" && !ctx.halted && !ctx.frozen && !ctx.killswitch
                    && tools["bash"].as_bool() == Some(true) && tools["edit"].as_bool() == Some(true)
                    && matches!(permission_mode, "default" | "acceptEdits" | "bypassPermissions");
                (allowed, true)
            }
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "Codex runner retry authority could not be read; no retry suggested");
                (false, false)
            }
        };
        let text = codexrt::runner_startup_hint(can_retry, authority_known);
        let mut row = json!({ "role": "system", "kind": "codex_runner_hint", "text": text,
                              "ts": now_iso(), "turn_id": turn_id, "failed_item_id": item["id"],
                              "retry_allowed": can_retry, "steer_status": "pending" });
        let client = self.engine.db.get().await?;
        let seq = self.convo.append(&client, row.clone()).await?;
        drop(client);
        row["seq"] = json!(seq);
        row["row_id"] = json!(format!("r{seq}"));
        row["event_id"] = json!(format!("e{seq}"));
        self.stream("steered", json!({ "committed_row": row }));

        // No database connection or transaction crosses the provider request.
        let delivered = match (&self.proc, codex_turn.as_deref()) {
            (Some(Proc::Codex(p)), Some(turn)) => p.steer(turn, text).await,
            _ => Err(anyhow!("no running Codex turn")),
        };
        match delivered {
            Ok(()) => row["steer_status"] = json!("delivered"),
            Err(e) => {
                // A timeout can mean an accepted but unacknowledged steer; never retry it.
                row["steer_status"] = json!("unconfirmed");
                row["steer_error"] = json!(gist(&format!("{e:#}"), 500));
                tracing::info!(agent = %self.name, error = %format!("{e:#}"), "Codex runner hint delivery unconfirmed; diagnostic retained, no replay");
            }
        }
        let client = self.engine.db.get().await?;
        self.convo.update(&client, seq, row.clone()).await?;
        drop(client);
        self.stream("steered", json!({ "committed_row": row }));
        Ok(())
    }

    /// Codex's checklist (`turn/plan/updated`) as the desk's progress list.
    async fn on_codex_plan(&mut self, p: &Value) -> Result<()> {
        let Some(steps) = p["plan"].as_array() else { return Ok(()) };
        let todos = plan_todos(steps);
        let chip_id = format!("plan-{}", self.turn.as_ref().and_then(|t| t.codex_turn.clone()).unwrap_or_default());
        let client = self.engine.db.get().await?;
        let key = match self.turn.as_ref().and_then(|t| t.tools.get(&chip_id).cloned()) {
            Some(k) => k,
            None => match self.codex_row(&client, &chip_id).await? {
                Some(k) => k,
                None => return Ok(()),
            },
        };
        let update = {
            let Some(t) = self.turn.as_mut() else { return Ok(()) };
            let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
            let tools = row["tools"].as_array_mut();
            if let Some(tools) = tools {
                match tools.iter_mut().find(|c| c["id"].as_str() == Some(chip_id.as_str())) {
                    Some(c) => c["todos"] = json!(todos),
                    None => tools.push(json!({ "id": chip_id, "name": "TodoWrite", "arg": "todos", "todos": todos })),
                }
            }
            t.tools.insert(chip_id.clone(), key.clone());
            (*seq, row.clone())
        };
        self.convo.update(&client, update.0, update.1).await?;
        drop(client);
        self.stream("tool", json!({ "id": chip_id }));
        Ok(())
    }

    /// A todo list one of the running turn's calls wrote (Muse's
    /// `write_todos`, which `session/todoListChanged` names as `sourceTool`)
    /// goes onto that call's own chip, the newest of that tool, rather than
    /// onto a second chip beside it (measured 2026-10-14: the call's
    /// item/started, then the list, then its item/completed; two chips for one
    /// call before). False when the turn has no call of that tool.
    async fn muse_todos_on_call(&mut self, tool: &str, plan: &[Value]) -> Result<bool> {
        let todos = plan_todos(plan);
        let update = {
            let Some(t) = self.turn.as_mut() else { return Ok(false) };
            let Some((key, id)) = newest_call(&t.rows, &t.tools, tool) else { return Ok(false) };
            let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(false) };
            let Some(chip) = row["tools"].as_array_mut().and_then(|a| a.iter_mut().find(|c| c["id"] == id.as_str())) else { return Ok(false) };
            muse_todo_chip(chip, tool, &todos);
            (*seq, row.clone(), id)
        };
        let client = self.engine.db.get().await?;
        self.convo.update(&client, update.0, update.1).await?;
        drop(client);
        self.stream("tool", json!({ "id": update.2 }));
        Ok(true)
    }

    fn on_init(&mut self, v: &Value) {
        self.init = json!({
            "model": v["model"], "permissionMode": v["permissionMode"], "cwd": v["cwd"],
            "tools": v["tools"].as_array().map(|a| a.len()).unwrap_or(0),
            "mcp_servers": v["mcp_servers"],
        });
        self.mcp.count = v["tools"]
            .as_array()
            .map(|a| a.iter().filter(|t| t.as_str().map(|s| s.starts_with("mcp__")).unwrap_or(false)).count() as i64);
        let with_status = |want: &str| -> Vec<String> {
            v["mcp_servers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|s| s["status"].as_str() == Some(want))
                        .filter_map(|s| s["name"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        let pending = with_status("pending");
        let failed = with_status("failed");
        self.mcp.waiting = !pending.is_empty();
        self.mcp.state = Some(if !pending.is_empty() {
            "connecting".into()
        } else if !failed.is_empty() {
            "degraded".into()
        } else {
            "ready".into()
        });
        self.mcp.reason = if !pending.is_empty() {
            Some(format!("waiting for {}", pending.join(", ")))
        } else if !failed.is_empty() {
            Some(format!("{} failed to connect", failed.join(", ")))
        } else {
            None
        };
        self.publish();
    }

    #[nolog]
    fn on_stream_event(&mut self, ev: &Value) {
        match ev["type"].as_str() {
            Some("content_block_start") => {
                let block = &ev["content_block"];
                match block["type"].as_str() {
                    Some("thinking") | Some("redacted_thinking") => {
                        if let Some(t) = self.turn.as_mut() {
                            t.thinking.clear();
                            t.thinking_order = None;
                        }
                        self.stream("thinking_start", json!({}));
                        self.set_activity("thinking", None);
                    }
                    Some("tool_use") | Some("server_tool_use") => {
                        let name = block["name"].as_str().unwrap_or("tool").to_string();
                        if let (Some(t), Some(index), Some(id)) = (self.turn.as_mut(), ev["index"].as_u64(), block["id"].as_str()) {
                            t.partial_serial += 1;
                            t.tool_writing.start(index, id, &name, t.partial_serial);
                            t.tool_writing.seed(index, &block["input"]);
                        }
                        // a message tool call: watch its arguments for `metadata`
                        // (typing in Hubchat, `net::typing`)
                        self.typing_probe = matches!(name.as_str(), "mcp__orgtree__orgtree_message" | "mcp__orgtree__orgtree_send_notice")
                            .then(|| TypingProbe {
                                index: ev["index"].as_i64().unwrap_or(-1),
                                call: block["id"].as_str().unwrap_or("").to_string(),
                                buf: String::new(),
                                done: false,
                                started: false,
                            })
                            .filter(|p| !p.call.is_empty());
                        self.stream("tool_writing", json!({}));
                        self.set_activity("tool_writing", Some(name));
                    }
                    Some("text") => {
                        if let Some(t) = self.turn.as_mut() {
                            t.draft.clear();
                            t.draft_order = None;
                        }
                        self.set_activity("writing", None);
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let (Some(t), Some(index)) = (self.turn.as_mut(), ev["index"].as_u64()) {
                    t.tool_writing.stop(index);
                }
                self.stream("tool_writing", json!({}));
                // a watched message call's block ended: the call is written,
                // so its typing heartbeats stop (or never start)
                let index = ev["index"].as_i64().unwrap_or(-1);
                if self.typing_probe.as_ref().is_some_and(|p| p.index == index) {
                    if let Some(p) = self.typing_probe.take().filter(|p| p.started) {
                        crate::net::typing::stop(&self.engine, &p.call);
                    }
                }
            }
            Some("content_block_delta") => {
                let d = &ev["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let text = d["text"].as_str().unwrap_or("");
                        if let Some(t) = self.turn.as_mut() {
                            if t.draft.len() < 64_000 {
                                t.draft.push_str(text);
                            }
                        }
                        self.stream("delta", json!({ "text": text }));
                    }
                    Some("thinking_delta") => {
                        let text = d["thinking"].as_str().unwrap_or("");
                        if let Some(t) = self.turn.as_mut() {
                            if t.thinking.len() < 16_000 {
                                t.thinking.push_str(text);
                            }
                        }
                        self.stream("thinking", json!({ "text": text }));
                    }
                    Some("input_json_delta") => {
                        let changed = if let (Some(t), Some(index)) = (self.turn.as_mut(), ev["index"].as_u64()) {
                            t.tool_writing.delta(index, d["partial_json"].as_str().unwrap_or(""))
                        } else { false };
                        if changed { self.stream("tool_writing", json!({})); }
                        // a watched message call: its `metadata`, once whole as
                        // the first argument, starts typing; anything else
                        // first (or too much) ends the watch, the send unaffected
                        let index = ev["index"].as_i64().unwrap_or(-1);
                        if let Some(p) = self.typing_probe.as_mut().filter(|p| p.index == index && !p.done) {
                            p.buf.push_str(d["partial_json"].as_str().unwrap_or(""));
                            match crate::net::typing::leading_metadata(&p.buf) {
                                crate::net::typing::Scan::Pending if p.buf.len() <= crate::net::typing::PROBE_MAX => {}
                                crate::net::typing::Scan::Ready(meta) => {
                                    p.done = true;
                                    p.started = true;
                                    p.buf = String::new();
                                    crate::net::typing::begin(&self.engine, self.org_id, self.id, &self.name, &p.call, &meta);
                                }
                                _ => {
                                    p.done = true;
                                    p.buf = String::new();
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if let Some(t) = self.turn.as_mut() {
            t.activity = true;
        }
    }

    #[nolog]
    fn set_activity(&mut self, phase: &str, tool: Option<String>) {
        let next = Some((phase.to_string(), tool));
        if self.activity != next {
            self.activity = next;
            self.publish();
        }
    }

    async fn on_assistant(&mut self, v: &Value) -> Result<()> {
        let msg = &v["message"];
        let mid = msg["id"].as_str().unwrap_or("").to_string();
        let mut wrote_text = false;
        let mut wrote_tool = None;
        let mut wrote_thought = false;
        let (seq, row) = {
            let Some(turn) = self.turn.as_mut() else { return Ok(()) };
            turn.activity = true;
            if let Some(u) = msg.get("usage").filter(|u| u.is_object()) {
                turn.usage = u.clone();
            }
            if let Some(m) = msg["model"].as_str() {
                turn.model = Some(m.to_string());
            }
            let (seq, mut row) = turn.rows.get(&mid).cloned().unwrap_or((
                0,
                json!({ "role": "assistant", "text": "", "tools": [], "content_blocks": [], "ts": now_iso(),
                        "assistant_id": mid, "native_event_id": v["uuid"] }),
            ));
            for block in msg["content"].as_array().cloned().unwrap_or_default() {
                match block["type"].as_str() {
                    Some("text") => {
                        let cur = row["text"].as_str().unwrap_or("").to_string();
                        let add = block["text"].as_str().unwrap_or("");
                        row["text"] = json!(if cur.is_empty() { add.to_string() } else { format!("{cur}\n\n{add}") });
                        // UTF-16 offsets match JavaScript String.slice, including non-BMP text.
                        let start = cur.encode_utf16().count() + if cur.is_empty() { 0 } else { 2 };
                        convo::append_display_block(&mut row, json!({"kind":"text", "start":start, "end":start + add.encode_utf16().count()}));
                        turn.draft.clear();
                        turn.draft_order = None;
                        wrote_text = true;
                    }
                    Some("thinking") => {
                        let cur = row.get("thinking").and_then(Value::as_str).unwrap_or("").to_string();
                        let add = block["thinking"].as_str().unwrap_or("");
                        if add.is_empty() {
                            row["thinking_sealed"] = json!(true);
                        } else {
                            let joined = if cur.is_empty() { add.to_string() } else { format!("{cur}\n\n{add}") };
                            row["thinking"] = json!(convo::clip(&joined, 20_000).0);
                        }
                        let room = 20_000usize.saturating_sub(cur.chars().count() + if cur.is_empty() { 0 } else { 2 });
                        let shown = convo::clip(add, room).0;
                        if !shown.is_empty() || add.is_empty() {
                            let start = cur.encode_utf16().count() + if cur.is_empty() { 0 } else { 2 };
                            convo::append_display_block(&mut row, json!({"kind":"thinking", "start":start, "end":start + shown.encode_utf16().count(), "sealed":add.is_empty()}));
                        }
                        turn.thinking.clear();
                        turn.thinking_order = None;
                        wrote_thought = true;
                    }
                    Some("redacted_thinking") => {
                        row["thinking_sealed"] = json!(true);
                        convo::append_display_block(&mut row, json!({"kind":"thinking", "sealed":true}));
                        turn.thinking.clear();
                        turn.thinking_order = None;
                        wrote_thought = true;
                    }
                    Some("tool_use") | Some("server_tool_use") => {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("tool").to_string();
                        if row["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["id"].as_str() == Some(id.as_str()))) {
                            continue;
                        }
                        crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                        let input = block["input"].clone();
                        let mut chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input), "input": input, "started_at": now_iso(),
                            "refs": convo::tool_refs(&name, &input, None) });
                        if name == "Agent" || name == "Task" {
                            chip["helper_transcript"] = json!(true);
                        }
                        if let Some(secs) = turn.tool_writing.take(&id) {
                            chip["writing_secs"] = json!(secs);
                        }
                        if name == "TodoWrite" {
                            chip["todos"] = input["todos"].clone();
                        }
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(chip);
                        }
                        // Keep native block order without duplicating tool inputs
                        // or results; the block resolves the current chip by id.
                        convo::append_display_block(&mut row, json!({"kind":"tool", "id":id}));
                        turn.tools.insert(id.clone(), mid.clone());
                        wrote_tool = Some(id);
                    }
                    _ => {}
                }
            }
            (seq, row)
        };
        let client = self.engine.db.get().await?;
        let seq = if seq == 0 {
            self.convo.append(&client, row.clone()).await?
        } else {
            self.convo.update(&client, seq, row.clone()).await?;
            seq
        };
        drop(client);
        for chip in row["tools"].as_array().into_iter().flatten().filter(|c| c["helper_transcript"] == true) {
            if let Some(id) = chip["id"].as_str() {
                let key = (seq, id.to_string());
                if self.helpers.len() < super::helper_transcript::MAX_CALLS || self.helpers.contains_key(&key) {
                    let transcript = self.helpers.entry(key).or_default();
                    transcript.dirty = true;
                    self.helper_due.get_or_insert(Instant::now() + Duration::from_millis(250));
                }
            }
        }
        if let Some(turn) = self.turn.as_mut() {
            turn.rows.insert(mid, (seq, row));
        }
        if wrote_text {
            self.text_landed();
        }
        if let Some(id) = wrote_tool {
            self.stream("tool", json!({ "id": id }));
        } else if wrote_thought && !wrote_text {
            self.stream("thought", json!({}));
        }
        Ok(())
    }

    async fn on_tool_results(&mut self, v: &Value) -> Result<()> {
        // Publish the last helper deltas before its parent call can become
        // terminal (and expanded readers stop their live refresh).
        self.flush_helpers().await;
        let mut images: Vec<(String, Vec<(String, Vec<u8>)>)> = Vec::new();
        let updates: Vec<(i64, Value)> = {
            let Some(turn) = self.turn.as_mut() else { return Ok(()) };
            turn.activity = true;
            let blocks = v.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut touched: Vec<String> = Vec::new();
            for b in blocks {
                if b["type"] != "tool_result" {
                    continue;
                }
                let tid = b["tool_use_id"].as_str().unwrap_or("").to_string();
                let Some(mid) = turn.tools.get(&tid).cloned() else { continue };
                let Some((_, row)) = turn.rows.get_mut(&mid) else { continue };
                let (text, n_images) = convo::tool_result_text(&b["content"]);
                if n_images > 0 {
                    images.push((tid.clone(), convo::image_blocks(&b["content"])));
                }
                let images = n_images;
                let (clipped, truncated) = convo::clip(&text, 4000);
                if let Some(chips) = row["tools"].as_array_mut() {
                    for chip in chips.iter_mut().filter(|c| c["id"].as_str() == Some(tid.as_str())) {
                        chip["result"] = json!(clipped);
                        chip["result_lines"] = json!(text.lines().count());
                            chip["ended_at"] = json!(now_iso());
                                let refs = convo::tool_refs(chip["name"].as_str().unwrap_or(""), &chip["input"], Some(&text));
                                chip["refs"] = refs;
                        if truncated {
                            chip["truncated"] = json!(true);
                        }
                        if images > 0 {
                            chip["images"] = json!(images);
                        }
                        if b["is_error"].as_bool().unwrap_or(false) {
                            chip["error"] = json!(gist(&text, 500));
                        }
                        convo::retain_failed_shell_output(chip, &text, b["is_error"] == true, false);
                        if let Some(diff) = patch_of(v) {
                            chip["diff"] = diff;
                        }
                        if let Some(extra) = turn.cards.remove(&tid) {
                            if let (Some(c), Some(e)) = (chip.as_object_mut(), extra.as_object()) {
                                for (k, val) in e {
                                    c.insert(k.clone(), val.clone());
                                }
                            }
                        }
                    }
                }
                touched.push(mid);
            }
            touched.sort();
            touched.dedup();
            touched.iter().filter_map(|m| turn.rows.get(m).map(|(s, r)| (*s, r.clone()))).collect()
        };
        if updates.is_empty() {
            return Ok(());
        }
        let client = self.engine.db.get().await?;
        self.convo.update_batch(&client, updates).await;
        for (tid, list) in images {
            if let Err(e) = convo::store_images(&client, self.id, &tid, list).await {
                tracing::warn!(agent=self.id, error=%format!("{e:#}"), "tool images failed; continuing batch");
            }
        }
        drop(client);
        self.set_activity("thinking", None);
        self.stream("tool", json!({}));
        Ok(())
    }

    async fn on_result(&mut self, v: &Value) -> Result<()> {
        let is_error =
            v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().map(|s| s != "success").unwrap_or(false);
        let interrupted = self.turn.as_ref().map(|t| t.interrupted).unwrap_or(false);
        let error = if is_error && !interrupted {
            let text = v["result"].as_str().unwrap_or("");
            Some(if text.is_empty() {
                let errs =
                    v["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str()).collect::<Vec<_>>().join("; "));
                errs.filter(|s| !s.is_empty()).unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").to_string())
            } else {
                gist(text, 600)
            })
        } else {
            None
        };
        self.end_turn(error, v.clone()).await
    }

    #[nolog]
    /// 3.x `_launch_working_cache_read` + `_working_cache_read`: one
    /// disposable read of a reported-working Claude agent's prompt prefix,
    /// when nothing else owns the agent, working checkups are off, and its
    /// lane's interval has passed since its last real request.
    async fn start_keepalive(&mut self) -> Result<()> {
        if self.stopping || self.turn.is_some() || self.waiting_since.is_some() || self.slot.is_some() || self.keepalive.is_some() {
            return Ok(());
        }
        if !keepalive::retry_due(self.id) {
            return Ok(());
        }
        if crate::runtime::reminders::switches(&self.engine).checkups || !self.engine.settings.provider_enabled(catalog::CLAUDE) {
            return Ok(());
        }
        let ctx = self.load_ctx().await?;
        if ctx.state != "live" || ctx.halted || ctx.frozen || ctx.killswitch || ctx.limit_locked || ctx.provider != catalog::CLAUDE {
            return Ok(());
        }
        let Some(session) = ctx.session_id.clone() else { return Ok(()) };
        let client = self.engine.db.get().await?;
        let row = client
            .query_one(
                "SELECT a.last_status->>'status' = 'working', a.extra->>'cache_keepalive_at',
                        (SELECT greatest(t.started_at, t.ended_at) FROM ot.turns t WHERE t.agent_id = a.id ORDER BY t.id DESC LIMIT 1),
                        EXISTS (SELECT 1 FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND m.recipient_agent_id = a.id AND m.state = 'pending'
                                   AND m.ev->>'variant' LIKE 'reminder.%')
                   FROM ot.agents a WHERE a.id = $1",
                &[&self.id],
            )
            .await?;
        drop(client);
        // 3.x `_working_cache_due`: still working, and no automatic wake waits beside it
        if row.get::<_, Option<bool>>(0) != Some(true) || row.get::<_, bool>(3) {
            return Ok(());
        }
        let account = ctx.account.as_deref().and_then(|a| self.engine.accounts.view().get(a).cloned());
        let apikey = account.as_ref().map(|a| a.is_apikey()).unwrap_or(false);
        let interval = keepalive::interval(apikey);
        let Some(last) = keepalive::last_request(row.get::<_, Option<String>>(1).as_deref(), row.get(2)) else { return Ok(()) };
        if (Utc::now() - last).num_seconds() < interval {
            return Ok(());
        }
        let Ok(slot) = keepalive::slots().try_acquire_owned() else { return Ok(()) };
        let mut plan = self.plan(&ctx);
        // a warm CLI keeps the org's shared notes it started with, and its
        // next turn reads that prefix: keep THAT one warm
        if let Some(n) = self.proc_notes.as_ref().filter(|n| **n != plan.notes) {
            plan.identity = format!("{}{n}", &plan.identity[..plan.identity.len() - plan.notes.len()]);
            plan.print.org_notes = Some(hash(n));
            plan.notes = n.clone();
        }
        let (spec, config_dir) = self.claude_spec(&ctx, None, &plan, true).await?;
        // a session with no transcript has no prefix to read
        if spec.resume.as_deref() != Some(session.as_str()) {
            return Ok(());
        }
        let sessions_dir = config_dir
            .map(PathBuf::from)
            .unwrap_or_else(claude::default_config_dir)
            .join("projects")
            .join(claude::project_dir(&ctx.scratch));
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let proc = ClaudeProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        let process = proc.process;
        let sent = proc.send_plain(keepalive::PROMPT);
        tracing::info!(agent = %self.name, %process, session = %session, apikey, "prompt-cache keepalive started");
        self.keepalive = Some(Keepalive {
            proc,
            process,
            session,
            fork: None,
            started: Instant::now(),
            sessions_dir,
            account: ctx.account.clone(),
            apikey,
            print: plan.print,
            result: None,
            _slot: slot,
        });
        if !sent {
            self.end_keepalive(KeepaliveEnd::Failed("the keepalive CLI took no prompt")).await;
        }
        self.publish();
        Ok(())
    }

    /// A line from the keepalive's CLI: the fork's session id, then its result.
    async fn on_keepalive_event(&mut self, v: Value) {
        let Some(k) = self.keepalive.as_mut() else { return };
        if let Some(sid) = v["session_id"].as_str().filter(|s| !s.is_empty() && *s != k.session) {
            k.fork = Some(sid.to_string());
        }
        if v["type"].as_str() == Some("result") {
            k.result = Some(v);
            self.end_keepalive(KeepaliveEnd::Done).await;
        }
    }

    /// Real work comes first: a running keepalive is killed (3.x
    /// `_cancel_working_cache`), with no backoff.
    async fn cancel_keepalive(&mut self) {
        if self.keepalive.is_some() {
            tracing::info!(agent = %self.name, "prompt-cache keepalive cancelled: the agent has real work");
            self.end_keepalive(KeepaliveEnd::Cancelled).await;
        }
    }

    /// The keepalive is over (3.x `_working_cache_read`'s finally): its CLI is
    /// closed and its fork's transcript removed, so nothing of it stays in the
    /// agent's sessions; its cost is banked; a good read refreshes the cache
    /// receipt (the prefix is warm again); a failed one backs the next off.
    async fn end_keepalive(&mut self, end: KeepaliveEnd) {
        let Some(mut k) = self.keepalive.take() else { return };
        match end {
            KeepaliveEnd::Done => k.proc.close().await,
            _ => k.proc.kill().await,
        }
        if let Some(fork) = k.fork.as_deref() {
            let file = k.sessions_dir.join(format!("{fork}.jsonl"));
            if let Err(e) = std::fs::remove_file(&file) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(agent = %self.name, file = %file.display(), error = %e, "the keepalive's fork transcript could not be removed");
                }
            }
        }
        let res = k.result.take().unwrap_or(Value::Null);
        let cost = res["total_cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0).unwrap_or(0.0);
        let ok = matches!(end, KeepaliveEnd::Done) && !res["is_error"].as_bool().unwrap_or(false) && k.fork.is_some();
        if let Err(e) = self.bank_keepalive(&k, &res, cost, ok).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the keepalive's cost or receipt was not recorded");
        }
        match (&end, ok) {
            (_, true) => {
                keepalive::clear_failure(self.id);
                tracing::info!(agent = %self.name, cost, "prompt-cache keepalive done");
            }
            (KeepaliveEnd::Cancelled, _) => {}
            (KeepaliveEnd::Failed(why), _) => self.keepalive_failed(why),
            (KeepaliveEnd::Done, _) => self.keepalive_failed("the read did not succeed"),
        }
        self.publish();
    }

    #[nolog]
    fn keepalive_failed(&self, why: &str) {
        let (failures, wait) = keepalive::note_failure(self.id);
        // advisory, deliberately not last_error: the agent itself is not broken
        tracing::warn!(agent = %self.name, why, failures, retry_in_s = wait.as_secs(), "prompt-cache keepalive skipped");
    }

    /// The keepalive's spend on the agent and its account; after a good read
    /// on the session it forked, the stamp the keeper counts from and the
    /// cache receipt the next turn's forecast reads.
    async fn bank_keepalive(&mut self, k: &Keepalive, res: &Value, cost: f64, ok: bool) -> Result<()> {
        let client = self.engine.db.get().await?;
        if cost > 0.0 {
            client.execute("UPDATE ot.agents SET cost_usd = cost_usd + $2::float8::numeric WHERE id = $1", &[&self.id, &cost]).await?;
            if let Some(acc) = &k.account {
                client
                    .execute(
                        "INSERT INTO ot.account_spend (account, usd_total, turns) VALUES ($1, $2::float8::numeric, 0)
                         ON CONFLICT (account) DO UPDATE SET usd_total = ot.account_spend.usd_total + EXCLUDED.usd_total, updated_at = now()",
                        &[acc, &cost],
                    )
                    .await?;
            }
        }
        if !ok {
            return Ok(());
        }
        let stamped = client
            .execute(
                "UPDATE ot.agents SET extra = jsonb_set(extra, '{cache_keepalive_at}', to_jsonb($3::text)) WHERE id = $1 AND session_id = $2",
                &[&self.id, &k.session, &iso(Utc::now())],
            )
            .await?;
        drop(client);
        let usage = &res["usage"];
        let n = |p: &str| usage.pointer(p).and_then(Value::as_i64).unwrap_or(0);
        if stamped == 1 && n("/cache_read_input_tokens") + n("/cache_creation_input_tokens") > 0 {
            // a read refreshes the entry it hit, at the tier it was written with
            let ttl = if n("/cache_creation/ephemeral_1h_input_tokens") > 0 {
                3600
            } else if n("/cache_creation/ephemeral_5m_input_tokens") > 0 {
                300
            } else {
                self.receipt.map(|r| r.1).unwrap_or(if k.apikey { 300 } else { 3600 })
            };
            self.receipt = Some((Utc::now(), ttl));
            self.sent_print = Some(k.print.clone());
            self.save_receipt().await;
            self.update_forecast().await;
        }
        self.changed(vec![Change::Agent(self.id)]);
        Ok(())
    }

    fn owns_process(&self, process: uuid::Uuid) -> bool {
        self.proc.as_ref().map(Proc::process) == Some(process)
    }

    async fn on_exit(&mut self, process: uuid::Uuid, reason: &str) -> Result<()> {
        if self.keepalive.as_ref().map(|k| k.process) == Some(process) {
            tracing::info!(agent = %self.name, %process, reason, "the keepalive CLI exited before its result");
            self.end_keepalive(KeepaliveEnd::Failed("the keepalive CLI exited before its result")).await;
            return Ok(());
        }
        if !self.owns_process(process) {
            tracing::info!(agent = self.id, %process, reason, "ignored exit from replaced CLI");
            return Ok(());
        }
        // its message calls are not being written any more (typing in Hubchat)
        self.typing_probe = None;
        crate::net::typing::stop_agent(&self.engine, self.id);
        self.engine.credential_bridge.revoke(self.id);
        let status = self.proc.as_mut().unwrap().exit_status(reason).await;
        let host = self.proc.as_ref().and_then(|p| p.host());
        let pid = self.proc.as_ref().map(|p| p.pid()).unwrap_or(0);
        self.proc = None;
        self.proc_print = None;
        self.proc_notes = None;
        self.unpark();
        self.bg_reset();
        self.claude_own = false;
        if let Err(e) = self.compact_close("interrupted", Value::Null).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "an open compaction row could not be closed");
        }
        self.orphans(&format!("the CLI exited: {reason}"));
        self.claude_lost(&format!("the CLI exited: {reason}")).await;
        self.muse_lost(&format!("the host exited: {reason}")).await;
        // A CLI in the user's session ends with that session: the user signed
        // out of it, or its sign-in helper stopped (another session of the
        // user may stay hosted). That is no failure of the agent: the turn
        // stops cleanly, its mail is kept as for any CLI that died (given back
        // when the CLI had produced nothing), and a new turn continues it at
        // once, woken as after an engine restart mid-turn and placed by the
        // turn-start rule: in Session 0, or another session that still has a
        // helper (docket option-to-run-the-background-engine-in-the-user-s;
        // the user, 2026-10-16 11:03Z). Windows ended the CLI, not this engine:
        // the kill record says so, with its exit status.
        let deliberate = self.turn.as_ref().is_some_and(|t| t.interrupted || t.killed) || self.stopping;
        let session_ended = may_be_session_end(host.is_some(), self.turn.is_some(), deliberate) && self.session_gone(host).await;
        if let Some(t) = self.turn.as_mut() {
            t.exited = true;
            t.session_ended = session_ended;
        }
        if self.turn.is_some() {
            let quiet = self.turn.as_ref().map(|t| t.interrupted || t.killed).unwrap_or(false);
            let msg = if session_ended {
                crate::codex_kills::session_ended(pid, &self.name, &status);
                tracing::info!(agent = %self.name, %process, pid, "the user's Windows session ended during the turn; a new turn continues it");
                Some(SESSION_ENDED.to_string())
            } else if quiet {
                None
            } else {
                Some(format!("the {} process exited during the turn ({status}; {reason})", catalog::provider_label(&self.provider)))
            };
            self.end_turn(msg, Value::Null).await?;
            if session_ended {
                if let Err(e) = crate::domain::runtime_notices::session_ended(&self.engine, self.org_id, self.id).await {
                    tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the session-end wake could not be sent");
                }
            }
        } else {
            // the next turn starts a CLI: the forecast weighs what it will read (org notes)
            self.update_forecast().await;
        }
        self.publish();
        Ok(())
    }

    /// The last wall whose own countdown set a freeze (3.x `last_wall`): it
    /// outlives the release and a completed turn drops it (`clear_runs`).
    async fn last_wall(&self) -> Value {
        let Ok(client) = self.engine.db.get().await else { return Value::Null };
        client
            .query_one("SELECT extra->'last_wall' FROM ot.agents WHERE id = $1", &[&self.id])
            .await
            .ok()
            .and_then(|r| r.get::<_, Option<Value>>(0))
            .unwrap_or(Value::Null)
    }

    async fn remember_wall(&self, wall: &Value) {
        let Ok(client) = self.engine.db.get().await else { return };
        if let Err(e) = client
            .execute("UPDATE ot.agents SET extra = jsonb_set(extra, '{last_wall}', $2) WHERE id = $1", &[&self.id, wall])
            .await
        {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the usage-limit wall could not be kept");
        }
    }

    /// The usage limit this failure reports, if it is one: when it lifts, and
    /// the wall to remember when its own countdown said so (`prior`: the last
    /// one, for 3.x's anchor-once rule).
    fn limit_of(&self, error: &str, prior: &Value) -> Option<(DateTime<Utc>, Option<Value>)> {
        let lower = error.to_lowercase();
        let rejected = self
            .rate_limit
            .as_ref()
            .map(|r| r["status"] == "rejected" || !r["rateLimitReachedType"].is_null())
            .unwrap_or(false);
        let worded = lower.contains("usage limit")
            || lower.contains("hit your limit")
            || lower.contains("limit reached")
            || lower.contains("rate limit")
            || lower.contains("resets")
            || recovery::worded_limit(error);
        if !rejected && !worded {
            return None;
        }
        let from_info = self
            .rate_limit
            .as_ref()
            .and_then(|r| {
                r["resetsAt"].as_i64().or_else(|| {
                    ["primary", "secondary"]
                        .iter()
                        .filter(|w| r[**w]["usedPercent"].as_i64().unwrap_or(0) >= 100)
                        .filter_map(|w| r[*w]["resetsAt"].as_i64())
                        .max()
                })
            })
            .and_then(|t| DateTime::from_timestamp(t, 0))
            .filter(|t| *t > Utc::now());
        if let Some(t) = from_info {
            return Some((t, None));
        }
        // the wall's own "Resets in 2h53m47s", anchored once (3.x)
        if let Some(secs) = recovery::reset_in_seconds(error) {
            let (kind, until) = recovery::countdown_until(secs, prior, Utc::now());
            tracing::info!(agent = %self.name, countdown = kind, secs, until = %iso(until), "usage limit countdown");
            return Some((until, Some(json!({ "secs": secs, "until": iso(until) }))));
        }
        let from_text = error
            .split('|')
            .nth(1)
            .and_then(|s| s.trim().parse::<i64>().ok())
            .and_then(|t| DateTime::from_timestamp(t, 0));
        Some((from_text.unwrap_or_else(|| Utc::now() + chrono::Duration::hours(1)), None))
    }

    /// Coalesce token deltas into at most four private writes per second per
    /// helper. SQL changes no feed revision or parent's tool inputs.
    #[nolog]
    async fn flush_helpers(&mut self) {
        self.helper_due = None;
        if !self.helpers.values().any(|t| t.dirty) { return; }
        let client = match self.engine.db.get().await {
            Ok(client) => client,
            Err(_) => { self.helper_due = Some(Instant::now() + Duration::from_secs(1)); return; }
        };
        for ((seq, tool), transcript) in &mut self.helpers {
            if !transcript.dirty { continue; }
            let snapshot = transcript.snapshot();
            match client.execute(
                "UPDATE ot.convo SET tool_inputs = jsonb_set(tool_inputs, ARRAY[$3::text, 'helper_transcript'], $4::jsonb, true) WHERE agent_id = $1 AND seq = $2 AND tool_inputs ? $3::text",
                &[&self.id, seq, tool, &snapshot],
            ).await {
                Ok(_) => transcript.dirty = false,
                Err(_) => {
                    tracing::warn!(agent=self.id, seq, "helper transcript save failed; retrying");
                    self.helper_due = Some(Instant::now() + Duration::from_secs(1));
                }
            }
        }
    }

    /// Close the turn: mail settled, ledger written, slot freed.
    async fn end_turn(&mut self, mut error: Option<String>, res: Value) -> Result<()> {
        self.flush_helpers().await;
        self.helpers.retain(|_, helper| helper.dirty);
        // Process exits and interrupts do not necessarily carry an `agy`
        // result. Settle the outstanding hook handoff on every exit path.
        if let Err(e) = self.settle_agy_steer().await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "mid-turn mail could not be settled");
        }
        // the turn's message calls are over (typing in Hubchat)
        self.typing_probe = None;
        crate::net::typing::stop_agent(&self.engine, self.id);
        let Some(turn) = self.take_turn() else { return Ok(()) };
        // the agent ended this turn itself and asked for a new one: exactly
        // one, as a turn is taken once; a halt takes its turn without this
        if turn.restart && !self.stopping {
            tracing::info!(agent = %self.name, "a new turn starts at once, as the agent asked when it ended its turn");
            if let Err(e) = crate::domain::runtime_notices::restart_asked(&self.engine, self.org_id, self.id).await {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the restart wake could not be sent");
            }
        }
        // a compaction the turn ended before the harness reported its end
        if let Err(e) = self.compact_close("interrupted", Value::Null).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "an open compaction row could not be closed");
        }
        crate::runtime::watchdogs::activity(&self.engine, self.id, "turn_done");
        // background results settled during this turn: a turn the CLI starts
        // by itself right after it shows it did not take them
        if !self.bg_in_turn.is_empty() {
            self.bg_grace = Some(Instant::now() + BG_GRACE);
        }
        let codex = res["codex"].as_bool().unwrap_or(false);
        // A terminal process error may carry no result object. The admitted
        // provider still determines the usage shape and quota pool.
        let agy = turn.serving_provider == catalog::GOOGLE || res["agy"].as_bool().unwrap_or(false);
        let muse = turn.serving_provider == catalog::MUSE || res["muse"].as_bool().unwrap_or(false);
        if error.is_none() && codex {
            error = turn.codex_error.clone().filter(|_| !turn.interrupted);
        }
        if error.as_deref().is_some_and(prompt::input_length_refusal) {
            error = Some(match turn.input_shape {
                Some((bytes, chars, budget)) => format!("Input exceeds maximum length: opening input {bytes} UTF-8 bytes / {chars} characters; Orgtree budget {budget} bytes. No automatic retry."),
                None => "Input exceeds maximum length: input sizes unavailable for this non-mail turn. No automatic retry.".into(),
            });
        }
        let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
        let (input, cache_read, cache_write, output, ttl, occupancy, cost) = if turn.acp {
            let u = &turn.usage;
            (n(u,"input_tokens"),n(u,"cache_read_input_tokens"),n(u,"cache_creation_input_tokens"),n(u,"output_tokens"),0,n(u,"context_used") as i32,0.0)
        } else if agy {
            let u = &turn.usage;
            (n(u, "input"), n(u, "cached"), 0, n(u, "output"), 300, n(u, "last_prompt") as i32, u["cost"].as_f64().unwrap_or(0.0))
        } else if muse {
            // Muse publishes neither prices nor a cache lifetime: the cost is
            // unknown (never zero) and so is the TTL. Child runs' usage is
            // kept apart (`children`), as Muse keeps it out of the session's.
            let u = &turn.usage;
            if u["children"].is_object() {
                tracing::info!(agent = %self.name, turn = turn.id, children = %u["children"], "Muse child runs' own usage (not in the turn's)");
            }
            (n(u, "input"), n(u, "cache_read"), n(u, "cache_write"), n(u, "output"), 0, n(u, "last_prompt") as i32, 0.0)
        } else if codex {
            // Codex counts tokens for the whole thread: this turn is the difference
            let total = &turn.usage["total"];
            let last = &turn.usage["last"];
            let base = turn.usage_base.clone().unwrap_or_else(|| {
                let mut b = json!({});
                for k in ["inputTokens", "cachedInputTokens", "outputTokens", "cacheWriteInputTokens"] {
                    b[k] = json!((n(total, k) - n(last, k)).max(0));
                }
                b
            });
            let d = |k: &str| (n(total, k) - n(&base, k)).max(0);
            let (inp, cached, out) = (d("inputTokens"), d("cachedInputTokens").min(d("inputTokens")), d("outputTokens"));
            let tier = self.tier().await;
            let cost = catalog::tier(&tier)
                .and_then(|t| t.prices)
                .or_else(|| crate::openrouter::prices(&self.engine, &tier))
                .map(|(pi, pc, po)| ((inp - cached) as f64 * pi + cached as f64 * pc + out as f64 * po) / 1e6)
                .unwrap_or(0.0);
            let occ = if n(last, "inputTokens") > 0 { n(last, "inputTokens") } else { n(total, "inputTokens") };
            (inp - cached, cached, d("cacheWriteInputTokens"), out, 1800, occ as i32, cost)
        } else {
            let usage = if res.get("usage").map(|u| u.is_object()).unwrap_or(false) { res["usage"].clone() } else { turn.usage.clone() };
            let ttl: i32 =
                if usage.pointer("/cache_creation/ephemeral_1h_input_tokens").and_then(Value::as_i64).unwrap_or(0) > 0 { 3600 } else { 300 };
            // the last model call's input is how full the context is
            let occupancy = (n(&turn.usage, "input_tokens")
                + n(&turn.usage, "cache_read_input_tokens")
                + n(&turn.usage, "cache_creation_input_tokens")) as i32;
            // the CLI's cost counter runs for the whole session
            let total = res.get("total_cost_usd").and_then(Value::as_f64);
            let cost = match total {
                Some(t) if t >= self.cost_seen => t - self.cost_seen,
                Some(t) => t,
                None => 0.0,
            };
            if let Some(t) = total {
                self.cost_seen = t;
            }
            (
                n(&usage, "input_tokens"),
                n(&usage, "cache_read_input_tokens"),
                n(&usage, "cache_creation_input_tokens"),
                n(&usage, "output_tokens"),
                ttl,
                occupancy,
                cost,
            )
        };
        // an OpenRouter seat on Claude Code is priced from its favorite's rates
        // (the CLI's own counter does not know the gateway's prices)
        let openrouter = self.provider == catalog::OPENROUTER;
        // a language server is the user's own hardware: nothing is billed
        let langserver = self.provider == catalog::LANGSERVER;
        let cost = if langserver {
            0.0
        } else if openrouter && !codex && !turn.acp {
            let tier = self.tier().await;
            match crate::openrouter::prices(&self.engine, &tier) {
                Some((pi, pc, po)) => {
                    ((input + cache_write) as f64 * pi + cache_read as f64 * pc + output as f64 * po) / 1e6
                }
                None => cost,
            }
        } else {
            cost
        };
        let ms = res.get("duration_ms").and_then(Value::as_i64).unwrap_or(turn.started.elapsed().as_millis() as i64);
        let mut denials: Vec<Value> = res
            .get("permission_denials")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|d| {
                        let tool = d["tool_name"].as_str().unwrap_or("").to_string();
                        json!({ "tool": tool, "arg": convo::tool_arg(&tool, &d["tool_input"]) })
                    })
                    .collect()
            })
            .unwrap_or_default();
        denials.extend(turn.denials.iter().cloned());
        let session = res.get("session_id").and_then(Value::as_str).map(str::to_string);
        // a usage limit freezes the agent (or moves it to another account)
        // the last wall this agent hit, for the anchor-once countdown rule
        let prior_wall = match &error {
            Some(_) => self.last_wall().await,
            None => Value::Null,
        };
        // Muse types its quota refusal (kind and reset); its words are never parsed
        let (limit, wall) = if muse {
            (turn.muse_quota.filter(|_| error.is_some()), None)
        } else {
            match error.as_deref().and_then(|e| self.limit_of(e, &prior_wall)) {
                Some((until, wall)) => (Some(until), wall),
                None => (None, None),
            }
        };
        let mut freeze_rec: Option<Value> = None;
        // an opted-in agent may move to another account; that search reads
        // usage and runs after this turn is settled, off the actor (3.x: the
        // background scheduler moves frozen agents)
        let mut fall_back: Option<(String, Option<String>, String)> = None;
        if let Some(until) = limit {
            let ctx = self.load_ctx().await?;
            if ctx.fallback {
                fall_back = Some((ctx.tier.clone(), ctx.account.clone(), ctx.org_slug.clone()));
            }
            let mut rec = json!({
                "at": now_iso(), "until": iso(until), "error": gist(error.as_deref().unwrap_or(""), 300),
                "limit": true, "provenance": "observed", "account": ctx.account,
            });
            // Codex/Antigravity: the refused request goes out again at the wake
            if !turn.replay.is_empty() {
                rec["resume_texts"] = json!([turn.replay]);
            }
            freeze_rec = Some(rec);
            if let Some(w) = &wall {
                self.remember_wall(w).await;
            }
            error = None;
        }
        // P34/P35 (3.x): a transient failure retries behind a connection
        // freeze; a rejected credential or repeated balance refusals park the
        // agent with no reset time. Classified failures skip the generic
        // stalled card; their own alerts follow below.
        let mut classified = false;
        let mut exhausted: Option<(i64, String)> = None;
        let mut parked: Option<&'static str> = None;
        // a turn the end of the user's session stopped is no failure (on_exit)
        if let (Some(e), false) = (error.as_deref(), turn.interrupted || turn.killed || turn.session_ended || freeze_rec.is_some()) {
            let died = turn.exited && turn.activity && res.is_null();
            let account = turn.serving_account.as_deref();
            // Muse classifies its own failures: a sign-in it needs, or one it
            // judges retryable; anything else reads as the other lanes do
            let class = if prompt::input_length_refusal(e) { None } else { match turn.muse_error.as_ref().filter(|_| muse) {
                Some((kind, _)) if kind == "authRequired" => Some(recovery::Class::Auth),
                Some((kind, true)) => Some(recovery::Class::Net(format!("Muse reported a retryable {kind} failure"))),
                _ => recovery::classify(e, &res, openrouter || langserver, died),
            } };
            match class {
                Some(recovery::Class::Net(kind)) => {
                    classified = true;
                    let run = recovery::bump(&self.engine, self.id, "net_fail_run").await?;
                    if run <= recovery::NET_RETRY_MAX {
                        freeze_rec = Some(recovery::connection_freeze(run, &kind, e, account));
                    } else if run == recovery::NET_RETRY_MAX + 1 {
                        exhausted = Some((run - 1, kind));
                    }
                }
                Some(recovery::Class::Auth) => {
                    classified = true;
                    freeze_rec = Some(recovery::auth_freeze(e, account, &self.provider));
                    parked = Some("auth");
                    if openrouter {
                        // the panel's "connected" must not outlive the refusal
                        crate::openrouter::key_refused(&self.engine);
                    }
                }
                Some(recovery::Class::Balance) => {
                    classified = true;
                    let run = recovery::bump(&self.engine, self.id, "balance_probe_run").await?;
                    let (rec, park) = recovery::balance_freeze(run, e, account);
                    freeze_rec = Some(rec);
                    if park {
                        parked = Some("balance");
                    }
                }
                None => {}
            }
        }
        // A language server's window filled and the CLI could not compact the
        // conversation (live 2026-10-11: "Prompt is too long · automatic
        // compaction failed: summarization produced empty response"): the
        // agent goes on in a fresh session seeded with a handoff note, a few
        // times in a row at most (a completed turn starts the count again).
        let mut fresh: Option<i64> = None;
        if let (Some(e), true) = (error.as_deref(), langserver && !classified && freeze_rec.is_none() && !turn.interrupted && !turn.killed) {
            if !prompt::input_length_refusal(e) && recovery::context_full(e) {
                let run = recovery::bump(&self.engine, self.id, "ctx_reset_run").await?;
                if run <= recovery::CTX_RESET_MAX {
                    fresh = Some(run);
                    classified = true;
                }
            }
        }
        // the CLI holds the prompt once it produced anything: settle the mail
        // as delivered; a turn that never started gives its mail back. A Codex
        // thread holds it once turn/start was accepted (3.x), so a provider
        // that keeps failing never re-sends a growing batch.
        let succeeded = error.is_none() && limit.is_none() && !turn.limit_signal
            && !turn.interrupted && !turn.killed && !turn.compact && !res.is_null();
        let requeue = error.is_some() && !turn.activity
            && (turn.codex_turn.is_none() || error.as_deref().is_some_and(prompt::input_length_refusal));
        let client = self.engine.db.get().await?;
        if let Some((_, ids, _)) = &turn.agy_steer {
            // A failed hook settlement is not delivery. Return these rows
            // before the bulk settlement, preserving their original IDs/order.
            client.execute(
                "UPDATE ot.mail SET state = 'pending', turn_id = NULL
                  WHERE id = ANY($1) AND turn_id = $2 AND state = 'delivering'",
                &[ids, &turn.id],
            ).await?;
        }
        // Read BEFORE returning a failed opening prompt. Only genuinely new
        // waiting mail may drive a retry after an error; otherwise a broken
        // provider would spin forever on the same requeued opening message.
        self.followup_mail = client.query(
            "SELECT uid FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND recipient_agent_id = $1 AND state = 'pending'
              AND (NOT notice OR extra->>'input_budget_deferred'='true') ORDER BY id LIMIT 64", &[&self.id],
        ).await?.into_iter().map(|r| r.get(0)).collect();
        if requeue {
            client
                .execute(
                    "UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE turn_id = $1 AND state = 'delivering'",
                    &[&turn.id],
                )
                .await?;
        } else {
            let delivered = crate::domain::mail::acknowledge_turn(&self.engine, &client, turn.id).await?;
            crate::runtime::watchdogs::events::mail_delivered(&self.engine, self.org_id, self.id, delivered);
        }
        // Account captured at admission: a rebind during the turn cannot move
        // this turn's spend, refusal, or successful recovery to another account.
        let account_now = turn.serving_account.clone();
        client
            .execute(
                "UPDATE ot.turns SET ended_at = now(), cost_usd = $2::float8::numeric, toks = $3, input_tokens = $4,
                        cache_read = $5, cache_write = $6, cache_ttl_s = $7, ms = $8, denials = $9, killed = $10,
                        error = $11, model = coalesce($12, model), cost_source = $13
                  WHERE id = $1",
                &[
                    &turn.id, &cost, &output, &input, &cache_read, &cache_write, &(!muse && !turn.acp).then_some(ttl), &ms, &(denials.len() as i32),
                    &turn.killed, &error, &turn.model, &(if (turn.acp && !langserver) || (agy && catalog::antigravity_claude(&turn.serving_tier)) || muse { "unknown" }
                        else if langserver { "local" } else if codex || agy || openrouter { "priced" } else { "cli" }),
                ],
            )
            .await?;
        let tier_now = self.tier_of(&client).await;
        // a language server's model has the window its server gives it (App
        // settings › Providers), which the user can change: always the latest
        let window = catalog::tier(&tier_now).and_then(|t| t.context).map(|c| c as i32).or_else(|| {
            langserver
                .then(|| crate::langserver::route_of(&self.engine, &tier_now))
                .flatten()
                .map(|(_, m)| crate::langserver::context_of(&m) as i32)
        });
        let measured = occupancy > 0 && !turn.compact;
        client
            .execute(
                "UPDATE ot.agents SET cost_usd = cost_usd + $2::float8::numeric,
                        cost_unknown = cost_unknown OR $12,
                        occupancy = CASE WHEN $3 THEN $4 ELSE occupancy END,
                        occupancy_est = CASE WHEN $3 THEN false WHEN $9 THEN true ELSE occupancy_est END,
                        compacted_unrun = CASE WHEN $9 THEN true WHEN $3 THEN false ELSE compacted_unrun END,
                        context_window = CASE WHEN $13 AND $5::int IS NOT NULL THEN $5 ELSE coalesce(context_window, $5) END,
                        session_id = coalesce($6, session_id), inflight_at = NULL, last_denials = $7,
                        last_error = $8,
                        frozen = coalesce($10, frozen),
                        extra = jsonb_set(extra, '{cost_seen}', to_jsonb($11::float8)),
                        row_version = row_version + 1
                  WHERE id = $1",
                &[
                    &self.id, &cost, &measured, &occupancy, &window, &session, &json!(denials), &error, &turn.compact,
                    &freeze_rec, &self.cost_seen,
                    &(turn.acp && !langserver || (agy && catalog::antigravity_claude(&turn.serving_tier) || muse) && input + cache_read + output > 0),
                    &langserver,
                ],
            )
            .await?;
        if let Some(acc) = &account_now {
            if cost > 0.0 {
                let _ = client
                    .execute(
                        "INSERT INTO ot.account_spend (account, usd_total, turns) VALUES ($1, $2::float8::numeric, 1)
                         ON CONFLICT (account) DO UPDATE SET usd_total = ot.account_spend.usd_total + EXCLUDED.usd_total,
                                turns = ot.account_spend.turns + 1, updated_at = now()",
                        &[acc, &cost],
                    )
                    .await;
            }
            if let Some(until) = limit {
                let win = self.rate_limit.as_ref().and_then(|r| r["rateLimitType"].as_str().map(str::to_string));
                let pool = if agy {
                    format!("agy:{}", catalog::antigravity_pool(&turn.serving_tier))
                } else if muse {
                    catalog::muse_pool(&turn.serving_tier)
                } else { "default".to_string() };
                let _ = client
                    .execute(
                        "INSERT INTO ot.account_marks (account, pool, until, provenance, win) VALUES ($1, $4, $2, 'observed', $3)
                         ON CONFLICT (account, pool) DO UPDATE SET until = EXCLUDED.until, win = EXCLUDED.win, at = now()",
                        &[acc, &until, &win, &pool],
                    )
                    .await;
            }
        }
        if turn.session_ended {
            let row = json!({ "role": "system", "text": SESSION_ENDED_ROW, "ts": now_iso(), "kind": "session" });
            let _ = self.convo.append(&client, row).await;
        } else if let Some(e) = &error {
            let ev = crate::events::typed("runtime.turn_failed_terminal", "@system",
                json!({"kind":"session","org":self.org.slug,"node":self.name,"session_id":session.clone().unwrap_or_default()}),
                json!({"door":"turn","err":e}));
            let row = json!({ "role": "system", "text": format!("The turn ended with an error: {e}"), "ts": now_iso(), "kind": "error", "ev":ev });
            let _ = self.convo.append(&client, row).await;
        }
        drop(client);
        if let Some(run) = fresh {
            if let Err(e) = self.fresh_after_full(run).await {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "no fresh session after the context filled");
            }
        }
        if cache_read > 0 || cache_write > 0 {
            self.receipt = Some((Utc::now(), ttl as i64));
            self.save_receipt().await;
        }
        // Some harnesses name a new session only in their result. Complete
        // that initial namespace without replacing an already-recorded one.
        if let Err(error) = self.complete_next_turn_namespace().await {
            tracing::warn!(agent=self.id, %error, "next-turn session evidence could not be completed");
        }
        if !turn.interrupted && !turn.session_ended && !classified {
            // 3.x `hard_fail_run`: a run of terminal failures, a turn the idle
            // or time limit killed included, is told once; only a completed
            // turn makes the next failure news again
            let tell = match (&error, &freeze_rec) {
                (Some(e), None) => recovery::bump(&self.engine, self.id, "hard_fail_run").await
                    .map(|run| run == 1 || prompt::input_length_refusal(e)).unwrap_or(true),
                _ => true,
            };
            if let Err(e) = crate::domain::runtime_notices::end_turn(&self.engine, self.org_id, self.id, error.as_deref(), freeze_rec.as_ref(), tell).await {
                tracing::warn!(agent = self.id, error = %format!("{e:#}"), "typed turn outcome could not be sent");
            }
        }
        if succeeded {
            if let Err(e) = recovery::clear_runs(&self.engine, self.id).await {
                tracing::warn!(agent = self.id, error = %format!("{e:#}"), "failure runs could not be cleared");
            }
        }
        if let Some((run, kind)) = &exhausted {
            recovery::retry_exhausted(&self.engine, self.org_id, self.id, *run, error.as_deref().unwrap_or(""), kind).await;
        }
        if let Some(kind) = parked {
            recovery::parked(&self.engine, self.org_id, self.id, kind, error.as_deref().unwrap_or("")).await;
        }
        self.apply_pending_config().await?;
        if (error.is_some() && !turn.session_ended) || limit.is_some() {
            crate::runtime::watchdogs::events::emit(&self.engine,crate::runtime::watchdogs::events::event(
                if limit.is_some(){"turn.limited"}else{"turn.failed"},
                crate::runtime::watchdogs::events::Scope::Agent(self.org_id,self.id),json!({"agent_id":self.id})));
        }
        self.last_error = if turn.session_ended { None } else { error.clone() };
        self.mcp.last_turn_count = self.mcp.count;
        self.slot = None;
        self.activity = None;
        self.idle_since = Instant::now();
        if succeeded {
            if let Some(account) = turn.serving_account.as_deref() {
                crate::account_marks::success(&self.engine, account, &turn.serving_provider, &turn.serving_tier, turn.admitted_at).await;
            }
        }
        if limit.is_some() {
            // the account changes or the agent sleeps: either way this process is done
            self.close_proc().await;
            let _ = self.engine.accounts.reload(&self.engine).await;
            crate::accounts::publish(&self.engine);
        } else if self.reconfigured {
            self.replace_idle_process().await;
        } else if self.engine.settings.keep_warm() && self.proc.is_some() {
            self.park();
        } else if self.proc.is_some() && self.bg_pending() {
            // warming off: background work keeps the process open until it is over
            self.hold();
        } else {
            self.close_proc().await;
        }
        self.update_forecast().await;
        self.publish();
        let mut ch = vec![
            Change::Mailbox(self.id),
            Change::History(self.id),
            Change::Credits,
            Change::Pulse { node: self.name.clone(), event: "turn_done", extra: None },
        ];
        if freeze_rec.is_some() {
            ch.push(Change::Pulse { node: self.name.clone(), event: "frozen", extra: None });
        }
        if cache_read > 0 || cache_write > 0 {
            // the record's stored forecast follows the new receipt
            ch.push(Change::Agent(self.id));
        }
        self.changed(ch);
        if let Some(rec) = &freeze_rec {
            freeze::schedule(&self.engine, self.org_id, self.id, &self.name, rec);
            if let Some((tier, account, org_slug)) = fall_back {
                let engine = self.engine.clone();
                let (org_id, id) = (self.org_id, self.id);
                // continue_on messages this actor; run it off the actor's own loop
                let span = crate::trace::request_from(&self.client, crate::trace::current_rq().as_deref());
                tokio::spawn(tracing::Instrument::instrument(async move {
                    freeze::fall_back(&engine, org_id, id, &tier, account.as_deref(), &org_slug).await;
                }, span));
            }
            return Ok(());
        }
        if error.is_none() || (!self.followup_mail.is_empty() && !error.as_deref().is_some_and(prompt::input_length_refusal)) {
            // All lanes share normal halt/freeze/killswitch and slot admission.
            // Confirmed boundary mail is no longer pending, so is not replayed.
            self.on_wake().await?;
        }
        Ok(())
    }

    async fn apply_pending_config(&mut self) -> Result<()> {
        use crate::domain::ops::{apply_pending, Boundary};
        let mut found = apply_pending(&self.engine, &self.org, self.id).await?;
        // a turn on record while this actor runs none is stale: close it,
        // then the queue applies (decision 62)
        if found == Boundary::Busy && self.turn.is_none() && self.close_stale_turns().await? {
            found = apply_pending(&self.engine, &self.org, self.id).await?;
        }
        if found == Boundary::Applied {
            self.reconfigured = self.proc.is_some();
        }
        Ok(())
    }

    /// This actor runs no turn, yet one is on record: a turn cut without
    /// settling (a retire before decision 62, a lost actor, a failed write).
    /// Close it as a restart would, so `busy` stops holding the queue back.
    /// True when anything was closed.
    async fn close_stale_turns(&mut self) -> Result<bool> {
        let client = self.engine.db.get().await?;
        let open: Vec<i64> = client
            .query("SELECT id FROM ot.turns WHERE agent_id = $1 AND ended_at IS NULL ORDER BY id LIMIT 16", &[&self.id])
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect();
        crate::domain::mail::recover_turns(&self.engine, &client, &open).await?;
        let ended = client
            .execute(
                "UPDATE ot.turns SET ended_at = now(), killed = true,
                        error = coalesce(error, 'no running turn owned this record; its agent closed it')
                  WHERE id = ANY($1) AND ended_at IS NULL",
                &[&open],
            )
            .await?;
        let inflight = client
            .execute(
                "UPDATE ot.agents SET inflight_at = NULL, row_version = row_version + 1 WHERE id = $1 AND inflight_at IS NOT NULL",
                &[&self.id],
            )
            .await?;
        drop(client);
        if !open.is_empty() || inflight > 0 {
            tracing::warn!(agent = %self.name, turns = ?open, ended, inflight = inflight > 0, "a turn on record that no running turn owns: closing it");
            self.changed(vec![Change::Mailbox(self.id), Change::Agent(self.id)]);
        }
        Ok(ended > 0 || inflight > 0)
    }

    /// A turn cut because its seat stopped while the engine runs on (retire,
    /// dissolve, delete): its mail is settled as a restart would settle it
    /// and the record is closed as killed (decision 62).
    async fn settle_cut_turn(&self, turn: i64) {
        let Ok(client) = self.engine.db.get().await else { return };
        if let Err(e) = crate::domain::mail::recover_turns(&self.engine, &client, &[turn]).await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "a cut turn's mail could not be settled");
        }
        let _ = client
            .execute(
                "UPDATE ot.turns SET ended_at = now(), killed = true,
                        error = coalesce(error, 'the turn was cut: its agent was retired or deleted')
                  WHERE id = $1 AND ended_at IS NULL",
                &[&turn],
            )
            .await;
        let _ = client
            .execute(
                "UPDATE ot.agents SET inflight_at = NULL, row_version = row_version + 1 WHERE id = $1 AND inflight_at IS NOT NULL",
                &[&self.id],
            )
            .await;
        drop(client);
        self.changed(vec![Change::Mailbox(self.id)]);
    }

    /// Admission was refused for a configuration change: try again after
    /// ADMIT_RETRY_FIRST, doubling to ADMIT_RETRY_MAX while refusals repeat.
    fn retry_admission(&mut self) {
        let delay = ADMIT_RETRY_FIRST.saturating_mul(1 << self.admit_refusals.min(8)).min(ADMIT_RETRY_MAX);
        self.admit_refusals = self.admit_refusals.saturating_add(1);
        self.admit_retry = Some(Instant::now() + delay);
        if self.admit_refusals > 2 {
            tracing::warn!(agent = %self.name, refusals = self.admit_refusals, retry_ms = delay.as_millis() as u64,
                "admission keeps being refused for a configuration change; retrying on a backoff");
        }
    }

    async fn tier_of(&self, client: &tokio_postgres::Client) -> String {
        client
            .query_one("SELECT tier FROM ot.agents WHERE id = $1", &[&self.id])
            .await
            .map(|r| r.get(0))
            .unwrap_or_default()
    }

    async fn halt(&mut self) -> Result<Value> {
        let at = now_iso();
        self.cancel_warm();
        if self.waiting_since.take().is_some() {
            self.engine.sched.cancel(self.id);
        }
        if let Some(t) = self.turn.as_mut() {
            t.interrupted = true;
            t.killed = true;
        }
        self.kill_proc().await;
        if let Some(t) = self.take_turn() {
            self.return_mail(t.id, !t.activity).await;
            if let Ok(client) = self.engine.db.get().await {
                let _ = client.execute("UPDATE ot.turns SET ended_at = now(), killed = true WHERE id = $1", &[&t.id]).await;
            }
            self.slot = None;
        }
        let client = self.engine.db.get().await?;
        client
            .execute(
                "UPDATE ot.agents SET halt = $2, inflight_at = NULL, row_version = row_version + 1 WHERE id = $1",
                &[&self.id, &json!({ "phase": "halted", "requested_at": at, "at": at, "by": "@user" })],
            )
            .await?;
        drop(client);
        self.activity = None;
        self.publish();
        self.changed(vec![
            Change::Mailbox(self.id),
            Change::Pulse { node: self.name.clone(), event: "turn_done", extra: None },
        ]);
        crate::runtime::watchdogs::events::emit(&self.engine,crate::runtime::watchdogs::events::event("agent.halted",crate::runtime::watchdogs::events::Scope::Agent(self.org_id,self.id),json!({"agent_id":self.id})));
        Ok(json!({ "halted": true, "settled": true, "status": "halted" }))
    }

    /// A slash command as its own turn (`/compact` compacts the session).
    async fn command(&mut self, text: &str) -> Result<Value> {
        let result = self.command_inner(text).await?;
        if result["started"].as_bool().unwrap_or(false) {
            // All admitted user commands, including compact on any supported harness.
            // Provider admission cannot join the DB transaction; the grant and notices do.
            if let Err(e) = crate::domain::runtime_notices::deep_reach(&self.engine,self.org_id,self.id,text,true).await {
                tracing::warn!(agent=self.id,error=%format!("{e:#}"),"command audience and notice could not be stored");
            }
        }
        Ok(result)
    }

    async fn command_inner(&mut self, text: &str) -> Result<Value> {
        let admitted_at = Utc::now();
        if self.turn.is_some() {
            return Ok(json!({ "started": false, "reason": "a turn is running; wait for it or interrupt it" }));
        }
        let compact = text.trim() == "/compact" || text.trim().starts_with("/compact ");
        let ctx = self.load_ctx().await?;
        if ctx.provider == catalog::MUSE {
            return self.muse_command(&ctx, compact).await;
        }
        let claude_code = ctx.provider == catalog::CLAUDE
            || ((ctx.provider == catalog::OPENROUTER || ctx.provider == catalog::LANGSERVER)
                && ctx.harness.as_deref() != Some("codex-cli"));
        if !claude_code {
            return Ok(json!({ "started": false,
                              "reason": "slash commands are Claude Code's; compact this agent with cheap compact instead" }));
        }
        if ctx.state != "live" || ctx.halted || ctx.killswitch {
            return Ok(json!({ "started": false, "reason": "this agent is not running (retired, halted or stopped)" }));
        }
        if compact && ctx.session_id.is_none() {
            return Ok(json!({ "started": false, "reason": "this agent has no conversation to compact yet" }));
        }
        self.ensure_proc(&ctx).await?;
        let sent = match self.proc.as_ref() {
            Some(Proc::Claude(p)) => p.send_user(text, Vec::new()),
            _ => false,
        };
        if !sent {
            return Ok(json!({ "started": false, "reason": "the process could not be reached" }));
        }
        let client = self.engine.db.get().await?;
        let turn_id: i64 = client
            .query_one(
                "INSERT INTO ot.turns (agent_id, started_at, sent_at, account, model) VALUES ($1, now(), now(), $2, $3) RETURNING id",
                &[&self.id, &ctx.account, &ctx.model],
            )
            .await?
            .get(0);
        drop(client);
        let mut turn = Turn::new(turn_id, compact);
        turn.admitted_at = admitted_at;
        turn.serving_account = self.serving_account_of(&ctx);
        turn.serving_provider = ctx.provider.clone();
        turn.activity = true;
        turn.serving_tier = ctx.tier.clone();
        self.begin_turn(turn);
        self.activity = Some((if compact { "compacting" } else { "thinking" }.into(), None));
        if !compact {
            let client = self.engine.db.get().await?;
            let row = json!({ "role": "user", "text": text, "ts": now_iso(), "command": true });
            self.convo.append(&client, row).await?;
        }
        self.publish();
        self.stream("text", json!({}));
        Ok(json!({ "started": true }))
    }

    /// A Muse agent's command: only `/compact`, which Muse runs on the session
    /// itself (`session/compact`, admission only; the compaction item reports
    /// its end). Other slash commands are Claude Code's.
    async fn muse_command(&mut self, ctx: &Ctx, compact: bool) -> Result<Value> {
        if !compact {
            return Ok(json!({ "started": false, "reason": "a Muse agent takes /compact only; other slash commands are Claude Code's" }));
        }
        if ctx.state != "live" || ctx.halted || ctx.killswitch {
            return Ok(json!({ "started": false, "reason": "this agent is not running (retired, halted or stopped)" }));
        }
        if ctx.session_id.is_none() {
            return Ok(json!({ "started": false, "reason": "this agent has no conversation to compact yet" }));
        }
        self.ensure_proc(ctx).await?;
        let admitted = match self.proc.as_ref() {
            Some(Proc::Muse(p)) => p.compact().await,
            _ => return Ok(json!({ "started": false, "reason": "the process could not be reached" })),
        };
        match admitted {
            Ok(_) => {
                self.park();
                self.publish();
                Ok(json!({ "started": true }))
            }
            Err(e) => Ok(json!({ "started": false, "reason": format!("Muse refused the compaction: {e:#}") })),
        }
    }

    // ------------------------------------------------------------ publish

    #[nolog]
    fn live_view(&self) -> LiveView {
        let mut transient = Vec::new();
        if let Some(t) = &self.turn {
            transient.extend(t.tool_writing.active(t.id));
            if !t.draft.is_empty() {
                transient.push(json!({ "event_id": format!("draft-{}", t.id), "role": "assistant", "kind": "draft", "text": t.draft, "stream_order": t.draft_order }));
            }
            if !t.thinking.is_empty() {
                transient.push(json!({ "event_id": format!("think-{}", t.id), "role": "assistant", "kind": "thinking", "text": t.thinking, "stream_order": t.thinking_order }));
            }
        }
        transient.sort_by_key(|row| row["stream_order"].as_u64().unwrap_or(0));
        LiveView {
            busy: self.turn.is_some(),
            turn_started_at: self.turn.as_ref().map(|t| iso(t.admitted_at)),
            turn_activity: self.turn.as_ref().map(|t| t.activity).unwrap_or(false),
            draft_epoch: format!("{}:{}", self.born, self.text_frames),
            init: self.init.clone(),
            last_error: self.last_error.clone(),
            transient,
            mcp_waiting: self.mcp.waiting,
            mcp_state: self.mcp.state.clone(),
            mcp_reason: self.mcp.reason.clone(),
        }
    }

    #[nolog]
    fn runtime_value(&self) -> Value {
        let busy = self.turn.is_some();
        let compacting = self.turn.as_ref().map(|t| t.compact).unwrap_or(false);
        let (phase, tool) = match (&self.activity, busy) {
            (Some((p, t)), true) => (p.clone(), t.clone()),
            (_, true) => ("thinking".to_string(), None),
            _ => ("idle".to_string(), None),
        };
        let mut activity = json!({ "phase": phase });
        if let Some(t) = tool {
            activity["tool"] = json!(t);
        }
        let queued_for_slot = self.waiting_since.filter(|_|
            self.engine.sched.held.load(std::sync::atomic::Ordering::SeqCst)
                >= self.engine.sched.limit.load(std::sync::atomic::Ordering::SeqCst)
        ).map(|since| {
            json!({ "since": since.timestamp(),
                    "limit": self.engine.sched.limit.load(std::sync::atomic::Ordering::SeqCst),
                    "waiting": self.engine.sched.waiting.load(std::sync::atomic::Ordering::SeqCst) })
        });
        let live = self.proc.is_some();
        json!({
            "busy": busy,
            // the running turn's admission: a tool call that started before it
            // belongs to an earlier turn and is never timed live again
            "turn_started_at": self.turn.as_ref().map(|t| iso(t.admitted_at)),
            "effort_current": if busy { self.proc_effort.clone() } else { None },
            "pending_effort": if busy { self.pending_effort.clone() } else { None },
            "waiting": self.waiting_since.is_some(),
            "loading_model": self.loading,
            "queued_for_slot": queued_for_slot,
            "responding": busy,
            "phase": if compacting { json!("compacting") } else if busy { json!("responding") } else { Value::Null },
            "ran_as": Value::Null,
            "codex_route": Value::Null,
            "queued": 0,
            "proc_warm": live && !busy,
            "cache_keepalive": self.keepalive.is_some(),
            "proc_live": live,
            // kept open only for its background work (outside the idle cap)
            "proc_held": self.held,
            "proc_relaunch": self.reconfigured && live,
            "proc_relaunch_reason": if self.reconfigured && live { json!("settings changed; the next turn starts a fresh process") } else { Value::Null },
            "proc_paused": false,
            "proc_control_enabled": !busy,
            "proc_control_action": if live { "stop" } else { "start" },
            "proc_control_reason": if busy { json!("a turn is running") } else { Value::Null },
            "mcp_tool_count": self.mcp.count,
            "last_turn_mcp_tool_count": self.mcp.last_turn_count,
            "mcp_tool_count_provider": self.provider,
            "mcp_tool_count_source": if self.mcp.count.is_some() { json!("init") } else { Value::Null },
            "mcp_tool_count_reason": Value::Null,
            "mcp_readiness_waiting": self.mcp.waiting,
            "mcp_readiness_state": self.mcp.state,
            "mcp_readiness_reason": self.mcp.reason,
            "tasks": self.tasks.counts().0,
            "bg_tasks": self.tasks.counts().1 + self.muse_bg.len(),
            "last_error": self.last_error,
            "activity": activity,
            "cache_forecast": self.forecast,
        })
    }

    #[nolog]
    fn publish(&self) {
        let v = self.runtime_value();
        let old=self.handle.view.swap(Arc::new(v.clone()));
        crate::runtime::watchdogs::events::runtime(&self.engine,self.org_id,self.id,&old,&v);
        self.org.feed.runtime(self.id, v);
    }

    #[nolog]
    fn publish_idle(&self) {
        let mut v = Map::new();
        for (k, val) in crate::domain::tree::idle_runtime() {
            v.insert(k, val);
        }
        // a null would hide the forecast the agent's record computes
        v.remove("cache_forecast");
        if !self.forecast.is_null() {
            v.insert("cache_forecast".into(), self.forecast.clone());
        }
        v.insert("last_error".into(), json!(self.last_error));
        let v = Value::Object(v);
        let old=self.handle.view.swap(Arc::new(v.clone()));
        crate::runtime::watchdogs::events::runtime(&self.engine,self.org_id,self.id,&old,&v);
        self.org.feed.runtime(self.id, v);
    }

    /// Keep the cache receipt and the prompt fingerprint it was observed
    /// with: an idle agent's card and a restarted engine forecast from them.
    async fn save_receipt(&self) {
        let Some((at, ttl)) = self.receipt else { return };
        let rec = json!({ "at": iso(at), "ttl": ttl, "print": self.sent_print.as_ref().map(|p| p.to_json()) });
        if let Ok(client) = self.engine.db.get().await {
            let _ = client
                .execute("UPDATE ot.agents SET extra = jsonb_set(extra, '{cache_receipt}', $2) WHERE id = $1", &[&self.id, &rec])
                .await;
        }
    }

    /// Refresh next-turn presentation from current settings. This also covers
    /// agent retool and org-default edits, which arrive as Reconfigured.
    async fn update_forecast(&mut self) {
        self.forecast = match self.load_ctx().await {
            Ok(ctx) => {
                self.session_pref = ctx.session_pref.clone();
                self.pending_effort = self.proc_effort.as_ref()
                    .filter(|current| self.turn.is_some() && *current != &ctx.effort)
                    .map(|_| ctx.effort.clone());
                let inputs = self.startup_inputs(&ctx);
                let folders = skill_folders(&ctx);
                let skills = crate::providers::skills::for_agent(&self.engine.providers.skills_registry(), &folders);
                let digest = shared_startup_digest(&startup::digest(&inputs), &skills);
                self.startup_seen = Some((inputs, folders, digest));
                self.forecast_for(&ctx)
            },
            Err(_) => Value::Null,
        };
    }

    fn forecast_for(&self, ctx: &Ctx) -> Value {
        self.forecast_for_print(ctx, None)
    }

    /// Record the delivered prefix independently of positive cache receipts.
    /// No text/auth is stored, and a query never writes this baseline.
    #[nolog]
    async fn save_next_turn_baseline(&self) -> Result<()> {
        let Some(print) = &self.proc_print else { return Ok(()) };
        let client = self.engine.db.get().await?;
        client.execute(
            "UPDATE ot.agents SET extra = jsonb_set(coalesce(extra,'{}'::jsonb), '{next_turn_baseline}',
                jsonb_build_object('print',$2::jsonb,'provider',provider,'session',session_id,
                    'generation',generation,'harness',extra->>'harness')) WHERE id=$1",
            &[&self.id, &print.to_json()],
        ).await?;
        Ok(())
    }

    #[nolog]
    async fn complete_next_turn_namespace(&self) -> Result<()> {
        let client = self.engine.db.get().await?;
        client.execute(
            "UPDATE ot.agents SET extra=jsonb_set(extra,'{next_turn_baseline,session}',to_jsonb(session_id))
             WHERE id=$1 AND session_id IS NOT NULL
               AND extra->'next_turn_baseline'->'session'='null'::jsonb
               AND extra->'next_turn_baseline'->>'generation'=generation::text
               AND extra->'next_turn_baseline'->>'provider'=provider", &[&self.id],
        ).await?;
        Ok(())
    }

    /// One point-in-time read of this actor's current prefix and policy. No
    /// pending intent is consumed and no provider/process/session is touched.
    #[nolog]
    async fn next_turn(&self) -> Result<Value> {
        let mut ctx = self.load_ctx().await?;
        let (baseline, pending_switch, pending_account): (Value, Option<Value>, Option<Value>) = {
            let client = self.engine.db.get().await?;
            let row = client.query_one(
                "SELECT coalesce(extra->'next_turn_baseline','null'::jsonb), pending_switch, pending_account
                 FROM ot.agents WHERE id=$1 AND org_id=$2", &[&self.id, &self.org_id],
            ).await?;
            (row.get(0), row.get(1), row.get(2))
        };
        let current = self.plan(&ctx).print;
        let saved = Fingerprint::from_json(&baseline["print"]);
        // Legacy aggregate fingerprints can establish a known change, but
        // never fabricate which historical instruction file changed.
        let previous = saved.as_ref().or(self.sent_print.as_ref());
        let files = current.instructions.as_ref().map(|m| m.compare(saved.as_ref().and_then(|p| p.instructions.as_ref()))).unwrap_or_default();
        let mut reasons = previous.map(|p| current.changed(p)).unwrap_or_default();
        let queued_switch = pending_switch.as_ref().is_some_and(|p| p["tier"].as_str().is_some_and(|t| t != ctx.tier));
        let queued_account = pending_account.as_ref().is_some_and(|p| p.get("account").is_some()
            && p["account"].as_str().filter(|a| *a != "primary" && !a.is_empty()) != ctx.account.as_deref());
        let starts = self.proc.is_none() || self.reconfigured || !reasons.is_empty() || queued_switch || queued_account
            || ctx.harness_stamp != ctx.harness_want;
        if starts && previous.is_some_and(|p| p.org_notes.is_some() && p.org_notes != current.org_notes) {
            reasons.push("org_notes".into());
        }
        let instruction_change = files.iter().any(|f| matches!(f["status"].as_str(), Some("changed" | "added" | "removed")));
        if starts && instruction_change { reasons.push("instruction_files".into()); }
        if queued_switch {
            reasons.push("pending_model_or_provider_switch".into());
        }
        if queued_account {
            reasons.push("pending_account_switch".into());
        }
        if ctx.harness_stamp != ctx.harness_want { reasons.push("pending_harness_switch".into()); }
        if !baseline.is_null() {
            if baseline["provider"].as_str() != ctx.session_provider.as_deref() { reasons.push("provider_namespace".into()); }
            if baseline["harness"].as_str() != ctx.harness_stamp.as_deref() { reasons.push("harness_namespace".into()); }
            if baseline["generation"].as_i64() != Some(i64::from(ctx.generation)) { reasons.push("session_generation".into()); }
            if baseline["session"].as_str().is_some() && baseline["session"].as_str() != ctx.session_id.as_deref() {
                reasons.push("session_namespace".into());
            }
        }
        reasons.sort(); reasons.dedup();
        let file_unknown = saved.as_ref().and_then(|p| p.instructions.as_ref()).is_none()
            || files.iter().any(|f| f["status"] == "unknown");
        let unknown = file_unknown || baseline["session"].as_str().is_none();
        let dirty = if !reasons.is_empty() { Some(true) } else if unknown { None } else { Some(false) };

        let codex = ctx.provider == catalog::OPENAI || ctx.harness.as_deref() == Some("codex-cli");
        if ctx.context_window.is_none() && ctx.provider == catalog::OPENROUTER {
            ctx.context_window = crate::openrouter::favorite(&self.engine, &ctx.tier)
                .and_then(|f| f["context"].as_i64()).and_then(|w| i32::try_from(w).ok());
        }
        let live = self.turn.as_ref().filter(|t| !t.compact).and_then(|t|
            super::next_turn::live_context(&t.usage, &t.serving_provider, codex, t.acp));
        if let Some((used, window)) = live {
            ctx.occupancy = i32::try_from(used).ok();
            ctx.context_window = window.and_then(|w| i32::try_from(w).ok()).or(ctx.context_window);
            ctx.context_measured = true;
        }
        let forecast = self.forecast_for_print(&ctx, Some(&current));
        let cheap = forecast["precompact_action"] == "will_compact";
        let crossing = pending_switch.as_ref().is_some_and(|p| p["crossing"] == true)
            || ctx.harness_stamp != ctx.harness_want
            || ctx.session_provider.as_deref().is_some_and(|p| p != ctx.provider)
            || ctx.session_id.is_none() && ctx.handoff_due.is_some();
        let native_supported = ctx.provider == catalog::CLAUDE || ctx.provider == catalog::OPENAI
            || ctx.provider == catalog::OPENROUTER && ctx.harness.as_deref() != Some("opencode");
        // Running processes retain the threshold they actually started with.
        let native_frac = if starts { Some(ctx.compact_at) } else { previous.and_then(|p| p.compact_at) };
        let ratio = ctx.occupancy.zip(ctx.context_window).filter(|(_, w)| *w > 0).map(|(n,w)| f64::from(n)/f64::from(w));
        let native_due = native_supported && ctx.context_measured && ratio.zip(native_frac).is_some_and(|(r,f)| r >= f);
        let compacting = self.compact_open.is_some() || self.turn.as_ref().is_some_and(|t| t.compact);
        let (will, kind, reason) = if compacting {
            (None, "in_progress", "a compaction is already running; the next boundary is not yet known")
        } else if crossing {
            (Some(true), "fresh_session", "a provider/harness crossing or recorded session reset requires a fresh session")
        } else if cheap {
            (Some(true), "cheap_compact", "the current admission policy selects a cheap compact")
        } else if native_due {
            (None, "harness", "observed context is at the configured threshold; the harness decides when to compact")
        } else if !native_supported {
            (None, "unknown", "this harness does not expose a predictable compaction boundary")
        } else if self.turn.is_some() || unknown || !ctx.context_measured || native_frac.is_none() {
            (None, "unknown", "current evidence cannot predict the final context or next admission")
        } else {
            (Some(false), "none", "no compaction is selected by the current evidence; later changes can alter this")
        };
        Ok(json!({
            "node":ctx.name,
            "cache": {"dirty":dirty,"reasons":reasons,"guaranteed_hit":false,
                "instruction_files":files,"instruction_baseline":if file_unknown {"unknown_or_incomplete"} else {"recorded"},
                "namespace_baseline":if baseline["session"].as_str().is_some() {"recorded"} else {"unknown"},
                "instruction_changes_at_next_session_start":instruction_change,
                "next_turn_starts_process":starts,
                "note":"Prefix and namespace compatibility only; dynamic turn envelopes and effort-only edits do not invalidate an unchanged prefix."},
            "compaction":{"will_compact":will,"kind":kind,"reason":reason,
                "occupancy":ctx.occupancy,"context_window":ctx.context_window,"measured":ctx.context_measured,
                "occupancy_source":if live.is_some() {"current_turn"} else {"last_completed_turn"},
                "cheap_compact_threshold":ctx.cold_reset,
                "harness_threshold":if native_supported {native_frac} else {None},
                "in_progress":compacting,
                "turn_running":self.turn.is_some(),"note":"A point-in-time forecast; the rest of this turn and later configuration can change it."}
        }))
    }

    fn forecast_for_print(&self, ctx: &Ctx, supplied: Option<&Fingerprint>) -> Value {
        let lane = match ctx.provider.as_str() {
            _ if ctx.harness.as_deref()==Some("opencode") => "opencode-acp",
            p if p == catalog::OPENAI => "codex",
            p if (p == catalog::OPENROUTER || p == catalog::LANGSERVER) && ctx.harness.as_deref() == Some("codex-cli") => "codex",
            p if p == catalog::GOOGLE => "antigravity",
            p if p == catalog::MUSE => "muse",
            _ => "claude",
        };
        let action = crate::domain::tree::cold_turn_action(
            ctx.cold_reset, ctx.occupancy.map(i64::from), ctx.context_window.map(i64::from),
            ctx.context_measured,
            ctx.state == "live" && !ctx.halted && !ctx.frozen && !ctx.killswitch && !ctx.limit_locked,
            ctx.session_id.is_some(),
        );
        let generation = format!("{}", ctx.generation);
        let receipt_at = self.receipt.map(|(t, _)| iso(t));
        let Some(sent) = &self.sent_print else {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "unknown",
                           "readiness_cause": "no_completed_fingerprint", "reason": "no turn has completed since the engine started",
                           "source": "no_completed_fingerprint", "lane": lane, "last_receipt_at": receipt_at,
                           "ttl_seconds": null, "expires_at": null });
        };
        let planned;
        let now_print = match supplied {
            Some(print) => print,
            None => { planned = self.plan(ctx).print; &planned },
        };
        let mut changed = now_print.changed(sent);
        // the org's shared notes reach only a CLI that starts: a warm one
        // serving the next turn keeps its copy
        let starts = self.proc.is_none() || self.reconfigured || !changed.is_empty();
        if starts && now_print.org_notes.is_some() && sent.org_notes.is_some() && now_print.org_notes != sent.org_notes {
            changed.push(ORG_NOTES_PART.to_string());
        }
        if !changed.is_empty() {
            return json!({ "generation": generation, "state": "known_incompatible", "readiness": "not_ready",
                           "readiness_cause": "prefix_changed", "reason": "the prompt prefix changed since the last turn",
                           "source": "authoritative_receipt", "lane": lane, "changed_inputs": changed,
                           "last_receipt_at": receipt_at, "ttl_seconds": null, "expires_at": null,
                           "precompact_action": action });
        }
        // a language server keeps its own prompt cache in its memory and says
        // nothing about it: no expiry to count down, nothing to reset for
        if ctx.provider == catalog::LANGSERVER {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "unknown",
                           "readiness_cause": "unsupported_capability", "reason": "a language server publishes no cache data",
                           "source": "unsupported_capability", "lane": lane, "last_receipt_at": receipt_at,
                           "ttl_seconds": null, "expires_at": null });
        }
        if ctx.harness.as_deref()==Some("opencode") {
            return json!({"generation":generation,"state":"uncertain","readiness":"unknown",
                "readiness_cause":"unsupported_capability","reason":"ACP custom providers do not report a verified cache lifetime",
                "source":"unsupported_capability","lane":lane,"last_receipt_at":receipt_at,"ttl_seconds":null,"expires_at":null});
        }
        let Some((at, ttl)) = self.receipt else {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "not_ready",
                           "readiness_cause": "no_positive_receipt", "reason": "the last turn reported no cache use",
                           "source": "no_positive_receipt", "lane": lane, "last_receipt_at": null,
                           "ttl_seconds": null, "expires_at": null });
        };
        // Muse reports cache reads but no cache lifetime: an observed entry
        // with an unknown expiry, never a countdown made up here
        if ctx.provider == catalog::MUSE {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "unknown",
                           "readiness_cause": "unsupported_capability",
                           "reason": "Muse reported cache reads but publishes no cache lifetime",
                           "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at),
                           "ttl_seconds": null, "expires_at": null });
        }
        let expires = at + chrono::Duration::seconds(ttl);
        if Utc::now() >= expires {
            return json!({ "generation": generation, "state": "expired_known_entry", "readiness": "not_ready",
                           "readiness_cause": "receipt_expired", "reason": "the cache entry has expired",
                           "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at),
                           "ttl_seconds": ttl, "expires_at": iso(expires), "precompact_action": action });
        }
        json!({ "generation": generation, "state": "compatible_observed", "readiness": "ready",
                "readiness_cause": "receipt_valid", "reason": "the cache entry was observed and has not expired",
                "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at), "ttl_seconds": ttl,
                "expires_at": iso(expires), "precompact_action": "not_applicable", "precompact_on_expiry": action })
    }
}

/// A claimed mail row (`to_jsonb(ot.mail)`) as the agent reads it.
#[nolog]
fn mail_of(m: &Value) -> Mail {
    Mail {
        uid: m["uid"].as_str().unwrap_or("").to_string(),
        sender: m["sender"].as_str().unwrap_or("").to_string(),
        kind: m["kind"].as_str().unwrap_or("message").to_string(),
        body: m["body"].as_str().unwrap_or("").to_string(),
        at: m["created_at"].as_str().and_then(crate::util::parse_ts).unwrap_or_else(Utc::now),
        attachments: m.get("attachments").cloned().unwrap_or(json!([])),
        notice: m["notice"].as_bool().unwrap_or(false),
        urgent: m["urgent"].as_bool().unwrap_or(false),
        reply_to: m.get("reply_to").cloned().unwrap_or(Value::Null),
        replies: crate::domain::replies::value(m.get("reply_to"),m.get("replies")),
        ev: m.get("ev").cloned().unwrap_or(Value::Null),
        via_project: m["extra"]["via_project"]["name"].as_str().map(str::to_string),
    }
}

/// The desk row for mail an agent was given: one mail segment.
#[nolog]
fn mail_row(raw: &[Value], receipt: Option<&str>) -> Value {
    let rows: Vec<Value> = raw
        .iter()
        .map(|m| {
            let mut e = crate::feed::compute::mail_entry(m);
            if let Some(o) = e.as_object_mut() {
                o.remove("delivering");
                // Passive delivery is independent of the typed message kind.
                o.insert("notice".into(), json!(m["notice"].as_bool().unwrap_or(false)));
            }
            e
        })
        .collect();
    let text = raw.iter().map(|m| m["body"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n\n");
    let mut row = json!({
        "role": "user",
        "text": text,
        "ts": now_iso(),
        "segments": [{ "kind": "mail", "rows": rows }],
        "mail_ids": raw.iter().map(|m| m["uid"].clone()).collect::<Vec<_>>(),
    });
    if let Some(r) = receipt {
        row["steered"] = json!(true);
        row["receipt"] = json!(r);
    }
    row
}

#[logged]
fn images_for(mails: &[Mail]) -> Vec<Value> {
    use base64::Engine as _;
    let mut out = Vec::new();
    for m in mails {
        for a in m.attachments.as_array().cloned().unwrap_or_default() {
            let Some(path) = a.get("path").and_then(Value::as_str) else { continue };
            let lower = path.to_lowercase();
            let media = if lower.ends_with(".png") {
                "image/png"
            } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                "image/jpeg"
            } else if lower.ends_with(".gif") {
                "image/gif"
            } else if lower.ends_with(".webp") {
                "image/webp"
            } else {
                continue;
            };
            if let Ok(bytes) = std::fs::read(path) {
                if bytes.len() < 5 * 1024 * 1024 {
                    out.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes) } }));
                }
            }
        }
    }
    out
}

/// An Edit/Write chip's diff from the CLI's structured patch.
#[logged]
fn patch_of(v: &Value) -> Option<Value> {
    let patch = v.pointer("/tool_use_result/structuredPatch").and_then(Value::as_array)?;
    let mut plus = 0;
    let mut minus = 0;
    let mut lines = Vec::new();
    let mut truncated = false;
    for h in patch {
        for l in h["lines"].as_array().cloned().unwrap_or_default() {
            let s = l.as_str().unwrap_or("");
            if s.starts_with('+') {
                plus += 1;
            } else if s.starts_with('-') {
                minus += 1;
            }
            if lines.len() < 200 {
                lines.push(json!(s));
            } else {
                truncated = true;
            }
        }
    }
    let mut d = json!({ "plus": plus, "minus": minus, "lines": lines });
    if truncated {
        d["truncated"] = json!(true);
    }
    Some(d)
}

/// The image attachments' paths (Muse sends each one's bytes, `musert::images`).
#[logged]
fn attachment_paths(mails: &[Mail]) -> Vec<String> {
    mails
        .iter()
        .flat_map(|m| m.attachments.as_array().cloned().unwrap_or_default())
        .filter_map(|a| a.get("path").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// Image attachments as Codex input items.
fn codex_images(mails: &[Mail]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in mails {
        for a in m.attachments.as_array().cloned().unwrap_or_default() {
            let Some(path) = a.get("path").and_then(Value::as_str) else { continue };
            let lower = path.to_lowercase();
            if [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|e| lower.ends_with(e)) && std::path::Path::new(path).is_file() {
                out.push(json!({ "type": "localImage", "path": path }));
            }
        }
    }
    out
}

/// A Codex tool item as (chip name, argument object).
#[logged]
fn codex_tool(item: &Value) -> Option<(String, Value)> {
    let args = |v: &Value| v.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| v.clone());
    let s = |k: &str| item[k].as_str().unwrap_or("").to_string();
    Some(match item["type"].as_str()? {
        "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_string(), args(&item["arguments"])),
        "mcpToolCall" => (format!("mcp__{}__{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("tool")), args(&item["arguments"])),
        "commandExecution" => {
            let input: Map<String, Value> = ["command", "cwd", "description", "timeout", "timeout_ms", "yield_time_ms"]
                .iter().filter_map(|k| item.get(*k).map(|v| ((*k).to_string(), v.clone()))).collect();
            ("exec_command".into(), Value::Object(input))
        },
        "fileChange" => {
            let paths: Vec<String> = item["changes"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["path"].as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            ("apply_patch".into(), json!({ "path": paths.join(", "), "changes": item["changes"] }))
        }
        "webSearch" => ("web_search".into(), json!({ "query": s("query"), "action": item["action"] })),
        "imageView" => ("view_image".into(), json!({ "path": s("path") })),
        "collabAgentToolCall" => (item["tool"].as_str().unwrap_or("collaboration").to_string(),
            json!({ "prompt": s("prompt"), "model": item["model"], "reasoningEffort": item["reasoningEffort"],
                "receiverThreadIds": item["receiverThreadIds"] })),
        "subAgentActivity" => ("collaboration".into(), json!({ "agent": s("agentPath"), "action": s("kind") })),
        "sleep" => ("wait".into(), json!({ "duration_ms": item["durationMs"] })),
        "imageGeneration" => ("image_generation".into(), json!({ "prompt": s("revisedPrompt") })),
        _ => return None,
    })
}

/// A completed Codex tool item's result text, and whether it failed.
fn codex_result(item: &Value) -> (String, bool) {
    let status = item["status"].as_str().unwrap_or("").to_lowercase();
    let failed = item["success"] == json!(false)
        || !item["error"].is_null()
        || ["fail", "error", "declin"].iter().any(|x| status.contains(x));
    match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            let mut body = item["aggregatedOutput"].as_str().unwrap_or("").to_string();
            let code = item["exitCode"].as_i64();
            if let Some(c) = code {
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&format!("exit code {c}"));
            }
            (body, failed || code.map(|c| c != 0).unwrap_or(false))
        }
        "dynamicToolCall" => {
            let text = item["contentItems"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            (text, failed)
        }
        "fileChange" => {
            let paths: Vec<String> = item["changes"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["path"].as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            (format!("{}{}", item["status"].as_str().unwrap_or("completed"), if paths.is_empty() { String::new() } else { format!(": {}", paths.join(", ")) }), failed)
        }
        "webSearch" => (
            if item["results"].is_null() { item["query"].as_str().unwrap_or("").to_string() } else { gist(&item["results"].to_string(), 2000) },
            failed,
        ),
        "mcpToolCall" => {
            let r = if !item["result"].is_null() { &item["result"] } else { &item["error"] };
            let text = r["content"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| r.as_str().map(str::to_string).unwrap_or_else(|| gist(&r.to_string(), 2000)));
            (text, failed)
        }
        _ => (item["status"].as_str().unwrap_or("completed").to_string(), failed),
    }
}

/// A Muse item drawn as a chip: (chip name, argument object). A tool call's
/// `args` is the model's JSON verbatim; a kind this engine does not know is
/// drawn by its name and the host's one-line `fallbackText` (MSP: unknown
/// kinds render generically).
#[logged]
fn muse_tool(item: &Value) -> (String, Value) {
    let s = |k: &str| item[k].as_str().unwrap_or("").to_string();
    match item["kind"].as_str().unwrap_or("") {
        "toolCall" => {
            let args = item["args"].as_str().and_then(|a| serde_json::from_str::<Value>(a).ok()).unwrap_or_else(|| json!({}));
            (item["tool"].as_str().unwrap_or("tool").to_string(), args)
        }
        "subagent" => ("subagent".into(), json!({ "role": s("role"), "objective": s("objective"), "subagent": s("subagentId") })),
        "reminderChild" => ("reminder".into(), json!({ "reminder": s("reminderAgentId"), "blocking": item["blocking"] })),
        "workflow" => ("workflow".into(), json!({ "script": s("scriptId"), "phase": s("declaredPhase") })),
        "userShell" => ("shell".into(), json!({ "command": s("commandText") })),
        other => (if other.is_empty() { "item".into() } else { other.to_string() }, json!({ "summary": s("fallbackText") })),
    }
}

/// A settled Muse item's visible result, and whether it failed (MSP: any
/// terminal status but `completed`).
#[logged]
fn muse_result(item: &Value) -> (String, bool) {
    let status = item["status"].as_str().unwrap_or("completed");
    let failed = status != "completed";
    let reason = item["failureReason"].as_str().or(item["failureKind"].as_str());
    let text = match item["kind"].as_str().unwrap_or("") {
        "toolCall" | "userShell" => item["visibleOutput"].as_str().map(str::to_string),
        "subagent" => item.pointer("/result/summary").or(item.pointer("/result/text")).and_then(Value::as_str).map(str::to_string),
        "workflow" => item["finalSummary"].as_str().or(item["message"].as_str()).map(str::to_string),
        _ => None,
    }
    .filter(|t| !t.is_empty())
    .or_else(|| reason.map(str::to_string))
    .or_else(|| item["fallbackText"].as_str().map(str::to_string))
    .unwrap_or_else(|| status.to_string());
    (text, failed)
}

/// A checklist's steps (Codex's plan, Muse's todo list) as the desk's todo
/// items.
#[logged]
fn plan_todos(steps: &[Value]) -> Vec<Value> {
    steps
        .iter()
        .filter_map(|s| {
            let step = s["step"].as_str()?;
            let status = match s["status"].as_str().unwrap_or("pending") {
                "inProgress" => "in_progress",
                "completed" => "completed",
                _ => "pending",
            };
            Some(json!({ "content": step, "status": status, "activeForm": step }))
        })
        .collect()
}

/// The turn's newest call of a tool, a chip of that name or shown as the
/// checklist for it: its row's key and its id. Newest is the latest row, then
/// the latest place in it.
#[nolog] // the turn's rows (bulk)
fn newest_call(rows: &HashMap<String, (i64, Value)>, tools: &HashMap<String, String>, tool: &str) -> Option<(String, String)> {
    let mut newest: Option<((i64, usize), String, String)> = None;
    for (id, key) in tools {
        let Some((seq, row)) = rows.get(key) else { continue };
        let Some(at) = row["tools"].as_array().and_then(|a| a.iter()
            .position(|c| c["id"] == id.as_str() && (c["name"] == tool || c["native_tool"] == tool))) else { continue };
        if newest.as_ref().is_none_or(|(pos, _, _)| (*seq, at) > *pos) {
            newest = Some(((*seq, at), key.clone(), id.clone()));
        }
    }
    newest.map(|(_, key, id)| (key, id))
}

/// The todo list a call wrote, on that call's chip: shown as the checklist
/// chip (`TodoWrite`, the name the transcript and the progress panel read),
/// with the call's own tool name kept in `native_tool`.
#[logged]
fn muse_todo_chip(chip: &mut Value, tool: &str, todos: &[Value]) {
    chip["native_tool"] = json!(tool);
    chip["name"] = json!("TodoWrite");
    chip["arg"] = json!("todos");
    chip["todos"] = json!(todos);
}

/// A settled Muse call's result on its chip: the input it ran with, the
/// output (clipped) and its line count, when it ended, and the error when it
/// failed.
#[nolog] // the call's output (muse_result logs the item)
fn muse_settle_chip(chip: &mut Value, item: &Value, input: &Value, text: &str, failed: bool) {
    let (clipped, truncated) = convo::clip(text, 4000);
    chip["input"] = input.clone();
    chip["result"] = json!(clipped);
    chip["result_lines"] = json!(text.lines().count());
    chip["ended_at"] = json!(now_iso());
    let refs = convo::tool_refs(chip["name"].as_str().unwrap_or(""), input, Some(text));
    chip["refs"] = refs;
    if truncated || item["truncated"] == true {
        chip["truncated"] = json!(true);
    }
    if failed {
        chip["error"] = json!(gist(text, 500));
    }
}

/// What an idle agent is woken with when a command Muse moved to the
/// background has finished: the command and how it ended. Never its output:
/// Muse puts that into the session itself, once.
#[logged]
fn muse_finished_note(bg: &MuseBg, item: &Value) -> String {
    let reason = item["failureReason"].as_str().filter(|r| !r.is_empty());
    let how = match (item["status"].as_str().unwrap_or("completed"), reason) {
        ("completed", _) => "it completed".to_string(),
        ("failed", Some(r)) => format!("it failed: {r}"),
        ("cancelled", Some(r)) => format!("it was cancelled: {r}"),
        ("cancelled", None) => "it was cancelled".to_string(),
        (other, Some(r)) => format!("it ended {other}: {r}"),
        (other, None) => format!("it ended {other}"),
    };
    format!(
        "Your background command has finished ({how}): {} `{}`. Muse has put its output and exit status into your context; \
         this message only wakes you so you can act on them.",
        bg.name,
        gist(&bg.arg, 300)
    )
}

/// What the agent is told when its Muse host ends while commands it moved to
/// the background still run: they ended with the host and no result will
/// arrive.
#[logged]
fn muse_lost_note(lost: &[(String, MuseBg)], reason: &str) -> String {
    let list = lost.iter().take(20).map(|(_, b)| format!("- {} `{}`", b.name, gist(&b.arg, 200))).collect::<Vec<_>>().join("\n");
    let more = if lost.len() > 20 { format!("\n… and {} more", lost.len() - 20) } else { String::new() };
    let (what, them) = if lost.len() == 1 { ("A command you ran in the background".to_string(), "it") } else {
        (format!("{} commands you ran in the background", lost.len()), "them")
    };
    format!(
        "{what} did not finish: the Muse host running {them} stopped ({reason}), and a command Muse runs ends with its host. \
         No result will arrive for:\n{list}{more}\nCheck the real state (files, processes) before relying on {them}, and run \
         {them} again if you still need {them}."
    )
}

/// A Claude background task's end on its chip: what the command printed
/// (clipped), or for any other task the CLI's summary; the line count and the
/// end time; and the summary as the error when it did not complete. A failed
/// shell command keeps its full output for reading on demand.
#[nolog] // the command's output
fn claude_settle_chip(chip: &mut Value, text: &str, more: bool, status: &str, summary: &str) {
    let failed = status != "completed";
    let (clipped, cut) = convo::clip(text, 4000);
    chip["result"] = json!(clipped);
    chip["result_lines"] = json!(text.lines().count());
    chip["ended_at"] = json!(now_iso());
    let refs = convo::tool_refs(chip["name"].as_str().unwrap_or(""), &chip["input"], Some(text));
    chip["refs"] = refs;
    if cut || more {
        chip["truncated"] = json!(true);
    }
    if failed {
        chip["error"] = json!(gist(if summary.is_empty() { status } else { summary }, 500));
    }
    convo::retain_failed_shell_output(chip, text, failed, more);
}

/// What an idle agent is woken with when a background task of its Claude
/// Code CLI has ended: the call (as its chip names it) and how it ended.
/// Never its output: the CLI hands the model its notification (status, exit
/// code, output file) itself, once.
#[logged]
fn claude_finished_note(bg: Option<&ClaudeBg>, v: &Value) -> String {
    let status = v["status"].as_str().unwrap_or("completed");
    let code = tasks::reported_exit_code(v).map(|c| format!(", exit code {c}")).unwrap_or_default();
    let how = match status {
        "completed" => format!("it completed{code}"),
        "failed" => format!("it failed{code}"),
        "stopped" | "killed" | "cancelled" => format!("it was {status}{code}"),
        other => format!("it ended {other}{code}"),
    };
    let (what, label) = match bg {
        Some(b) => (if b.shell { "command" } else { "task" }, format!("{} `{}`", b.name, gist(&b.arg, 300))),
        None => ("task", format!("`{}`", gist(v["summary"].as_str().unwrap_or("a background task"), 300))),
    };
    format!(
        "Your background {what} has finished ({how}): {label}. Claude Code has put its notification (status, exit code and \
         output file) into your context; this message only wakes you so you can act on it."
    )
}

#[cfg(test)]
mod print_tests {
    use super::*;

    #[nolog]
    fn print(prompt: &str, notes: Option<&str>) -> Fingerprint {
        let parts = PRINT_PARTS.iter().map(|k| (*k, if *k == "system_prompt" { prompt.to_string() } else { format!("{k}-1") })).collect();
        Fingerprint { parts, org_notes: notes.map(str::to_string), instructions: None, compact_at: None }
    }

    /// Another agent's edit of the org's shared notes leaves a warm CLI
    /// usable (coordinator ruling (b), 2026-10-13), and the notes' digest
    /// survives an engine restart beside the parts.
    #[test]
    fn org_notes_never_make_a_warm_cli_stale_and_are_kept_across_restarts() {
        let a = print("p", Some("n1"));
        assert_eq!(a, print("p", Some("n2")));
        assert!(a.changed(&print("p", Some("n2"))).is_empty());
        assert_ne!(a, print("q", Some("n1")));
        let back = Fingerprint::from_json(&a.to_json()).unwrap();
        assert_eq!((back.org_notes.as_deref(), &back.parts), (Some("n1"), &a.parts));
        // a fingerprint saved before the notes existed reads, their digest unknown
        let old = json!(a.parts.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>());
        let back = Fingerprint::from_json(&old).unwrap();
        assert_eq!((back.org_notes, back.parts), (None, a.parts));
    }

    #[test]
    fn private_file_and_threshold_metadata_roundtrip_without_changing_launch_equality() {
        let a = print("p", Some("n"));
        let mut b = a.clone();
        let mut files = super::super::next_turn::Instructions::default();
        files.text(std::path::Path::new("not-a-real-file.md"), "own_scratch", "private instruction");
        b.instructions = Some(files);
        b.compact_at = Some(0.7);
        assert_eq!(a, b);
        let saved = b.to_json();
        assert!(!saved.to_string().contains("private instruction"));
        let restored = Fingerprint::from_json(&saved).unwrap();
        assert_eq!(restored.compact_at, Some(0.7));
        let rows = restored.instructions.as_ref().unwrap().compare(b.instructions.as_ref());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["status"], "unchanged");
    }
}

/// Follow one Muse tool call of the running turn: in flight (and whether
/// Muse moved it to the background, which it does by itself to a shell
/// command still running after about 10 s) until its item settles, when its
/// record is returned.
#[nolog] // every tool item event, with the item's output
fn muse_track_tool(tools: &mut HashMap<String, MuseTool>, id: &str, item: &Value, done: bool) -> Option<MuseTool> {
    if done {
        return tools.remove(id);
    }
    let background = item["background"].as_bool() == Some(true)
        || item.pointer("/backgroundStatus/state").and_then(Value::as_str) == Some("backgrounded");
    let call = tools.entry(id.to_string()).or_insert_with(|| MuseTool {
        name: item["tool"].as_str().filter(|s| !s.is_empty()).unwrap_or("tool").to_string(),
        background: false,
        stop_asked: None,
    });
    call.background |= background;
    None
}

/// The tool calls a silent Muse turn is waiting on, all to be stopped. None
/// when the silence is the model's (nothing in flight but background work)
/// or a call Orgtree already stopped is still in flight: that stop did not
/// take, so the turn ends as before instead of waiting on it again.
#[logged]
fn muse_silent_calls(tools: &HashMap<String, MuseTool>) -> Option<Vec<String>> {
    let waiting: Vec<(&String, &MuseTool)> = tools.iter().filter(|(_, c)| !c.background).collect();
    if waiting.is_empty() || waiting.iter().any(|(_, c)| c.stop_asked.is_some()) {
        return None;
    }
    let mut ids: Vec<String> = waiting.into_iter().map(|(id, _)| id.clone()).collect();
    ids.sort();
    Some(ids)
}

/// What a Muse turn is told when Orgtree stops its silent tool calls.
#[logged]
fn muse_silence_note(names: &[String], limit_s: u64) -> String {
    let span = span_text(limit_s);
    match names {
        [one] => format!("Orgtree stopped your {one} call: it produced no output for {span}, the silence limit for a turn. \
                          Treat that call as failed and carry on with your turn."),
        many => format!("Orgtree stopped your {} tool calls ({}): they produced no output for {span}, the silence limit for a turn. \
                         Treat those calls as failed and carry on with your turn.", many.len(), many.join(", ")),
    }
}

/// A limit in seconds in words; whole minutes as minutes.
#[logged]
fn span_text(s: u64) -> String {
    let (n, unit) = if s >= 60 && s % 60 == 0 { (s / 60, "minute") } else { (s, "second") };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod muse_silence_tests {
    use super::*;

    fn started(tools: &mut HashMap<String, MuseTool>, id: &str, tool: &str) {
        muse_track_tool(tools, id, &json!({ "itemId": id, "kind": "toolCall", "tool": tool, "status": "inProgress" }), false);
    }

    #[test]
    fn muse_silence_stops_each_waiting_call_once() {
        let mut tools = HashMap::new();
        assert_eq!(muse_silent_calls(&tools), None, "nothing in flight: the model is silent");
        started(&mut tools, "b", "powershell");
        started(&mut tools, "a", "mcp__slow__wait");
        assert_eq!(muse_silent_calls(&tools), Some(vec!["a".to_string(), "b".to_string()]));
        // a stop asked a whole limit ago that did not take: the turn ends as before
        tools.get_mut("a").unwrap().stop_asked = Some((Instant::now(), 600));
        assert_eq!(muse_silent_calls(&tools), None);
        // once the stopped call settles, a later silent call is stopped in its turn
        let gone = muse_track_tool(&mut tools, "a", &json!({ "itemId": "a", "kind": "toolCall", "status": "cancelled" }), true);
        assert_eq!(gone.and_then(|c| c.stop_asked).map(|(_, limit)| limit), Some(600));
        assert_eq!(muse_silent_calls(&tools), Some(vec!["b".to_string()]));
    }

    #[test]
    fn muse_background_work_is_not_the_turns_silence() {
        let mut tools = HashMap::new();
        started(&mut tools, "x", "powershell");
        // Muse moved it to the background by itself (measured shape, 1.4.6)
        muse_track_tool(&mut tools, "x", &json!({ "itemId": "x", "kind": "toolCall", "tool": "powershell", "status": "inProgress",
            "backgroundStatus": { "state": "backgrounded", "detail": "{}" } }), false);
        assert!(tools["x"].background);
        assert_eq!(muse_silent_calls(&tools), None);
        started(&mut tools, "y", "read_file");
        muse_track_tool(&mut tools, "y", &json!({ "itemId": "y", "kind": "toolCall", "status": "inProgress", "background": true }), false);
        assert!(tools["y"].background && tools["y"].name == "read_file", "a later update keeps the name and the flag");
        assert_eq!(muse_silent_calls(&tools), None);
    }

    #[test]
    fn a_todo_list_lands_on_the_call_that_wrote_it() {
        // Muse 1.4.6's list (measured 2026-10-14): `text`, camelCase statuses
        let plan: Vec<Value> = [("inProgress", "Locate the old project"), ("pending", "Design the app"), ("completed", "Read the brief")]
            .iter().map(|(s, t)| json!({ "step": t, "status": s })).collect();
        let todos = plan_todos(&plan);
        assert_eq!(todos.iter().map(|t| t["status"].as_str().unwrap()).collect::<Vec<_>>(), ["in_progress", "pending", "completed"]);
        assert_eq!(todos[0], json!({ "content": "Locate the old project", "status": "in_progress", "activeForm": "Locate the old project" }));
        // the turn's newest write_todos call: a later row, then a later place in a row
        let chip = |id: &str, name: &str| json!({ "id": id, "name": name, "arg": "", "started_at": "2026-10-14T17:31:54Z" });
        let rows: HashMap<String, (i64, Value)> = HashMap::from([
            ("r1".to_string(), (5, json!({ "tools": [chip("w1", "write_todos"), chip("p1", "powershell")] }))),
            ("r2".to_string(), (9, json!({ "tools": [chip("w2", "write_todos"), chip("w3", "write_todos"), chip("p2", "powershell")] }))),
        ]);
        let tools: HashMap<String, String> = [("w1", "r1"), ("p1", "r1"), ("w2", "r2"), ("w3", "r2"), ("p2", "r2")]
            .iter().map(|(i, k)| (i.to_string(), k.to_string())).collect();
        assert_eq!(newest_call(&rows, &tools, "write_todos"), Some(("r2".to_string(), "w3".to_string())));
        assert_eq!(newest_call(&rows, &tools, "read_file"), None, "no such call: the plan chip instead");
        // the call's own chip becomes the checklist, its id and timing kept
        let mut c = chip("w3", "write_todos");
        muse_todo_chip(&mut c, "write_todos", &todos);
        assert_eq!((c["name"].as_str(), c["arg"].as_str(), c["native_tool"].as_str()), (Some("TodoWrite"), Some("todos"), Some("write_todos")));
        assert_eq!((c["id"].as_str(), c["started_at"].as_str()), (Some("w3"), Some("2026-10-14T17:31:54Z")));
        assert_eq!(c["todos"], json!(todos));
        // a second list from the same call finds it again by its own tool name
        let rows: HashMap<String, (i64, Value)> = HashMap::from([("r2".to_string(), (9, json!({ "tools": [c] })))]);
        let tools = HashMap::from([("w3".to_string(), "r2".to_string())]);
        assert_eq!(newest_call(&rows, &tools, "write_todos"), Some(("r2".to_string(), "w3".to_string())));
    }

    /// A command Muse moved to the background and that finished after its
    /// turn: the chip gets its result, and the agent's wake message names the
    /// command and how it ended but never repeats the output, which Muse
    /// delivers itself (measured item shapes, 1.4.6).
    #[test]
    fn muse_background_results_land_on_the_chip_and_the_wake_names_the_outcome() {
        let bg = MuseBg { seq: 7, name: "powershell".into(), arg: "Start-Sleep -Seconds 15; Write-Output MARK".into() };
        let done = json!({ "itemId": "x", "kind": "toolCall", "tool": "powershell", "status": "completed", "visibleOutput": "MARK\r\n" });
        let failed = json!({ "itemId": "x", "kind": "toolCall", "tool": "powershell", "status": "failed",
                             "failureReason": "process exited with status 3", "visibleOutput": "MARK\r\n" });
        let note = muse_finished_note(&bg, &done);
        assert!(note.contains("has finished (it completed): powershell `Start-Sleep -Seconds 15; Write-Output MARK`"), "{note}");
        assert!(note.contains("Muse has put its output and exit status into your context"), "{note}");
        let note = muse_finished_note(&bg, &failed);
        assert!(note.contains("(it failed: process exited with status 3)"), "{note}");
        let cancelled = json!({ "status": "cancelled", "failureReason": "cancelled by runtime client" });
        assert!(muse_finished_note(&bg, &cancelled).contains("(it was cancelled: cancelled by runtime client)"));
        // the arg names the marker (it is the command); the output's line never travels on its own
        assert!(!muse_finished_note(&bg, &failed).contains("MARK\r\n"));

        let input = json!({ "command": "Start-Sleep -Seconds 15; Write-Output MARK" });
        let mut chip = json!({ "id": "x", "name": "powershell", "arg": bg.arg, "started_at": "2026-10-13T21:29:00Z" });
        let (text, bad) = muse_result(&done);
        muse_settle_chip(&mut chip, &done, &input, &text, bad);
        assert_eq!((chip["result"].as_str(), chip["result_lines"].as_u64(), chip.get("error")), (Some("MARK\r\n"), Some(1), None));
        assert!(chip["ended_at"].is_string() && chip["input"] == input);
        let (text, bad) = muse_result(&failed);
        muse_settle_chip(&mut chip, &failed, &input, &text, bad);
        assert!(bad && chip["error"].is_string());
    }

    #[test]
    fn muse_background_commands_lost_with_their_host_are_listed_once() {
        let b = |seq: i64, arg: &str| (format!("i{seq}"), MuseBg { seq, name: "powershell".into(), arg: arg.into() });
        let one = muse_lost_note(&[b(1, "npm test")], "the host was stopped");
        assert!(one.starts_with("A command you ran in the background did not finish: the Muse host running it stopped (the host was stopped)"), "{one}");
        assert!(one.contains("No result will arrive for:\n- powershell `npm test`\n") && one.contains("run it again"), "{one}");
        let two = muse_lost_note(&[b(1, "npm test"), b(2, "cargo build")], "the host exited: crashed");
        assert!(two.starts_with("2 commands you ran in the background did not finish") && two.contains("- powershell `cargo build`"), "{two}");
        let many: Vec<(String, MuseBg)> = (0..23).map(|i| b(i, "x")).collect();
        let note = muse_lost_note(&many, "r");
        assert_eq!(note.matches("\n- powershell").count(), 20);
        assert!(note.contains("… and 3 more"), "{note}");
    }

    #[test]
    fn muse_silence_note_names_the_call_and_the_limit() {
        assert_eq!(span_text(600), "10 minutes");
        assert_eq!(span_text(60), "1 minute");
        assert_eq!(span_text(90), "90 seconds");
        assert_eq!(span_text(1), "1 second");
        let one = muse_silence_note(&["powershell".to_string()], 600);
        assert!(one.contains("your powershell call") && one.contains("no output for 10 minutes") && one.contains("silence limit"), "{one}");
        let two = muse_silence_note(&["a".to_string(), "b".to_string()], 3);
        assert!(two.contains("your 2 tool calls (a, b)") && two.contains("3 seconds"), "{two}");
    }
}

#[cfg(test)]
mod claude_bg_tests {
    use super::*;

    fn bash() -> ClaudeBg {
        ClaudeBg { seq: 7, tool: "toolu_1".into(), name: "Bash".into(), arg: "npm run build".into(), shell: true }
    }

    #[test]
    fn the_wake_note_names_the_call_and_how_it_ended_never_its_output() {
        let done = json!({ "status": "completed", "summary": "Background command \"npm run build\" completed (exit code 0)",
                           "output_file": r"C:\t\b1.output" });
        let note = claude_finished_note(Some(&bash()), &done);
        assert!(note.starts_with("Your background command has finished (it completed, exit code 0): Bash `npm run build`."), "{note}");
        assert!(note.contains("this message only wakes you"), "{note}");
        let failed = json!({ "status": "failed", "summary": "Background command \"node exit.js\" failed with exit code 3" });
        assert!(claude_finished_note(Some(&bash()), &failed).contains("(it failed, exit code 3)"));
        let killed = json!({ "status": "killed", "summary": "Background command \"npm run build\" was killed" });
        assert!(claude_finished_note(Some(&bash()), &killed).contains("(it was killed)"));
        let agent = ClaudeBg { shell: false, name: "Agent".into(), arg: "review the diff".into(), ..bash() };
        assert!(claude_finished_note(Some(&agent), &done).starts_with("Your background task has finished (it completed, exit code 0): Agent `review the diff`."));
        let unknown = claude_finished_note(None, &done);
        assert!(unknown.contains("`Background command \"npm run build\" completed (exit code 0)`"), "{unknown}");
    }

    #[test]
    fn a_settled_chip_shows_the_output_and_a_failed_one_keeps_it() {
        let mut chip = json!({ "id": "toolu_1", "name": "Bash", "arg": "npm test", "input": { "command": "npm test", "run_in_background": true },
                               "result": "Command running in background with ID: b1." });
        claude_settle_chip(&mut chip, "ok 1\nok 2\n", false, "completed", "Background command \"npm test\" completed (exit code 0)");
        assert_eq!(chip["result"], "ok 1\nok 2\n");
        assert_eq!(chip["result_lines"], 2);
        assert!(chip["error"].is_null() && chip["truncated"].is_null() && chip["ended_at"].is_string(), "{chip}");
        let mut failed = json!({ "id": "toolu_2", "name": "Bash", "arg": "npm test", "input": { "command": "npm test" } });
        claude_settle_chip(&mut failed, "not ok 3\n", true, "failed", "Background command \"npm test\" failed with exit code 1");
        assert_eq!(failed["error"], "Background command \"npm test\" failed with exit code 1");
        assert_eq!(failed["truncated"], true);
        assert_eq!(failed["failed_shell_output"]["output"], "not ok 3\n");
        // a background subagent's chip gets the CLI's summary
        let mut agent = json!({ "id": "toolu_3", "name": "Agent", "arg": "review", "input": { "prompt": "review" } });
        claude_settle_chip(&mut agent, "Agent \"review\" completed", false, "completed", "Agent \"review\" completed");
        assert_eq!(agent["result"], "Agent \"review\" completed");
        assert!(agent.get("failed_shell_output").is_none());
    }
}

#[cfg(test)]
mod session_end_tests {
    use super::*;

    /// The user, 2026-10-16 11:03Z: a turn the sign-out cut off resumes at
    /// once, as after an engine restart mid-turn; a turn that was
    /// interrupted, halted, timed out or retired does not.
    #[test]
    fn only_a_turn_the_session_cut_off_continues() {
        assert!(may_be_session_end(true, true, false));
        assert!(!may_be_session_end(true, true, true), "a deliberate end never resumes");
        assert!(!may_be_session_end(false, true, false), "a CLI the engine started ends with no session");
        assert!(!may_be_session_end(true, false, false), "no turn, nothing to resume");
    }

    use crate::runtime::session_host::Host;
    const B: Host = Host { session: 7, helper: (700, 11) };
    const A: (u32, (u32, u64)) = (2, (200, 22));

    /// rig-sol-b's finding on 0bc97a4 (2026-10-16 13:27Z): with helpers in two
    /// of the user's sessions, a CLI whose own helper went (its session ended)
    /// while the other stays must see its session end, so its cut turn resumes.
    #[test]
    fn a_cli_sees_its_own_helper_go_while_another_stays() {
        assert!(helper_gone(B, &[A]));
    }

    /// The same: a later helper in its session, or a later process with its
    /// helper's pid, is not the helper that started it.
    #[test]
    fn a_later_helper_in_its_session_is_not_its_own() {
        assert!(helper_gone(B, &[A, (7, (701, 33))]), "another helper in session 7");
        assert!(helper_gone(B, &[A, (7, (700, 44))]), "a later process with B's pid");
    }

    /// While its own helper hosts, its exit is no session end; with no helper
    /// left it is.
    #[test]
    fn its_own_live_helper_keeps_it() {
        assert!(!helper_gone(B, &[A, (7, (700, 11))]));
        assert!(!helper_gone(B, &[(7, (700, 11))]));
        assert!(helper_gone(B, &[]));
    }
}
