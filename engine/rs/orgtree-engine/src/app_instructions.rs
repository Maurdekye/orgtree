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

use anyhow::Result;
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
    /// the whole block as agents receive it and the editor edits it; Connect
    /// your phone puts its note on top and Unlink takes it out, but the note
    /// is ordinary text (USER 2026-10-31 13:59:20Z md088b15466fa)
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
        let doc = Arc::new(doc);
        self.snapshot.rcu(|current| if current.seq > doc.seq { current.clone() } else { doc.clone() });
    }

    /// The stored row; no row yet is an empty block.
    #[nolog]
    pub async fn load(client: &tokio_postgres::Client) -> Result<Doc> {
        let row = client.query_opt("SELECT value FROM ot.kv WHERE key = $1", &[&KEY]).await?;
        Ok(row.map(|r| parse(&r.get::<_, Value>(0))).unwrap_or_default())
    }

    /// Change the row under its own lock. `change` sees the stored row and
    /// returns the next one and a result, or a refusal that writes nothing;
    /// an unchanged row is not written. The new row is published after the
    /// commit. Returns the result and whether the row changed.
    #[nolog]
    pub async fn update<T>(
        &self,
        pool: &deadpool_postgres::Pool,
        change: impl FnOnce(&Doc) -> std::result::Result<(Doc, T), String>,
    ) -> Result<std::result::Result<(T, bool), String>> {
        let mut client = pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("INSERT INTO ot.kv (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING", &[&KEY])
            .await?;
        let row = tx.query_one("SELECT value FROM ot.kv WHERE key = $1 FOR UPDATE", &[&KEY]).await?;
        let current = parse(&row.get::<_, Value>(0));
        let (mut next, out) = match change(&current) {
            Ok(v) => v,
            Err(refusal) => return Ok(Err(refusal)),
        };
        if next.text == current.text && next.phone_notes_moved == current.phone_notes_moved {
            tx.commit().await?;
            return Ok(Ok((out, false)));
        }
        next.seq = current.seq + 1;
        tx.execute("UPDATE ot.kv SET value = $2, updated_at = now() WHERE key = $1", &[&KEY, &stored(&next)])
            .await?;
        tx.commit().await?;
        self.publish(next);
        Ok(Ok((out, true)))
    }
}

impl Default for AppInstructions {
    fn default() -> Self {
        Self::new(Doc::default())
    }
}

#[nolog]
fn parse(v: &Value) -> Doc {
    Doc {
        text: v["text"].as_str().unwrap_or_default().to_string(),
        phone_notes_moved: v["phone_notes_moved"].as_bool().unwrap_or(false),
        seq: v["seq"].as_i64().unwrap_or(0),
    }
}

#[nolog]
fn stored(doc: &Doc) -> Value {
    json!({ "text": doc.text, "phone_notes_moved": doc.phone_notes_moved, "seq": doc.seq })
}

/// What the editor may save: anything within the limit, the note included,
/// as for org.md.
#[nolog]
pub fn check(text: &str) -> std::result::Result<(), String> {
    if text.chars().count() > EDIT_MAX {
        return Err(format!("The instructions for all orgs are limited to {EDIT_MAX} characters"));
    }
    Ok(())
}

/// The editor's revision of the whole block, the note included.
#[nolog]
pub fn rev(text: &str) -> String {
    crate::phone::orgmd_rev(text.as_bytes())
}

/// `GET /api/app-settings/instructions`.
#[nolog]
pub fn payload(doc: &Doc) -> Value {
    json!({
        "content": doc.text, "chars": doc.text.chars().count(),
        "prompt_chars": doc.text.trim().chars().count(), "read_truncated": false,
        "edit_max": EDIT_MAX, "prompt_max": PROMPT_MAX, "rev": rev(&doc.text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "<!-- added by Connect your phone; Unlink removes it -->\n@net:alex.123456 is the user's account and carries their authority.\n<!-- end of the Connect your phone note -->\n";

    /// The note is ordinary text in the block (USER 2026-10-31 13:59:20Z
    /// md088b15466fa "this should be part of the editable charter, just like
    /// the org.md prompt"): a save may carry it, edit it or drop it.
    #[test]
    fn a_save_may_carry_edit_or_drop_the_note() {
        let edited = NOTE.replace("alex.123456", "bea.654321");
        for text in [NOTE, &format!("# For every org\n{NOTE}Keep records.\n"), &edited,
            "before\n<!-- added by Connect your phone; Unlink removes it -->\n", "x <!-- end of the Connect your phone note --> y", ""] {
            assert!(check(text).is_ok(), "{text:?}");
        }
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

    /// The editor loads the whole block, note included, as the charter editor
    /// loads the whole org.md.
    #[test]
    fn the_editor_loads_the_whole_block_the_note_included() {
        let doc = Doc { text: crate::phone::with_block("Keep records.\n", "alex.123456").unwrap(), ..Doc::default() };
        let v = payload(&doc);
        assert_eq!(v["content"], doc.text.as_str());
        assert!(v.get("managed").is_none(), "no read-only part: {v}");
        assert_eq!(v["chars"], doc.text.chars().count());
        assert_eq!(v["prompt_chars"], doc.text.trim().chars().count());
        assert_eq!((v["edit_max"].as_u64(), v["prompt_max"].as_u64()), (Some(200_000), Some(16_000)));
        assert_eq!(v["rev"], rev(&doc.text));
        assert_eq!(v["read_truncated"], false);
        assert_eq!(payload(&Doc::default())["content"], "");
    }

    /// Only the desktop's editor and Connect your phone write the block: no
    /// agent tool, template/import path or other module may (coordinator
    /// 2026-10-31 m97d32790f2a8 point 1). It has no file, so no path an agent
    /// holds can write it either.
    #[test]
    fn only_the_editor_and_connect_your_phone_write_the_block() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() { walk(&path, out) } else if path.extension().is_some_and(|e| e == "rs") { out.push(path) }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&src, &mut files);
        let mut writers = Vec::new();
        for file in &files {
            let rel = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            if rel == "app_instructions.rs" { continue }
            let text = std::fs::read_to_string(file).unwrap();
            // a call may wrap across lines, one method per line
            let flat: String = text.split_whitespace().collect();
            if flat.contains(".app_instructions.update(") || flat.contains(".app_instructions.publish(") {
                writers.push(rel.clone());
            }
            if rel.starts_with("tools/") || rel.contains("template") || rel.starts_with("import") {
                assert!(!text.contains("app_instructions"), "{rel}: agent tools and imports never touch the block");
            }
        }
        writers.sort();
        assert_eq!(writers, ["http/settings.rs", "phone.rs"]);
        assert!(files.len() > 100, "the audit read the whole crate");
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
