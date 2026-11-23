//! Importing an export, and the second half of a duplicate
//! (docs/rust-engine/agent-export.md, "Import").
//!
//! Cheap checks come first (USER 2026-11-15 15:04Z: no wasted time): the file
//! is opened and checked whole, the plan is worked out, the disk is measured,
//! and only then is anything created. Step 1 creates the nodes in one
//! transaction (`domain::ops::import`); a refusal there leaves nothing behind.
//! Step 2, here, brings each node's history and files in, outside any long
//! transaction. A failure in step 2 never undoes a finished node: the import
//! ends, says what is left, and every agent whose own parts are in place is
//! let go. An agent whose transcript could not be read stays held, with the
//! reason in the result.
//!
//! What comes in as history stays history. Transcript rows go in below the
//! range the agent's actor writes (seq <= 0, ver 0, as `runtime::history`
//! does for a 3.x agent). Mail is restored only between the imported nodes;
//! mail with anyone else, questions and undelivered mail go to a folder of
//! the agent's own, `imported-history`, and never into this organization's
//! inbox. Nothing is live afterwards: no mail waits, no question is open, no
//! watchdog runs unless the importer asked for that.
//!
//! Never mark these agents with `extra.imported_from`: that is the 3.x
//! upgrade's own mark, and `runtime::history::ensure` replaces the history
//! rows of an agent that has it. The mark here is `extra.ported`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::runtime::Handle;

use super::credits::Shrink;
use super::format::{self, Node};
use super::reader::Export;
use crate::domain::ops::import::{self as nodes, Created};
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::orgs::OrgHandle;

/// What to import, where, and for whom.
pub struct Request {
    pub org: Arc<OrgHandle>,
    pub actor: Actor,
    pub file: PathBuf,
    /// The node it goes under; `None` is the top level.
    pub dest: Option<String>,
    pub index: Option<usize>,
    pub strategy: Option<Shrink>,
    /// The digest of the plan that was previewed.
    pub expect: Option<String>,
    /// Arm the watchdogs that can run anywhere, once everything is in place.
    pub resume_watchdogs: bool,
    /// The user's own import from a window: one entry of the undo history.
    pub record: bool,
    /// The file is a copy this engine has just made of its own nodes.
    pub duplicate: bool,
}

/// How far a running import is.
#[derive(Default)]
pub struct Progress {
    pub step: arc_swap::ArcSwap<String>,
    pub nodes: AtomicU64,
    pub total: AtomicU64,
    pub bytes: AtomicU64,
    pub bytes_total: AtomicU64,
}

/// The folder in an agent's own folder that holds what did not become rows here.
pub const HISTORY_DIR: &str = "imported-history";
/// Free space kept beyond what the file unpacks to.
const DISK_MARGIN: u64 = 512 * 1024 * 1024;

#[nolog]
fn phase1<'a>(req: &Request, export: &'a Export, origin: Value) -> nodes::Request<'a> {
    nodes::Request { nodes: &export.nodes, audiences: &export.links.audiences, dest: req.dest.clone(), index: req.index, strategy: req.strategy, origin,
                     expect: req.expect.clone(), duplicate: req.duplicate, record: req.record }
}

/// Where the nodes came from, as each keeps it.
#[nolog]
fn origin(export: &Export) -> Value {
    let m = &export.manifest;
    json!({ "engine": m.origin.engine, "org_uuid": m.origin.org_uuid, "org_slug": m.origin.org_slug, "org_name": m.origin.org_name,
            "by": m.origin.by, "exported_at": m.exported_at, "orgtree_version": m.orgtree_version })
}

/// What the file says of itself, for whoever decides on it.
#[nolog]
fn about(engine: &Engine, req: &Request, export: &Export) -> Value {
    let m = &export.manifest;
    json!({
        "orgtree_version": m.orgtree_version, "exported_at": m.exported_at, "root": m.root, "subtree": m.subtree,
        "from": { "organization": m.origin.org_name, "by": m.origin.by },
        "counts": m.counts, "unpacked_bytes": m.bytes.unpacked, "file_bytes": export.file_bytes, "include": m.include, "secrets": m.secrets,
        // made on another computer, or changed since it was made: nothing more depends on it
        "foreign": !req.duplicate && !super::seal::made_here(engine, m),
        "watchdogs": export.links.watchdogs.len(), "audiences": export.links.audiences.len(), "left_out": export.links.left_out,
    })
}

/// Why this disk cannot take the file, when it cannot.
#[nolog]
fn disk_short(engine: &Engine, export: &Export) -> Option<String> {
    let need = export.manifest.bytes.unpacked.saturating_add(DISK_MARGIN);
    let free = crate::domain::docs::free_bytes(&engine.cfg.data_root)?;
    (free < need).then(|| format!("the disk has {:.1} GB free and this needs {:.1} GB", free as f64 / 1e9, need as f64 / 1e9))
}

#[nolog]
async fn open(file: &Path) -> Result<Export> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || Export::open(&file)).await.context("reading the export stopped unexpectedly")?
}

/// What the import would do, with nothing created: the plan, and what the file says of itself.
#[nolog]
pub async fn preview(engine: &Arc<Engine>, req: &Request) -> Result<Value> {
    let export = open(&req.file).await?;
    let plan = nodes::preview(engine, &req.org, &req.actor, &phase1(req, &export, origin(&export))).await?;
    let mut out = plan.json();
    out["file"] = about(engine, req, &export);
    if let Some(why) = disk_short(engine, &export).filter(|_| plan.refusal.is_none()) {
        out["refusal"] = json!(why);
        out["ok"] = json!(false);
    }
    Ok(out)
}

/// Import the file. The result names every node created, what was changed on the way, and
/// what is left when a part could not be brought in.
#[nolog]
pub async fn run(engine: Arc<Engine>, req: Request, progress: Arc<Progress>) -> Result<Value> {
    progress.step.store(Arc::new("checking the file".to_string()));
    let export = open(&req.file).await?;
    if let Some(why) = disk_short(&engine, &export) {
        crate::refuse!(Conflict, "{why}");
    }
    let file = about(&engine, &req, &export);
    progress.total.store(export.nodes.len() as u64, Ordering::Relaxed);
    progress.bytes_total.store(export.manifest.bytes.unpacked, Ordering::Relaxed);
    progress.step.store(Arc::new("creating the nodes".to_string()));
    let (created, fx) = nodes::create(&engine, &req.org, &req.actor, &phase1(&req, &export, origin(&export))).await?;
    crate::domain::ops::apply_effects(&engine, &req.org, fx).await;
    if created.history_entry.is_some() {
        crate::domain::undo::import_published(&engine, &req.org);
    }
    let handle = Handle::current();
    let at = Utc::now();
    let content = {
        let (engine, org, progress, duplicate) = (engine.clone(), req.org.clone(), progress.clone(), req.duplicate);
        let (ids, names): (Vec<i64>, Vec<String>) = (created.ids.clone(), created.plan.nodes.iter().map(|p| p.name.clone()).collect());
        let retired: Vec<bool> = created.plan.nodes.iter().map(|p| p.retired).collect();
        tokio::task::spawn_blocking(move || {
            let mut cx = Content { handle, engine, org, export, ids, names, retired, duplicate, at, progress, leftovers: Vec::new(), done: Vec::new(), sessions: Vec::new(),
                                   waiting: Vec::new(), archived: Vec::new() };
            cx.all();
            cx
        })
        .await
        .context("the import stopped unexpectedly")?
    };
    progress.step.store(Arc::new("finishing".to_string()));
    let watchdogs = watchdogs(&engine, &req, &content, &created).await;
    let released = finish(&engine, &req, &content, &created).await;
    let held: Vec<&str> = created.plan.nodes.iter().enumerate()
        .filter(|(at, p)| !p.retired && !p.project && !released.contains(&created.ids[*at])).map(|(_, p)| p.name.as_str()).collect();
    let mut out = json!({
        "root": created.plan.nodes[0].name,
        "nodes": created.plan.nodes.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        "plan": created.plan.json(),
        "file": file,
        "audiences": created.audiences,
        "watchdogs": watchdogs,
        "notes": created.notes,
        "leftovers": content.leftovers,
        "held": held,
        "sessions_carried": content.sessions.iter().filter(|carried| **carried).count(),
        "complete": content.leftovers.is_empty(),
    });
    if let Some(entry) = &created.history_entry {
        out["history_entry"] = entry.clone();
    }
    Ok(out)
}

