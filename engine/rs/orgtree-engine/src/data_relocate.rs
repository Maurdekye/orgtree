//! Crash-resumable, idempotent post-move data relocation (`Q8`).
//!
//! When the desktop moves the data folder from `<fromRoot>` to `<toRoot>`, it
//! stamps `<toRoot>/.data-location-moved.json` before switching
//! `data-location.json`. On the first engine boot at `<toRoot>` — immediately
//! after schema migrations and before importer, org load, accounts, mailhub, or
//! agent recovery — `run_if_needed` rewrites `<fromRoot>` path prefixes inside:
//!   1. All 16 path/JSONB columns in PostgreSQL (`ot.*`), in one SQL transaction.
//!   2. Managed Claude profile state under `<toRoot>/profiles/claude-*`
//!      (`.claude.json` project keys and `projects/<encoded-cwd>` directories).
//!   3. Appends an audit receipt to `<toRoot>/diagnostics/data-relocation.jsonl`
//!      and removes `.data-location-moved.json` last.
//!
//! If the process crashes or is killed at any step, `.data-location-moved.json`
//! remains on disk and the next startup safely finishes from wherever it stopped.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use deadpool_postgres::Pool;
use serde_json::{json, Map, Value};
use tokio_postgres::Transaction;

use crate::config::Config;
use crate::data_location::comparable_path;

pub const MOVED_MARKER_FILE: &str = ".data-location-moved.json";
pub const RECEIPT_REL_PATH: &str = "diagnostics/data-relocation.jsonl";

