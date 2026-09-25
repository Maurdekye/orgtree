//! Pure checks of the migration set. No database.

use std::collections::BTreeSet;

use orgtree_store_schema::lint::{lint, Schema};
use orgtree_store_schema::{
    computed_manifest, pinned_manifest, range_schema, schema, EXCLUDED, INSTALLATION_TABLES, MIGRATIONS, PUBLISHED,
    RANGES, RANGE_DEFS, RECEIPT_PUBLISHED_COLUMNS,
};

#[test]
fn every_migration_is_named_ascending_and_in_exactly_one_range() {
    assert!(!RANGE_DEFS.is_empty() && RANGE_DEFS.len() == RANGES.len());
    let mut prev = 0;
    for m in MIGRATIONS {
        assert!(m.version > prev, "{} not ascending (duplicate number?)", m.file);
        assert_eq!(m.file, format!("{:04}_{}.sql", m.version, m.name));
        assert!(!m.sql.trim().is_empty());
        let owners: Vec<&str> = RANGE_DEFS.iter().filter(|r| r.contains(m.version)).map(|r| r.name).collect();
        assert_eq!(owners.len(), 1, "{} is owned by {:?}: every migration needs exactly one range file", m.file, owners);
        prev = m.version;
    }
    // ranges do not overlap
    for (i, a) in RANGE_DEFS.iter().enumerate() {
        for b in &RANGE_DEFS[i + 1..] {
            assert!(a.last < b.first || b.last < a.first, "{} and {} overlap", a.name, b.name);
        }
    }
    // the WS2 base is where it always was
    let ws2 = RANGE_DEFS.iter().find(|r| r.name == "WS2").expect("the WS2 range file is missing");
    assert_eq!((ws2.first, ws2.last), (1, 99));
    assert!(ws2.migrations().count() >= 8);
}

#[test]
fn landed_migrations_match_their_pinned_checksums() {
    // Immutability, per range: a landed migration's file never changes. A NEW
    // migration adds a line to ITS range's .sha256 (`schema-manifest <range>`
    // prints it); an edited one fails here.
    for r in RANGE_DEFS {
        assert_eq!(r.computed_manifest(), r.manifest.replace('\r', ""), "range {} ({})", r.name, r.file);
    }
    assert_eq!(computed_manifest(), pinned_manifest());
}

#[test]
fn each_range_declares_exactly_the_tables_its_migrations_create() {
    let mut total = 0;
    for r in RANGE_DEFS {
        let created: BTreeSet<String> = range_schema(r).tables.iter().map(|t| t.name.clone()).collect();
        let declared: BTreeSet<String> = r.tables.iter().map(|t| t.to_string()).collect();
        assert_eq!(declared.len(), r.tables.len(), "range {} declares a table twice", r.name);
        assert_eq!(created, declared, "range {}: declared tables must equal the tables its DDL creates", r.name);
        total += created.len();
    }
    // no table is created twice across ranges, and nothing is undeclared
    let all = schema();
    assert_eq!(all.tables.len(), total, "a table is created by two ranges or outside any range");
    // non-vacuity: the parser found the WS2 base
    assert!(total >= 39, "parsed only {total} tables: the check did not run");
}

#[test]
fn checksum_ignores_line_endings_only() {
    let m = &MIGRATIONS[0];
    let crlf = m.sql.replace('\r', "").replace('\n', "\r\n");
    assert_eq!(orgtree_store_schema::sha256_hex(&crlf), orgtree_store_schema::sha256_hex(m.sql));
    let changed = format!("{} ", m.sql);
    assert_ne!(orgtree_store_schema::sha256_hex(&changed), orgtree_store_schema::sha256_hex(m.sql));
}

