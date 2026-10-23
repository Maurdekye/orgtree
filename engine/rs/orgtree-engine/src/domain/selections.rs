//! Verified reply selections. Offsets refer to one authorized canonical source
//! part, never DOM text or a model envelope. Text-bearing helpers are not logged.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_SELECTIONS: usize = 8;
pub const MAX_EXCERPT: usize = 4096;
pub const MAX_CONTEXT: usize = 256;
pub const MAX_METADATA: usize = 48 * 1024;
pub const MAX_WINDOW: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub part: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub part: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<usize>,
    pub projection: String,
    pub expected_sha256: String,
    pub unit: String,
    pub start: usize,
    pub end: usize,
}

#[nolog]
impl Selector {
    pub fn part(&self) -> Part {
        Part { part: self.part.clone(), tool_id: self.tool_id.clone(), pointer: self.pointer.clone(),
            role: self.role.clone(), entry: self.entry }
    }
    pub fn parse(value: &Value) -> Result<Self> {
        let out: Self = serde_json::from_value(value.clone())
            .map_err(|_| super::user_err(super::UserError::BadRequest, "selection needs a valid bounded source-v1 range"))?;
        out.part().validate()?;
        if out.projection != "source-v1" || out.unit != "unicode-scalar" || out.start >= out.end
            || out.end - out.start > MAX_EXCERPT
            || out.expected_sha256.len() != 64
            || !out.expected_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            crate::refuse!(BadRequest, "selection needs source-v1, unicode-scalar, a lowercase SHA256 and a nonempty bounded range");
        }
        Ok(out)
    }
}

#[nolog]
impl Part {
    pub fn parse(value: &Value) -> Result<Self> {
        let out: Self = serde_json::from_value(value.clone())
            .map_err(|_| super::user_err(super::UserError::BadRequest, "source needs a known part selector"))?;
        out.validate()?;
        Ok(out)
    }
    pub fn validate(&self) -> Result<()> {
        let tool = matches!(self.part.as_str(), "tool.input" | "tool.result" | "tool.error");
        let entry = matches!(self.part.as_str(), "work_item.done_so_far" | "work_item.working_on_next" | "work_item.evidence.note");
        if !matches!(self.part.as_str(), "text" | "thinking" | "cmd_out" | "tool.input" | "tool.result" | "tool.error"
            | "mail.body" | "document.body" | "document.title" | "work_item.title" | "work_item.objective"
            | "work_item.blocked_reason" | "work_item.dropped_reason" | "work_item.done_so_far"
            | "work_item.working_on_next" | "work_item.evidence.note")
            || tool != self.tool_id.is_some() || entry != self.entry.is_some()
            || self.tool_id.as_ref().is_some_and(|s| s.is_empty() || s.len() > 200 || s.chars().any(char::is_control))
            || self.entry.is_some_and(|n| n >= 50)
            || (self.pointer.is_some() || self.role.is_some()) && !matches!(self.part.as_str(),"tool.input"|"tool.result")
            || self.pointer.as_ref().is_some_and(|s| s.len() > 1024 || !s.is_empty() && !s.starts_with('/')
                || s.chars().any(char::is_control) || s.split('~').skip(1).any(|p| !p.starts_with(['0','1'])))
            || self.role.as_ref().is_some_and(|s| s != "key" && s != "value")
            || self.role.as_deref() == Some("key") && self.pointer.as_deref().is_none_or(str::is_empty) {
            crate::refuse!(BadRequest, "unknown source part or incompatible tool, pointer, role or entry selector");
        }
        Ok(())
    }
}

/// Digest the exact UTF-8 source bytes: no whitespace or newline normalization.
#[nolog]
pub fn digest(text: &str) -> String { format!("{:x}", Sha256::digest(text.as_bytes())) }

#[nolog]
fn byte_at(text: &str, scalar: usize) -> Option<usize> {
    text.char_indices().map(|(n, _)| n).chain(std::iter::once(text.len())).nth(scalar)
}

#[nolog]
fn range(text: &str, start: usize, end: usize) -> Option<&str> {
    text.get(byte_at(text, start)?..byte_at(text, end)?)
}

