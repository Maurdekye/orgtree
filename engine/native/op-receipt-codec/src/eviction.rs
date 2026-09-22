//! What `opreceipts.append(d, row)` does to the receipt metadata and log
//! length, as a pure plan. Nothing is written; the caller applies the plan.
//!
//! Python, in order:
//!
//! ```text
//! m = d.get(META)  (a fresh meta with from_ms 0 and seq 0 when None)
//! m["seq"] = int(m.get("seq") or 0) + 1
//! log = d.setdefault(SECTION, []); log.append(row)
//! if len(log) > CEILING:
//!     cut = len(log) - TRIM_TO
//!     hi = max(int(r.get("mint_ms") or 0) for r in log[:cut])
//!     m["from_ms"] = max(int(m.get("from_ms") or 0), hi + 1)
//!     m["evicted"] = int(m.get("evicted") or 0) + cut
//!     d[SECTION] = log[cut:]
//! ```
//!
//! The watermark moves past the largest mint time evicted, not the newest
//! row's, and never decreases: forgetting always costs a refusal, never a
//! duplicate.

use crate::admission::{member, receipt_rows};
use crate::key::{narrow, py_int_or_zero_with};
use crate::pyint::PyInt;
use crate::{PyOutcome, Rules, META};
use orgtree_backend_codec::json::{Object, Value};
use orgtree_backend_codec::presence::Presence;

/// The effect of one `append`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendPlan {
    /// `append` creates the meta because `d.get(META)` was `None`.
    pub created_meta: bool,
    /// The new `meta["seq"]`.
    pub seq: PyInt,
    /// Rows in the log after the append and any trim.
    pub len_after: usize,
    /// Oldest rows removed by the trim (0 when none).
    pub cut: usize,
    /// `watermark(d)` after the append.
    pub watermark_after: PyInt,
    /// The new `meta["evicted"]`, set only when a trim ran.
    pub evicted_total: Option<PyInt>,
}

/// Plan `append(d, row)` for the org document `doc`. The appended row's
/// content does not affect the plan: it is never among the evicted rows.
pub fn plan_append(doc: &Object) -> PyOutcome<AppendPlan> {
    plan_append_with(doc, &Rules::LEGACY)
}

pub fn plan_append_with(doc: &Object, rules: &Rules) -> PyOutcome<AppendPlan> {
    let (meta, created_meta) = match doc.get(META) {
        Presence::Absent | Presence::Null => (None, true),
        Presence::Present(Value::Object(o)) => (Some(o), false),
        Presence::Present(_) => {
            return PyOutcome::OutsideParityDomain("receipt meta is not a dict")
        }
    };
    let one = PyInt::from(1i64);
    let old_seq = tri!(py_int_or_zero_with(member(meta, "seq"), rules));
    let seq = tri!(narrow(old_seq.add(&one), rules));
    let rows = tri!(receipt_rows(doc));
    let len = rows.len() + 1;
    let over = if rules.ceiling_inclusive {
        len >= rules.ceiling
    } else {
        len > rules.ceiling
    };
    if !over {
        let watermark_after = tri!(py_int_or_zero_with(member(meta, "from_ms"), rules));
        return PyOutcome::Value(AppendPlan {
            created_meta,
            seq,
            len_after: len,
            cut: 0,
            watermark_after,
            evicted_total: None,
        });
    }
    let cut = len - rules.trim_to;
    let mut mints = Vec::with_capacity(cut);
    for row in &rows[..cut] {
        mints.push(tri!(py_int_or_zero_with(row.get("mint_ms"), rules)));
    }
    let hi = if rules.watermark_from_last_evicted {
        mints.pop()
    } else {
        mints.into_iter().max()
    }
    .unwrap_or_default();
    let old_from = tri!(py_int_or_zero_with(member(meta, "from_ms"), rules));
    let next = tri!(narrow(hi.add(&one), rules));
    let from_ms = if rules.monotonic_watermark {
        old_from.max(next)
    } else {
        next
    };
    let old_evicted = tri!(py_int_or_zero_with(member(meta, "evicted"), rules));
    let evicted_total = tri!(narrow(old_evicted.add(&PyInt::from(cut)), rules));
    PyOutcome::Value(AppendPlan {
        created_meta,
        seq,
        len_after: len - cut,
        cut,
        watermark_after: from_ms,
        evicted_total: Some(evicted_total),
    })
}
