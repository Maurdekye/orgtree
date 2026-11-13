//! A save says what it was based on (docs/rust-engine/remote-org.md, "The
//! save that would replace a newer change"; decision 101).
//!
//! With the fields it changes, a window sends `expect`: for each of them the
//! value that field had when the edit started. The engine compares under the
//! same lock it writes under. When any is no longer what is stored it writes
//! nothing and answers 409 with what is stored now, who changed it and when.
//!
//! There is no force flag. "Save mine anyway" is a new save based on what is
//! stored now, so a third change in between is still caught. A save without
//! `expect` (an older window, an agent's tool) is not checked.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::GenericClient;

use super::undo::Coded;

/// The code of the refusal, beside `conflict` in the answer.
pub const CODE: &str = "save_conflict";
/// The most fields one save may name.
const MAX_FIELDS: usize = 64;
/// How far back the events are read for who changed a field: the newest of
/// that agent, or of that organization. Beyond it the answer says no name.
const WHO_WINDOW_AGENT: i64 = 500;
const WHO_WINDOW_ORG: i64 = 2000;

/// How a long text is named in `expect` instead of being sent back whole: the
/// first 16 hex digits of the SHA-256 of its UTF-8 bytes, `{"rev": "..."}`.
#[nolog]
pub fn rev(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..16].to_string()
}

/// The `expect` member of a save, taken out of its body: `None` when the save
/// names none, which checks nothing.
#[nolog]
pub fn take(body: &mut Map<String, Value>) -> std::result::Result<Option<Map<String, Value>>, String> {
    match body.remove("expect") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(fields)) if fields.len() <= MAX_FIELDS => Ok(Some(fields)),
        Some(Value::Object(_)) => Err(format!("expect names at most {MAX_FIELDS} fields")),
        Some(_) => Err("expect is an object: for each field this save changes, the value the edit started from".into()),
    }
}

/// The same, for a body held as a value: the body without `expect`, and it.
#[nolog]
pub fn split(body: &Value) -> std::result::Result<(Value, Option<Map<String, Value>>), String> {
    match body {
        Value::Object(map) if map.contains_key("expect") => {
            let mut map = map.clone();
            let expect = take(&mut map)?;
            Ok((Value::Object(map), expect))
        }
        other => Ok((other.clone(), None)),
    }
}

/// Is `stored` what the edit started from? A text may be named by its `rev`.
/// Numbers compare by value (80 and 80.0). Nothing is nothing however it is
/// spelled: null, an empty text, an empty list, an object with no members,
/// and a member that is not there.
#[nolog]
pub fn same(expected: &Value, stored: &Value) -> bool {
    if let Some(named) = expected.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("rev")).and_then(Value::as_str) {
        return match stored {
            Value::String(text) => named == rev(text),
            Value::Null => named == rev(""),
            _ => false,
        };
    }
    canonical(expected) == canonical(stored)
}

#[nolog]
fn canonical(value: &Value) -> Value {
    match value {
        // one spelling per number: an integer when it is one, else its float
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => json!(f as i64),
            Some(f) => json!((f * 1e9).round() / 1e9),
            None => value.clone(),
        },
        // a form holds "", [] or {} where nothing is stored
        Value::String(text) if text.is_empty() => Value::Null,
        Value::Array(items) if items.is_empty() => Value::Null,
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(members) => {
            let kept: Map<String, Value> = members.iter().map(|(k, v)| (k.clone(), canonical(v))).filter(|(_, v)| !v.is_null()).collect();
            if kept.is_empty() { Value::Null } else { Value::Object(kept) }
        }
        other => other.clone(),
    }
}

/// One field that is no longer what the edit started from.
#[derive(Debug, Clone, PartialEq)]
pub struct Changed {
    pub field: String,
    /// What is stored now, as a window is shown it.
    pub stored: Value,
    /// Who changed it last, when that is known.
    pub by: Option<Who>,
}

