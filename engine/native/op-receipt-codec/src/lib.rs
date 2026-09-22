//! Non-authoritative Rust compatibility codec for the legacy operation
//! receipts in `engine/backend/orgtree/opreceipts.py`.
//!
//! It reproduces, as pure functions, the parts of that module that decide
//! what a keyed agent call means:
//!
//! * [`key::parse_key`]: the `<mint_ms>-<24 hex>` key grammar, with Python
//!   `re` string semantics;
//! * [`fingerprint::fingerprint`]: the `legacy-1` full SHA-256 over the
//!   canonical call identity;
//! * [`admission`]: `find`, `fp_node`, `matches`, `classify`,
//!   `schema_ahead`, `watermark` and the `admit` decision with its exact
//!   branch order and refusal reasons;
//! * [`eviction::plan_append`]: the append counter, trim rule and monotonic
//!   eviction watermark.
//!
//! Every function is checked against vectors that a Python oracle produces
//! by calling the real `opreceipts` functions (`oracle/generate_vectors.py`).
//!
//! It has no listener, storage, SQL, clock, entropy, custody epoch, witness,
//! coverage table, lookup API or effect. The caller supplies `now_ms` and
//! `epoch_ok`. Its input domain is arguments after the API's own
//! normalization. Passing its tests is not evidence that command receipts,
//! PostgreSQL storage or any runtime phase has been ported; the open
//! questions are listed in [`UNRESOLVED`].

/// Unwrap a [`PyOutcome`] value, or return its exception or parity-domain
/// refusal unchanged, the way a Python exception propagates.
macro_rules! tri {
    ($e:expr) => {
        match $e {
            $crate::PyOutcome::Value(v) => v,
            $crate::PyOutcome::Raises(x) => return $crate::PyOutcome::Raises(x),
            $crate::PyOutcome::OutsideParityDomain(r) => {
                return $crate::PyOutcome::OutsideParityDomain(r)
            }
        }
    };
}

pub mod admission;
pub mod canonical;
pub mod eviction;
pub mod fingerprint;
pub mod key;
pub mod sha256;
pub mod vectors;

pub use orgtree_backend_codec::{PyException, PyOutcome};

/// `opreceipts.SCHEMA`: the receipt row shape this build understands.
pub const SCHEMA: i64 = 1;
/// `opreceipts.COVERAGE`: the coverage table revision this build understands.
pub const COVERAGE: i64 = 1;
/// `opreceipts.HORIZON_MS`: a key older than this is refused.
pub const HORIZON_MS: i64 = 900_000;
/// `opreceipts.SKEW_MS`: a key minted further ahead than this is refused.
pub const SKEW_MS: i64 = 60_000;
/// `opreceipts.CEILING`: rows retained before an eviction runs.
pub const CEILING: usize = 500;
/// `opreceipts.TRIM_TO`: rows an eviction leaves behind.
pub const TRIM_TO: usize = 400;
/// `opreceipts.SECTION`: the document member holding the receipt rows.
pub const SECTION: &str = "op_receipts";
/// `opreceipts.META`: the document member holding the receipt metadata.
pub const META: &str = "op_receipts_meta";
/// The name of the only fingerprint codec this crate implements.
pub const FINGERPRINT_CODEC: &str = "legacy-1";

