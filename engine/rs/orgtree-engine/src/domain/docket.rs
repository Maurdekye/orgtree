//! The docket: the org's durable record of substantive work. An item is
//! named by a readable slug fixed at creation; its owner holds it and gets
//! the user's replies. Lean by design (ledger F2–F6): no acceptance checks,
//! review seats or verdicts, receipts, artifacts, findings or addenda —
//! `review` and `approved` are ordinary statuses and evidence is a note.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use tokio_postgres::GenericClient;

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::refuse;
use crate::util::{gist, iso, slugify};

pub const STATUSES: &[&str] =
    &["backlogged", "open", "in_progress", "blocked", "review", "approved", "deploy_ready", "done", "superseded", "dropped"];
/// What an update may set (`superseded` comes only from the supersede action).
const SETTABLE: &[&str] = &["backlogged", "open", "in_progress", "blocked", "review", "approved", "deploy_ready", "done", "dropped"];
/// What a new item may start as.
const STARTS: &[&str] = &["backlogged", "open", "in_progress", "blocked", "review", "approved", "deploy_ready"];
pub const CLOSED: &[&str] = &["done", "superseded", "dropped"];
const ARCHIVE_AFTER_S: i64 = 3600;
const ACTIVE_MAX: i64 = 200;
const SLUG_MAX: usize = 48;
const TITLE_MAX: usize = 200;
const ENTRY_MAX: usize = 500;
const ENTRIES_MAX: usize = 40;
const BLOCKED_MAX: usize = 2000;
const DROPPED_MAX: usize = 1500;
const ATTENTION_MAX: usize = 1500;
const EVIDENCE_MAX: usize = 50;
const REF_MAX: usize = 500;
const EVIDENCE_KINDS: &[&str] = &["note", "link", "file", "commit", "log"];
const HISTORY_SHOWN: i64 = 100;
pub const ATTACHMENT_MAX: usize = 25 * 1024 * 1024;
/// The fields a list row carries; the rest come with the opened item.
const LIST_FIELDS: &[&str] = &[
    "slug", "ref", "rev", "kind", "title", "objective", "status", "owner", "reviewer", "created_by", "at", "updated_at",
    "done_so_far", "working_on_next", "docket_at", "last_updater", "manual_attention", "next_action", "objective_notice",
    "post_completion", "status_at", "superseded_by", "parent", "parent_visible", "legacy_status", "blocked_reason",
    "waiting_reason", "dropped_reason", "participants", "reply_recipients", "archived", "archived_at", "owner_current",
    "owner_state", "questions", "superseded_by_visible", "effective_attention", "attention_sources", "dependencies",
];
const SUMMARY_FIELDS: &[&str] = &[
    "slug", "ref", "rev", "title", "kind", "status", "owner", "reviewer", "participants", "parent", "docket_at",
    "effective_attention", "attention_sources", "blocked_reason", "dropped_reason", "superseded_by", "archived",
];
const COMPACT_EXTRA: &[&str] = &[
    "objective", "done_so_far", "working_on_next", "dependencies", "manual_attention", "questions", "last_updater",
    "status_at", "evidence",
];

/// Who acts on the docket.
#[derive(Debug, Clone)]
pub enum Who {
    User,
    Agent { id: i64, name: String, generation: i32 },
}

#[logged]
impl Who {
    #[nolog]
    pub fn actor(&self) -> Value {
        match self {
            Who::User => json!("user"),
            Who::Agent { name, generation, .. } => json!({ "node": name, "generation": generation }),
        }
    }

    #[nolog]
    pub fn label(&self) -> String {
        match self {
            Who::User => "the user".into(),
            Who::Agent { name, .. } => name.clone(),
        }
    }

    #[nolog]
    fn name(&self) -> Option<&str> {
        match self {
            Who::User => None,
            Who::Agent { name, .. } => Some(name.as_str()),
        }
    }

    #[nolog]
    fn id(&self) -> Option<i64> {
        match self {
            Who::User => None,
            Who::Agent { id, .. } => Some(*id),
        }
    }
}

/// A `work_items` row.
#[derive(Debug, Clone)]
pub struct Item {
    pub id: i64,
    pub slug: String,
    pub rev: i64,
    pub kind: String,
    pub title: String,
    pub objective: String,
    pub status: String,
    pub blocked_reason: Option<String>,
    pub dropped_reason: Option<String>,
    pub owner: Option<Value>,
    pub owner_id: Option<i64>,
    pub reviewer: Option<Value>,
    pub reviewer_id: Option<i64>,
    pub created_by: Value,
    pub last_updater: Option<Value>,
    pub participants: Vec<String>,
    pub parent: Option<String>,
    pub dependencies: Vec<String>,
    pub superseded_by: Option<String>,
    pub done: Value,
    pub next: Value,
    pub attention: Option<Value>,
    pub dismissals: Value,
    pub evidence: Value,
    pub accepted: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub docket_at: Option<DateTime<Utc>>,
    pub status_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    pub extra: Value,
}

const COLS: &str = "id, slug, rev, kind, title, objective, status, blocked_reason, dropped_reason, owner, owner_agent_id, reviewer,
    reviewer_agent_id, created_by, last_updater, participants, parent, dependencies, superseded_by, done_so_far, working_on_next,
    manual_attention, dismissals, evidence, accepted, created_at, updated_at, docket_at, status_at, archived_at, extra";

fn item_of(r: &tokio_postgres::Row) -> Item {
    Item {
        id: r.get(0),
        slug: r.get(1),
        rev: r.get(2),
        kind: r.get(3),
        title: r.get(4),
        objective: r.get(5),
        status: r.get(6),
        blocked_reason: r.get(7),
        dropped_reason: r.get(8),
        owner: r.get(9),
        owner_id: r.get(10),
        reviewer: r.get(11),
        reviewer_id: r.get(12),
        created_by: r.get(13),
        last_updater: r.get(14),
        participants: r.get(15),
        parent: r.get(16),
        dependencies: r.get(17),
        superseded_by: r.get(18),
        done: r.get(19),
        next: r.get(20),
        attention: r.get(21),
        dismissals: r.get(22),
        evidence: r.get(23),
        accepted: r.get(24),
        created_at: r.get(25),
        updated_at: r.get(26),
        docket_at: r.get(27),
        status_at: r.get(28),
        archived_at: r.get(29),
        extra: r.get(30),
    }
}

#[logged]
impl Item {
    #[nolog]
    pub fn owner_name(&self) -> Option<&str> {
        self.owner.as_ref().and_then(|o| o["node"].as_str())
    }

    #[nolog]
    fn reviewer_name(&self) -> Option<&str> {
        self.reviewer.as_ref().and_then(|o| o["node"].as_str())
    }

    #[nolog]
    fn creator_name(&self) -> Option<&str> {
        self.created_by["node"].as_str()
    }

    #[nolog]
    fn closed(&self) -> bool {
        CLOSED.contains(&self.status.as_str())
    }

    #[nolog]
    fn deleted(&self) -> bool {
        self.extra["deleted"].as_bool().unwrap_or(false)
    }

    #[nolog]
    fn clock(&self) -> DateTime<Utc> {
        self.docket_at.unwrap_or(self.updated_at)
    }
}

// ------------------------------------------------------------ reading

/// What a view needs beyond the row itself.
#[derive(Debug, Default)]
pub struct Ctx {
    org: String,
    now: DateTime<Utc>,
    /// the org's agents (not deleted) by name: (id, state, parent)
    agents: HashMap<String, (i64, String, Option<i64>)>,
    /// open questions attached to each item
    questions: HashMap<String, Vec<Value>>,
    /// every item's (title, status), for dependency and parent rows
    titles: HashMap<String, (String, String)>,
}

#[logged]
pub async fn ctx(client: &impl GenericClient, org: &OrgHandle) -> Result<Ctx> {
    let mut c = Ctx { org: org.slug.clone(), now: Utc::now(), ..Default::default() };
    for r in client
        .query("SELECT name, id, state, parent_id FROM ot.agents WHERE org_id = $1 AND state <> 'deleted'", &[&org.id])
        .await?
    {
        c.agents.insert(r.get(0), (r.get(1), r.get(2), r.get(3)));
    }
    for r in client
        .query(
            "SELECT k.uid, a.name, k.rev, k.created_at, k.body, k.work_items FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
              WHERE k.org_id = $1 AND k.status = 'open' AND cardinality(k.work_items) > 0",
            &[&org.id],
        )
        .await?
    {
        let body: Value = r.get(4);
        let items: Vec<String> = r.get(5);
        let qs = body["questions"].as_array().cloned().unwrap_or_default();
        for slug in items {
            let mut tabs: Vec<Value> = Vec::new();
            for (i, q) in qs.iter().enumerate() {
                if q["work_item"].as_str().map(|w| w == slug).unwrap_or(true) {
                    let mut t = json!({ "index": i, "question": q["question"].clone() });
                    for k in ["header", "options", "multi"] {
                        if let Some(v) = q.get(k).filter(|v| !v.is_null()) {
                            t[k] = v.clone();
                        }
                    }
                    tabs.push(t);
                }
            }
            c.questions.entry(slug).or_default().push(json!({
                "ask_id": r.get::<_, String>(0), "node": r.get::<_, String>(1), "rev": r.get::<_, i32>(2),
                "at": iso(r.get(3)), "tabs": tabs,
            }));
        }
    }
    for r in client
        .query(
            "SELECT slug, title, status FROM ot.work_items WHERE org_id = $1 AND NOT coalesce((extra->>'deleted')::boolean, false)",
            &[&org.id],
        )
        .await?
    {
        c.titles.insert(r.get(0), (r.get(1), r.get(2)));
    }
    Ok(c)
}

