//! Resumable schema-migration runner (M1 contract §2 row 2; lead ruling
//! 2026-09-25: option (a), migrations read at run time via `--schema-dir`).
//!
//! Input: a directory holding `NNNN_name.sql` files and `SHA256SUMS`
//! (`<64 lowercase hex>  <file>` per line), i.e. WS2's
//! `engine/native/store-schema/migrations/`.
//!
//! THE HASHING RULE, shared with WS2's `store_schema::normalized` (agreed by
//! mail 2026-09-25): sha256 over the file's UTF-8 bytes with EVERY `\r`
//! removed, and nothing else changed (no trimming, trailing newline kept as
//! is). `.gitattributes` is `* text=auto eol=crlf`, so a checkout has CRLF on
//! this machine; both sides hash the same CR-free bytes. Change it only
//! together with WS2.
//!
//! The runner applies exactly the CR-stripped text it hashed (fed to psql on
//! stdin, never re-read), each migration in ONE transaction together with its
//! bookkeeping row in `orgtree_custodian.applied_migrations`, so a run killed
//! at any point resumes at the first unapplied migration.
//!
//! Refusals (each has a test): a `.sql` file missing from the manifest; a
//! manifest entry with no file; a duplicate version; a gap in the numbering;
//! a checksum mismatch; applied history that differs from the manifest or has
//! a hole; a database that has migrations the manifest does not know; a
//! pending migration whose `min_writer` is above the deployed writer version.

use crate::error::{CustodianError, Result};
use orgtree_op_receipt_codec::sha256::{hex, sha256};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const MANIFEST_FILE: &str = "SHA256SUMS";
pub const MIN_WRITER_HEADER: &str = "-- orgtree:min_writer=";
pub const BOOKKEEPING: &str = "orgtree_custodian.applied_migrations";

/// The shared normalization: remove every CR, change nothing else.
pub fn normalized(text: &str) -> String {
    text.replace('\r', "")
}

pub fn checksum(text: &str) -> String {
    hex(&sha256(normalized(text).as_bytes()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MigrationFile {
    pub version: u32,
    pub file: String,
    pub sha256: String,
    pub min_writer: u32,
    /// The CR-stripped text that was hashed and is what gets applied.
    #[serde(skip)]
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Applied {
    pub version: u32,
    pub file: String,
    pub sha256: String,
    pub min_writer: u32,
}

fn refuse(code: &'static str, msg: impl Into<String>) -> CustodianError {
    CustodianError::new(code, msg)
}

/// `NNNN_name.sql` → NNNN. Names are lower-case `[a-z0-9_]`.
pub fn version_of(file: &str) -> Result<u32> {
    let bad = || refuse("migrate.bad_name", format!("{file:?} is not NNNN_name.sql"));
    let stem = file.strip_suffix(".sql").ok_or_else(bad)?;
    let (num, name) = stem.split_once('_').ok_or_else(bad)?;
    if num.len() != 4 || !num.bytes().all(|b| b.is_ascii_digit()) || name.is_empty() {
        return Err(bad());
    }
    if !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
        return Err(bad());
    }
    let v: u32 = num.parse().map_err(|_| bad())?;
    if v == 0 {
        return Err(bad());
    }
    Ok(v)
}

/// Workstream ranges (WS2 1-99, then 100-wide blocks: WS3 100-, WS4 200-,
/// ...). A range's migrations start at its first number and are contiguous.
pub fn range_start(v: u32) -> u32 {
    if v < 100 {
        1
    } else {
        v / 100 * 100
    }
}

/// Numbering rule: starts at 1; each next version is prev+1 inside the same
/// range, or the FIRST number of a later range.
pub fn check_numbering(versions: &[u32]) -> Result<()> {
    let mut prev: Option<u32> = None;
    for &v in versions {
        match prev {
            None if v != 1 => return Err(refuse("migrate.gap", format!("the first migration must be 0001, found {v:04}"))),
            Some(p) if v == p => return Err(refuse("migrate.duplicate_version", format!("version {v:04} appears twice"))),
            Some(p) if !(v == p + 1 && range_start(v) == range_start(p)) && !(v == range_start(v) && range_start(p) < range_start(v)) => {
                return Err(refuse("migrate.gap", format!("{v:04} does not follow {p:04} (contiguous within a range, a new range starts at its first number)")))
            }
            _ => {}
        }
        prev = Some(v);
    }
    Ok(())
}

pub fn parse_manifest(text: &str) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let (h, f) = line
            .split_once("  ")
            .ok_or_else(|| refuse("migrate.bad_manifest", format!("line {}: {line:?} is not '<sha256>  <file>'", i + 1)))?;
        if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(refuse("migrate.bad_manifest", format!("line {}: bad sha256 {h:?}", i + 1)));
        }
        version_of(f)?;
        if out.insert(f.to_string(), h.to_string()).is_some() {
            return Err(refuse("migrate.bad_manifest", format!("{f} listed twice")));
        }
    }
    Ok(out)
}