#[derive(Clone, Debug)]
pub struct MoveMarker {
    pub from_root: String,
    pub from_variants: Vec<String>,
    pub to_root: String,
    pub to_clean: String,
    pub moved_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DbRelocationStats {
    pub orgs: usize,
    pub agents: usize,
    pub agent_sessions: usize,
    pub accounts: usize,
    pub mail: usize,
    pub org_inbox: usize,
    pub net_transfers: usize,
    pub net_downloads: usize,
    pub uploads: usize,
    pub upload_stages: usize,
    pub deliveries: usize,
    pub work_attachments: usize,
    pub work_items: usize,
    pub watchdogs: usize,
    pub custom_app_file_grants: usize,
    pub custom_app_file_refs: usize,
}

#[nolog]
impl DbRelocationStats {
    pub fn total(&self) -> usize {
        self.orgs
            + self.agents
            + self.agent_sessions
            + self.accounts
            + self.mail
            + self.org_inbox
            + self.net_transfers
            + self.net_downloads
            + self.uploads
            + self.upload_stages
            + self.deliveries
            + self.work_attachments
            + self.work_items
            + self.watchdogs
            + self.custom_app_file_grants
            + self.custom_app_file_refs
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProfileRelocationStats {
    pub configs_updated: usize,
    pub project_dirs_moved: usize,
}

#[logged]
pub fn strip_verbatim_and_trailing(raw: &str) -> String {
    let trimmed = raw.trim();
    let plain = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    // Keep a bare Windows drive root like `S:\` down to `S:` when matching
    // boundaries (`S:` + `\foo`), so `S:\foo` relocates cleanly even if the
    // source or target was a drive root.
    plain.trim_end_matches(['\\', '/']).to_string()
}

#[nolog]
fn is_windows_like_path(p: &str) -> bool {
    let bytes = p.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') || p.starts_with(r"\\")
}

/// Match `from_clean` against `body` on a strict path-component boundary,
/// returning the untouched suffix starting with `\` or `/` (or `""` on an exact
/// match). Never matches sibling prefixes such as `C:\data-other`.
#[nolog]
fn match_prefix_boundary<'a>(body: &'a str, from_clean: &str, case_insensitive: bool) -> Option<&'a str> {
    if from_clean.is_empty() {
        return None;
    }
    let mut b_chars = body.char_indices();
    for fc in from_clean.chars() {
        let (_, bc) = b_chars.next()?;
        let same = if (fc == '\\' || fc == '/') && (bc == '\\' || bc == '/') {
            true
        } else if case_insensitive {
            fc.to_lowercase().eq(bc.to_lowercase())
        } else {
            fc == bc
        };
        if !same {
            return None;
        }
    }
    match b_chars.next() {
        None => Some(""),
        Some((idx, sep)) if sep == '\\' || sep == '/' => Some(&body[idx..]),
        Some(_) => None,
    }
}

/// Rewrite `value` if it equals or sits inside any spelling in `from_variants`.
/// Returns `None` when `value` is unrelated or already relocated to `to_clean`.
#[logged]
pub fn rewrite_path_str(value: &str, from_variants: &[String], to_clean: &str) -> Option<String> {
    if value.is_empty() || to_clean.is_empty() {
        return None;
    }
    let (verbatim, body) = match value.strip_prefix(r"\\?\") {
        Some(rest) => (true, rest),
        None => (false, value),
    };
    let case_insensitive = cfg!(windows) || is_windows_like_path(to_clean) || is_windows_like_path(body);

    // Idempotency guard: if `value` already resolves inside `to_clean` (unless
    // `from` is a strict subdirectory of `to_clean`, which move preflight
    // forbids), leave it untouched.
    let from_inside_to = from_variants
        .iter()
        .any(|f| match_prefix_boundary(f, to_clean, case_insensitive).is_some_and(|s| !s.is_empty()));
    if !from_inside_to && match_prefix_boundary(body, to_clean, case_insensitive).is_some() {
        return None;
    }

    for from in from_variants {
        if let Some(suffix) = match_prefix_boundary(body, from, case_insensitive) {
            let forward_only = body.contains('/') && !body.contains('\\') && !verbatim;
            let base = if forward_only {
                to_clean.replace('\\', "/")
            } else {
                to_clean.to_string()
            };
            let rebuilt_body = if suffix.is_empty() {
                // Bare Windows drive root (`S:`) needs its trailing separator
                // when standing alone as a directory path.
                if base.len() == 2 && base.as_bytes()[1] == b':' {
                    if forward_only {
                        format!("{base}/")
                    } else {
                        format!(r"{base}\")
                    }
                } else {
                    base
                }
            } else {
                format!("{base}{suffix}")
            };
            let rebuilt = if verbatim && !rebuilt_body.starts_with(r"\\") {
                format!(r"\\?\{rebuilt_body}")
            } else {
                rebuilt_body
            };
            if rebuilt != value {
                return Some(rebuilt);
            }
            return None;
        }
    }
    None
}

fn rewrite_dir_entries_field(doc: &Value, key: &str, from_variants: &[String], to_clean: &str) -> Option<Value> {
    let obj = doc.as_object()?;
    let items = obj.get(key)?.as_array()?;
    let mut changed = false;
    let mut next_items = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(s) => {
                if let Some(re) = rewrite_path_str(s, from_variants, to_clean) {
                    changed = true;
                    next_items.push(Value::String(re));
                } else {
                    next_items.push(item.clone());
                }
            }
            Value::Object(entry) => {
                if let Some(p) = entry.get("path").and_then(Value::as_str) {
                    if let Some(re) = rewrite_path_str(p, from_variants, to_clean) {
                        changed = true;
                        let mut next_entry = entry.clone();
                        next_entry.insert("path".into(), Value::String(re));
                        next_items.push(Value::Object(next_entry));
                        continue;
                    }
                }
                next_items.push(item.clone());
            }
            _ => next_items.push(item.clone()),
        }
    }
    if !changed {
        return None;
    }
    let mut next_obj = obj.clone();
    next_obj.insert(key.into(), Value::Array(next_items));
    Some(Value::Object(next_obj))
}

fn rewrite_attachments_array(doc: &Value, from_variants: &[String], to_clean: &str) -> Option<Value> {
    let items = doc.as_array()?;
    let mut changed = false;
    let mut next_items = Vec::with_capacity(items.len());
    for item in items {
        if let Some(obj) = item.as_object() {
            if let Some(p) = obj.get("path").and_then(Value::as_str) {
                if let Some(re) = rewrite_path_str(p, from_variants, to_clean) {
                    changed = true;
                    let mut next = obj.clone();
                    next.insert("path".into(), Value::String(re));
                    next_items.push(Value::Object(next));
                    continue;
                }
            }
        }
        next_items.push(item.clone());
    }
    changed.then_some(Value::Array(next_items))
}

