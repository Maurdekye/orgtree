//! The P03 prototype PostgreSQL schema (`engine/native/store/CONTRACT-M1.md` §7).
//!
//! Ordered SQL migrations are embedded as text. The WS1 runner applies
//! [`MIGRATIONS`] in order as the admin role and checks each checksum against
//! [`MANIFEST`]; the runtime role gets DML only. A landed migration is
//! immutable: its checksum is pinned in `migrations/SHA256SUMS`, and a test
//! fails if the file changes.
//!
//! This crate has no driver and runs no SQL. [`lint`] is a static checker for
//! the conventions of CONTRACT-M1 §2; it parses only the subset of DDL these
//! files use and is not a SQL parser. Proving the DDL is accepted by
//! PostgreSQL needs a WS1 dev cluster.

pub mod lint;

/// One migration file.
#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub file: &'static str,
    pub sql: &'static str,
    /// The minimum store-writer version that understands the schema once this
    /// migration is applied (recorded by the WS1 runner).
    pub min_writer: u32,
}

macro_rules! migration {
    ($v:expr, $name:expr, $file:expr) => {
        Migration {
            version: $v,
            name: $name,
            file: $file,
            sql: include_str!(concat!("../migrations/", $file)),
            min_writer: 1,
        }
    };
}

/// Every migration, ascending. WS2 owns 0001-0099 (CONTRACT-M1 §7).
pub const MIGRATIONS: &[Migration] = &[
    migration!(1, "core", "0001_core.sql"),
    migration!(2, "funding", "0002_funding.sql"),
    migration!(3, "work", "0003_work.sql"),
    migration!(4, "reservations", "0004_reservations.sql"),
    migration!(5, "mail", "0005_mail.sql"),
    migration!(6, "requests_charters_runtime", "0006_requests_charters_runtime.sql"),
    migration!(7, "publication", "0007_publication.sql"),
];

/// Migration number ranges per workstream, so parallel branches never collide.
pub const RANGES: &[(&str, u32, u32)] = &[
    ("WS2", 1, 99),
    ("WS3", 100, 199),
    ("WS4", 200, 299),
    ("WS5", 300, 399),
    ("WS6", 400, 499),
    ("WS7", 500, 599),
];

/// The pinned checksums (`<sha256 hex>  <file>` per line, LF-normalized content).
pub const MANIFEST: &str = include_str!("../migrations/SHA256SUMS");

/// Tables that are not organization-scoped (no `org_id`).
pub const INSTALLATION_TABLES: &[&str] = &["store_incarnation", "service_incarnations", "publication_catalog"];

/// Tables WS6 may publish (CONTRACT-M1 §7). `operation_receipts` is published
/// with [`RECEIPT_PUBLISHED_COLUMNS`] only.
pub const PUBLISHED: &[&str] = &[
    "organizations", "org_controls", "agents", "agent_names", "authority_epoch",
    "topology_edges", "scope_rows", "runtime_state", "audience_grants",
    "operation_receipts",
    "catalog_current", "price_catalog", "issuer_capacity", "funding_edges", "kiosk_pool",
    "work_items", "work_item_versions", "work_participants", "active_work_names",
    "resource_reservations",
    "mailboxes", "mail_sent", "mail_pair_highwater", "mailbox_messages",
    "outgoing_intents", "transport_intents",
    "request_batches", "charter_heads", "charter_versions", "runtime_claims", "folder_move_intents",
];

/// Tables never published (CONTRACT-M1 §7).
pub const EXCLUDED: &[&str] = &[
    "store_incarnation", "service_incarnations", "runtime_inflight",
    "read_service_registrations", "restrictions", "restriction_obligations",
    "legacy_work_names", "publication_catalog",
];

/// The safe identifier columns of `operation_receipts` (never `result` or
/// `fingerprint`), CONTRACT-M1 §3.7/§7.
pub const RECEIPT_PUBLISHED_COLUMNS: &[&str] = &[
    "org_id", "ns_kind", "ns_id", "op_key", "receipt_id", "family", "verb", "state", "decided_at",
];

/// Content with CR removed, so the checksum does not depend on the checkout's
/// line endings (`.gitattributes` is `* text=auto eol=crlf`).
pub fn normalized(sql: &str) -> String {
    sql.replace('\r', "")
}

pub fn sha256_hex(sql: &str) -> String {
    use orgtree_op_receipt_codec::sha256::{hex, sha256};
    hex(&sha256(normalized(sql).as_bytes()))
}

/// The manifest the current files would produce.
pub fn computed_manifest() -> String {
    let mut out = String::new();
    for m in MIGRATIONS {
        out.push_str(&sha256_hex(m.sql));
        out.push_str("  ");
        out.push_str(m.file);
        out.push('\n');
    }
    out
}

/// The whole schema, parsed for linting.
pub fn schema() -> lint::Schema {
    let mut s = lint::Schema::default();
    for m in MIGRATIONS {
        s.add(m.file, m.sql);
    }
    s
}