/// Who changed a field, from the event that recorded it.
#[derive(Debug, Clone, PartialEq)]
pub struct Who {
    /// `@user`, or an agent's name.
    pub actor: String,
    /// Which computer the user's change came through (`caller`), when recorded.
    pub via: Option<Value>,
    pub at: DateTime<Utc>,
}

/// Compare every expectation with what is stored: `shown(field)` is the
/// stored value as a window is shown it, or `None` for a field this save does
/// not have. Answers the fields that differ, in the order `expect` names them.
#[nolog]
pub fn differing(expect: &Map<String, Value>, shown: impl Fn(&str) -> Option<Value>) -> std::result::Result<Vec<Changed>, String> {
    let mut out = Vec::new();
    for (field, expected) in expect {
        let Some(stored) = shown(field) else {
            return Err(format!("expect names {field}, which is not a field of this save"));
        };
        if !same(expected, &stored) {
            out.push(Changed { field: field.clone(), stored, by: None });
        }
    }
    Ok(out)
}

/// The name a sentence gives who changed something: the label of the computer
/// a user's change came through, "Someone" for a user's change that names
/// none, or the agent.
#[nolog]
pub fn name_of(by: &Who) -> String {
    match (&by.via, by.actor.as_str()) {
        (Some(via), _) => via["name"].as_str().unwrap_or("Someone").to_string(),
        (None, "@user" | "user") => "Someone".to_string(),
        (None, agent) => agent.to_string(),
    }
}

/// The refusal: nothing was saved. `target` is `agent:<name>`, `org`,
/// `defaults`, `orgmd` or `instructions`.
#[nolog]
pub fn refusal(target: &str, changed: Vec<Changed>) -> Coded {
    let names: Vec<&str> = changed.iter().map(|c| c.field.as_str()).collect();
    let what = match names.as_slice() {
        [one] => (*one).to_string(),
        [first, rest @ ..] => format!("{first} and {} more", rest.len()),
        [] => "this".to_string(),
    };
    let who = changed.iter().find_map(|c| c.by.as_ref()).map(name_of);
    let detail = match who {
        Some(who) => format!("{who} changed {what} since you opened it. Nothing was saved."),
        None => format!("{what} changed since you opened it. Nothing was saved."),
    };
    let fields: Vec<Value> = changed.into_iter().map(|c| {
        let mut field = json!({ "field": c.field, "stored": c.stored, "actor": null, "changed_by": null, "changed_at": null });
        if let Some(by) = c.by {
            field["actor"] = json!(by.actor);
            field["changed_by"] = by.via.unwrap_or(Value::Null);
            field["changed_at"] = json!(crate::util::iso(by.at));
        }
        field
    }).collect();
    Coded { status: 409, code: CODE, detail, extra: json!({ "conflict": { "target": target, "fields": fields } }) }
}

/// Who last changed `field` of an agent: the newest `scope` or `retool` event
/// about it that changed the field. A user's save lists what it really
/// changed (`changed`: an older window sends its whole form); an event
/// without that list counts when its `change` names the field. Read only
/// when a save is refused.
#[logged]
pub async fn agent_changed_by(client: &impl GenericClient, agent_id: i64, field: &str) -> Result<Option<Who>> {
    let row = client.query_opt(
        "SELECT actor, via, at FROM (SELECT id, op, actor, via, at, detail FROM ot.events WHERE subject_agent_id = $1 ORDER BY id DESC LIMIT $3) e
          WHERE op IN ('scope', 'retool')
            AND CASE WHEN jsonb_typeof(detail->'changed') = 'array' THEN (detail->'changed') ? $2
                     ELSE jsonb_typeof(detail->'change') = 'object' AND (detail->'change') ? $2 END
          ORDER BY id DESC LIMIT 1",
        &[&agent_id, &field, &WHO_WINDOW_AGENT],
    ).await?;
    Ok(row.map(|r| Who { actor: r.get(0), via: r.get(1), at: r.get(2) }))
}

