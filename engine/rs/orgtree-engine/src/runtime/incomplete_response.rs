//! Turn-end fallback for text only. Native identities, never prose alone,
//! associate a later completion with the retained row.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[nolog]
pub fn key(harness: &str, id: &str) -> String {
    format!("{harness}:{:x}", Sha256::digest(id.as_bytes()))
}

#[nolog]
pub fn row(text: &str, key: &str, interrupted: bool, at: &str) -> Option<Value> {
    if text.trim().is_empty() { return None; }
    Some(json!({"role":"assistant","text":text,"tools":[],"ts":at,
        "assistant_id":key,"assistant_state":"partial","interrupted":interrupted,
        "incomplete_key":key,"incomplete_bytes":text.len(),
        "incomplete_hash":format!("{:x}",Sha256::digest(text.as_bytes()))}))
}

/// A native completion may extend its draft. Keep the original prefix receipt
/// after completing so a repeated completion still replaces this same row.
#[nolog]
pub fn complete(row: &mut Value, text: &str) -> bool {
    let Some(n)=row["incomplete_bytes"].as_u64().and_then(|n|usize::try_from(n).ok()) else {return false};
    let Some(prefix)=text.get(..n) else {return false};
    if row["incomplete_hash"].as_str()!=Some(format!("{:x}",Sha256::digest(prefix.as_bytes())).as_str()) {return false;}
    row["text"]=json!(text); row["assistant_state"]=json!("complete"); row["interrupted"]=json!(false);
    true
}

/// AGY sends deltas, including after a cut turn, rather than repeating its
/// full response at DONE. Preserve those received tails in the existing row.
#[nolog]
pub fn agy_delta(row: &mut Value, delta: &str, done: bool) {
    if row["assistant_state"]=="complete" {return;} // replayed DONE
    let before=row["text"].as_str().unwrap_or("");
    let text=format!("{before}{}",delta.chars().take(64_000usize.saturating_sub(before.chars().count())).collect::<String>());
    if done { complete(row,&text); } else {row["text"]=json!(text);}
}

#[cfg(test)]
mod incomplete_response_tests {
    use super::*;
    #[test]
    fn stop_without_completion_keeps_visible_text_and_no_thought() {
        // The tutorial's fake CLI emits message_start, text_delta, then stops;
        // it emits neither content_block_stop nor a completed assistant row.
        let r=row("Unfinished **visible** reply",&key("claude","message-1"),true,"now").unwrap();
        assert_eq!(r["text"],"Unfinished **visible** reply");
        assert_eq!(r["assistant_state"],"partial"); assert_eq!(r["interrupted"],true);
        assert!(r.get("thinking").is_none());
    }
    #[test]
    fn other_end_keeps_text_but_blank_draft_adds_nothing() {
        assert_eq!(row("reply","k",false,"now").unwrap()["interrupted"],false);
        assert!(row(" \n\t","k",true,"now").is_none());
    }
    #[test]
    fn late_completion_and_replay_replace_the_same_row() {
        let mut r=row("Hello 🦀",&key("codex","item-1"),true,"now").unwrap();
        r["seq"]=json!(17);
        assert!(complete(&mut r,"Hello 🦀 world")); assert!(complete(&mut r,"Hello 🦀 world"));
        assert_eq!(r["text"],"Hello 🦀 world"); assert_eq!(r["seq"],17);
        assert_eq!(r["assistant_state"],"complete"); assert_eq!(r["interrupted"],false);
        assert!(!complete(&mut r,"Different reply"));
    }
    #[test]
    fn native_identity_separates_turns_harnesses_and_long_ids() {
        for h in ["claude","codex","muse","agy","acp"] {
            assert_ne!(key(h,"one"),key(h,"two"));
            assert!(row("same words",&key(h,"one"),true,"now").is_some());
        }
        assert_ne!(key("claude","one"),key("codex","one"));
        assert!(key("claude",&"x".repeat(10000)).len()<80);
    }
    #[test]
    fn agy_late_deltas_and_replayed_done_keep_every_received_tail_once() {
        let mut r=row("First ",&key("agy","conversation:3"),true,"now").unwrap();
        agy_delta(&mut r,"second ",false);agy_delta(&mut r,"third",true);
        agy_delta(&mut r,"third",true);
        assert_eq!(r["text"],"First second third");assert_eq!(r["assistant_state"],"complete");
        assert_eq!(r["interrupted"],false);
    }
}