/// The decisions the vectors exercise, gathered in one place.
///
/// [`Rules::LEGACY`] is the current Python behavior and is what every public
/// function uses. The other fields exist so that the negative controls in
/// `tests/controls.rs` can change exactly one decision and show that the
/// unchanged Python vectors detect it. Production callers never build a
/// `Rules` of their own.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    /// `\d` matches every Unicode decimal digit, as Python's `re` does for
    /// `str` patterns.
    pub key_unicode_digits: bool,
    /// `$` also matches just before one final `\n`.
    pub key_final_newline: bool,
    /// `json.dumps(..., ensure_ascii=False)`: non-ASCII text stays raw.
    pub ensure_ascii: bool,
    /// Sort object keys by UTF-16 code units instead of code points.
    pub utf16_key_order: bool,
    /// Render floats with Python `repr` rather than Rust `Display`.
    pub python_float_repr: bool,
    /// Hex characters of the digest kept as the fingerprint (64 = full).
    pub fingerprint_hex_len: usize,
    /// Treat the row generation as part of `find`'s match.
    pub generation_matches_in_find: bool,
    /// `find` returns the newest matching row.
    pub find_newest_first: bool,
    /// `matches` fingerprints at the row's own `fp_node`, not the caller's node.
    pub fp_node_from_row: bool,
    pub skew_ms: i64,
    pub horizon_ms: i64,
    /// Refuse a key exactly `skew_ms` ahead (Python refuses only beyond it).
    pub future_inclusive: bool,
    /// Refuse a key exactly `horizon_ms` old (Python refuses only beyond it).
    pub stale_inclusive: bool,
    /// Refuse a key minted exactly at the watermark (Python admits it).
    pub watermark_inclusive: bool,
    /// Check `schema_ahead` before looking for an existing row.
    pub schema_before_row: bool,
    /// Check the foreign generation before the fenced outcome.
    pub foreign_before_fenced: bool,
    pub ceiling: usize,
    pub trim_to: usize,
    /// Trim when the log reaches the ceiling rather than exceeds it.
    pub ceiling_inclusive: bool,
    /// Take the watermark from the last evicted row instead of the largest
    /// evicted mint time.
    pub watermark_from_last_evicted: bool,
    /// Never lower an already raised watermark.
    pub monotonic_watermark: bool,
    /// SHA-256 round constants.
    pub sha256_k: &'static [u32; 64],
}

impl Rules {
    pub const LEGACY: Rules = Rules {
        key_unicode_digits: true,
        key_final_newline: true,
        ensure_ascii: false,
        utf16_key_order: false,
        python_float_repr: true,
        fingerprint_hex_len: 64,
        generation_matches_in_find: false,
        find_newest_first: true,
        fp_node_from_row: true,
        skew_ms: SKEW_MS,
        horizon_ms: HORIZON_MS,
        future_inclusive: false,
        stale_inclusive: false,
        watermark_inclusive: false,
        schema_before_row: false,
        foreign_before_fenced: false,
        ceiling: CEILING,
        trim_to: TRIM_TO,
        ceiling_inclusive: false,
        watermark_from_last_evicted: false,
        monotonic_watermark: true,
        sha256_k: &sha256::K,
    };
}

/// A question that current source and the v6 architecture do not settle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unresolved {
    pub id: &'static str,
    pub summary: &'static str,
}

/// Every open question this crate found. None is decided here.
pub const UNRESOLVED: &[Unresolved] = &[
    Unresolved {
        id: "U-RCPT-1",
        summary: "v6 requires a versioned, language-neutral receipt codec, but defines no v3-native version; only legacy-1 is implemented",
    },
    Unresolved {
        id: "U-RCPT-2",
        summary: "whether cutover imports retained receipts or relies on boot epoch rotation to fence them is not decided",
    },
    Unresolved {
        id: "U-RCPT-3",
        summary: "input domain is arguments after API/pydantic normalization; raw request normalization is not reproduced",
    },
    Unresolved {
        id: "U-RCPT-4",
        summary: "lone surrogates (Python fails to UTF-8 encode) and non-JSON values (json.dumps default=str) are outside the parity domain",
    },
    Unresolved {
        id: "U-RCPT-5",
        summary: "malformed legacy documents (non-list section, non-object rows or meta, non-empty containers in str() positions) are outside the parity domain",
    },
    Unresolved {
        id: "U-RCPT-6",
        summary: "the human-readable refusal detail text is not reproduced; decisions, reasons and row identity are",
    },
];