fn rewrite_transfer_source(doc: &Value, from_variants: &[String], to_clean: &str) -> Option<Value> {
    let obj = doc.as_object()?;
    let p = obj.get("path")?.as_str()?;
    let re = rewrite_path_str(p, from_variants, to_clean)?;
    let mut next = obj.clone();
    next.insert("path".into(), Value::String(re));
    Some(Value::Object(next))
}

fn rewrite_work_evidence(doc: &Value, from_variants: &[String], to_clean: &str) -> Option<Value> {
    let items = doc.as_array()?;
    let mut changed = false;
    let mut next_items = Vec::with_capacity(items.len());
    for item in items {
        if let Some(obj) = item.as_object() {
            let mut item_changed = false;
            let mut next = obj.clone();
            let kind = obj.get("kind").and_then(Value::as_str);
            if matches!(kind, Some("file" | "log") | None) {
                if let Some(r) = obj.get("ref").and_then(Value::as_str) {
                    if let Some(re) = rewrite_path_str(r, from_variants, to_clean) {
                        next.insert("ref".into(), Value::String(re));
                        item_changed = true;
                    }
                }
            }
            if let Some(p) = obj.get("path").and_then(Value::as_str) {
                if let Some(re) = rewrite_path_str(p, from_variants, to_clean) {
                    next.insert("path".into(), Value::String(re));
                    item_changed = true;
                }
            }
            if item_changed {
                changed = true;
                next_items.push(Value::Object(next));
                continue;
            }
        }
        next_items.push(item.clone());
    }
    changed.then_some(Value::Array(next_items))
}

#[logged]
pub fn read_marker(data_root: &Path) -> Result<Option<MoveMarker>> {
    let marker_path = data_root.join(MOVED_MARKER_FILE);
    if !marker_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&marker_path)
        .with_context(|| format!("could not read {}", marker_path.display()))?;
    let doc: Value = serde_json::from_str(&raw)
        .with_context(|| format!("{} is not valid JSON", marker_path.display()))?;
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        bail!("{} has unsupported version (expected 1)", marker_path.display());
    }
    let from_root = doc
        .get("fromRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("{} is missing fromRoot", marker_path.display()))?
        .to_string();
    let to_root = doc
        .get("toRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("{} is missing toRoot", marker_path.display()))?
        .to_string();

    if comparable_path(Path::new(&to_root)) != comparable_path(data_root) {
        bail!(
            "{} targets {}, which does not match active data root {}",
            marker_path.display(),
            to_root,
            data_root.display()
        );
    }

    let to_clean = strip_verbatim_and_trailing(&data_root.to_string_lossy());
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    let mut push_variant = |candidate: &str| {
        let clean = strip_verbatim_and_trailing(candidate);
        if clean.is_empty() {
            return;
        }
        let key = if cfg!(windows) || is_windows_like_path(&clean) {
            clean.replace('/', "\\").to_lowercase()
        } else {
            clean.clone()
        };
        if seen.insert(key) {
            variants.push(clean);
        }
    };

    push_variant(&from_root);
    if let Some(arr) = doc.get("fromRootVariants").and_then(Value::as_array) {
        for entry in arr {
            if let Some(s) = entry.as_str() {
                push_variant(s);
            }
        }
    }
    if let Ok(canon) = std::fs::canonicalize(&from_root) {
        push_variant(&canon.to_string_lossy());
    }
    variants.sort_by(|a, b| b.len().cmp(&a.len()));

    let moved_at = doc.get("movedAt").and_then(Value::as_str).map(str::to_string);
    Ok(Some(MoveMarker {
        from_root,
        from_variants: variants,
        to_root,
        to_clean,
        moved_at,
    }))
}

/// Test-only crash hook: when `ORGTREE_TEST_RELOCATE_CHECKPOINT` matches `stage`,
/// signals readiness to `ORGTREE_TEST_RELOCATE_SIGNAL_FILE` (if set) and sleeps
/// until the test harness kills this child process.
fn maybe_pause_for_crash_test(stage: &str) {
    #[cfg(any(test, debug_assertions))]
    {
        if std::env::var("ORGTREE_TEST_RELOCATE_CHECKPOINT").as_deref() == Ok(stage) {
            if let Ok(sig) = std::env::var("ORGTREE_TEST_RELOCATE_SIGNAL_FILE") {
                let _ = std::fs::write(&sig, format!("paused:{stage}\n"));
            }
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
            }
        }
    }
    #[cfg(not(any(test, debug_assertions)))]
    let _ = stage;
}

