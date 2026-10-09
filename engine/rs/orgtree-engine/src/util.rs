//! Small shared helpers: timestamps, ids, slugs, JSON conveniences.

use chrono::{DateTime, SecondsFormat, Utc};
use rand::Rng;
use serde_json::Value;

/// Every timestamp the engine emits: UTC, millisecond precision, `Z` —
/// the same shape as JavaScript's `toISOString()`, so string order is time
/// order across the whole wire.
pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn iso_opt(t: Option<DateTime<Utc>>) -> Value {
    match t {
        Some(t) => Value::String(iso(t)),
        None => Value::Null,
    }
}

/// A bundled executable's file name on this platform (`postgres` ->
/// `postgres.exe` on Windows, unchanged elsewhere).
#[logged]
pub fn exe_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

pub fn now_iso() -> String {
    iso(Utc::now())
}

pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    if s.is_empty() {
        return None;
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.with_timezone(&Utc));
    }
    // tolerate "2026-10-06T12:34:56" (no zone = UTC) and "... +00:00" spaced forms
    let fixed = s.replace(' ', "T");
    if let Ok(t) = DateTime::parse_from_rfc3339(&format!("{fixed}Z")) {
        return Some(t.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(&fixed, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|n| DateTime::from_naive_utc_and_offset(n, Utc))
}

/// A short random id with a readable prefix (`m3f9a1c0d2b7e`).
pub fn uid(prefix: &str) -> String {
    let mut rng = rand::thread_rng();
    let n: u64 = rng.gen();
    format!("{prefix}{:012x}", n & 0xffff_ffff_ffff)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill(&mut buf[..]);
    hex::encode(buf)
}

/// Slug from a title: lowercase ascii words joined by '-', at most `max`
/// characters, never empty.
pub fn slugify(title: &str, max: usize) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            dash = true;
        }
        if out.len() >= max {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "item".to_string()
    } else {
        out
    }
}

pub fn json_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub fn json_bool(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}

pub fn json_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

pub fn json_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// Collapse whitespace and cap a one-line gist.
pub fn gist(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut s: String = flat.chars().take(max.saturating_sub(1)).collect();
        s.push('…');
        s
    }
}

pub fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}


/// PostgreSQL UTF-8 text/jsonb reject U+0000. Rust strings cannot contain lone
/// UTF-16 surrogates or invalid UTF-8; preserve all other scalar values.
#[nolog]
pub fn pg_text(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('\0') { std::borrow::Cow::Owned(text.replace('\0', "")) }
    else { std::borrow::Cow::Borrowed(text) }
}

#[nolog]
fn json_has_nul(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(a) => a.iter().any(json_has_nul),
        Value::Object(o) => o.iter().any(|(k,v)| k.contains('\0') || json_has_nul(v)),
        _ => false,
    }
}

/// Mutate owned JSON without allocating for clean input or string values.
/// On key collisions retain the existing clean spelling deterministically.
#[nolog]
pub fn pg_json_mut(value: &mut Value) {
    match value {
        Value::String(s) => { if s.contains('\0') { s.retain(|c| c != '\0'); } }
        Value::Array(a) => { for v in a { pg_json_mut(v); } }
        Value::Object(o) => {
            for v in o.values_mut() { pg_json_mut(v); }
            if o.keys().any(|k| k.contains('\0')) {
                let bad: Vec<String> = o.keys().filter(|k| k.contains('\0')).cloned().collect();
                for key in bad {
                    if let Some(v) = o.remove(&key) { o.entry(key.replace('\0', "")).or_insert(v); }
                }
            }
        }
        _ => {}
    }
}

#[nolog]
pub fn pg_json(value: &Value) -> std::borrow::Cow<'_, Value> {
    if !json_has_nul(value) { return std::borrow::Cow::Borrowed(value); }
    let mut clean = value.clone(); pg_json_mut(&mut clean);
    std::borrow::Cow::Owned(clean)
}

#[nolog]
pub fn pg_json_option(value: &Option<Value>) -> std::borrow::Cow<'_, Option<Value>> {
    if !value.as_ref().map(json_has_nul).unwrap_or(false) { return std::borrow::Cow::Borrowed(value); }
    let mut clean = value.clone(); if let Some(v) = &mut clean { pg_json_mut(v); }
    std::borrow::Cow::Owned(clean)
}

#[nolog]
pub fn pg_text_option(value: &Option<String>) -> std::borrow::Cow<'_, Option<String>> {
    if !value.as_ref().map(|s| s.contains('\0')).unwrap_or(false) { return std::borrow::Cow::Borrowed(value); }
    std::borrow::Cow::Owned(value.as_ref().map(|s| s.replace('\0', "")))
}