fn attention_sources(it: &Item, ctx: &Ctx) -> Vec<&'static str> {
    let mut s = Vec::new();
    if it.attention.is_some() {
        s.push("manual");
    }
    if ctx.questions.get(&it.slug).map(|q| !q.is_empty()).unwrap_or(false) {
        s.push("question");
    }
    s
}

/// Archived (derived): physically archived, dropped, or closed an hour ago —
/// and never while it holds the user's attention.
fn archived(it: &Item, ctx: &Ctx) -> bool {
    if !attention_sources(it, ctx).is_empty() {
        return false;
    }
    it.archived_at.is_some()
        || it.status == "dropped"
        || (matches!(it.status.as_str(), "done" | "superseded") && (ctx.now - it.clock()).num_seconds() > ARCHIVE_AFTER_S)
}

/// (current, state) of a holder reference.
fn holder_state(h: &Option<Value>, ctx: &Ctx) -> (bool, Value) {
    let Some(h) = h else { return (false, Value::Null) };
    let Some(name) = h["node"].as_str() else { return (false, Value::Null) };
    if h["deleted"].as_bool().unwrap_or(false) {
        return (false, json!("missing"));
    }
    match ctx.agents.get(name) {
        Some((_, state, _)) if state == "live" => (true, json!("live")),
        Some((_, state, _)) if state == "archived" => (false, json!("retired")),
        _ => (false, json!("missing")),
    }
}

fn agent_state(name: &str, ctx: &Ctx) -> &'static str {
    match ctx.agents.get(name).map(|a| a.1.as_str()) {
        Some("live") => "live",
        Some("archived") => "retired",
        _ => "missing",
    }
}

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// The `WorkItem` the docket renders. `detail` adds history and attachments.
/// (Called per row: not logged.)
pub fn view(it: &Item, ctx: &Ctx, detail: Option<(&[Value], &[Value])>) -> Value {
    let sources = attention_sources(it, ctx);
    let is_archived = archived(it, ctx);
    let (owner_current, owner_state) = holder_state(&it.owner, ctx);
    let questions = ctx.questions.get(&it.slug).cloned().unwrap_or_default();
    let next_action = if it.closed() {
        Value::Null
    } else if it.status == "review" && it.reviewer_name().is_some() {
        json!({ "node": it.reviewer_name(), "role": "reviewer" })
    } else if let Some(o) = it.owner_name() {
        json!({ "node": o, "role": if it.status == "deploy_ready" { "deployer" } else { "owner" } })
    } else {
        Value::Null
    };
    let mut recipients: Vec<Value> = Vec::new();
    if let Some(o) = it.owner_name() {
        recipients.push(json!({ "node": o, "role": "owner", "state": agent_state(o, ctx) }));
    }
    for p in &it.participants {
        if Some(p.as_str()) != it.owner_name() {
            recipients.push(json!({ "node": p, "role": "participant", "state": agent_state(p, ctx) }));
        }
    }
    let deps: Vec<Value> = it
        .dependencies
        .iter()
        .map(|d| match ctx.titles.get(d) {
            Some((t, s)) => json!({ "slug": d, "visible": true, "title": t, "status": s }),
            None => json!({ "visible": false }),
        })
        .collect();
    let archived_at = if is_archived {
        json!(iso(it.archived_at.unwrap_or_else(|| if it.status == "dropped" { it.clock() } else { it.clock() + chrono::Duration::seconds(ARCHIVE_AFTER_S) })))
    } else {
        json!(it.archived_at.map(iso))
    };
    let mut v = json!({
        "slug": it.slug,
        "ref": format!("@item:{}/{}", ctx.org, it.slug),
        "rev": it.rev,
        "kind": it.kind,
        "title": it.title,
        "objective": it.objective,
        "objective_notice": null,
        "status": it.status,
        "legacy_status": null,
        "blocked_reason": it.blocked_reason,
        "waiting_reason": null,
        "dropped_reason": it.dropped_reason,
        "archived": is_archived,
        "archived_at": archived_at,
        "owner": it.owner,
        "owner_current": owner_current,
        "owner_state": owner_state,
        "next_action": next_action,
        "reviewer": it.reviewer,
        "participants": it.participants,
        "reply_recipients": recipients,
        "created_by": it.created_by,
        "at": iso(it.created_at),
        "updated_at": iso(it.updated_at),
        "done_so_far": it.done,
        "working_on_next": it.next,
        "post_completion": null,
        "docket_at": it.docket_at.map(iso),
        "status_at": iso(it.status_at.unwrap_or(it.created_at)),
        "last_updater": it.last_updater,
        "manual_attention": it.attention,
        "dismissals": it.dismissals,
        "questions": questions,
        "effective_attention": !sources.is_empty(),
        "attention_sources": sources,
        "acceptance": [],
        "dependencies": deps,
        "parent": it.parent,
        "parent_visible": it.parent.as_ref().map(|p| ctx.titles.contains_key(p)),
        "evidence": it.evidence,
        "delivery": null,
        "accepted": it.accepted,
        "superseded_by": it.superseded_by,
        "superseded_by_visible": it.superseded_by.as_ref().map(|s| ctx.titles.contains_key(s)),
    });
    if let Some((history, attachments)) = detail {
        v["history"] = json!(history);
        v["attachments"] = json!(attachments);
    }
    v
}

/// A light list row: the list fields, marked with its own revision.
fn list_row(full: &Value) -> Value {
    let mut o = Map::new();
    for k in LIST_FIELDS {
        if let Some(v) = full.get(*k) {
            o.insert((*k).to_string(), v.clone());
        }
    }
    o.insert("view".into(), json!("list"));
    let rev = fnv(&serde_json::to_vec(&o).unwrap_or_default());
    o.insert("view_revision".into(), json!(rev));
    Value::Object(o)
}

fn sort_rows(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        let ka = (a["docket_at"].as_str().or(a["updated_at"].as_str()).unwrap_or(""), a["slug"].as_str().unwrap_or(""));
        let kb = (b["docket_at"].as_str().or(b["updated_at"].as_str()).unwrap_or(""), b["slug"].as_str().unwrap_or(""));
        kb.cmp(&ka)
    });
}

/// The user's docket view: the main list (attention rows always on it), and
/// the archive and the backlog when asked for.
#[logged]
pub async fn user_list(engine: &Engine, org: &OrgHandle, with_archived: bool, with_backlogged: bool, revision: &str) -> Result<Value> {
    let client = engine.db.get().await?;
    let ctx = ctx(&**client, org).await?;
    let asked: Vec<String> = ctx.questions.keys().cloned().collect();
    let sql = if with_archived {
        format!("SELECT {COLS} FROM ot.work_items WHERE org_id = $1 AND NOT coalesce((extra->>'deleted')::boolean, false) AND $2::text[] IS NOT NULL")
    } else {
        format!(
            "SELECT {COLS} FROM ot.work_items WHERE org_id = $1 AND NOT coalesce((extra->>'deleted')::boolean, false)
               AND (archived_at IS NULL OR manual_attention IS NOT NULL OR slug = ANY($2))"
        )
    };
    let rows = client.query(&sql, &[&org.id, &asked]).await?;
    let mut items = Vec::new();
    let mut arch = Vec::new();
    let mut back = Vec::new();
    for r in &rows {
        let it = item_of(r);
        let full = view(&it, &ctx, None);
        let row = list_row(&full);
        if full["archived"].as_bool().unwrap_or(false) {
            arch.push(row);
        } else if it.status == "backlogged" && !full["effective_attention"].as_bool().unwrap_or(false) {
            back.push(row);
        } else {
            items.push(row);
        }
    }
    let archived_n = if with_archived {
        arch.len() as i64
    } else {
        let hidden: i64 = client
            .query_one(
                "SELECT count(*) FROM ot.work_items WHERE org_id = $1 AND NOT coalesce((extra->>'deleted')::boolean, false)
                   AND archived_at IS NOT NULL AND manual_attention IS NULL AND NOT (slug = ANY($2))",
                &[&org.id, &asked],
            )
            .await?
            .get(0);
        hidden + arch.len() as i64
    };
    sort_rows(&mut items);
    sort_rows(&mut arch);
    sort_rows(&mut back);
    let attention_n = items.iter().chain(back.iter()).filter(|v| v["effective_attention"].as_bool().unwrap_or(false)).count();
    let active_n = items
        .iter()
        .filter(|v| {
            let s = v["status"].as_str().unwrap_or("");
            !CLOSED.contains(&s) && s != "backlogged"
        })
        .count();
    let backlogged_n = back.len();
    let references: Vec<Value> = items
        .iter()
        .chain(arch.iter())
        .chain(back.iter())
        .map(|r| {
            json!({ "slug": r["slug"], "title": r["title"], "parent": r["parent"], "archived": r["archived"],
                    "status": r["status"], "rev": r["rev"], "view_revision": r["view_revision"] })
        })
        .collect();
    let attention: Vec<Value> = items.iter().chain(back.iter()).filter(|r| !r["manual_attention"].is_null()).cloned().collect();
    let mut out = json!({
        "revision": revision,
        "counts": { "attention": attention_n, "active": active_n, "archived": archived_n, "backlogged": backlogged_n },
        "references": references,
        "attention": attention,
        "items": items,
        "now": iso(ctx.now),
    });
    if with_archived {
        out["archived"] = json!(arch);
    }
    if with_backlogged {
        out["backlogged"] = json!(back);
    }
    Ok(out)
}