#[logged]
pub async fn relocate_database<'a>(
    tx: &Transaction<'a>,
    from_variants: &[String],
    to_clean: &str,
) -> Result<DbRelocationStats> {
    let mut stats = DbRelocationStats::default();

    // 1. ot.orgs.settings -> dirs
    for row in tx.query("SELECT id, settings FROM ot.orgs", &[]).await? {
        let id: i64 = row.get(0);
        let settings: Value = row.get(1);
        if let Some(next) = rewrite_dir_entries_field(&settings, "dirs", from_variants, to_clean) {
            tx.execute("UPDATE ot.orgs SET settings = $2 WHERE id = $1", &[&id, &next]).await?;
            stats.orgs += 1;
        }
    }

    // 2. ot.agents -> scratch_dir + scope.add_dirs
    for row in tx.query("SELECT id, scratch_dir, scope FROM ot.agents", &[]).await? {
        let id: i64 = row.get(0);
        let scratch_dir: Option<String> = row.get(1);
        let scope: Value = row.get(2);
        let next_scratch = scratch_dir
            .as_deref()
            .and_then(|s| rewrite_path_str(s, from_variants, to_clean));
        let next_scope = rewrite_dir_entries_field(&scope, "add_dirs", from_variants, to_clean);
        if next_scratch.is_some() || next_scope.is_some() {
            let final_scratch = next_scratch.or(scratch_dir);
            let final_scope = next_scope.unwrap_or(scope);
            tx.execute(
                "UPDATE ot.agents SET scratch_dir = $2, scope = $3 WHERE id = $1",
                &[&id, &final_scratch, &final_scope],
            )
            .await?;
            stats.agents += 1;
        }
    }

    // 3. ot.agent_sessions -> transcript_file
    for row in tx
        .query(
            "SELECT id, transcript_file FROM ot.agent_sessions WHERE transcript_file IS NOT NULL",
            &[],
        )
        .await?
    {
        let id: i64 = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute(
                "UPDATE ot.agent_sessions SET transcript_file = $2 WHERE id = $1",
                &[&id, &next],
            )
            .await?;
            stats.agent_sessions += 1;
        }
    }

    // 4. ot.accounts -> config_dir
    for row in tx
        .query("SELECT id, config_dir FROM ot.accounts WHERE config_dir IS NOT NULL", &[])
        .await?
    {
        let id: String = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.accounts SET config_dir = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.accounts += 1;
        }
    }

    // 5. ot.mail -> attachments[*].path
    for row in tx
        .query(
            "SELECT id, attachments FROM ot.mail WHERE jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) > 0",
            &[],
        )
        .await?
    {
        let id: i64 = row.get(0);
        let attachments: Value = row.get(1);
        if let Some(next) = rewrite_attachments_array(&attachments, from_variants, to_clean) {
            tx.execute("UPDATE ot.mail SET attachments = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.mail += 1;
        }
    }

    // 6. ot.org_inbox -> attachments[*].path
    for row in tx
        .query(
            "SELECT id, attachments FROM ot.org_inbox WHERE jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) > 0",
            &[],
        )
        .await?
    {
        let id: i64 = row.get(0);
        let attachments: Value = row.get(1);
        if let Some(next) = rewrite_attachments_array(&attachments, from_variants, to_clean) {
            tx.execute("UPDATE ot.org_inbox SET attachments = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.org_inbox += 1;
        }
    }

    // 7. ot.net_transfers -> source.path
    for row in tx.query("SELECT id, source FROM ot.net_transfers", &[]).await? {
        let id: String = row.get(0);
        let source: Value = row.get(1);
        if let Some(next) = rewrite_transfer_source(&source, from_variants, to_clean) {
            tx.execute("UPDATE ot.net_transfers SET source = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.net_transfers += 1;
        }
    }

    // 8. ot.net_downloads -> path
    for row in tx.query("SELECT id, path FROM ot.net_downloads", &[]).await? {
        let id: String = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.net_downloads SET path = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.net_downloads += 1;
        }
    }

    // 9. ot.uploads -> path
    for row in tx.query("SELECT id, path FROM ot.uploads", &[]).await? {
        let id: String = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.uploads SET path = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.uploads += 1;
        }
    }

    // 10. ot.upload_stages -> path
    for row in tx.query("SELECT id, path FROM ot.upload_stages", &[]).await? {
        let id: String = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.upload_stages SET path = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.upload_stages += 1;
        }
    }

    // 11. ot.deliveries -> path
    for row in tx.query("SELECT id, path FROM ot.deliveries", &[]).await? {
        let id: i64 = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.deliveries SET path = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.deliveries += 1;
        }
    }

    // 12. ot.work_attachments -> path
    for row in tx.query("SELECT id, path FROM ot.work_attachments", &[]).await? {
        let id: String = row.get(0);
        let path: String = row.get(1);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute("UPDATE ot.work_attachments SET path = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.work_attachments += 1;
        }
    }

    // 13. ot.work_items -> evidence[*] (file/log refs)
    for row in tx
        .query(
            "SELECT id, evidence FROM ot.work_items WHERE jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0",
            &[],
        )
        .await?
    {
        let id: i64 = row.get(0);
        let evidence: Value = row.get(1);
        if let Some(next) = rewrite_work_evidence(&evidence, from_variants, to_clean) {
            tx.execute("UPDATE ot.work_items SET evidence = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.work_items += 1;
        }
    }

    // 14. ot.watchdogs -> target (file watchdogs only)
    for row in tx
        .query("SELECT id, target FROM ot.watchdogs WHERE kind = 'file'", &[])
        .await?
    {
        let id: i64 = row.get(0);
        let target: String = row.get(1);
        if let Some(next) = rewrite_path_str(&target, from_variants, to_clean) {
            tx.execute("UPDATE ot.watchdogs SET target = $2 WHERE id = $1", &[&id, &next])
                .await?;
            stats.watchdogs += 1;
        }
    }

    // 15. ot.custom_app_file_grants -> path
    for row in tx
        .query(
            "SELECT org_id, app_id, id, path FROM ot.custom_app_file_grants WHERE path IS NOT NULL",
            &[],
        )
        .await?
    {
        let org_id: i64 = row.get(0);
        let app_id: String = row.get(1);
        let id: String = row.get(2);
        let path: String = row.get(3);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute(
                "UPDATE ot.custom_app_file_grants SET path = $4 WHERE org_id = $1 AND app_id = $2 AND id = $3",
                &[&org_id, &app_id, &id, &next],
            )
            .await?;
            stats.custom_app_file_grants += 1;
        }
    }

    // 16. ot.custom_app_file_refs -> path
    for row in tx
        .query(
            "SELECT org_id, app_id, panel_id, id, path FROM ot.custom_app_file_refs",
            &[],
        )
        .await?
    {
        let org_id: i64 = row.get(0);
        let app_id: String = row.get(1);
        let panel_id: String = row.get(2);
        let id: String = row.get(3);
        let path: String = row.get(4);
        if let Some(next) = rewrite_path_str(&path, from_variants, to_clean) {
            tx.execute(
                "UPDATE ot.custom_app_file_refs SET path = $5 WHERE org_id = $1 AND app_id = $2 AND panel_id = $3 AND id = $4",
                &[&org_id, &app_id, &panel_id, &id, &next],
            )
            .await?;
            stats.custom_app_file_refs += 1;
        }
    }

    Ok(stats)
}

