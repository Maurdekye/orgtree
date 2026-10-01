//! Absent versus null, kept apart.
//!
//! Python code at the current doors often writes `d.get(k, default)`, which
//! treats an absent member and a present `null` differently: the default
//! applies only when the member is absent. This module never offers a helper
//! that silently merges the two cases.

use crate::json::{Object, Value};
use crate::{PyException, PyOutcome};

/// A member that is absent, present as `null`, or present with a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence<T> {
    Absent,
    Null,
    Present(T),
}

impl<T> Presence<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Presence::Absent)
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Presence::Null)
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Presence<U> {
        match self {
            Presence::Absent => Presence::Absent,
            Presence::Null => Presence::Null,
            Presence::Present(v) => Presence::Present(f(v)),
        }
    }

    /// Stable lowercase name used by the vectors.
    pub fn kind(&self) -> &'static str {
        match self {
            Presence::Absent => "absent",
            Presence::Null => "null",
            Presence::Present(_) => "present",
        }
    }
}

/// Why a strict `generation` member was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GenerationError {
    /// The member is present as `null`. Python raises `TypeError` here (see
    /// [`legacy_api_generation`]); strict decoding refuses it.
    Null,
    /// Not a JSON integer literal: a boolean, fraction, exponent, string,
    /// array or object.
    NotInteger,
    Negative,
    /// Larger than `i64::MAX`.
    OutOfRange,
}

impl GenerationError {
    pub fn as_str(self) -> &'static str {
        match self {
            GenerationError::Null => "null",
            GenerationError::NotInteger => "not_integer",
            GenerationError::Negative => "negative",
            GenerationError::OutOfRange => "out_of_range",
        }
    }
}

/// Strictly decode a node record's `generation` member.
///
/// `Ok(None)` means the member is absent. The current Python default for an
/// absent member is 0 (`caller.get("generation", 0)` in api.py, and the same
/// default in agentauth.child_env), but that default is the caller's legacy
/// rule, so it is not applied here. `agentauth.child_env` refuses a negative
/// value or a non-`int` type (`type(g) is not int or g < 0`); this decoder
/// accepts the same set, bounded to `i64`.
pub fn node_generation(obj: &Object) -> Result<Option<u64>, GenerationError> {
    match obj.get("generation") {
        Presence::Absent => Ok(None),
        Presence::Null => Err(GenerationError::Null),
        Presence::Present(Value::Number(n)) if n.is_integer_lexeme() => {
            let s = n.lexeme();
            if let Some(digits) = s.strip_prefix('-') {
                // "-0" is an integer literal equal to zero, which Python
                // accepts as int 0.
                return if digits.bytes().all(|b| b == b'0') { Ok(Some(0)) } else { Err(GenerationError::Negative) };
            }
            match s.parse::<i64>() {
                Ok(v) => Ok(Some(v as u64)),
                Err(_) => Err(GenerationError::OutOfRange),
            }
        }
        Presence::Present(_) => Err(GenerationError::NotInteger),
    }
}

/// What the current Python API door computes for a node's generation:
/// `int(caller.get("generation", 0))` (api.py `_agent_identity`).
///
/// This is characterization only. It reproduces Python's quirks, so that a
/// later port can see them rather than inherit them by accident:
///
/// * absent gives 0, while `null` raises `TypeError` (an HTTP 500 there);
/// * `true`/`false` give 1/0, because `bool` is an `int` subclass;
/// * a fraction is truncated toward zero (`1.9` gives 1, `-0.5` gives 0);
/// * `NaN` raises `ValueError` and an infinity raises `OverflowError`.
///
/// Strings are outside the parity domain: Python's `int(str)` grammar
/// (whitespace, underscores, non-ASCII digits) is not reproduced.
pub fn legacy_api_generation(obj: &Object) -> PyOutcome<i64> {
    match obj.get("generation") {
        Presence::Absent => PyOutcome::Value(0),
        Presence::Null => PyOutcome::Raises(PyException::TypeError),
        Presence::Present(v) => match v {
            Value::Bool(b) => PyOutcome::Value(i64::from(*b)),
            Value::Number(n) if n.is_integer_lexeme() => match n.to_i64() {
                Some(i) => PyOutcome::Value(i),
                None => PyOutcome::OutsideParityDomain("integer outside i64"),
            },
            Value::Number(n) => {
                let f = n.to_f64();
                if f.is_nan() {
                    PyOutcome::Raises(PyException::ValueError)
                } else if f.is_infinite() {
                    PyOutcome::Raises(PyException::OverflowError)
                } else {
                    let t = f.trunc();
                    // i64 range check without overflow in the cast.
                    if (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&t) {
                        PyOutcome::Value(t as i64)
                    } else {
                        PyOutcome::OutsideParityDomain("truncated float outside i64")
                    }
                }
            }
            Value::String(_) => PyOutcome::OutsideParityDomain("python int(str) grammar"),
            Value::Array(_) | Value::Object(_) => PyOutcome::Raises(PyException::TypeError),
            Value::Null => unreachable!("null is reported as Presence::Null"),
        },
    }
}
