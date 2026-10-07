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
use crate::runtime::convo::{self, ConvoWriter};
use crate::runtime::prompt::{self, Mail};
use crate::runtime::sched::Slot;
use crate::runtime::{freeze, AgentHandle, AgentMsg, AgentTx, Caller, Envelope, Post};
use crate::util::{gist, iso, now_iso};

/// What `/chat` needs from a running actor.
#[derive(Clone, Default, Debug)]
pub struct LiveView {
    pub busy: bool,
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
                    "SELECT name, coalesce((extra->>'cost_seen')::float8, 0), tier, extra->'cache_receipt' FROM ot.agents WHERE id = $1",
                    &[&handle.id],
                )
                .await?;
            Ok((client, row))
        }.await;
        match loaded {
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
    session_id: Option<String>,
    session_provider: Option<String>,
    generation: i32,
    state: String,
    halted: bool,
    frozen: bool,
    top_level: bool,
    scratch: PathBuf,
    effort: String,
    fallback: bool,
    /// an OpenRouter seat's harness: claude-code or codex-cli
    harness: Option<String>,
    /// the org's compaction threshold, a fraction of the context window:
    /// the CLI compacts the session when its context passes it
    compact_at: f64,
    /// "reset a session before a known-cold turn" (agent override, else the
    /// org's): the context occupancy above which it applies
    cold_reset: Option<f64>,
    /// the earlier session could not be carried over: why (the next turn
    /// starts with a handoff note)
    handoff_due: Option<String>,
}

/// How an OpenRouter seat reaches the gateway (the key never prints).
struct OrRoute {
    key: String,
    codex: bool,
    reasoning: bool,
}

impl std::fmt::Debug for OrRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OrRoute {{ key: *****, codex: {}, reasoning: {} }}", self.codex, self.reasoning)
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
            .field("scratch", &self.scratch)
            .field("effective", &self.effective)
            .finish()
    }
}

/// The launch of a CLI process for an agent, before anything is written.
#[derive(Debug)]
struct Plan {
    identity: String,
    settings: Value,
    mcp: Value,
    disallowed: Vec<String>,
    allowed: Vec<String>,
    add_dirs: Vec<String>,
    external: Vec<String>,
    print: Fingerprint,
}

struct Turn {
    id: i64,
    started: Instant,
    admitted_at: DateTime<Utc>,
    serving_account: Option<String>,
    serving_provider: String,
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
    usage: Value,
    model: Option<String>,
    draft: String,
    thinking: String,
    compact: bool,
    /// the request this turn's CLI stream is logged under
    span: tracing::Span,
    /// cards `orgtree_*` tools attached to their chips, by tool_use_id
    cards: HashMap<String, Value>,
    /// Codex: this turn's id on the thread
    codex_turn: Option<String>,
    /// Codex: the thread's token total before this turn
    usage_base: Option<Value>,
    /// Codex: the assistant row tool chips attach to
    codex_row: Option<String>,
    /// Codex: the last error the server reported (it ends with `turn/completed`)
    codex_error: Option<String>,
    /// approvals declined during the turn
    denials: Vec<Value>,
    /// Antigravity: response text so far, by step
    agy_text: HashMap<i64, String>,
    /// Antigravity: mid-turn mail handed to the steer hook and not yet
    /// emitted: (handoff id, mail ids, the claimed mail rows)
    agy_steer: Option<(String, Vec<i64>, Vec<Value>)>,
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
            limit_signal: false,
            last_event: Instant::now(),
            rows: HashMap::new(),
            tools: HashMap::new(),
            interrupted: false,
            killed: false,
            activity: false,
            usage: Value::Null,
            model: None,
            draft: String::new(),
            thinking: String::new(),
            compact,
            cards: HashMap::new(),
            span: tracing::Span::none(),
            codex_turn: None,
            usage_base: None,
            codex_row: None,
            codex_error: None,
            denials: Vec::new(),
            agy_text: HashMap::new(),
            agy_steer: None,
        }
    }
}

/// The agent's CLI process: Claude Code or the Codex app-server.
enum Proc {
    Claude(ClaudeProc),
    Codex(CodexProc),
    Agy(AgyProc),
}

#[logged]
impl Proc {
    #[nolog]
    fn process(&self) -> uuid::Uuid {
        match self {
            Proc::Claude(p) => p.process,
            Proc::Codex(p) => p.process,
            Proc::Agy(p) => p.process,
        }
    }

    async fn exit_status(&mut self, reason: &str) -> String {
        match self {
            Proc::Claude(p) => p.exit_status(reason).await,
            Proc::Codex(p) => p.exit_status(reason).await,
            Proc::Agy(p) => p.exit_status(reason).await,
        }
    }

    #[nolog]
    fn alive(&mut self) -> bool {
        match self {
            Proc::Claude(p) => p.alive(),
            Proc::Codex(p) => p.alive(),
            Proc::Agy(p) => p.alive(),
        }
    }

    /// Ask the running turn to stop (`codex_turn`: the Codex turn id).
    fn interrupt(&self, codex_turn: Option<&str>) -> bool {
        match (self, codex_turn) {
            (Proc::Claude(p), _) => p.interrupt(),
            (Proc::Codex(p), Some(t)) => p.interrupt(t),
            (Proc::Codex(_), None) => false,
            (Proc::Agy(p), _) => p.interrupt(),
        }
    }

    /// A live effort change (Claude only; Codex takes it at the next turn).
    fn set_effort(&self, level: &str) -> bool {
        match self {
            Proc::Claude(p) => p.set_effort(level),
            Proc::Codex(_) | Proc::Agy(_) => false,
        }
    }

    async fn close(&mut self) {
        match self {
            Proc::Claude(p) => p.close().await,
            Proc::Codex(p) => p.close().await,
            Proc::Agy(p) => p.close().await,
        }
    }

    async fn kill(&mut self) {
        match self {
            Proc::Claude(p) => p.kill().await,
            Proc::Codex(p) => p.kill().await,
            Proc::Agy(p) => p.kill().await,
        }
    }

    #[nolog]
    fn is_codex(&self) -> bool {
        matches!(self, Proc::Codex(_))
    }

    #[nolog]
    fn is_agy(&self) -> bool {
        matches!(self, Proc::Agy(_))
    }
}

#[derive(Clone, PartialEq, Debug)]
struct Fingerprint {
    parts: Vec<(&'static str, String)>,
}

/// The fingerprint's parts, in `plan`'s order.
const PRINT_PARTS: [&str; 6] = ["system_prompt", "tools", "model", "permission_mode", "folders", "account"];

#[logged]
impl Fingerprint {
    fn to_json(&self) -> Value {
        json!(self.parts.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>())
    }

