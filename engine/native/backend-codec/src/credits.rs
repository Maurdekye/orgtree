//! Exact credit amounts on the 0.01 grid.
//!
//! Source facts (engine/backend/orgtree/ledger.py): `CREDIT_PLACES = 2`, and
//! `_q(x) = round(x, 2)` is applied to every computed total and mutated
//! grant, which keeps Python floats exactly on the hundredths grid. The
//! approved v6 schema catalog requires exact numeric credit values rather
//! than float tolerance. This module therefore stores whole hundredths in an
//! `i64` and offers two separate families:
//!
//! * exact decoders and checked arithmetic ([`Credits`], [`parse_exact`]);
//! * Python characterizations ([`py_round2`], [`py_seat_for`],
//!   [`legacy_hire_grant`]) that reproduce current float behavior bit for bit
//!   inside a stated parity domain and report everything outside it.
//!
//! Neither family chooses whether sub-grid input should be refused or rounded
//! at a future door. That choice is unresolved case `U-AMT-1`.

use crate::json::{Number, Value};
use crate::{PyException, PyOutcome};
use std::fmt;

/// Largest magnitude, in hundredths, where the Python float and the exact
/// decimal are interchangeable. Below 10^15 hundredths every grid value has
/// at most 15 significant digits, so the nearest `f64` round-trips to exactly
/// that decimal and Python's `repr` prints it unchanged. The ledger's own
/// reachable range (about 1.03e8 hundredths, see the CREDIT_PLACES comment)
/// is far inside it.
pub const PARITY_MAX_HUNDREDTHS: i64 = 999_999_999_999_999;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmountError {
    /// NaN or an infinity.
    NotFinite,
    /// A nonzero digit below 0.01.
    Precision,
    /// Magnitude above [`PARITY_MAX_HUNDREDTHS`].
    OutOfRange,
    /// Not a finite JSON number.
    NotNumber,
}

impl AmountError {
    pub fn as_str(self) -> &'static str {
        match self {
            AmountError::NotFinite => "not_finite",
            AmountError::Precision => "precision",
            AmountError::OutOfRange => "out_of_range",
            AmountError::NotNumber => "not_number",
        }
    }
}

impl fmt::Display for AmountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for AmountError {}

/// A credit quantity in whole hundredths. There is no negative zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Credits(i64);

impl Credits {
    pub const ZERO: Credits = Credits(0);

    pub fn from_hundredths(h: i64) -> Result<Credits, AmountError> {
        if h.unsigned_abs() > PARITY_MAX_HUNDREDTHS as u64 {
            Err(AmountError::OutOfRange)
        } else {
            Ok(Credits(h))
        }
    }

    pub fn hundredths(self) -> i64 {
        self.0
    }

    pub fn checked_add(self, other: Credits) -> Result<Credits, AmountError> {
        Credits::from_hundredths(self.0.checked_add(other.0).ok_or(AmountError::OutOfRange)?)
    }

    pub fn checked_sub(self, other: Credits) -> Result<Credits, AmountError> {
        Credits::from_hundredths(self.0.checked_sub(other.0).ok_or(AmountError::OutOfRange)?)
    }

    /// Exact sum; any intermediate overflow is an error, never a wrap.
    pub fn checked_sum<I: IntoIterator<Item = Credits>>(items: I) -> Result<Credits, AmountError> {
        items.into_iter().try_fold(Credits::ZERO, Credits::checked_add)
    }

    /// Plain decimal text with no trailing zeros, e.g. `0.1`, `2`, `-12.05`.
    /// This is a display form, not a chosen wire format (see `U-AMT-3`).
    pub fn to_decimal_string(self) -> String {
        let a = self.0.unsigned_abs();
        let sign = if self.0 < 0 { "-" } else { "" };
        match a % 100 {
            0 => format!("{sign}{}", a / 100),
            f if f % 10 == 0 => format!("{sign}{}.{}", a / 100, f / 10),
            f => format!("{sign}{}.{:02}", a / 100, f),
        }
    }
}

/// The capacity of an issuer. The root USER pool is unlimited in current
/// source (`free(USER)` returns `math.inf`); v6 requires that to be an
/// explicit mode rather than a very large balance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capacity {
    Unlimited,
    Finite(Credits),
}

