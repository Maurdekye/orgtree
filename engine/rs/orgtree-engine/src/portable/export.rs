//! Writing an export: one node, or a node and everything under it, as one
//! zip (docs/rust-engine/agent-export.md, "Export").
//!
//! The export interrupts nobody and changes nothing in the organization. It
//! reads the nodes' records a page at a time, with no transaction held open
//! over the file, then copies their folders. A node that is working while it
//! is exported is exported as far as it had got. A file that cannot be read
//! is named in the report and the export goes on.
//!
//! The whole of it runs on one blocking thread (`pack`): the zip is written
//! to a file as it is made, and each page of records is fetched from that
//! thread. Nothing here is logged with its arguments: they are the agents'
//! own text.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio_postgres::types::ToSql;

use super::format::{self, Audience, DocketRef, End, Include, IndexLine, Links, Manifest, Node, Nodes, Watchdog};
use super::secrets::{self, Detector, Hits};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::zipfile::{Open, ZipOut};

/// What to export.
pub struct Request {
    pub org: Arc<OrgHandle>,
    /// The node's numeric id.
    pub root: i64,
    pub subtree: bool,
    pub include: Include,
    /// Take detected secrets out (the app setting, or the choice in the confirmation).
    pub strip: bool,
    /// The user's own export from a window. Only that may carry sealed watchdog credentials
    /// (USER 2026-11-23 20:30Z, question 2: alt B); an agent's export never does.
    pub manual: bool,
    /// `user`, or the exporting agent's name.
    pub by: String,
    /// The zip to write. It is written beside itself as `<name>.part` and renamed at the end.
    pub dest: PathBuf,
    /// The copy feeds a duplicate inside this engine: nothing is scanned or stripped.
    pub duplicate: bool,
}

/// How far a running export is, for whoever watches it.
#[derive(Default)]
pub struct Progress {
    pub step: arc_swap::ArcSwap<String>,
    pub nodes: AtomicU64,
    pub total: AtomicU64,
    pub bytes: AtomicU64,
    pub cancel: AtomicBool,
}

/// What a finished export came to.
pub struct Outcome {
    pub manifest: Manifest,
    /// `report/secrets.json`, as it lies in the file.
    pub report: Value,
    pub not_included: Vec<String>,
    /// The zip file's own size.
    pub file_bytes: u64,
}

/// A node's row, as far as an export reads it.
struct Row {
    id: i64,
    parent: Option<i64>,
    name: String,
    kind: String,
    state: String,
    title: String,
    charter: Option<String>,
    team_charter: Option<String>,
    tier: String,
    account: Option<String>,
    seat: f64,
    grant: f64,
    scope: Value,
    extra: Value,
    born: String,
    generation: i32,
    provider: Option<String>,
    session: Option<String>,
    cost_usd: f64,
    api_cost_usd: f64,
    cost_unknown: bool,
    context_window: Option<i32>,
    last_status: Option<Value>,
    mid_turn: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    scratch_dir: Option<String>,
    order: f64,
}

const ROW_COLS: &str = "a.id, a.parent_id, a.name, a.kind, a.state, a.title, a.charter, a.team_charter, a.tier, a.account,
    a.seat::float8, a.grant_credits::float8, a.scope, a.extra, a.born, a.generation, a.provider, a.session_id,
    a.cost_usd::float8, a.api_cost_usd::float8, a.cost_unknown, a.context_window, a.last_status, a.inflight_at IS NOT NULL,
    a.created_at, a.scratch_dir, a.sibling_order";

#[nolog]
fn row_of(r: &tokio_postgres::Row) -> Row {
    Row {
        id: r.get(0), parent: r.get(1), name: r.get(2), kind: r.get(3), state: r.get(4), title: r.get(5), charter: r.get(6),
        team_charter: r.get(7), tier: r.get(8), account: r.get(9), seat: r.get(10), grant: r.get(11), scope: r.get(12),
        extra: r.get(13), born: r.get(14), generation: r.get(15), provider: r.get(16), session: r.get(17), cost_usd: r.get(18),
        api_cost_usd: r.get(19), cost_unknown: r.get(20), context_window: r.get(21), last_status: r.get(22), mid_turn: r.get(23),
        created_at: r.get(24), scratch_dir: r.get(25), order: r.get(26),
    }
}

/// The engine's own files in a scratch folder, which no export takes: what a launch writes
/// there (identity, settings and the resolved MCP definitions, which can hold credentials),
/// the tool-scope folder, the generated parts of `.agents`, and an upload in progress.
/// `path` is the entry's path in the folder, `/` between its parts.
#[nolog]
pub fn engine_owned(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or("");
    if first.starts_with(".orgtree-") || path.ends_with(".orgtree-part") {
        return true;
    }
    matches!(path, ".agents/hooks.json" | ".agents/orgtree-rights.json" | ".agents/steer" | ".agents/plugins/orgtree")
        || path.strip_prefix(".agents/rules/").is_some_and(|rule| rule.starts_with("orgtree-identity-") && !rule.contains('/'))
}

/// The file the zip is written to, and what went wrong with it.
struct Sink {
    file: std::io::BufWriter<std::fs::File>,
}

/// One part that is written line by line.
struct Lines {
    name: String,
    open: Open,
    sha: Sha256,
    size: u64,
    count: u64,
}

/// The zip as an export fills it: every part is indexed with its size and SHA-256, and the
/// secrets found on the way are counted by place.
struct Pack<'z> {
    zip: ZipOut<'z>,
    fault: &'z std::cell::RefCell<Option<std::io::Error>>,
    progress: &'z Progress,
    detector: Option<&'z Detector>,
    strip: bool,
    index: Vec<IndexLine>,
    unpacked: u64,
    files: u64,
    hits: BTreeMap<String, Hits>,
    files_with_secrets: Vec<String>,
    files_stripped: Vec<String>,
    not_scanned: Vec<String>,
    not_included: Vec<String>,
}