#[logged]
async fn load(client: &impl GenericClient, org_id: i64, slug: &str, lock: bool) -> Result<Item> {
    let sql = format!(
        "SELECT {COLS} FROM ot.work_items WHERE org_id = $1 AND slug = $2{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    let slug = slug.trim().trim_start_matches("@item:");
    let slug = slug.rsplit('/').next().unwrap_or(slug);
    match client.query_opt(&sql, &[&org_id, &slug]).await? {
        Some(r) => {
            let it = item_of(&r);
            if it.deleted() {
                refuse!(NotFound, "docket item {slug} was deleted");
            }
            Ok(it)
        }
        None => refuse!(NotFound, "no docket item named {slug} (the slug is its only name; orgtree_work list shows them)"),
    }
}

/// History rows and attachments of one item.
#[logged]
async fn detail(client: &impl GenericClient, it: &Item) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut history: Vec<Value> = client
        .query(
            "SELECT at, by, op, detail FROM ot.work_events WHERE work_id = $1 ORDER BY id DESC LIMIT $2",
            &[&it.id, &HISTORY_SHOWN],
        )
        .await?
        .iter()
        .map(|r| {
            let mut h = json!({ "at": iso(r.get(0)), "by": r.get::<_, Value>(1), "op": r.get::<_, String>(2) });
            if let Value::Object(d) = r.get::<_, Value>(3) {
                for (k, v) in d {
                    if !v.is_null() {
                        h[k] = v;
                    }
                }
            }
            h
        })
        .collect();
    history.reverse();
    let attachments: Vec<Value> = client
        .query("SELECT id, at, by, name, bytes FROM ot.work_attachments WHERE work_id = $1 ORDER BY at", &[&it.id])
        .await?
        .iter()
        .map(|r| json!({ "id": r.get::<_, String>(0), "at": iso(r.get(1)), "by": r.get::<_, Value>(2),
                         "name": r.get::<_, String>(3), "bytes": r.get::<_, i64>(4) }))
        .collect();
    Ok((history, attachments))
}

/// One item, whole, for the user.
#[logged]
pub async fn user_get(engine: &Engine, org: &OrgHandle, slug: &str) -> Result<Value> {
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    let ctx = ctx(&**client, org).await?;
    let (h, a) = detail(&**client, &it).await?;
    Ok(view(&it, &ctx, Some((&h, &a))))
}

// ------------------------------------------------------------ authority

/// How far `who` reaches into an item.
#[derive(Debug, PartialEq, PartialOrd, Clone, Copy)]
enum Level {
    None,
    State,
    Manage,
}

/// The agent ids strictly below `id`.
#[logged]
async fn below(client: &impl GenericClient, id: i64) -> Result<HashSet<i64>> {
    Ok(client
        .query(
            "WITH RECURSIVE down(id, depth) AS (SELECT $1::bigint, 0 UNION ALL
               SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id WHERE d.depth < 1024)
             SELECT id FROM down WHERE depth > 0",
            &[&id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

fn level(who: &Who, it: &Item, ctx: &Ctx, under: &HashSet<i64>) -> Level {
    let Who::Agent { name, .. } = who else { return Level::Manage };
    let me = name.as_str();
    let is_below = |n: Option<&str>| n.and_then(|n| ctx.agents.get(n)).map(|a| under.contains(&a.0)).unwrap_or(false);
    if it.owner_name() == Some(me) || it.creator_name() == Some(me) || is_below(it.owner_name()) || is_below(it.creator_name()) {
        return Level::Manage;
    }
    if it.participants.iter().any(|p| p == me) || it.reviewer_name() == Some(me) {
        return Level::State;
    }
    Level::None
}

// ------------------------------------------------------------ writing

fn text_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn bounded(field: &str, v: &str, max: usize) -> Result<String> {
    let n = v.chars().count();
    if n > max {
        refuse!(BadRequest, "{field} is {n} characters; the limit is {max} — the whole call is refused (nothing written), never truncated");
    }
    Ok(v.to_string())
}

/// A progress list: individual nonblank entries, each bounded.
fn entries(field: &str, v: &Value) -> Result<Option<Vec<String>>> {
    let list: Vec<String> = match v {
        Value::Null => return Ok(None),
        Value::String(s) => s.lines().map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim().to_string()).collect(),
        Value::Array(a) => a.iter().map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())).collect(),
        _ => refuse!(BadRequest, "{field} is a list of entries"),
    };
    let list: Vec<String> = list.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if list.len() > ENTRIES_MAX {
        refuse!(BadRequest, "{field} has {} entries; the limit is {ENTRIES_MAX}", list.len());
    }
    for e in &list {
        bounded(field, e, ENTRY_MAX)?;
    }
    Ok(Some(list))
}

fn names(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().trim_start_matches('@').to_string()).filter(|s| !s.is_empty()).collect(),
        Value::String(s) => s.split(',').map(|x| x.trim().trim_start_matches('@').to_string()).filter(|x| !x.is_empty()).collect(),
        _ => Vec::new(),
    }
}

#[logged]
async fn save(tx: &impl GenericClient, it: &Item) -> Result<()> {
    tx.execute(
        "UPDATE ot.work_items SET rev = $2, kind = $3, title = $4, objective = $5, status = $6, blocked_reason = $7,
                dropped_reason = $8, owner = $9, owner_agent_id = $10, reviewer = $11, reviewer_agent_id = $12,
                last_updater = $13, participants = $14, parent = $15, dependencies = $16, superseded_by = $17,
                done_so_far = $18, working_on_next = $19, manual_attention = $20, dismissals = $21, evidence = $22,
                accepted = $23, updated_at = $24, docket_at = $25, status_at = $26, archived_at = $27, extra = $28
          WHERE id = $1",
        &[
            &it.id, &it.rev, &it.kind, &it.title, &it.objective, &it.status, &it.blocked_reason, &it.dropped_reason,
            &it.owner, &it.owner_id, &it.reviewer, &it.reviewer_id, &it.last_updater, &it.participants, &it.parent,
            &it.dependencies, &it.superseded_by, &it.done, &it.next, &it.attention, &it.dismissals, &it.evidence,
            &it.accepted, &it.updated_at, &it.docket_at, &it.status_at, &it.archived_at, &it.extra,
        ],
    )
    .await?;
    Ok(())
}

#[logged]
async fn history(tx: &impl GenericClient, it: &Item, who: &Who, op: &str, detail: Value) -> Result<()> {
    tx.execute(
        "INSERT INTO ot.work_events (work_id, by, op, detail) VALUES ($1, $2, $3, $4)",
        &[&it.id, &who.actor(), &op, &detail],
    )
    .await?;
    Ok(())
}

