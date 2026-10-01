//! A Python `str` as Python holds it: a sequence of code points in which
//! lone surrogates (U+D800..U+DFFF) are ordinary members. Rust's `String`
//! cannot hold those, and a path Python accepts may contain them, so every
//! string the clamps touch is a [`PyStr`].
//!
//! Ordering is Python's: lexicographic by code point, which is what
//! `sorted()` and tuple comparison use.

use crate::tables::{NONPRINTABLE, PY_WHITESPACE};
use std::fmt;

#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PyStr(pub Vec<u32>);

impl PyStr {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The UTF-16 code units Windows sees (`PyUnicode_AsWideCharString`):
    /// astral code points become pairs, lone surrogates pass as themselves.
    pub fn to_wide(&self) -> Vec<u16> {
        let mut out = Vec::with_capacity(self.0.len());
        for &c in &self.0 {
            if c > 0xFFFF {
                let v = c - 0x1_0000;
                out.push(0xD800 + (v >> 10) as u16);
                out.push(0xDC00 + (v & 0x3FF) as u16);
            } else {
                out.push(c as u16);
            }
        }
        out
    }

    /// `PyUnicode_FromWideChar`: a high surrogate followed by a low one is
    /// joined into one code point; any other surrogate stays lone.
    pub fn from_wide(w: &[u16]) -> PyStr {
        let mut out = Vec::with_capacity(w.len());
        let mut i = 0;
        while i < w.len() {
            let u = w[i];
            if (0xD800..0xDC00).contains(&u)
                && i + 1 < w.len()
                && (0xDC00..0xE000).contains(&w[i + 1])
            {
                let hi = u32::from(u - 0xD800);
                let lo = u32::from(w[i + 1] - 0xDC00);
                out.push(0x1_0000 + (hi << 10) + lo);
                i += 2;
            } else {
                out.push(u32::from(u));
                i += 1;
            }
        }
        PyStr(out)
    }

    pub fn starts_with(&self, p: &PyStr) -> bool {
        self.0.starts_with(&p.0)
    }

    pub fn concat(&self, other: &PyStr) -> PyStr {
        let mut v = self.0.clone();
        v.extend_from_slice(&other.0);
        PyStr(v)
    }

    /// `str.strip()` with no argument: Python's whitespace set.
    pub fn strip(&self) -> PyStr {
        let s = &self.0;
        let a = s.iter().position(|&c| !is_space(c)).unwrap_or(s.len());
        let b = s.iter().rposition(|&c| !is_space(c)).map_or(a, |i| i + 1);
        PyStr(s[a..b].to_vec())
    }

    /// `str.rstrip(chars)`.
    pub fn rstrip_any(&self, chars: &[u32]) -> PyStr {
        let s = &self.0;
        let b = s
            .iter()
            .rposition(|c| !chars.contains(c))
            .map_or(0, |i| i + 1);
        PyStr(s[..b].to_vec())
    }

    /// `str.replace(a, b)` for single code points.
    pub fn replace_cp(&self, a: u32, b: u32) -> PyStr {
        PyStr(self.0.iter().map(|&c| if c == a { b } else { c }).collect())
    }

    /// Rust text, when every code point is a Unicode scalar value.
    pub fn to_rust(&self) -> Option<String> {
        self.0.iter().map(|&c| char::from_u32(c)).collect()
    }

    /// The same text as an f-string would insert it (`str(s)`), for
    /// messages. A lone surrogate cannot be Rust text; it is written as the
    /// replacement-free escape `\u{d800}` and the result is marked lossy.
    pub fn to_text(&self) -> String {
        self.0
            .iter()
            .map(|&c| match char::from_u32(c) {
                Some(ch) => ch.to_string(),
                None => format!("\\u{{{c:x}}}"),
            })
            .collect()
    }
}

impl From<&str> for PyStr {
    fn from(s: &str) -> PyStr {
        PyStr(s.chars().map(u32::from).collect())
    }
}

impl fmt::Debug for PyStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&py_repr(self).to_text())
    }
}

pub fn is_space(c: u32) -> bool {
    PY_WHITESPACE.binary_search(&c).is_ok()
}

/// `str.isprintable()` of one code point on CPython 3.13 (the table is the
/// oracle's own capture).
pub fn is_printable(c: u32) -> bool {
    NONPRINTABLE
        .binary_search_by(|&(lo, hi)| {
            if hi < c {
                std::cmp::Ordering::Less
            } else if lo > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_err()
}

/// `repr(s)` exactly as CPython 3.13 writes it, as a Python string (a lone
/// surrogate is printed as an escape, so the result is always text).
pub fn py_repr(s: &PyStr) -> PyStr {
    let has_sq = s.0.contains(&0x27);
    let has_dq = s.0.contains(&0x22);
    let q: u32 = if has_sq && !has_dq { 0x22 } else { 0x27 };
    let mut out: Vec<u32> = vec![q];
    let push = |out: &mut Vec<u32>, t: &str| out.extend(t.chars().map(u32::from));
    for &c in &s.0 {
        if c == q || c == 0x5c {
            out.push(0x5c);
            out.push(c);
        } else if c == 0x09 {
            push(&mut out, "\\t");
        } else if c == 0x0a {
            push(&mut out, "\\n");
        } else if c == 0x0d {
            push(&mut out, "\\r");
        } else if c < 0x20 || c == 0x7f {
            push(&mut out, &format!("\\x{c:02x}"));
        } else if c < 0x7f || is_printable(c) {
            out.push(c);
        } else if c <= 0xff {
            push(&mut out, &format!("\\x{c:02x}"));
        } else if c <= 0xffff {
            push(&mut out, &format!("\\u{c:04x}"));
        } else {
            push(&mut out, &format!("\\U{c:08x}"));
        }
    }
    out.push(q);
    PyStr(out)
}