fn encode_claude_project_dir(path_str: &str) -> String {
    path_str
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn suffix_belongs_to_data_root(data_root: &Path, suffix_after_dash: &str, encoded_top_entries: &[String]) -> bool {
    let lower = suffix_after_dash.to_ascii_lowercase();
    if lower == "scratch"
        || lower.starts_with("scratch-")
        || lower == "orgs"
        || lower.starts_with("orgs-")
        || lower == "profiles"
        || lower.starts_with("profiles-")
    {
        return true;
    }
    let _ = data_root;
    for top in encoded_top_entries {
        if top.is_empty() {
            continue;
        }
        let top_lower = top.to_ascii_lowercase();
        if lower == top_lower || lower.starts_with(&format!("{top_lower}-")) {
            return true;
        }
    }
    false
}

fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".{}.relocate-{}.tmp",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let mut f = std::fs::File::create(&tmp)
        .with_context(|| format!("could not create {}", tmp.display()))?;
    f.write_all(bytes)
        .with_context(|| format!("could not write {}", tmp.display()))?;
    let _ = f.sync_all();
    drop(f);
    std::fs::rename(&tmp, target)
        .with_context(|| format!("could not rename {} -> {}", tmp.display(), target.display()))?;
    Ok(())
}

/// Crash-resumable move of `src` directory into `dst`. When `dst` does not yet
/// exist on the same volume, `rename` is atomic; if an earlier crash left both
/// `src` and `dst` present, merges every file from `src` into `dst` and removes
/// `src` once empty.
fn merge_or_move_dir(src: &Path, dst: &Path, pause_after_first_file: bool) -> Result<()> {
    if comparable_path(src) == comparable_path(dst) {
        return Ok(());
    }
    if !dst.exists() && !pause_after_first_file {
        if std::fs::rename(src, dst).is_ok() {
            return Ok(());
        }
    }
    std::fs::create_dir_all(dst)
        .with_context(|| format!("could not create {}", dst.display()))?;
    let mut moved_one = false;
    for entry in std::fs::read_dir(src).with_context(|| format!("could not read {}", src.display()))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_child = entry.path();
        let dst_child = dst.join(entry.file_name());
        if file_type.is_symlink() {
            // Never traverse links inside profile dirs; drop stale link entry.
            let _ = std::fs::remove_file(&src_child);
            continue;
        }
        if file_type.is_dir() {
            merge_or_move_dir(&src_child, &dst_child, false)?;
        } else {
            if std::fs::rename(&src_child, &dst_child).is_err() {
                let data = std::fs::read(&src_child)?;
                atomic_write_bytes(&dst_child, &data)?;
                std::fs::remove_file(&src_child)?;
            }
            if pause_after_first_file && !moved_one {
                moved_one = true;
                maybe_pause_for_crash_test("mid-profiles");
            }
        }
    }
    std::fs::remove_dir(src)
        .with_context(|| format!("could not remove merged source dir {}", src.display()))?;
    Ok(())
}

