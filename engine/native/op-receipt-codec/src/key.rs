//! The operation-key grammar and the Python scalar coercions the receipt
//! rules apply to stored values.
//!
//! `opreceipts.KEY_RE` is `^(\d{13,14})-([0-9a-f]{24})$`, used with
//! `re.match` on a `str`. Two Python details matter:
//!
//! * `\d` matches every Unicode decimal digit (general category Nd), and the
//!   captured group goes through `int()`, which converts those digits too, so
//!   a key written in Arabic-Indic digits is valid with an ordinary mint time;
//! * `$` matches at the end of the text or just before one final `\n`.
//!
//! The coercions reproduce `int(x or 0)`, truthiness and `str(x or y or "")`
//! over values decoded from the org document by `json.loads`.

use crate::canonical::{py_float_repr, py_int_lexeme};
use crate::pyint::PyInt;
use crate::{PyException, PyOutcome, Rules};
use orgtree_backend_codec::json::{Number, Value, PYTHON_INT_MAX_STR_DIGITS};
use orgtree_backend_codec::presence::Presence;

/// The zero of every run of Unicode decimal digits (Unicode 15.1, as in
/// CPython 3.13). Each run holds the ten digits 0..9 in order. The oracle
/// regenerates this table from `str.isdecimal()` over every code point.
pub const DECIMAL_ZEROS: [u32; 68] = [
    0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66,
    0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10,
    0x104A0, 0x10D30, 0x11066, 0x110F0, 0x11136, 0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650,
    0x116C0, 0x11730, 0x118E0, 0x11950, 0x11C50, 0x11D50, 0x11DA0, 0x11F50, 0x16A60, 0x16AC0,
    0x16B50, 0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E950,
    0x1FBF0,
];

/// Every code point for which Python `str.isspace()` is true (CPython 3.13).
pub const PY_SPACE: [u32; 29] = [
    0x9, 0xA, 0xB, 0xC, 0xD, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x85, 0xA0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F,
    0x205F, 0x3000,
];

/// The decimal value of `c` if Python's `\d` (and `str.isdecimal()`)
/// accepts it.
pub fn py_decimal_value(c: char) -> Option<u32> {
    let cp = c as u32;
    // The table is sorted; find the last run starting at or before cp.
    let i = DECIMAL_ZEROS.partition_point(|&z| z <= cp);
    if i == 0 {
        return None;
    }
    let d = cp - DECIMAL_ZEROS[i - 1];
    (d < 10).then_some(d)
}

pub fn is_py_space(c: char) -> bool {
    PY_SPACE.binary_search(&(c as u32)).is_ok()
}

fn key_digit(c: char, rules: &Rules) -> Option<u32> {
    if rules.key_unicode_digits {
        py_decimal_value(c)
    } else if c.is_ascii_digit() {
        c.to_digit(10)
    } else {
        None
    }
}

/// `opreceipts.parse_key(key)`: the key's mint time in ms, or `None` when it
/// is not one of ours.
pub fn parse_key(key: &str) -> Option<i64> {
    parse_key_with(key, &Rules::LEGACY)
}

pub fn parse_key_with(key: &str, rules: &Rules) -> Option<i64> {
    let body = match key.strip_suffix('\n') {
        Some(b) if rules.key_final_newline => b,
        _ => key,
    };
    let chars: Vec<char> = body.chars().collect();
    let dash = chars.iter().position(|&c| c == '-')?;
    if !(13..=14).contains(&dash) || chars.len() != dash + 1 + 24 {
        return None;
    }
    let mut mint: i64 = 0;
    for &c in &chars[..dash] {
        mint = mint * 10 + i64::from(key_digit(c, rules)?);
    }
    if !chars[dash + 1..]
        .iter()
        .all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    {
        return None;
    }
    Some(mint)
}

/// Python `int(s)` for a `str` in base 10.
///
/// CPython (`_PyUnicode_TransformDecimalAndSpaceToASCII`) first copies every
/// code point below U+007F unchanged, and maps each other code point that is
/// `str.isspace()` to a space and each other Unicode decimal digit to its
/// ASCII digit; anything else makes the text invalid. It then parses:
/// optional surrounding ASCII whitespace (space, tab, LF, VT, FF, CR), an
/// optional sign, and ASCII digits with single underscores allowed only
/// between digits. So the ASCII separators U+001C..U+001F, although
/// `str.isspace()`, are rejected. The value is exact at any width; more than
/// 4300 digits raise `ValueError`.
pub fn py_int_from_str(s: &str) -> PyOutcome<PyInt> {
    py_int_from_str_with(s, &Rules::LEGACY)
}

