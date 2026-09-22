//! Reading receipt rows and deciding what a keyed call means:
//! `opreceipts.find`, `fp_node`, `matches`, `classify`, `watermark`,
//! `schema_ahead` and `admit`, as pure functions over a document decoded by
//! `json.loads`.
//!
//! The document is the org document object. Its `op_receipts` member must be
//! absent or an array of objects, and its `op_receipts_meta` member absent,
//! falsy or an object; any other shape is outside the parity domain
//! (`U-RCPT-5`). The custody epoch is the caller's: `epoch_ok` is required
//! and has no default, as in Python.

use crate::fingerprint::fingerprint_with;
use crate::key::{parse_key_with, py_int_or_zero_with, py_str_or, py_truthy};
use crate::pyint::PyInt;
use crate::{PyException, PyOutcome, Rules, COVERAGE, META, SCHEMA, SECTION};
use orgtree_backend_codec::json::{Object, Value};
use orgtree_backend_codec::presence::Presence;

/// `classify`'s answer about a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    /// No row (`""`).
    None,
    /// The row under this key identifies a different call.
    Conflict,
    Applied,
    Fenced,
}

impl RowState {
    pub fn as_str(self) -> &'static str {
        match self {
            RowState::None => "",
            RowState::Conflict => "conflict",
            RowState::Applied => "applied",
            RowState::Fenced => "fenced",
        }
    }
}

/// `admit`'s decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Admit,
    Replay,
    Conflict,
    Refuse,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Admit => "admit",
            Decision::Replay => "replay",
            Decision::Conflict => "conflict",
            Decision::Refuse => "refuse",
        }
    }
}

/// The machine-readable part of `admit`'s `(decision, info)`. The human
/// `detail` text is not reproduced (`U-RCPT-6`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admission {
    pub decision: Decision,
    /// `info["reason"]`, absent for `replay` and `admit`.
    pub reason: Option<&'static str>,
    /// Index into the receipt rows of `info["row"]`; `None` when the info
    /// carries no row or carries `None`.
    pub row: Option<usize>,
    /// `info["row_state"]` when present.
    pub row_state: Option<RowState>,
    /// `info["mint_ms"]`, present only for `admit`.
    pub mint_ms: Option<i64>,
}

impl Admission {
    fn refuse(reason: &'static str) -> Admission {
        Admission {
            decision: Decision::Refuse,
            reason: Some(reason),
            row: None,
            row_state: None,
            mint_ms: None,
        }
    }
}

/// `_log(d, create=False)`: the receipt rows, oldest first.
pub fn receipt_rows(doc: &Object) -> PyOutcome<Vec<&Object>> {
    match doc.get(SECTION) {
        Presence::Absent => PyOutcome::Value(Vec::new()),
        Presence::Present(Value::Array(items)) => {
            let mut rows = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::Object(o) => rows.push(o),
                    _ => return PyOutcome::OutsideParityDomain("receipt row is not an object"),
                }
            }
            PyOutcome::Value(rows)
        }
        _ => PyOutcome::OutsideParityDomain("receipt section is not a list"),
    }
}

/// `d.get(META) or {}`: `None` stands for the empty dict.
pub fn receipt_meta(doc: &Object) -> PyOutcome<Option<&Object>> {
    match doc.get(META) {
        Presence::Present(v) if py_truthy(v) => match v {
            Value::Object(o) => PyOutcome::Value(Some(o)),
            _ => PyOutcome::OutsideParityDomain("receipt meta is not a dict"),
        },
        _ => PyOutcome::Value(None),
    }
}

pub(crate) fn member<'a>(o: Option<&'a Object>, key: &str) -> Presence<&'a Value> {
    match o {
        Some(o) => o.get(key),
        None => Presence::Absent,
    }
}

fn is_str(p: Presence<&Value>, s: &str) -> bool {
    matches!(p, Presence::Present(Value::String(v)) if v == s)
}

/// `watermark(d)`: `int(meta.get("from_ms") or 0)`, exact at any width.
pub fn watermark(doc: &Object) -> PyOutcome<PyInt> {
    watermark_with(doc, &Rules::LEGACY)
}

pub fn watermark_with(doc: &Object, rules: &Rules) -> PyOutcome<PyInt> {
    let meta = tri!(receipt_meta(doc));
    py_int_or_zero_with(member(meta, "from_ms"), rules)
}

/// `schema_ahead(d) != ""`: rows written by a newer receipts build.
pub fn schema_ahead(doc: &Object) -> PyOutcome<bool> {
    schema_ahead_with(doc, &Rules::LEGACY)
}

pub fn schema_ahead_with(doc: &Object, rules: &Rules) -> PyOutcome<bool> {
    let meta = tri!(receipt_meta(doc));
    if tri!(py_int_or_zero_with(member(meta, "schema"), rules)) > PyInt::from(SCHEMA) {
        return PyOutcome::Value(true);
    }
    let coverage = tri!(py_int_or_zero_with(member(meta, "coverage"), rules));
    PyOutcome::Value(coverage > PyInt::from(COVERAGE))
}