#[nolog]
fn prefix(text: &str) -> String {
    let mut bytes = 0;
    text.chars().rev().take_while(|c| { bytes += c.len_utf8(); bytes <= MAX_CONTEXT }).collect::<String>().chars().rev().collect()
}

#[nolog]
fn suffix(text: &str) -> String {
    let mut bytes = 0;
    text.chars().take_while(|c| { bytes += c.len_utf8(); bytes <= MAX_CONTEXT }).collect()
}

/// Validate at send time, then derive an immutable exact quote from storage.
/// `revision` is diagnostic; the part digest protects against unrelated edits.
#[nolog]
pub fn capture(text: &str, selector: &Selector, revision: &Value) -> Result<Value> {
    if digest(text) != selector.expected_sha256 {
        crate::refuse!(Conflict, "Source changed before sending; reselect the passage. Nothing was sent.");
    }
    let Some(excerpt) = range(text, selector.start, selector.end).filter(|s| !s.is_empty() && s.len() <= MAX_EXCERPT) else {
        crate::refuse!(BadRequest, "selection is outside its source or exceeds 4096 UTF-8 bytes");
    };
    let start = byte_at(text, selector.start).unwrap();
    let end = byte_at(text, selector.end).unwrap();
    Ok(json!({"version":1,"selector":selector,"revision":revision,"excerpt":excerpt,
        "prefix":prefix(&text[..start]),"suffix":suffix(&text[end..]),"state":"exact"}))
}

/// Return a bounded exact source window without trimming. Continuation must
/// present this digest, so a changed source never silently joins two versions.
#[nolog]
pub fn window(text: &str, part: &Part, revision: &Value, offset: usize, expected: Option<&str>) -> Result<Value> {
    let sha = digest(text);
    if expected.is_some_and(|s| s != sha) { crate::refuse!(Conflict, "Source changed; restart the source read."); }
    if offset > 0 && expected.is_none() { crate::refuse!(BadRequest, "source continuation needs expected_sha256"); }
    let Some(start) = byte_at(text, offset) else { crate::refuse!(BadRequest, "source offset is beyond the selected part"); };
    let mut bytes = 0;
    let body: String = text[start..].chars().take_while(|c| { bytes += c.len_utf8(); bytes <= MAX_WINDOW }).collect();
    let next = offset + body.chars().count();
    Ok(json!({"part":part,"revision":revision,"projection":"source-v1","unit":"unicode-scalar",
        "sha256":sha,"offset":offset,"text":body,"total_scalars":text.chars().count(),
        "next_offset":if start + body.len() < text.len() { Some(next) } else { None }}))
}

/// A quote can relocate only within the same part, with the original nearby
/// context and exactly one candidate. Overlapping matches count separately.
#[nolog]
pub fn locate(text: Option<&str>, snapshot: &Value) -> Value {
    let unavailable = || json!({"state":"unavailable"});
    let Some(text) = text else { return unavailable() };
    let Ok(selector) = Selector::parse(&snapshot["selector"]) else { return unavailable() };
    let Some(excerpt) = snapshot["excerpt"].as_str().filter(|s| !s.is_empty() && s.len() <= MAX_EXCERPT) else { return unavailable() };
    if digest(text) == selector.expected_sha256 && range(text, selector.start, selector.end) == Some(excerpt) {
        return json!({"state":"exact","start":selector.start,"end":selector.end});
    }
    let before = snapshot["prefix"].as_str().unwrap_or("");
    let after = snapshot["suffix"].as_str().unwrap_or("");
    if before.len() > MAX_CONTEXT || after.len() > MAX_CONTEXT { return unavailable(); }
    let mut found = None;
    for (start, _) in text.char_indices() {
        let end = start.saturating_add(excerpt.len());
        if text.get(start..end) != Some(excerpt) || !text[..start].ends_with(before)
            || !text.get(end..).is_some_and(|s| s.starts_with(after)) { continue; }
        if found.is_some() { return json!({"state":"changed"}); }
        let scalar = text[..start].chars().count();
        found = Some((scalar, scalar + excerpt.chars().count()));
    }
    match found {
        Some((start, end)) => json!({"state":"relocated","start":start,"end":end}),
        None => json!({"state":"changed"}),
    }
}

