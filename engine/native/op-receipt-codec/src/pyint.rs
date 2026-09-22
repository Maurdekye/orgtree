//! An exact, arbitrary-precision signed integer with the few operations the
//! receipt rules perform on Python `int`s: conversion from JSON integer text,
//! from a decimal `str` and from a float (`int(x)` truncates exactly),
//! comparison, addition and subtraction, and `str()`.
//!
//! Python integers have no width. The receipt metadata and rows store
//! `int(x or 0)` of whatever the document holds, so a watermark, a sequence
//! counter or a generation may be far beyond `i64`. Every such value is kept
//! exactly here; nothing is saturated, wrapped or refused for its size.
//!
//! The magnitude is little-endian base 10^9 limbs with no zero limb at the
//! top; zero is the empty magnitude and is never negative.

use std::cmp::Ordering;
use std::fmt;

const BASE: u64 = 1_000_000_000;
const BASE_DIGITS: usize = 9;

#[derive(Clone, PartialEq, Eq, Hash, Default)]
pub struct PyInt {
    neg: bool,
    mag: Vec<u32>,
}

fn trim(mag: &mut Vec<u32>) {
    while mag.last() == Some(&0) {
        mag.pop();
    }
}

fn cmp_mag(a: &[u32], b: &[u32]) -> Ordering {
    a.len()
        .cmp(&b.len())
        .then_with(|| a.iter().rev().cmp(b.iter().rev()))
}

fn add_mag(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().max(b.len()) + 1);
    let mut carry = 0u64;
    for i in 0..a.len().max(b.len()) {
        let s = u64::from(*a.get(i).unwrap_or(&0)) + u64::from(*b.get(i).unwrap_or(&0)) + carry;
        out.push((s % BASE) as u32);
        carry = s / BASE;
    }
    if carry > 0 {
        out.push(carry as u32);
    }
    out
}

/// `a - b` for `a >= b`.
fn sub_mag(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len());
    let mut borrow = 0i64;
    for (i, &x) in a.iter().enumerate() {
        let mut d = i64::from(x) - i64::from(*b.get(i).unwrap_or(&0)) - borrow;
        if d < 0 {
            d += BASE as i64;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out.push(d as u32);
    }
    trim(&mut out);
    out
}

fn mul_small(mag: &mut Vec<u32>, m: u32) {
    let mut carry = 0u64;
    for limb in mag.iter_mut() {
        let p = u64::from(*limb) * u64::from(m) + carry;
        *limb = (p % BASE) as u32;
        carry = p / BASE;
    }
    while carry > 0 {
        mag.push((carry % BASE) as u32);
        carry /= BASE;
    }
    trim(mag);
}

impl PyInt {
    pub fn zero() -> PyInt {
        PyInt::default()
    }

    fn from_parts(neg: bool, mut mag: Vec<u32>) -> PyInt {
        trim(&mut mag);
        let neg = neg && !mag.is_empty();
        PyInt { neg, mag }
    }

    /// The value of ASCII decimal digits (leading zeros allowed), negated
    /// when `neg`. `None` when `digits` is empty or holds a non-digit.
    pub fn from_ascii_digits(neg: bool, digits: &[u8]) -> Option<PyInt> {
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let mut mag = Vec::with_capacity(digits.len() / BASE_DIGITS + 1);
        for chunk in digits.rchunks(BASE_DIGITS) {
            let limb = chunk
                .iter()
                .fold(0u32, |acc, d| acc * 10 + u32::from(d - b'0'));
            mag.push(limb);
        }
        Some(PyInt::from_parts(neg, mag))
    }

    /// Python `int(text)` for an optionally `-`-signed run of ASCII digits,
    /// such as a JSON integer lexeme. `None` for anything else.
    pub fn parse_decimal(text: &str) -> Option<PyInt> {
        match text.as_bytes() {
            [b'-', rest @ ..] => PyInt::from_ascii_digits(true, rest),
            b => PyInt::from_ascii_digits(false, b),
        }
    }

