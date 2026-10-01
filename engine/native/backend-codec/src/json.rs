//! A small JSON reader for codec boundaries.
//!
//! It keeps object member order, the exact text of every number, and the
//! difference between a member that is absent and one that is `null`. It never
//! converts a number to a float on its own; callers choose an exact decoder.
//!
//! Two profiles exist:
//!
//! * [`Profile::Strict`] refuses duplicate member names and the non-standard
//!   `NaN`/`Infinity`/`-Infinity` tokens. Everything it accepts is also
//!   accepted by Python's `json.loads`, with the same meaning.
//! * [`Profile::PythonLegacy`] reproduces what Python 3.13 `json.loads(str)`
//!   accepts at the current backend doors: duplicate names keep the first
//!   member's position with the last member's value, and the three non-finite
//!   tokens are accepted. It exists to characterize legacy input, not to
//!   define a new format.
//!
//! Both profiles refuse an unpaired UTF-16 surrogate escape (`"\ud800"`).
//! Python accepts one, but a Rust `String` cannot hold it. That difference is
//! recorded as unresolved case `U-JSON-1`, never silently repaired.

use crate::presence::Presence;
use std::fmt;

/// Which acceptance rules to apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Strict,
    PythonLegacy,
}

/// Input bounds, checked before and during parsing. No production value is
/// chosen here; callers state their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_depth: usize,
}

impl Limits {
    /// Bounds used by the local test driver and the vectors. They are test
    /// bounds only, not a production admission limit.
    pub const TEST: Limits = Limits { max_bytes: 1 << 20, max_depth: 64 };
}

/// A number exactly as written. `Finite` holds text that matched the JSON
/// number grammar; the non-finite variants exist only under
/// [`Profile::PythonLegacy`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Number {
    Finite(String),
    NaN,
    Infinity,
    NegInfinity,
}

impl Number {
    /// True for a finite lexeme with no fraction and no exponent, which is the
    /// set Python's JSON decoder turns into `int` rather than `float`.
    pub fn is_integer_lexeme(&self) -> bool {
        match self {
            Number::Finite(s) => !s.bytes().any(|b| matches!(b, b'.' | b'e' | b'E')),
            _ => false,
        }
    }

    /// The value Python's decoder would produce as a `float`. Rust's `f64`
    /// parser is correctly rounded like CPython's, including overflow to
    /// infinity for text such as `1e400`.
    pub fn to_f64(&self) -> f64 {
        match self {
            Number::Finite(s) => s.parse::<f64>().unwrap_or(f64::NAN),
            Number::NaN => f64::NAN,
            Number::Infinity => f64::INFINITY,
            Number::NegInfinity => f64::NEG_INFINITY,
        }
    }

    /// The exact integer for an integer lexeme inside `i64`, else `None`.
    pub fn to_i64(&self) -> Option<i64> {
        match self {
            Number::Finite(s) if self.is_integer_lexeme() => s.parse::<i64>().ok(),
            _ => None,
        }
    }

    pub fn lexeme(&self) -> &str {
        match self {
            Number::Finite(s) => s,
            Number::NaN => "NaN",
            Number::Infinity => "Infinity",
            Number::NegInfinity => "-Infinity",
        }
    }
}

/// An object with members in document order.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Object {
    members: Vec<(String, Value)>,
}

impl Object {
    pub fn members(&self) -> &[(String, Value)] {
        &self.members
    }

    /// Absent, null or present — three different answers, never collapsed.
    pub fn get(&self, key: &str) -> Presence<&Value> {
        match self.members.iter().find(|(k, _)| k == key) {
            None => Presence::Absent,
            Some((_, Value::Null)) => Presence::Null,
            Some((_, v)) => Presence::Present(v),
        }
    }

    pub fn len(&self) -> usize {
        self.members.len()
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonErrorKind {
    TooLarge,
    TooDeep,
    Syntax,
    DuplicateKey,
    NonFiniteConstant,
    LoneSurrogate,
    ControlCharacter,
    TrailingData,
    ByteOrderMark,
    /// An integer literal longer than CPython's default
    /// `sys.int_info.default_max_str_digits`, refused in both profiles.
    IntegerDigitLimit,
}

/// CPython 3.13 `sys.int_info.default_max_str_digits`.
pub const PYTHON_INT_MAX_STR_DIGITS: usize = 4300;

impl JsonErrorKind {
    /// Stable lowercase name used by the vectors.
    pub fn as_str(self) -> &'static str {
        match self {
            JsonErrorKind::TooLarge => "too_large",
            JsonErrorKind::TooDeep => "too_deep",
            JsonErrorKind::Syntax => "syntax",
            JsonErrorKind::DuplicateKey => "duplicate_key",
            JsonErrorKind::NonFiniteConstant => "nonfinite_constant",
            JsonErrorKind::LoneSurrogate => "lone_surrogate",
            JsonErrorKind::ControlCharacter => "control_character",
            JsonErrorKind::TrailingData => "trailing_data",
            JsonErrorKind::ByteOrderMark => "byte_order_mark",
            JsonErrorKind::IntegerDigitLimit => "integer_digit_limit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JsonError {
    pub kind: JsonErrorKind,
    /// Byte offset into the input where the problem was found.
    pub offset: usize,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.kind.as_str(), self.offset)
    }
}

impl std::error::Error for JsonError {}

/// Parse one complete JSON text.
pub fn parse(text: &str, profile: Profile, limits: Limits) -> Result<Value, JsonError> {
    if text.len() > limits.max_bytes {
        return Err(JsonError { kind: JsonErrorKind::TooLarge, offset: limits.max_bytes });
    }
    if text.starts_with('\u{feff}') {
        // Python's json.loads(str) refuses a leading BOM too.
        return Err(JsonError { kind: JsonErrorKind::ByteOrderMark, offset: 0 });
    }
    let mut p = Parser { s: text.as_bytes(), text, i: 0, profile, limits };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err(JsonErrorKind::TrailingData));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
    profile: Profile,
    limits: Limits,
}

