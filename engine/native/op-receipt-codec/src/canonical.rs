//! `opreceipts._canonical`: `json.dumps(obj, sort_keys=True,
//! separators=(",", ":"), ensure_ascii=False, default=str)`, reproduced for
//! values decoded by `json.loads`.
//!
//! * Object members are sorted by Python `str` comparison, which is code
//!   point order. Rust `str` ordering compares UTF-8 bytes, which gives the
//!   same order.
//! * Strings escape only `"`, `\` and the C0 controls (`\b \f \n \r \t` in
//!   short form, the rest as lowercase `\u00XX`). Everything else, including
//!   U+007F, U+2028 and astral characters, stays raw.
//! * Integers keep their exact digits (`-0` becomes `0`); floats use Python
//!   `repr`; the non-finite values render as `NaN`, `Infinity`, `-Infinity`.
//! * `default=str` is never reached for JSON values and is not reproduced.

use crate::Rules;
use orgtree_backend_codec::json::{python_ascii_string, Number, Value};

/// Python `int.__repr__` for a JSON integer lexeme.
pub fn py_int_lexeme(lexeme: &str) -> String {
    if lexeme.bytes().all(|b| matches!(b, b'-' | b'0')) {
        "0".to_owned()
    } else {
        lexeme.to_owned()
    }
}

/// Python `float.__repr__` for a finite float: the shortest digits that
/// round-trip, in fixed notation when the decimal point position is in
/// `-4 < decpt <= 16`, else in exponent form with a sign and at least two
/// exponent digits (`1e+16`, `1e-05`). Fixed notation always has a `.`.
pub fn py_float_repr(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0" } else { "0.0" }.to_owned();
    }
    // Rust's `{:e}` without a precision prints the shortest round-trip digits.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let exp: i32 = exp.parse().expect("LowerExp exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let n = digits.len() as i32;
    let decpt = exp + 1;
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if -4 < decpt && decpt <= 16 {
        if decpt <= 0 {
            out.push_str("0.");
            out.extend(std::iter::repeat_n('0', (-decpt) as usize));
            out.push_str(&digits);
        } else if decpt >= n {
            out.push_str(&digits);
            out.extend(std::iter::repeat_n('0', (decpt - n) as usize));
            out.push_str(".0");
        } else {
            out.push_str(&digits[..decpt as usize]);
            out.push('.');
            out.push_str(&digits[decpt as usize..]);
        }
    } else {
        out.push_str(&digits[..1]);
        if n > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let e = decpt - 1;
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", e.abs()));
    }
    out
}

/// What `json.dumps` writes for a Python float.
pub fn py_json_float(x: f64, rules: &Rules) -> String {
    if x.is_nan() {
        "NaN".to_owned()
    } else if x == f64::INFINITY {
        "Infinity".to_owned()
    } else if x == f64::NEG_INFINITY {
        "-Infinity".to_owned()
    } else if rules.python_float_repr {
        py_float_repr(x)
    } else {
        format!("{x}")
    }
}

/// A string as `json.dumps(..., ensure_ascii=False)` writes it.
pub fn py_json_string(s: &str, rules: &Rules) -> String {
    if rules.ensure_ascii {
        return python_ascii_string(s);
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{0}'..='\u{1f}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn number(n: &Number, rules: &Rules) -> String {
    if n.is_integer_lexeme() {
        py_int_lexeme(n.lexeme())
    } else {
        py_json_float(n.to_f64(), rules)
    }
}

/// The canonical text `_canonical` produces for a decoded JSON value.
pub fn canonical(v: &Value) -> String {
    canonical_with(v, &Rules::LEGACY)
}

pub fn canonical_with(v: &Value, rules: &Rules) -> String {
    let mut out = String::new();
    write_value(v, rules, &mut out);
    out
}

pub(crate) fn write_value(v: &Value, rules: &Rules, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&number(n, rules)),
        Value::String(s) => out.push_str(&py_json_string(s, rules)),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, rules, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut members: Vec<&(String, Value)> = o.members().iter().collect();
            if rules.utf16_key_order {
                members.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            } else {
                members.sort_by(|a, b| a.0.cmp(&b.0));
            }
            out.push('{');
            for (i, (k, val)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&py_json_string(k, rules));
                out.push(':');
                write_value(val, rules, out);
            }
            out.push('}');
        }
    }
}