pub fn py_int_from_str_with(s: &str, rules: &Rules) -> PyOutcome<PyInt> {
    let mut t = String::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if cp < 0x7f {
            let separator = (0x1c..=0x1f).contains(&cp);
            t.push(if separator && rules.int_ascii_separators_as_space {
                ' '
            } else {
                c
            });
        } else if is_py_space(c) {
            t.push(' ');
        } else if let Some(d) = py_decimal_value(c) {
            t.push(char::from(b'0' + d as u8));
        } else {
            return PyOutcome::Raises(PyException::ValueError);
        }
    }
    // After the mapping only ASCII whitespace can surround the number.
    let b = t
        .trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '\x0c' | '\r'))
        .as_bytes();
    let (neg, digits) = match b.first() {
        Some(b'-') => (true, &b[1..]),
        Some(b'+') => (false, &b[1..]),
        _ => (false, b),
    };
    if digits.is_empty() || digits[0] == b'_' || digits[digits.len() - 1] == b'_' {
        return PyOutcome::Raises(PyException::ValueError);
    }
    let mut prev_underscore = false;
    let mut plain = Vec::with_capacity(digits.len());
    for &c in digits {
        match c {
            b'_' if !prev_underscore => prev_underscore = true,
            b'0'..=b'9' => {
                prev_underscore = false;
                plain.push(c);
            }
            _ => return PyOutcome::Raises(PyException::ValueError),
        }
    }
    if plain.len() > PYTHON_INT_MAX_STR_DIGITS {
        return PyOutcome::Raises(PyException::ValueError);
    }
    match PyInt::from_ascii_digits(neg, &plain) {
        Some(v) => PyOutcome::Value(v),
        None => PyOutcome::Raises(PyException::ValueError),
    }
}

/// Python truthiness of a value decoded by `json.loads`.
pub fn py_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n @ Number::Finite(s)) if n.is_integer_lexeme() => {
            s.bytes().any(|b| matches!(b, b'1'..=b'9'))
        }
        Value::Number(n) => n.to_f64() != 0.0,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn truthy_member(p: Presence<&Value>) -> Option<&Value> {
    match p {
        Presence::Present(v) if py_truthy(v) => Some(v),
        _ => None,
    }
}

/// Python `int(x or 0)` where `x` is a member that may be absent. The value
/// is exact at any width.
pub fn py_int_or_zero(p: Presence<&Value>) -> PyOutcome<PyInt> {
    py_int_or_zero_with(p, &Rules::LEGACY)
}

/// `int(x or 0)` under the given rules. Only the negative control that
/// narrows integers to `i64` changes the answer.
pub fn py_int_or_zero_with(p: Presence<&Value>, rules: &Rules) -> PyOutcome<PyInt> {
    let Some(v) = truthy_member(p) else {
        return PyOutcome::Value(PyInt::zero());
    };
    let out = match v {
        Value::Bool(_) => PyOutcome::Value(PyInt::from(1i64)),
        Value::Number(n) if n.is_integer_lexeme() => match PyInt::parse_decimal(n.lexeme()) {
            Some(i) => PyOutcome::Value(i),
            None => PyOutcome::Raises(PyException::ValueError),
        },
        Value::Number(n) => {
            let f = n.to_f64();
            if f.is_nan() {
                PyOutcome::Raises(PyException::ValueError)
            } else {
                match PyInt::from_f64_trunc(f) {
                    Some(i) => PyOutcome::Value(i),
                    None => PyOutcome::Raises(PyException::OverflowError),
                }
            }
        }
        Value::String(s) => py_int_from_str_with(s, rules),
        Value::Array(_) | Value::Object(_) => PyOutcome::Raises(PyException::TypeError),
        Value::Null => PyOutcome::Value(PyInt::zero()),
    };
    match out {
        PyOutcome::Value(i) => narrow(i, rules),
        other => other,
    }
}

/// The identity under [`Rules::LEGACY`]. The `i64_ints` negative control
/// reports a value beyond `i64` as outside the parity domain instead, which
/// is what this crate did before it carried exact integers.
pub fn narrow(v: PyInt, rules: &Rules) -> PyOutcome<PyInt> {
    if rules.i64_ints && v.to_i64().is_none() {
        PyOutcome::OutsideParityDomain("integer beyond i64")
    } else {
        PyOutcome::Value(v)
    }
}

/// Python `str(a or b or "")` over two members that may be absent.
pub fn py_str_or(a: Presence<&Value>, b: Presence<&Value>) -> PyOutcome<String> {
    let Some(v) = truthy_member(a).or_else(|| truthy_member(b)) else {
        return PyOutcome::Value(String::new());
    };
    match v {
        Value::String(s) => PyOutcome::Value(s.clone()),
        Value::Bool(_) => PyOutcome::Value("True".to_owned()),
        Value::Number(n) if n.is_integer_lexeme() => PyOutcome::Value(py_int_lexeme(n.lexeme())),
        Value::Number(n) => {
            let f = n.to_f64();
            let text = if f.is_nan() {
                "nan".to_owned()
            } else if f == f64::INFINITY {
                "inf".to_owned()
            } else if f == f64::NEG_INFINITY {
                "-inf".to_owned()
            } else {
                py_float_repr(f)
            };
            PyOutcome::Value(text)
        }
        _ => PyOutcome::OutsideParityDomain("str() of a container"),
    }
}