fn rewrite_claude_json(path: &Path, from_variants: &[String], to_clean: &str) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    let Ok(mut doc) = serde_json::from_str::<Value>(&raw) else {
        return Ok(false);
    };
    let Some(root_obj) = doc.as_object_mut() else {
        return Ok(false);
    };
    let Some(projects) = root_obj.get("projects").and_then(Value::as_object).cloned() else {
        return Ok(false);
    };
    let mut changed = false;
    let mut next_projects = Map::new();
    for (k, v) in projects {
        if let Some(re_key) = rewrite_path_str(&k, from_variants, to_clean) {
            changed = true;
            // If an interrupted run already created `re_key`, preserve existing
            // fields on `re_key` and backfill any missing keys from `v`.
            match (next_projects.get_mut(&re_key), v) {
                (Some(Value::Object(existing)), Value::Object(incoming)) => {
                    for (ik, iv) in incoming {
                        existing.entry(ik).or_insert(iv);
                    }
                }
                (None, val) => {
                    next_projects.insert(re_key, val);
                }
                _ => {}
            }
        } else if let Some(Value::Object(existing)) = next_projects.get_mut(&k) {
            if let Value::Object(incoming) = v {
                for (ik, iv) in incoming {
                    existing.insert(ik, iv);
                }
            }
        } else {
            next_projects.insert(k, v);
        }
    }
    if !changed {
        return Ok(false);
    }
    root_obj.insert("projects".into(), Value::Object(next_projects));
    let encoded = serde_json::to_vec_pretty(&doc)?;
    atomic_write_bytes(path, &encoded)?;
    Ok(true)
}

