//! The `legacy-1` receipt fingerprint, `opreceipts.fingerprint`:
//!
//! ```text
//! sha256(_canonical({"tool": tool, "node": node,
//!                    "generation": int(generation), "args": args})
//!        .encode("utf-8")).hexdigest()
//! ```
//!
//! The four member names are fixed ASCII, so their sorted order is always
//! `args`, `generation`, `node`, `tool`; the arguments are sorted
//! recursively by [`crate::canonical`]. A Rust `String` cannot hold a lone
//! surrogate, so the Python `UnicodeEncodeError` for one is outside this
//! crate's domain: the JSON reader refuses such input before it gets here.

use crate::canonical::{py_json_string, write_value};
use crate::sha256::{hex, sha256_with};
use crate::Rules;
use orgtree_backend_codec::json::Value;

/// The exact text that is hashed.
pub fn canonical_call(
    tool: &str,
    node: &str,
    generation: i64,
    args: &Value,
    rules: &Rules,
) -> String {
    let mut out = String::from("{\"args\":");
    write_value(args, rules, &mut out);
    out.push_str(",\"generation\":");
    out.push_str(&generation.to_string());
    out.push_str(",\"node\":");
    out.push_str(&py_json_string(node, rules));
    out.push_str(",\"tool\":");
    out.push_str(&py_json_string(tool, rules));
    out.push('}');
    out
}

/// `opreceipts.fingerprint(tool, node, generation, args)`: 64 lowercase hex
/// characters.
pub fn fingerprint(tool: &str, node: &str, generation: i64, args: &Value) -> String {
    fingerprint_with(tool, node, generation, args, &Rules::LEGACY)
}

pub fn fingerprint_with(
    tool: &str,
    node: &str,
    generation: i64,
    args: &Value,
    rules: &Rules,
) -> String {
    let text = canonical_call(tool, node, generation, args, rules);
    let mut h = hex(&sha256_with(text.as_bytes(), rules.sha256_k));
    h.truncate(rules.fingerprint_hex_len);
    h
}
