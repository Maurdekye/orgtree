//! Non-authoritative Rust backend codec foundation.
//!
//! This crate holds pure value codecs for the later Rust backend: a JSON
//! reader that keeps absent and `null` apart, exact 0.01-grid credit amounts,
//! identity and name namespaces, and the agent-credential payload. Every
//! Python-facing function is checked against vectors that a Python oracle
//! produces by calling the current backend functions themselves
//! (`oracle/generate_vectors.py`).
//!
//! It deliberately has no listener, no storage, no clock, no entropy, no
//! signing key and no domain writes. It does not reconstruct the Python `Org`
//! object, and passing its tests is not evidence that any query, command or
//! runtime phase has been ported. Where current source and the v6
//! architecture do not settle a question, the case is listed in
//! [`UNRESOLVED`] instead of being decided here.

pub mod credential;
pub mod credits;
pub mod identity;
pub mod json;
pub mod presence;
pub mod vectors;

/// A Python exception class that current code raises for an input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PyException {
    TypeError,
    ValueError,
    OverflowError,
    /// `orgtree.ledger.LedgerError`, the product's own refusal.
    LedgerError,
}

impl PyException {
    pub fn as_str(self) -> &'static str {
        match self {
            PyException::TypeError => "TypeError",
            PyException::ValueError => "ValueError",
            PyException::OverflowError => "OverflowError",
            PyException::LedgerError => "LedgerError",
        }
    }
}

/// The outcome of reproducing one Python expression.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PyOutcome<T> {
    Value(T),
    Raises(PyException),
    /// Python has a defined answer here, but this crate does not reproduce
    /// it. The reason names what is missing.
    OutsideParityDomain(&'static str),
}

/// A question that current source and the v6 architecture do not settle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unresolved {
    pub id: &'static str,
    pub summary: &'static str,
}

/// Every open question this crate found. Nothing here is decided by the
/// crate; each needs an owner's ruling before a production door uses it.
pub const UNRESOLVED: &[Unresolved] = &[
    Unresolved {
        id: "U-JSON-1",
        summary: "Python json.loads accepts unpaired UTF-16 surrogate escapes; Rust strings cannot hold them. Both profiles here refuse them.",
    },
    Unresolved {
        id: "U-JSON-2",
        summary: "Current doors accept duplicate member names (last value wins) and NaN/Infinity/-Infinity. v6 requires canonical codecs but no ruling says whether new doors refuse these; only the Strict profile refuses them.",
    },
    Unresolved {
        id: "U-JSON-3",
        summary: "Python json.loads(bytes) detects UTF-16/32 and uses surrogatepass UTF-8; this crate reads UTF-8 text only and reports such bytes as outside parity.",
    },
    Unresolved {
        id: "U-AMT-1",
        summary: "Python rounds sub-0.01 amounts with round(x, 2); v6 requires exact values. Whether a future door refuses or rounds sub-grid input is not ruled. parse_exact refuses; py_round2 reproduces rounding.",
    },
    Unresolved {
        id: "U-AMT-2",
        summary: "Python credit floats can be negative zero (round(-0.001, 2) is -0.0). The exact type has no signed zero; py_round2 reports it separately.",
    },
    Unresolved {
        id: "U-AMT-3",
        summary: "v6 asks for language-neutral exact credit encodings but fixes no wire lexeme. Python writes int or float JSON (4 versus 4.0) depending on history. Only Python-compatible characterizations are provided.",
    },
    Unresolved {
        id: "U-AMT-4",
        summary: "Org.hire accepts true/false and integral floats such as 3.0 as grants and stores int(grant) (true becomes 1); NaN and +Infinity raise ValueError/OverflowError instead of the product refusal.",
    },
    Unresolved {
        id: "U-GEN-1",
        summary: "An absent node generation is read as 0 but a null one raises TypeError at the API door; booleans and fractions are coerced by int(). Strict decoding keeps absent and null apart and leaves the default to the caller.",
    },
    Unresolved {
        id: "U-ID-1",
        summary: "agentauth.verify accepts a negative generation that child_env would never write. The canonical decoder refuses it; the legacy reproduction accepts it.",
    },
    Unresolved {
        id: "U-ID-2",
        summary: "agentauth.verify decodes base64 non-strictly (unknown characters dropped, + / = accepted, unused bits ignored). Only alphabet-only payloads are reproduced.",
    },
    Unresolved {
        id: "U-ID-3",
        summary: "Imported legacy node ids, org slugs and work names are not guaranteed to be slugify fixed points; AgentKey/OrgKey parsing is for new canonical keys, and legacy import preflight is separate work.",
    },
    Unresolved {
        id: "U-NAME-1",
        summary: "Title-prefix derivation is pinned to Python 3.13.15 lowercase data (Unicode 15.1.0). A different interpreter or Unicode version is a behavior change that the vectors will flag.",
    },
];