fn min_writer_of(file: &str, sql: &str) -> Result<u32> {
    match sql.lines().next().and_then(|l| l.strip_prefix(MIN_WRITER_HEADER)) {
        None => Ok(1),
        Some(n) => n
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or_else(|| refuse("migrate.bad_min_writer", format!("{file}: bad header value {n:?}"))),
    }
}

/// Read and verify a schema directory. Every refusal happens here, before
/// any database is touched.
pub fn read_schema_dir(dir: &Path) -> Result<Vec<MigrationFile>> {
    let mpath = dir.join(MANIFEST_FILE);
    let mtext = std::fs::read_to_string(&mpath).map_err(|e| CustodianError::io("migrate.no_manifest", &mpath, e))?;
    let manifest = parse_manifest(&mtext)?;
    let mut on_disk = BTreeSet::new();
    for e in std::fs::read_dir(dir).map_err(|e| CustodianError::io("migrate.read_dir", dir, e))? {
        let name = e.map_err(|e| CustodianError::io("migrate.read_dir", dir, e))?.file_name().to_string_lossy().to_string();
        if name.to_ascii_lowercase().ends_with(".sql") {
            on_disk.insert(name);
        }
    }
    if let Some(f) = on_disk.iter().find(|f| !manifest.contains_key(*f)) {
        return Err(refuse("migrate.unlisted_file", format!("{f} is not in {MANIFEST_FILE}")));
    }
    if let Some(f) = manifest.keys().find(|f| !on_disk.contains(*f)) {
        return Err(refuse("migrate.missing_file", format!("{MANIFEST_FILE} lists {f}, which does not exist")));
    }
    let mut files = Vec::new();
    for (file, want) in &manifest {
        let path = dir.join(file);
        let bytes = std::fs::read(&path).map_err(|e| CustodianError::io("migrate.read", &path, e))?;
        let text = String::from_utf8(bytes).map_err(|_| refuse("migrate.not_utf8", format!("{file} is not UTF-8")))?;
        let sql = normalized(&text);
        let got = hex(&sha256(sql.as_bytes()));
        if &got != want {
            return Err(refuse("migrate.checksum_mismatch", format!("{file}: sha256 {got}, manifest says {want}")));
        }
        files.push(MigrationFile { version: version_of(file)?, file: file.clone(), sha256: got, min_writer: min_writer_of(file, &sql)?, sql });
    }
    files.sort_by_key(|m| m.version);
    check_numbering(&files.iter().map(|m| m.version).collect::<Vec<_>>())?;
    Ok(files)
}

/// What is left to apply, given the database's applied history. Refuses when
/// the history is not exactly a prefix of the manifest, or when a pending
/// migration needs a newer writer than the one deployed.
pub fn plan<'a>(files: &'a [MigrationFile], applied: &[Applied], writer_version: u32) -> Result<Vec<&'a MigrationFile>> {
    let known_max = files.last().map(|m| m.version).unwrap_or(0);
    let mut applied_sorted = applied.to_vec();
    applied_sorted.sort_by_key(|a| a.version);
    for (i, a) in applied_sorted.iter().enumerate() {
        let Some(m) = files.get(i) else {
            return Err(refuse(
                "migrate.database_newer",
                format!("the database has {:04} ({}) but this manifest ends at {known_max:04}", a.version, a.file),
            ));
        };
        if a.version > known_max && !files.iter().any(|m| m.version == a.version) {
            return Err(refuse("migrate.database_newer", format!("the database has {:04}, the manifest ends at {known_max:04}", a.version)));
        }
        if m.version != a.version {
            return Err(refuse(
                "migrate.history_hole",
                format!("applied history is not a prefix of the manifest: expected {:04}, database has {:04}", m.version, a.version),
            ));
        }
        if m.sha256 != a.sha256 || m.file != a.file {
            return Err(refuse(
                "migrate.history_mismatch",
                format!("{:04} was applied as {} sha256 {}, manifest now says {} sha256 {}", a.version, a.file, a.sha256, m.file, m.sha256),
            ));
        }
    }
    let pending: Vec<&MigrationFile> = files[applied_sorted.len()..].iter().collect();
    if let Some(m) = pending.iter().find(|m| m.min_writer > writer_version) {
        return Err(refuse(
            "migrate.writer_too_old",
            format!("{} needs store writer >= {}, deployed writer is {writer_version}", m.file, m.min_writer),
        ));
    }
    Ok(pending)
}

