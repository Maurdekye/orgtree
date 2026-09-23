//! The raw Python values the clamps receive (tool maps, dir lists, ceiling
//! documents), as JSON would carry them but with Python strings that may
//! hold lone surrogates.
//!
//! In the vector files a string that is not valid Unicode text is written
//! as the one-member object `{"\u0000str": [code points]}`; every other
//! string is an ordinary JSON string.

use crate::pystr::PyStr;
use orgtree_backend_codec::json::{Number, Value};

pub const PYSTR_KEY: &str = "\u{0}str";

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Null,
    Bool(bool),
    Int(i128),
    Float(f64),
    Str(PyStr),
    List(Vec<Val>),
    /// A dict, in insertion order.
    Obj(Vec<(PyStr, Val)>),
}

/// An input the model does not cover. Never a guess.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outside(pub &'static str);

impl Val {
    pub fn from_json(v: &Value) -> Result<Val, Outside> {
        Ok(match v {
            Value::Null => Val::Null,
            Value::Bool(b) => Val::Bool(*b),
            Value::Number(Number::Finite(s)) => {
                if v_is_int(s) {
                    Val::Int(s.parse().map_err(|_| Outside("int beyond i128"))?)
                } else {
                    Val::Float(s.parse().map_err(|_| Outside("unparsable float"))?)
                }
            }
            Value::Number(_) => return Err(Outside("non-finite number")),
            Value::String(s) => Val::Str(PyStr::from(s.as_str())),
            Value::Array(a) => Val::List(a.iter().map(Val::from_json).collect::<Result<_, _>>()?),
            Value::Object(o) => {
                let m = o.members();
                if m.len() == 1 && m[0].0 == PYSTR_KEY {
                    let Value::Array(cps) = &m[0].1 else {
                        return Err(Outside("malformed code-point string"));
                    };
                    let mut out = Vec::with_capacity(cps.len());
                    for c in cps {
                        match c {
                            Value::Number(Number::Finite(s)) => out.push(
                                s.parse::<u32>()
                                    .ok()
                                    .filter(|&c| c < 0x11_0000)
                                    .ok_or(Outside("bad code point"))?,
                            ),
                            _ => return Err(Outside("bad code point")),
                        }
                    }
                    Val::Str(PyStr(out))
                } else {
                    Val::Obj(
                        m.iter()
                            .map(|(k, v)| Ok((PyStr::from(k.as_str()), Val::from_json(v)?)))
                            .collect::<Result<_, Outside>>()?,
                    )
                }
            }
        })
    }

    /// `bool(v)`.
    pub fn truthy(&self) -> bool {
        match self {
            Val::Null => false,
            Val::Bool(b) => *b,
            Val::Int(i) => *i != 0,
            Val::Float(f) => *f != 0.0,
            Val::Str(s) => !s.is_empty(),
            Val::List(l) => !l.is_empty(),
            Val::Obj(o) => !o.is_empty(),
        }
    }

    /// `d.get(key)` on a dict: `None` when absent.
    pub fn get(&self, key: &str) -> Option<&Val> {
        match self {
            Val::Obj(m) => {
                let k = PyStr::from(key);
                m.iter().find(|(x, _)| *x == k).map(|(_, v)| v)
            }
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&PyStr> {
        match self {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Python equality with a `str`: only a `str` can be equal to one.
    pub fn eq_str(&self, s: &PyStr) -> bool {
        matches!(self, Val::Str(x) if x == s)
    }

    /// `str(v)`: the string itself, else `repr(v)`.
    pub fn py_str(&self) -> Result<PyStr, Outside> {
        match self {
            Val::Str(s) => Ok(s.clone()),
            _ => self.py_repr(),
        }
    }

    /// `repr(v)` for JSON-shaped Python values.
    pub fn py_repr(&self) -> Result<PyStr, Outside> {
        let t = |x: &str| PyStr::from(x);
        Ok(match self {
            Val::Null => t("None"),
            Val::Bool(true) => t("True"),
            Val::Bool(false) => t("False"),
            Val::Int(i) => t(&i.to_string()),
            Val::Float(f) => t(&py_float_repr(*f)),
            Val::Str(s) => crate::pystr::py_repr(s),
            Val::List(l) => {
                let mut v = t("[");
                for (i, x) in l.iter().enumerate() {
                    if i > 0 {
                        v = v.concat(&t(", "));
                    }
                    v = v.concat(&x.py_repr()?);
                }
                v.concat(&t("]"))
            }
            Val::Obj(m) => {
                let mut v = t("{");
                for (i, (k, x)) in m.iter().enumerate() {
                    if i > 0 {
                        v = v.concat(&t(", "));
                    }
                    v = v
                        .concat(&crate::pystr::py_repr(k))
                        .concat(&t(": "))
                        .concat(&x.py_repr()?);
                }
                v.concat(&t("}"))
            }
        })
    }

    pub fn to_json(&self) -> String {
        match self {
            Val::Null => "null".to_owned(),
            Val::Bool(b) => b.to_string(),
            Val::Int(i) => i.to_string(),
            Val::Float(f) => format!("{f:?}"),
            Val::Str(s) => str_json(s),
            Val::List(l) => format!(
                "[{}]",
                l.iter().map(Val::to_json).collect::<Vec<_>>().join(",")
            ),
            Val::Obj(m) => format!(
                "{{{}}}",
                m.iter()
                    .map(|(k, v)| format!("{}:{}", str_json(k), v.to_json()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}

/// `repr(float)`: the shortest round-tripping digits (Rust's `{:e}` gives
/// the same digits as CPython's `repr`), laid out as Python does: fixed
/// notation for decimal exponents -4..16, else `d.ddde+XX`.
pub fn py_float_repr(f: f64) -> String {
    if f.is_nan() {
        return "nan".to_owned();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf" } else { "-inf" }.to_owned();
    }
    let sci = format!("{f:e}");
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let sign = if neg { "-" } else { "" };
    if (-4..16).contains(&exp) {
        let point = exp + 1;
        let body = if point <= 0 {
            format!("0.{}{}", "0".repeat((-point) as usize), digits)
        } else if point as usize >= digits.len() {
            format!("{}{}.0", digits, "0".repeat(point as usize - digits.len()))
        } else {
            format!(
                "{}.{}",
                &digits[..point as usize],
                &digits[point as usize..]
            )
        };
        format!("{sign}{body}")
    } else {
        let m = if digits.len() > 1 {
            format!("{}.{}", &digits[..1], &digits[1..])
        } else {
            digits.clone()
        };
        let es = if exp < 0 { '-' } else { '+' };
        format!("{sign}{m}e{es}{:02}", exp.abs())
    }
}

fn v_is_int(s: &str) -> bool {
    !s.bytes().any(|b| matches!(b, b'.' | b'e' | b'E'))
}

/// A string for diagnostics: JSON text, or the code-point form.
pub fn str_json(s: &PyStr) -> String {
    match s
        .0
        .iter()
        .map(|&c| char::from_u32(c))
        .collect::<Option<String>>()
    {
        Some(t) => orgtree_backend_codec::json::python_ascii_string(&t),
        None => format!(
            "{{\"\\u0000str\":[{}]}}",
            s.0.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
        ),
    }
}
