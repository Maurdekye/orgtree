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

/// Reply targets accepted by the agent message tools. Strings retain the
/// legacy mail-id form; objects carry identity only and are resolved against
/// the current organization before any delivery is admitted.
#[nolog]
pub fn targets(first: Option<&Value>, list: Option<&Value>) -> Result<Vec<Value>> {
    let parse = |v: &Value| -> Result<Value> {
        match v {
            Value::String(id) if valid_id(id) => Ok(v.clone()),
            Value::Object(_) if valid_target(v) => Ok(v.clone()),
            _ => crate::refuse!(BadRequest, "reply targets must be bounded mail IDs or qualified document, docket or transcript identities"),
        }
    };
    let Some(list) = list.filter(|v| !v.is_null()) else {
        return match first.filter(|v| !v.is_null()) {
            Some(v) => Ok(vec![parse(v)?]),
            None => Ok(Vec::new()),
        };
    };
    let Some(items) = list.as_array().filter(|items| !items.is_empty() && items.len() <= MAX_REPLIES) else {
        crate::refuse!(BadRequest, "replies needs 1 to 50 qualified targets");
    };
    let mut out = Vec::new();
    for item in items {
        let target = parse(item)?;
        if !out.contains(&target) { out.push(target); }
    }
    if first.filter(|v| !v.is_null()).is_some_and(|v| out.first() != Some(v)) {
        crate::refuse!(BadRequest, "reply_to must match the first replies target");
    }
    Ok(out)
}

