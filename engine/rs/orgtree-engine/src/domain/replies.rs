//! Additive multi-reply references. The legacy first snapshot is unchanged;
//! qualified immutable snapshots carry every target without trusting body text.
use anyhow::Result;
use serde_json::{json, Value};

pub const MAX_REPLIES: usize = 50;
pub const MAX_ID: usize = 200;
pub const META_MAX: usize = 4096;

#[nolog]
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID && !id.chars().any(char::is_control)
}

/// A supplied list is strict: malformed input never silently drops a target.
#[nolog]
pub fn ids(first: Option<&str>, list: Option<&Value>) -> Result<Vec<String>> {
    let Some(v) = list.filter(|v| !v.is_null()) else {
        return match first { Some(id) if valid_id(id) => Ok(vec![id.into()]), None => Ok(vec![]), _ => crate::refuse!(BadRequest, "reply_to needs a bounded message id") };
    };
    let Some(a) = v.as_array().filter(|a| !a.is_empty() && a.len() <= MAX_REPLIES) else {
        crate::refuse!(BadRequest, "replies needs 1 to 50 message ids");
    };
    let mut out = Vec::new();
    for x in a {
        let Some(id) = x.as_str().filter(|s| valid_id(s)) else { crate::refuse!(BadRequest, "replies needs message ids of 1 to 200 characters, with no control characters"); };
        if !out.iter().any(|s| s == id) { out.push(id.to_string()); }
    }
    if first.is_some_and(|id| out.first().map(String::as_str) != Some(id)) { crate::refuse!(BadRequest, "reply_to must match the first replies id"); }
    Ok(out)
}

/// Incoming metadata is untrusted. Invalid extra references fall back to the
/// legacy first reference; never recover references from arbitrary quote lines.
#[nolog]
pub fn incoming(first: Option<&str>, meta: Option<&Value>) -> Vec<String> {
    let fallback = || first.filter(|s| valid_id(s)).map(|s| vec![s.into()]).unwrap_or_default();
    let Some(v) = meta.filter(|m| m.is_object() && serde_json::to_vec(m).is_ok_and(|b| b.len() <= META_MAX)).and_then(|m| m.get("replies")) else { return fallback(); };
    match ids(first, Some(v)) {
        Ok(list) if list.len() >= 2 && first == list.first().map(String::as_str) => list,
        _ => fallback(),
    }
}

/// Old rows normalize on read, without rewriting inactive history.
#[nolog]
pub fn snapshots(first: Option<&Value>, list: Option<&Value>) -> Vec<Value> {
    match list.and_then(Value::as_array).filter(|a| !a.is_empty()) {
        Some(a) => a.iter().filter(|v| v.is_object()).take(MAX_REPLIES).cloned().collect(),
        None => first.filter(|v| v.is_object()).cloned().into_iter().collect(),
    }
}

#[nolog]
pub fn value(first: Option<&Value>, list: Option<&Value>) -> Value {
    Value::Array(snapshots(first, list))
}

#[nolog]
pub fn same_sender(quotes:&[Value]) -> Result<()> {
    let sender=|q:&Value| q.get("sender").or_else(|| q.get("from")).and_then(Value::as_str)
        .or_else(|| q.pointer("/source_event_ref/agent").and_then(Value::as_str)).map(str::to_owned);
    let first=quotes.first().and_then(sender);
    if quotes.len()>1 && (first.is_none() || quotes.iter().any(|q| sender(q)!=first)) {
        crate::refuse!(BadRequest,"a multi-reply can only answer messages from the same sender; nothing was sent");
    }
    Ok(())
}

/// Keep the first link and all context on clients/hubs without `meta`.
/// The fallback is the existing Hubchat plain multi-reply prefix contract.
#[nolog]
pub fn wire(body: &str, quotes: &[Value]) -> Result<(String, Option<Value>)> {
    if quotes.len() < 2 { return Ok((body.into(), None)); }
    let mut references = Vec::new();
    let mut prefix = String::new();
    for q in quotes {
        let Some(id) = q["net_id"].as_str().filter(|s| valid_id(s)) else { crate::refuse!(BadRequest, "every hub multi-reply target must have a hub message id"); };
        if references.iter().any(|s| s == id) { continue; }
        references.push(id.to_string());
        let text = q["gist"].as_str().unwrap_or("Original message unavailable").lines().next().unwrap_or("");
        prefix.push_str("> "); prefix.extend(text.chars().take(120)); prefix.push('\n');
    }
    if references.len() < 2 { return Ok((body.into(), None)); }
    let meta = json!({"replies":references,"fallback":[0,prefix.len()]});
    if serde_json::to_vec(&meta)?.len() > META_MAX { crate::refuse!(BadRequest, "reply metadata exceeds 4096 bytes; split this reply"); }
    Ok((format!("{prefix}{body}"), Some(meta)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plural_ids_are_bounded_and_first_matches() {
        assert_eq!(ids(Some("a"),Some(&json!(["a","b","a"]))).unwrap(),vec!["a","b"]);
        for list in [json!([]),json!(["b","a"]),json!(["a",3]),json!(["a","bad\n"]),json!(vec!["a";51])] { assert!(ids(Some("a"),Some(&list)).is_err()); }
        assert_eq!(incoming(Some("a"),Some(&json!({"replies":["b","a"]}))),vec!["a"]);
        assert_eq!(snapshots(Some(&json!({"id":"old"})),Some(&json!([]))),vec![json!({"id":"old"})]);
    }
    #[test]
    fn fallback_keeps_all_context_and_first_link() {
        let quotes=vec![json!({"net_id":"a","gist":"one\nmore"}),json!({"net_id":"b","gist":"two"})];
        let (body,meta)=wire("answer",&quotes).unwrap();
        assert_eq!(body,"> one\n> two\nanswer");
        assert_eq!(meta.unwrap(),json!({"replies":["a","b"],"fallback":[0,12]}));
        assert!(wire("answer",&[quotes[0].clone(),json!({"id":"internal"})]).is_err());
    }
}