#[nolog]
impl Pack<'_> {
    /// Why the file could not be written, when the zip said its reader is gone.
    fn stopped(&self) -> anyhow::Error {
        stopped(self.fault)
    }

    /// Count the secrets of one text into `place`, and take them out when stripping.
    fn scan_text(&mut self, place: &str, text: &mut String) {
        let Some(detector) = self.detector else { return };
        let mut hits = Hits::new();
        if let Some(clean) = detector.scan(text.as_bytes(), self.strip, &mut hits) {
            *text = String::from_utf8_lossy(&clean).into_owned();
        }
        self.note(place, hits);
    }

    fn cancelled(&self) -> Result<()> {
        if self.progress.cancel.load(Ordering::Relaxed) {
            crate::refuse!(Conflict, "the export was cancelled");
        }
        Ok(())
    }

    fn count(&mut self, name: &str, size: u64, sha: Sha256) -> Result<()> {
        self.index.push(IndexLine { name: name.to_string(), size, sha256: hex(&sha.finalize()), lines: None });
        self.unpacked += size;
        self.progress.bytes.store(self.unpacked, Ordering::Relaxed);
        if self.unpacked > super::SIZE_MAX {
            crate::refuse!(Unprocessable, "the export holds more than 256 GiB; leave a part out (the scratch folders, the transcripts or the CLI session files) or export a smaller team");
        }
        Ok(())
    }

    fn note(&mut self, place: &str, hits: Hits) {
        if hits.is_empty() {
            return;
        }
        let at = self.hits.entry(place.to_string()).or_default();
        for (kind, n) in hits {
            *at.entry(kind).or_default() += n;
        }
    }

    /// A small part, whole.
    fn part(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut sha = Sha256::new();
        sha.update(bytes);
        let mut data = bytes;
        if !self.zip.file(name, None, &mut data)? {
            return Err(self.stopped());
        }
        self.count(name, bytes.len() as u64, sha)
    }

    fn lines(&mut self, name: &str) -> Result<Lines> {
        let open = self.zip.begin(name, None).ok_or_else(|| self.stopped())?;
        Ok(Lines { name: name.to_string(), open, sha: Sha256::new(), size: 0, count: 0 })
    }

    fn line(&mut self, lines: &mut Lines, row: &Value) -> Result<()> {
        let mut text = serde_json::to_vec(row)?;
        text.push(b'\n');
        lines.sha.update(&text);
        lines.size += text.len() as u64;
        lines.count += 1;
        if !self.zip.put(&mut lines.open, &text)? {
            return Err(self.stopped());
        }
        Ok(())
    }

    fn close(&mut self, lines: Lines) -> Result<u64> {
        let Lines { name, open, sha, size, count } = lines;
        if self.zip.end(open)?.is_none() {
            return Err(self.stopped());
        }
        self.count(&name, size, sha)?;
        if let Some(line) = self.index.last_mut() {
            line.lines = Some(count);
        }
        Ok(count)
    }

    /// Count the secrets of a record into `place`, and take them out when stripping. `named`
    /// lists the members that hold what somebody wrote as settings (a tool's input); `skip`
    /// the members that hold encoded bytes.
    fn scan_row(&mut self, place: &str, row: &mut Value, named: &[&str], skip: &[&str]) {
        let Some(detector) = self.detector else { return };
        let mut hits = Hits::new();
        let mut aside: Vec<(String, Value)> = Vec::new();
        if let Some(members) = row.as_object_mut() {
            for key in skip.iter().chain(named) {
                if let Some(value) = members.remove(*key) {
                    aside.push((key.to_string(), value));
                }
            }
        }
        detector.scan_json(row, self.strip, false, &mut hits);
        for (key, mut value) in aside {
            if named.contains(&key.as_str()) {
                detector.scan_json(&mut value, self.strip, true, &mut hits);
            }
            row[key] = value;
        }
        self.note(place, hits);
    }

    /// One file from disk under `name`. A credential file is counted and, when stripping, left
    /// out; a text is scanned, and written without its secrets when stripping. A file that
    /// cannot be read is named in the report.
    fn disk_file(&mut self, name: &str, path: &Path, relative: &str, place: &str) -> Result<()> {
        self.cancelled()?;
        if !crate::zipfile::name_fits(name, false) {
            self.not_included.push(format!("{} (its path is too long for a zip)", name.chars().take(200).collect::<String>()));
            return Ok(());
        }
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                self.not_included.push(format!("{name} ({error})"));
                return Ok(());
            }
        };
        let modified = metadata.modified().ok();
        if self.detector.is_some() && secrets::credential_file(relative) {
            self.note(place, Hits::from([(secrets::CREDENTIAL_FILE, 1)]));
            self.files_with_secrets.push(name.to_string());
            if self.strip {
                self.files_stripped.push(name.to_string());
                return Ok(());
            }
        }
        if metadata.len() <= secrets::SCAN_MAX {
            // read whole first: a file that cannot be read leaves nothing half written
            let bytes = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.not_included.push(format!("{name} ({error})"));
                    return Ok(());
                }
            };
            let mut clean = None;
            if let Some(detector) = self.detector.filter(|_| secrets::looks_like_text(&bytes)) {
                let mut hits = Hits::new();
                clean = detector.scan(&bytes, self.strip, &mut hits);
                if !hits.is_empty() {
                    self.files_with_secrets.push(name.to_string());
                    self.note(place, hits);
                }
            }
            let bytes = clean.unwrap_or(bytes);
            let mut sha = Sha256::new();
            sha.update(&bytes);
            let mut data = &bytes[..];
            if !self.zip.file(name, modified, &mut data)? {
                return Err(self.stopped());
            }
            self.files += 1;
            return self.count(name, bytes.len() as u64, sha);
        }
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) => {
                self.not_included.push(format!("{name} ({error})"));
                return Ok(());
            }
        };
        if self.detector.is_some() {
            self.not_scanned.push(format!("{name} (larger than 64 MiB)"));
        }
        let mut open = self.zip.begin(name, modified).ok_or_else(|| self.stopped())?;
        let mut sha = Sha256::new();
        let mut size = 0u64;
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let read = match file.read(&mut chunk) {
                Ok(read) => read,
                Err(error) => {
                    // what was written of it cannot be taken back: it ends here, and the report says so
                    self.not_included.push(format!("{name} (cut short after {size} bytes: {error})"));
                    break;
                }
            };
            if read == 0 {
                break;
            }
            sha.update(&chunk[..read]);
            size += read as u64;
            if !self.zip.put(&mut open, &chunk[..read])? {
                return Err(self.stopped());
            }
            self.progress.bytes.store(self.unpacked + size, Ordering::Relaxed);
        }
        if self.zip.end(open)?.is_none() {
            return Err(self.stopped());
        }
        self.files += 1;
        self.count(name, size, sha)
    }

    /// `folder` and what is stored in it under `prefix`, by name, a folder before what is in
    /// it. Links are left out, and so is what `skip` names by its path in the folder.
    fn tree(&mut self, prefix: &str, folder: &Path, place: &str, skip: &dyn Fn(&str) -> bool) -> Result<()> {
        let mut todo: Vec<(PathBuf, String)> = vec![(folder.to_path_buf(), String::new())];
        while let Some((at, relative)) = todo.pop() {
            self.cancelled()?;
            let Ok(read) = std::fs::read_dir(&at) else {
                self.not_included.push(format!("{prefix}/{relative} (the folder could not be read)"));
                continue;
            };
            let mut entries: Vec<(String, PathBuf, std::fs::Metadata)> = read
                .flatten()
                .filter_map(|entry| Some((entry.file_name().to_string_lossy().to_string(), entry.path(), std::fs::symlink_metadata(entry.path()).ok()?)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut folders = Vec::new();
            for (name, path, metadata) in entries {
                let inner = if relative.is_empty() { name } else { format!("{relative}/{name}") };
                if skip(&inner) {
                    continue;
                }
                let named = format!("{prefix}/{inner}");
                if crate::http::scratch_files::is_link(&metadata) {
                    self.not_included.push(format!("{named} (a link, which is not followed)"));
                    continue;
                }
                if metadata.is_dir() {
                    if !crate::zipfile::name_fits(&named, true) {
                        self.not_included.push(format!("{} (its path is too long for a zip)", named.chars().take(200).collect::<String>()));
                        continue;
                    }
                    if !self.zip.folder(&named, metadata.modified().ok()) {
                        return Err(self.stopped());
                    }
                    folders.push((path, inner));
                } else {
                    self.disk_file(&named, &path, &inner, place)?;
                }
            }
            // the stack is taken from its end: push in reverse, so folders come by name
            todo.extend(folders.into_iter().rev());
        }
        Ok(())
    }
}

#[nolog]
fn hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// Why the export file could not be written: what the sink kept of its failed write.
#[nolog]
fn stopped(fault: &std::cell::RefCell<Option<std::io::Error>>) -> anyhow::Error {
    match fault.borrow_mut().take() {
        // ERROR_DISK_FULL, ENOSPC
        Some(error) if matches!(error.raw_os_error(), Some(112) | Some(28)) => crate::domain::user_err(crate::domain::UserError::Conflict, "the disk is full: the export file could not be written"),
        Some(error) => anyhow!("the export file could not be written: {error}"),
        None => anyhow!("the export file could not be written"),
    }
}

/// A page of rows, fetched from the blocking thread.
#[nolog]
fn query(handle: &Handle, client: &tokio_postgres::Client, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<tokio_postgres::Row>> {
    Ok(handle.block_on(client.query(sql, params))?)
}

/// The secrets this Orgtree holds, for exact matching: every provider key and OpenRouter
/// key, every language model server secret and every organization's hub identity. They are
/// only compared with what is exported; none is written anywhere.
#[nolog]
fn held_secrets(handle: &Handle, client: &tokio_postgres::Client) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for sql in [
        "SELECT secret FROM ot.account_secrets WHERE secret IS NOT NULL",
        "SELECT secret FROM ot.langserver_secrets WHERE secret IS NOT NULL",
        "SELECT net->'identity'->>'secret' FROM ot.orgs WHERE net->'identity'->>'secret' IS NOT NULL",
    ] {
        for row in query(handle, client, sql, &[])? {
            let secret: Option<String> = row.get(0);
            out.extend(secret.filter(|s| !s.is_empty()));
        }
    }
    Ok(out)
}

/// This installation's own id (`ot.meta`, made by the app feed at its first start).
#[nolog]
fn engine_id(handle: &Handle, client: &tokio_postgres::Client) -> Result<String> {
    let found = query(handle, client, "SELECT value FROM ot.meta WHERE key = 'app_uuid'", &[])?;
    Ok(found.first().and_then(|row| row.get::<_, Value>(0).as_str().map(str::to_string)).unwrap_or_default())
}

/// The exported nodes in tree order: the root, then each node's children by their order,
/// each before its own. With `subtree`, every live node under the root, and the retired
/// ones too when they are asked for or the root itself is retired.
#[nolog]
fn read_tree(handle: &Handle, client: &tokio_postgres::Client, org: i64, root: i64, subtree: bool, retired: bool) -> Result<Vec<Row>> {
    let found = query(handle, client, &format!("SELECT {ROW_COLS} FROM ot.agents a WHERE a.id = $1 AND a.org_id = $2 AND a.state <> 'deleted'"), &[&root, &org])?;
    let Some(first) = found.first().map(row_of) else { crate::refuse!(NotFound, "that node is not in this organization") };
    if !subtree {
        return Ok(vec![first]);
    }
    let states: Vec<&str> = if retired || first.state != "live" { vec!["live", "archived", "unrecoverable"] } else { vec!["live"] };
    let rows = query(handle, client, &format!(
        "WITH RECURSIVE t AS (
           SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2
           UNION ALL
           SELECT c.id FROM ot.agents c JOIN t ON c.parent_id = t.id WHERE c.state = ANY($3)
         ) SELECT {ROW_COLS} FROM ot.agents a JOIN t ON t.id = a.id"), &[&root, &org, &states])?;
    let mut rows: Vec<Row> = rows.iter().map(row_of).collect();
    rows.sort_by(|a, b| a.order.total_cmp(&b.order).then(a.id.cmp(&b.id)));
    let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut top = None;
    for (at, row) in rows.iter().enumerate() {
        if row.id == root {
            top = Some(at);
        } else if let Some(parent) = row.parent {
            children.entry(parent).or_default().push(at);
        }
    }
    let mut order = Vec::with_capacity(rows.len());
    let mut todo = vec![top.ok_or_else(|| anyhow!("the exported node vanished while it was read"))?];
    while let Some(at) = todo.pop() {
        order.push(at);
        if let Some(below) = children.get(&rows[at].id) {
            todo.extend(below.iter().rev());
        }
    }
    let mut slots: Vec<Option<Row>> = rows.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|at| slots[at].take()).collect())
}