#[nolog]
fn valid_target(target: &Value) -> bool {
    let Some(object) = target.as_object() else { return false };
    if let Some(source) = object.get("source_event_ref") {
        let Some(source) = source.as_object() else { return false };
        return object.keys().all(|k| ["source_event_ref", "mail_id"].contains(&k.as_str()))
            && source.keys().all(|k| ["org", "agent", "generation", "eventId"].contains(&k.as_str()))
            && ["org", "agent", "eventId"].iter().all(|k| source.get(*k).and_then(Value::as_str).is_some_and(valid_id))
            && source.get("generation").and_then(Value::as_i64).is_some_and(|n| n > 0)
            && object.get("mail_id").is_none_or(|v| v.as_str().is_some_and(valid_id));
    }
    let kind = object.get("kind").and_then(Value::as_str);
    match kind {
        Some("document" | "presentation") => object.keys().all(|k| ["kind", "org", "id"].contains(&k.as_str()))
            && object.get("org").and_then(Value::as_str).is_some_and(valid_id)
            && object.get("id").and_then(Value::as_str).is_some_and(valid_id),
        Some("work_item") => object.keys().all(|k| ["kind", "org", "slug"].contains(&k.as_str()))
            && object.get("org").and_then(Value::as_str).is_some_and(valid_id)
            && object.get("slug").and_then(Value::as_str).is_some_and(valid_id),
        _ => false,
    }
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
pub fn dedupe(quotes:&mut Vec<Value>) {
    let mut seen=std::collections::HashSet::new();
    quotes.retain(|q| seen.insert(if q.get("source_event_ref").is_some() {
        json!([q["source_event_ref"],q["mail_id"]]).to_string()
    } else { json!([q["org"],q["kind"],q["id"],q["net_id"]]).to_string() }));
}

/// Quote visible event content, never the enveloped model prompt. A delivered
/// turn may contain mail from several senders; a card id selects its own row.
#[nolog]
pub fn event_context(body:&Value,agent:&str,mail_id:Option<&str>) -> Result<(String,String)> {
    let segments=body["segments"].as_array();
    let rows:Vec<&Value>=segments.into_iter().flatten().filter(|s| s["kind"]=="mail")
        .flat_map(|s| s["rows"].as_array().into_iter().flatten()).collect();
    if let Some(id)=mail_id {
        let Some(row)=rows.iter().find(|r| r["id"].as_str()==Some(id)) else { crate::refuse!(NotFound,"that mail card is not part of this event"); };
        return Ok((row["from"].as_str().unwrap_or("@system").into(),row["body"].as_str().unwrap_or("").into()));
    }
    if body["role"]=="user" && segments.is_some() {
        let mut senders=std::collections::HashSet::new();
        let mut parts=Vec::new();
        for s in segments.into_iter().flatten() {
            match s["kind"].as_str() {
                Some("mail") => for row in s["rows"].as_array().into_iter().flatten() {
                    let from=row["from"].as_str().unwrap_or("@system");
                    senders.insert(from); parts.push(row["body"].as_str().unwrap_or(""));
                },
                Some("text") => parts.push(s["text"].as_str().unwrap_or("")),
                Some("notices") => for row in s["rows"].as_array().into_iter().flatten() { parts.push(row["text"].as_str().unwrap_or("")); },
                // Machine state/drive context is not reply prose.
                _=>{},
            }
        }
        // An aggregate user turn has no single author; individual cards above
        // keep their own sender. Sender metadata never determines routing.
        let sender=if senders.len()==1 { senders.into_iter().next().unwrap_or("@user") } else { "@user" };
        return Ok((sender.into(),parts.join("\n\n")));
    }
    let sender=if body["role"]=="user" { "@user" } else { agent };
    let text=body["cmd_out"].as_str().or_else(|| body["text"].as_str()).or_else(|| body["thinking"].as_str()).unwrap_or("Recorded event");
    Ok((sender.into(),text.into()))
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
    fn typed_targets_are_identity_only_and_preserve_legacy_ids() {
        let document=json!({"kind":"document","org":"demo","id":"d1"});
        let docket=json!({"kind":"work_item","org":"demo","slug":"release"});
        let transcript=json!({"source_event_ref":{"org":"demo","agent":"writer","generation":2,"eventId":"e42"}});
        assert_eq!(targets(Some(&document),None).unwrap(),vec![document.clone()]);
        assert_eq!(targets(Some(&json!("mail-1")),Some(&json!(["mail-1",document.clone(),docket,transcript]))).unwrap(),
            vec![json!("mail-1"),document,json!({"kind":"work_item","org":"demo","slug":"release"}),json!({"source_event_ref":{"org":"demo","agent":"writer","generation":2,"eventId":"e42"}})]);
        for bad in [json!({"kind":"document","org":"demo","id":"d1","gist":"untrusted"}), json!({"source_event_ref":{"org":"demo","agent":"writer","generation":0,"eventId":"e42"}}), json!({"kind":"work_item","org":"demo","slug":""}), json!({"kind":"mail","org":"demo","id":"mail-1"})] {
            assert!(targets(Some(&bad),None).is_err(),"{bad}");
        }
        assert!(targets(Some(&json!("a")),Some(&json!(["b"]))).is_err());
    }
    #[test]
    fn fallback_keeps_all_context_and_first_link() {
        let quotes=vec![json!({"net_id":"a","gist":"one\nmore"}),json!({"net_id":"b","gist":"two"})];
        let (body,meta)=wire("answer",&quotes).unwrap();
        assert_eq!(body,"> one\n> two\nanswer");
        assert_eq!(meta.unwrap(),json!({"replies":["a","b"],"fallback":[0,12]}));
        assert!(wire("answer",&[quotes[0].clone(),json!({"id":"internal"})]).is_err());
    }
    #[test]
    fn event_quotes_use_visible_mail_and_authoritative_sender() {
        let event=json!({"role":"user","text":"HIDDEN envelope","segments":[{"kind":"state","text":"HIDDEN state"},{"kind":"mail","rows":[{"id":"a","from":"writer","body":"one"},{"id":"b","from":"other","body":"two"}]}]});
        assert_eq!(event_context(&event,"reader",Some("a")).unwrap(),("writer".into(),"one".into()));
        assert_eq!(event_context(&event,"reader",None).unwrap(),("@user".into(),"one\n\ntwo".into()));
        assert!(event_context(&event,"reader",Some("missing")).is_err());
    }
}
