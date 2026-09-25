//! Logical backup with a content manifest, and restore under a new
//! incarnation (P03-PLAN WS1; v6 BUNDLED backup/restore).
//!
//! CONSISTENCY UNDER CONCURRENT WRITES. A backup must describe ONE moment.
//! A held session opens a REPEATABLE READ transaction and exports its
//! snapshot; `pg_dump --snapshot` dumps exactly that snapshot, and the content
//! manifest (per-table row count and an order-independent digest) is computed
//! in a second session that imports the same snapshot. So the dump and its
//! manifest agree however many writers run meanwhile, and a restore is
//! verified against the manifest before it is accepted. WS1 unsafe control
//! (d) is the naive alternative: a live copy of the data directory.
//!
//! Restore goes into a fresh, running, EMPTY cluster (its own prototype root),
//! in one transaction, then the content is verified, and only then is
//! `store_incarnation.incarnation` replaced by a new value (database_id is
//! kept): a restored database is a new incarnation of the same database.

use crate::cluster::{self, PgBin, RuntimeRecord, APP_DB};
use crate::error::{CustodianError, Result};
use orgtree_op_receipt_codec::sha256::{hex, sha256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

pub const MANIFEST_SCHEMA: &str = "orgtree.p03.pg-backup/v1";
pub const DUMP_FILE: &str = "orgtree.dump";
pub const MANIFEST_FILE: &str = "backup-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableContent {
    pub rows: u64,
    /// md5 over the table's rows as text, sorted: independent of physical order.
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackupManifest {
    pub schema: String,
    pub source_root_id: String,
    pub source_system_identifier: String,
    pub engine_version: String,
    pub snapshot: String,
    pub created_at_unix: u64,
    pub dump_file: String,
    pub dump_sha256: String,
    pub dump_bytes: u64,
    /// `schema.table` -> content, at the snapshot.
    pub tables: BTreeMap<String, TableContent>,
    /// (database_id, incarnation) at the snapshot, when the schema has it.
    pub store_incarnation: Option<(String, String)>,
}

const TABLES_SQL: &str = "select schemaname || '.' || tablename from pg_tables \
where schemaname not in ('pg_catalog', 'information_schema') order by 1";

fn quote_ident_path(t: &str) -> String {
    t.split('.').map(|p| format!("\"{}\"", p.replace('"', "\"\""))).collect::<Vec<_>>().join(".")
}

/// The content query for a set of tables, as one statement.
fn content_sql(tables: &[String]) -> String {
    if tables.is_empty() {
        return "select 'none', 0, ''".into();
    }
    tables
        .iter()
        .map(|t| {
            let q = quote_ident_path(t);
            format!(
                "select '{}', count(*), coalesce(md5(string_agg(r::text, E'\\n' order by r::text)), '') from {q} r",
                t.replace('\'', "''")
            )
        })
        .collect::<Vec<_>>()
        .join(" union all ")
}

fn parse_content(rows: Vec<Vec<String>>) -> Result<BTreeMap<String, TableContent>> {
    let mut out = BTreeMap::new();
    for r in rows {
        if r.len() != 3 || r[0] == "none" {
            continue;
        }
        let rows = r[1].parse().map_err(|_| CustodianError::new("backup.content", format!("bad count {r:?}")))?;
        out.insert(r[0].clone(), TableContent { rows, digest: r[2].clone() });
    }
    Ok(out)
}

/// Content of the database right now (one statement = one snapshot).
pub fn content_now(bin: &PgBin, rt: &RuntimeRecord) -> Result<BTreeMap<String, TableContent>> {
    let tables: Vec<String> = cluster::psql(bin, rt, APP_DB, TABLES_SQL)?.into_iter().filter_map(|r| r.into_iter().next()).collect();
    parse_content(cluster::psql(bin, rt, APP_DB, &content_sql(&tables))?)
}

/// A psql session held open inside one REPEATABLE READ transaction whose
/// snapshot it exported (written to a file by `\o`, so nothing depends on
/// psql flushing a pipe). Dropping it commits and ends the session.
struct HeldSnapshot {
    child: std::process::Child,
    pub id: String,
}

impl HeldSnapshot {
    fn open(bin: &PgBin, rt: &RuntimeRecord, work: &Path) -> Result<Self> {
        let out = work.join("snapshot.id");
        let mut child = cluster::child(&bin.exe("psql"))
            .args(["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-d"])
            .arg(rt.conninfo(APP_DB))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| CustodianError::new("backup.snapshot", e.to_string()))?;
        let script = format!(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n\\o '{}'\nSELECT pg_export_snapshot();\n\\o\n",
            out.display().to_string().replace('\\', "/").replace('\'', "''")
        );
        child
            .stdin
            .as_mut()
            .expect("piped")
            .write_all(script.as_bytes())
            .and_then(|_| child.stdin.as_mut().expect("piped").flush())
            .map_err(|e| CustodianError::new("backup.snapshot", e.to_string()))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(t) = fs::read_to_string(&out) {
                let id = t.trim().to_string();
                if !id.is_empty() {
                    let _ = fs::remove_file(&out);
                    return Ok(Self { child, id });
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(CustodianError::new("backup.snapshot", format!("psql exited ({status}) before exporting a snapshot")));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(CustodianError::new("backup.snapshot", "no snapshot id within 30 s"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for HeldSnapshot {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"COMMIT;\n\\q\n");
        }
        let _ = self.child.wait();
    }
}

fn file_sha256(path: &Path) -> Result<(String, u64)> {
    let bytes = fs::read(path).map_err(|e| CustodianError::io("backup.read", path, e))?;
    Ok((hex(&sha256(&bytes)), bytes.len() as u64))
}

/// Back up the app database into `out` (a NEW folder, outside every
/// protected location). Refuses unless the cluster attaches cleanly.
pub fn backup(root: &crate::guard::PrototypeRoot, bin: &PgBin, out: &Path, env: &crate::guard::Env) -> Result<BackupManifest> {
    crate::guard::check_location(out, env)?;
    if out.exists() {
        return Err(CustodianError::new("backup.exists", format!("{} already exists; a backup goes into a new folder", out.display())));
    }
    let (rt, _) = cluster::attach(root, bin)?;
    fs::create_dir_all(out).map_err(|e| CustodianError::io("backup.mkdir", out, e))?;
    let held = HeldSnapshot::open(bin, &rt, out)?;
    let dump = out.join(DUMP_FILE);
    let dump_log = out.join("pg_dump.log");
    let log = fs::File::create(&dump_log).map_err(|e| CustodianError::io("backup.log", &dump_log, e))?;
    let status = cluster::child(&bin.exe("pg_dump"))
        .args(["-Fc", "--no-password"])
        .arg(format!("--snapshot={}", held.id))
        .arg("-f")
        .arg(&dump)
        .arg("-d")
        .arg(rt.conninfo(APP_DB))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .status()
        .map_err(|e| CustodianError::new("backup.pg_dump", e.to_string()))?;
    if !status.success() {
        return Err(CustodianError::new("backup.pg_dump", format!("{status}; see {}", dump_log.display())));
    }
    // The manifest, in the SAME snapshot as the dump.
    let tables: Vec<String> = cluster::psql(bin, &rt, APP_DB, TABLES_SQL)?.into_iter().filter_map(|r| r.into_iter().next()).collect();
    let script = format!(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '{}';\n{};\nCOMMIT;\n",
        held.id.replace('\'', "''"),
        content_sql(&tables)
    );
    let text = cluster::psql_stdin(bin, &rt, APP_DB, &script, false)?;
    let rows: Vec<Vec<String>> = text.lines().filter(|l| !l.is_empty()).map(|l| l.split('|').map(str::to_string).collect()).collect();
    let content = parse_content(rows)?;
    if content.len() != tables.len() {
        return Err(CustodianError::new("backup.content", format!("manifest has {} tables, the database {}", content.len(), tables.len())));
    }
    let inc = if tables.iter().any(|t| t == "public.store_incarnation") {
        let s = format!(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '{}';\nselect database_id, incarnation from public.store_incarnation;\nCOMMIT;\n",
            held.id.replace('\'', "''")
        );
        cluster::psql_stdin(bin, &rt, APP_DB, &s, false)?
            .lines()
            .find(|l| l.contains('|'))
            .and_then(|l| l.split_once('|'))
            .map(|(a, b)| (a.to_string(), b.to_string()))
    } else {
        None
    };
    let snapshot = held.id.clone();
    drop(held);
    let (dump_sha256, dump_bytes) = file_sha256(&dump)?;
    let manifest = BackupManifest {
        schema: MANIFEST_SCHEMA.into(),
        source_root_id: root.root_id().into(),
        source_system_identifier: rt.system_identifier.clone(),
        engine_version: bin.version.clone(),
        snapshot,
        created_at_unix: crate::now_unix(),
        dump_file: DUMP_FILE.into(),
        dump_sha256,
        dump_bytes,
        tables: content,
        store_incarnation: inc,
    };
    crate::write_json_atomic(&out.join(MANIFEST_FILE), &manifest)?;
    Ok(manifest)
}

#[derive(Debug, Serialize)]
pub struct RestoreReport {
    pub from: PathBuf,
    pub tables_verified: usize,
    pub rows_verified: u64,
    pub old_incarnation: Option<String>,
    pub new_incarnation: Option<String>,
    pub database_id: Option<String>,
}

pub fn read_manifest(from: &Path) -> Result<BackupManifest> {
    let p = from.join(MANIFEST_FILE);
    let t = fs::read_to_string(&p).map_err(|e| CustodianError::io("restore.manifest", &p, e))?;
    let m: BackupManifest = serde_json::from_str(&t).map_err(|e| CustodianError::new("restore.manifest", e.to_string()))?;
    if m.schema != MANIFEST_SCHEMA {
        return Err(CustodianError::new("restore.manifest", format!("schema {:?}", m.schema)));
    }
    Ok(m)
}

/// Compare restored content with the manifest; every difference is named.
pub fn content_differences(want: &BTreeMap<String, TableContent>, got: &BTreeMap<String, TableContent>) -> Vec<String> {
    let mut out = Vec::new();
    for (t, w) in want {
        match got.get(t) {
            None => out.push(format!("{t}: missing after restore")),
            Some(g) if g != w => out.push(format!("{t}: rows {} digest {} != backup rows {} digest {}", g.rows, g.digest, w.rows, w.digest)),
            _ => {}
        }
    }
    for t in got.keys().filter(|t| !want.contains_key(*t)) {
        out.push(format!("{t}: present after restore but not in the backup"));
    }
    out
}

/// Restore `from` into the running, EMPTY cluster of `root`.
pub fn restore(root: &crate::guard::PrototypeRoot, bin: &PgBin, from: &Path) -> Result<RestoreReport> {
    crate::guard::refuse_product(root, "restore")?;
    let manifest = read_manifest(from)?;
    let dump = from.join(&manifest.dump_file);
    let (sha, bytes) = file_sha256(&dump)?;
    if sha != manifest.dump_sha256 || bytes != manifest.dump_bytes {
        return Err(CustodianError::new("restore.dump_mismatch", format!("{} is {sha} ({bytes} bytes); the manifest says {}", dump.display(), manifest.dump_sha256)));
    }
    let (rt, _) = cluster::attach(root, bin)?;
    if rt.system_identifier == manifest.source_system_identifier {
        return Err(CustodianError::new("restore.same_cluster", "restore goes into a NEW cluster, never over its source"));
    }
    let existing = cluster::psql(bin, &rt, APP_DB, TABLES_SQL)?;
    if !existing.is_empty() {
        return Err(CustodianError::new("restore.target_not_empty", format!("the target database has {} tables", existing.len())));
    }
    // Into the (validated) target root's log folder: `--from` is only read.
    let log_path = cluster::Layout::of(root).log.join(format!("pg_restore-{}.log", crate::win::random_hex(3)?));
    let log = fs::File::create(&log_path).map_err(|e| CustodianError::io("restore.log", &log_path, e))?;
    let status = cluster::child(&bin.exe("pg_restore"))
        .args(["--exit-on-error", "--single-transaction", "--no-password", "-d"])
        .arg(rt.conninfo(APP_DB))
        .arg(&dump)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .status()
        .map_err(|e| CustodianError::new("restore.pg_restore", e.to_string()))?;
    if !status.success() {
        return Err(CustodianError::new("restore.pg_restore", format!("{status}; see {}", log_path.display())));
    }
    let got = content_now(bin, &rt)?;
    let diffs = content_differences(&manifest.tables, &got);
    if !diffs.is_empty() {
        return Err(CustodianError::new("restore.content_mismatch", diffs.join("; ")));
    }
    let (old, new, dbid) = if manifest.store_incarnation.is_some() {
        let rows = cluster::psql(
            bin,
            &rt,
            APP_DB,
            "update public.store_incarnation set incarnation = gen_random_uuid() returning database_id, incarnation",
        )?;
        let r = rows.into_iter().next().unwrap_or_default();
        (manifest.store_incarnation.as_ref().map(|i| i.1.clone()), r.get(1).cloned(), r.first().cloned())
    } else {
        (None, None, None)
    };
    if let (Some(o), Some(n)) = (&old, &new) {
        if o == n {
            return Err(CustodianError::new("restore.incarnation", "the incarnation did not change"));
        }
    }
    Ok(RestoreReport {
        from: from.to_path_buf(),
        tables_verified: manifest.tables.len(),
        rows_verified: manifest.tables.values().map(|t| t.rows).sum(),
        old_incarnation: old,
        new_incarnation: new,
        database_id: dbid,
    })
}
