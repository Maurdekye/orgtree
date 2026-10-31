//! The instructions for all orgs (App settings > Runtime): one Markdown block
//! that every agent in every org receives on every harness, right before its
//! own org's org.md (USER 2026-10-31 10:07:16Z m187a259a848d, "yes please"
//! 10:08:14Z mda4f6d7961a4; @coordinator-opus rulings 10:20Z mdd81da812d3b;
//! docs/rust-engine/app-instructions.md).
//!
//! Stored as one `ot.kv` row (`app_instructions`), never a file: it belongs to
//! no org, so creating and deleting orgs leaves it alone, and no folder an
//! agent holds can write it. Its only writers are the desktop's editor
//! (`http::settings::put_app_instructions`) and Connect your phone (`phone`).
//! Readers use a lock-free snapshot, republished after each committed write.

use std::sync::Arc;

use arc_swap::ArcSwap;
use serde_json::{json, Value};

pub const KEY: &str = "app_instructions";
/// The editor's limit, the same as org.md's (ruling 9). Characters, not bytes.
pub const EDIT_MAX: usize = 200_000;
/// How much reaches agents, the same as org.md's. Characters, not bytes.
pub const PROMPT_MAX: usize = crate::http::settings::ORGMD_PROMPT_MAX;
/// The block has no file: the next-turn report names it by this label.
pub const SOURCE: &str = "Instructions for all orgs (App settings > Runtime)";

/// The stored row. No Debug or Serialize: it holds private instruction text.
#[derive(Clone, Default, PartialEq)]
pub struct Doc {
    /// the whole block as agents receive it: the Connect your phone note
    /// first while a phone is linked, then the user's own text
    pub text: String,
    /// the one-time move of org.md phone notes has run (`phone::migrate`)
    pub phone_notes_moved: bool,
    /// bumped by every committed write, so a slower writer never publishes
    /// an older row over a newer one
    pub seq: i64,
}

pub struct AppInstructions {
    snapshot: ArcSwap<Doc>,
}

#[logged]
impl AppInstructions {
    #[nolog]
    pub fn new(initial: Doc) -> Self {
        AppInstructions { snapshot: ArcSwap::from_pointee(initial) }
    }

    #[nolog]
    pub fn get(&self) -> Arc<Doc> {
        self.snapshot.load_full()
    }

    /// Publish a committed row unless a newer one is already published.
    #[nolog]
    pub fn publish(&self, doc: Doc) {
        // RED STUB: replaced in the engine commit
        self.snapshot.store(Arc::new(doc));
    }
}

/// (the Connect your phone note at the top, the user's own text)
#[nolog]
pub fn split(text: &str) -> (Option<String>, String) {
    // RED STUB: replaced in the engine commit
    (None, text.to_string())
}

/// The block from the note (if any) and the user's text, laid out the way
/// `phone::with_block` lays out a note over a charter.
#[nolog]
pub fn join(managed: Option<&str>, user: &str) -> String {
    // RED STUB: replaced in the engine commit
    let _ = managed;
    user.to_string()
}

/// What the editor may save: within the limit, and never the note's markers.
#[nolog]
pub fn check(user: &str) -> std::result::Result<(), String> {
    // RED STUB: replaced in the engine commit
    let _ = user;
    Ok(())
}

/// The editor's revision of the whole block, the note included.
#[nolog]
pub fn rev(text: &str) -> String {
    // RED STUB: replaced in the engine commit
    let _ = text;
    String::new()
}

/// `GET /api/app-settings/instructions`.
#[nolog]
pub fn payload(doc: &Doc) -> Value {
    // RED STUB: replaced in the engine commit
    let _ = doc;
    json!({})
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "<!-- added by Connect your phone; Unlink removes it -->\n@net:alex.123456 is the user's account and carries their authority.\n<!-- end of the Connect your phone note -->\n";

    #[test]
    fn split_takes_the_phone_note_off_the_top_and_join_puts_it_back() {
        let user = "# For every org\nKeep records.\n";
        let whole = crate::phone::with_block(user, "alex.123456").unwrap();
        let (managed, rest) = split(&whole);
        assert_eq!(managed.as_deref(), Some(NOTE));
        assert_eq!(rest, user);
        assert_eq!(join(managed.as_deref(), &rest), whole);
        let only = crate::phone::with_block("", "alex.123456").unwrap();
        assert_eq!(split(&only), (Some(NOTE.to_string()), String::new()));
        assert_eq!(join(Some(NOTE), ""), only);
        assert_eq!(split(user), (None, user.to_string()));
        assert_eq!(join(None, user), user);
        assert_eq!(split(""), (None, String::new()));
    }

    #[test]
    fn a_save_that_carries_the_note_markers_is_refused() {
        for text in [NOTE, "before\n<!-- added by Connect your phone; Unlink removes it -->\n",
            "x <!-- end of the Connect your phone note --> y"] {
            let refusal = check(text).expect_err("markers in the user's text");
            assert!(refusal.contains("Connect your phone"), "{refusal}");
        }
        assert!(check("Plain instructions that mention Connect your phone in prose.").is_ok());
        assert!(check("").is_ok());
    }

    #[test]
    fn the_editor_limit_is_org_md_s_200000_characters() {
        assert_eq!((EDIT_MAX, PROMPT_MAX), (200_000, 16_000));
        assert!(check(&"é".repeat(EDIT_MAX)).is_ok(), "characters, not bytes");
        let refusal = check(&"x".repeat(EDIT_MAX + 1)).expect_err("one character too many");
        assert!(refusal.contains("200000"), "{refusal}");
    }

    #[test]
    fn the_revision_covers_the_whole_block_note_included() {
        let user = "Keep records.\n";
        let linked = crate::phone::with_block(user, "alex.123456").unwrap();
        assert_eq!(rev(user), crate::phone::orgmd_rev(user.as_bytes()));
        assert_ne!(rev(user), rev(&linked), "a link or unlink changes the revision");
        assert_eq!(rev(&linked), rev(&linked.clone()));
    }

    #[test]
    fn the_payload_shows_the_note_apart_from_the_editable_text() {
        let doc = Doc { text: crate::phone::with_block("Keep records.\n", "alex.123456").unwrap(), ..Doc::default() };
        let v = payload(&doc);
        assert_eq!(v["content"], "Keep records.\n");
        assert_eq!(v["managed"], NOTE);
        assert_eq!(v["chars"], 14);
        assert_eq!(v["prompt_chars"], doc.text.trim().chars().count());
        assert_eq!((v["edit_max"].as_u64(), v["prompt_max"].as_u64()), (Some(200_000), Some(16_000)));
        assert_eq!(v["rev"], rev(&doc.text));
        assert_eq!(v["read_truncated"], false);
        let empty = payload(&Doc::default());
        assert_eq!((empty["content"].as_str(), empty["managed"].is_null()), (Some(""), true));
    }

    #[test]
    fn a_later_write_is_never_replaced_by_an_earlier_one() {
        let store = AppInstructions::new(Doc::default());
        let doc = |seq: i64, text: &str| Doc { text: text.into(), seq, ..Doc::default() };
        store.publish(doc(2, "second"));
        // a slower writer's earlier commit arrives late
        store.publish(doc(1, "first"));
        assert_eq!(store.get().text, "second");
        store.publish(doc(3, "third"));
        assert_eq!(store.get().text, "third");
    }
}
