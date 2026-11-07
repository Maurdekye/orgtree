//! Keeping a RESUMED Claude session's standing instructions current
//! (docket 4-5-8-resumed-claude-sessions-keep-a-stale-syste; USER
//! 2026-11-07 22:41Z md53ba71edd88 "Both (refresh + 4.5.8 fix)"; coordinator
//! ruling (A) 2026-11-07 22:49Z).
//!
//! MEASURED cause: Claude Code writes a `prompt_snapshot` of the appended
//! system prompt into the session transcript when the session is created, and
//! on `--resume` restores THAT copy; the `--append-system-prompt-file` the
//! engine passes at every later launch is ignored. A rule-text, app-wide
//! instructions, org.md or charter change therefore never reached a session
//! that predated it, however many times its CLI was respawned.
//!
//! The engine cannot rewrite the snapshot, so the changed text rides the next
//! turn: per section, the digest delivered with the session (recorded when the
//! session is created, and again at each later delivery) is compared with the
//! text the engine would write now. At a turn boundary one block names ONLY
//! the changed sections with their full current text and says it supersedes
//! the earlier system prompt for them. Unchanged text adds nothing and a
//! second turn after delivery adds nothing. The shared org/team notes folder
//! is NOT a section: it already stays out of the prompt on purpose
//! (coordinator ruling (b), 2026-10-13) and changes with every agent's edit.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// One independently refreshable part of the appended system prompt.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub key: &'static str,
    pub label: &'static str,
    pub text: String,
}

pub const OPEN: &str = "[SYSTEM PROMPT UPDATE";
pub const CLOSE: &str = "[END SYSTEM PROMPT UPDATE]";

#[nolog]
fn digest(text: &str) -> String {
    hex::encode(&Sha256::digest(text.trim().as_bytes())[..12])
}

/// The record kept in `agents.extra.envelope.prompt_sections`: the session
/// these digests belong to and one digest per section (sections whose text is
/// empty are recorded too, so a later first appearance reads as a change).
#[nolog]
pub fn record(sid: &str, sections: &[Section]) -> Value {
    let digests: Map<String, Value> = sections.iter().map(|s| (s.key.to_string(), json!(digest(&s.text)))).collect();
    json!({ "sid": sid, "digests": digests })
}

/// What the session should be told now: `None` when every section matches
/// what it holds, else the block and the record to store once the turn was
/// accepted. `prior` is the stored record: one for another session, or none
/// (a session older than this mechanism), has an unknown baseline, so every
/// non-empty section is delivered once.
#[nolog]
pub fn update(sections: &[Section], prior: Option<&Value>, sid: &str) -> Option<(String, Value)> {
    let held: Option<&Map<String, Value>> = prior
        .filter(|p| p["sid"].as_str() == Some(sid))
        .and_then(|p| p["digests"].as_object());
    let changed: Vec<&Section> = sections.iter().filter(|s| match held {
        Some(h) => h.get(s.key).and_then(Value::as_str) != Some(digest(&s.text).as_str()),
        None => !s.text.trim().is_empty(),
    }).collect();
    if changed.is_empty() { return None; }
    let mut out = format!("{OPEN} — {} section{} changed]\n", changed.len(), if changed.len() == 1 { "" } else { "s" });
    out.push_str("Your session started with an older system prompt and cannot reload it. The sections below changed since; \
                  their full CURRENT text follows and supersedes the earlier text of the same section. Sections not listed are unchanged.\n");
    for s in &changed {
        out.push_str(&format!("\n## {} (current)\n", s.label));
        if s.text.trim().is_empty() {
            out.push_str("(now empty: the earlier text of this section no longer applies)\n");
        } else {
            out.push_str(s.text.trim_end());
            out.push('\n');
        }
    }
    out.push_str(CLOSE);
    Some((out, record(sid, sections)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(app: &str, org: &str) -> Vec<Section> {
        vec![
            Section { key: "rules", label: "Orgtree rules", text: "RULES".into() },
            Section { key: "app", label: "Instructions for all orgs (app-wide)", text: app.into() },
            Section { key: "org", label: "Organization notes (org.md)", text: org.into() },
        ]
    }

    #[test]
    fn a_session_whose_text_did_not_change_gets_nothing() {
        let held = record("s1", &secs("A", "O"));
        assert!(update(&secs("A", "O"), Some(&held), "s1").is_none());
        // whitespace at the ends is not a change
        assert!(update(&secs("A\n", "O"), Some(&held), "s1").is_none());
    }

    #[test]
    fn only_the_changed_sections_are_sent_in_full_and_marked_as_superseding() {
        let held = record("s1", &secs("", "O"));
        let (block, rec) = update(&secs("The phone note", "O"), Some(&held), "s1").unwrap();
        assert!(block.starts_with(OPEN) && block.ends_with(CLOSE));
        assert!(block.contains("1 section changed"), "{block}");
        assert!(block.contains("Instructions for all orgs (app-wide) (current)\nThe phone note"));
        assert!(!block.contains("Organization notes") && !block.contains("RULES"), "unchanged sections stay out: {block}");
        assert!(block.contains("supersedes the earlier text"));
        // the next turn, with the new record, adds nothing
        assert!(update(&secs("The phone note", "O"), Some(&rec), "s1").is_none());
    }

    #[test]
    fn a_cleared_section_says_so() {
        let held = record("s1", &secs("A", "O"));
        let (block, _) = update(&secs("", "O"), Some(&held), "s1").unwrap();
        assert!(block.contains("(now empty"), "{block}");
    }

    #[test]
    fn a_session_without_a_record_gets_every_non_empty_section_once() {
        let (block, rec) = update(&secs("", "O"), None, "s1").unwrap();
        assert!(block.contains("2 sections changed") && block.contains("RULES") && block.contains("\nO\n"));
        assert!(!block.contains("Instructions for all orgs"), "an empty section has nothing to supersede: {block}");
        assert!(update(&secs("", "O"), Some(&rec), "s1").is_none());
        // a record for another session is no baseline either
        assert!(update(&secs("", "O"), Some(&rec), "other").is_some());
    }

    #[test]
    fn a_session_created_now_starts_current() {
        let fresh = record("s2", &secs("A", "O"));
        assert!(update(&secs("A", "O"), Some(&fresh), "s2").is_none());
    }
}