/// Every page of `sql`, whose first parameter is `owner` and second the last key seen; each
/// row is a key and a record. `each` gets the records in key order.
#[nolog]
fn pages(handle: &Handle, client: &tokio_postgres::Client, sql: &str, owner: &(dyn ToSql + Sync), mut each: impl FnMut(Value) -> Result<()>) -> Result<()> {
    let mut after = i64::MIN;
    loop {
        let rows = query(handle, client, sql, &[owner, &after])?;
        let Some(last) = rows.last() else { return Ok(()) };
        after = last.get(0);
        for row in &rows {
            each(row.get(1))?;
        }
    }
}

/// The nodes as the file names them: each with its place in the list, its settings, and what
/// was going on when it was read.
#[nolog]
fn listed(handle: &Handle, engine: &Arc<Engine>, org: &Arc<OrgHandle>, client: &tokio_postgres::Client, rows: &[Row]) -> Result<Vec<Node>> {
    let place_of: HashMap<i64, usize> = rows.iter().enumerate().map(|(at, row)| (row.id, at)).collect();
    let seats: Vec<super::credits::Seat> = rows.iter().map(|row| super::credits::Seat {
        parent: row.parent.and_then(|p| place_of.get(&p).copied()), project: row.kind == "project", retired: row.state != "live", seat: row.seat, grant: row.grant,
    }).collect();
    let costed = super::credits::cost(&seats);
    let accounts = engine.accounts.view();
    let scratch_root = engine.cfg.scratch_root(&org.slug);
    let teams_root = engine.cfg.teams_dir(&org.slug);
    let mut nodes: Vec<Node> = Vec::with_capacity(rows.len());
    for (at, row) in rows.iter().enumerate() {
        let scratch_dir = row.scratch_dir.clone().map(PathBuf::from).unwrap_or_else(|| scratch_root.join(&row.name));
        let waiting: i64 = query(handle, client, "SELECT count(*) FROM ot.mail WHERE recipient_agent_id = $1 AND state IN ('pending', 'delivering')", &[&row.id])?[0].get(0);
        let open_ask: bool = query(handle, client, "SELECT EXISTS (SELECT 1 FROM ot.asks WHERE agent_id = $1 AND status = 'open')", &[&row.id])?[0].get(0);
        nodes.push(Node {
            name: row.name.clone(),
            parent: seats[at].parent,
            kind: row.kind.clone(),
            retired: row.state != "live",
            title: row.title.clone(),
            charter: row.charter.clone(),
            team_charter: row.team_charter.clone(),
            tier: row.tier.clone(),
            account: row.account.as_ref().map(|id| format::AccountRef { id: id.clone(), label: accounts.get(id).map(|a| a.label.clone()).unwrap_or_default() }),
            seat: row.seat,
            grant: row.grant,
            spare: costed.spare[at],
            scope: row.scope.clone(),
            harness_pin: crate::harnesses::seat_pin(&row.extra),
            provider: row.provider.clone(),
            session: row.session.as_ref().map(|id| format::SessionRef { id: id.clone(), harness: row.extra["harness"].as_str().unwrap_or_default().to_string(), files: false }),
            born: row.born.clone(),
            generation: row.generation,
            created_at: Some(crate::util::iso(row.created_at)),
            cost_usd: row.cost_usd,
            api_cost_usd: row.api_cost_usd,
            cost_unknown: row.cost_unknown,
            context_window: row.context_window,
            last_status: row.last_status.clone(),
            mid_turn: row.mid_turn,
            waiting_mail: waiting.max(0) as u64,
            open_ask,
            dir: format::node_dir(at, &row.name),
            scratch_dir: scratch_dir.to_string_lossy().to_string(),
            uploads_dir: engine.cfg.path("uploads").join(&org.slug).join(&row.name).to_string_lossy().to_string(),
            team_dir: crate::domain::teams::workspace(&teams_root, row.id).to_string_lossy().to_string(),
        });
    }
    Ok(nodes)
}

