//! Migration runner: every refusal the lead's ruling lists, without a
//! database (schema directories are synthetic fixtures in a temp folder).

use orgtree_pg_custodian::migrate::{self, Applied, MigrationFile};
use std::path::PathBuf;

struct Dir(PathBuf);

impl Dir {
    /// Files as given; SHA256SUMS computed from each file's CR-stripped text
    /// unless `manifest` overrides it.
    fn new(files: &[(&str, &str)], manifest: Option<&str>) -> Self {
        let p = std::env::temp_dir().join(format!("orgtree-p03-migrate-{}", orgtree_pg_custodian::win::random_hex(6).unwrap()));
        std::fs::create_dir_all(&p).unwrap();
        let mut m = String::new();
        for (name, body) in files {
            std::fs::write(p.join(name), body).unwrap();
            m.push_str(&format!("{}  {name}\n", migrate::checksum(body)));
        }
        std::fs::write(p.join(migrate::MANIFEST_FILE), manifest.unwrap_or(&m)).unwrap();
        Self(p)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn code<T: std::fmt::Debug>(r: orgtree_pg_custodian::Result<T>) -> &'static str {
    r.expect_err("expected a refusal").code
}

const A: &str = "CREATE TABLE a (x int);\n";
const B: &str = "CREATE TABLE b (x int);\n";

#[test]
fn crlf_and_lf_checkouts_hash_identically() {
    // WS2's rule: remove every CR, nothing else.
    assert_eq!(migrate::checksum("x\r\ny\r\n"), migrate::checksum("x\ny\n"));
    assert_ne!(migrate::checksum("x\ny\n"), migrate::checksum("x\ny"), "the trailing newline is part of the hash");
    // A manifest computed on LF text accepts a CRLF checkout, and the text
    // kept for applying is the CR-free one.
    let lf = Dir::new(&[("0001_a.sql", "CREATE TABLE a (x int);\n")], None);
    let manifest = std::fs::read_to_string(lf.0.join("SHA256SUMS")).unwrap().replace('\n', "\r\n");
    let crlf = Dir::new(&[("0001_a.sql", "CREATE TABLE a (x int);\r\n")], Some(&manifest));
    let files = migrate::read_schema_dir(&crlf.0).unwrap();
    assert_eq!(files[0].sql, "CREATE TABLE a (x int);\n");
}

#[test]
fn a_good_directory_reads_in_order_with_min_writer() {
    let d = Dir::new(&[("0002_b.sql", B), ("0001_a.sql", A), ("0003_c.sql", "-- orgtree:min_writer=3\nSELECT 1;\n")], None);
    let f = migrate::read_schema_dir(&d.0).unwrap();
    assert_eq!(f.iter().map(|m| m.version).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(f.iter().map(|m| m.min_writer).collect::<Vec<_>>(), vec![1, 1, 3]);
}

#[test]
fn a_file_missing_from_the_manifest_is_refused() {
    let d = Dir::new(&[("0001_a.sql", A)], None);
    std::fs::write(d.0.join("0002_b.sql"), B).unwrap();
    assert_eq!(code(migrate::read_schema_dir(&d.0)), "migrate.unlisted_file");
}

#[test]
fn a_manifest_entry_without_a_file_is_refused() {
    let d = Dir::new(&[("0001_a.sql", A), ("0002_b.sql", B)], None);
    std::fs::remove_file(d.0.join("0002_b.sql")).unwrap();
    assert_eq!(code(migrate::read_schema_dir(&d.0)), "migrate.missing_file");
}

#[test]
fn a_checksum_mismatch_is_refused() {
    let d = Dir::new(&[("0001_a.sql", A)], None);
    std::fs::write(d.0.join("0001_a.sql"), "CREATE TABLE a (x bigint);\n").unwrap();
    assert_eq!(code(migrate::read_schema_dir(&d.0)), "migrate.checksum_mismatch");
}

#[test]
fn gaps_and_duplicates_are_refused() {
    assert_eq!(code(migrate::read_schema_dir(&Dir::new(&[("0001_a.sql", A), ("0003_b.sql", B)], None).0)), "migrate.gap");
    assert_eq!(code(migrate::read_schema_dir(&Dir::new(&[("0002_a.sql", A)], None).0)), "migrate.gap");
    assert_eq!(code(migrate::read_schema_dir(&Dir::new(&[("0001_a.sql", A), ("0001_b.sql", B)], None).0)), "migrate.duplicate_version");
    // A new workstream range starts at its first number...
    migrate::check_numbering(&[1, 2, 3, 100, 101, 200]).unwrap();
    // ...and nowhere else.
    assert_eq!(migrate::check_numbering(&[1, 2, 101]).unwrap_err().code, "migrate.gap");
    assert_eq!(migrate::check_numbering(&[1, 100, 102]).unwrap_err().code, "migrate.gap");
    assert_eq!(migrate::check_numbering(&[1, 200, 100]).unwrap_err().code, "migrate.gap");
}

#[test]
fn malformed_names_and_manifests_are_refused() {
    for bad in ["1_a.sql", "0001.sql", "0001_A.sql", "0000_a.sql", "0001_a.txt", "0001_a-b.sql"] {
        assert_eq!(migrate::version_of(bad).unwrap_err().code, "migrate.bad_name", "{bad}");
    }
    assert_eq!(code(migrate::parse_manifest("abc  0001_a.sql\n")), "migrate.bad_manifest");
    assert_eq!(code(migrate::parse_manifest(&format!("{} 0001_a.sql\n", "a".repeat(64)))), "migrate.bad_manifest");
    let twice = format!("{h}  0001_a.sql\n{h}  0001_a.sql\n", h = "a".repeat(64));
    assert_eq!(code(migrate::parse_manifest(&twice)), "migrate.bad_manifest");
    let d = Dir::new(&[("0001_a.sql", "-- orgtree:min_writer=0\nSELECT 1;\n")], None);
    assert_eq!(code(migrate::read_schema_dir(&d.0)), "migrate.bad_min_writer");
}

/// WS2's real migrations verify under our rule (no database needed):
/// ORGTREE_P03_SCHEMA_DIR = a CRLF or LF checkout of store-schema/migrations.
#[test]
#[ignore = "needs ORGTREE_P03_SCHEMA_DIR (WS2's migrations folder)"]
fn the_real_ws2_schema_dir_verifies() {
    let dir = PathBuf::from(std::env::var_os("ORGTREE_P03_SCHEMA_DIR").expect("ORGTREE_P03_SCHEMA_DIR"));
    let f = migrate::read_schema_dir(&dir).unwrap();
    assert!(!f.is_empty());
    println!("verified {} migrations: {:?}", f.len(), f.iter().map(|m| (m.version, m.min_writer)).collect::<Vec<_>>());
}

fn files(spec: &[(u32, u32)]) -> Vec<MigrationFile> {
    spec.iter()
        .map(|&(v, mw)| MigrationFile { version: v, file: format!("{v:04}_m.sql"), sha256: format!("{v:064}"), min_writer: mw, sql: String::new() })
        .collect()
}

fn applied(fs: &[MigrationFile]) -> Vec<Applied> {
    fs.iter().map(|m| Applied { version: m.version, file: m.file.clone(), sha256: m.sha256.clone(), min_writer: m.min_writer }).collect()
}

#[test]
fn plan_resumes_after_the_applied_prefix() {
    let f = files(&[(1, 1), (2, 1), (3, 1)]);
    let p = migrate::plan(&f, &applied(&f[..2]), 1).unwrap();
    assert_eq!(p.iter().map(|m| m.version).collect::<Vec<_>>(), vec![3]);
    assert!(migrate::plan(&f, &applied(&f), 1).unwrap().is_empty());
    assert_eq!(migrate::plan(&f, &[], 1).unwrap().len(), 3);
}

#[test]
fn a_changed_applied_migration_is_refused() {
    let f = files(&[(1, 1), (2, 1)]);
    let mut a = applied(&f[..1]);
    a[0].sha256 = "f".repeat(64);
    assert_eq!(code(migrate::plan(&f, &a, 1)), "migrate.history_mismatch");
}

#[test]
fn a_database_newer_than_the_manifest_is_refused() {
    let f = files(&[(1, 1), (2, 1), (3, 1)]);
    assert_eq!(code(migrate::plan(&f[..2], &applied(&f), 1)), "migrate.database_newer");
}

#[test]
fn a_hole_in_applied_history_is_refused() {
    let f = files(&[(1, 1), (2, 1), (3, 1)]);
    let a = vec![applied(&f)[0].clone(), applied(&f)[2].clone()];
    assert_eq!(code(migrate::plan(&f, &a, 1)), "migrate.history_hole");
}

#[test]
fn min_writer_rules() {
    let f = files(&[(1, 1), (2, 3)]);
    // Migrating past what the deployed writer understands is refused.
    assert_eq!(code(migrate::plan(&f, &applied(&f[..1]), 2)), "migrate.writer_too_old");
    assert_eq!(migrate::plan(&f, &applied(&f[..1]), 3).unwrap().len(), 1);
    // A writer older than the applied schema's highest min_writer is refused.
    assert_eq!(code(migrate::check_writer(&applied(&f), 2)), "migrate.writer_too_old");
    assert_eq!(migrate::check_writer(&applied(&f), 3).unwrap(), 3);
    assert_eq!(migrate::check_writer(&[], 1).unwrap(), 1);
}