#[test]
fn the_real_schema_parses_fully_and_passes_every_lint() {
    let s = schema();
    assert!(s.tables.len() >= 39, "tables parsed: {:?}", s.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    for t in &s.tables {
        assert!(!t.columns.is_empty(), "{} parsed with no columns", t.name);
        assert!(!t.constraints.is_empty(), "{} parsed with no constraints", t.name);
    }
    assert!(s.indexes.len() >= 20, "indexes parsed: {}", s.indexes.len());
    // F2/F3 pins: the removed foreign keys stay removed
    let names: BTreeSet<String> = s.object_names().into_iter().map(|(_, n)| n).collect();
    for gone in ["operation_receipts_org_fk", "runtime_inflight_org_fk", "mail_sent_org_fk",
                 "outgoing_intents_org_fk", "mail_sent_dest_mailbox_fk", "restrictions_epoch"] {
        assert!(!names.contains(gone), "{gone} must not exist (lead rulings F1-F3)");
    }
    let findings = lint(&s);
    assert!(findings.is_empty(), "{:#?}", findings);
}

#[test]
fn publication_lists_partition_the_tables() {
    let s = schema();
    let tables: BTreeSet<&str> = s.tables.iter().map(|t| t.name.as_str()).collect();
    let published: BTreeSet<&str> = PUBLISHED.iter().copied().collect();
    let excluded: BTreeSet<&str> = EXCLUDED.iter().copied().collect();
    assert_eq!(published.len(), PUBLISHED.len(), "duplicate in PUBLISHED");
    assert_eq!(excluded.len(), EXCLUDED.len(), "duplicate in EXCLUDED");
    assert!(published.is_disjoint(&excluded));
    let union: BTreeSet<&str> = published.union(&excluded).copied().collect();
    assert_eq!(union, tables, "every table is either published or excluded");
    for t in INSTALLATION_TABLES {
        assert!(excluded.contains(t), "installation table {t} must be excluded");
    }
    // receipts publish only safe identifier columns, and those columns exist
    let r = s.table("operation_receipts").unwrap();
    for c in RECEIPT_PUBLISHED_COLUMNS {
        assert!(r.columns.iter().any(|x| x.name == *c), "operation_receipts has no column {c}");
    }
    assert!(!RECEIPT_PUBLISHED_COLUMNS.contains(&"result"));
    assert!(!RECEIPT_PUBLISHED_COLUMNS.contains(&"fingerprint"));
}

#[test]
fn contract_constraint_names_exist() {
    // Names CONTRACT-M1 §3.4/§7 promise to consumers.
    let names: BTreeSet<String> = schema().object_names().into_iter().map(|(_, n)| n).collect();
    for n in [
        "operation_receipts_original_key",
        "resource_reservations_held_resource",
        "resource_reservations_integration_key",
        "audience_grants_key",
        "mailbox_messages_original",
        "mail_sent_pair_seq",
        "agent_names_active",
        "request_batches_one_pending",
        "folder_move_intents_one_pending",
    ] {
        assert!(names.contains(n), "missing {n}");
    }
}

// ---- negative controls: each rule must fire on a fixture built to break it.
// Each control asserts the exact rule fired, so a rule that silently stops
// working fails here rather than letting the real-schema test pass vacuously.

fn findings_for(sql: &str) -> Vec<&'static str> {
    let mut s = Schema::default();
    s.add("fixture.sql", sql);
    assert!(!s.tables.is_empty(), "control fixture parsed no table: the control did not run");
    lint(&s).into_iter().map(|f| f.rule).collect()
}

const GOOD: &str = "CREATE TABLE t ( org_id uuid NOT NULL, name text COLLATE \"C\" NOT NULL, \
                    amount_centi bigint NOT NULL, CONSTRAINT t_pk PRIMARY KEY (org_id, name), \
                    CONSTRAINT t_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id) );";

#[test]
fn control_good_fixture_is_clean() {
    assert_eq!(findings_for(GOOD), Vec::<&str>::new());
}

#[test]
fn control_r1_missing_org_id() {
    let bad = "CREATE TABLE t ( id uuid NOT NULL, CONSTRAINT t_pk PRIMARY KEY (id) );";
    let f = findings_for(bad);
    assert!(f.contains(&"R1-org-id"), "{f:?}");
}

#[test]
fn control_r2_identity_text_without_collation() {
    let bad = GOOD.replace("name text COLLATE \"C\" NOT NULL", "name text NOT NULL");
    assert_eq!(findings_for(&bad), vec!["R2-collate-c"]);
}

#[test]
fn control_r3_credits_not_bigint() {
    let bad = GOOD.replace("amount_centi bigint", "amount_centi numeric(20,2)");
    let f = findings_for(&bad);
    assert!(f.contains(&"R3-credits"), "{f:?}");
}

#[test]
fn control_r4_unprefixed_constraint() {
    let bad = GOOD.replace("CONSTRAINT t_pk", "CONSTRAINT pk_t");
    assert_eq!(findings_for(&bad), vec!["R4-prefix"]);
}