/// The audiences that hold between the exported nodes and with the user (never the org mailbox), and
/// the ones left behind because their other end is not exported.
#[nolog]
fn audiences_of(handle: &Handle, client: &tokio_postgres::Client, org: i64, rows: &[Row]) -> Result<(Vec<Audience>, Vec<String>)> {
    let names: HashMap<&str, usize> = rows.iter().enumerate().map(|(at, row)| (row.name.as_str(), at)).collect();
    let end = |name: &str| -> Option<End> {
        match name.trim_start_matches('@') {
            "user" => Some(End::User),
            other => names.get(other).map(|at| End::Node(*at)),
        }
    };
    // USER 2026-11-24 m63824e37d3d6: "the org inbox audience should never move / be saved with an import".
    // Who holds the org mailbox is not part of an export, and is not told as left behind either.
    // a weak link (`@extern-weak`) is not carried either (docket weak-org-mailbox-links-several-agents-may-send-a)
    let outside = |name: &str| name == crate::domain::audiences::EXTERN || name == crate::domain::audiences::EXTERN_WEAK;
    let (mut found, mut left) = (Vec::new(), Vec::new());
    pages(handle, client, "SELECT id, jsonb_build_object('grantee', grantee, 'grantor', grantor) FROM ot.audiences WHERE org_id = $1 AND id > $2 AND revoked_at IS NULL AND NOT paused ORDER BY id LIMIT 500", &org, |grant| {
        let (grantee, grantor) = (grant["grantee"].as_str().unwrap_or_default(), grant["grantor"].as_str().unwrap_or_default());
        if (!names.contains_key(grantee) && !names.contains_key(grantor)) || outside(grantee) || outside(grantor) {
            return Ok(());
        }
        match (end(grantee), end(grantor)) {
            (Some(grantee), Some(grantor)) => found.push(Audience { grantee, grantor }),
            _ => left.push(format!("The audience between {grantee} and {grantor}: one of them is not in the export.")),
        }
        Ok(())
    })?;
    Ok((found, left))
}

/// The nodes an export of `root` would hold and the audiences among them, with nothing written:
/// what the plan of a duplicate reads.
#[nolog]
pub async fn outline(engine: Arc<Engine>, org: Arc<OrgHandle>, root: i64, subtree: bool) -> Result<(Vec<Node>, Vec<Audience>)> {
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || -> Result<(Vec<Node>, Vec<Audience>)> {
        let client = handle.block_on(engine.db.get())?;
        let rows = read_tree(&handle, &client, org.id, root, subtree, false)?;
        let nodes = listed(&handle, &engine, &org, &client, &rows)?;
        let (audiences, _) = audiences_of(&handle, &client, org.id, &rows)?;
        Ok((nodes, audiences))
    })
    .await
    .context("reading the nodes stopped unexpectedly")?
}

/// How large an export of `root` would be, before anything is written: the nodes, the bytes of
/// their folders, and of their transcripts as the database holds them. A folder that cannot be
/// read counts for nothing here and is named when the export runs.
#[nolog]
pub async fn estimate(engine: Arc<Engine>, org: Arc<OrgHandle>, root: i64, subtree: bool, retired: bool) -> Result<Value> {
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let client = handle.block_on(engine.db.get())?;
        let rows = read_tree(&handle, &client, org.id, root, subtree, retired)?;
        let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
        let transcript: i64 = query(&handle, &client, "SELECT coalesce(sum(pg_column_size(body) + pg_column_size(tool_inputs) + pg_column_size(tool_native_inputs)), 0)::bigint FROM ot.convo WHERE agent_id = ANY($1)", &[&ids])?[0].get(0);
        let documents: i64 = query(&handle, &client, "SELECT coalesce(sum(coalesce(octet_length(body), 0) + coalesce(octet_length(download), 0)), 0)::bigint FROM ot.documents WHERE agent_id = ANY($1)", &[&ids])?[0].get(0);
        let scratch_root = engine.cfg.scratch_root(&org.slug);
        let teams_root = engine.cfg.teams_dir(&org.slug);
        let (mut scratch, mut team) = (0u64, 0u64);
        for row in &rows {
            let own = row.scratch_dir.clone().map(PathBuf::from).unwrap_or_else(|| scratch_root.join(&row.name));
            if row.kind == "project" {
                team += folder_bytes(&own, false);
            } else {
                scratch += folder_bytes(&own, true);
                if subtree {
                    team += folder_bytes(&crate::domain::teams::workspace(&teams_root, row.id), false);
                }
            }
        }
        Ok(json!({
            "nodes": rows.len(),
            "agents": rows.iter().filter(|row| row.kind == "agent" && row.state == "live").count(),
            "projects": rows.iter().filter(|row| row.kind == "project" && row.state == "live").count(),
            "retired": rows.iter().filter(|row| row.state != "live").count(),
            "bytes": { "scratch": scratch, "team": team, "transcript": transcript.max(0), "documents": documents.max(0),
                       "total": scratch + team + transcript.max(0) as u64 + documents.max(0) as u64 },
            "limit": super::SIZE_MAX,
        }))
    })
    .await
    .context("measuring the export stopped unexpectedly")?
}

/// The bytes of the files under `folder`, links left out, and the engine's own files too when
/// it is a scratch folder.
#[nolog]
fn folder_bytes(folder: &Path, scratch: bool) -> u64 {
    let mut total = 0u64;
    let mut todo: Vec<(PathBuf, String)> = vec![(folder.to_path_buf(), String::new())];
    while let Some((at, relative)) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&at) else { continue };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let inner = if relative.is_empty() { name } else { format!("{relative}/{name}") };
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else { continue };
            if crate::http::scratch_files::is_link(&metadata) || (scratch && engine_owned(&inner)) {
                continue;
            }
            if metadata.is_dir() {
                todo.push((entry.path(), inner));
            } else {
                total += metadata.len();
            }
        }
    }
    total
}