/// A live agent: (id, generation).
#[logged]
async fn live_agent(client: &impl GenericClient, org_id: i64, name: &str) -> Result<(i64, i32)> {
    let name = name.trim().trim_start_matches('@');
    match client
        .query_opt("SELECT id, generation FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org_id, &name])
        .await?
    {
        Some(r) => Ok((r.get(0), r.get(1))),
        None => refuse!(NotFound, "no live agent named {name}"),
    }
}

/// Physically archive what the rules say is archived (after each docket write).
#[logged]
async fn sweep(client: &impl GenericClient, org_id: i64) -> Result<()> {
    client
        .execute(
            "UPDATE ot.work_items SET archived_at = now()
              WHERE org_id = $1 AND archived_at IS NULL AND manual_attention IS NULL
                AND (status = 'dropped' OR (status IN ('done', 'superseded') AND coalesce(docket_at, updated_at) < now() - interval '1 hour'))
                AND NOT (slug = ANY(SELECT unnest(work_items) FROM ot.asks WHERE org_id = $1 AND status = 'open'))",
            &[&org_id],
        )
        .await?;
    Ok(())
}

fn reply_to(it: &Item) -> Value {
    json!({ "id": it.slug, "from": "docket", "at": iso(Utc::now()), "gist": format!("docket item {}: {}", it.slug, it.title),
            "kind": "work_item" })
}

/// A docket note to an agent (`wake` false: a notice).
#[logged]
async fn tell(engine: &Arc<Engine>, org_id: i64, it: &Item, to: &str, body: String, kind: &str, wake: bool) {
    let mut out = Outgoing::new(From::System, to, &body);
    out.kind = kind.into();
    out.notice = !wake;
    out.reply_to = Some(reply_to(it));
    if let Err(e) = mail::send(engine, org_id, out).await {
        tracing::warn!(to, error = %format!("{e:#}"), "docket note failed");
    }
}

fn assignment_text(who: &Who, it: &Item) -> String {
    let mut s = format!(
        "{} assigned you docket item {} — \"{}\" (status {}). You own it now: you hold the item and the user's replies on it reach you.\n\n",
        who.label(),
        it.slug,
        it.title,
        it.status
    );
    s.push_str(&gist(&it.objective, 4000));
    s.push_str("\n\nKeep it current with orgtree_work update (done_so_far and working_on_next).");
    if it.status == "backlogged" {
        s.push_str(" It is BACKLOGGED: do not start it until it is approved or you are told to.");
    }
    s
}

#[logged]
fn changed(engine: &Engine, org: &OrgHandle) {
    changes::notify(engine, org, vec![Change::Docket, Change::Events]);
}

/// `orgtree_work create` (and the docket half of `orgtree_staff`).
#[logged]
pub async fn create(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, args: &Value) -> Result<Value> {
    let Some(title) = text_arg(args, "title") else { refuse!(BadRequest, "a work item needs a title") };
    let title = bounded("title", title, TITLE_MAX)?;
    let Some(objective) = text_arg(args, "objective").or(text_arg(args, "description")) else {
        refuse!(
            BadRequest,
            "a work item needs a description in `objective` — state the PROBLEM currently faced first, then the proposed solution"
        );
    };
    let objective = objective.to_string();
    let kind = text_arg(args, "kind").unwrap_or("code").to_string();
    if kind != "code" && kind != "non-code" {
        refuse!(BadRequest, "kind must be code|non-code");
    }
    let status = text_arg(args, "status").unwrap_or("open").to_string();
    if !STARTS.contains(&status.as_str()) {
        refuse!(BadRequest, "a new item starts {}", STARTS.join("|"));
    }
    let blocked_reason = match text_arg(args, "blocked_reason") {
        Some(b) => Some(bounded("blocked_reason", b, BLOCKED_MAX)?),
        None => None,
    };
    if status == "blocked" && blocked_reason.is_none() {
        refuse!(BadRequest, "blocked needs blocked_reason: what prevents progress, what would unblock it, who can act");
    }
    let done = entries("done_so_far", &args["done_so_far"])?;
    let next = entries("working_on_next", &args["working_on_next"])?;
    if (done.is_some() || next.is_some()) && done.as_ref().map(|d| d.is_empty()).unwrap_or(true) && next.as_ref().map(|n| n.is_empty()).unwrap_or(true) {
        refuse!(BadRequest, "a docket update needs at least one entry in done_so_far or working_on_next");
    }
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let active: i64 = tx
        .query_one(
            "SELECT count(*) FROM ot.work_items WHERE org_id = $1 AND archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean, false)",
            &[&org.id],
        )
        .await?
        .get(0);
    if active >= ACTIVE_MAX {
        refuse!(
            Conflict,
            "the active docket holds {active} items (cap {ACTIVE_MAX}) — finish items so they archive, or archive a closed one explicitly"
        );
    }
    let owner_name = text_arg(args, "owner").map(|o| o.trim_start_matches('@').to_string()).or_else(|| who.name().map(str::to_string));
    let mut owner: Option<Value> = None;
    let mut owner_id: Option<i64> = None;
    if let Some(o) = &owner_name {
        let (oid, gen) = live_agent(&*tx, org.id, o).await?;
        if let Who::Agent { id, .. } = who {
            if oid != *id && !below(&*tx, *id).await?.contains(&oid) {
                refuse!(Forbidden, "you may own an item yourself or assign it to a subordinate — {o} is neither");
            }
        }
        owner = Some(json!({ "node": o, "generation": gen }));
        owner_id = Some(oid);
    }
    let mut participants: Vec<String> = Vec::new();
    for p in names(&args["participants"]) {
        if Some(&p) != owner_name.as_ref() && !participants.contains(&p) {
            live_agent(&*tx, org.id, &p).await?;
            participants.push(p);
        }
    }
    let mut deps: Vec<String> = Vec::new();
    for d in names(&args["dependencies"]) {
        load(&*tx, org.id, &d, false).await?;
        if !deps.contains(&d) {
            deps.push(d);
        }
    }
    let parent = match text_arg(args, "parent") {
        Some(p) => Some(load(&*tx, org.id, p, false).await?.slug),
        None => None,
    };
    let base = slugify(&title, SLUG_MAX);
    let mut slug = base.clone();
    let mut n = 2;
    while tx.query_opt("SELECT 1 FROM ot.work_items WHERE org_id = $1 AND slug = $2", &[&org.id, &slug]).await?.is_some() {
        slug = format!("{}-{n}", &base[..base.len().min(SLUG_MAX - 4)]);
        n += 1;
    }
    let now = Utc::now();
    let row = tx
        .query_one(
            &format!(
                "INSERT INTO ot.work_items (org_id, slug, rev, kind, title, objective, status, blocked_reason, owner, owner_agent_id,
                                            created_by, last_updater, participants, parent, dependencies, done_so_far, working_on_next,
                                            created_at, updated_at, docket_at, status_at)
                 VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $17, $17)
                 RETURNING {COLS}"
            ),
            &[
                &org.id, &slug, &kind, &title, &objective, &status, &blocked_reason, &owner, &owner_id, &who.actor(),
                &(if matches!(who, Who::User) { None } else { Some(who.actor()) }), &participants, &parent, &deps,
                &json!(done.clone().unwrap_or_default()), &json!(next.clone().unwrap_or_default()), &now,
            ],
        )
        .await?;
    let it = item_of(&row);
    history(&*tx, &it, who, "create", json!({ "title": title, "status": status, "owner": owner_name })).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    let mut notified = Value::Null;
    if let Some(o) = &owner_name {
        if Some(o.as_str()) != who.name() {
            tell(engine, org.id, &it, o, assignment_text(who, &it), "request", true).await;
            notified = json!(o);
        }
    }
    for p in &participants {
        tell(
            engine,
            org.id,
            &it,
            p,
            format!("{} added you as a participant on docket item {} — \"{}\". You may update its state and add evidence; the owner is {}.",
                who.label(), it.slug, it.title, owner_name.as_deref().unwrap_or("nobody yet")),
            "status",
            false,
        )
        .await;
    }
    Ok(json!({
        "created": it.slug, "slug": it.slug, "rev": 1, "owner": it.owner, "notified": notified,
        "status": format!("work item {} created — that name is its only identity; use it in mail, reports and every later update, question and handoff", it.slug),
    }))
}