    fn from_json(v: &Value) -> Option<Fingerprint> {
        let parts = v
            .as_array()?
            .iter()
            .map(|p| {
                let name = p.get(0)?.as_str()?;
                let k = PRINT_PARTS.iter().find(|n| **n == name)?;
                Some((*k, p.get(1)?.as_str()?.to_string()))
            })
            .collect::<Option<Vec<_>>>()?;
        (parts.len() == PRINT_PARTS.len()).then_some(Fingerprint { parts })
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

#[logged]
fn hash(s: &str) -> String {
    hex::encode(&Sha256::digest(s.as_bytes())[..12])
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
    proc_effort: Option<String>,
    parked: bool,
    slot: Option<Slot>,
    waiting_since: Option<DateTime<Utc>>,
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
            proc_effort: None,
            parked: false,
            slot: None,
            waiting_since: None,
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
            activity: None,
            rate_limit: None,
            cost_seen: row.get(1),
            agy_steer_dir: None,
            board_sent: None,
            provider: catalog::provider_of(&tier).to_string(),
            codex_total: None,
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
        self.turn.is_none() && self.proc.is_none() && self.slot.is_none() && self.waiting_since.is_none()
    }

    #[nolog]
    fn next_deadline(&self) -> tokio::time::Instant {
        let now = Instant::now();
        let mut d = now + Duration::from_secs(30);
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
        if self.dormant() {
            d = d.min(self.idle_since + ACTOR_IDLE_EXIT + Duration::from_millis(50));
        }
        tokio::time::Instant::from_std(d.max(now))
    }

    #[nolog]
    async fn on_timer(&mut self) -> Result<()> {
        if let Some(k) = self.keep_until {
            if Instant::now() >= k && self.turn.is_none() {
                self.keep_until = None;
                self.close_proc().await;
                self.publish();
            }
        }
        let expired = self.turn.as_ref().and_then(|t| {
            let idle_limit = self.engine.settings.turn_idle_s();
            let total = self.engine.settings.turn_timeout_s();
            if idle_limit > 0 && t.last_event.elapsed() >= Duration::from_secs(idle_limit) {
                Some("the turn produced nothing for too long and was stopped")
            } else if total > 0 && t.started.elapsed() >= Duration::from_secs(total) {
                Some("the turn ran past its time limit and was stopped")
            } else {
                None
            }
        });
        if let Some(why) = expired {
            tracing::warn!(agent = %self.name, why, "ending turn");
            if let Some(t) = self.turn.as_mut() {
                t.killed = true;
            }
            self.kill_proc().await;
            self.end_turn(Some(why.to_string()), Value::Null).await?;
        }
        Ok(())
    }

    async fn handle_msg(&mut self, msg: AgentMsg) -> Result<()> {
        match msg {
            AgentMsg::Wake => self.on_wake().await?,
            AgentMsg::Slot(slot) => self.on_slot(slot).await?,
            AgentMsg::Claude(process, v) => {
                if self.owns_process(process) { self.on_claude(v).await?; }
            }
            AgentMsg::Codex(process, v) => {
                if self.owns_process(process) { self.on_codex(v).await?; }
            }
            AgentMsg::Agy(process, v) => {
                if self.owns_process(process) { self.on_agy(v).await?; }
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
                let _ = reply.send(json!({ "unhalted": true, "status": "idle" }));
                self.on_wake().await?;
            }
            AgentMsg::Command(text, reply) => {
                let r = match self.command(&text).await {
                    Ok(v) => v,
                    Err(e) => json!({ "started": false, "reason": format!("{e:#}") }),
                };
                let _ = reply.send(r);
            }
            AgentMsg::Effort(level, reply) => {
                let live = catalog::tier(&self.tier().await).map(|t| t.live_effort).unwrap_or(false);
                let r = match (&self.proc, &self.turn) {
                    (Some(p), Some(_)) if live => {
                        if self.proc_effort.as_deref() == Some(level.as_str()) {
                            json!({ "effort_delivery": "unchanged" })
                        } else if p.set_effort(&level) {
                            self.proc_effort = Some(level.clone());
                            json!({ "effort_delivery": "sent" })
                        } else {
                            json!({ "effort_delivery": "next_turn" })
                        }
                    }
                    (Some(p), None) if live => {
                        if p.set_effort(&level) {
                            self.proc_effort = Some(level.clone());
                        }
                        json!({ "effort_delivery": "next_turn" })
                    }
                    _ => json!({ "effort_delivery": "next_turn" }),
                };
                let _ = reply.send(r);
                self.update_forecast().await;
                self.publish();
            }
            AgentMsg::Process { action, reply } => {
                let r = self.process_control(&action).await;
                self.publish();
                let _ = reply.send(r);
            }
            AgentMsg::Reconfigured => {
                self.reconfigured = self.proc.is_some();
                self.update_forecast().await;
                self.publish();
            }
            AgentMsg::Live(reply) => {
                let _ = reply.send(self.live_view());
            }
            AgentMsg::Stop(reply) => {
                // engine shutdown or retirement: a running turn's mail stays
                // claimed and inflight_at stays set, so the next start resumes it
                self.stopping = true;
                if self.waiting_since.take().is_some() {
                    self.engine.sched.cancel(self.id);
                }
                self.kill_proc().await;
                let _ = self.take_turn();
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
            AgentMsg::CloseIdle => {
                if self.turn.is_none() && self.proc.is_some() {
                    self.keep_until = None;
                    self.close_proc().await;
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
        if self.turn.is_some() && !self.stopping && self.proc.as_ref().map(|p| p.is_codex()).unwrap_or(false) {
            // Codex takes mid-turn mail at once (`turn/steer`)
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
        let client = self.engine.db.get().await?;
        let row = client
            .query_one(
                "SELECT a.state, a.halt IS NOT NULL, a.frozen IS NOT NULL, o.killswitch IS NOT NULL,
                        EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = a.id AND m.state = 'pending' AND NOT m.notice), a.frozen
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
        let rx = self.engine.sched.want(self.org_id, self.id);
        let tx = self.tx.clone();
        crate::trace::spawn(async move {
            if let Ok(slot) = rx.await {
                // if the actor is gone the slot drops here and is freed
                let _ = tx.post(AgentMsg::Slot(slot));
            }
        });
        self.publish();
        Ok(())
    }

    async fn on_slot(&mut self, slot: Slot) -> Result<()> {
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
                self.publish();
                self.changed(vec![Change::Agent(self.id)]);
            }
        }
        Ok(())
    }

    async fn load_ctx(&self) -> Result<Ctx> {
        let client = self.engine.db.get().await?;
        let r = client
            .query_one(
                "SELECT a.name, a.title, a.tier, a.account, a.scope, a.charter, a.session_id, a.provider, a.generation,
                        a.state, a.halt IS NOT NULL, a.frozen IS NOT NULL, a.parent_id, a.scratch_dir,
                        p.team_charter, o.name, o.slug, o.settings, o.killswitch IS NOT NULL,
                        (SELECT s.secret FROM ot.account_secrets s JOIN ot.accounts ac ON ac.id = s.account_id
                          WHERE ac.id = a.account AND ac.kind = 'apikey'),
                        a.extra->>'harness', a.extra->>'handoff_due',
                        a.team_charter, p.name,
                        EXISTS (SELECT 1 FROM ot.audiences au WHERE au.org_id = a.org_id AND au.grantee = a.name
                                   AND au.grantor = '@extern' AND au.revoked_at IS NULL)
                   FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
                   LEFT JOIN ot.agents p ON p.id = a.parent_id
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
        let harness = if openrouter {
            Some(r.get::<_, Option<String>>(20).unwrap_or_else(|| crate::openrouter::selected_harness(&self.engine)))
        } else {
            None
        };
        let effort = configured
            .get("effort")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| settings.get("default_effort").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string))
            .unwrap_or_else(|| catalog::DEFAULT_EFFORT.to_string());
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
            effort,
            fallback,
            harness,
            compact_at,
            cold_reset,
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
        let key = crate::openrouter::key(&self.engine).await.ok_or_else(|| {
            anyhow!("this agent runs on an OpenRouter tier and no OpenRouter API key is set (App settings › Providers › OpenRouter)")
        })?;
        let codex = ctx.harness.as_deref() == Some("codex-cli");
        Ok(OrRoute { key, codex, reasoning: fav["reasoning"].as_bool().unwrap_or(false) })
    }

    /// The system prompt for this launch (runtime::identity). Reads the
    /// agent's own and its granted folders' CLAUDE.md; no side effects.
    fn identity(&self, ctx: &Ctx, external: &[String]) -> String {
        let codex = ctx.provider == catalog::OPENAI || ctx.harness.as_deref() == Some("codex-cli");
        let lane = if codex {
            prompt::Lane::Codex
        } else if ctx.provider == catalog::GOOGLE {
            prompt::Lane::Antigravity
        } else {
            prompt::Lane::Claude
        };
        let tools = &ctx.effective["tools"];
        let pm = ctx.effective["permission_mode"].as_str().unwrap_or("acceptEdits");
        let may_write = tools.get("edit").and_then(Value::as_bool).unwrap_or(true) && pm != "plan";
        let sandbox = if !may_write {
            "read-only"
        } else if pm == "bypassPermissions" {
            "danger-full-access"
        } else {
            "workspace-write"
        };
        // granted folders' CLAUDE.md; the org workspace's is org.md, delivered on its own
        let workspace = self.engine.cfg.workspace_dir(&ctx.org_slug);
        let folder_notes: Vec<(String, String)> = ctx.effective["add_dirs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d["path"].as_str())
            .filter(|p| crate::config::canonical(std::path::Path::new(p)).ok() != crate::config::canonical(&workspace).ok())
            .filter_map(|p| std::fs::read_to_string(std::path::Path::new(p).join("CLAUDE.md")).ok().map(|t| (p.to_string(), t)))
            .collect();
        let own_notes = if lane == prompt::Lane::Claude { None } else { std::fs::read_to_string(ctx.scratch.join("CLAUDE.md")).ok() };
        let skills = dirs::home_dir().map(|h| h.join(".claude").join("skills").to_string_lossy().to_string()).unwrap_or_default();
        prompt::identity(&prompt::Identity {
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
            folder_notes: &folder_notes,
            own_notes: own_notes.as_deref(),
            skills_dir: &skills,
        })
    }

    /// Everything a launch needs, computed without side effects (the cache
    /// forecast compares these without starting anything).
    fn plan(&self, ctx: &Ctx) -> Plan {

        let tools = &ctx.effective["tools"];
        let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
        let mut disallowed: Vec<String> = vec!["AskUserQuestion".into(), "EnterPlanMode".into(), "ExitPlanMode".into()];
        if !on("bash") {
            disallowed.extend(["Bash".into(), "PowerShell".into(), "BashOutput".into(), "KillShell".into()]);
        }
        if !on("web") {
            disallowed.extend(["WebSearch".into(), "WebFetch".into()]);
        }
        if !on("edit") {
            disallowed.extend(["Edit".into(), "Write".into(), "NotebookEdit".into(), "MultiEdit".into()]);
        }
        if !on("subagents") {
            disallowed.extend(["Task".into(), "Agent".into()]);
        }
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
        let identity = self.identity(ctx, &external);
        let mcp = json!({ "mcpServers": servers });
        let mut allowed: Vec<String> = servers.keys().map(|k| format!("mcp__{k}")).collect();
        if on("bash") {
            allowed.extend(["Bash".into(), "PowerShell".into()]);
        }
        if on("web") {
            allowed.extend(["WebSearch".into(), "WebFetch".into()]);
        }
        let mut add_dirs: Vec<String> = Vec::new();
        let mut deny: Vec<String> = Vec::new();
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
        let tools_print = format!("{}|{}|{}", disallowed.join(","), allowed.join(","), mcp);
        let dirs_print = format!("{}|{}", add_dirs.join(";"), settings);
        let print = Fingerprint {
            parts: vec![
                ("system_prompt", hash(&identity)),
                ("tools", hash(&tools_print)),
                ("model", ctx.model.clone()),
                ("permission_mode", ctx.effective["permission_mode"].as_str().unwrap_or("").to_string()),
                ("folders", hash(&dirs_print)),
                ("account", ctx.account.clone().unwrap_or_default()),
            ],
        };
        Plan { identity, settings, mcp, disallowed, allowed, add_dirs, external, print }
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
        let view = self.engine.accounts.view();
        let acc = ctx.account.as_deref().and_then(|a| view.get(a));
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
            .execute("UPDATE ot.agents SET extra = extra - 'handoff_due' WHERE id = $1", &[&self.id])
            .await?;
        tracing::info!(agent = %self.name, why = %why, "handoff note for a fresh session");
        Ok(Some(note))
    }

    /// "Reset a session before a known-cold turn" (cheap compact; Org
    /// settings › Policies, or the agent's ⚙): when the prompt cache is known
    /// to be cold and the context is fuller than the setting's occupancy, the
    /// turn starts a fresh session seeded with a digest instead of re-reading
    /// the whole old one at full price. An unknown forecast never resets.
    /// Returns the note the turn's prompt starts with.
    async fn cold_reset(&mut self, ctx: &mut Ctx) -> Result<Option<String>> {
        let Some(occ) = ctx.cold_reset else { return Ok(None) };
        let Some(session) = ctx.session_id.clone() else { return Ok(None) };
        let state = self.forecast_for(ctx)["state"].as_str().unwrap_or("").to_string();
        if state != "expired_known_entry" && state != "known_incompatible" {
            return Ok(None);
        }
        let client = self.engine.db.get().await?;
        let r = client
            .query_one("SELECT occupancy, context_window, last_status FROM ot.agents WHERE id = $1", &[&self.id])
            .await?;
        let used: Option<i32> = r.get(0);
        let window: Option<i32> = r.get::<_, Option<i32>>(1).or_else(|| catalog::tier(&ctx.tier).and_then(|t| t.context).map(|c| c as i32));
        let (Some(used), Some(window)) = (used, window) else { return Ok(None) };
        if window <= 0 || (used as f64) < occ * window as f64 {
            return Ok(None);
        }
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
                "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true, row_version = row_version + 1
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
        self.close_proc().await;
        self.reconfigured = true;
        Ok(Some(note))
    }

    async fn ensure_proc(&mut self, ctx: &Ctx) -> Result<()> {
        let route = if ctx.provider == catalog::OPENROUTER { Some(self.openrouter_route(ctx).await?) } else { None };
        self.account_gate(ctx, route.as_ref())?;
        if ctx.provider == catalog::OPENAI || route.as_ref().map(|r| r.codex).unwrap_or(false) {
            return self.ensure_codex(ctx, route.as_ref()).await;
        }
        if ctx.provider == catalog::GOOGLE {
            return self.ensure_agy(ctx).await;
        }
        if ctx.provider != catalog::CLAUDE && route.is_none() {
            return Err(anyhow!("{} agents cannot run on this engine build yet", catalog::provider_label(&ctx.provider)));
        }
        if route.is_none() && !self.engine.settings.provider_enabled(catalog::CLAUDE) {
            return Err(anyhow!("Claude is turned off in App settings"));
        }
        let plan = self.plan(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => {
                !p.is_codex() && !p.is_agy() && self.proc_print.as_ref() == Some(&plan.print) && !self.reconfigured && p.alive()
            }
            None => false,
        };
        if reuse {
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
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
        let mut env: Vec<(String, String)> = vec![
            ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
            ("ORGTREE_AGENT".into(), ctx.name.clone()),
            ("ORGTREE_ORG".into(), ctx.org_slug.clone()),
            // the org's compaction threshold (Org settings › Basic)
            ("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), format!("{}", (ctx.compact_at * 100.0).round() as i64)),
        ];
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
        let config_dir = if route.is_some() { None } else { self.config_dir_of(ctx.account.as_deref()) };
        if let Some(r) = &route {
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
        let effort =
            catalog::tier(&ctx.tier).filter(|t| t.provider == catalog::CLAUDE && t.live_effort).map(|_| ctx.effort.clone());
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
        };
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
        self.proc = Some(Proc::Claude(proc));
        self.proc_print = Some(plan.print);
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

    /// Start (or keep) the agent's Codex app-server on its thread.
    async fn ensure_codex(&mut self, ctx: &Ctx, route: Option<&OrRoute>) -> Result<()> {
        if route.is_none() && !self.engine.settings.provider_enabled(catalog::OPENAI) {
            return Err(anyhow!("OpenAI is turned off in App settings"));
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
        let (codex_home, api_key) = if route.is_some() {
            // its own home: the host login never holds OpenRouter threads
            let home = self.engine.cfg.path("profiles").join("openrouter-codex");
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
        let sandbox = if !may_write {
            "read-only"
        } else if pm == "bypassPermissions" {
            "danger-full-access"
        } else {
            "workspace-write"
        };
        let servers = plan.mcp["mcpServers"].as_object().cloned().unwrap_or_default();
        let external: serde_json::Map<String, Value> = servers.into_iter().filter(|(k, _)| k != "orgtree").collect();
        let (mut config, _attached) = codexrt::mcp_overrides(&external);
        if route.is_some() {
            let mut gateway = crate::openrouter::codex_overrides(&ctx.model);
            gateway.append(&mut config);
            config = gateway;
        }
        // the org's compaction threshold (Org settings › Basic), in tokens
        let window = catalog::tier(&ctx.tier).and_then(|t| t.context).map(|c| c as f64).or_else(|| {
            crate::openrouter::favorite(&self.engine, &ctx.tier).and_then(|f| f["context"].as_f64()).filter(|c| *c > 0.0)
        });
        if let Some(w) = window {
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
        let spec = CodexSpec {
            exe,
            cwd: ctx.scratch.clone(),
            codex_home,
            api_key,
            model: ctx.model.clone(),
            // a gateway model that takes no reasoning gets no effort
            effort: Some(codexrt::codex_effort(&ctx.effort)).filter(|_| route.map(|r| r.reasoning).unwrap_or(true)),
            sandbox: sandbox.to_string(),
            instructions: plan.identity.clone(),
            dynamic_tools: codexrt::dynamic_tools(),
            config,
            resume: resume.clone(),
            may_write,
            may_shell: on("bash"),
            env: {
                let mut env = vec![("ORGTREE_AGENT".into(), ctx.name.clone()), ("ORGTREE_ORG".into(), ctx.org_slug.clone())];
                if let Some(r) = route {
                    env.push((crate::openrouter::KEY_ENV.into(), r.key.clone()));
                }
                env
            },
        };
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let proc = CodexProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        let session_id = proc.session_id.clone();
        if resume.is_some() && resume.as_deref() != Some(session_id.as_str()) {
            self.flag_handoff("its previous Codex thread could not be resumed").await;
        }
        if resume.as_deref() != Some(session_id.as_str()) {
            self.codex_total = None;
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
        }
        self.proc = Some(Proc::Codex(proc));
        self.proc_print = Some(plan.print);
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
        let plan = self.plan(ctx);
        let reuse = match self.proc.as_mut() {
            Some(p) => {
                p.is_agy()
                    && self.proc_print.as_ref() == Some(&plan.print)
                    && self.proc_effort.as_deref() == Some(ctx.effort.as_str())
                    && !self.reconfigured
                    && p.alive()
            }
            None => false,
        };
        if reuse {
            return Ok(());
        }
        self.close_proc().await;
        self.reconfigured = false;
        let exe = match self.engine.providers.agy_path() {
            Some(p) => p,
            None => tokio::task::spawn_blocking(crate::providers::locate_agy)
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
                .ok_or_else(|| anyhow!("the Antigravity CLI is not installed on this machine"))?,
        };
        std::fs::create_dir_all(&ctx.scratch)?;
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
            model: ctx.model.clone(),
            effort: Some(ctx.effort.clone()).filter(|e| !e.is_empty()),
            conversation,
            identity: plan.identity.clone(),
            servers: granted,
            bash: on("bash"),
            edit: on("edit") && pm != "plan",
            web: on("web"),
            subagents: on("subagents"),
            env: vec![
                ("ORGTREE_AGENT".into(), ctx.name.clone()),
                ("ORGTREE_ORG".into(), ctx.org_slug.clone()),
                ("ORGTREE_AGY_STEER_DIR".into(), agyrt::steer_dir(&ctx.scratch).to_string_lossy().to_string()),
            ],
            turn_timeout_s: self.engine.settings.turn_timeout_s(),
        };
        self.agy_steer_dir = Some(agyrt::steer_dir(&ctx.scratch));
        let caller = Caller { org_id: self.org_id, org_slug: ctx.org_slug.clone(), agent_id: self.id, name: ctx.name.clone() };
        let proc = AgyProc::spawn(self.engine.clone(), spec, caller, self.tx.clone()).await?;
        self.proc = Some(Proc::Agy(proc));
        self.proc_print = Some(plan.print);
        self.proc_effort = Some(ctx.effort.clone());
        self.provider = ctx.provider.clone();
        self.mcp = McpState { last_turn_count: self.mcp.last_turn_count, ..McpState::default() };
        self.publish();
        Ok(())
    }

    /// Mail that arrived during a Codex turn goes straight in (`turn/steer`);
    /// if the turn does not take it, it waits for the next turn.
    async fn steer_codex(&mut self) -> Result<()> {
        let Some((turn_id, Some(codex_turn))) = self.turn.as_ref().map(|t| (t.id, t.codex_turn.clone())) else { return Ok(()) };
        let client = self.engine.db.get().await?;
        let claimed = client
            .query(
                "UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
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
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let mails: Vec<Mail> = raw.iter().map(mail_of).collect();
        let text = prompt::steer_text(&mails);
        let steered = match &self.proc {
            Some(Proc::Codex(p)) => p.steer(&codex_turn, &text).await,
            _ => Err(anyhow!("no Codex process")),
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
                  WHERE id IN (SELECT id FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
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
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let mails: Vec<Mail> = raw.iter().map(mail_of).collect();
        let id = format!("t{turn_id}-m{}", ids[0]);
        let body = json!({ "id": id, "text": prompt::steer_text(&mails) }).to_string();
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
        let Some((_, _, raw)) = self.turn.as_mut().and_then(|t| t.agy_steer.take()) else { return Ok(false) };
        if let Some(t) = self.turn.as_mut() { t.activity = true; }
        let client = self.engine.db.get().await?;
        let row = mail_row(&raw, Some("Delivered into the running turn."));
        let seq = self.convo.append(&client, row.clone()).await?;
        drop(client);
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
        self.unpark();
        if let Some(mut p) = self.proc.take() {
            p.close().await;
        }
        self.proc_print = None;
    }

    async fn kill_proc(&mut self) {
        self.unpark();
        if let Some(mut p) = self.proc.take() {
            p.kill().await;
        }
        self.proc_print = None;
    }

    fn begin_turn(&mut self, mut turn: Turn) {
        self.unpark();
        turn.span = crate::trace::request_from(&self.client, crate::trace::current_rq().as_deref());
        self.turn = Some(turn);
        self.keep_until = None;
        self.org.turn_delta(&self.engine, 1);
        crate::runtime::watchdogs::activity(&self.engine, self.id, "turn_started");
    }

    fn take_turn(&mut self) -> Option<Turn> {
        let t = self.turn.take();
        // Cleanup may fail in the database; a finished turn must never retain a slot.
        self.slot = None;
        if t.is_some() {
            self.org.turn_delta(&self.engine, -1);
        }
        t
    }

    /// Claim waiting mail, make sure the CLI runs, send the opening message.
    async fn start_turn(&mut self) -> Result<bool> {
        let admitted_at = Utc::now();
        let mut ctx = self.load_ctx().await?;
        if ctx.state != "live" || ctx.halted || ctx.frozen || ctx.killswitch {
            return Ok(false);
        }
        let mut client = self.engine.db.get().await?;
        let tx = client.transaction().await?;
        let turn_id: i64 = tx
            .query_one(
                "INSERT INTO ot.turns (agent_id, started_at, account, api_key, model) VALUES ($1, now(), $2, $3, $4) RETURNING id",
                &[&self.id, &ctx.account, &ctx.api_key.is_some(), &ctx.model],
            )
            .await?
            .get(0);
        let claimed = tx
            .query(
                "UPDATE ot.mail SET state = 'delivering', turn_id = $2
                  WHERE id IN (SELECT id FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
                                ORDER BY id LIMIT 64 FOR UPDATE SKIP LOCKED)
                  RETURNING id, to_jsonb(ot.mail.*)",
                &[&self.id, &turn_id],
            )
            .await?;
        let mut rows: Vec<(i64, Value)> = claimed.iter().map(|r| (r.get(0), r.get(1))).collect();
        rows.sort_by_key(|(id, _)| *id);
        if !rows.iter().any(|(_, m)| !m["notice"].as_bool().unwrap_or(false)) {
            tx.rollback().await?;
            return Ok(false);
        }
        tx.execute(
            "UPDATE ot.agents SET inflight_at = now(), last_error = NULL, row_version = row_version + 1 WHERE id = $1",
            &[&self.id],
        )
        .await?;
        tx.commit().await?;
        drop(client);
        let raw: Vec<Value> = rows.into_iter().map(|(_, m)| m).collect();
        let mails: Vec<Mail> = raw.iter().map(mail_of).collect();
        let reset_note = match self.cold_reset(&mut ctx).await {
            Ok(note) => note,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the cold-cache reset failed; resuming the session");
                None
            }
        };
        if let Err(e) = self.ensure_proc(&ctx).await {
            self.return_mail(turn_id, true).await;
            return Err(e);
        }
        let handoff = match self.take_handoff(&ctx).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "the handoff note could not be built");
                None
            }
        };
        let context = self.turn_context(&ctx).await;
        let followup: Vec<String> = mails.iter().filter(|m| self.followup_mail.contains(&m.uid))
            .map(|m| m.uid.clone()).collect();
        let mut text = prompt::turn_text(&mails, &context);
        if !followup.is_empty() {
            text.push_str("\n(orgtree) You have new mail above — handle it as appropriate, and use orgtree_status when your own task state changes.\n");
        }
        let text = match reset_note.or(handoff) {
            Some(note) => format!("{note}\n\n{text}"),
            None => text,
        };
        let mut codex_turn: Option<String> = None;
        let sent = match self.proc.as_ref() {
            Some(Proc::Claude(p)) => p.send_user(&text, images_for(&mails)),
            Some(Proc::Agy(p)) => p.send_user(&text),
            Some(Proc::Codex(p)) => match p.start_turn(&text, codex_images(&mails)).await {
                Ok(t) => {
                    codex_turn = Some(t);
                    true
                }
                Err(e) => {
                    tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "turn/start failed");
                    false
                }
            },
            None => false,
        };
        if !sent {
            self.return_mail(turn_id, true).await;
            self.close_proc().await;
            return Err(anyhow!("the {} process did not accept the turn", catalog::provider_label(&ctx.provider)));
        }
        let mut turn = Turn::new(turn_id, false);
        turn.admitted_at = admitted_at;
        turn.serving_account = self.serving_account_of(&ctx);
        turn.serving_provider = ctx.provider.clone();
        turn.codex_turn = codex_turn;
        turn.usage_base = self.codex_total.clone();
        self.begin_turn(turn);
        if !followup.is_empty() {
            tracing::info!(agent = self.id, turn = turn_id, mail_ids = ?followup,
                "started follow-up turn for undelivered mid-turn mail");
            self.followup_mail.retain(|id| !followup.contains(id));
        }
        self.last_error = None;
        self.activity = Some(("thinking".into(), None));
        self.sent_print = self.proc_print.clone();
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

    /// Fast-changing facts for the turn's opening message (kept out of the
    /// system prompt so the provider's cache survives hires and status changes).
    /// The PROVIDER USAGE block for this turn: in full (numbered) when it
    /// changed or the session is new, else one line pointing at the last one.
    fn usage_block(&mut self, ctx: &Ctx) -> String {
        let (text, key) = crate::usage::turn_board(&self.engine, &ctx.provider, ctx.account.as_deref(), &ctx.tier);
        if let Some((session, last, seq)) = &self.board_sent {
            if *session == ctx.session_id && *last == key {
                return format!("[PROVIDER USAGE #{seq} — unchanged since #{seq} earlier in this conversation; read the numbers there]");
            }
        }
        let seq = self.board_sent.as_ref().map(|(_, _, n)| n + 1).unwrap_or(1);
        self.board_sent = Some((ctx.session_id.clone(), key, seq));
        text.replacen("[PROVIDER USAGE", &format!("[PROVIDER USAGE #{seq}"), 1)
    }

    async fn turn_context(&mut self, ctx: &Ctx) -> String {
        let mut s = format!("[Orgtree] {} · you are {}", now_iso(), ctx.name);
        let Ok(client) = self.engine.db.get().await else { return s };
        if let Ok(rows) = client
            .query(
                "SELECT name, last_status->>'status' FROM ot.agents WHERE parent_id = $1 AND state = 'live'
                  ORDER BY sibling_order, id LIMIT 50",
                &[&self.id],
            )
            .await
        {
            if !rows.is_empty() {
                let list: Vec<String> = rows
                    .iter()
                    .map(|r| match r.get::<_, Option<String>>(1) {
                        Some(st) => format!("{} ({st})", r.get::<_, String>(0)),
                        None => r.get::<_, String>(0),
                    })
                    .collect();
                s.push_str("\nYour reports: ");
                s.push_str(&list.join(", "));
            }
        }
        drop(client);
        s.push_str("\n\n");
        s.push_str(&self.usage_block(ctx));
        s
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
                let _ = client
                    .execute(
                        "UPDATE ot.mail SET state = 'delivered', delivered_at = now() WHERE turn_id = $1 AND state = 'delivering'",
                        &[&turn_id],
                    )
                    .await;
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
                  WHERE id IN (SELECT id FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
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
        let mails: Vec<Mail> = raw.iter().map(mail_of).collect();
        let text = prompt::steer_text(&mails);
        if let Some(t) = self.turn.as_mut() { t.activity = true; }
        let row = mail_row(&raw, Some("Delivered after a tool call."));
        let seq = self.convo.append(&client, row.clone()).await?;
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
        crate::changes::notify(&self.engine, &self.org, ch);
    }

    #[nolog]
    fn stream(&self, kind: &str, extra: Value) {
        let mut frame = json!({ "type": "node_stream", "node": self.name, "kind": kind, "text": "" });
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
        let sub = v.get("parent_tool_use_id").map(|p| !p.is_null()).unwrap_or(false);
        match v["type"].as_str() {
            Some("system") => match v["subtype"].as_str() {
                Some("init") => self.on_init(&v),
                Some("compact_boundary") => {
                    let client = self.engine.db.get().await?;
                    let pre = v.pointer("/compact_metadata/pre_tokens").cloned().unwrap_or(Value::Null);
                    let row = json!({ "role": "system", "text": "Context compacted", "ts": now_iso(), "kind": "compact",
                                      "pre_tokens": pre });
                    self.convo.append(&client, row).await?;
                    drop(client);
                    self.text_landed();
                }
                _ => {}
            },
            Some("rate_limit_event") => {
                self.rate_limit = v.get("rate_limit_info").cloned();
                if let Some(turn) = self.turn.as_mut() {
                    turn.limit_signal |= crate::account_marks::limit_signal(&v["rate_limit_info"]);
                }
            }
            Some("stream_event") if !sub => self.on_stream_event(&v["event"]),
            Some("assistant") if !sub => self.on_assistant(&v).await?,
            Some("user") if !sub => self.on_tool_results(&v).await?,
            Some("result") => self.on_result(&v).await?,
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
                let client = self.engine.db.get().await?;
                let row = json!({ "role": "system", "text": "Context compacted", "ts": now_iso(), "kind": "compact" });
                self.convo.append(&client, row).await?;
                drop(client);
                self.text_landed();
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

    /// One Antigravity stream-json event.
    #[nolog]
    async fn on_agy(&mut self, v: Value) -> Result<()> {
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
                        acc["cost"] = json!(acc["cost"].as_f64().unwrap_or(0.0) + agyrt::request_cost(&model, inp, cached, out));
                        acc["last_prompt"] = json!(inp + cached);
                    }
                    t.draft.clear();
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
                        let input = if info["parameters"].is_object() { info["parameters"].clone() } else { json!({}) };
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input) }));
                        }
                        t.tools.insert(id.clone(), key.clone());
                        (*seq, row.clone())
                    };
                    self.convo.update(&client, update.0, update.1).await?;
                    self.set_activity("tool", Some(name.clone()));
                    self.stream("tool", json!({ "id": id }));
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
                                chip["result"] = json!(clipped);
                                chip["result_lines"] = json!(result.lines().count());
                                if truncated {
                                    chip["truncated"] = json!(true);
                                }
                                if state == "ERROR" {
                                    chip["error"] = json!(gist(&result, 500));
                                }
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
    async fn codex_row(&mut self, client: &tokio_postgres::Client, key_hint: &str) -> Result<Option<String>> {
        let existing = self.turn.as_ref().and_then(|t| t.codex_row.clone()).filter(|k| self.turn.as_ref().map(|t| t.rows.contains_key(k)).unwrap_or(false));
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
        match typ {
            "userMessage" | "hookPrompt" | "contextCompaction" | "enteredReviewMode" | "exitedReviewMode" | "functionCallOutput" => {}
            "agentMessage" | "plan" => {
                if !completed {
                    if let Some(t) = self.turn.as_mut() {
                        t.draft.clear();
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
                }
                self.text_landed();
            }
            "reasoning" => {
                if !completed {
                    if let Some(t) = self.turn.as_mut() {
                        t.thinking.clear();
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
                }
                self.stream("thought", json!({}));
            }
            _ => {
                let Some((name, input)) = codex_tool(item) else { return Ok(()) };
                let client = self.engine.db.get().await?;
                if !completed {
                    crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                    let Some(key) = self.codex_row(&client, &id).await? else { return Ok(()) };
                    let update = {
                        let Some(t) = self.turn.as_mut() else { return Ok(()) };
                        let Some((seq, row)) = t.rows.get_mut(&key) else { return Ok(()) };
                        let chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input) });
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
                            chip["result"] = json!(clipped);
                            chip["result_lines"] = json!(text.lines().count());
                            if truncated {
                                chip["truncated"] = json!(true);
                            }
                            if failed {
                                chip["error"] = json!(gist(&text, 500));
                            }
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

    /// Codex's checklist (`turn/plan/updated`) as the desk's progress list.
    async fn on_codex_plan(&mut self, p: &Value) -> Result<()> {
        let Some(steps) = p["plan"].as_array() else { return Ok(()) };
        let todos: Vec<Value> = steps
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
            .collect();
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
                        }
                        self.stream("thinking_start", json!({}));
                        self.set_activity("thinking", None);
                    }
                    Some("tool_use") | Some("server_tool_use") => {
                        let name = block["name"].as_str().unwrap_or("tool").to_string();
                        self.set_activity("tool", Some(name));
                    }
                    Some("text") => {
                        if let Some(t) = self.turn.as_mut() {
                            t.draft.clear();
                        }
                        self.set_activity("writing", None);
                    }
                    _ => {}
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
                json!({ "role": "assistant", "text": "", "tools": [], "ts": now_iso(),
                        "assistant_id": mid, "native_event_id": v["uuid"] }),
            ));
            for block in msg["content"].as_array().cloned().unwrap_or_default() {
                match block["type"].as_str() {
                    Some("text") => {
                        let cur = row["text"].as_str().unwrap_or("").to_string();
                        let add = block["text"].as_str().unwrap_or("");
                        row["text"] = json!(if cur.is_empty() { add.to_string() } else { format!("{cur}\n\n{add}") });
                        turn.draft.clear();
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
                        turn.thinking.clear();
                        wrote_thought = true;
                    }
                    Some("redacted_thinking") => {
                        row["thinking_sealed"] = json!(true);
                        turn.thinking.clear();
                        wrote_thought = true;
                    }
                    Some("tool_use") | Some("server_tool_use") => {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("tool").to_string();
                        crate::runtime::watchdogs::activity(&self.engine, self.id, &format!("tool_call {name}"));
                        let input = block["input"].clone();
                        let mut chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input) });
                        if name == "TodoWrite" {
                            chip["todos"] = input["todos"].clone();
                        }
                        if let Some(tools) = row["tools"].as_array_mut() {
                            tools.push(chip);
                        }
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
                        if truncated {
                            chip["truncated"] = json!(true);
                        }
                        if images > 0 {
                            chip["images"] = json!(images);
                        }
                        if b["is_error"].as_bool().unwrap_or(false) {
                            chip["error"] = json!(gist(&text, 500));
                        }
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
        for (seq, row) in updates {
            if seq > 0 {
                self.convo.update(&client, seq, row).await?;
            }
        }
        for (tid, list) in images {
            convo::store_images(&client, self.id, &tid, list).await?;
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
    fn owns_process(&self, process: uuid::Uuid) -> bool {
        self.proc.as_ref().map(Proc::process) == Some(process)
    }

    async fn on_exit(&mut self, process: uuid::Uuid, reason: &str) -> Result<()> {
        if !self.owns_process(process) {
            tracing::info!(agent = self.id, %process, reason, "ignored exit from replaced CLI");
            return Ok(());
        }
        let status = self.proc.as_mut().unwrap().exit_status(reason).await;
        self.proc = None;
        self.proc_print = None;
        self.unpark();
        if self.turn.is_some() {
            let quiet = self.turn.as_ref().map(|t| t.interrupted || t.killed).unwrap_or(false);
            let msg = if quiet { None } else { Some(format!("the {} process exited during the turn ({status}; {reason})", catalog::provider_label(&self.provider))) };
            self.end_turn(msg, Value::Null).await?;
        }
        self.publish();
        Ok(())
    }

    /// The usage limit this failure reports, if it is one: when it lifts.
    fn limit_of(&self, error: &str) -> Option<DateTime<Utc>> {
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
            || lower.contains("resets");
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
        let from_text = error
            .split('|')
            .nth(1)
            .and_then(|s| s.trim().parse::<i64>().ok())
            .and_then(|t| DateTime::from_timestamp(t, 0));
        Some(from_info.or(from_text).unwrap_or_else(|| Utc::now() + chrono::Duration::hours(1)))
    }

    /// Close the turn: mail settled, ledger written, slot freed.
    async fn end_turn(&mut self, mut error: Option<String>, res: Value) -> Result<()> {
        // Process exits and interrupts do not necessarily carry an `agy`
        // result. Settle the outstanding hook handoff on every exit path.
        if let Err(e) = self.settle_agy_steer().await {
            tracing::warn!(agent = %self.name, error = %format!("{e:#}"), "mid-turn mail could not be settled");
        }
        let Some(turn) = self.take_turn() else { return Ok(()) };
        crate::runtime::watchdogs::activity(&self.engine, self.id, "turn_done");
        let codex = res["codex"].as_bool().unwrap_or(false);
        let agy = res["agy"].as_bool().unwrap_or(false);
        if error.is_none() && codex {
            error = turn.codex_error.clone().filter(|_| !turn.interrupted);
        }
        let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
        let (input, cache_read, cache_write, output, ttl, occupancy, cost) = if agy {
            let u = &turn.usage;
            (n(u, "input"), n(u, "cached"), 0, n(u, "output"), 300, n(u, "last_prompt") as i32, u["cost"].as_f64().unwrap_or(0.0))
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
        let cost = if openrouter && !codex {
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
        let limit = error.as_deref().and_then(|e| self.limit_of(e));
        let mut freeze_rec: Option<Value> = None;
        let mut moved_to: Option<String> = None;
        if let Some(until) = limit {
            let ctx = self.load_ctx().await?;
            if ctx.fallback {
                moved_to = freeze::pick_fallback(&self.engine, &ctx.provider, ctx.account.as_deref());
            }
            if moved_to.is_none() {
                freeze_rec = Some(json!({
                    "at": now_iso(), "until": iso(until), "error": gist(error.as_deref().unwrap_or(""), 300),
                    "limit": true, "provenance": "observed", "account": ctx.account,
                }));
            }
            error = None;
        }
        // the CLI holds the prompt once it produced anything: settle the mail
        // as delivered; a turn that never started gives its mail back
        let succeeded = error.is_none() && limit.is_none() && !turn.limit_signal
            && !turn.interrupted && !turn.killed && !turn.compact && !res.is_null();
        let requeue = error.is_some() && !turn.activity;
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
            "SELECT uid FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
              AND NOT notice ORDER BY id LIMIT 64", &[&self.id],
        ).await?.into_iter().map(|r| r.get(0)).collect();
        if requeue {
            client
                .execute(
                    "UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE turn_id = $1 AND state = 'delivering'",
                    &[&turn.id],
                )
                .await?;
        } else {
            client
                .execute(
                    "UPDATE ot.mail SET state = 'delivered', delivered_at = now() WHERE turn_id = $1 AND state = 'delivering'",
                    &[&turn.id],
                )
                .await?;
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
                    &turn.id, &cost, &output, &input, &cache_read, &cache_write, &ttl, &ms, &(denials.len() as i32),
                    &turn.killed, &error, &turn.model, &(if codex || agy || openrouter { "priced" } else { "cli" }),
                ],
            )
            .await?;
        let window = catalog::tier(&self.tier_of(&client).await).and_then(|t| t.context).map(|c| c as i32);
        let measured = occupancy > 0 && !turn.compact;
        client
            .execute(
                "UPDATE ot.agents SET cost_usd = cost_usd + $2::float8::numeric,
                        occupancy = CASE WHEN $3 THEN $4 ELSE occupancy END,
                        occupancy_est = CASE WHEN $3 THEN false WHEN $9 THEN true ELSE occupancy_est END,
                        compacted_unrun = CASE WHEN $9 THEN true WHEN $3 THEN false ELSE compacted_unrun END,
                        context_window = coalesce(context_window, $5),
                        session_id = coalesce($6, session_id), inflight_at = NULL, last_denials = $7,
                        last_error = $8,
                        frozen = coalesce($10, frozen), limit_locked = ($10::jsonb IS NOT NULL) OR limit_locked,
                        extra = jsonb_set(extra, '{cost_seen}', to_jsonb($11::float8)),
                        row_version = row_version + 1
                  WHERE id = $1",
                &[
                    &self.id, &cost, &measured, &occupancy, &window, &session, &json!(denials), &error, &turn.compact,
                    &freeze_rec, &self.cost_seen,
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
                let _ = client
                    .execute(
                        "INSERT INTO ot.account_marks (account, pool, until, provenance, win) VALUES ($1, 'default', $2, 'observed', $3)
                         ON CONFLICT (account, pool) DO UPDATE SET until = EXCLUDED.until, win = EXCLUDED.win, at = now()",
                        &[acc, &until, &win],
                    )
                    .await;
            }
        }
        if let Some(e) = &error {
            let row = json!({ "role": "system", "text": format!("The turn ended with an error: {e}"), "ts": now_iso(), "kind": "error" });
            let _ = self.convo.append(&client, row).await;
        }
        drop(client);
        if cache_read > 0 || cache_write > 0 {
            self.receipt = Some((Utc::now(), ttl as i64));
            self.save_receipt().await;
        }
        self.last_error = error.clone();
        self.mcp.last_turn_count = self.mcp.count;
        self.slot = None;
        self.activity = None;
        self.idle_since = Instant::now();
        if succeeded {
            if let Some(account) = turn.serving_account.as_deref() {
                crate::account_marks::success(&self.engine, account, &turn.serving_provider, turn.admitted_at).await;
            }
        }
        if limit.is_some() {
            // the account changes or the agent sleeps: either way this process is done
            self.close_proc().await;
            let _ = self.engine.accounts.reload(&self.engine).await;
            crate::accounts::publish(&self.engine);
        } else if self.engine.settings.keep_warm() && self.proc.is_some() {
            self.park();
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
            return Ok(());
        }
        if let Some(acc) = moved_to {
            let engine = self.engine.clone();
            let (org_id, id) = (self.org_id, self.id);
            // continue_on messages this actor; run it off the actor's own loop
            let span = crate::trace::request_from(&self.client, crate::trace::current_rq().as_deref());
            tokio::spawn(tracing::Instrument::instrument(async move {
                if let Err(e) = freeze::continue_on(&engine, org_id, id, &acc, "account fallback").await {
                    tracing::warn!(agent = id, error = %format!("{e:#}"), "account fallback failed");
                }
            }, span));
            return Ok(());
        }
        if error.is_none() || !self.followup_mail.is_empty() {
            // All lanes share normal halt/freeze/killswitch and slot admission.
            // Confirmed boundary mail is no longer pending, so is not replayed.
            self.on_wake().await?;
        }
        Ok(())
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
        Ok(json!({ "halted": true, "settled": true, "status": "halted" }))
    }

    /// A slash command as its own turn (`/compact` compacts the session).
    async fn command(&mut self, text: &str) -> Result<Value> {
        let admitted_at = Utc::now();
        if self.turn.is_some() {
            return Ok(json!({ "started": false, "reason": "a turn is running; wait for it or interrupt it" }));
        }
        let compact = text.trim() == "/compact" || text.trim().starts_with("/compact ");
        let ctx = self.load_ctx().await?;
        let claude_code = ctx.provider == catalog::CLAUDE
            || (ctx.provider == catalog::OPENROUTER && ctx.harness.as_deref() != Some("codex-cli"));
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

    // ------------------------------------------------------------ publish

    #[nolog]
    fn live_view(&self) -> LiveView {
        let mut transient = Vec::new();
        if let Some(t) = &self.turn {
            if !t.draft.is_empty() {
                transient.push(json!({ "event_id": format!("draft-{}", t.id), "role": "assistant", "kind": "draft", "text": t.draft }));
            }
            if !t.thinking.is_empty() {
                transient.push(json!({ "event_id": format!("think-{}", t.id), "role": "assistant", "kind": "thinking", "text": t.thinking }));
            }
        }
        LiveView {
            busy: self.turn.is_some(),
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
            "waiting": self.waiting_since.is_some(),
            "queued_for_slot": queued_for_slot,
            "responding": busy,
            "phase": if compacting { json!("compacting") } else if busy { json!("responding") } else { Value::Null },
            "ran_as": Value::Null,
            "codex_route": Value::Null,
            "queued": 0,
            "proc_warm": live && !busy,
            "proc_live": live,
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
            "tasks": 0,
            "bg_tasks": 0,
            "last_error": self.last_error,
            "activity": activity,
            "cache_forecast": self.forecast,
        })
    }

    #[nolog]
    fn publish(&self) {
        let v = self.runtime_value();
        self.handle.view.store(Arc::new(v.clone()));
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
        self.handle.view.store(Arc::new(v.clone()));
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

    /// Will the next turn hit the provider's prompt cache?
    async fn update_forecast(&mut self) {
        self.forecast = match self.load_ctx().await {
            Ok(ctx) => self.forecast_for(&ctx),
            Err(_) => Value::Null,
        };
    }

    fn forecast_for(&self, ctx: &Ctx) -> Value {
        let lane = match ctx.provider.as_str() {
            p if p == catalog::OPENAI => "codex",
            p if p == catalog::OPENROUTER && ctx.harness.as_deref() == Some("codex-cli") => "codex",
            p if p == catalog::GOOGLE => "antigravity",
            _ => "claude",
        };
        let generation = format!("{}", ctx.generation);
        let receipt_at = self.receipt.map(|(t, _)| iso(t));
        let Some(sent) = &self.sent_print else {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "unknown",
                           "readiness_cause": "no_completed_fingerprint", "reason": "no turn has completed since the engine started",
                           "source": "no_completed_fingerprint", "lane": lane, "last_receipt_at": receipt_at,
                           "ttl_seconds": null, "expires_at": null });
        };
        let now_print = self.plan(ctx).print;
        let changed = now_print.changed(sent);
        if !changed.is_empty() {
            return json!({ "generation": generation, "state": "known_incompatible", "readiness": "not_ready",
                           "readiness_cause": "prefix_changed", "reason": "the prompt prefix changed since the last turn",
                           "source": "authoritative_receipt", "lane": lane, "changed_inputs": changed,
                           "last_receipt_at": receipt_at, "ttl_seconds": null, "expires_at": null,
                           "precompact_action": "not_applicable" });
        }
        let Some((at, ttl)) = self.receipt else {
            return json!({ "generation": generation, "state": "uncertain", "readiness": "not_ready",
                           "readiness_cause": "no_positive_receipt", "reason": "the last turn reported no cache use",
                           "source": "no_positive_receipt", "lane": lane, "last_receipt_at": null,
                           "ttl_seconds": null, "expires_at": null });
        };
        let expires = at + chrono::Duration::seconds(ttl);
        if Utc::now() >= expires {
            return json!({ "generation": generation, "state": "expired_known_entry", "readiness": "not_ready",
                           "readiness_cause": "receipt_expired", "reason": "the cache entry has expired",
                           "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at),
                           "ttl_seconds": ttl, "expires_at": iso(expires), "precompact_action": "miss_expected" });
        }
        json!({ "generation": generation, "state": "compatible_observed", "readiness": "ready",
                "readiness_cause": "receipt_valid", "reason": "the cache entry was observed and has not expired",
                "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at), "ttl_seconds": ttl,
                "expires_at": iso(expires), "precompact_action": "not_applicable" })
    }
}

/// A claimed mail row (`to_jsonb(ot.mail)`) as the agent reads it.
#[logged]
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
    }
}

/// The desk row for mail an agent was given: one mail segment.
#[logged]
fn mail_row(raw: &[Value], receipt: Option<&str>) -> Value {
    let rows: Vec<Value> = raw
        .iter()
        .map(|m| {
            let mut e = crate::feed::compute::mail_entry(m);
            if let Some(o) = e.as_object_mut() {
                o.remove("delivering");
                o.remove("notice");
                if m["notice"].as_bool().unwrap_or(false) && o.get("kind").and_then(Value::as_str) == Some("message") {
                    o.insert("kind".into(), json!("notice"));
                }
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
fn codex_tool(item: &Value) -> Option<(String, Value)> {
    let args = |v: &Value| if v.is_object() { v.clone() } else { json!({ "arguments": v }) };
    let s = |k: &str| item[k].as_str().unwrap_or("").to_string();
    Some(match item["type"].as_str()? {
        "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_string(), args(&item["arguments"])),
        "mcpToolCall" => (format!("mcp__{}__{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("tool")), args(&item["arguments"])),
        "commandExecution" => ("exec_command".into(), json!({ "command": s("command") })),
        "fileChange" => {
            let paths: Vec<String> = item["changes"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["path"].as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            ("apply_patch".into(), json!({ "path": paths.join(", ") }))
        }
        "webSearch" => ("web_search".into(), json!({ "query": s("query") })),
        "imageView" => ("view_image".into(), json!({ "path": s("path") })),
        "collabAgentToolCall" => (item["tool"].as_str().unwrap_or("collaboration").to_string(), json!({ "prompt": s("prompt") })),
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
