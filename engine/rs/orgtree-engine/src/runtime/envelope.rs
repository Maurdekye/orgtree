//! The per-turn envelope an agent reads before its mail (user 2026-10-07:
//! "match 3.x, minus what 4.0 removed"). Ported from the 3.x engine
//! (supervisor.py on origin/v3/3.0.0-alpha.0: `org_state_block`,
//! `_org_state_parts`, `_render_chart`, `_status_note`, `_mail_block`;
//! envelope.py for D-223).
//!
//! Order on every turn: `[ORG STATE …]`, `[PROVIDER USAGE …]` (actor
//! `usage_block`), `[ORG NOTICES — N change(s) since your last turn]`, then
//! `[MAIL — N message(s)] … [END MAIL]`. 3.x kept notices in their own box;
//! 4.0 sends them as passive engine mail carrying a typed event, and this
//! module sorts them back into their block (`split_notices`). Typed mail is
//! worded by `event_text` (3.x events_render.py) from its event.
//!
//! D-181: everything here changes when ANOTHER agent moves (a hire, a
//! retire, a status report, a grant), so it rides the turn and never the
//! system prompt — one changed byte there throws away the provider's whole
//! prompt cache. D-223: the chart is most of the block and changes rarely,
//! so while it is unchanged it is replaced by a pointer at the numbered
//! snapshot that carried it (the record lives in `agents.extra.envelope`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::runtime::prompt::Mail;
use crate::util::iso;

pub const ORG_STATE_OPEN: &str = "[ORG STATE";
pub const ORG_STATE_CLOSE: &str = "[END ORG STATE]";
/// The line a turn's mail ends with (3.x's wake text for mail).
pub const MAIL_PING: &str =
    "(orgtree) You have new mail above — handle it as appropriate, and use orgtree_status when your own task state changes.";
/// The line a delivery of passive notices only ends with (3.x `send_message`
/// wake=False after a status report or send_notice, user ruling 2026-10-03:
/// a status report wakes nobody and asks for no action).
pub const NOTICE_PING: &str =
    "(orgtree) A notice arrived in your mail above — informational, no reply expected. Note it and continue your current task.";

/// The closing line for a delivery: the mail ping when anything in it
/// expects handling, the notice ping when it is all passive notices.
#[logged]
pub fn ping_for(mail: &[Mail]) -> &'static str {
    if !mail.is_empty() && mail.iter().all(|m| m.notice) { NOTICE_PING } else { MAIL_PING }
}

/// The chart's legend (3.x FR-1): the status words are claims, the bracket is their age.
const CHART_LEGEND: &str = "\n(After \"·\": what each agent last SAID about itself via orgtree_status, and in brackets HOW OLD \
that claim is — it is self-reported, so an old one may simply be wrong. \"▶ mid-turn\" is not self-reported: the system knows a \
turn is executing right now.)";
/// 3.x `_CHART_SUPPRESS_MIN`: a smaller chart is always sent whole.
const CHART_SUPPRESS_MIN: usize = 280;
/// 3.x envelope.py: a suppressed chart is re-sent at least this often.
const FULL_REFRESH_TURNS: i64 = 10;
const FULL_REFRESH_AGE_S: i64 = 900;
const FULL_REFRESH_TOKENS: i64 = 60_000;
/// 3.x WORKING_CHECKUP_AFTER_S: a "working" claim this old is flagged.
const WORKING_STALE_S: i64 = 20 * 60;
const STATUS_GIST_MAX: usize = 80;
/// Bound on the org read (the target is up to ~1000 agents).
const MAX_AGENTS: i64 = 5000;
/// Images larger than this are not loaded into a turn (actor `images_for`).
const IMAGE_MAX: u64 = 5 * 1024 * 1024;

#[derive(Debug)]
struct Row {
    id: i64,
    name: String,
    parent: Option<i64>,
    tier: String,
    state: String,
    halted: bool,
    status: Option<Value>,
    inflight_at: Option<DateTime<Utc>>,
    last_turn: Option<DateTime<Utc>>,
}

