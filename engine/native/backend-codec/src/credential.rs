//! The payload half of the engine-local agent credential.
//!
//! Source (engine/backend/orgtree/agentauth.py): `child_env` writes
//! `json.dumps([slug, nid, generation], separators=(',', ':'))`, encodes it
//! with URL-safe base64, strips `=` padding, then appends `.` and a hex
//! HMAC-SHA256 signature. `verify` checks the signature, restores padding,
//! decodes with Python's non-strict base64 decoder, parses the JSON and
//! requires `str, str, int` (`type(generation) is int`).
//!
//! This module handles only the payload text before the `.`. It does not
//! sign, verify signatures, hold a key or grant authority; a decoded payload
//! is a claim, not an authenticated identity.

use crate::json::{self, python_ascii_string, Limits, Profile, Value};
use std::fmt;

/// The (organization slug, node id, generation) tuple the payload carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialClaim {
    pub org: String,
    pub node: String,
    pub generation: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    /// `child_env` refuses a negative generation.
    NegativeGeneration,
    /// A byte outside the URL-safe base64 alphabet, including `=`.
    Alphabet,
    /// A length that is 1 more than a multiple of 4.
    Length,
    /// Nonzero unused bits in the final character.
    NonCanonicalBits,
    /// The decoded bytes are not UTF-8.
    Utf8,
    /// The decoded text is not strict JSON.
    Json,
    /// Not a three-element array of string, string, non-negative integer.
    Shape,
    /// Decodes to a claim, but encoding that claim does not give back the
    /// same payload text (for example extra JSON whitespace).
    NotReencoded,
}

impl CredentialError {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialError::NegativeGeneration => "negative_generation",
            CredentialError::Alphabet => "alphabet",
            CredentialError::Length => "length",
            CredentialError::NonCanonicalBits => "noncanonical_bits",
            CredentialError::Utf8 => "utf8",
            CredentialError::Json => "json",
            CredentialError::Shape => "shape",
            CredentialError::NotReencoded => "not_reencoded",
        }
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for CredentialError {}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn sextet(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn b64url_encode_unpadded(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// Decode unpadded URL-safe base64. `strict` refuses nonzero unused bits;
/// Python's non-strict decoder ignores them.
fn b64url_decode_unpadded(s: &str, strict: bool) -> Result<Vec<u8>, CredentialError> {
    let bytes = s.as_bytes();
    if bytes.len() % 4 == 1 {
        return Err(CredentialError::Length);
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &b) in chunk.iter().enumerate() {
            n |= u32::from(sextet(b).ok_or(CredentialError::Alphabet)?) << (18 - 6 * i);
        }
        let full = chunk.len() - 1; // output bytes in this chunk
        let unused = match chunk.len() {
            2 => n & 0xffff,
            3 => n & 0xff,
            _ => 0,
        };
        if strict && unused != 0 {
            return Err(CredentialError::NonCanonicalBits);
        }
        for i in 0..full {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Ok(out)
}

/// Encode the payload exactly as `agentauth.child_env` does. A negative
/// generation is refused like `child_env` refuses it.
pub fn encode_payload(org: &str, node: &str, generation: i64) -> Result<String, CredentialError> {
    if generation < 0 {
        return Err(CredentialError::NegativeGeneration);
    }
    let text = format!("[{},{},{}]", python_ascii_string(org), python_ascii_string(node), generation);
    Ok(b64url_encode_unpadded(text.as_bytes()))
}

fn claim_from(v: &Value) -> Option<CredentialClaim> {
    let Value::Array(items) = v else { return None };
    let [Value::String(org), Value::String(node), Value::Number(g)] = items.as_slice() else { return None };
    if !g.is_integer_lexeme() {
        return None;
    }
    Some(CredentialClaim { org: org.clone(), node: node.clone(), generation: g.to_i64()? })
}

/// Canonical decoding: only unpadded URL-safe base64 with zero unused bits,
/// strict JSON, the exact `[str,str,int]` shape, a generation that
/// `child_env` could have produced, and byte-identical re-encoding.
pub fn decode_payload_canonical(encoded: &str) -> Result<CredentialClaim, CredentialError> {
    let raw = b64url_decode_unpadded(encoded, true)?;
    let text = std::str::from_utf8(&raw).map_err(|_| CredentialError::Utf8)?;
    let v = json::parse(text, Profile::Strict, Limits::TEST).map_err(|_| CredentialError::Json)?;
    let claim = claim_from(&v).ok_or(CredentialError::Shape)?;
    if claim.generation < 0 {
        return Err(CredentialError::Shape);
    }
    if encode_payload(&claim.org, &claim.node, claim.generation)? != encoded {
        return Err(CredentialError::NotReencoded);
    }
    Ok(claim)
}

/// What Python `agentauth.verify` returns for this payload, assuming the
/// signature over it is valid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyVerify {
    Accepted(CredentialClaim),
    /// `verify` returns `None`.
    Rejected,
    /// Python accepts inputs this reproduction does not model. They are
    /// reported, never guessed.
    OutsideParityDomain(&'static str),
}

/// Reproduce `verify`'s payload handling. The parity domain is payload text
/// made only of the URL-safe alphabet, which is all `child_env` emits.
/// Outside it, Python's non-strict decoder discards unknown characters,
/// accepts `+`, `/` and `=`, and detects UTF-16/32 JSON; none of that is
/// reproduced (unresolved case `U-ID-2`).
pub fn decode_payload_legacy(encoded: &str) -> LegacyVerify {
    if !encoded.bytes().all(|b| sextet(b).is_some()) {
        return LegacyVerify::OutsideParityDomain("byte outside the url-safe alphabet");
    }
    let raw = match b64url_decode_unpadded(encoded, false) {
        Ok(r) => r,
        Err(_) => return LegacyVerify::Rejected, // binascii.Error is a ValueError
    };
    if raw.starts_with(&[0xef, 0xbb, 0xbf]) || raw.iter().take(4).any(|&b| b == 0) {
        return LegacyVerify::OutsideParityDomain("json.loads(bytes) encoding detection");
    }
    let text = match std::str::from_utf8(&raw) {
        Ok(t) => t,
        Err(_) => return LegacyVerify::OutsideParityDomain("json.loads(bytes) surrogatepass decoding"),
    };
    let v = match json::parse(text, Profile::PythonLegacy, Limits::TEST) {
        Ok(v) => v,
        Err(e) if e.kind == json::JsonErrorKind::LoneSurrogate => {
            return LegacyVerify::OutsideParityDomain("lone surrogate escape")
        }
        Err(e) if e.kind == json::JsonErrorKind::TooDeep || e.kind == json::JsonErrorKind::TooLarge => {
            return LegacyVerify::OutsideParityDomain("test bounds")
        }
        Err(_) => return LegacyVerify::Rejected, // JSONDecodeError is a ValueError
    };
    // `slug, nid, generation = value`: only a three-element array can pass
    // the later type checks (a string or an object of three members unpacks,
    // but its third element is then a string).
    if let Value::Array(items) = &v {
        if let [Value::String(_), Value::String(_), Value::Number(g)] = items.as_slice() {
            if g.is_integer_lexeme() && g.to_i64().is_none() {
                return LegacyVerify::OutsideParityDomain("integer generation outside i64");
            }
        }
    }
    match claim_from(&v) {
        Some(c) => LegacyVerify::Accepted(c),
        None => LegacyVerify::Rejected,
    }
}