fn find_in(
    rows: &[&Object],
    node: &str,
    key: &str,
    generation: Option<&PyInt>,
    rules: &Rules,
) -> PyOutcome<Option<usize>> {
    let order: Box<dyn Iterator<Item = usize>> = if rules.find_newest_first {
        Box::new((0..rows.len()).rev())
    } else {
        Box::new(0..rows.len())
    };
    for i in order {
        let row = rows[i];
        if !(is_str(row.get("key"), key) && is_str(row.get("node"), node)) {
            continue;
        }
        if let Some(g) = generation {
            if &tri!(py_int_or_zero_with(row.get("gen"), rules)) != g {
                continue;
            }
        }
        return PyOutcome::Value(Some(i));
    }
    PyOutcome::Value(None)
}

/// `find(d, node, key)`: the index of the newest row filed under this key
/// and node. Generation is not a matcher.
pub fn find(doc: &Object, node: &str, key: &str) -> PyOutcome<Option<usize>> {
    let rows = tri!(receipt_rows(doc));
    find_in(&rows, node, key, None, &Rules::LEGACY)
}

/// `fp_node(row)`: `str(row.get("fp_node") or row.get("node") or "")`.
pub fn fp_node(row: &Object) -> PyOutcome<String> {
    py_str_or(row.get("fp_node"), row.get("node"))
}

fn matches_in(
    row: &Object,
    tool: &str,
    args: &Value,
    caller_node: &str,
    rules: &Rules,
) -> PyOutcome<bool> {
    let subject = if rules.fp_node_from_row {
        tri!(fp_node(row))
    } else {
        caller_node.to_owned()
    };
    let generation = tri!(py_int_or_zero_with(row.get("gen"), rules));
    let fp = tri!(fingerprint_with(tool, &subject, &generation, args, rules));
    PyOutcome::Value(is_str(row.get("tool"), tool) && is_str(row.get("fp"), &fp))
}

/// `matches(row, tool, args)`: tool and full fingerprint, computed at the
/// row's own subject and generation.
pub fn matches(row: &Object, tool: &str, args: &Value) -> PyOutcome<bool> {
    matches_in(row, tool, args, "", &Rules::LEGACY)
}

fn classify_in(
    row: Option<&Object>,
    tool: &str,
    args: &Value,
    caller_node: &str,
    rules: &Rules,
) -> PyOutcome<RowState> {
    let Some(row) = row else {
        return PyOutcome::Value(RowState::None);
    };
    if !tri!(matches_in(row, tool, args, caller_node, rules)) {
        return PyOutcome::Value(RowState::Conflict);
    }
    PyOutcome::Value(if is_str(row.get("outcome"), "fenced") {
        RowState::Fenced
    } else {
        RowState::Applied
    })
}

/// `classify(row, tool, args)`.
pub fn classify(row: Option<&Object>, tool: &str, args: &Value) -> PyOutcome<RowState> {
    classify_in(row, tool, args, "", &Rules::LEGACY)
}

/// Whether Python's `a / 1000` overflows a float for an `int` `a >= 0`.
///
/// `admit` formats a refused key's age as `f"{(mint - ms) / 1000:.0f}"`.
/// Integer true division is correctly rounded and raises `OverflowError`
/// when the rounded quotient would exceed the largest float, that is when
/// `a >= 1000 * (f64::MAX + 2^970)` (half an ulp above `f64::MAX`; the tie
/// rounds away because `f64::MAX` has an odd significand).
fn age_text_overflows(a: &PyInt) -> bool {
    let max = PyInt::from_f64_trunc(f64::MAX).unwrap_or_default();
    let half_ulp = PyInt::from_f64_trunc(2f64.powi(970)).unwrap_or_default();
    *a >= max.add(&half_ulp).mul_u32(1000)
}

/// The inputs of one `admit` call. `now_ms` and `epoch_ok` are the caller's
/// clock reading and custody proof; this crate has neither. `generation` and
/// `now_ms` are Python `int`s, exact at any width, as `admit`'s
/// `int(generation)` and `int(now_ms)` are.
#[derive(Clone, Debug)]
pub struct AdmitCall<'a> {
    pub node: &'a str,
    pub generation: PyInt,
    pub key: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
    pub now_ms: PyInt,
    pub epoch_ok: bool,
}

/// `admit(d, node, generation, key, tool, args, now_ms, epoch_ok=...)`.
pub fn admit(doc: &Object, call: &AdmitCall<'_>) -> PyOutcome<Admission> {
    admit_with(doc, call, &Rules::LEGACY)
}