    /// Python `int(x)` for a finite float: the exact value truncated toward
    /// zero. `None` for NaN and the infinities.
    pub fn from_f64_trunc(x: f64) -> Option<PyInt> {
        if !x.is_finite() {
            return None;
        }
        let bits = x.to_bits();
        let neg = bits >> 63 == 1;
        let biased = ((bits >> 52) & 0x7ff) as i32;
        let frac = bits & ((1u64 << 52) - 1);
        // x = mantissa * 2^exp exactly.
        let (mantissa, exp) = if biased == 0 {
            (frac, -1074)
        } else {
            (frac | (1u64 << 52), biased - 1075)
        };
        if exp < 0 {
            let shift = -exp;
            let m = if shift >= 64 { 0 } else { mantissa >> shift };
            return Some(PyInt::from_parts(neg, u64_mag(m)));
        }
        let mut mag = u64_mag(mantissa);
        let mut e = exp;
        while e > 0 {
            let step = e.min(29);
            mul_small(&mut mag, 1u32 << step);
            e -= step;
        }
        Some(PyInt::from_parts(neg, mag))
    }

    pub fn is_zero(&self) -> bool {
        self.mag.is_empty()
    }

    pub fn is_negative(&self) -> bool {
        self.neg
    }

    /// The value when it fits in `i64`.
    pub fn to_i64(&self) -> Option<i64> {
        let mut v: i128 = 0;
        for &limb in self.mag.iter().rev() {
            v = v
                .checked_mul(i128::from(BASE as u32))?
                .checked_add(i128::from(limb))?;
            if v > i128::from(i64::MAX) + 1 {
                return None;
            }
        }
        let v = if self.neg { -v } else { v };
        i64::try_from(v).ok()
    }

    /// The number of decimal digits of the magnitude (`0` has one).
    pub fn digit_count(&self) -> usize {
        match self.mag.last() {
            None => 1,
            Some(top) => (self.mag.len() - 1) * BASE_DIGITS + top.to_string().len(),
        }
    }

    pub fn negate(&self) -> PyInt {
        PyInt::from_parts(!self.neg, self.mag.clone())
    }

    pub fn add(&self, other: &PyInt) -> PyInt {
        if self.neg == other.neg {
            return PyInt::from_parts(self.neg, add_mag(&self.mag, &other.mag));
        }
        match cmp_mag(&self.mag, &other.mag) {
            Ordering::Equal => PyInt::zero(),
            Ordering::Greater => PyInt::from_parts(self.neg, sub_mag(&self.mag, &other.mag)),
            Ordering::Less => PyInt::from_parts(other.neg, sub_mag(&other.mag, &self.mag)),
        }
    }

    pub fn sub(&self, other: &PyInt) -> PyInt {
        self.add(&other.negate())
    }

    pub fn mul_u32(&self, m: u32) -> PyInt {
        let mut mag = self.mag.clone();
        mul_small(&mut mag, m);
        PyInt::from_parts(self.neg, mag)
    }
}

fn u64_mag(mut m: u64) -> Vec<u32> {
    let mut mag = Vec::new();
    while m > 0 {
        mag.push((m % BASE) as u32);
        m /= BASE;
    }
    mag
}

impl From<i64> for PyInt {
    fn from(v: i64) -> PyInt {
        PyInt::from_parts(v < 0, u64_mag(v.unsigned_abs()))
    }
}

impl From<usize> for PyInt {
    fn from(v: usize) -> PyInt {
        PyInt::from_parts(false, u64_mag(v as u64))
    }
}

impl Ord for PyInt {
    fn cmp(&self, other: &PyInt) -> Ordering {
        match (self.neg, other.neg) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => cmp_mag(&self.mag, &other.mag),
            (true, true) => cmp_mag(&other.mag, &self.mag),
        }
    }
}

impl PartialOrd for PyInt {
    fn partial_cmp(&self, other: &PyInt) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Python `str(int)` without its digit limit; see
/// [`crate::fingerprint::canonical_call`] for where the limit applies.
impl fmt::Display for PyInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Some(top) = self.mag.last() else {
            return f.write_str("0");
        };
        let mut s = String::with_capacity(self.mag.len() * BASE_DIGITS + 1);
        if self.neg {
            s.push('-');
        }
        s.push_str(&top.to_string());
        for limb in self.mag.iter().rev().skip(1) {
            s.push_str(&format!("{limb:09}"));
        }
        f.write_str(&s)
    }
}

impl fmt::Debug for PyInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