#[logged]
pub fn relocate_claude_profiles(
    data_root: &Path,
    from_variants: &[String],
    to_clean: &str,
) -> Result<ProfileRelocationStats> {
    let mut stats = ProfileRelocationStats::default();
    let profiles_dir = data_root.join("profiles");
    if !profiles_dir.is_dir() {
        return Ok(stats);
    }

    let mut encoded_top_entries = Vec::new();
    if let Ok(entries) = std::fs::read_dir(data_root) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with('.') {
                    encoded_top_entries.push(encode_claude_project_dir(name));
                }
            }
        }
    }

    let encoded_to = encode_claude_project_dir(to_clean);
    let encoded_froms: Vec<(String, bool)> = from_variants
        .iter()
        .map(|f| {
            let ci = cfg!(windows) || is_windows_like_path(f) || is_windows_like_path(to_clean);
            (encode_claude_project_dir(f), ci)
        })
        .collect();

    let pause_mid_profiles = {
        #[cfg(any(test, debug_assertions))]
        {
            std::env::var("ORGTREE_TEST_RELOCATE_CHECKPOINT").as_deref() == Ok("mid-profiles")
        }
        #[cfg(not(any(test, debug_assertions)))]
        {
            false
        }
    };

    let mut profile_dirs: Vec<PathBuf> = std::fs::read_dir(&profiles_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)
                && e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("claude-") || n == "claude")
                    .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    profile_dirs.sort();

    for profile in profile_dirs {
        if rewrite_claude_json(&profile.join(".claude.json"), from_variants, to_clean)? {
            stats.configs_updated += 1;
        }
        let projects_dir = profile.join("projects");
        if !projects_dir.is_dir() {
            continue;
        }
        let mut proj_entries: Vec<PathBuf> = std::fs::read_dir(&projects_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        proj_entries.sort();

        for proj_path in proj_entries {
            let Some(name) = proj_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Skip directories already starting with `encoded_to` at a boundary.
            let already_to = if cfg!(windows) || is_windows_like_path(to_clean) {
                let nl = name.to_ascii_lowercase();
                let tl = encoded_to.to_ascii_lowercase();
                nl == tl || nl.starts_with(&format!("{tl}-"))
            } else {
                name == encoded_to || name.starts_with(&format!("{encoded_to}-"))
            };
            if already_to {
                continue;
            }

            let mut target_name: Option<String> = None;
            for (enc_from, ci) in &encoded_froms {
                if enc_from.is_empty() {
                    continue;
                }
                let matched_suffix = if *ci {
                    let nl = name.to_ascii_lowercase();
                    let fl = enc_from.to_ascii_lowercase();
                    if nl == fl {
                        Some("")
                    } else if nl.starts_with(&format!("{fl}-")) {
                        Some(&name[enc_from.len() + 1..])
                    } else {
                        None
                    }
                } else if name == enc_from {
                    Some("")
                } else if name.starts_with(&format!("{enc_from}-")) {
                    Some(&name[enc_from.len() + 1..])
                } else {
                    None
                };

                if let Some(after_dash) = matched_suffix {
                    if after_dash.is_empty() {
                        target_name = Some(encoded_to.clone());
                        break;
                    }
                    if suffix_belongs_to_data_root(data_root, after_dash, &encoded_top_entries) {
                        target_name = Some(format!("{encoded_to}-{after_dash}"));
                        break;
                    }
                }
            }

            if let Some(new_dir_name) = target_name {
                if new_dir_name != name {
                    let dst = projects_dir.join(&new_dir_name);
                    merge_or_move_dir(&proj_path, &dst, pause_mid_profiles)?;
                    stats.project_dirs_moved += 1;
                }
            }
        }
    }

    Ok(stats)
}

