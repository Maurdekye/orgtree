//! Private, hash-only records of instruction bytes actually supplied at launch.
//! These records never change the existing cache/reset policy.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Instructions(BTreeMap<String, Instruction>);

#[derive(Clone, Serialize, Deserialize)]
struct Instruction { path: String, source: String, signature: Option<String> }

impl std::fmt::Debug for Instructions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Instructions").field("files", &self.0.len()).finish()
    }
}

impl Instructions {
    /// Hash the exact supplied text, without another filesystem read.
    #[nolog]
    pub fn text(&mut self, path: &Path, source: &str, text: &str) {
        self.hashed(path, source, Some(hex::encode(Sha256::digest(text.as_bytes()))));
    }

    #[nolog]
    pub fn hashed(&mut self, path: &Path, source: &str, signature: Option<String>) {
        self.0.entry(super::global_instructions::key(path)).or_insert_with(|| Instruction {
            path: path.to_string_lossy().into_owned(), source: source.into(), signature,
        });
    }

    /// A present path omitted from discovery can have become unreadable or
    /// stopped participating (for example a native override). Never call it
    /// removed merely because a read failed.
    #[nolog]
    pub fn compare(&self, baseline: Option<&Self>) -> Vec<Value> {
        let keys: BTreeSet<&String> = self.0.keys().chain(baseline.into_iter().flat_map(|b| b.0.keys())).collect();
        keys.into_iter().map(|key| {
            let current = self.0.get(key);
            let old = baseline.and_then(|b| b.0.get(key));
            let file = current.or(old).expect("union key");
            let status = match (baseline, current, old) {
                (None, _, _) => "unknown",
                (_, Some(a), Some(b)) => match (&a.signature, &b.signature) {
                    (Some(a), Some(b)) if a == b => "unchanged",
                    (Some(_), Some(_)) => "changed",
                    _ => "unknown",
                },
                (_, Some(a), None) if a.signature.is_some() => "added",
                (_, None, Some(b)) if b.signature.is_none() => "unknown",
                (_, None, Some(_)) => match std::fs::read(&file.path) {
                    Ok(_) => "removed",
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => "removed",
                    Err(_) => "unknown",
                },
                _ => "unknown",
            };
            json!({"path":file.path,"source":file.source,"status":status,"effective_at":"next_session_start"})
        }).collect()
    }
}

/// Latest observed input occupancy, not cumulative spend or output tokens.
#[nolog]
pub fn live_context(usage: &Value, provider: &str, codex: bool, acp: bool) -> Option<(i64, Option<i64>)> {
    let n = |k: &str| usage[k].as_i64().unwrap_or(0);
    let used = if acp { n("context_used") }
        else if codex { usage.pointer("/last/inputTokens").and_then(Value::as_i64).unwrap_or(0) }
        else if provider == "google" || provider == "muse" { n("last_prompt") }
        else { n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") };
    (used > 0).then_some((used, usage["context_window"].as_i64().filter(|n| *n > 0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_hash_only_and_legacy_does_not_fabricate_a_copy() {
        let mut old = Instructions::default();
        old.text(Path::new("notes/AGENTS.md"), "own_scratch", "PRIVATE original");
        let durable = serde_json::to_value(&old).unwrap();
        assert!(!durable.to_string().contains("PRIVATE"));
        let old: Instructions = serde_json::from_value(durable).unwrap();
        assert_eq!(old.compare(Some(&old))[0]["status"], "unchanged");
        assert_eq!(old.compare(None)[0]["status"], "unknown");
        let mut now = Instructions::default();
        now.text(Path::new("notes/AGENTS.md"), "own_scratch", "PRIVATE revised");
        now.text(Path::new("notes/CLAUDE.md"), "own_scratch", "PRIVATE added");
        let rows = now.compare(Some(&old));
        assert_eq!(rows.iter().filter(|r| r["status"] == "changed").count(), 1);
        assert_eq!(rows.iter().filter(|r| r["status"] == "added").count(), 1);
        assert!(rows.iter().all(|r| r["effective_at"] == "next_session_start"));
        assert!(!json!(rows).to_string().contains("PRIVATE"));
        let removed = Instructions::default().compare(Some(&old));
        assert_eq!(removed[0]["status"], "removed");
    }

    #[test]
    fn unavailable_file_and_missing_usage_stay_unknown() {
        let mut old = Instructions::default();
        old.text(Path::new("notes/AGENTS.md"), "own_scratch", "before");
        let mut now = Instructions::default();
        now.hashed(Path::new("notes/AGENTS.md"), "own_scratch", None);
        assert_eq!(now.compare(Some(&old))[0]["status"], "unknown");
        assert_eq!(live_context(&json!({}), "claude", false, false), None);
        assert_eq!(live_context(&json!({"output_tokens":99999}), "claude", false, false), None);
    }

    #[test]
    fn context_uses_last_model_input_instead_of_spend_or_thread_total() {
        assert_eq!(live_context(&json!({"input_tokens":2,"cache_read_input_tokens":30,"cache_creation_input_tokens":4,"output_tokens":999}), "claude", false, false), Some((36,None)));
        assert_eq!(live_context(&json!({"last":{"inputTokens":41},"total":{"inputTokens":999999}}), "openai", true, false), Some((41,None)));
        for provider in ["muse","google"] {
            assert_eq!(live_context(&json!({"last_prompt":58,"input":999999,"context_window":1000}), provider, false, false), Some((58,Some(1000))));
        }
        assert_eq!(live_context(&json!({"context_used":71,"context_window":1000}), "other", false, true), Some((71,Some(1000))));
    }
}
