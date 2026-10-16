//! Opt-in synthetic reader, not an implementation of any real CLI's loader.
//! Each lane supplies only its native binding. The receipt proves the fake
//! process opened a category, followed its section link, then opened a leaf.
use std::io::Write;
use std::path::{Path, PathBuf};
use serde_json::json;

fn child_link(file: &Path) -> std::io::Result<PathBuf> {
    let text = std::fs::read_to_string(file)?;
    text.split("](").skip(1).filter_map(|s| s.split(')').next())
        .find(|s| s.ends_with("/SKILL.md") && !s.starts_with("../"))
        .map(|s| file.parent().unwrap().join(s))
        .ok_or_else(|| std::io::Error::other("no child guide link"))
}

pub fn observe(cwd: &Path, roots: &[PathBuf]) {
    let Some(dir) = std::env::var_os("ORGTREE_FAKECLI_DIR") else { return };
    if !PathBuf::from(dir).join("probe-builtin-skills").is_file() { return; }
    let mut loaded = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        for entry in entries.flatten() {
            let file = entry.path().join("SKILL.md");
            let result = (|| -> std::io::Result<_> {
                let text = std::fs::read_to_string(&file)?;
                let name = text.lines().find_map(|s| s.strip_prefix("name: ")).unwrap_or("");
                if !["orgtree-working", "orgtree-app"].contains(&name) { return Ok(None); }
                let section = child_link(&file)?;
                let section_text = std::fs::read_to_string(&section)?;
                let leaf = child_link(&section)?;
                let leaf_text = std::fs::read_to_string(&leaf)?;
                Ok(Some(json!({"name":name,"entry":file,"entry_bytes":text.len(),
                    "section":section,"section_bytes":section_text.len(),
                    "leaf":leaf,"leaf_bytes":leaf_text.len()})))
            })();
            match result {
                Ok(Some(receipt)) => loaded.push(receipt),
                Ok(None) => {},
                Err(error) => loaded.push(json!({"entry":file,"error":error.to_string()})),
            }
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
        .open(cwd.join("skills-observed.jsonl")) {
        let _ = writeln!(file, "{}", json!({"pid":std::process::id(),"roots":roots,"loaded":loaded}));
    }
}