/// Step 2 on its own thread: the file is read there, and each page of rows is written from it.
struct Content {
    handle: Handle,
    engine: Arc<Engine>,
    org: Arc<OrgHandle>,
    export: Export,
    ids: Vec<i64>,
    names: Vec<String>,
    retired: Vec<bool>,
    duplicate: bool,
    /// When the nodes were created: nothing brought in is newer than this.
    at: DateTime<Utc>,
    progress: Arc<Progress>,
    /// What could not be brought in, in words.
    leftovers: Vec<String>,
    /// Whether each node's own parts are all in place.
    done: Vec<bool>,
    /// Whether each node goes on with its own CLI session.
    sessions: Vec<bool>,
    /// How many messages were waiting for each node when it was exported.
    waiting: Vec<u64>,
    /// Whether each node has an `imported-history` folder.
    archived: Vec<bool>,
}

#[nolog]
fn stamp(value: &Value) -> Option<DateTime<Utc>> {
    let text = value.as_str()?;
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc)).or_else(|| crate::util::parse_ts(text))
}

/// `path` moved from under `from` to under `to`, when it lies there.
#[nolog]
fn moved(path: &str, from: &str, to: &Path) -> Option<String> {
    if from.is_empty() || !crate::domain::scope::path_within(path, from) {
        return None;
    }
    let rest = path.get(from.trim_end_matches(['\\', '/']).len()..)?.trim_start_matches(['\\', '/']);
    let mut out = to.to_path_buf();
    for part in rest.split(['\\', '/']).filter(|p| !p.is_empty()) {
        if !crate::http::scratch_files::upload_name(part) {
            return None;
        }
        out.push(part);
    }
    Some(out.to_string_lossy().to_string())
}

#[nolog]
impl Content {
    fn step(&self, text: String) {
        self.progress.step.store(Arc::new(text));
    }

    fn client(&self) -> Result<deadpool_postgres::Object> {
        Ok(self.handle.block_on(self.engine.db.get())?)
    }

    fn scratch(&self, at: usize) -> PathBuf {
        if self.export.nodes[at].kind == crate::domain::projects::KIND {
            crate::domain::teams::workspace(&self.engine.cfg.teams_dir(&self.org.slug), self.ids[at])
        } else {
            self.engine.cfg.scratch_root(&self.org.slug).join(&self.names[at])
        }
    }

    fn uploads(&self, at: usize) -> PathBuf {
        self.engine.cfg.path("uploads").join(&self.org.slug).join(&self.names[at])
    }

    /// The folder of the team under the node.
    fn team(&self, at: usize) -> PathBuf {
        crate::domain::teams::workspace(&self.engine.cfg.teams_dir(&self.org.slug), self.ids[at])
    }

    /// Every node, then what lies between them. A node's failure is its own: the rest go on.
    fn all(&mut self) {
        let n = self.ids.len();
        self.done = vec![false; n];
        self.sessions = vec![false; n];
        self.waiting = vec![0; n];
        self.archived = vec![false; n];
        for at in 0..n {
            self.step(format!("bringing in {}", self.names[at]));
            match self.node(at) {
                Ok(()) => self.done[at] = true,
                Err(error) => self.leftovers.push(format!("{}: {error:#}", self.names[at])),
            }
            self.progress.nodes.fetch_add(1, Ordering::Relaxed);
        }
        if !self.duplicate {
            self.step("bringing in the mail".to_string());
            if let Err(error) = self.mail() {
                self.leftovers.push(format!("the mail between the imported nodes: {error:#}"));
            }
            self.step("bringing in the docket items".to_string());
            if let Err(error) = self.docket() {
                self.leftovers.push(format!("the docket items: {error:#}"));
            }
        }
    }