/// Decode an exact amount from a JSON number lexeme. Any nonzero digit below
/// the 0.01 grid is refused rather than rounded. Exponents are accepted when
/// the value is exact (`1e2` is 100, `1.5e-1` is 0.15).
pub fn parse_exact(n: &Number) -> Result<Credits, AmountError> {
    let s = match n {
        Number::Finite(s) => s.as_str(),
        _ => return Err(AmountError::NotFinite),
    };
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (mantissa, exp_text) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int_part, frac_part) = match mantissa.find('.') {
        Some(i) => (&mantissa[..i], &mantissa[i + 1..]),
        None => (mantissa, ""),
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(AmountError::NotNumber);
    }
    let digits: String = format!("{int_part}{frac_part}");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok(Credits::ZERO);
    }
    let exp: i64 = match exp_text {
        None => 0,
        Some(t) => {
            let t = t.strip_prefix('+').unwrap_or(t);
            // A syntactically valid but absurd exponent is clamped; with a
            // nonzero mantissa it can only be out of range or imprecise.
            t.parse::<i64>().unwrap_or(if t.starts_with('-') { i64::MIN / 2 } else { i64::MAX / 2 })
        }
    };
    // hundredths = digits * 10^(exp - frac_len + 2)
    let shift = exp.saturating_sub(frac_part.len() as i64).saturating_add(2);
    let kept = if shift >= 0 {
        if shift > 18 || digits.len() as i64 + shift > 18 {
            return Err(AmountError::OutOfRange);
        }
        format!("{digits}{}", "0".repeat(shift as usize))
    } else {
        let drop = shift.unsigned_abs();
        if drop >= digits.len() as u64 {
            // Every remaining digit is below the grid and at least one is
            // nonzero (leading zeros were trimmed).
            return Err(AmountError::Precision);
        }
        let cut = digits.len() - drop as usize;
        if !digits[cut..].bytes().all(|b| b == b'0') {
            return Err(AmountError::Precision);
        }
        digits[..cut].to_owned()
    };
    if kept.len() > 18 {
        return Err(AmountError::OutOfRange);
    }
    let h: i64 = kept.parse().map_err(|_| AmountError::OutOfRange)?;
    Credits::from_hundredths(if neg { -h } else { h })
}

/// The result of Python `round(x, 2)` on a float: the hundredths it denotes
/// and whether the float is negative zero, which the exact type cannot carry
/// (`round(-0.001, 2)` is `-0.0`; see `U-AMT-2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PyFloat2 {
    pub hundredths: i64,
    pub negative_zero: bool,
}

impl PyFloat2 {
    pub fn credits(self) -> Credits {
        Credits(self.hundredths)
    }
}

/// Reproduce CPython's `round(x, 2)` (ledger `_q`) exactly.
///
/// CPython rounds the float's exact binary value to two decimals with ties to
/// even, so `round(0.125, 2)` is 0.12 and `round(2.675, 2)` is 2.67 (2.675 is
/// really 2.67499999…). This does the same with integer arithmetic on the
/// float's bits, without any intermediate float multiplication.
pub fn py_round2(x: f64) -> Result<PyFloat2, AmountError> {
    if !x.is_finite() {
        return Err(AmountError::NotFinite);
    }
    let bits = x.to_bits();
    let negative = bits >> 63 == 1;
    let exp_bits = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp_bits == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp_bits - 1075) };
    if m == 0 {
        return Ok(PyFloat2 { hundredths: 0, negative_zero: negative });
    }
    let n = u128::from(m) * 100; // < 2^60
    let q: u128 = if e >= 0 {
        if e > 60 {
            return Err(AmountError::OutOfRange);
        }
        n << e
    } else {
        let k = e.unsigned_abs();
        if k >= 127 {
            0 // n < 2^60 is below half of 2^k, so it rounds to zero
        } else {
            let q = n >> k;
            let r = n & ((1u128 << k) - 1);
            let half = 1u128 << (k - 1);
            if r > half || (r == half && q & 1 == 1) { q + 1 } else { q }
        }
    };
    if q > PARITY_MAX_HUNDREDTHS as u128 {
        return Err(AmountError::OutOfRange);
    }
    let h = q as i64;
    Ok(PyFloat2 { hundredths: if negative { -h } else { h }, negative_zero: negative && h == 0 })
}

