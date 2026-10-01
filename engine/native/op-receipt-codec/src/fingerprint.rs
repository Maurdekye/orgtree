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
use crate::pyint::PyInt;
use crate::sha256::{hex, sha256_with};
use crate::{PyException, PyOutcome, Rules};
use orgtree_backend_codec::json::Value;

/// The exact text that is hashed.
///
/// The generation is an exact integer of any width. `json.dumps` renders it
/// with `int.__repr__`, which raises `ValueError` beyond Python's 4300-digit
/// string-conversion limit. The arguments cannot hit that limit: the JSON
/// reader refuses such an integer before it gets here, as `json.loads` does.
pub fn canonical_call(
    tool: &str,
    node: &str,
    generation: &PyInt,
    args: &Value,
    rules: &Rules,
) -> PyOutcome<String> {
    if generation.digit_count() > rules.int_str_max_digits {
        return PyOutcome::Raises(PyException::ValueError);
    }
    let mut out = String::from("{\"args\":");
    write_value(args, rules, &mut out);
    out.push_str(",\"generation\":");
    out.push_str(&generation.to_string());
    out.push_str(",\"node\":");
    out.push_str(&py_json_string(node, rules));
    out.push_str(",\"tool\":");
    out.push_str(&py_json_string(tool, rules));
    out.push('}');
    PyOutcome::Value(out)
}

/// `opreceipts.fingerprint(tool, node, generation, args)`: 64 lowercase hex
/// characters, or the `ValueError` Python raises for a generation too long
/// to render.
pub fn fingerprint(tool: &str, node: &str, generation: &PyInt, args: &Value) -> PyOutcome<String> {
    fingerprint_with(tool, node, generation, args, &Rules::LEGACY)
}

pub fn fingerprint_with(
    tool: &str,
    node: &str,
    generation: &PyInt,
    args: &Value,
    rules: &Rules,
) -> PyOutcome<String> {
    if rules.i64_ints && generation.to_i64().is_none() {
        return PyOutcome::OutsideParityDomain("integer beyond i64");
    }
    let text = tri!(canonical_call(tool, node, generation, args, rules));
    let mut h = hex(&sha256_with(text.as_bytes(), rules.sha256_k));
    h.truncate(rules.fingerprint_hex_len);
    PyOutcome::Value(h)
}