/// `orgtree_work update`: progress, status, attention, scope.
#[logged]
pub async fn update(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, args: &Value) -> Result<Value> {
    let Some(slug) = text_arg(args, "slug") else { refuse!(BadRequest, "name the item (slug)") };
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let mut it = load(&*tx, org.id, slug, true).await?;
    let ctx = ctx(&*tx, org).await?;
    let under = match who.id() {
        Some(id) => below(&*tx, id).await?,
        None => HashSet::new(),
    };
    let lv = level(who, &it, &ctx, &under);
    if lv < Level::State {
        refuse!(Forbidden, "only the owner, the creator, their superiors, participants, the reviewer or the user may update {}", it.slug);
    }
    if let Some(exp) = args["expected_rev"].as_i64() {
        if exp != it.rev {
            refuse!(Conflict, "{} moved to rev {} since you read it (you sent {exp}); re-read it and update again", it.slug, it.rev);
        }
    }
    let reopen = args["reopen"].as_bool().unwrap_or(false);
    let was_archived = archived(&it, &ctx);
    if (it.closed() || was_archived) && !reopen {
        refuse!(
            Conflict,
            "{} is {} — to RESUME it pass reopen=true with the new status. To report on finished work without reopening it, add `evidence`",
            it.slug,
            if was_archived { "ARCHIVED".to_string() } else { it.status.clone() }
        );
    }
    if reopen && !(it.closed() || was_archived) {
        refuse!(BadRequest, "{} is not closed; reopen is only for resuming finished work", it.slug);
    }
    // ownership: your own update claims the item unless you name its holder
    let mut claim: Option<String> = None;
    if let Who::Agent { name, .. } = who {
        let holder = it.owner_name().map(str::to_string);
        match text_arg(args, "owner").map(|o| o.trim_start_matches('@')) {
            Some(o) if Some(o) == holder.as_deref() => {}
            Some(o) if o == name.as_str() => {
                if holder.as_deref() != Some(name.as_str()) {
                    claim = holder.clone().or(Some(String::new()));
                }
            }
            Some(o) => refuse!(BadRequest, "`owner` on update names the CURRENT holder ({}) to keep it with them; to hand the item to {o} use the assign action", holder.as_deref().unwrap_or("nobody")),
            None => {
                if holder.as_deref() != Some(name.as_str()) {
                    claim = holder.clone().or(Some(String::new()));
                }
            }
        }
    }
    // scope edits are owner-level
    let title = text_arg(args, "title");
    let objective = args["objective"].as_str().map(str::to_string);
    let objective_append = text_arg(args, "objective_append");
    if (title.is_some() || objective.is_some() || objective_append.is_some()) && lv < Level::Manage {
        refuse!(Forbidden, "only the owner, the creator, their superiors or the user may retitle or re-scope an item");
    }
    if objective.is_some() && objective_append.is_some() {
        refuse!(BadRequest, "pass either `objective` (replacing the description) or `objective_append`, not both");
    }
    // progress
    let mut done = entries("done_so_far", &args["done_so_far"])?;
    let mut next = entries("working_on_next", &args["working_on_next"])?;
    let as_list = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    if args["keep_done"].as_bool().unwrap_or(false) {
        done = Some(as_list(&it.done));
    }
    if args["keep_next"].as_bool().unwrap_or(false) {
        next = Some(as_list(&it.next));
    }
    if let Some(add) = entries("done_append", &args["done_append"])? {
        let mut d = done.unwrap_or_else(|| as_list(&it.done));
        d.extend(add);
        done = Some(d);
    }
    if let Some(add) = entries("next_append", &args["next_append"])? {
        let mut n = next.unwrap_or_else(|| as_list(&it.next));
        n.extend(add);
        next = Some(n);
    }
    let progress = done.is_some() || next.is_some();
    if progress {
        let d = done.clone().unwrap_or_default();
        let n = next.clone().unwrap_or_default();
        if d.is_empty() && n.is_empty() {
            refuse!(BadRequest, "a docket update needs at least one entry in done_so_far or working_on_next — both empty says nothing the user can read");
        }
        if d.len() > ENTRIES_MAX || n.len() > ENTRIES_MAX {
            refuse!(BadRequest, "a progress list holds at most {ENTRIES_MAX} entries");
        }
    }
    // status
    let status = text_arg(args, "status").map(str::to_string);
    if let Some(s) = &status {
        if s == "waiting" {
            refuse!(BadRequest, "`waiting` is no longer a task state: use `blocked` with a blocked_reason that names what you are waiting on and how you will hear of it");
        }
        if s == "superseded" {
            refuse!(BadRequest, "an item becomes superseded through the supersede action (naming its replacement)");
        }
        if !SETTABLE.contains(&s.as_str()) {
            refuse!(BadRequest, "status must be one of {}", SETTABLE.join("|"));
        }
    }
    let blocked_reason = match args["blocked_reason"].as_str() {
        Some(b) => Some(bounded("blocked_reason", b.trim(), BLOCKED_MAX)?),
        None => None,
    };
    let dropped_reason = match args["dropped_reason"].as_str() {
        Some(b) => Some(bounded("dropped_reason", b.trim(), DROPPED_MAX)?),
        None => None,
    };
    // attention
    let attention = args["attention"].as_bool();
    let amend = args["attention_amend"].as_bool().unwrap_or(false);
    let reason = match args["attention_reason"].as_str() {
        Some(r) => Some(bounded("attention_reason", r.trim(), ATTENTION_MAX)?),
        None => None,
    };
    if attention == Some(true) && amend {
        refuse!(BadRequest, "`attention: true` RAISES a flag and `attention_amend` edits the one already standing — pass one or the other");
    }
    if (attention == Some(true) || amend) && reason.as_deref().map(str::is_empty).unwrap_or(true) {
        refuse!(BadRequest, "raising or amending attention needs a nonblank attention_reason — the concrete thing the user must see and the confirmation you want");
    }
    if amend && it.attention.is_none() {
        refuse!(Conflict, "there is no attention flag standing on {}, so there is nothing to amend — raise one with attention=true", it.slug);
    }
    if attention == Some(true) {
        let r = reason.clone().unwrap_or_default();
        let repeat = it.dismissals.as_array().map(|d| d.iter().any(|x| x["reason"].as_str() == Some(r.as_str()))).unwrap_or(false);
        if repeat {
            refuse!(Conflict, "the user already dismissed exactly this flag; say what changed since, or do not raise it again");
        }
    }
    let reviewer = text_arg(args, "reviewer").map(|r| r.trim_start_matches('@').to_string());
    let substantive = progress || status.is_some() || attention.is_some() || amend || title.is_some() || objective.is_some()
        || objective_append.is_some() || reviewer.is_some() || reopen || blocked_reason.is_some() || dropped_reason.is_some();
    if !substantive {
        refuse!(BadRequest, "nothing to update: send done_so_far and working_on_next, and any status, attention or scope change");
    }
    // apply
    let now = Utc::now();
    let from_status = it.status.clone();
    let mut notes: Vec<String> = Vec::new();
    if let Some(t) = title {
        it.title = bounded("title", t, TITLE_MAX)?;
    }
    if let Some(o) = objective {
        if o.trim().is_empty() {
            refuse!(BadRequest, "the description (`objective`) may be rewritten but not emptied");
        }
        it.objective = o;
    }
    if let Some(a) = objective_append {
        it.objective = format!("{}\n\n{a}", it.objective.trim_end());
    }
    if reopen {
        it.archived_at = None;
        it.accepted = None;
        if status.is_none() {
            it.status = "in_progress".into();
        }
        notes.push("reopened".into());
    }
    if let Some(s) = &status {
        it.status = s.clone();
    }
    if let Some(r) = &reviewer {
        let (rid, gen) = live_agent(&*tx, org.id, r).await?;
        if Some(r.as_str()) == it.owner_name() {
            refuse!(BadRequest, "the reviewer checks the owner's work — name someone other than the owner");
        }
        it.reviewer = Some(json!({ "node": r, "generation": gen }));
        it.reviewer_id = Some(rid);
    }
    // each state's own reason: required on entry, cleared on the way out
    if it.status == "blocked" {
        if let Some(b) = &blocked_reason {
            it.blocked_reason = Some(b.clone());
        }
        if it.blocked_reason.as_deref().map(str::is_empty).unwrap_or(true) {
            refuse!(BadRequest, "blocked needs blocked_reason: what prevents progress, what would unblock it, who can act");
        }
    } else {
        it.blocked_reason = None;
    }
    if it.status == "dropped" {
        if let Some(d) = &dropped_reason {
            it.dropped_reason = Some(d.clone());
        }
        if from_status != "dropped" && dropped_reason.as_deref().map(str::is_empty).unwrap_or(true) {
            refuse!(BadRequest, "dropped needs dropped_reason: cancelled or failed, who decided, and what would make it worth resuming");
        }
    } else {
        it.dropped_reason = None;
    }
    if it.status == "done" && from_status != "done" {
        it.accepted = Some(json!({ "at": iso(now), "by": who.label() }));
    }
    if attention == Some(true) {
        let rev = it.extra["attention_rev"].as_i64().unwrap_or_else(|| it.attention.as_ref().and_then(|a| a["set_rev"].as_i64()).unwrap_or(0)) + 1;
        it.extra["attention_rev"] = json!(rev);
        it.attention = Some(json!({ "reason": reason.clone().unwrap_or_default(), "at": iso(now), "by": who.actor(), "set_rev": rev }));
    } else if amend {
        if let Some(a) = it.attention.as_mut() {
            a["reason"] = json!(reason.clone().unwrap_or_default());
            a["at"] = json!(iso(now));
        }
    } else if attention == Some(false) && it.attention.is_some() {
        it.attention = None;
        notes.push("the standing attention flag was CLEARED by this update".into());
    }
    if let Some(d) = done {
        it.done = json!(d);
    }
    if let Some(n) = next {
        it.next = json!(n);
    }
    if let Some(prev) = &claim {
        if let Who::Agent { id, name, generation } = who {
            it.owner = Some(json!({ "node": name, "generation": generation }));
            it.owner_id = Some(*id);
            if !prev.is_empty() {
                notes.push(format!("you now OWN this item (it was {prev}'s); pass owner={prev} on someone else's item to leave it with them"));
            }
        }
    }
    it.rev += 1;
    it.updated_at = now;
    if progress || status.is_some() || reopen {
        it.docket_at = Some(now);
    }
    if it.status != from_status {
        it.status_at = Some(now);
    }
    if !matches!(who, Who::User) {
        it.last_updater = Some(who.actor());
    }
    save(&*tx, &it).await?;
    history(
        &*tx,
        &it,
        who,
        if reopen { "reopen" } else { "update" },
        json!({ "from": (from_status != it.status).then(|| from_status.clone()), "to": (from_status != it.status).then(|| it.status.clone()),
                "attention": attention, "claimed_from": claim.clone().filter(|c| !c.is_empty()) }),
    )
    .await?;
    sweep(&*tx, org.id).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    if let Some(prev) = claim.filter(|p| !p.is_empty()) {
        tell(engine, org.id, &it, &prev, format!("{} took over docket item {} — \"{}\" with its own update; it owns the item now.", who.label(), it.slug, it.title), "status", false).await;
    }
    if it.status == "review" && from_status != "review" {
        if let Some(r) = it.reviewer_name() {
            tell(engine, org.id, &it, r, format!("{} asks you to REVIEW docket item {} — \"{}\". Check the work and its evidence, then set the status (approved, done, or back to in_progress with what must change).", who.label(), it.slug, it.title), "request", true).await;
        }
    }
    let mut out = json!({ "updated": it.slug, "rev": it.rev, "status": it.status, "owner": it.owner_name(),
                          "manual_attention": it.attention.is_some() });
    if !notes.is_empty() {
        out["notes"] = json!(notes);
    }
    Ok(out)
}