/// Apply aggregate bounds before admitting any delivery, never truncate quotes.
#[nolog]
pub fn bounds(quotes: &[Value]) -> Result<()> {
    let selections: Vec<&Value> = quotes.iter().filter_map(|q| q.get("selection")).collect();
    if selections.len() > MAX_SELECTIONS || serde_json::to_vec(&selections)?.len() > MAX_METADATA {
        crate::refuse!(BadRequest, "reply supports at most 8 selected passages and 48 KiB of selection metadata; split the reply");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selector(text: &str, start: usize, end: usize) -> Selector {
        Selector::parse(&json!({"part":"mail.body","projection":"source-v1","unit":"unicode-scalar",
            "expected_sha256":digest(text),"start":start,"end":end})).unwrap()
    }
    #[test]
    fn reply_selection_exact_unicode_whitespace_and_bounds() {
        let text = "A\r\n😀e\u{301} שלום\nZ";
        let s = selector(text, 3, 6);
        let q = capture(text, &s, &json!(2)).unwrap();
        assert_eq!(q["excerpt"], "😀e\u{301}");
        assert_eq!(q["prefix"], "A\r\n");
        assert_eq!(q["suffix"], " שלום\nZ");
        assert!(capture("changed", &s, &json!(3)).is_err());
        assert!(capture(text, &selector(text, 0, 999), &Value::Null).is_err());
        let big = "😀".repeat(1025);
        assert!(capture(&big, &selector(&big, 0, 1025), &Value::Null).is_err());
    }
    #[test]
    fn reply_selection_relocation_requires_unique_quote_and_context() {
        let text = "before quote after";
        let q = capture(text, &selector(text, 7, 12), &json!(1)).unwrap();
        assert_eq!(locate(Some(text), &q)["state"], "exact");
        assert_eq!(locate(Some("new before quote after tail"), &q), json!({"state":"relocated","start":11,"end":16}));
        assert_eq!(locate(Some("before quote after / before quote after"), &q)["state"], "changed");
        assert_eq!(locate(Some("before QUOTE after"), &q)["state"], "changed");
        assert_eq!(locate(None, &q)["state"], "unavailable");
        let repeated = capture("aa", &selector("aa", 0, 1), &json!(1)).unwrap();
        assert_eq!(locate(Some("aaa"), &repeated)["state"], "changed");
    }
    #[test]
    fn reply_selection_windows_are_version_bound_and_utf8_bounded() {
        let text = "א😀\r\n".repeat(900);
        let part = Part::parse(&json!({"part":"text"})).unwrap();
        let a = window(&text, &part, &json!(9), 0, None).unwrap();
        assert!(a["text"].as_str().unwrap().len() <= MAX_WINDOW);
        let offset = a["next_offset"].as_u64().unwrap() as usize;
        assert!(window(&text, &part, &json!(9), offset, None).is_err());
        assert!(window("changed", &part, &json!(10), offset, a["sha256"].as_str()).is_err());
        let b = window(&text, &part, &json!(9), offset, a["sha256"].as_str()).unwrap();
        assert!(text.starts_with(&format!("{}{}", a["text"].as_str().unwrap(), b["text"].as_str().unwrap())));
    }
    #[test]
    fn reply_selection_schema_rejects_hidden_fields_and_metadata_overflow() {
        for bad in [json!({"part":"segments"}), json!({"part":"text","pointer":"/secret"}),
            json!({"part":"tool.input"}), json!({"part":"mail.body","tool_id":"x"}),
            json!({"part":"text","extra":"untrusted"}), json!({"part":"work_item.done_so_far"})] {
            assert!(Part::parse(&bad).is_err());
        }
        assert!(bounds(&vec![json!({"selection":{}});9]).is_err());
        assert!(bounds(&[json!({"selection":"x".repeat(MAX_METADATA)})]).is_err());
    }
}
