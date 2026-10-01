//! The two Python formatting rules the ledger's messages use: `format(x,
//! 'g')` for every amount and `repr(s)` for a quoted node name.

use crate::pynum::{Outside, PyNum, R};

/// `format(x, "g")`: six significant digits, the exact binary value rounded
/// half-to-even (CPython's dtoa), trailing zeros dropped, and exponent form
/// when the decimal exponent is below -4 or at least 6. An int is formatted
/// as the float it converts to, as `int.__format__` does for `g`.
///
/// `half_even = false` rounds exact ties upward; it exists only as a
/// negative control.
pub fn py_g(x: PyNum, half_even: bool) -> String {
    let f = x.to_f64();
    if f.is_nan() {
        return "nan".to_owned();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf" } else { "-inf" }.to_owned();
    }
    let sign = if f.is_sign_negative() { "-" } else { "" };
    if f == 0.0 {
        return format!("{sign}0");
    }
    // 800 fractional digits hold the exact decimal expansion of any finite
    // double (at most 767 significant digits), so the tie test below sees
    // the true value rather than an already-rounded one.
    let exact = format!("{:.800e}", f.abs());
    let (mant, e) = exact.split_once('e').unwrap_or((exact.as_str(), "0"));
    let mut exp: i32 = e.parse().unwrap_or(0);
    let digits: Vec<u8> = mant
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|b| b - b'0')
        .collect();
    let mut keep: Vec<u8> = digits[..6].to_vec();
    let next = digits[6];
    let rest_nonzero = digits[7..].iter().any(|&d| d != 0);
    let odd = keep[5] % 2 == 1;
    if next > 5 || (next == 5 && (rest_nonzero || odd || !half_even)) {
        let mut i = 6;
        loop {
            if i == 0 {
                keep.insert(0, 1);
                keep.pop();
                exp += 1;
                break;
            }
            i -= 1;
            if keep[i] == 9 {
                keep[i] = 0;
            } else {
                keep[i] += 1;
                break;
            }
        }
    }
    while keep.len() > 1 && keep.last() == Some(&0) {
        keep.pop();
    }
    let ds: String = keep.iter().map(|d| char::from(b'0' + d)).collect();
    let body = if (-4..6).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if ds.len() <= int_len {
                format!("{ds}{}", "0".repeat(int_len - ds.len()))
            } else {
                format!("{}.{}", &ds[..int_len], &ds[int_len..])
            }
        } else {
            format!("0.{}{ds}", "0".repeat((-exp - 1) as usize))
        }
    } else {
        let (head, tail) = ds.split_at(1);
        let frac = if tail.is_empty() {
            String::new()
        } else {
            format!(".{tail}")
        };
        let es = if exp < 0 { '-' } else { '+' };
        format!("{head}{frac}e{es}{:02}", exp.unsigned_abs())
    };
    format!("{sign}{body}")
}

/// `repr(s)` for the node names and actors that appear in messages. Only
/// printable ASCII is reproduced; anything needing an escape is outside the
/// parity domain rather than guessed.
pub fn py_repr_str(s: &str) -> R<String> {
    let backslash = char::from(92u8);
    if !s.chars().all(|c| (' '..='~').contains(&c)) || s.contains(backslash) {
        return Err(Outside("repr() of a string that needs escapes"));
    }
    if !s.contains('\'') {
        Ok(format!("'{s}'"))
    } else if !s.contains('"') {
        Ok(format!("\"{s}\""))
    } else {
        Err(Outside("repr() of a string with both quote kinds"))
    }
}
