//! Question cards for Hubchat (Hubchat's docs/question-cards.md): an
//! agent's question to a @net: address may carry 2-10 preset answers. They
//! go into the body as a numbered list every client can read, and the hub
//! payload turns that list back into the `meta` Hubchat shows as buttons.
//! The person's answer comes back as ordinary mail ("Answer: <label>").
use anyhow::Result;
use serde_json::{json, Value};

pub const MAX_OPTIONS: usize = 10;
/// Characters in one option.
pub const MAX_LABEL: usize = 100;
const ONE: &str = "Pick one:";
const MANY: &str = "Pick one or more:";

/// The options an agent gave, checked: 2-10 different one-line answers of
/// 1-100 characters (spaces around them dropped).
#[logged]
pub fn options(v: &Value) -> Result<Vec<String>> {
    let Some(a) = v.as_array().filter(|a| (2..=MAX_OPTIONS).contains(&a.len())) else {
        crate::refuse!(BadRequest, "options must be a list of 2 to {MAX_OPTIONS} answers");
    };
    let mut out: Vec<String> = Vec::new();
    for o in a {
        let Some(l) = o.as_str().map(str::trim) else { crate::refuse!(BadRequest, "each option is a short text") };
        if l.is_empty() || l.chars().count() > MAX_LABEL || l.chars().any(char::is_control) {
            crate::refuse!(BadRequest, "each option is one line of 1 to {MAX_LABEL} characters");
        }
        if out.iter().any(|x| x.to_lowercase() == l.to_lowercase()) {
            crate::refuse!(BadRequest, "the options must all be different");
        }
        out.push(l.to_string());
    }
    Ok(out)
}

/// The question with its options as a numbered list: what every client reads.
#[logged]
pub fn with_block(question: &str, options: &[String], multiple: bool) -> String {
    let mut s = format!("{}\n\n{}", question.trim_end(), if multiple { MANY } else { ONE });
    for (i, o) in options.iter().enumerate() {
        s.push_str(&format!("\n{}. {o}", i + 1));
    }
    s
}

/// The `meta` of a question whose body ends with such a list (the list is
/// the plain-text part Hubchat leaves out); None for anything else.
#[logged]
pub fn meta(kind: &str, body: &str) -> Option<Value> {
    if kind != "question" {
        return None;
    }
    let (start, multiple, rest) = [(ONE, false), (MANY, true)]
        .into_iter()
        .filter_map(|(h, m)| {
            let at = body.rfind(&format!("\n\n{h}\n"))?;
            Some((at, m, &body[at + 2 + h.len() + 1..]))
        })
        .max_by_key(|x| x.0)?;
    let mut options = Vec::new();
    for (i, line) in rest.split('\n').enumerate() {
        let l = line.strip_prefix(&format!("{}. ", i + 1))?;
        if l.is_empty() || l.trim() != l || l.chars().count() > MAX_LABEL || l.chars().any(char::is_control) {
            return None;
        }
        options.push(l.to_string());
    }
    if !(2..=MAX_OPTIONS).contains(&options.len()) {
        return None;
    }
    Some(json!({ "question": { "options": options, "multiple": multiple }, "fallback": [start, body.len()] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_are_checked_as_the_tool_receives_them() {
        assert_eq!(options(&json!([" Beta ", "Stable"])).unwrap(), ["Beta", "Stable"]);
        for bad in [json!(["one"]), json!("Beta"), json!(["a", "A"]), json!(["a", "b\nc"]), json!(["a", " "]), json!(["a", 2]),
                    json!((0..11).map(|i| i.to_string()).collect::<Vec<_>>()), json!(["a", "x".repeat(101)])] {
            assert!(options(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_list_in_the_body_becomes_hubchat_meta() {
        let body = with_block("Which channel should rc4 go to?\n", &["Beta".into(), "Stable".into()], false);
        assert_eq!(body, "Which channel should rc4 go to?\n\nPick one:\n1. Beta\n2. Stable");
        let m = meta("question", &body).unwrap();
        assert_eq!(m["question"], json!({ "options": ["Beta", "Stable"], "multiple": false }));
        let at = m["fallback"][0].as_u64().unwrap() as usize;
        assert_eq!((&body[..at], m["fallback"][1].as_u64().unwrap() as usize), ("Which channel should rc4 go to?", body.len()));
        let many = with_block("Which days work?", &["1. Monday".into(), "Tuesday".into(), "Friday".into()], true);
        assert_eq!(meta("question", &many).unwrap()["question"], json!({ "options": ["1. Monday", "Tuesday", "Friday"], "multiple": true }));
        // the last list counts; anything else is plain text
        let quoted = format!("Earlier:\n\nPick one:\n1. x\n2. y\n\nNow?{}", &body[body.find("\n\nPick").unwrap()..]);
        assert_eq!(meta("question", &quoted).unwrap()["question"]["options"], json!(["Beta", "Stable"]));
        assert_eq!(meta("message", &body), None);
        for bad in ["Q?\n\nPick one:\n1. Beta", "Q?\n\nPick one:\n1. Beta\n3. Stable", "Q?\n\nPick one:\n1. Beta\n2. Stable\nmore", "Q?\n\nPick one:\n1.  Beta\n2. Stable", "Q?"] {
            assert_eq!(meta("question", bad), None, "{bad:?}");
        }
    }
}