/// Load an item for a write the caller must manage.
#[logged]
async fn managed(tx: &impl GenericClient, org: &OrgHandle, who: &Who, slug: &str, need: &str) -> Result<(Item, Ctx, HashSet<i64>)> {
    let it = load(tx, org.id, slug, true).await?;
    let ctx = ctx(tx, org).await?;
    let under = match who.id() {
        Some(id) => below(tx, id).await?,
        None => HashSet::new(),
    };
    if level(who, &it, &ctx, &under) < Level::Manage {
        refuse!(Forbidden, "only the owner, the creator, their superiors or the user may {need} {}", it.slug);
    }
    Ok((it, ctx, under))
}

/// `assign`: ownership only — the status never moves.
#[logged]
pub async fn assign(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, slug: &str, owner: &str) -> Result<Value> {
    let owner = owner.trim().trim_start_matches('@').to_string();
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let (mut it, _ctx, under) = managed(&*tx, org, who, slug, "assign").await?;
    let (oid, gen) = live_agent(&*tx, org.id, &owner).await?;
    if let Who::Agent { id, .. } = who {
        if oid != *id && !under.contains(&oid) {
            refuse!(Forbidden, "you may assign an item to yourself or a subordinate — {owner} is neither");
        }
    }
    if it.owner_name() == Some(owner.as_str()) {
        refuse!(Conflict, "{} is already owned by {owner}", it.slug);
    }
    let prev = it.owner_name().map(str::to_string);
    it.owner = Some(json!({ "node": owner, "generation": gen }));
    it.owner_id = Some(oid);
    it.participants.retain(|p| p != &owner);
    it.rev += 1;
    it.updated_at = Utc::now();
    save(&*tx, &it).await?;
    history(&*tx, &it, who, "assign", json!({ "from": prev, "to": owner })).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    if Some(owner.as_str()) != who.name() {
        tell(engine, org.id, &it, &owner, assignment_text(who, &it), "request", true).await;
    }
    if let Some(p) = prev.as_deref().filter(|p| Some(*p) != who.name()) {
        tell(engine, org.id, &it, p, format!("{} reassigned docket item {} — \"{}\" to {owner}; you no longer hold it.", who.label(), it.slug, it.title), "status", false).await;
    }
    Ok(json!({ "assigned": it.slug, "owner": owner, "status": it.status, "rev": it.rev }))
}

/// `handoff`: the owner asks its superior (or `target`) to take the item.
#[logged]
pub async fn handoff(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, slug: &str, target: Option<&str>, reason: &str) -> Result<Value> {
    let Who::Agent { id, name, generation } = who else { refuse!(BadRequest, "handoff is the owner's request; the user assigns directly") };
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    if it.owner_name() != Some(name.as_str()) {
        refuse!(Forbidden, "only the owner hands an item off; {} is owned by {}", it.slug, it.owner_name().unwrap_or("nobody"));
    }
    let superior: Option<String> = client
        .query_one("SELECT p.name FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.id = $1", &[id])
        .await?
        .get(0);
    let to = match target.map(|t| t.trim().trim_start_matches('@')).filter(|t| !t.is_empty()) {
        Some("user") => "user".to_string(),
        Some(t) => t.to_string(),
        None => superior.clone().unwrap_or_else(|| "user".into()),
    };
    if reason.trim().is_empty() {
        refuse!(BadRequest, "say why the item needs an upward handoff (reason)");
    }
    client
        .execute(
            "INSERT INTO ot.work_events (work_id, by, op, detail) VALUES ($1, $2, 'handoff_request', $3)",
            &[&it.id, &who.actor(), &json!({ "to": to, "reason": reason })],
        )
        .await?;
    drop(client);
    let text = format!(
        "{name} asks you to take over docket item {} — \"{}\" ({}): {reason}\nOwnership is unchanged until you assign it (orgtree_work assign).",
        it.slug, it.title, it.status
    );
    let mut out = Outgoing::new(From::Agent { id: *id, name: name.clone(), generation: *generation }, &to, &text);
    out.kind = "request".into();
    out.reply_to = Some(reply_to(&it));
    let sent = mail::send(engine, org.id, out).await?;
    changed(engine, org);
    Ok(json!({ "requested": to, "item": it.slug, "ownership": "unchanged", "delivery": sent.delivery }))
}

/// `participants`: add and remove collaborators.
#[logged]
pub async fn participants(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, slug: &str, add: &[String], remove: &[String]) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let (mut it, _, _) = managed(&*tx, org, who, slug, "change the participants of").await?;
    let mut added = Vec::new();
    for p in add {
        if Some(p.as_str()) == it.owner_name() || it.participants.contains(p) {
            continue;
        }
        live_agent(&*tx, org.id, p).await?;
        it.participants.push(p.clone());
        added.push(p.clone());
    }
    let before = it.participants.len();
    it.participants.retain(|p| !remove.contains(p));
    let removed = before - it.participants.len();
    if added.is_empty() && removed == 0 {
        refuse!(BadRequest, "nothing changed: add names agents not yet on the item, remove names agents on it");
    }
    it.rev += 1;
    it.updated_at = Utc::now();
    save(&*tx, &it).await?;
    history(&*tx, &it, who, "participants", json!({ "added": added, "removed": remove })).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    for p in &added {
        tell(engine, org.id, &it, p, format!("{} added you as a participant on docket item {} — \"{}\". You may update its state and add evidence; the owner is {}.",
            who.label(), it.slug, it.title, it.owner_name().unwrap_or("nobody")), "status", false).await;
    }
    Ok(json!({ "item": it.slug, "participants": it.participants, "rev": it.rev }))
}

/// `evidence`: notes, links, files, commits and logs on the item.
#[logged]
pub async fn evidence(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, slug: &str, args: &Value) -> Result<Value> {
    let rows: Vec<Value> = match args["items"].as_array() {
        Some(a) => a.clone(),
        None => vec![args.clone()],
    };
    let mut adds = Vec::new();
    let now = iso(Utc::now());
    for r in &rows {
        let kind = r["kind"].as_str().unwrap_or("note");
        if !EVIDENCE_KINDS.contains(&kind) {
            refuse!(BadRequest, "evidence kind is {}", EVIDENCE_KINDS.join("|"));
        }
        let rf = r["ref"].as_str().map(str::trim).filter(|s| !s.is_empty());
        let note = r["note"].as_str().map(str::trim).filter(|s| !s.is_empty());
        if rf.is_none() && note.is_none() {
            refuse!(BadRequest, "evidence needs a ref or a note");
        }
        if let Some(x) = rf {
            bounded("ref", x, REF_MAX)?;
        }
        let mut e = json!({ "at": now, "by": who.label(), "kind": kind });
        if let Some(x) = rf {
            e["ref"] = json!(x);
        }
        if let Some(x) = note {
            e["note"] = json!(x);
        }
        adds.push(e);
    }
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let mut it = load(&*tx, org.id, slug, true).await?;
    let ctx = ctx(&*tx, org).await?;
    let under = match who.id() {
        Some(id) => below(&*tx, id).await?,
        None => HashSet::new(),
    };
    if level(who, &it, &ctx, &under) < Level::State {
        refuse!(Forbidden, "only the owner, the creator, their superiors, participants, the reviewer or the user add evidence to {}", it.slug);
    }
    let mut ev = it.evidence.as_array().cloned().unwrap_or_default();
    if ev.len() + adds.len() > EVIDENCE_MAX {
        refuse!(Conflict, "{} holds {} evidence rows; {} more would pass the limit of {EVIDENCE_MAX} (refused, not truncated)", it.slug, ev.len(), adds.len());
    }
    ev.extend(adds.iter().cloned());
    it.evidence = json!(ev);
    it.rev += 1;
    it.updated_at = Utc::now();
    save(&*tx, &it).await?;
    history(&*tx, &it, who, "evidence", json!({ "count": adds.len() })).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    Ok(json!({ "item": it.slug, "evidence": it.evidence.as_array().map(|a| a.len()).unwrap_or(0), "rev": it.rev }))
}