/// `admit` under the given rules. The branch order is Python's:
/// malformed key, stale epoch, future key, stale key, existing row
/// (conflict, fenced, foreign generation, replay), newer schema, evicted
/// horizon, admit.
pub fn admit_with(doc: &Object, call: &AdmitCall<'_>, rules: &Rules) -> PyOutcome<Admission> {
    let ms = tri!(crate::key::narrow(call.now_ms.clone(), rules));
    let Some(mint) = parse_key_with(call.key, rules) else {
        return PyOutcome::Value(Admission::refuse("malformed_key"));
    };
    let generation = tri!(crate::key::narrow(call.generation.clone(), rules));
    let row_filter = if rules.generation_matches_in_find {
        Some(&generation)
    } else {
        None
    };
    let (node, tool, args) = (call.node, call.tool, call.args);
    if !call.epoch_ok {
        let rows = tri!(receipt_rows(doc));
        let prior = tri!(find_in(&rows, node, call.key, row_filter, rules));
        let state = tri!(classify_in(prior.map(|i| rows[i]), tool, args, node, rules));
        return PyOutcome::Value(Admission {
            row: prior,
            row_state: Some(state),
            ..Admission::refuse("stale_epoch")
        });
    }
    let m = PyInt::from(mint);
    let ahead = ms.add(&PyInt::from(rules.skew_ms));
    let future = if rules.future_inclusive {
        m >= ahead
    } else {
        m > ahead
    };
    if future {
        if rules.detail_raises && age_text_overflows(&m.sub(&ms)) {
            return PyOutcome::Raises(PyException::OverflowError);
        }
        return PyOutcome::Value(Admission::refuse("key_from_the_future"));
    }
    let age = ms.sub(&m);
    let horizon = PyInt::from(rules.horizon_ms);
    let stale = if rules.stale_inclusive {
        age >= horizon
    } else {
        age > horizon
    };
    if stale {
        if rules.detail_raises && age_text_overflows(&age) {
            return PyOutcome::Raises(PyException::OverflowError);
        }
        return PyOutcome::Value(Admission::refuse("key_stale"));
    }
    if rules.schema_before_row && tri!(schema_ahead_with(doc, rules)) {
        return PyOutcome::Value(Admission::refuse("schema_ahead"));
    }
    let rows = tri!(receipt_rows(doc));
    if let Some(i) = tri!(find_in(&rows, node, call.key, row_filter, rules)) {
        let row = rows[i];
        let state = tri!(classify_in(Some(row), tool, args, node, rules));
        let found = |decision, reason| Admission {
            decision,
            reason,
            row: Some(i),
            row_state: Some(state),
            mint_ms: None,
        };
        if state == RowState::Conflict {
            return PyOutcome::Value(Admission {
                row_state: None,
                ..found(Decision::Conflict, Some("key_reused"))
            });
        }
        let foreign = tri!(py_int_or_zero_with(row.get("gen"), rules)) != generation;
        if rules.foreign_before_fenced && foreign {
            return PyOutcome::Value(found(Decision::Refuse, Some("foreign_generation")));
        }
        if state == RowState::Fenced {
            return PyOutcome::Value(found(Decision::Refuse, Some("fenced")));
        }
        if foreign {
            // The detail text formats the caller's `generation` with
            // `str()`, which raises past Python's digit limit.
            if rules.detail_raises && generation.digit_count() > rules.int_str_max_digits {
                return PyOutcome::Raises(PyException::ValueError);
            }
            return PyOutcome::Value(found(Decision::Refuse, Some("foreign_generation")));
        }
        return PyOutcome::Value(Admission {
            row_state: None,
            ..found(Decision::Replay, None)
        });
    }
    if !rules.schema_before_row && tri!(schema_ahead_with(doc, rules)) {
        return PyOutcome::Value(Admission::refuse("schema_ahead"));
    }
    let wm = tri!(watermark_with(doc, rules));
    let evicted = if rules.watermark_inclusive {
        m <= wm
    } else {
        m < wm
    };
    if evicted {
        return PyOutcome::Value(Admission::refuse("horizon_evicted"));
    }
    PyOutcome::Value(Admission {
        decision: Decision::Admit,
        reason: None,
        row: None,
        row_state: None,
        mint_ms: Some(mint),
    })
}

/// `find` under the given rules (for the vector runner and its controls).
pub fn find_with(doc: &Object, node: &str, key: &str, rules: &Rules) -> PyOutcome<Option<usize>> {
    let rows = tri!(receipt_rows(doc));
    find_in(&rows, node, key, None, rules)
}

/// `classify` under the given rules. `caller_node` is used only by the
/// control that fingerprints at the caller's node instead of `fp_node`.
pub fn classify_with(
    row: Option<&Object>,
    tool: &str,
    args: &Value,
    caller_node: &str,
    rules: &Rules,
) -> PyOutcome<RowState> {
    classify_in(row, tool, args, caller_node, rules)
}