/// Who last changed an organization setting: the newest `settings` event
/// that names it (`org_renamed` for the name).
#[logged]
pub async fn org_changed_by(client: &impl GenericClient, org_id: i64, field: &str) -> Result<Option<Who>> {
    let row = client.query_opt(
        "SELECT actor, via, at FROM (SELECT id, op, actor, via, at, detail FROM ot.events WHERE org_id = $1 ORDER BY id DESC LIMIT $3) e
          WHERE (op = 'settings' AND detail ? $2) OR (op = 'org_renamed' AND $2 = 'org_name')
          ORDER BY id DESC LIMIT 1",
        &[&org_id, &field, &WHO_WINDOW_ORG],
    ).await?;
    Ok(row.map(|r| Who { actor: r.get(0), via: r.get(1), at: r.get(2) }))
}

/// Who saved the org.md that is there now: the newest `notes_saved` event of
/// the text with that revision. Connect your phone changes org.md with no
/// such event, and the answer then names nobody.
#[logged]
pub async fn notes_saved_by(client: &impl GenericClient, org_id: i64, rev: &str) -> Result<Option<Who>> {
    let row = client.query_opt(
        "SELECT actor, via, at FROM (SELECT id, op, actor, via, at, detail FROM ot.events WHERE org_id = $1 ORDER BY id DESC LIMIT $3) e
          WHERE op = 'notes_saved' AND detail->>'rev' = $2
          ORDER BY id DESC LIMIT 1",
        &[&org_id, &rev, &WHO_WINDOW_ORG],
    ).await?;
    Ok(row.map(|r| Who { actor: r.get(0), via: r.get(1), at: r.get(2) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_is_the_same_whatever_its_spelling() {
        assert!(same(&json!(80), &json!(80.0)));
        assert!(same(&json!(0.8), &json!(0.8000000000001)));
        assert!(!same(&json!(0.8), &json!(0.81)));
        assert!(same(&json!("high"), &json!("high")));
        assert!(!same(&json!("high"), &json!("max")));
        assert!(same(&Value::Null, &Value::Null));
        assert!(!same(&Value::Null, &json!("high")), "a field someone set since is not what the edit started from");
        assert!(same(&json!({ "bash": true, "mcp": [], "web": null }), &json!({ "mcp": [], "bash": true })), "member order and null members do not matter");
        assert!(!same(&json!({ "bash": true }), &json!({ "bash": false })));
        assert!(same(&json!([{ "path": "S:/a", "mode": "rw" }]), &json!([{ "mode": "rw", "path": "S:/a" }])));
        assert!(same(&json!(""), &Value::Null) && same(&Value::Null, &json!("")), "a form holds an empty text where nothing is stored");
        assert!(same(&json!({ "session": "" }), &json!({})));
        assert!(same(&json!({}), &Value::Null) && same(&json!([]), &Value::Null), "no override is no override");
        assert!(same(&json!({ "bash": true, "mcp": [] }), &json!({ "bash": true })));
        assert!(!same(&json!([]), &json!(["a"])));
        assert!(!same(&json!(""), &json!("x")));
        assert!(!same(&json!(["a", "b"]), &json!(["b", "a"])), "a list's order is part of it");
    }

    #[test]
    fn a_long_text_is_named_by_its_revision() {
        let charter = "You lead the far org.\nSecond line, with an accent: é.";
        assert_eq!(rev(charter).len(), 16);
        assert!(rev(charter).bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // the value every implementation must agree on (SHA-256 of the UTF-8 bytes, first 16 hex digits)
        assert_eq!(rev(""), "e3b0c44298fc1c14");
        assert_eq!(rev("abc"), "ba7816bf8f01cfea");
        assert!(same(&json!({ "rev": rev(charter) }), &json!(charter)));
        assert!(!same(&json!({ "rev": rev(charter) }), &json!(format!("{charter} "))));
        assert!(same(&json!({ "rev": rev("") }), &Value::Null), "no charter yet is the empty text");
        assert!(same(&json!(charter), &json!(charter)), "a text may also be sent back whole");
        assert!(!same(&json!({ "rev": rev("x") }), &json!(7)));
    }

    #[test]
    fn expect_is_taken_out_of_the_body_and_checked_field_by_field() {
        let mut body = json!({ "effort": "high", "expect": { "effort": "medium", "charter": { "rev": rev("old") } } }).as_object().unwrap().clone();
        let expect = take(&mut body).unwrap().unwrap();
        assert_eq!(Value::Object(body.clone()), json!({ "effort": "high" }), "the save itself never sees expect");
        assert_eq!(take(&mut body).unwrap(), None, "a save that names none is not checked");
        let stored = |field: &str| match field {
            "effort" => Some(json!("medium")),
            "charter" => Some(json!("new")),
            _ => None,
        };
        let changed = differing(&expect, stored).unwrap();
        assert_eq!(changed, vec![Changed { field: "charter".into(), stored: json!("new"), by: None }]);
        let unknown = json!({ "colour": "blue" }).as_object().unwrap().clone();
        assert!(differing(&unknown, stored).unwrap_err().contains("colour"));
        for bad in [json!({ "expect": "medium" }), json!({ "expect": ["effort"] })] {
            assert!(take(&mut bad.as_object().unwrap().clone()).is_err(), "{bad}");
        }
        let (rest, expect) = split(&json!({ "op": "scope", "effort": "high", "expect": { "effort": null } })).unwrap();
        assert_eq!((rest, expect.map(Value::Object)), (json!({ "op": "scope", "effort": "high" }), Some(json!({ "effort": null }))));
    }

    #[test]
    fn the_refusal_says_what_is_stored_who_changed_it_and_when() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-13T14:02:00Z").unwrap().with_timezone(&Utc);
        let sam = json!({ "id": "c-1", "name": "Sam", "on": "Orgtree desktop (PC2)" });
        let by_sam = refusal("agent:lead", vec![Changed { field: "charter".into(), stored: json!("theirs"), by: Some(Who { actor: "@user".into(), via: Some(sam.clone()), at }) }]);
        assert_eq!((by_sam.status, by_sam.code), (409, "save_conflict"));
        assert_eq!(by_sam.detail, "Sam changed charter since you opened it. Nothing was saved.");
        assert_eq!(by_sam.extra, json!({ "conflict": { "target": "agent:lead", "fields": [
            { "field": "charter", "stored": "theirs", "actor": "@user", "changed_by": sam, "changed_at": "2026-11-13T14:02:00.000Z" }] } }));
        let by_agent = refusal("agent:scout", vec![Changed { field: "effort".into(), stored: json!("max"), by: Some(Who { actor: "lead".into(), via: None, at }) }]);
        assert_eq!(by_agent.detail, "lead changed effort since you opened it. Nothing was saved.");
        assert_eq!(by_agent.extra["conflict"]["fields"][0]["actor"], "lead");
        // a user's change recorded before origins were, or one that came through no request
        let unnamed = refusal("org", vec![Changed { field: "default_effort".into(), stored: json!("max"), by: Some(Who { actor: "@user".into(), via: None, at }) }]);
        assert_eq!(unnamed.detail, "Someone changed default_effort since you opened it. Nothing was saved.");
        assert_eq!(unnamed.extra["conflict"]["fields"][0], json!({ "field": "default_effort", "stored": "max", "actor": "@user", "changed_by": null, "changed_at": "2026-11-13T14:02:00.000Z" }));
        let unknown = refusal("org", vec![Changed { field: "default_effort".into(), stored: json!("high"), by: None },
            Changed { field: "compact_at".into(), stored: json!(0.8), by: None }]);
        assert_eq!(unknown.detail, "default_effort and 1 more changed since you opened it. Nothing was saved.");
        assert_eq!(unknown.extra["conflict"]["fields"][1], json!({ "field": "compact_at", "stored": 0.8, "actor": null, "changed_by": null, "changed_at": null }));
    }
}