/// Write the export. Runs on a blocking thread; see the module's head.
#[nolog]
pub async fn run(engine: Arc<Engine>, request: Request, progress: Arc<Progress>) -> Result<Outcome> {
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || pack(&handle, &engine, &request, &progress)).await.context("the export stopped unexpectedly")?
}

#[nolog]
fn pack(handle: &Handle, engine: &Arc<Engine>, request: &Request, progress: &Progress) -> Result<Outcome> {
    let org = &request.org;
    let client = handle.block_on(engine.db.get())?;
    progress.step.store(Arc::new("reading the nodes".to_string()));
    let rows = read_tree(handle, &client, org.id, request.root, request.subtree, request.include.retired)?;
    progress.total.store(rows.len() as u64, Ordering::Relaxed);
    let place_of: HashMap<i64, usize> = rows.iter().enumerate().map(|(at, row)| (row.id, at)).collect();
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();

    let mut nodes = listed(handle, engine, org, &client, &rows)?;

    // a duplicate stays inside this engine: nothing leaves, so nothing is scanned
    let detector = if request.duplicate { None } else { Some(Detector::new(&held_secrets(handle, &client)?)) };

    let part = request.dest.with_extension("zip.part");
    if let Some(folder) = request.dest.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let mut guard = PartFile(Some(part.clone()));
    let mut sink = Sink { file: std::io::BufWriter::with_capacity(1024 * 1024, std::fs::File::create(&part)?) };
    let fault = std::cell::RefCell::new(None);
    let outcome = {
        let mut write = |bytes: Vec<u8>| match sink.file.write_all(&bytes) {
            Ok(()) => true,
            Err(error) => {
                *fault.borrow_mut() = Some(error);
                false
            }
        };
        let mut pack = Pack {
            zip: ZipOut::new(&mut write), fault: &fault, progress, detector: detector.as_ref(), strip: request.strip && !request.duplicate,
            index: Vec::new(), unpacked: 0, files: 0, hits: BTreeMap::new(), files_with_secrets: Vec::new(), files_stripped: Vec::new(),
            not_scanned: Vec::new(), not_included: Vec::new(),
        };
        let outcome = fill(handle, engine, request, &client, &rows, &mut nodes, &ids, &place_of, &mut pack)?;
        // the directory of the zip: without it the file is not one
        if !pack.zip.finish() {
            return Err(stopped(&fault));
        }
        outcome
    };
    sink.file.flush()?;
    let file = sink.file.into_inner().map_err(|error| anyhow!("the export file could not be written: {}", error.error()))?;
    file.sync_all()?;
    let file_bytes = file.metadata()?.len();
    drop(file);
    std::fs::rename(&part, &request.dest)?;
    guard.0 = None;
    Ok(Outcome { file_bytes, ..outcome })
}

/// The unfinished file, removed when the export does not end well.
struct PartFile(Option<PathBuf>);