/// `archive` (close the row early), `supersede` (by another item), `move` (nest under a parent).
#[logged]
pub async fn arrange(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, action: &str, slug: &str, args: &Value) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let (mut it, _ctx, _) = managed(&*tx, org, who, slug, action).await?;
    let now = Utc::now();
    let out = match action {
        "archive" => {
            it.archived_at = Some(now);
            json!({ "archived": it.slug, "note": if it.attention.is_some() { "it stays on the list while its attention flag stands" } else { "archived" } })
        }
        "supersede" => {
            let Some(by) = text_arg(args, "by").or(text_arg(args, "superseded_by")).or(text_arg(args, "target")) else {
                refuse!(BadRequest, "supersede names the item that replaces this one (by)");
            };
            let by = load(&*tx, org.id, by, false).await?.slug;
            if by == it.slug {
                refuse!(BadRequest, "an item cannot supersede itself");
            }
            it.status = "superseded".into();
            it.superseded_by = Some(by.clone());
            it.blocked_reason = None;
            it.dropped_reason = None;
            it.status_at = Some(now);
            it.docket_at = Some(now);
            json!({ "superseded": it.slug, "by": by })
        }
        "move" => {
            let parent = text_arg(args, "parent").filter(|p| *p != "null" && *p != "none");
            match parent {
                None => it.parent = None,
                Some(p) => {
                    let p = load(&*tx, org.id, p, false).await?;
                    // no cycles: walk up from the new parent
                    let mut cur = Some(p.slug.clone());
                    let mut hops = 0;
                    while let Some(c) = cur {
                        if c == it.slug {
                            refuse!(BadRequest, "{} is above {} already; moving would make a loop", it.slug, p.slug);
                        }
                        hops += 1;
                        if hops > 256 {
                            break;
                        }
                        cur = tx
                            .query_opt("SELECT parent FROM ot.work_items WHERE org_id = $1 AND slug = $2", &[&org.id, &c])
                            .await?
                            .and_then(|r| r.get::<_, Option<String>>(0));
                    }
                    it.parent = Some(p.slug);
                }
            }
            json!({ "moved": it.slug, "parent": it.parent })
        }
        other => refuse!(BadRequest, "unknown action {other}"),
    };
    it.rev += 1;
    it.updated_at = now;
    save(&*tx, &it).await?;
    history(&*tx, &it, who, action, args.get("by").cloned().map(|b| json!({ "by": b })).unwrap_or(json!({}))).await?;
    sweep(&*tx, org.id).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    Ok(out)
}

/// `delete`: gone for good (its name is never reused). The user, a superior
/// of the owner, or a top-level owner; never with children or an open question.
#[logged]
pub async fn delete(engine: &Arc<Engine>, org: &Arc<OrgHandle>, who: &Who, slug: &str) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let mut it = load(&*tx, org.id, slug, true).await?;
    if let Who::Agent { id, name, .. } = who {
        let owner_top = it.owner_name() == Some(name.as_str())
            && tx.query_one("SELECT parent_id IS NULL FROM ot.agents WHERE id = $1", &[id]).await?.get::<_, bool>(0);
        let above_owner = match it.owner_id {
            Some(o) => below(&*tx, *id).await?.contains(&o),
            None => false,
        };
        if !(owner_top || above_owner) {
            refuse!(Forbidden, "only the user, a superior of the owner or a top-level owner deletes an item — prefer archive or dropped");
        }
    }
    let kids: i64 = tx
        .query_one(
            "SELECT count(*) FROM ot.work_items WHERE org_id = $1 AND parent = $2 AND NOT coalesce((extra->>'deleted')::boolean, false)",
            &[&org.id, &it.slug],
        )
        .await?
        .get(0);
    if kids > 0 {
        refuse!(Conflict, "{} has {kids} sub-item(s); move or delete them first", it.slug);
    }
    let asked: bool = tx
        .query_one("SELECT EXISTS (SELECT 1 FROM ot.asks WHERE org_id = $1 AND status = 'open' AND $2 = ANY(work_items))", &[&org.id, &it.slug])
        .await?
        .get(0);
    if asked {
        refuse!(Conflict, "{} has an open question attached; withdraw or answer it first", it.slug);
    }
    it.extra["deleted"] = json!(true);
    it.archived_at = Some(Utc::now());
    it.rev += 1;
    save(&*tx, &it).await?;
    history(&*tx, &it, who, "delete", json!({})).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    Ok(json!({ "deleted": it.slug }))
}

// ------------------------------------------------------------ the agent's reads

/// Narrow a full view to a projection (and optional fields).
fn project(full: &Value, projection: &str, fields: &[String]) -> Value {
    let keep: Vec<&str> = if !fields.is_empty() {
        let mut f: Vec<&str> = fields.iter().map(|s| match s.as_str() {
            "description" => "objective",
            "attention" => "effective_attention",
            other => other,
        }).collect();
        if !f.contains(&"slug") {
            f.push("slug");
        }
        f
    } else {
        match projection {
            "full" => return full.clone(),
            "compact" => SUMMARY_FIELDS.iter().chain(COMPACT_EXTRA.iter()).copied().collect(),
            _ => SUMMARY_FIELDS.to_vec(),
        }
    };
    let mut o = Map::new();
    for k in keep {
        if let Some(v) = full.get(k) {
            if (k == "owner" || k == "reviewer") && v.is_object() {
                o.insert(k.into(), v["node"].clone());
            } else if !v.is_null() || k == "owner" {
                o.insert(k.into(), v.clone());
            }
        }
    }
    Value::Object(o)
}

/// `list`: the items the caller may read, in three disjoint groups.
#[logged]
pub async fn agent_list(engine: &Engine, org: &OrgHandle, who: &Who, args: &Value) -> Result<Value> {
    let with_archived = args["include_archived"].as_bool().unwrap_or(false);
    let with_backlogged = args["include_backlogged"].as_bool().unwrap_or(false);
    let projection = if args["compact"].as_bool().unwrap_or(false) { "compact" } else { args["projection"].as_str().unwrap_or("summary") };
    let fields = names(&args["fields"]);
    let client = engine.db.get().await?;
    let ctx = ctx(&**client, org).await?;
    let under = match who.id() {
        Some(id) => below(&**client, id).await?,
        None => HashSet::new(),
    };
    let rows = client
        .query(
            &format!("SELECT {COLS} FROM ot.work_items WHERE org_id = $1 AND NOT coalesce((extra->>'deleted')::boolean, false)
                        AND ($2 OR archived_at IS NULL OR manual_attention IS NOT NULL)"),
            &[&org.id, &with_archived],
        )
        .await?;
    let (mut items, mut arch, mut back) = (Vec::new(), Vec::new(), Vec::new());
    let mut arch_n = 0;
    for r in &rows {
        let it = item_of(r);
        let lv = level(who, &it, &ctx, &under);
        let readable = lv > Level::None || matches!(who, Who::User);
        if !readable {
            continue;
        }
        let full = view(&it, &ctx, None);
        let row = project(&full, projection, &fields);
        if full["archived"].as_bool().unwrap_or(false) {
            arch_n += 1;
            arch.push((full, row));
        } else if it.status == "backlogged" && !full["effective_attention"].as_bool().unwrap_or(false) {
            back.push((full, row));
        } else {
            items.push((full, row));
        }
    }
    let key = |v: &Value| (v["docket_at"].as_str().or(v["updated_at"].as_str()).unwrap_or("").to_string(), v["slug"].as_str().unwrap_or("").to_string());
    for g in [&mut items, &mut arch, &mut back] {
        g.sort_by(|a, b| key(&b.0).cmp(&key(&a.0)));
    }
    let attention = items.iter().chain(back.iter()).filter(|(f, _)| f["effective_attention"].as_bool().unwrap_or(false)).count();
    let active = items.iter().filter(|(f, _)| { let s = f["status"].as_str().unwrap_or(""); !CLOSED.contains(&s) && s != "backlogged" }).count();
    let mut out = json!({
        "projection": projection,
        "counts": { "attention": attention, "active": active, "archived": arch_n, "backlogged": back.len() },
        "groups": {
            "items": { "count": items.len(), "included": true, "how": "served in `items`" },
            "archived": { "count": arch_n, "included": with_archived,
                          "how": if with_archived { "served in `archived`" } else { "NOT in this payload — pass include_archived=true" } },
            "backlogged": { "count": back.len(), "included": with_backlogged,
                            "how": if with_backlogged { "served in `backlogged`" } else { "NOT in this payload — pass include_backlogged=true" } },
        },
        "items": items.into_iter().map(|x| x.1).collect::<Vec<_>>(),
        "now": iso(ctx.now),
    });
    if with_archived {
        out["archived"] = json!(arch.into_iter().map(|x| x.1).collect::<Vec<_>>());
    }
    if with_backlogged {
        out["backlogged"] = json!(back.into_iter().map(|x| x.1).collect::<Vec<_>>());
    }
    Ok(out)
}

/// `get`: one item (compact by default).
#[logged]
pub async fn agent_get(engine: &Engine, org: &OrgHandle, who: &Who, slug: &str, args: &Value) -> Result<Value> {
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    let ctx = ctx(&**client, org).await?;
    let under = match who.id() {
        Some(id) => below(&**client, id).await?,
        None => HashSet::new(),
    };
    if level(who, &it, &ctx, &under) == Level::None && !matches!(who, Who::User) {
        refuse!(Forbidden, "{} is not readable to you (owner, creator, their superiors, participants and the reviewer read it)", it.slug);
    }
    let projection = if args["compact"].as_bool().unwrap_or(false) { "compact" } else { args["projection"].as_str().unwrap_or("compact") };
    let (h, a) = if projection == "full" { detail(&**client, &it).await? } else { (Vec::new(), Vec::new()) };
    let full = view(&it, &ctx, if projection == "full" { Some((&h, &a)) } else { None });
    Ok(project(&full, projection, &names(&args["fields"])))
}

// ------------------------------------------------------------ the user's hand

/// Dismiss a manual attention flag (CAS on the revision it was shown at):
/// unfinished work other than review becomes blocked, and the owner is told.
#[logged]
pub async fn dismiss(engine: &Arc<Engine>, org: &Arc<OrgHandle>, slug: &str, set_rev: i64) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let mut it = load(&*tx, org.id, slug, true).await?;
    let Some(cur) = it.attention.clone() else {
        refuse!(Conflict, "{} has no manual attention flag to dismiss (already cleared or dismissed — re-read the item)", it.slug);
    };
    let at = cur["set_rev"].as_i64().unwrap_or(0);
    if at != set_rev {
        refuse!(Conflict, "the flag changed after it rendered (dismiss against revision {set_rev}, flag at {at}) — re-read the reason and dismiss what it shows now");
    }
    let reason = cur["reason"].as_str().unwrap_or("").to_string();
    let mut dismissals = it.dismissals.as_array().cloned().unwrap_or_default();
    dismissals.push(json!({ "at": iso(Utc::now()), "by": "user", "set_rev": at, "reason": reason }));
    it.dismissals = json!(dismissals);
    it.attention = None;
    let from = it.status.clone();
    let keep = matches!(from.as_str(), "done" | "review");
    if !keep {
        it.status = "blocked".into();
        it.blocked_reason = Some(format!("attention flag dismissed by the user ({reason})"));
        it.dropped_reason = None;
        if from != "blocked" {
            it.status_at = Some(Utc::now());
        }
        it.archived_at = None;
    }
    it.rev += 1;
    it.updated_at = Utc::now();
    save(&*tx, &it).await?;
    history(&*tx, &it, &Who::User, "dismiss_attention", json!({ "set_rev": at, "from": from, "to": it.status })).await?;
    tx.commit().await?;
    drop(client);
    changed(engine, org);
    if let Some(o) = it.owner_name() {
        tell(
            engine,
            org.id,
            &it,
            o,
            format!(
                "The user dismissed the attention flag on docket item {} — \"{}\" (\"{}\").{}",
                it.slug,
                it.title,
                gist(&reason, 300),
                if keep { String::new() } else { " The item is now BLOCKED on that; update it when you know how to proceed.".into() }
            ),
            "status",
            false,
        )
        .await;
    }
    user_get(engine, org, &it.slug).await
}