/// A writer may run against the database only if it is at least the highest
/// `min_writer` any applied migration recorded.
pub fn check_writer(applied: &[Applied], writer_version: u32) -> Result<u32> {
    let need = applied.iter().map(|a| a.min_writer).max().unwrap_or(1);
    if writer_version < need {
        return Err(refuse("migrate.writer_too_old", format!("the schema needs store writer >= {need}, this writer is {writer_version}")));
    }
    Ok(need)
}

// ---------------------------------------------------------------- database side

use crate::cluster::{self, PgBin, RuntimeRecord, APP_DB};

// Grants are NOT the runner's business: WS2's migrations grant per table
// (0008_grants.sql), because which tables are append-only or retained is a
// schema decision.

const ADVISORY_KEY: i64 = 0x0726_3031; // "migrate", arbitrary but fixed

const BOOKKEEPING_DDL: &str = "CREATE SCHEMA IF NOT EXISTS orgtree_custodian;\n\
REVOKE ALL ON SCHEMA orgtree_custodian FROM PUBLIC;\n\
CREATE TABLE IF NOT EXISTS orgtree_custodian.applied_migrations (\n\
    version     integer     NOT NULL PRIMARY KEY,\n\
    file        text        NOT NULL,\n\
    sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),\n\
    min_writer  integer     NOT NULL CHECK (min_writer >= 1),\n\
    applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()\n\
);\n";

pub fn read_applied(bin: &PgBin, rt: &RuntimeRecord) -> Result<Vec<Applied>> {
    cluster::psql_stdin(bin, rt, APP_DB, BOOKKEEPING_DDL, true)?;
    let rows = cluster::psql(bin, rt, APP_DB, "select version, file, sha256, min_writer from orgtree_custodian.applied_migrations order by version")?;
    rows.into_iter()
        .map(|r| {
            let bad = || refuse("migrate.bad_bookkeeping", format!("row {r:?}"));
            Ok(Applied {
                version: r.first().and_then(|v| v.parse().ok()).ok_or_else(bad)?,
                file: r.get(1).cloned().ok_or_else(bad)?,
                sha256: r.get(2).cloned().ok_or_else(bad)?,
                min_writer: r.get(3).and_then(|v| v.parse().ok()).ok_or_else(bad)?,
            })
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct MigrateReport {
    pub schema_dir: String,
    pub manifest_versions: Vec<u32>,
    pub already_applied: Vec<u32>,
    pub applied_now: Vec<u32>,
    pub store_incarnation_written: bool,
}

fn sql_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Apply every pending migration, each atomically with its bookkeeping row,
/// then write `store_incarnation` once. Safe to re-run after any failure.
pub fn migrate(bin: &PgBin, rt: &RuntimeRecord, dir: &Path, writer_version: u32) -> Result<MigrateReport> {
    let files = read_schema_dir(dir)?;
    let applied = read_applied(bin, rt)?;
    let pending = plan(&files, &applied, writer_version)?;
    let mut done = Vec::new();
    for m in pending {
        let script = format!(
            "SELECT pg_advisory_xact_lock({ADVISORY_KEY});\n{}\n;\nINSERT INTO {BOOKKEEPING} (version, file, sha256, min_writer) VALUES ({}, {}, {}, {});\n",
            m.sql,
            m.version,
            sql_literal(&m.file),
            sql_literal(&m.sha256),
            m.min_writer
        );
        cluster::psql_stdin(bin, rt, APP_DB, &script, true)
            .map_err(|e| refuse("migrate.apply_failed", format!("{} rolled back: {}", m.file, e.message)))?;
        done.push(m.version);
    }
    let rows = cluster::psql(bin, rt, APP_DB, "select to_regclass('public.store_incarnation') is not null")?;
    let mut wrote = false;
    if rows == vec![vec!["t".to_string()]] {
        let out = cluster::psql(
            bin,
            rt,
            APP_DB,
            "insert into public.store_incarnation (database_id, incarnation) select gen_random_uuid(), gen_random_uuid() \
             where not exists (select 1 from public.store_incarnation) returning 1",
        )?;
        wrote = !out.is_empty();
    }
    Ok(MigrateReport {
        schema_dir: dir.display().to_string(),
        manifest_versions: files.iter().map(|m| m.version).collect(),
        already_applied: applied.iter().map(|a| a.version).collect(),
        applied_now: done,
        store_incarnation_written: wrote,
    })
}