#[test]
fn control_r5_duplicate_name() {
    let bad = format!("{GOOD} CREATE INDEX t_pk ON t (name);");
    assert_eq!(findings_for(&bad), vec!["R5-unique-name"]);
}

#[test]
fn control_r6_fk_without_org_id() {
    let bad = GOOD.replace(
        "CONSTRAINT t_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id)",
        "CONSTRAINT t_agent_fk FOREIGN KEY (name) REFERENCES agents (name)",
    );
    assert_eq!(findings_for(&bad), vec!["R6-org-fk"]);
}

#[test]
fn control_r7_unnamed_inline_constraint() {
    let bad = GOOD.replace("amount_centi bigint NOT NULL", "amount_centi bigint NOT NULL CHECK (amount_centi >= 0)");
    assert_eq!(findings_for(&bad), vec!["R7-named"]);
}

#[test]
fn control_r9_high_rate_table_references_org_row() {
    let bad = "CREATE TABLE mail_sent ( org_id uuid NOT NULL, message_id uuid NOT NULL, \
               CONSTRAINT mail_sent_pk PRIMARY KEY (org_id, message_id), \
               CONSTRAINT mail_sent_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id) );";
    assert_eq!(findings_for(bad), vec!["R9-hot-fk"]);
}

#[test]
fn control_r10_source_side_references_receiver_head() {
    let bad = "CREATE TABLE mail_sent ( org_id uuid NOT NULL, message_id uuid NOT NULL, dest_mailbox_id uuid NULL, \
               CONSTRAINT mail_sent_pk PRIMARY KEY (org_id, message_id), \
               CONSTRAINT mail_sent_dest_fk FOREIGN KEY (org_id, dest_mailbox_id) REFERENCES mailboxes (org_id, mailbox_id) );";
    assert_eq!(findings_for(bad), vec!["R10-head-fk"]);
}

/// Every function and trigger in the migrations is declared for WS7's
/// statement/relation map (lead note N1), and nothing declared is missing.
#[test]
fn server_side_statements_are_declared() {
    use orgtree_store_schema::lint::{split_statements, strip_comments};
    use orgtree_store_schema::DECLARED_SERVER_SIDE;
    let mut found = BTreeSet::new();
    for m in MIGRATIONS {
        for stmt in split_statements(&strip_comments(m.sql)) {
            let w: Vec<&str> = stmt.split_whitespace().collect();
            let up: Vec<String> = w.iter().map(|x| x.to_ascii_uppercase()).collect();
            if up.len() > 2 && up[0] == "CREATE" && up[1] == "FUNCTION" {
                found.insert(format!("function {}", w[2].split('(').next().unwrap()));
            } else if up.len() > 2 && up[0] == "CREATE" && up[1] == "TRIGGER" {
                found.insert(format!("trigger {}", w[2]));
            } else if up.len() > 3 && up[0] == "CREATE" && up[1] == "CONSTRAINT" && up[2] == "TRIGGER" {
                found.insert(format!("trigger {}", w[3]));
            }
        }
    }
    assert!(found.len() >= 3, "parsed too few server-side objects: {found:?}");
    let declared: BTreeSet<String> = DECLARED_SERVER_SIDE.iter().map(|d| d.0.to_string()).collect();
    // the trigger FUNCTION is covered by its trigger's declaration
    let found: BTreeSet<String> = found.into_iter().filter(|f| f != "function operation_receipts_refuse_claimed").collect();
    assert_eq!(found, declared);
}

#[test]
fn control_comment_and_dollar_bodies_do_not_hide_tables() {
    let sql = format!(
        "-- CREATE TABLE ghost ( x int );\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n{GOOD}"
    );
    let mut s = Schema::default();
    s.add("fixture.sql", &sql);
    assert_eq!(s.tables.len(), 1);
    assert_eq!(s.tables[0].name, "t");
}

// ---- runner compatibility (WS1 applies each file in ONE transaction)

