//! DECLARED-CONTACTS builders for island families (CONTRACT-M1 §5 r4; WS7
//! `oracle.py` shape, same as WS5's `mail::declared`):
//! `"<family>.<verb>": { relations: { "<rel>": { modes, required } }, p01_contract, source }`.
//!
//! `required: true` marks the design's mandatory anchors, locks and claims
//! (C3 anchors, C2a version bumps, the P8 head lock, the E7 claim, and
//! `restriction_epoch FOR SHARE` for narrowing writers). A relation touched
//! only on some branches is `required: false`, or the verb is split into
//! variants. Unsafe-control paths are NOT declared: a control run that
//! touches an undeclared relation is supposed to look wrong.

use serde_json::{json, Map, Value};

pub const R: &[&str] = &["read"];
pub const RW: &[&str] = &["read", "write"];
pub const W: &[&str] = &["write"];
pub const SHARE: &[&str] = &["read", "for_share"];
pub const LOCK_W: &[&str] = &["read", "for_no_key_update", "write"];
pub const SHARE_LOCK_W: &[&str] = &["read", "for_share", "for_no_key_update", "write"];

pub fn rel(modes: &[&str], required: bool) -> Value {
    json!({"modes": modes, "required": required})
}

/// The executor's own generic step: the receipt claim (E7), always required.
pub fn receipts() -> (&'static str, Value) {
    ("operation_receipts", rel(RW, true))
}

pub fn entry(rels: Vec<(&'static str, Value)>, p01: Option<&str>, source: &str) -> Value {
    let mut m = Map::new();
    for (k, v) in rels {
        m.insert(k.to_string(), v);
    }
    json!({"relations": Value::Object(m), "p01_contract": p01, "source": source})
}

/// Merge several `"<family>.<verb>" → spec` maps (WS3a's staffing table and
/// WS3b's lifecycle table) into the one the harness handshake reports.
pub fn merge(tables: Vec<Value>) -> Value {
    let mut m = Map::new();
    for t in tables {
        if let Value::Object(o) = t {
            for (k, v) in o {
                assert!(!m.contains_key(&k), "declared twice: {k}");
                m.insert(k, v);
            }
        }
    }
    Value::Object(m)
}