    fn node(&mut self, at: usize) -> Result<()> {
        let old: Node = self.export.nodes[at].clone();
        let project = old.kind == crate::domain::projects::KIND;
        // the transcript first: an agent without it is not let go
        self.convo(at)?;
        self.rows(at, format::TOOL_IMAGES, "INSERT INTO ot.tool_images (agent_id, tool_id, idx, media, data, at)
            SELECT $1::bigint, r->>'tool_id', (r->>'idx')::int, r->>'media', decode(r->>'data', 'base64'), least(coalesce((r->>'at')::timestamptz, $3::timestamptz), $3::timestamptz)
              FROM jsonb_array_elements($2::jsonb) r WHERE r->>'tool_id' IS NOT NULL AND r->>'media' IS NOT NULL AND r->>'data' IS NOT NULL
            ON CONFLICT DO NOTHING", 20, None)?;
        if !self.duplicate {
            // the cost ledger and the sessions it ran: an import's, never a duplicate's (question 6)
            self.rows(at, format::TURNS, "INSERT INTO ot.turns (agent_id, started_at, ended_at, cost_usd, cost_source, estimated, toks, input_tokens, cache_read, cache_write,
                                                                 cache_ttl_s, ms, denials, approvals, killed, error, account, api_key, model, sent_at, do_not_disturb)
                SELECT $1::bigint, least(coalesce(r.started_at, $3::timestamptz), $3::timestamptz), least(coalesce(r.ended_at, r.started_at, $3::timestamptz), $3::timestamptz), r.cost_usd, r.cost_source, coalesce(r.estimated, false), r.toks,
                       r.input_tokens, r.cache_read, r.cache_write, r.cache_ttl_s, r.ms, coalesce(r.denials, 0), r.approvals, coalesce(r.killed, false), r.error, r.account,
                       coalesce(r.api_key, false), r.model, least(r.sent_at, $3::timestamptz), coalesce(r.do_not_disturb, false)
                  FROM jsonb_array_elements($2::jsonb) e, jsonb_populate_record(NULL::ot.turns, e) r", 500, Some("turns"))?;
            self.rows(at, format::SESSIONS, "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id, started_at, ended_at, end_reason, transcript_file)
                SELECT $1::bigint, coalesce(r.generation, 1), coalesce(r.provider, ''), r.session_id, least(coalesce(r.started_at, $3::timestamptz), $3::timestamptz), least(coalesce(r.ended_at, $3::timestamptz), $3::timestamptz),
                       coalesce(r.end_reason, 'imported'), NULL
                  FROM jsonb_array_elements($2::jsonb) e, jsonb_populate_record(NULL::ot.agent_sessions, e) r WHERE r.session_id IS NOT NULL", 500, Some("sessions"))?;
        }
        self.documents(at)?;
        // the folders, then the records of the files in them
        let scratch = self.scratch(at);
        std::fs::create_dir_all(&scratch).with_context(|| format!("its folder {}", scratch.display()))?;
        if project {
            self.folder(at, format::TEAM, &scratch)?;
            self.icon(at)?;
        } else {
            self.folder(at, format::SCRATCH, &scratch)?;
            let team = crate::domain::teams::workspace(&self.engine.cfg.teams_dir(&self.org.slug), self.ids[at]);
            if !self.export.files_under(&self.export.of(at, format::TEAM)).is_empty() {
                std::fs::create_dir_all(&team)?;
                self.folder(at, format::TEAM, &team)?;
            }
        }
        self.sent_files(at, &old, &scratch)?;
        self.uploaded(at, &old)?;
        if !self.duplicate {
            self.questions(at, &scratch)?;
        }
        if !project && !self.retired[at] {
            self.sessions[at] = self.session(at, &old, &scratch).unwrap_or_else(|error| {
                tracing::warn!(agent = self.ids[at], error = %format!("{error:#}"), "an imported agent's CLI session could not be placed; it starts on a fresh one");
                false
            });
        }
        // where its files were, for whoever resolves a path its history names
        let paths = json!({ "scratch": [old.scratch_dir, scratch.to_string_lossy()], "uploads": [old.uploads_dir, self.uploads(at).to_string_lossy()],
                            "team": [old.team_dir, crate::domain::teams::workspace(&self.engine.cfg.teams_dir(&self.org.slug), self.ids[at]).to_string_lossy()] });
        let client = self.client()?;
        self.handle.block_on(client.execute("UPDATE ot.agents SET extra = jsonb_set(extra, '{ported,paths}', $2) WHERE id = $1 AND extra ? 'ported'", &[&self.ids[at], &paths]))?;
        Ok(())
    }

    /// Whether a part that cannot be written twice is already in (a resumed import).
    fn has(&self, at: usize, part: &str) -> Result<bool> {
        let client = self.client()?;
        Ok(self.handle.block_on(client.query_one("SELECT coalesce(extra->'ported'->'parts' ? $2, false) FROM ot.agents WHERE id = $1", &[&self.ids[at], &part]))?.get(0))
    }

    /// One of a node's parts into its table, a page at a time. `sql` takes the node, a page of
    /// records and the import's time. A part named in `once` is written in one transaction
    /// with its own mark, so it is never written twice; the others are keyed and may repeat.
    fn rows(&mut self, at: usize, part: &str, sql: &str, page: usize, once: Option<&str>) -> Result<()> {
        let name = self.export.of(at, part);
        if self.export.listed(&name).is_none() {
            return Ok(());
        }
        if let Some(mark) = once {
            if self.has(at, mark)? {
                return Ok(());
            }
        }
        let (id, when) = (self.ids[at], self.at);
        let mut client = self.client()?;
        let handle = self.handle.clone();
        let tx = handle.block_on(client.transaction())?;
        let Some((mut lines, _)) = self.export.lines(&name)? else { return Ok(()) };
        let mut batch: Vec<Value> = Vec::with_capacity(page);
        loop {
            let next = lines.next()?;
            if let Some(mut row) = next.clone() {
                crate::util::pg_json_mut(&mut row);
                batch.push(row);
            }
            if batch.len() >= page || (next.is_none() && !batch.is_empty()) {
                handle.block_on(tx.execute(sql, &[&id, &Value::Array(std::mem::take(&mut batch)), &when])).with_context(|| format!("its {part}"))?;
            }
            if next.is_none() {
                break;
            }
        }
        if let Some(mark) = once {
            handle.block_on(tx.execute(
                "UPDATE ot.agents SET extra = jsonb_set(extra, '{ported,parts}', coalesce(extra->'ported'->'parts', '[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1 AND extra ? 'ported'",
                &[&id, &mark]))?;
        }
        handle.block_on(tx.commit())?;
        Ok(())
    }

    /// The transcript, below the range the agent's actor writes, in its order. Two rows of the
    /// import's own close it: the state it was left in, ended (when that was not idle), and at
    /// seq 0 the line that says where everything above happened. The actor's own first row here
    /// is then seq 1: a row at 0 or below is never amended (`ConvoWriter::update_batch`), so
    /// none of the actor's may land there.
    fn convo(&mut self, at: usize) -> Result<()> {
        if self.export.nodes[at].kind == crate::domain::projects::KIND {
            return Ok(());
        }
        let name = self.export.of(at, format::CONVO);
        let (id, when, handle) = (self.ids[at], self.at, self.handle.clone());
        let client = self.client()?;
        // how it ends, before any row gets its place
        let (mut total, mut last_state): (i64, Option<String>) = (0, None);
        if let Some((mut lines, _)) = self.export.lines(&name)? {
            while let Some(row) = lines.next()? {
                let Some(body) = row["body"].as_object() else { continue };
                total += 1;
                if body.get("kind").and_then(Value::as_str) == Some("state") {
                    last_state = body.get("state").and_then(Value::as_str).map(str::to_string);
                }
            }
        }
        let closing = last_state.as_deref().is_some_and(|state| state != "idle");
        let first = -total - i64::from(closing);
        if let Some((mut lines, _)) = self.export.lines(&name)? {
            let mut batch: Vec<Value> = Vec::with_capacity(200);
            let mut k: i64 = 0;
            loop {
                let next = lines.next()?;
                if let Some(mut row) = next.clone() {
                    let was = row["seq"].as_i64();
                    let mut body = row["body"].take();
                    if let Some(members) = body.as_object_mut() {
                        let seq = first + k;
                        k += 1;
                        members.insert("seq".into(), json!(seq));
                        members.insert("row_id".into(), json!(format!("r{seq}")));
                        members.insert("event_id".into(), json!(format!("h{}", -seq)));
                        // a tool's input is kept with its row: the chip says which
                        for chip in members.get_mut("tools").and_then(Value::as_array_mut).into_iter().flatten() {
                            for key in ["input_seq", "output_seq"] {
                                if chip.get(key).is_some_and(|v| v.as_i64() == was && was.is_some()) {
                                    chip[key] = json!(seq);
                                }
                            }
                        }
                        let mut record = json!({ "seq": seq, "at": row["at"], "body": body, "tool_inputs": row["tool_inputs"], "tool_native_inputs": row["tool_native_inputs"] });
                        crate::util::pg_json_mut(&mut record);
                        batch.push(record);
                    }
                }
                if batch.len() >= 200 || (next.is_none() && !batch.is_empty()) {
                    handle.block_on(client.execute(
                        "INSERT INTO ot.convo (agent_id, seq, ver, at, body, tool_inputs, tool_native_inputs)
                         SELECT $1::bigint, (r->>'seq')::bigint, 0, least(coalesce((r->>'at')::timestamptz, $3::timestamptz), $3::timestamptz), r->'body',
                                CASE WHEN jsonb_typeof(r->'tool_inputs') = 'object' THEN r->'tool_inputs' ELSE '{}'::jsonb END,
                                CASE WHEN jsonb_typeof(r->'tool_native_inputs') = 'object' THEN r->'tool_native_inputs' ELSE '{}'::jsonb END
                           FROM jsonb_array_elements($2::jsonb) r WHERE jsonb_typeof(r->'body') = 'object'
                         ON CONFLICT DO NOTHING",
                        &[&id, &Value::Array(std::mem::take(&mut batch)), &when])).context("its transcript")?;
                }
                if next.is_none() {
                    break;
                }
            }
        }
        let not_sent = crate::runtime::token_counts::not_counted(crate::runtime::token_counts::NOT_SENT);
        if closing {
            // it was exported in some state and arrives idle: its history says so, at the time it was exported
            let then = stamp(&json!(self.export.manifest.exported_at)).unwrap_or(when).min(when);
            let body = json!({ "role": "system", "kind": "state", "ts": crate::util::iso(then), "state": "idle", "prev_state": last_state, "prev_secs": null,
                               "text": "Idle", "seq": -1, "row_id": "r-1", "event_id": "h1", "tokens": not_sent });
            handle.block_on(client.execute("INSERT INTO ot.convo (agent_id, seq, ver, at, body) VALUES ($1, -1, 0, $2, $3) ON CONFLICT DO NOTHING", &[&id, &then, &body]))?;
        }
        let old = &self.export.nodes[at];
        let text = if self.duplicate {
            format!("Copied from {}.{}", old.name, if total > 0 { format!(" Everything above is {}'s conversation up to the copy.", old.name) } else { String::new() })
        } else {
            format!("Imported from the organization \"{}\".{}", self.export.manifest.origin.org_name,
                    if total > 0 { " Everything above happened there." } else if !self.export.manifest.include.transcript { " Its transcript was not exported." } else { "" })
        };
        let body = json!({ "role": "system", "kind": "ported", "ts": crate::util::iso(when), "text": text, "seq": 0, "row_id": "r0", "event_id": "h0", "tokens": not_sent });
        handle.block_on(client.execute("INSERT INTO ot.convo (agent_id, seq, ver, at, body) VALUES ($1, 0, 0, $2, $3) ON CONFLICT DO NOTHING", &[&id, &when, &body]))?;
        Ok(())
    }

    /// What it presented: rows of this organization, already seen, under their own titles.
    fn documents(&mut self, at: usize) -> Result<()> {
        let renamed: Value = self.export.nodes.iter().zip(&self.names).map(|(old, new)| (old.name.clone(), json!(new))).collect::<serde_json::Map<String, Value>>().into();
        let (name, owner) = (self.names[at].clone(), renamed);
        // who presented it: the node's name here. A presenter that did not come along is a name of the
        // organization it left, and here it could be somebody else's: only a copy keeps it.
        let presenter = if self.duplicate { format!("coalesce({owner}::jsonb->>(r->>'presented_by'), r->>'presented_by')", owner = quote(&owner.to_string())) }
                        else { format!("{owner}::jsonb->>(r->>'presented_by')", owner = quote(&owner.to_string())) };
        self.rows(at, format::DOCUMENTS, &format!(
            "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, at, dismissed, download, preview, viewed_at, presented_by)
             SELECT 'd' || replace(gen_random_uuid()::text, '-', ''), {org}, $1::bigint, {name}, coalesce(r->>'title', ''), r->>'body', coalesce(r->>'format', 'markdown'),
                    coalesce((r->>'bytes')::int, 0), least(coalesce((r->>'at')::timestamptz, $3::timestamptz), $3::timestamptz), coalesce((r->>'dismissed')::boolean, false),
                    CASE WHEN r->>'download' IS NULL THEN NULL ELSE decode(r->>'download', 'base64') END, r->>'preview',
                    least(coalesce((r->>'viewed_at')::timestamptz, $3::timestamptz), $3::timestamptz), {presenter}
               FROM jsonb_array_elements($2::jsonb) r",
            org = self.org.id, name = quote(&name)), 10, Some("documents"))
    }

    /// One of the node's folders, unpacked into `dest`. Only what the index names is taken, and
    /// only to a plain path inside `dest`; nothing is written through a link.
    fn folder(&mut self, at: usize, part: &str, dest: &Path) -> Result<()> {
        let prefix = self.export.of(at, part);
        for folder in self.export.folders_under(&prefix) {
            let _ = std::fs::create_dir_all(inside(dest, &folder).ok_or_else(|| anyhow!("a folder of the file names a place outside its own"))?);
        }
        let mut failed: Vec<String> = Vec::new();
        for (name, inner, _) in self.export.files_under(&prefix) {
            let Some(to) = inside(dest, &inner) else {
                failed.push(format!("{inner} (not a path inside its folder)"));
                continue;
            };
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
                if linked(dest, parent) {
                    failed.push(format!("{inner} (a link stands in its way)"));
                    continue;
                }
            }
            let progress = self.progress.clone();
            if let Err(error) = self.export.unpack(&name, &to, &mut |n| {
                progress.bytes.fetch_add(n, Ordering::Relaxed);
            }) {
                failed.push(format!("{inner} ({error:#})"));
            }
        }
        if !failed.is_empty() {
            let shown: Vec<&str> = failed.iter().take(8).map(String::as_str).collect();
            return Err(anyhow!("{} file(s) of its {part} folder could not be written: {}{}", failed.len(), shown.join("; "), if failed.len() > shown.len() { "; …" } else { "" }));
        }
        Ok(())
    }

    /// A project's uploaded icon: the record it was stored as, under the new project.
    fn icon(&mut self, at: usize) -> Result<()> {
        let name = self.export.of(at, format::ICON);
        let Some(bytes) = self.export.part(&name, 8 * 1024 * 1024)? else { return Ok(()) };
        let record: crate::profile_pictures::wire::PictureRecord = serde_json::from_slice(&bytes).context("its icon")?;
        let Some(sha) = self.export.nodes[at].scope["theme_icon_custom"].as_str().filter(|s| crate::domain::projects::valid_theme_icon_custom(s)).map(str::to_string) else { return Ok(()) };
        let client = self.client()?;
        let key = crate::domain::projects::icon_key(self.org.id, self.ids[at]);
        self.handle.block_on(client.execute("INSERT INTO ot.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[&key, &serde_json::to_value(&record)?]))?;
        self.handle.block_on(client.execute("UPDATE ot.agents SET scope = scope || jsonb_build_object('theme_icon_custom', $2::text), row_version = row_version + 1 WHERE id = $1", &[&self.ids[at], &sha]))?;
        Ok(())
    }

    /// The files it sent: each record follows its file into the new folder; a file that lay
    /// outside the agent's own folder did not come along, and its record stays behind.
    fn sent_files(&mut self, at: usize, old: &Node, scratch: &Path) -> Result<()> {
        let name = self.export.of(at, format::DELIVERIES);
        if self.export.listed(&name).is_none() || self.has(at, "deliveries")? {
            return Ok(());
        }
        let mut kept: Vec<Value> = Vec::new();
        if let Some((mut lines, _)) = self.export.lines(&name)? {
            while let Some(mut row) = lines.next()? {
                let Some(path) = row["path"].as_str().and_then(|path| moved(path, &old.scratch_dir, scratch)) else { continue };
                if Path::new(&path).is_file() {
                    row["path"] = json!(path);
                    crate::util::pg_json_mut(&mut row);
                    kept.push(row);
                }
            }
        }
        let client = self.client()?;
        self.handle.block_on(client.execute(&format!(
            "WITH put AS (INSERT INTO ot.deliveries (uid, org_id, agent_id, name, path, bytes, note, at)
               SELECT 'f' || replace(gen_random_uuid()::text, '-', ''), {org}, $1::bigint, coalesce(r->>'name', ''), r->>'path', coalesce((r->>'bytes')::bigint, 0), r->>'note',
                      least(coalesce((r->>'at')::timestamptz, $3::timestamptz), $3::timestamptz) FROM jsonb_array_elements($2::jsonb) r)
             UPDATE ot.agents SET extra = jsonb_set(extra, '{{ported,parts}}', coalesce(extra->'ported'->'parts', '[]'::jsonb) || '\"deliveries\"'::jsonb) WHERE id = $1::bigint AND extra ? 'ported'",
            org = self.org.id), &[&self.ids[at], &Value::Array(kept), &self.at])).context("its sent files")?;
        Ok(())
    }

    /// The files the user gave it: unpacked into its uploads folder here, each with its record.
    fn uploaded(&mut self, at: usize, old: &Node) -> Result<()> {
        let name = self.export.of(at, format::UPLOADS);
        if self.export.listed(&name).is_none() || self.has(at, "uploads")? {
            return Ok(());
        }
        let dest = self.uploads(at);
        let prefix = self.export.of(at, format::UPLOAD_FILES);
        let files = self.export.files_under(&prefix);
        let mut kept: Vec<Value> = Vec::new();
        if let Some((mut lines, _)) = self.export.lines(&name)? {
            while let Some(row) = lines.next()? {
                kept.push(row);
            }
        }
        let mut rows: Vec<Value> = Vec::new();
        for mut row in kept {
            // the export stored each upload under its file's own name
            let Some(file) = row["path"].as_str().and_then(|path| path.rsplit(['\\', '/']).next()).map(str::to_string) else { continue };
            let Some((part, _, _)) = files.iter().find(|(_, inner, _)| *inner == file) else { continue };
            let Some(to) = inside(&dest, &file) else { continue };
            std::fs::create_dir_all(&dest)?;
            let progress = self.progress.clone();
            self.export.unpack(part, &to, &mut |n| {
                progress.bytes.fetch_add(n, Ordering::Relaxed);
            })?;
            row["path"] = json!(to.to_string_lossy());
            crate::util::pg_json_mut(&mut row);
            rows.push(row);
        }
        let _ = old;
        let client = self.client()?;
        self.handle.block_on(client.execute(&format!(
            "WITH put AS (INSERT INTO ot.uploads (id, org_id, agent_id, name, path, bytes, at)
               SELECT 'u' || replace(gen_random_uuid()::text, '-', ''), {org}, $1::bigint, coalesce(r->>'name', ''), r->>'path', coalesce((r->>'bytes')::bigint, 0),
                      least(coalesce((r->>'at')::timestamptz, $3::timestamptz), $3::timestamptz) FROM jsonb_array_elements($2::jsonb) r)
             UPDATE ot.agents SET extra = jsonb_set(extra, '{{ported,parts}}', coalesce(extra->'ported'->'parts', '[]'::jsonb) || '\"uploads\"'::jsonb) WHERE id = $1::bigint AND extra ? 'ported'",
            org = self.org.id), &[&self.ids[at], &Value::Array(rows), &self.at])).context("its uploads")?;
        Ok(())
    }

    /// Its questions to the user go to its own folder: none is asked again here.
    fn questions(&mut self, at: usize, scratch: &Path) -> Result<()> {
        let name = self.export.of(at, format::ASKS);
        let Some((mut lines, _)) = self.export.lines(&name)? else { return Ok(()) };
        let mut text = Vec::new();
        while let Some(row) = lines.next()? {
            serde_json::to_writer(&mut text, &row)?;
            text.push(b'\n');
        }
        if !text.is_empty() {
            self.archive(at, scratch, "questions.jsonl", &text)?;
        }
        Ok(())
    }

    /// A file of the node's `imported-history` folder, with the note that says what the folder is.
    fn archive(&mut self, at: usize, scratch: &Path, file: &str, bytes: &[u8]) -> Result<()> {
        let folder = scratch.join(HISTORY_DIR);
        std::fs::create_dir_all(&folder)?;
        if linked(scratch, &folder) {
            return Err(anyhow!("a link stands where its {HISTORY_DIR} folder goes"));
        }
        std::fs::write(folder.join(file), bytes)?;
        let note = folder.join("README.md");
        if !note.exists() {
            let m = &self.export.manifest;
            std::fs::write(note, format!(
                "# Imported history\r\n\r\nThis agent was exported from the organization \"{}\" on {} and imported here on {}.\r\n\r\n\
                 These files hold what belonged to it there and did not become part of this organization's own records:\r\n\r\n\
                 - `mail.jsonl`: its mail with the user and with anyone who was not imported with it, and mail that was still waiting for it.\r\n\
                 - `questions.jsonl`: the questions it asked the user. None is open here.\r\n\r\n\
                 One record per line, as that organization stored it. Nothing here is delivered, asked or answered again.\r\n",
                m.origin.org_name, m.exported_at, crate::util::iso(self.at)))?;
        }
        self.archived[at] = true;
        Ok(())
    }

    /// The agent's CLI session, under a new id and in the folder its CLI reads here. False
    /// when its harness keeps none that can be carried, or the file holds none.
    fn session(&mut self, at: usize, old: &Node, scratch: &Path) -> Result<bool> {
        let Some(session) = old.session.as_ref().filter(|s| s.files && super::sessions::plain_id(&s.id)) else { return Ok(false) };
        let prefix = format!("{}/{}", self.export.of(at, format::NATIVE), session.harness);
        let files = self.export.files_under(&prefix);
        if files.is_empty() {
            return Ok(false);
        }
        let client = self.client()?;
        let row = self.handle.block_on(client.query_one("SELECT tier, account, extra FROM ot.agents WHERE id = $1", &[&self.ids[at]]))?;
        let (tier, account, extra): (String, Option<String>, Value) = (row.get(0), row.get(1), row.get(2));
        // only onto the harness that wrote it
        if super::sessions::harness_of(&tier, &extra) != session.harness {
            return Ok(false);
        }
        let new = uuid::Uuid::new_v4().to_string();
        let Some(home) = super::sessions::home(&self.engine, &session.harness, account.as_deref()) else { return Ok(false) };
        let staged = scratch.join(format!(".orgtree-session-{new}"));
        std::fs::create_dir_all(&staged)?;
        let _swept = Sweep(staged.clone());
        let mut unpacked: Vec<(String, PathBuf)> = Vec::new();
        for (name, inner, _) in &files {
            let Some(to) = inside(&staged, inner) else { return Ok(false) };
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            self.export.unpack(name, &to, &mut |_| {})?;
            unpacked.push((inner.clone(), to));
        }
        if !super::sessions::place(&session.harness, &home, scratch, &session.id, &new, &unpacked)? {
            return Ok(false);
        }
        // as the actor records a session it has just learned (`runtime::actor`, "a new session"): the
        // id, and the provider it belongs to. A Codex thread is resumed only when that provider is
        // the seat's own, so a session without it would never be gone on with.
        let provider = crate::providers::catalog::provider_of(&tier).to_string();
        let taken = self.handle.block_on(client.execute(
            "WITH put AS (UPDATE ot.agents SET session_id = $2::text, provider = $3::text, occupancy = NULL, occupancy_est = true, row_version = row_version + 1
                           WHERE id = $1::bigint AND session_id IS NULL RETURNING id, generation)
             INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id) SELECT id, generation, $3::text, $2::text FROM put",
            &[&self.ids[at], &new, &provider]))?;
        Ok(taken > 0)
    }

    /// The mail of the file: a message between two imported nodes becomes a message between
    /// them here, as it stood; any other goes to the `imported-history` of the nodes it names.
    fn mail(&mut self) -> Result<()> {
        if self.export.listed(format::MAIL).is_none() {
            return Ok(());
        }
        let root = self.ids[0];
        let already = {
            let client = self.client()?;
            self.handle.block_on(client.query_one("SELECT coalesce(extra->'ported'->'parts' ? 'mail', false) FROM ot.agents WHERE id = $1", &[&root]))?.get::<_, bool>(0)
        };
        let n = self.ids.len();
        let mut kept: Vec<Vec<u8>> = vec![Vec::new(); n];
        let mut uids: HashMap<String, String> = HashMap::new();
        let mut client = self.client()?;
        let handle = self.handle.clone();
        let tx = handle.block_on(client.transaction())?;
        let Some((mut lines, _)) = self.export.lines(format::MAIL)? else { return Ok(()) };
        let mut batch: Vec<Value> = Vec::new();
        loop {
            let next = lines.next()?;
            if let Some(mut row) = next.clone() {
                let place = |v: &Value| v.as_u64().map(|i| i as usize).filter(|i| *i < n);
                let (from, to) = (place(&row["sender_node"]), place(&row["recipient_node"]));
                let state = row["state"].as_str().unwrap_or("").to_string();
                let waiting = matches!(state.as_str(), "pending" | "delivering");
                if let (true, Some(to)) = (waiting, to) {
                    self.waiting[to] += 1;
                }
                match (from, to) {
                    (Some(from), Some(to)) if !waiting && matches!(state.as_str(), "delivered" | "read" | "retracted") => {
                        let uid = crate::util::uid("m");
                        if let Some(old) = row["uid"].as_str() {
                            uids.insert(old.to_string(), uid.clone());
                        }
                        row["uid"] = json!(uid);
                        row["s"] = json!(self.ids[from]);
                        row["sn"] = json!(self.names[from]);
                        row["r"] = json!(self.ids[to]);
                        row["rn"] = json!(self.names[to]);
                        crate::util::pg_json_mut(&mut row);
                        batch.push(row);
                    }
                    _ => {
                        for node in [from, to].into_iter().flatten().collect::<std::collections::BTreeSet<usize>>() {
                            serde_json::to_writer(&mut kept[node], &row)?;
                            kept[node].push(b'\n');
                        }
                    }
                }
            }
            if !already && (batch.len() >= 200 || (next.is_none() && !batch.is_empty())) {
                handle.block_on(tx.execute(&format!(
                    "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name, kind, notice, body,
                                          attachments, reply_to, ev, urgent, urgent_reason, relationship, state, created_at, delivered_at, read_at, replies, via)
                     SELECT r->>'uid', {org}, r->>'sn', (r->>'s')::bigint, 1, 'agent', (r->>'r')::bigint, r->>'rn', coalesce(r->>'kind', 'message'), coalesce((r->>'notice')::boolean, false),
                            coalesce(r->>'body', ''), '[]'::jsonb, NULL, NULL, coalesce((r->>'urgent')::boolean, false), r->>'urgent_reason', r->>'relationship', r->>'state',
                            least(coalesce((r->>'created_at')::timestamptz, $2::timestamptz), $2::timestamptz), least((r->>'delivered_at')::timestamptz, $2::timestamptz), least((r->>'read_at')::timestamptz, $2::timestamptz),
                            '[]'::jsonb, nullif(r->'via', 'null'::jsonb)
                       FROM jsonb_array_elements($1::jsonb) r", org = self.org.id), &[&Value::Array(std::mem::take(&mut batch)), &self.at])).context("the mail")?;
            }
            if next.is_none() {
                break;
            }
        }
        if !already {
            handle.block_on(tx.execute(
                "UPDATE ot.agents SET extra = jsonb_set(extra, '{ported,parts}', coalesce(extra->'ported'->'parts', '[]'::jsonb) || '\"mail\"'::jsonb) WHERE id = $1 AND extra ? 'ported'", &[&root]))?;
        }
        handle.block_on(tx.commit())?;
        drop(lines);
        for (at, text) in kept.into_iter().enumerate() {
            if text.is_empty() || self.export.nodes[at].kind == crate::domain::projects::KIND {
                continue;
            }
            let scratch = self.scratch(at);
            if let Err(error) = self.archive(at, &scratch, "mail.jsonl", &text) {
                self.leftovers.push(format!("{}: its earlier mail could not be saved to its folder ({error:#})", self.names[at]));
            }
        }
        Ok(())
    }

    /// The docket items the nodes own: items of this organization now, with their history, under
    /// a free slug. A reviewer or a participant who did not come along is left off, and a link
    /// to another item holds only when that item came along too.
    fn docket(&mut self) -> Result<()> {
        let n = self.ids.len();
        let renamed: HashMap<String, String> = self.export.nodes.iter().zip(&self.names).map(|(old, new)| (old.name.clone(), new.clone())).collect();
        let came_from = self.export.manifest.origin.org_name.clone();
        // every slug first: a link between two items of the file follows both
        let mut slugs: Vec<(usize, String)> = Vec::new();
        for at in 0..n {
            let name = self.export.of(at, format::DOCKET);
            let Some((mut lines, _)) = self.export.lines(&name)? else { continue };
            while let Some(row) = lines.next()? {
                if let Some(slug) = row["item"]["slug"].as_str() {
                    slugs.push((at, slug.to_string()));
                }
            }
        }
        if slugs.is_empty() {
            return Ok(());
        }
        let client = self.client()?;
        let wanted: Vec<String> = slugs.iter().map(|(_, slug)| slug.clone()).collect();
        let mut taken: std::collections::HashSet<String> = self.handle
            .block_on(client.query("SELECT lower(slug) FROM ot.work_items WHERE org_id = $1 AND (lower(slug) = ANY($2) OR lower(slug) LIKE ANY($3))",
                                   &[&self.org.id, &wanted.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>(), &wanted.iter().map(|s| format!("{}-%", s.to_lowercase().replace(['%', '_'], ""))).collect::<Vec<_>>()]))?
            .iter().map(|r| r.get(0)).collect();
        let mut new_slug: HashMap<String, String> = HashMap::new();
        for (_, slug) in &slugs {
            new_slug.entry(slug.clone()).or_insert_with(|| super::names::free_name(&slug.chars().take(60).collect::<String>(), &mut taken).to_lowercase());
        }
        drop(client);
        for at in 0..n {
            let name = self.export.of(at, format::DOCKET);
            if self.export.listed(&name).is_none() || self.has(at, "docket")? {
                continue;
            }
            let (id, owner_name, when, handle) = (self.ids[at], self.names[at].clone(), self.at, self.handle.clone());
            let mut client = self.client()?;
            let tx = handle.block_on(client.transaction())?;
            let Some((mut lines, _)) = self.export.lines(&name)? else { continue };
            while let Some(mut row) = lines.next()? {
                crate::util::pg_json_mut(&mut row);
                let Some(slug) = row["item"]["slug"].as_str().and_then(|s| new_slug.get(s)).cloned() else { continue };
                let item = &row["item"];
                let names = |key: &str| -> Vec<String> { item[key].as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(|n| renamed.get(n).cloned()).collect() };
                let links = |key: &str| -> Vec<String> { item[key].as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(|s| new_slug.get(s).cloned()).collect() };
                // the owner as this organization records one: the same record, under the node's name here
                let mut owner = item["owner"].clone();
                match &mut owner {
                    Value::Object(members) => {
                        members.insert("name".into(), json!(owner_name));
                        if members.contains_key("generation") {
                            members.insert("generation".into(), json!(1));
                        }
                    }
                    other => *other = json!(owner_name),
                }
                let parent = item["parent"].as_str().and_then(|s| new_slug.get(s)).cloned();
                let made = handle.block_on(tx.query_opt(
                    "INSERT INTO ot.work_items (org_id, slug, rev, kind, title, objective, status, blocked_reason, dropped_reason, owner, owner_agent_id, created_by, last_updater,
                                                participants, parent, dependencies, done_so_far, working_on_next, evidence, accepted, created_at, updated_at, docket_at, status_at,
                                                archived_at)
                     SELECT $1::bigint, $2::text, coalesce(r.rev, 1), coalesce(r.kind, 'code'), coalesce(r.title, $2::text), coalesce(r.objective, ''), coalesce(r.status, 'open'), r.blocked_reason,
                            r.dropped_reason, $3::jsonb, $4::bigint, coalesce(r.created_by, '\"user\"'::jsonb), r.last_updater, $5::text[], $6::text, $7::text[], coalesce(r.done_so_far, '[]'::jsonb),
                            coalesce(r.working_on_next, '[]'::jsonb), coalesce(r.evidence, '[]'::jsonb), r.accepted, least(coalesce(r.created_at, $9::timestamptz), $9::timestamptz),
                            least(coalesce(r.updated_at, $9::timestamptz), $9::timestamptz), least(r.docket_at, $9::timestamptz), least(r.status_at, $9::timestamptz), least(r.archived_at, $9::timestamptz)
                       FROM jsonb_populate_record(NULL::ot.work_items, $8::jsonb) r
                     ON CONFLICT (org_id, slug) DO NOTHING RETURNING id",
                    &[&self.org.id, &slug, &owner, &id, &names("participants"), &parent, &links("dependencies"), item, &when])).with_context(|| format!("docket item {slug}"))?;
                let Some(work) = made.map(|r| r.get::<_, i64>(0)) else { continue };
                handle.block_on(tx.execute(
                    "INSERT INTO ot.work_events (work_id, at, by, op, detail, via)
                     SELECT $1::bigint, least(coalesce(r.at, $3::timestamptz), $3::timestamptz), coalesce(r.by, '\"user\"'::jsonb), coalesce(r.op, 'update'), coalesce(r.detail, '{}'::jsonb), r.via
                       FROM jsonb_array_elements($2::jsonb) e, jsonb_populate_record(NULL::ot.work_events, e) r",
                    &[&work, &Value::Array(row["events"].as_array().cloned().unwrap_or_default()), &when]))?;
                handle.block_on(tx.execute(
                    "INSERT INTO ot.work_events (work_id, at, by, op, detail) VALUES ($1, $2, to_jsonb('@system'::text), 'imported', $3)",
                    &[&work, &when, &json!({ "from": came_from, "was": row["item"]["slug"], "owner": owner_name })]))?;
            }
            handle.block_on(tx.execute(
                "UPDATE ot.agents SET extra = jsonb_set(extra, '{ported,parts}', coalesce(extra->'ported'->'parts', '[]'::jsonb) || '\"docket\"'::jsonb) WHERE id = $1 AND extra ? 'ported'", &[&id]))?;
            handle.block_on(tx.commit())?;
        }
        crate::changes::notify(&self.engine, &self.org, vec![crate::changes::Change::Docket]);
        Ok(())
    }
}