/// The user's reply on an item: mail to its owner, or to a participant it names.
#[logged]
pub async fn reply(engine: &Arc<Engine>, org: &Arc<OrgHandle>, slug: &str, body: &str, to: Option<&str>, attachments: Vec<Value>, notice: bool) -> Result<Value> {
    let text = body.trim();
    if text.is_empty() && attachments.is_empty() {
        refuse!(Unprocessable, "empty reply");
    }
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    let (target, role) = match to.map(|t| t.trim().trim_start_matches('@')).filter(|t| !t.is_empty()) {
        Some(t) if Some(t) == it.owner_name() => (t.to_string(), "owner"),
        Some(t) if it.participants.iter().any(|p| p == t) => (t.to_string(), "participant"),
        Some(t) => refuse!(Unprocessable, "{t} is neither the owner nor a participant of {}; nothing was sent", it.slug),
        None => match it.owner_name() {
            Some(o) => (o.to_string(), "owner"),
            None => refuse!(Unprocessable, "{} has no owner to reply to; assign it first", it.slug),
        },
    };
    let state: Option<String> = client
        .query_opt("SELECT state FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&org.id, &target])
        .await?
        .map(|r| r.get(0));
    let Some(state) = state else { refuse!(NotFound, "{target} no longer exists; nothing was sent") };
    drop(client);
    let how = if role == "participant" {
        format!("(the user replied on docket item {} ADDRESSED TO YOU AS A PARTICIPANT — the item is owned by {}, not by you; act on it and coordinate any update with the owner)", it.slug, it.owner_name().unwrap_or("nobody"))
    } else {
        format!("(the user replied on docket item {} — treat it as item-linked mail and update the item if it changes the work)", it.slug)
    };
    let mut out = Outgoing::new(From::User, &target, &format!("{text}\n\n{how}"));
    out.notice = notice;
    out.attachments = attachments;
    out.reply_to = Some(reply_to(&it));
    let sent = mail::send(engine, org.id, out).await?;
    // the user answered: a standing manual flag has been seen
    if it.attention.is_some() {
        let client = engine.db.get().await?;
        client
            .execute(
                "UPDATE ot.work_items SET manual_attention = NULL, rev = rev + 1, updated_at = now() WHERE id = $1",
                &[&it.id],
            )
            .await?;
        client
            .execute(
                "INSERT INTO ot.work_events (work_id, by, op, detail) VALUES ($1, '\"user\"', 'attention_answered', '{}')",
                &[&it.id],
            )
            .await?;
    }
    changed(engine, org);
    Ok(json!({
        "accepted": true, "to": target, "role": role, "deferred": sent.deferred, "notice": notice && state == "live",
        "node_state": state, "delivery": sent.delivery, "id": sent.uid, "ref": format!("@mail:{}", sent.uid),
    }))
}

/// Attach a file to the item itself.
#[logged]
pub async fn attach(engine: &Arc<Engine>, org: &Arc<OrgHandle>, slug: &str, name: &str, bytes: &[u8]) -> Result<Value> {
    if bytes.len() > ATTACHMENT_MAX {
        refuse!(BadRequest, "an attachment is limited to 25 MB");
    }
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    let base = std::path::Path::new(name).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let clean: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ()+".contains(c) { c } else { '_' })
        .take(120)
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();
    let clean = if clean.is_empty() { "file.bin".to_string() } else { clean };
    // the stored name is what is listed: de-duplicate it
    let taken: HashSet<String> = client
        .query("SELECT name FROM ot.work_attachments WHERE work_id = $1", &[&it.id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let mut stored = clean.clone();
    let mut n = 2;
    while taken.contains(&stored) {
        let p = std::path::Path::new(&clean);
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        stored = format!("{stem} ({n}){ext}");
        n += 1;
    }
    let id = crate::util::uid("a");
    let dir = engine.cfg.path("docket").join(&org.slug).join(&it.slug);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}-{stored}"));
    std::fs::write(&path, bytes)?;
    let by = json!("user");
    let p = path.to_string_lossy().to_string();
    client
        .execute(
            "INSERT INTO ot.work_attachments (id, work_id, name, bytes, path, by) VALUES ($1, $2, $3, $4, $5, $6)",
            &[&id, &it.id, &stored, &(bytes.len() as i64), &p, &by],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.work_events (work_id, by, op, detail) VALUES ($1, $2, 'attach', $3)",
            &[&it.id, &by, &json!({ "name": stored, "bytes": bytes.len() })],
        )
        .await?;
    drop(client);
    changed(engine, org);
    Ok(json!({ "attachment": { "id": id, "at": iso(Utc::now()), "by": "user", "name": stored, "bytes": bytes.len() } }))
}

/// (name, path) of an attachment.
#[logged]
pub async fn attachment(engine: &Engine, org: &OrgHandle, slug: &str, aid: &str) -> Result<(String, String)> {
    let client = engine.db.get().await?;
    let it = load(&**client, org.id, slug, false).await?;
    match client.query_opt("SELECT name, path FROM ot.work_attachments WHERE id = $1 AND work_id = $2", &[&aid, &it.id]).await? {
        Some(r) => Ok((r.get(0), r.get(1))),
        None => refuse!(NotFound, "no attachment {aid} on {}", it.slug),
    }
}

#[logged]
pub async fn detach(engine: &Arc<Engine>, org: &Arc<OrgHandle>, slug: &str, aid: &str) -> Result<Value> {
    let (name, path) = attachment(engine, org, slug, aid).await?;
    let client = engine.db.get().await?;
    client.execute("DELETE FROM ot.work_attachments WHERE id = $1", &[&aid]).await?;
    let it = load(&**client, org.id, slug, false).await?;
    client
        .execute(
            "INSERT INTO ot.work_events (work_id, by, op, detail) VALUES ($1, '\"user\"', 'detach', $2)",
            &[&it.id, &json!({ "name": name })],
        )
        .await?;
    drop(client);
    let _ = std::fs::remove_file(&path);
    changed(engine, org);
    Ok(json!({ "removed": aid }))
}

/// The docket text an agent's prompt and status read: its own items.
#[logged]
pub async fn owned_summary(client: &impl GenericClient, agent_id: i64) -> Result<Vec<Value>> {
    Ok(client
        .query(
            "SELECT slug, title, status FROM ot.work_items
              WHERE owner_agent_id = $1 AND archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean, false)
              ORDER BY coalesce(docket_at, updated_at) DESC LIMIT 20",
            &[&agent_id],
        )
        .await?
        .iter()
        .map(|r| json!({ "slug": r.get::<_, String>(0), "title": r.get::<_, String>(1), "status": r.get::<_, String>(2) }))
        .collect())
}