/// Python `repr` (and therefore `json.dumps`) of the float a [`PyFloat2`]
/// denotes, e.g. `10.0`, `0.1`, `-0.0`, `1234.56`.
pub fn py_float_repr(v: PyFloat2) -> String {
    if v.negative_zero {
        return "-0.0".to_owned();
    }
    let s = Credits(v.hundredths).to_decimal_string();
    if s.contains('.') { s } else { format!("{s}.0") }
}

/// `openrouter.SEAT_FLOOR`, mirrored by `ledger.SEAT_FLOOR`.
pub const SEAT_FLOOR_HUNDREDTHS: i64 = 10;

/// Reproduce `openrouter.seat_for(prompt_per_m)`:
///
/// ```text
/// floor(p + 1e-9)            when p >= 1
/// max(0.10, round(p, 2))     when p <  1
/// ```
///
/// including its quirks: `NaN` and negative inputs give 0.10 (Python's `max`
/// keeps the floor when a comparison is false), and `+inf` raises
/// `OverflowError` from `math.floor`.
pub fn py_seat_for(p: f64) -> PyOutcome<PyFloat2> {
    if p >= 1.0 {
        let v = (p + 1e-9).floor();
        if v.is_infinite() {
            return PyOutcome::Raises(PyException::OverflowError);
        }
        if v * 100.0 > PARITY_MAX_HUNDREDTHS as f64 {
            return PyOutcome::OutsideParityDomain("seat above parity range");
        }
        return PyOutcome::Value(PyFloat2 { hundredths: v as i64 * 100, negative_zero: false });
    }
    let floor = PyFloat2 { hundredths: SEAT_FLOOR_HUNDREDTHS, negative_zero: false };
    if p.is_nan() || p < 0.0 {
        return PyOutcome::Value(floor);
    }
    match py_round2(p) {
        Ok(r) if r.hundredths > SEAT_FLOOR_HUNDREDTHS => PyOutcome::Value(r),
        Ok(_) => PyOutcome::Value(floor),
        Err(_) => PyOutcome::OutsideParityDomain("unreachable for 0 <= p < 1"),
    }
}

/// The grant `Org.hire` stores after accepting it: `int(grant)`, passed to
/// `_new_node`. So `3.0` is stored as 3, `true` as 1 and `-0.0` as 0 (see
/// `U-AMT-4`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyGrant(pub i64);

impl LegacyGrant {
    /// What `json.dumps` writes for the stored grant.
    pub fn python_json(self) -> String {
        self.0.to_string()
    }
}

/// Reproduce `Org.hire`'s grant check on a JSON-decoded argument,
/// `if grant < 0 or grant != int(grant): raise LedgerError(...)`, and the
/// `int(grant)` it then stores.
pub fn legacy_hire_grant(v: &Value) -> PyOutcome<LegacyGrant> {
    match v {
        Value::Bool(b) => PyOutcome::Value(LegacyGrant(i64::from(*b))),
        Value::Number(n) if n.is_integer_lexeme() => match n.to_i64() {
            Some(i) if i < 0 => PyOutcome::Raises(PyException::LedgerError),
            Some(i) => PyOutcome::Value(LegacyGrant(i)),
            None => PyOutcome::OutsideParityDomain("integer outside i64"),
        },
        Value::Number(n) => {
            let f = n.to_f64();
            if f < 0.0 {
                PyOutcome::Raises(PyException::LedgerError)
            } else if f.is_nan() {
                PyOutcome::Raises(PyException::ValueError)
            } else if f.is_infinite() {
                PyOutcome::Raises(PyException::OverflowError)
            } else if f.fract() != 0.0 {
                PyOutcome::Raises(PyException::LedgerError)
            } else if f >= 9_223_372_036_854_775_808.0 {
                PyOutcome::OutsideParityDomain("int(grant) outside i64")
            } else {
                // Integral and non-negative here; -0.0 becomes 0.
                PyOutcome::Value(LegacyGrant(f as i64))
            }
        }
        Value::Null | Value::String(_) | Value::Array(_) | Value::Object(_) => {
            PyOutcome::Raises(PyException::TypeError)
        }
    }
}