#[test]
fn migrations_carry_no_transaction_control_or_concurrent_index() {
    use orgtree_store_schema::lint::{split_statements, strip_comments};
    for m in MIGRATIONS {
        for stmt in split_statements(&strip_comments(m.sql)) {
            let up = stmt.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
            for bad in ["BEGIN", "COMMIT", "ROLLBACK", "START TRANSACTION", "SAVEPOINT"] {
                assert!(!(up == bad || up.starts_with(&format!("{bad} ")) || up.starts_with(&format!("{bad};"))), "{}: {stmt}", m.file);
            }
            assert!(!up.contains("CONCURRENTLY"), "{}: {stmt}", m.file);
        }
    }
}

#[test]
fn min_writer_header_is_read_from_the_first_line_only() {
    use orgtree_store_schema::header_min_writer;
    assert_eq!(header_min_writer("-- orgtree:min_writer=3\nCREATE TABLE t ();"), 3);
    assert_eq!(header_min_writer("-- orgtree:min_writer=3\r\nCREATE TABLE t ();"), 3);
    assert_eq!(header_min_writer("CREATE TABLE t ();\n-- orgtree:min_writer=3"), 1);
    assert_eq!(header_min_writer("-- something else"), 1);
    for m in MIGRATIONS {
        assert_eq!(m.min_writer(), 1, "{}", m.file);
    }
}

// ---- grants (0008): every table has a deliberate runtime grant, the
// replication role reads exactly the published set, receipts only through
// their safe columns, and retained tables have no DELETE.

fn grants() -> Vec<(String, Vec<String>, String)> {
    use orgtree_store_schema::lint::{split_statements, strip_comments};
    let mut out = Vec::new();
    for m in MIGRATIONS {
        for stmt in split_statements(&strip_comments(m.sql)) {
            let s = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
            let Some(rest) = s.strip_prefix("GRANT ") else { continue };
            let (privs, rest) = rest.split_once(" ON ").unwrap();
            let (objs, to) = rest.rsplit_once(" TO ").unwrap();
            if objs.starts_with("SCHEMA ") {
                continue;
            }
            let objs: Vec<String> = objs.split(',').map(|o| o.trim().to_string()).collect();
            out.push((privs.to_string(), objs, to.to_string()));
        }
    }
    assert!(out.len() >= 5, "parsed only {} grants: the check did not run", out.len());
    out
}

#[test]
fn every_table_has_a_runtime_grant_and_retained_tables_have_no_delete() {
    let s = schema();
    let g = grants();
    let runtime: Vec<&(String, Vec<String>, String)> = g.iter().filter(|x| x.2.contains("orgtree_runtime")).collect();
    for t in &s.tables {
        let mine: Vec<&String> = runtime.iter().filter(|x| x.1.iter().any(|o| o == &t.name)).map(|x| &x.0).collect();
        assert_eq!(mine.len(), 1, "{} needs exactly one runtime grant, has {:?}", t.name, mine);
        let has_delete = mine[0].contains("DELETE");
        let retained = ["operation_receipts", "restrictions", "work_item_versions", "charter_versions", "price_catalog",
                        "mail_sent", "store_incarnation", "legacy_work_names", "publication_catalog"];
        assert_eq!(has_delete, !retained.contains(&t.name.as_str()), "{}: DELETE granted = {has_delete}", t.name);
        if t.name == "store_incarnation" {
            assert_eq!(mine[0], "SELECT", "only the custodian writes store_incarnation");
        }
    }
}

#[test]
fn the_replication_role_reads_exactly_the_published_set() {
    let g = grants();
    let mut tables: BTreeSet<String> = BTreeSet::new();
    let mut receipt_cols: Option<String> = None;
    for (privs, objs, to) in g.iter().filter(|x| x.2.contains("orgtree_repl")) {
        let _ = to;
        if privs.starts_with("SELECT (") {
            assert_eq!(objs, &vec!["operation_receipts".to_string()]);
            receipt_cols = Some(privs.clone());
        } else {
            assert_eq!(privs, "SELECT");
            tables.extend(objs.iter().cloned());
        }
    }
    let want: BTreeSet<String> = PUBLISHED.iter().filter(|t| **t != "operation_receipts").map(|t| t.to_string()).collect();
    assert_eq!(tables, want);
    let cols = receipt_cols.expect("no column grant on operation_receipts");
    let inner = cols.trim_start_matches("SELECT (").trim_end_matches(')');
    let got: Vec<&str> = inner.split(',').map(str::trim).collect();
    assert_eq!(got, RECEIPT_PUBLISHED_COLUMNS);
}