/// The rendered block and the D-223 record to store once the turn was sent.
#[derive(Debug, Default)]
pub struct OrgState {
    pub text: String,
    pub record: Option<Value>,
}

/// What the actor knows about one agent's live runtime (busy, waiting for a slot).
#[derive(Debug, Clone, Copy, Default)]
pub struct Live {
    pub busy: bool,
    pub waiting: bool,
}

#[nolog]
fn live_of(engine: &Engine, id: i64) -> Live {
    match engine.agents.get(id) {
        Some(h) => {
            let v = h.view.load();
            Live { busy: v["busy"].as_bool() == Some(true), waiting: v["waiting"].as_bool() == Some(true) }
        }
        None => Live::default(),
    }
}

/// 3.x `_age_phrase`: coarse on purpose, so the chart (and its digest) stays
/// the same for a quiet org.
#[nolog]
fn age_phrase(secs: i64) -> String {
    if secs < -60 {
        "in the future?".into()
    } else if secs < 600 {
        "<10m".into()
    } else if secs < 3600 {
        format!("{}m", secs / 600 * 10)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

#[nolog]
fn status_gist(s: &str) -> String {
    let g = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if g.chars().count() > STATUS_GIST_MAX {
        let cut: String = g.chars().take(STATUS_GIST_MAX - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        g
    }
}

#[nolog]
fn ts(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    v.get(key).and_then(Value::as_str).and_then(crate::util::parse_ts)
}

/// 3.x `_status_note`: what the agent last said, how old that is, and what
/// the engine knows better (mid-turn, waiting, died mid-turn).
#[nolog]
fn status_note(r: &Row, live: Live, now: DateTime<Utc>) -> String {
    if r.state != "live" {
        return String::new();
    }
    if live.busy {
        return match r.inflight_at {
            Some(t) => format!("▶ mid-turn {}", age_phrase((now - t).num_seconds())),
            None => "▶ mid-turn".into(),
        };
    }
    if live.waiting {
        return "waiting for a turn slot".into();
    }
    if let Some(t) = r.inflight_at {
        return format!("⚠ turn started {} ago and never finished — the engine stopped mid-turn", age_phrase((now - t).num_seconds()));
    }
    let Some(rec) = r.status.as_ref().filter(|s| s.is_object()) else { return "no status reported".into() };
    let word = rec.get("status").and_then(Value::as_str).unwrap_or("?");
    let gist = status_gist(rec.get("summary").and_then(Value::as_str).unwrap_or(""));
    let at = ts(rec, "at");
    let age = at.map(|t| age_phrase((now - t).num_seconds())).unwrap_or_else(|| "age unknown".into());
    let mut note = if gist.is_empty() { format!("{word} ({age})") } else { format!("{word} \"{gist}\" ({age})") };
    let before_last_turn = matches!((at, r.last_turn), (Some(a), Some(t)) if t > a);
    if before_last_turn {
        note.push_str(" — said BEFORE its last turn; nothing reported since");
    } else if word == "working" && at.map(|t| (now - t).num_seconds() >= WORKING_STALE_S).unwrap_or(false) {
        note = format!("⚠ {note} — not mid-turn, no report since");
    }
    note
}

struct Tree<'a> {
    by_id: HashMap<i64, &'a Row>,
    kids: HashMap<Option<i64>, Vec<&'a Row>>,
    live: &'a HashMap<i64, Live>,
    now: DateTime<Utc>,
    me: i64,
    hidden: usize,
}

impl<'a> Tree<'a> {
    #[nolog]
    fn subtree_all_dead(&self, id: i64) -> (bool, usize) {
        let mut n = 1;
        let mut dead = self.by_id.get(&id).map(|r| r.state != "live").unwrap_or(true);
        for k in self.kids.get(&Some(id)).map(Vec::as_slice).unwrap_or(&[]) {
            let (d, c) = self.subtree_all_dead(k.id);
            dead &= d;
            n += c;
        }
        (dead, n)
    }

    /// 3.x `_render_chart` (archived subtrees hidden, counted at their own indent).
    #[nolog]
    fn render(&mut self, roots: &[&'a Row], indent: usize, out: &mut Vec<String>) {
        let mut hidden_here = 0;
        for r in roots {
            if r.state != "live" {
                let (dead, n) = self.subtree_all_dead(r.id);
                if dead {
                    hidden_here += n;
                    continue;
                }
            }
            let mut tags: Vec<String> = Vec::new();
            if r.state != "live" {
                tags.push(r.state.clone());
            }
            if r.halted {
                tags.push("halted — explicit unhalt required".into());
            }
            let state = if tags.is_empty() { String::new() } else { format!(" ({})", tags.join(", ")) };
            let note = status_note(r, self.live.get(&r.id).copied().unwrap_or_default(), self.now);
            let note = if note.is_empty() { String::new() } else { format!(" · {note}") };
            let star = if r.id == self.me { "  ← you" } else { "" };
            out.push(format!("{}- {} [{}]{state}{note}{star}", "  ".repeat(indent), r.name, r.tier));
            let kids: Vec<&'a Row> = self.kids.get(&Some(r.id)).cloned().unwrap_or_default();
            self.render(&kids, indent + 1, out);
        }
        if hidden_here > 0 {
            self.hidden += hidden_here;
            out.push(format!("{}+ {hidden_here} archived here — hidden", "  ".repeat(indent)));
        }
    }
}

#[nolog]
fn names(rows: &[&Row]) -> Vec<String> {
    rows.iter().filter(|r| r.state == "live").map(|r| r.name.clone()).collect()
}

#[nolog]
fn digest(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// 3.x envelope.py `decide`: send the chart whole, or point at the last one.
#[nolog]
fn decide(prior: &Value, sid: &str, dig: &str, occ: i64, now: DateTime<Utc>) -> bool {
    let Some(p) = prior.as_object() else { return true };
    if sid.is_empty() || p.get("sid").and_then(Value::as_str) != Some(sid) {
        return true;
    }
    if p.get("dig").and_then(Value::as_str) != Some(dig) {
        return true;
    }
    let pocc = p.get("occ").and_then(Value::as_i64).unwrap_or(0);
    if occ > 0 && pocc > 0 && (occ < pocc || occ - pocc >= FULL_REFRESH_TOKENS) {
        return true;
    }
    if p.get("turns").and_then(Value::as_i64).unwrap_or(0) + 1 > FULL_REFRESH_TURNS {
        return true;
    }
    match p.get("at").and_then(Value::as_str).and_then(crate::util::parse_ts) {
        Some(at) if now >= at => (now - at).num_seconds() >= FULL_REFRESH_AGE_S,
        _ => true,
    }
}

/// The `[ORG STATE …]` block for one agent (3.x `org_state_block` with the
/// D-223 chart pointer). Small bounded reads; no locks.
#[logged]
pub async fn org_state(engine: &Arc<Engine>, agent_id: i64) -> Result<OrgState> {
    let client = engine.db.get().await?;
    let me = client
        .query_one(
            "SELECT a.org_id, a.name, a.parent_id, coalesce(a.scope->>'org_visibility', 'subtree'), a.seat::float8,
                    a.grant_credits::float8,
                    (SELECT coalesce(sum(c.seat + c.grant_credits), 0)::float8 FROM ot.agents c WHERE c.parent_id = a.id AND c.state = 'live'),
                    a.session_id, coalesce(a.occupancy, 0), a.extra->'envelope'->'org_state',
                    (SELECT p.name FROM ot.agents p WHERE p.id = a.parent_id),
                    EXISTS (SELECT 1 FROM ot.audiences u WHERE u.org_id = a.org_id AND u.grantee = a.name AND u.grantor = '@user'
                             AND u.revoked_at IS NULL AND NOT u.paused)
               FROM ot.agents a WHERE a.id = $1",
            &[&agent_id],
        )
        .await?;
    let org_id: i64 = me.get(0);
    let my_name: String = me.get(1);
    let parent: Option<i64> = me.get(2);
    // the effective visibility (narrowest along the chain), as 3.x org_state_block
    let vis: String = crate::tools::effective_visibility(&client, agent_id).await?;
    let (seat, grant, hold): (f64, f64, f64) = (me.get(4), me.get(5), me.get(6));
    let sid: Option<String> = me.get(7);
    let occ: i32 = me.get(8);
    let prior: Option<Value> = me.get(9);
    let superior: Option<String> = me.get(10);
    let user_audience: bool = me.get(11);
    let rows: Vec<Row> = client
        .query(
            "SELECT a.id, a.name, a.parent_id, a.tier, a.state, a.halt IS NOT NULL, a.last_status, a.inflight_at,
                    (SELECT t.started_at FROM ot.turns t WHERE t.agent_id = a.id ORDER BY t.id DESC LIMIT 1)
               FROM ot.agents a
              WHERE a.org_id = $1 AND a.state IN ('live', 'archived', 'unrecoverable')
              ORDER BY a.sibling_order, a.id LIMIT $2",
            &[&org_id, &MAX_AGENTS],
        )
        .await?
        .iter()
        .map(|r| Row {
            id: r.get(0),
            name: r.get(1),
            parent: r.get(2),
            tier: r.get(3),
            state: r.get(4),
            halted: r.get(5),
            status: r.get(6),
            inflight_at: r.get(7),
            last_turn: r.get(8),
        })
        .collect();
    let ask = client
        .query_opt(
            "SELECT kind, body, created_at FROM ot.asks WHERE agent_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1",
            &[&agent_id],
        )
        .await?
        .map(|a| (a.get::<_, String>(0), a.get::<_, Value>(1), a.get::<_, DateTime<Utc>>(2)));
    drop(client);
    let live: HashMap<i64, Live> = rows.iter().filter(|r| r.state == "live").map(|r| (r.id, live_of(engine, r.id))).collect();
    let facts = Facts {
        agent_id, my_name, parent, vis, seat, grant, hold, sid, occ: occ as i64, prior, superior, user_audience, rows, ask,
    };
    Ok(render(&facts, &live, Utc::now()))
}

/// Everything `render` reads, loaded in one go.
#[derive(Debug)]
struct Facts {
    agent_id: i64,
    my_name: String,
    parent: Option<i64>,
    vis: String,
    seat: f64,
    grant: f64,
    hold: f64,
    sid: Option<String>,
    occ: i64,
    prior: Option<Value>,
    superior: Option<String>,
    user_audience: bool,
    rows: Vec<Row>,
    /// the agent's open request: (kind, body, posed at)
    ask: Option<(String, Value, DateTime<Utc>)>,
}

/// The block from loaded facts (no IO).
#[nolog]
fn render(f: &Facts, live: &HashMap<i64, Live>, now: DateTime<Utc>) -> OrgState {
    let Facts { agent_id, my_name, parent, vis, seat, grant, hold, sid, occ, prior, superior, user_audience, rows, ask } = f;
    let (agent_id, parent, occ, vis) = (*agent_id, *parent, *occ, vis.as_str());
    let mut kids: HashMap<Option<i64>, Vec<&Row>> = HashMap::new();
    for r in rows {
        kids.entry(r.parent).or_default().push(r);
    }
    let by_id: HashMap<i64, &Row> = rows.iter().map(|r| (r.id, r)).collect();
    let mine = names(kids.get(&Some(agent_id)).map(Vec::as_slice).unwrap_or(&[]));
    let reports = if mine.is_empty() { "none yet".to_string() } else { mine.join(", ") };
    let roster = if vis == "self" {
        format!("Your reports: {reports}.")
    } else {
        let peers: Vec<String> = names(kids.get(&parent).map(Vec::as_slice).unwrap_or(&[]))
            .into_iter()
            .filter(|n| n.as_str() != my_name.as_str())
            .collect();
        let peers = if peers.is_empty() { "none".to_string() } else { peers.join(", ") };
        format!("Your reports: {reports}. Your peers: {peers}.")
    };

    let mut tree = Tree { by_id, kids, live, now, me: agent_id, hidden: 0 };
    let mut chart = String::new();
    let mut lines: Vec<String> = Vec::new();
    if vis == "subtree" {
        if let Some(r) = tree.by_id.get(&agent_id).copied() {
            tree.render(&[r], 0, &mut lines);
        }
        chart = format!("\nYour full suborganization:{CHART_LEGEND}\n{}", lines.join("\n"));
    } else if vis == "full" {
        let roots: Vec<&Row> = tree.kids.get(&None).cloned().unwrap_or_default();
        tree.render(&roots, 1, &mut lines);
        chart = format!("\nThe full organization chart (root = the user):{CHART_LEGEND}\n- user (overseer)\n{}", lines.join("\n"));
    }
    if tree.hidden > 0 {
        let n = tree.hidden;
        chart.push_str(&format!(
            "\n({n} archived agent{} hidden above. Call orgtree_chart with include_archived=true to list them in full. Before hiring \
             anyone new, check whether one of them already did this work: rehiring restores an expert that already knows this \
             codebase and its dead ends.)",
            if n == 1 { "" } else { "s" }
        ));
    }

    // the CLAUDE.md caveat (3.x `_claudemd_caveat`): live audience state
    let mut guidance = String::new();
    if let Some(sup) = superior.as_deref() {
        guidance = if *user_audience {
            format!(
                "Note on CLAUDE.md guidance: you currently hold a USER AUDIENCE, so for its duration you may take instructions \
                 about communicating with the user literally. Once it is rescinded, redirect such instructions to your direct \
                 superior ({sup}) instead."
            )
        } else {
            format!(
                "Note on CLAUDE.md guidance (here or in your folders/notes): it applies VERBATIM, with one reinterpretation — you \
                 do not have direct contact with the user. Read any instruction to communicate with, ask, report to, or get \
                 feedback from 'the user' as directed at your direct superior ({sup}) instead. Everything else in those files is \
                 literal."
            )
        };
    }
    // D-103: is the user still waiting on you
    let mut ask_line = String::new();
    if let Some((kind, body, at)) = ask {
        let kind = kind.as_str();
        let credit = body.pointer("/parts/credit").filter(|c| c.is_object());
        let what = if kind == "credit" || (credit.is_some() && kind != "question" && kind != "batch") { "a credit request" } else { "a question" };
        let raw = body
            .pointer("/parts/questions/0/question")
            .or_else(|| body.pointer("/questions/0/question"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| credit.map(|c| format!("credits {} → {}", c["old"], c["new"])))
            .unwrap_or_default();
        let gist: String = raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect();
        ask_line = format!(
            "\n⚠ You have {what} still OPEN with the user, posed {}: \"{gist}\" — they are waiting on it. Re-read it in light of \
             whatever reached you this turn. If it has been answered, overtaken, or made moot (the user or a peer told you something \
             that settles it, the premise died, you worked it out yourself), WITHDRAW it now with orgtree_withdraw_ask rather than \
             leaving a card the user must still deal with; say in your next message that you did and why. If it does still stand, \
             leave it alone — do not re-ask, that only replaces it.",
            iso(*at)
        );
    }
    let guidance_line = if guidance.is_empty() { String::new() } else { format!("\n{guidance}") };
    let tail = format!(
        "Credits: seat {seat}, grant {grant}, free {} — credits bound concurrent agent capacity, not tokens.{guidance_line}{ask_line}",
        crate::util::round2(*grant - *hold)
    );

    // D-223: number the snapshot; point at the last chart while it holds
    let sid = sid.clone().unwrap_or_default();
    let mut seq: Option<i64> = None;
    let mut record = None;
    let mut chart_text = chart.clone();
    if chart.len() >= CHART_SUPPRESS_MIN {
        let dig = digest(&chart);
        let prior = prior.clone().unwrap_or(Value::Null);
        let full = decide(&prior, &sid, &dig, occ, now);
        let pseq = prior.get("seq").and_then(Value::as_i64);
        let n = if full || pseq.is_none() { pseq.unwrap_or(0) + 1 } else { pseq.unwrap_or(1) };
        seq = Some(n);
        if full || pseq.is_none() {
            record = Some(json!({ "seq": n, "dig": dig, "sid": sid, "at": iso(now), "occ": occ, "turns": 0 }));
        } else {
            let turns = prior.get("turns").and_then(Value::as_i64).unwrap_or(0) + 1;
            let mut p = prior.clone();
            p["turns"] = json!(turns);
            record = Some(p);
            chart_text = format!(
                "\n(Chart unchanged since #{n}: {} rows, read it there — or call orgtree_chart for a fresh one.)",
                chart.matches('\n').count()
            );
        }
    }
    let header = format!(
        "{ORG_STATE_OPEN}{} — current as of {}. Newest wins; EARLIER COPIES IN THIS CONVERSATION ARE STALE.]",
        seq.map(|n| format!(" #{n}")).unwrap_or_default(),
        iso(now)
    );
    OrgState { text: format!("{header}\n{roster}{chart_text}\n{tail}\n{ORG_STATE_CLOSE}"), record }
}

/// Store the D-223 record once the turn's text reached the CLI.
#[logged]
pub async fn commit(engine: &Engine, agent_id: i64, record: &Value) -> Result<()> {
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.agents SET extra = jsonb_set(jsonb_set(extra, '{envelope}', coalesce(extra->'envelope', '{}'::jsonb)),
                                                    '{envelope,org_state}', $2)
              WHERE id = $1",
            &[&agent_id, record],
        )
        .await?;
    Ok(())
}

// ------------------------------------------------------------------ mail

/// How the sender stands to the recipient (3.x `Org.relationship`).
#[logged]
pub async fn relationships(engine: &Engine, agent_id: i64, senders: &[String]) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let agents: Vec<String> = senders.iter().filter(|s| !s.starts_with('@')).cloned().collect();
    if agents.is_empty() {
        return Ok(out);
    }
    let client = engine.db.get().await?;
    let me = client.query_one("SELECT org_id, name, parent_id FROM ot.agents WHERE id = $1", &[&agent_id]).await?;
    let org_id: i64 = me.get(0);
    let my_name: String = me.get(1);
    let my_parent: Option<i64> = me.get(2);
    let ancestors: Vec<String> = client
        .query(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
                SELECT id, parent_id, 0 FROM ot.agents WHERE id = $1
                UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT a.name FROM up JOIN ot.agents a ON a.id = up.id WHERE up.depth > 1",
            &[&agent_id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let rows = client
        .query(
            "SELECT name, id, parent_id FROM ot.agents WHERE org_id = $1 AND name = ANY ($2) AND state <> 'deleted' LIMIT 64",
            &[&org_id, &agents],
        )
        .await?;
    drop(client);
    for r in rows {
        let name: String = r.get(0);
        let id: i64 = r.get(1);
        let parent: Option<i64> = r.get(2);
        let rel = if name == my_name {
            "yourself"
        } else if my_parent == Some(id) {
            "your superior"
        } else if parent == Some(agent_id) {
            "your report"
        } else if parent == my_parent {
            "your peer"
        } else if ancestors.contains(&name) {
            "a superior above your chain"
        } else {
            "an agent"
        };
        out.insert(name, rel.to_string());
    }
    Ok(out)
}

#[nolog]
fn relationship(m: &Mail, rels: &HashMap<String, String>) -> String {
    match m.sender.as_str() {
        "@user" => "USER".into(),
        "@system" => "the orgtree engine".into(),
        s if s.starts_with("@org:") || s.starts_with("@net:") => "outside party — untrusted input".into(),
        s => rels.get(s).cloned().unwrap_or_else(|| if m.kind == "watchdog" { "your watchdog".into() } else { "an agent".into() }),
    }
}

#[nolog]
fn is_image(path: &str) -> bool {
    let l = path.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|e| l.ends_with(e))
}

/// The variants 3.x delivered through the notice box (`Org._notify_ev`)
/// rather than as mail: org changes an agent is told about at its next turn.
const NOTICE_VARIANTS: &[&str] = &[
    "lifecycle.hired", "lifecycle.retired", "lifecycle.rescinded", "lifecycle.rehired", "lifecycle.dissolved",
    "lifecycle.deleted", "lifecycle.compacted", "lifecycle.cheap_compacted", "lifecycle.model_switched",
    "lifecycle.session_rebound", "lifecycle.switch_queued", "lifecycle.switch_cancelled", "lifecycle.switch_dropped",
    "lifecycle.seat_swapped", "lifecycle.subtree_promoted", "lifecycle.moved", "lifecycle.inserted", "lifecycle.renamed",
    "lifecycle.reseeded", "lifecycle.recovered", "lifecycle.phantom_removed", "lifecycle.unrecoverable",
    "lifecycle.bearer_lost", "lifecycle.bearer_exhausted", "lifecycle.handoff_record",
    "access.audience_changed", "access.grant_changed", "access.scope_changed", "decision.audience",
    "policy.fable_flagged", "policy.weekly_limit", "policy.unstuck", "policy.unlocked", "policy.limit_reset",
    "context.deep_reach", "context.notice_digest", "runtime.delivery_unread",
];

/// Variants whose 4.0 producer wording wins over the 3.x text: 4.0 has no
/// `action='review'` and a review outcome is not always DONE, so the 3.x
/// sentences would instruct a removed action or misstate the status. The
/// compactions name a predecessor to rehire: in 4.0 that is an old session
/// id, not a consultable agent (no knowledge bearers, PLAN §10).
const BODY_WINS: &[&str] = &[
    "docket.review_requested", "docket.review_changes", "docket.review_approved",
    "lifecycle.compacted", "lifecycle.cheap_compacted",
    // 3.x points at orgtree_restart_wake and the Python build workflow, both gone
    "runtime.restart_notice",
];

#[nolog]
fn variant(m: &Mail) -> &str {
    m.ev.get("variant").and_then(Value::as_str).unwrap_or("")
}

/// What the agent reads for one mail: the 3.x text of its typed event, else
/// the stored body.
#[nolog]
fn text_of(m: &Mail) -> String {
    let v = variant(m);
    // a cross-provider switch's 3.x text also offers the predecessor for rehire
    let crossed = v == "lifecycle.model_switched" && m.ev.get("crossed").and_then(Value::as_bool).unwrap_or(false);
    if v.is_empty() || BODY_WINS.contains(&v) || crossed {
        return m.body.clone();
    }
    crate::runtime::event_text::render_agent(&m.ev).unwrap_or_else(|| m.body.clone())
}

/// Sort delivered mail into 3.x's two blocks: org-change notices
/// (`(at, text)`, led by the fresh-session `handoff` note) and real mail.
#[logged]
pub fn split_notices<'a>(mail: &'a [Mail], handoff: Option<&str>) -> (Vec<(String, String)>, Vec<&'a Mail>) {
    let mut notices: Vec<(String, String)> = Vec::new();
    if let Some(h) = handoff {
        let h = h.strip_prefix("[Orgtree] ").unwrap_or(h);
        notices.push((iso(chrono::Utc::now()), h.trim_end().to_string()));
    }
    let mut rest = Vec::new();
    for m in mail {
        if m.sender == "@system" && m.notice && NOTICE_VARIANTS.contains(&variant(m)) {
            notices.push((iso(m.at), text_of(m).trim_end().to_string()));
        } else {
            rest.push(m);
        }
    }
    (notices, rest)
}

/// 3.x `[ORG NOTICES — N change(s) since your last turn] … [END NOTICES]`.
#[logged]
pub fn notices_block(notices: &[(String, String)]) -> String {
    let lines: Vec<String> = notices.iter().map(|(at, text)| format!("- {at}: {text}")).collect();
    format!("[ORG NOTICES — {} change(s) since your last turn]\n{}\n[END NOTICES]", notices.len(), lines.join("\n"))
}

/// 3.x `_mail_block`: `[MAIL — N message(s)] … [END MAIL]`. `turn_start`
/// says whether images can be loaded into context (a turn's opening
/// message) or not (mid-turn delivery is text only).
#[logged]
pub fn mail_block(mail: &[&Mail], rels: &HashMap<String, String>, turn_start: bool) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for m in mail {
        let from = if m.sender == "@user" { "user" } else if m.sender == "@system" { "orgtree" } else { m.sender.as_str() };
        let tag = if m.sender == "@user" { " ⚠ THE USER — user instructions outrank your chain" } else { "" };
        let rel = relationship(m, rels);
        let at = iso(m.at);
        // the id an answer names (orgtree_message `reply_to`)
        let id = if m.uid.is_empty() { String::new() } else { format!(" · id {}", m.uid) };
        let mut b = if m.notice {
            format!("NOTICE FROM {from} ({rel}{tag}) · {at}{id} — informational, delivered passively; no reply is expected")
        } else {
            format!("FROM {from} ({rel}{tag}) · {} · {at}{id}", m.kind)
        };
        if m.urgent {
            b.push_str(" · URGENT");
        }
        if let Some(g) = m.reply_to.get("gist").or_else(|| m.reply_to.get("quoted_context")).and_then(Value::as_str) {
            if !g.trim().is_empty() {
                let who = m.reply_to.get("from").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
                let owner = who.map(|w| format!("{w}'s message")).unwrap_or_else(|| "your message".into());
                let qat = m.reply_to.get("at").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
                b.push_str(&format!("\n↩ IN REPLY TO {owner}{}: “{g}”", qat.map(|a| format!(" of {a}")).unwrap_or_default()));
            }
        }
        // someone over the mail hub reads only what is sent to them (user 2026-10-09)
        if !m.notice && m.sender.starts_with("@net:") {
            b.push_str(&format!("\n↳ Answer with orgtree_message to {}: a reply only in your turn's text never reaches them.", m.sender));
        }
        b.push('\n');
        b.push_str(text_of(m).trim_end());
        for a in m.attachments.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let path = a.get("path").and_then(Value::as_str).unwrap_or("");
            let bytes = a.get("bytes").and_then(Value::as_u64).or_else(|| std::fs::metadata(Path::new(path)).ok().map(|m| m.len()));
            let size = match bytes {
                Some(n) if n < 1024 => format!("{n} B"),
                Some(n) => format!("{} KB", (n as f64 / 1024.0).round() as u64),
                None => "size unknown".into(),
            };
            b.push_str(&format!("\n[ATTACHED FILE: {path} ({size}) — read it from there]"));
            if !is_image(path) {
                continue;
            }
            if !turn_start {
                b.push_str(&format!(
                    "\n  ↳ an IMAGE. Mid-turn delivery is text-only, so it was NOT loaded into your context and will NOT load later \
                     — this message has already been delivered. Read {path} now if you need to see it."
                ));
            } else if bytes.map(|n| n >= IMAGE_MAX).unwrap_or(true) {
                b.push_str("\n  ↳ an IMAGE, NOT loaded into your context: it is unreadable or larger than 5 MB. Read it if you need it.");
            }
        }
        blocks.push(b);
    }
    format!("[MAIL — {} message(s)]\n{}\n[END MAIL]", mail.len(), blocks.join("\n---\n"))
}