#[logged]
pub fn write_receipt_and_clear_marker(
    data_root: &Path,
    marker: &MoveMarker,
    db_stats: DbRelocationStats,
    profile_stats: ProfileRelocationStats,
) -> Result<()> {
    let receipt_path = data_root.join(RECEIPT_REL_PATH);
    if let Some(parent) = receipt_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = json!({
        "at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "fromRoot": marker.from_root,
        "fromVariants": marker.from_variants,
        "toRoot": marker.to_root,
        "movedAt": marker.moved_at,
        "dbRowsUpdated": db_stats.total(),
        "dbTables": {
            "orgs": db_stats.orgs,
            "agents": db_stats.agents,
            "agent_sessions": db_stats.agent_sessions,
            "accounts": db_stats.accounts,
            "mail": db_stats.mail,
            "org_inbox": db_stats.org_inbox,
            "net_transfers": db_stats.net_transfers,
            "net_downloads": db_stats.net_downloads,
            "uploads": db_stats.uploads,
            "upload_stages": db_stats.upload_stages,
            "deliveries": db_stats.deliveries,
            "work_attachments": db_stats.work_attachments,
            "work_items": db_stats.work_items,
            "watchdogs": db_stats.watchdogs,
            "custom_app_file_grants": db_stats.custom_app_file_grants,
            "custom_app_file_refs": db_stats.custom_app_file_refs,
        },
        "claudeConfigsUpdated": profile_stats.configs_updated,
        "claudeProjectDirsMoved": profile_stats.project_dirs_moved,
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&receipt_path)
        .with_context(|| format!("could not open {}", receipt_path.display()))?;
    writeln!(f, "{line}")?;
    let _ = f.sync_data();
    drop(f);

    let marker_path = data_root.join(MOVED_MARKER_FILE);
    if marker_path.exists() {
        std::fs::remove_file(&marker_path)
            .with_context(|| format!("could not remove {}", marker_path.display()))?;
    }
    Ok(())
}

#[logged]
pub async fn run_if_needed(cfg: &Config, pool: &Pool, progress: &dyn Fn(&str)) -> Result<()> {
    let Some(marker) = read_marker(&cfg.data_root)? else {
        return Ok(());
    };

    if comparable_path(Path::new(&marker.from_root)) == comparable_path(&cfg.data_root) {
        write_receipt_and_clear_marker(
            &cfg.data_root,
            &marker,
            DbRelocationStats::default(),
            ProfileRelocationStats::default(),
        )?;
        return Ok(());
    }

    progress("relocating-data");
    tracing::info!(
        from = %marker.from_root,
        to = %cfg.data_root.display(),
        "relocating moved data root paths"
    );

    let db_stats = {
        let mut client = pool.get().await.context("relocation db connection")?;
        let tx = client.transaction().await.context("relocation db transaction")?;
        let stats = relocate_database(&tx, &marker.from_variants, &marker.to_clean).await?;
        maybe_pause_for_crash_test("mid-sql-before-commit");
        tx.commit().await.context("relocation db commit")?;
        stats
    };

    maybe_pause_for_crash_test("after-sql-before-profiles");

    let profile_stats = relocate_claude_profiles(
        &cfg.data_root,
        &marker.from_variants,
        &marker.to_clean,
    )?;

    write_receipt_and_clear_marker(&cfg.data_root, &marker, db_stats, profile_stats)?;
    tracing::info!(
        db_rows = db_stats.total(),
        claude_configs = profile_stats.configs_updated,
        claude_projects = profile_stats.project_dirs_moved,
        "data root relocation complete"
    );
    Ok(())
}