impl Parser<'_> {
    fn err(&self, kind: JsonErrorKind) -> JsonError {
        JsonError { kind, offset: self.i }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.s[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        match self.peek() {
            None => Err(self.err(JsonErrorKind::Syntax)),
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') if self.eat("true") => Ok(Value::Bool(true)),
            Some(b'f') if self.eat("false") => Ok(Value::Bool(false)),
            Some(b'n') if self.eat("null") => Ok(Value::Null),
            Some(b'N') if self.s[self.i..].starts_with(b"NaN") => self.nonfinite("NaN", Number::NaN),
            Some(b'I') if self.s[self.i..].starts_with(b"Infinity") => {
                self.nonfinite("Infinity", Number::Infinity)
            }
            Some(b'-') if self.s[self.i..].starts_with(b"-Infinity") => {
                self.nonfinite("-Infinity", Number::NegInfinity)
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err(JsonErrorKind::Syntax)),
        }
    }

    fn nonfinite(&mut self, lit: &str, n: Number) -> Result<Value, JsonError> {
        if self.profile == Profile::Strict {
            return Err(self.err(JsonErrorKind::NonFiniteConstant));
        }
        self.i += lit.len();
        Ok(Value::Number(n))
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.err(JsonErrorKind::Syntax)),
        }
        // Like Python's scanner, a fraction or exponent is only consumed when
        // complete; "1." leaves "." behind, which is then trailing data.
        if self.peek() == Some(b'.') && matches!(self.s.get(self.i + 1), Some(b'0'..=b'9')) {
            self.i += 1;
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let save = self.i;
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                self.i = save;
            }
        }
        let lexeme = &self.text[start..self.i];
        let n = Number::Finite(lexeme.to_owned());
        if n.is_integer_lexeme() && lexeme.trim_start_matches('-').len() > PYTHON_INT_MAX_STR_DIGITS {
            // CPython 3.11+ refuses int text longer than its default limit.
            // Strict refuses it too, so Strict accepts only texts the current
            // Python doors also accept.
            return Err(JsonError { kind: JsonErrorKind::IntegerDigitLimit, offset: start });
        }
        Ok(Value::Number(n))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let mut v = 0u32;
        for _ in 0..4 {
            let d = match self.peek() {
                Some(c @ b'0'..=b'9') => c - b'0',
                Some(c @ b'a'..=b'f') => c - b'a' + 10,
                Some(c @ b'A'..=b'F') => c - b'A' + 10,
                _ => return Err(self.err(JsonErrorKind::Syntax)),
            };
            v = v * 16 + u32::from(d);
            self.i += 1;
        }
        Ok(v)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let run = self.i;
            while let Some(c) = self.peek() {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            // `run..i` ends on an ASCII byte, so it is a char boundary.
            out.push_str(&self.text[run..self.i]);
            match self.peek() {
                None => return Err(self.err(JsonErrorKind::Syntax)),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(c) if c < 0x20 => return Err(self.err(JsonErrorKind::ControlCharacter)),
                Some(_) => {
                    let at = self.i;
                    self.i += 1;
                    let c = match self.peek() {
                        Some(b'"') => '"',
                        Some(b'\\') => '\\',
                        Some(b'/') => '/',
                        Some(b'b') => '\u{8}',
                        Some(b'f') => '\u{c}',
                        Some(b'n') => '\n',
                        Some(b'r') => '\r',
                        Some(b't') => '\t',
                        Some(b'u') => {
                            self.i += 1;
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if self.s[self.i..].starts_with(b"\\u") {
                                    let save = self.i;
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                                    } else {
                                        self.i = save;
                                        return Err(JsonError { kind: JsonErrorKind::LoneSurrogate, offset: at });
                                    }
                                } else {
                                    return Err(JsonError { kind: JsonErrorKind::LoneSurrogate, offset: at });
                                }
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(JsonError { kind: JsonErrorKind::LoneSurrogate, offset: at });
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).expect("non-surrogate scalar"));
                            continue;
                        }
                        _ => return Err(self.err(JsonErrorKind::Syntax)),
                    };
                    self.i += 1;
                    out.push(c);
                }
            }
        }
    }

    fn enter(&self, depth: usize) -> Result<(), JsonError> {
        if depth > self.limits.max_depth {
            Err(self.err(JsonErrorKind::TooDeep))
        } else {
            Ok(())
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.enter(depth)?;
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.err(JsonErrorKind::Syntax)),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.enter(depth)?;
        self.i += 1;
        let mut obj = Object::default();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Value::Object(obj));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.err(JsonErrorKind::Syntax));
            }
            let at = self.i;
            let key = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(self.err(JsonErrorKind::Syntax));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth)?;
            match obj.members.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => {
                    if self.profile == Profile::Strict {
                        return Err(JsonError { kind: JsonErrorKind::DuplicateKey, offset: at });
                    }
                    // Python dict semantics: first position, last value.
                    slot.1 = v;
                }
                None => obj.members.push((key, v)),
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Object(obj));
                }
                _ => return Err(self.err(JsonErrorKind::Syntax)),
            }
        }
    }
}

/// Encode a string the way Python's `json.dumps` does with its default
/// `ensure_ascii=True`: every character outside space..tilde is escaped, with
/// lowercase hex and UTF-16 surrogate pairs for astral characters.
pub fn python_ascii_string(s: &str) -> String {
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
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{:04x}", u));
                }
            }
        }
    }
    out.push('"');
    out
}