/// A text as an SQL string literal: for the few values a statement holds for every row of a
/// page (a node's name, a map of names), which are this engine's own and never the file's.
#[nolog]
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// `inner` (`/` between plain parts) as a path inside `root`, or `None` when it is not one.
#[nolog]
fn inside(root: &Path, inner: &str) -> Option<PathBuf> {
    let parts = super::names::safe_parts(inner)?;
    let mut out = root.to_path_buf();
    out.extend(parts);
    Some(out)
}

/// Whether a link stands at `folder` or between it and `root`: nothing is written through one.
#[nolog]
fn linked(root: &Path, folder: &Path) -> bool {
    let mut at = folder;
    loop {
        if std::fs::symlink_metadata(at).is_ok_and(|m| crate::http::scratch_files::is_link(&m)) {
            return true;
        }
        if at == root {
            return false;
        }
        match at.parent() {
            Some(parent) if parent.starts_with(root) => at = parent,
            _ => return false,
        }
    }
}

/// A folder removed when it is no longer needed.
struct Sweep(PathBuf);

impl Drop for Sweep {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The watchdogs of the imported agents: each created paused under its new owner, its node
/// target following the node's new name. One whose target did not come along is dropped. They
/// are armed afterwards only when the importer asked, and only those that can run anywhere.
#[nolog]
async fn watchdogs(engine: &Arc<Engine>, req: &Request, content: &Content, created: &Created) -> Value {
    let org = req.org.id;
    let old: HashMap<&str, usize> = content.export.nodes.iter().enumerate().map(|(at, node)| (node.name.as_str(), at)).collect();
    let renamed: HashMap<String, String> = content.export.nodes.iter().zip(&content.names).filter(|(old, new)| old.name != **new).map(|(old, new)| (old.name.clone(), new.clone())).collect();
    let (mut made, mut armed, mut notes) = (0, 0, Vec::new());
    let mut staged = Vec::new();
    for dog in &content.export.links.watchdogs {
        let owner = &created.plan.nodes[dog.owner];
        let label = dog.args["name"].as_str().unwrap_or("a watchdog").to_string();
        if owner.retired || owner.project {
            notes.push(format!("{label} of {} was not restored: its owner came in retired", owner.name));
            continue;
        }
        let mut args = dog.args.clone();
        let kind = args["kind"].as_str().unwrap_or_default().to_string();
        if crate::domain::template_links::node_target(&kind) {
            let target = args["target"].as_str().unwrap_or_default().trim_start_matches('@').to_string();
            match old.get(target.as_str()).filter(|at| !created.plan.nodes[**at].retired) {
                Some(at) => args["target"] = json!(created.plan.nodes[*at].name),
                None => {
                    notes.push(format!("{label} of {} was dropped: what it watches ({target}) did not come along", owner.name));
                    continue;
                }
            }
        }
        // a watched file follows its folder: one inside the folder of a node that came along is that file here
        if kind == "file" {
            let here = args["target"].as_str().and_then(|target| {
                content.export.nodes.iter().enumerate().filter(|(at, _)| !created.plan.nodes[*at].retired).find_map(|(at, node)| {
                    moved(target, &node.scratch_dir, &content.scratch(at)).or_else(|| moved(target, &node.team_dir, &content.team(at)))
                })
            });
            if let Some(here) = here {
                args["target"] = json!(here);
            }
        }
        for key in ["pattern", "payload_pattern"] {
            if let Some(text) = args[key].as_str() {
                args[key] = json!(super::names::rewrite_mentions(text, &renamed));
            }
        }
        let mut needs = dog.needs_credentials;
        let mut result = None;
        if let Some(credentials) = &dog.credentials {
            let mut with = args.clone();
            with["credentials"] = credentials.clone();
            match crate::runtime::watchdogs::create_from_template(engine, org, created.ids[dog.owner], &with, false).await {
                Ok(value) => result = Some(value),
                Err(error) => {
                    needs = true;
                    notes.push(format!("{label} of {}: its credentials could not be stored again ({error}); it stays paused until it is given them", owner.name));
                }
            }
        }
        if result.is_none() {
            match crate::runtime::watchdogs::create_from_template(engine, org, created.ids[dog.owner], &args, needs).await {
                Ok(value) => result = Some(value),
                Err(error) => {
                    notes.push(format!("{label} of {} could not be restored: {error}", owner.name));
                    continue;
                }
            }
        }
        made += 1;
        let portable = !dog.paused && !needs && !crate::domain::template_links::machine(&kind);
        if req.resume_watchdogs && portable {
            if let Some(id) = result.as_ref().and_then(|v| v["id"].as_str()) {
                staged.push(crate::domain::watchdogs::handle(&owner.name, id));
            }
        }
    }
    for id in staged {
        match crate::util::boxed(|| crate::runtime::watchdogs::act(engine, org, None, &id, "resume", Some("restored by an import"))).await {
            Ok(_) => armed += 1,
            Err(error) => notes.push(format!("watchdog {id} stays paused: {error}")),
        }
    }
    json!({ "created": made, "armed": armed, "paused": made - armed, "notes": notes })
}

/// What each agent is told at the start of its first turn here.
#[nolog]
fn notice(req: &Request, content: &Content, created: &Created, at: usize) -> String {
    let (old, planned) = (&content.export.nodes[at], &created.plan.nodes[at]);
    let m = &content.export.manifest;
    let above = planned.parent.map(|p| created.plan.nodes[p].name.clone()).or_else(|| req.dest.clone()).unwrap_or_else(|| "the user".to_string());
    let mut lines = Vec::new();
    if req.duplicate {
        lines.push(format!("You are a copy of {}, made on {}. Your name is {}, and you are under {above}. Your history up to the copy is the history of {}; from here on you are a separate agent, and {} goes on as before.",
                           old.name, crate::util::iso(content.at), planned.name, old.name, old.name));
    } else {
        lines.push(format!("You were exported from the organization \"{}\" on {} and imported into \"{}\". Your name here is {}{}, and you are under {above}.",
                           m.origin.org_name, m.exported_at, req.org.name.load(), planned.name, if planned.name == old.name { String::new() } else { format!(" (it was {})", old.name) }));
        lines.push("Everything in your earlier conversation happened in the organization you left: its instructions, its superiors and its open work do not bind you here. Take your instructions from whoever writes to you now.".to_string());
    }
    let renamed: Vec<String> = created.plan.nodes.iter().filter(|p| p.was != p.name).map(|p| format!("{} is now {}", p.was, p.name)).collect();
    if !renamed.is_empty() {
        lines.push(format!("Names that changed: {}.", renamed.join("; ")));
    }
    if old.mid_turn {
        lines.push("A turn of yours was running when the copy was taken; it did not finish here.".to_string());
    }
    if !content.sessions[at] && old.session.is_some() {
        lines.push("You start on a fresh session; your earlier conversation is on your desk and saved in your folder.".to_string());
    }
    if content.waiting[at] > 0 {
        lines.push(format!("{} message(s) were waiting for you then and are not delivered here; they are in {HISTORY_DIR}/mail.jsonl in your folder.", content.waiting[at]));
    } else if content.archived[at] {
        lines.push(format!("Your earlier mail with anyone who did not come along is in {HISTORY_DIR}/ in your folder."));
    }
    if old.open_ask && !req.duplicate {
        lines.push("You had a question open to the user; it is not asked again here.".to_string());
    }
    let dogs = content.export.links.watchdogs.iter().filter(|dog| dog.owner == at).count();
    if dogs > 0 {
        lines.push(format!("Your {dogs} watchdog(s) came along{}; list them, and resume or remove each as you need.", if req.resume_watchdogs { ", and the ones that can run anywhere are armed" } else { " paused" }));
    }
    if !planned.warnings.is_empty() {
        lines.push(format!("Changed on the way in: {}.", planned.warnings.join("; ")));
    }
    lines.join("\n")
}

/// Tell each agent what happened to it, mark a fresh start where its session did not come
/// along, and let every agent go whose own parts are in place. Returns the agents let go.
#[nolog]
async fn finish(engine: &Arc<Engine>, req: &Request, content: &Content, created: &Created) -> Vec<i64> {
    let mut ready = Vec::new();
    for (at, planned) in created.plan.nodes.iter().enumerate() {
        if planned.retired || planned.project {
            continue;
        }
        let id = created.ids[at];
        if !content.sessions[at] {
            let why = if req.duplicate { "you are a copy: your earlier conversation is another agent's session" } else { "you were imported: your earlier session did not come along" };
            if let Ok(client) = engine.db.get().await {
                let _ = client.execute(
                    "UPDATE ot.agents SET extra = jsonb_set(extra, '{handoff_due}', to_jsonb($2::text)) WHERE id = $1 AND session_id IS NULL AND NOT (extra ? 'handoff_due')
                       AND EXISTS (SELECT 1 FROM ot.convo WHERE agent_id = $1 AND seq < 0)", &[&id, &why]).await;
            }
        }
        let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, &planned.name, &notice(req, content, created, at));
        out.notice = true;
        out.wake = false;
        out.grant_reply_audience = false;
        if let Err(error) = Box::pin(crate::domain::mail::send(engine, req.org.id, out)).await {
            tracing::warn!(agent = id, error = %format!("{error:#}"), "an imported agent's notice could not be sent");
        }
        if content.done[at] {
            ready.push(id);
        }
    }
    let released = match nodes::release(engine, &req.org, &ready).await {
        Ok(released) => released,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "imported agents could not be released");
            Vec::new()
        }
    };
    for id in &released {
        crate::runtime::warm(engine, req.org.id, *id);
    }
    released
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_path_follows_its_file_only_from_inside_the_old_folder() {
        let to = Path::new("D:\\data\\scratch\\new\\lead-2");
        let got = moved("C:\\old\\scratch\\org\\lead\\outbox\\d1\\report.pdf", "C:\\old\\scratch\\org\\lead", to).unwrap();
        assert_eq!(PathBuf::from(got), to.join("outbox").join("d1").join("report.pdf"));
        assert_eq!(PathBuf::from(moved("C:/old/scratch/org/lead/a.txt", "C:\\old\\scratch\\org\\lead\\", to).unwrap()), to.join("a.txt"));
        // not under it, a sibling whose name starts alike, a way out, and no old folder at all
        assert_eq!(moved("C:\\elsewhere\\report.pdf", "C:\\old\\scratch\\org\\lead", to), None);
        assert_eq!(moved("C:\\old\\scratch\\org\\lead-two\\a.txt", "C:\\old\\scratch\\org\\lead", to), None);
        assert_eq!(moved("C:\\old\\scratch\\org\\lead\\..\\other\\a.txt", "C:\\old\\scratch\\org\\lead", to), None);
        assert_eq!(moved("C:\\old\\a.txt", "", to), None);
    }

    #[test]
    fn only_a_plain_path_is_a_place_inside_a_folder() {
        let root = Path::new("root");
        assert_eq!(inside(root, "a/b.txt"), Some(root.join("a").join("b.txt")));
        for bad in ["../a", "a/../../b", "/abs", "C:/x", "a\\b", "", "a//b", "con", "a/b."] {
            assert_eq!(inside(root, bad), None, "{bad}");
        }
        assert_eq!(quote("o'neil"), "'o''neil'");
    }

    #[test]
    fn a_time_is_read_as_the_database_writes_it() {
        assert_eq!(stamp(&json!("2026-11-23T20:40:00.123456+00:00")).map(crate::util::iso).as_deref().map(|s| &s[..19]), Some("2026-11-23T20:40:00"));
        assert!(stamp(&json!("2026-11-23T20:40:00Z")).is_some());
        assert_eq!(stamp(&json!(12)), None);
        assert_eq!(stamp(&json!("yesterday")), None);
    }
}