impl Drop for PartFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Everything that goes into the zip, in order: the node list, each node's records, the mail
/// and the event log, the links, then the folders, and last the report, the index and the
/// manifest.
#[nolog]
#[allow(clippy::too_many_arguments)]
fn fill(handle: &Handle, engine: &Arc<Engine>, request: &Request, client: &tokio_postgres::Client, rows: &[Row], nodes: &mut [Node],
        ids: &[i64], place_of: &HashMap<i64, usize>, pack: &mut Pack<'_>) -> Result<Outcome> {
    let org = &request.org;
    let include = request.include;
    // which CLI session files will be in the file is known before the list is written
    let natives: Vec<Option<super::sessions::Found>> = rows.iter().map(|row| {
        (include.native_sessions && row.state == "live" && row.kind == "agent").then(|| super::sessions::find(engine, super::sessions::Seat { org: org.id, agent: row.id, generation: row.generation }, &row.tier, row.account.as_deref(), row.session.as_deref(), &row.extra, Path::new(&nodes[place_of[&row.id]].scratch_dir))).flatten()
    }).collect();
    for (at, found) in natives.iter().enumerate() {
        if let (Some(found), Some(session)) = (found, nodes[at].session.as_mut()) {
            session.files = true;
            session.harness = found.harness.to_string();
        }
    }
    // what the list says in the nodes' own words is scanned like everything else, before it is written
    for node in nodes.iter_mut() {
        let place = format!("settings of {}", node.name);
        for text in [Some(&mut node.title), node.charter.as_mut(), node.team_charter.as_mut()].into_iter().flatten() {
            pack.scan_text(&place, text);
        }
        if let (Some(detector), Some(status)) = (pack.detector, node.last_status.as_mut()) {
            let mut hits = Hits::new();
            detector.scan_json(status, pack.strip, false, &mut hits);
            pack.note(&place, hits);
        }
    }
    pack.part(format::NODES, &serde_json::to_vec_pretty(&Nodes { nodes: nodes.to_vec() })?)?;

    for (at, row) in rows.iter().enumerate() {
        pack.cancelled()?;
        let dir = nodes[at].dir.clone();
        pack.progress.step.store(Arc::new(format!("reading the records of {}", row.name)));
        if include.transcript {
            let place = format!("transcript of {}", row.name);
            let mut lines = pack.lines(&format!("{dir}/{}", format::CONVO))?;
            pages(handle, client,
                "SELECT seq, jsonb_build_object('seq', seq, 'at', at, 'body', body, 'tool_inputs', tool_inputs, 'tool_native_inputs', tool_native_inputs)
                   FROM ot.convo WHERE agent_id = $1 AND seq > $2 ORDER BY seq LIMIT 400", &row.id, |mut record| {
                    // a tool's inputs are what the agent wrote; the rest of a row is the engine's record of it
                    let mut inputs: Vec<Value> = Vec::new();
                    if let Some(tools) = record["body"]["tools"].as_array_mut() {
                        for chip in tools.iter_mut() {
                            inputs.push(chip.as_object_mut().and_then(|c| c.remove("input")).unwrap_or(Value::Null));
                        }
                    }
                    let mut written = json!({ "inputs": inputs });
                    pack.scan_row(&place, &mut written, &["inputs"], &[]);
                    pack.scan_row(&place, &mut record, &["tool_inputs"], &["tool_native_inputs"]);
                    if let (Some(tools), Some(inputs)) = (record["body"]["tools"].as_array_mut(), written["inputs"].as_array_mut()) {
                        for (chip, input) in tools.iter_mut().zip(inputs.iter_mut()) {
                            if !input.is_null() {
                                chip["input"] = input.take();
                            }
                        }
                    }
                    pack.line(&mut lines, &record)
                })?;
            pack.close(lines)?;
            let mut lines = pack.lines(&format!("{dir}/{}", format::TOOL_IMAGES))?;
            let mut offset = 0i64;
            loop {
                let images = query(handle, client,
                    "SELECT jsonb_build_object('tool_id', tool_id, 'idx', idx, 'media', media, 'at', at, 'data', encode(data, 'base64'))
                       FROM ot.tool_images WHERE agent_id = $1 ORDER BY tool_id, idx LIMIT 20 OFFSET $2", &[&row.id, &offset])?;
                if images.is_empty() {
                    break;
                }
                offset += images.len() as i64;
                for image in &images {
                    pack.line(&mut lines, &image.get::<_, Value>(0))?;
                }
            }
            pack.close(lines)?;
            for (name, sql) in [
                (format::TURNS, "SELECT id, to_jsonb(t) - 'agent_id' - 'id' FROM ot.turns t WHERE agent_id = $1 AND id > $2 ORDER BY id LIMIT 1000"),
                (format::SESSIONS, "SELECT id, to_jsonb(s) - 'agent_id' - 'id' FROM ot.agent_sessions s WHERE agent_id = $1 AND id > $2 ORDER BY id LIMIT 1000"),
            ] {
                let mut lines = pack.lines(&format!("{dir}/{name}"))?;
                pages(handle, client, sql, &row.id, |record| pack.line(&mut lines, &record))?;
                pack.close(lines)?;
            }
            let place = format!("questions of {}", row.name);
            let mut lines = pack.lines(&format!("{dir}/{}", format::ASKS))?;
            pages(handle, client, "SELECT id, to_jsonb(k) - 'agent_id' - 'org_id' - 'id' FROM ot.asks k WHERE agent_id = $1 AND id > $2 ORDER BY id LIMIT 200", &row.id, |mut record| {
                pack.scan_row(&place, &mut record, &[], &[]);
                pack.line(&mut lines, &record)
            })?;
            pack.close(lines)?;
        }
        // what it presented and sent: its documents (a project's are the ones presented under it), its files, its uploads
        let place = format!("documents of {}", row.name);
        let mut lines = pack.lines(&format!("{dir}/{}", format::DOCUMENTS))?;
        pages(handle, client,
            "SELECT id, (to_jsonb(d) - 'agent_id' - 'org_id' - 'id' - 'download') || jsonb_build_object('download', encode(d.download, 'base64'))
               FROM ot.documents d WHERE agent_id = $1 AND id > $2 ORDER BY id LIMIT 20", &row.id, |mut record| {
                pack.scan_row(&place, &mut record, &[], &["download"]);
                pack.line(&mut lines, &record)
            })?;
        pack.close(lines)?;
        for (name, sql) in [
            (format::DELIVERIES, "SELECT id, to_jsonb(d) - 'agent_id' - 'org_id' - 'id' FROM ot.deliveries d WHERE agent_id = $1 AND id > $2 ORDER BY id LIMIT 500"),
        ] {
            let mut lines = pack.lines(&format!("{dir}/{name}"))?;
            pages(handle, client, sql, &row.id, |record| pack.line(&mut lines, &record))?;
            pack.close(lines)?;
        }
        let uploads = query(handle, client, "SELECT to_jsonb(u) - 'agent_id' - 'org_id' FROM ot.uploads u WHERE agent_id = $1 AND org_id = $2 ORDER BY at, id", &[&row.id, &org.id])?;
        let mut lines = pack.lines(&format!("{dir}/{}", format::UPLOADS))?;
        for upload in &uploads {
            pack.line(&mut lines, &upload.get::<_, Value>(0))?;
        }
        pack.close(lines)?;
        // the docket items it owns, each with its history and the records of its attachments
        let place = format!("docket items of {}", row.name);
        let mut lines = pack.lines(&format!("{dir}/{}", format::DOCKET))?;
        let items = query(handle, client, "SELECT id, to_jsonb(w) - 'org_id' - 'id' FROM ot.work_items w WHERE owner_agent_id = $1 AND org_id = $2 ORDER BY id", &[&row.id, &org.id])?;
        for item in &items {
            let work: i64 = item.get(0);
            let mut events: Vec<Value> = Vec::new();
            pages(handle, client, "SELECT id, to_jsonb(e) - 'work_id' - 'id' FROM ot.work_events e WHERE work_id = $1 AND id > $2 ORDER BY id LIMIT 1000", &work, |event| {
                events.push(event);
                Ok(())
            })?;
            let attachments: Vec<Value> = query(handle, client, "SELECT to_jsonb(a) - 'work_id' FROM ot.work_attachments a WHERE work_id = $1 ORDER BY at, id", &[&work])?.iter().map(|a| a.get(0)).collect();
            let mut record = json!({ "item": item.get::<_, Value>(1), "events": events, "attachments": attachments });
            pack.scan_row(&place, &mut record, &[], &[]);
            pack.line(&mut lines, &record)?;
        }
        pack.close(lines)?;
        if row.kind == "project" {
            let icon: Option<Value> = query(handle, client, "SELECT value FROM ot.meta WHERE key = $1", &[&crate::domain::projects::icon_key(org.id, row.id)])?.first().map(|r| r.get(0));
            if let Some(icon) = icon {
                pack.part(&format!("{dir}/{}", format::ICON), &serde_json::to_vec(&icon)?)?;
            }
        }
        pack.progress.nodes.fetch_add(1, Ordering::Relaxed);
    }

    // mail: each row once. What a node sent is written with it; what it received from a node of the export was
    // written with its sender, so only mail from outside is added there.
    pack.progress.step.store(Arc::new("reading the mail".to_string()));
    let mut lines = pack.lines(format::MAIL)?;
    for row in rows {
        pack.cancelled()?;
        let place = format!("mail of {}", row.name);
        for (sql, received) in [
            ("SELECT id, (to_jsonb(m) - 'org_id' - 'id') || jsonb_build_object('s', sender_agent_id, 'r', recipient_agent_id)
                FROM ot.mail m WHERE sender_agent_id = $1 AND id > $2 ORDER BY id LIMIT 500", false),
            ("SELECT id, (to_jsonb(m) - 'org_id' - 'id') || jsonb_build_object('s', sender_agent_id, 'r', recipient_agent_id)
                FROM ot.mail m WHERE recipient_agent_id = $1 AND recipient_kind = 'agent' AND id > $2 ORDER BY id LIMIT 500", true),
        ] {
            pages(handle, client, sql, &row.id, |mut record| {
                let sender = record["s"].as_i64().and_then(|id| place_of.get(&id).copied());
                let recipient = record["r"].as_i64().and_then(|id| place_of.get(&id).copied());
                if received && sender.is_some() {
                    return Ok(());
                }
                if let Some(members) = record.as_object_mut() {
                    for key in ["s", "r", "sender_agent_id", "recipient_agent_id", "turn_id"] {
                        members.remove(key);
                    }
                    members.insert("sender_node".into(), json!(sender));
                    members.insert("recipient_node".into(), json!(recipient));
                }
                pack.scan_row(&place, &mut record, &[], &[]);
                pack.line(&mut lines, &record)
            })?;
        }
    }
    pack.close(lines)?;
    let mut lines = pack.lines(format::EVENTS)?;
    for row in rows {
        let place = place_of[&row.id];
        pages(handle, client, "SELECT id, to_jsonb(e) - 'org_id' - 'id' - 'subject_agent_id' FROM ot.events e WHERE subject_agent_id = $1 AND id > $2 ORDER BY id LIMIT 1000", &row.id, |mut record| {
            record["node"] = json!(place);
            pack.line(&mut lines, &record)
        })?;
    }
    pack.close(lines)?;

    // the links between nodes: audiences, watchdog definitions, docket items a node takes part in
    let mut links = Links::default();
    let (found, left) = audiences_of(handle, client, org.id, rows)?;
    links.audiences = found;
    links.left_out.extend(left);
    let dog_names: HashMap<String, bool> = rows.iter().map(|row| (row.name.clone(), row.kind == "project")).collect();
    let dog_include = crate::domain::templates::Include { machine_watchdogs: true, ..Default::default() };
    let mut dog_warnings = Vec::new();
    // a project's own watchdogs travel like an agent's (USER 2026-11-24 m516cde3ebdef: "the two sub-projects are
    // missing watchdogs from the top inbox project"): the owner is the project's place, and the delivery form is kept
    for row in rows.iter().filter(|row| row.kind == "agent" || row.kind == "project") {
        let of_project = row.kind == "project";
        let owned = query(handle, client,
            "SELECT w.id, to_jsonb(w) || jsonb_build_object('owner', $2::text), EXISTS (SELECT 1 FROM ot.watchdog_secrets s WHERE s.watchdog_id = w.id)
               FROM ot.watchdogs w WHERE w.owner_agent_id = $1 AND w.owner_kind = $3 AND w.state IN ('armed', 'paused') ORDER BY w.id", &[&row.id, &row.name, &row.kind])?;
        // the definition reader takes an owner that is an agent of the layout: a project owner is one for it
        let as_owner: HashMap<String, bool>;
        let names = if of_project {
            as_owner = dog_names.iter().map(|(name, project)| (name.clone(), *project && *name != row.name)).collect();
            &as_owner
        } else {
            &dog_names
        };
        for dog in &owned {
            let raw: Value = dog.get(1);
            let sealed: bool = dog.get(2);
            // fire actions that hold credentials, or name a credentials file, travel where sealed credentials do in
            // a file: the user's own export that strips nothing (USER 2026-11-24 mf7c65a1b2403 "can watchdogs be
            // shipped with those secrets if we choose to retain secrets in the export?"). Everywhere else the
            // definition reader takes them out and the watchdog arrives needing them.
            let secret_actions = crate::domain::template_links::secret_fire_actions(&raw);
            if secret_actions.is_some() && pack.detector.is_some() {
                pack.note(&format!("watchdogs of {}", row.name), Hits::from([(secrets::WATCHDOG, 1)]));
            }
            let kept_actions = secret_actions.filter(|_| request.manual && !request.strip && !request.duplicate);
            let mut raw = raw;
            if kept_actions.is_some() {
                // read without them, so that what else the definition needs is still told
                if let Some(memo) = raw["memo"].as_object_mut() {
                    memo.remove("fire_actions");
                }
            }
            let Some(mut saved) = crate::domain::template_links::saved_dog(&raw, names, &dog_include, &mut dog_warnings) else { continue };
            if of_project {
                saved.args["project_delivery"] = json!(crate::domain::watchdogs::project_delivery(&raw["memo"]));
            }
            let mut carried = None;
            if sealed && pack.detector.is_some() {
                pack.note(&format!("watchdogs of {}", row.name), Hits::from([(secrets::WATCHDOG, 1)]));
            }
            // sealed credentials travel only in the user's own export that strips nothing, and inside a duplicate
            if sealed && ((request.manual && !request.strip) || request.duplicate) {
                carried = handle.block_on(crate::runtime::watchdogs::export_credentials(engine, dog.get(0))).unwrap_or(None);
            }
            let needs_credentials = saved.needs_credentials || (sealed && carried.is_none());
            links.watchdogs.push(Watchdog { owner: place_of[&row.id], args: saved.args, paused: saved.paused, needs_credentials, credentials: carried, fire_actions: kept_actions });
        }
    }
    links.left_out.extend(dog_warnings);
    for row in rows {
        let taking_part = query(handle, client,
            "SELECT slug, title, reviewer_agent_id = $1 FROM ot.work_items
              WHERE org_id = $2 AND archived_at IS NULL AND owner_agent_id IS DISTINCT FROM $1 AND (reviewer_agent_id = $1 OR $3 = ANY(participants)) ORDER BY id LIMIT 500",
            &[&row.id, &org.id, &row.name])?;
        for item in &taking_part {
            links.docket_refs.push(DocketRef { node: place_of[&row.id], slug: item.get(0), title: item.get(1),
                role: if item.get::<_, Option<bool>>(2) == Some(true) { "reviewer" } else { "participant" }.to_string() });
        }
    }
    let watchdog_credentials = links.watchdogs.iter().filter(|dog| dog.credentials.is_some() || dog.fire_actions.is_some()).count() as u64;
    pack.part(format::LINKS, &serde_json::to_vec_pretty(&links)?)?;

    // the folders
    let data_root = engine.cfg.data_root.clone();
    let within = engine.cfg.scratch_root(&org.slug);
    for (at, row) in rows.iter().enumerate() {
        pack.cancelled()?;
        let dir = nodes[at].dir.clone();
        pack.progress.step.store(Arc::new(format!("copying the folders of {}", row.name)));
        let project = row.kind == "project";
        // a project's folder is its team folder; an agent's own folder is its scratch folder
        if include.scratch && !project {
            folder(pack, &data_root, &within, Path::new(&nodes[at].scratch_dir), &format!("{dir}/{}", format::SCRATCH), &format!("scratch folder of {}", row.name), true)?;
        }
        if (include.team && request.subtree) || project {
            let team = if project { PathBuf::from(&nodes[at].scratch_dir) } else { PathBuf::from(&nodes[at].team_dir) };
            folder(pack, &data_root, &within, &team, &format!("{dir}/{}", format::TEAM), &format!("team folder of {}", row.name), false)?;
        }
        // the files the user uploaded to it, where its records say they are
        let uploads_root = engine.cfg.path("uploads");
        for upload in query(handle, client, "SELECT path FROM ot.uploads WHERE agent_id = $1 AND org_id = $2 ORDER BY at, id", &[&row.id, &org.id])? {
            let path = PathBuf::from(upload.get::<_, String>(0));
            if let Some(name) = owned_file(&uploads_root, &path) {
                pack.disk_file(&format!("{dir}/{}/{name}", format::UPLOAD_FILES), &path, &name, &format!("uploads of {}", row.name))?;
            }
        }
        let docket_root = engine.cfg.path("docket");
        for attachment in query(handle, client,
            "SELECT w.slug, a.path FROM ot.work_attachments a JOIN ot.work_items w ON w.id = a.work_id WHERE w.owner_agent_id = $1 AND w.org_id = $2 ORDER BY a.at, a.id", &[&row.id, &org.id])? {
            let (slug, path): (String, String) = (attachment.get(0), attachment.get(1));
            let path = PathBuf::from(path);
            if let Some(name) = owned_file(&docket_root, &path) {
                pack.disk_file(&format!("{dir}/{}/{slug}/{name}", format::DOCKET_FILES), &path, &name, &format!("docket items of {}", row.name))?;
            }
        }
        if let Some(found) = &natives[at] {
            pack.progress.step.store(Arc::new(format!("copying the session of {}", row.name)));
            for (name, path) in &found.files {
                // a session's own files are the CLI's record of the same conversation: scanned like the transcript
                pack.disk_file(&format!("{dir}/{}/{}/{name}", format::NATIVE, found.harness), path, name, &format!("session files of {}", row.name))?;
            }
        }
    }

    // the report, the index and the manifest
    let detected: u64 = pack.hits.values().flat_map(|kinds| kinds.values()).sum();
    let mut kinds: BTreeMap<&str, u64> = BTreeMap::new();
    for found in pack.hits.values() {
        for (kind, n) in found {
            *kinds.entry(kind).or_default() += n;
        }
    }
    const LISTED: usize = 200;
    let report = json!({
        "stripped": pack.strip,
        "detected": detected,
        "kinds": kinds,
        "places": pack.hits.iter().map(|(place, kinds)| json!({ "place": place, "kinds": kinds })).collect::<Vec<_>>(),
        "files": pack.files_with_secrets.iter().take(LISTED).collect::<Vec<_>>(),
        "files_more": pack.files_with_secrets.len().saturating_sub(LISTED),
        "left_out": pack.files_stripped.iter().take(LISTED).collect::<Vec<_>>(),
        "left_out_more": pack.files_stripped.len().saturating_sub(LISTED),
        "not_scanned": pack.not_scanned.iter().take(LISTED).collect::<Vec<_>>(),
        "not_scanned_more": pack.not_scanned.len().saturating_sub(LISTED),
        "watchdog_credentials": watchdog_credentials,
    });
    pack.part(format::SECRETS_REPORT, &serde_json::to_vec_pretty(&report)?)?;
    let mut not_included = std::mem::take(&mut pack.not_included);
    not_included.extend(links.left_out.iter().cloned());
    if !not_included.is_empty() {
        let text = format!("These are not in this export:\r\n\r\n{}\r\n", not_included.join("\r\n"));
        pack.part(format::NOT_INCLUDED, text.as_bytes())?;
    }
    let mut index = Vec::new();
    for line in &pack.index {
        serde_json::to_writer(&mut index, line)?;
        index.push(b'\n');
    }
    let mut sha = Sha256::new();
    sha.update(&index);
    let index_sha256 = hex(&sha.finalize());
    if !pack.zip.file(format::INDEX, None, &mut &index[..])? {
        return Err(pack.stopped());
    }
    let mut manifest = Manifest {
        kind: format::KIND.to_string(),
        format: format::FORMAT,
        orgtree_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: crate::util::now_iso(),
        origin: format::Origin { engine: engine_id(handle, client)?, org_uuid: org.uuid.clone(), org_slug: org.slug.clone(), org_name: org.name.load().as_ref().clone(), by: request.by.clone() },
        root: rows[0].name.clone(),
        subtree: request.subtree,
        duplicate: request.duplicate,
        counts: format::Counts {
            agents: rows.iter().filter(|row| row.kind == "agent" && row.state == "live").count() as u64,
            projects: rows.iter().filter(|row| row.kind == "project" && row.state == "live").count() as u64,
            retired: rows.iter().filter(|row| row.state != "live").count() as u64,
            files: pack.files,
        },
        bytes: format::Sizes { unpacked: pack.unpacked },
        include,
        secrets: format::SecretsNote { stripped: pack.strip, detected, watchdog_credentials },
        index_sha256,
        seal: None,
    };
    manifest.seal = super::seal::sign(engine, &manifest);
    if !pack.zip.file(format::MANIFEST, None, &mut &serde_json::to_vec_pretty(&manifest)?[..])? {
        return Err(pack.stopped());
    }
    Ok(Outcome { manifest, report, not_included, file_bytes: 0 })
}

/// The name of `path` when it is a file directly or deeper inside `root`: what a record says
/// is not followed to anywhere else.
#[nolog]
fn owned_file(root: &Path, path: &Path) -> Option<String> {
    let (root, path) = (std::fs::canonicalize(root).ok()?, std::fs::canonicalize(path).ok()?);
    (path.starts_with(&root) && path.is_file()).then(|| path.file_name().map(|name| name.to_string_lossy().to_string())).flatten()
}

/// One of a node's folders into the zip. A folder of the organization's own is taken only when
/// no link stands in its place or above it; a scratch folder stored somewhere else (an agent
/// imported from an older version keeps its path) is taken as it is, links inside left out. A
/// folder that is not there is not an error: many agents have no team folder.
#[nolog]
fn folder(pack: &mut Pack<'_>, data_root: &Path, within: &Path, folder: &Path, prefix: &str, place: &str, scratch: bool) -> Result<()> {
    let resolved = match crate::http::scratch_files::unlinked_root(data_root, within, folder) {
        Ok(resolved) => resolved,
        Err((status, _)) if status == axum::http::StatusCode::NOT_FOUND => return Ok(()),
        Err((_, why)) => match std::fs::canonicalize(folder) {
            Ok(elsewhere) if !crate::domain::scope::path_within(&folder.to_string_lossy(), &within.to_string_lossy()) && elsewhere.is_dir() => elsewhere,
            _ => {
                pack.not_included.push(format!("{prefix} ({why})"));
                return Ok(());
            }
        },
    };
    if !pack.zip.folder(prefix, std::fs::metadata(&resolved).ok().and_then(|m| m.modified().ok())) {
        return Err(pack.stopped());
    }
    let skip = |path: &str| scratch && engine_owned(path);
    pack.tree(prefix, &resolved, place, &skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engines_own_files_in_a_scratch_folder_are_not_exported() {
        for path in [
            ".orgtree-identity.md", ".orgtree-settings.json", ".orgtree-mcp.json", ".orgtree-muse-identity.md", ".orgtree-tool-scope",
            ".orgtree-tool-scope/anything", ".orgtree-exports", ".orgtree-exports/team.zip", ".agents/hooks.json", ".agents/orgtree-rights.json",
            ".agents/steer", ".agents/plugins/orgtree", ".agents/rules/orgtree-identity-0000.md", "notes/.up1a2b.orgtree-part",
        ] {
            assert!(engine_owned(path), "{path}");
        }
        for path in [
            "AGENTS.md", "breadcrumbs.md", "outbox", "outbox/deliveryabc/report.pdf", ".agents", ".agents/AGENTS.md", ".agents/rules",
            ".agents/rules/my-own-rule.md", ".agents/rules/sub/orgtree-identity-0000.md", ".agents/skills/x/SKILL.md", "exports/data.csv",
            "notes/orgtree-identity.md", ".env", "earlier-conversation-20261120-202605.md", "src/.orgtree-identity.md",
        ] {
            assert!(!engine_owned(path), "{path}");
        }
    }
}
