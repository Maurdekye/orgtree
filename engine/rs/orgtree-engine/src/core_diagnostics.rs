//! Bounded, content-free lifecycle evidence. Never pass arbitrary stderr here.
use std::{io::Write, path::Path};

#[nolog]
pub fn record(root: &Path, event: &str, generation: Option<&str>, pid: u32, code: Option<u32>) {
    let dir = root.join("diagnostics");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let path = dir.join("core-exits.jsonl");
    // Callers use a closed event vocabulary. Bound each record as well as the
    // file; a failed rotation must not turn this into an unbounded log.
    if event.len() > 80 || generation.is_some_and(|g| g.len() > 32) { return; }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 256 * 1024) {
        let old = dir.join("core-exits.previous.jsonl");
        let _ = std::fs::remove_file(&old);
        if std::fs::rename(&path, old).is_err() { return; }
    }
    let value = serde_json::json!({"at_ms":crate::core_state::now(),"event":event,
        "generation":generation,"pid":pid,"exit_code":code});
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{value}");
        let _ = f.sync_data();
    }
}
