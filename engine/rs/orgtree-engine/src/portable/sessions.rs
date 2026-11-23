//! An agent's CLI session files, so that an imported or duplicated agent
//! goes on with its own session and its full context
//! (docs/rust-engine/agent-export.md, "Sessions"; USER 2026-11-23 20:30Z
//! m2106530cca00, question 8: "prefer own cli session with full context").
//!
//! Two harnesses keep a session as files that can be carried, and the engine
//! already carries them between folders and accounts
//! (`runtime::claude::ensure_session`, `runtime::codex::ensure_rollout`):
//!
//! - Claude Code: `<config>/projects/<the scratch path, spelled as a folder
//!   name>/<session>.jsonl`, with a folder `<session>/` beside it (subagent
//!   transcripts, large tool results).
//! - Codex: `<home>/sessions/<year>/<month>/<day>/rollout-...-<thread>.jsonl`.
//!
//! The other harnesses keep sessions inside the login's own store
//! (Antigravity, Muse) or under the numeric ids of the organization and the
//! agent (OpenCode). Their agents start on a fresh session with the standing
//! handoff note and their whole earlier conversation saved in their folder,
//! as any agent does whose session could not be resumed.
//!
//! An imported session gets a NEW id: two agents of one computer must never
//! share a session (a duplicate and its original would write the same file).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::engine::Engine;
use crate::providers::catalog;

pub const CLAUDE: &str = "claude-code";
pub const CODEX: &str = "codex-cli";
/// The shortest session id that is carried (the CLIs' own are 36 characters).
const MIN_ID: usize = 8;

/// The files of one agent's current session.
pub struct Found {
    pub harness: &'static str,
    /// Each file's name under the node's `native/<harness>/` folder, and where it lies.
    pub files: Vec<(String, PathBuf)>,
}

/// The harness an agent's session runs on: its stamp (an OpenRouter or language model
/// server seat has one), else its provider's own CLI.
#[nolog]
pub fn harness_of(tier: &str, extra: &Value) -> String {
    if let Some(stamp) = extra["harness"].as_str().filter(|s| !s.is_empty()) {
        return stamp.to_string();
    }
    match catalog::provider_of(tier) {
        catalog::CLAUDE => CLAUDE,
        catalog::OPENAI => CODEX,
        catalog::GOOGLE => "antigravity",
        catalog::MUSE => "muse",
        _ => "",
    }
    .to_string()
}

/// Every Claude config folder a session of this computer can lie in: each account's, the
/// default one, and the language model server seats' own.
#[nolog]
fn claude_roots(engine: &Engine) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut add = |root: PathBuf| {
        if !roots.contains(&root) {
            roots.push(root);
        }
    };
    for account in engine.accounts.view().all() {
        if let Some(dir) = &account.config_dir {
            add(PathBuf::from(dir));
        }
    }
    add(crate::runtime::claude::default_config_dir());
    add(engine.cfg.path("profiles").join("langserver-claude"));
    roots
}

/// Every Codex home a thread of this computer can lie in.
#[nolog]
fn codex_homes(engine: &Engine) -> Vec<PathBuf> {
    let mut homes: Vec<PathBuf> = Vec::new();
    let mut add = |home: PathBuf| {
        if !homes.contains(&home) {
            homes.push(home);
        }
    };
    for account in engine.accounts.view().all() {
        if account.provider == catalog::OPENAI {
            if let Some(dir) = &account.config_dir {
                add(PathBuf::from(dir));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(engine.cfg.path("profiles")) {
        for entry in entries.flatten() {
            if entry.path().join("sessions").is_dir() {
                add(entry.path());
            }
        }
    }
    add(crate::runtime::codex::default_home());
    homes
}

/// The files under `folder`, each with its path in it (`/` between parts). Links are not
/// followed, and a folder deeper than a session's own ever is, is left.
#[nolog]
fn files_under(folder: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut todo = vec![(folder.to_path_buf(), String::new(), 0usize)];
    while let Some((at, relative, depth)) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&at) else { continue };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else { continue };
            if crate::http::scratch_files::is_link(&metadata) {
                continue;
            }
            let inner = if relative.is_empty() { name } else { format!("{relative}/{name}") };
            if metadata.is_dir() {
                if depth < 6 {
                    todo.push((entry.path(), inner, depth + 1));
                }
            } else {
                out.push((inner, entry.path()));
            }
        }
    }
    out.sort();
    out
}

/// The current session's files of an agent, when its harness keeps them as files that can
/// be carried and they are there.
#[nolog]
pub fn find(engine: &Engine, _agent: i64, tier: &str, _account: Option<&str>, session: Option<&str>, extra: &Value, scratch: &Path) -> Option<Found> {
    let session = session.filter(|s| plain_id(s))?;
    match harness_of(tier, extra).as_str() {
        CLAUDE => {
            let file = format!("{session}.jsonl");
            let own = crate::runtime::claude::project_dir(scratch);
            // where this agent's CLI looks first, then any project folder of any config folder
            let mut found: Option<PathBuf> = None;
            for root in claude_roots(engine) {
                let projects = root.join("projects");
                let candidate = projects.join(&own).join(&file);
                if candidate.is_file() {
                    found = Some(candidate);
                    break;
                }
                if found.is_none() {
                    if let Ok(entries) = std::fs::read_dir(&projects) {
                        found = entries.flatten().map(|e| e.path().join(&file)).find(|p| p.is_file());
                    }
                }
            }
            let transcript = found?;
            let mut files = vec![(file, transcript.clone())];
            let beside = transcript.with_extension("");
            if beside.is_dir() {
                files.extend(files_under(&beside).into_iter().map(|(inner, path)| (format!("{session}/{inner}"), path)));
            }
            Some(Found { harness: CLAUDE, files })
        }
        CODEX => {
            let (path, _) = codex_homes(engine).iter().find_map(|home| crate::runtime::codex::find_rollout(home, session))?;
            let name = path.file_name()?.to_string_lossy().to_string();
            Some(Found { harness: CODEX, files: vec![(name, path)] })
        }
        _ => None,
    }
}

/// The folder the CLI of an agent on `account` keeps its sessions under: a Claude config
/// folder, a Codex home. `None` for a harness whose sessions cannot be carried.
#[nolog]
pub fn home(engine: &Engine, harness: &str, account: Option<&str>) -> Option<PathBuf> {
    let own = account.and_then(|id| engine.accounts.view().get(id).and_then(|a| a.config_dir.clone())).map(PathBuf::from);
    match harness {
        CLAUDE => Some(own.unwrap_or_else(crate::runtime::claude::default_config_dir)),
        CODEX => Some(own.unwrap_or_else(crate::runtime::codex::default_home)),
        _ => None,
    }
}

/// `line` with every `old` in it replaced by `new`.
#[nolog]
fn replaced(line: &[u8], old: &[u8], new: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(line.len());
    let mut at = 0;
    while at < line.len() {
        if line[at..].starts_with(old) {
            out.extend_from_slice(new);
            at += old.len();
        } else {
            out.push(line[at]);
            at += 1;
        }
    }
    out
}

/// Copy a session's line file, each mention of its old id becoming the new one: every line
/// of such a file names the session it belongs to.
#[nolog]
fn renamed_copy(from: &Path, to: &Path, old: &str, new: &str) -> std::io::Result<()> {
    use std::io::{BufRead, Write};
    let reader = std::io::BufReader::with_capacity(256 * 1024, std::fs::File::open(from)?);
    let mut writer = std::io::BufWriter::with_capacity(256 * 1024, std::fs::File::create(to)?);
    for line in reader.split(b'\n') {
        writer.write_all(&replaced(&line?, old.as_bytes(), new.as_bytes()))?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}

/// Put the unpacked files of session `old` (each by its name under `native/<harness>/`) where
/// the CLI of an agent whose folder is `scratch` finds them as session `new`. False when the
/// files are not a session of that harness.
#[nolog]
pub fn place(harness: &str, home: &Path, scratch: &Path, old: &str, new: &str, files: &[(String, PathBuf)]) -> std::io::Result<bool> {
    // every mention of the old id is rewritten: an id too short to be one of a CLI's own could
    // be a word of the conversation, and is not carried
    if !plain_id(old) || !plain_id(new) || old.len() < MIN_ID {
        return Ok(false);
    }
    match harness {
        CLAUDE => {
            let own = format!("{old}.jsonl");
            let Some((_, transcript)) = files.iter().find(|(inner, _)| *inner == own) else { return Ok(false) };
            let folder = home.join("projects").join(crate::runtime::claude::project_dir(scratch));
            std::fs::create_dir_all(&folder)?;
            renamed_copy(transcript, &folder.join(format!("{new}.jsonl")), old, new)?;
            // what lies beside it (subagent transcripts, large tool results), under the new id
            let beside = format!("{old}/");
            for (inner, path) in files {
                let Some(parts) = inner.strip_prefix(&beside).and_then(super::names::safe_parts) else { continue };
                let mut to = folder.join(new);
                to.extend(parts);
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if inner.ends_with(".jsonl") {
                    renamed_copy(path, &to, old, new)?;
                } else {
                    std::fs::copy(path, &to)?;
                }
            }
            Ok(true)
        }
        CODEX => {
            // one rollout file, whose name ends with the thread's id
            let Some((inner, rollout)) = files.iter().find(|(inner, _)| inner.contains(old) && inner.ends_with(".jsonl") && !inner.contains('/')) else { return Ok(false) };
            let name = inner.replace(old, new);
            if super::names::safe_parts(&name).is_none() {
                return Ok(false);
            }
            let now = chrono::Utc::now();
            let folder = home.join("sessions").join(now.format("%Y").to_string()).join(now.format("%m").to_string()).join(now.format("%d").to_string());
            std::fs::create_dir_all(&folder)?;
            renamed_copy(rollout, &folder.join(name), old, new)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// A session id that can stand in a file name: what the CLIs make (letters, digits, `-`,
/// `_`), and nothing a stored value could use to name another place.
#[nolog]
pub fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_seat_runs_on_its_stamp_or_its_providers_own_cli() {
        assert_eq!(harness_of("or-anything", &json!({ "harness": "opencode" })), "opencode");
        assert_eq!(harness_of("fable", &json!({})), CLAUDE);
        assert_eq!(harness_of("sol", &json!({})), CODEX);
        assert_eq!(harness_of("fable", &json!({ "harness": "" })), CLAUDE);
    }

    #[test]
    fn only_a_plain_id_names_a_session_file() {
        for id in ["0f8fad5b-d9cb-469f-a165-70867728950e", "thread_01", "a"] {
            assert!(plain_id(id), "{id}");
        }
        for id in ["", "../other", "a/b", "a\\b", "a.jsonl", "id with space", "C:x", &"x".repeat(129)] {
            assert!(!plain_id(id), "{id}");
        }
    }

    #[test]
    fn a_session_is_placed_under_a_new_id_where_its_cli_reads_it() {
        let root = std::env::temp_dir().join(format!("orgtree-sessions-{}", uuid::Uuid::new_v4()));
        let (from, home, scratch) = (root.join("unpacked"), root.join("home"), root.join("scratch").join("lead-2"));
        std::fs::create_dir_all(from.join("old-session-1").join("subagents")).unwrap();
        let (old, new) = ("old-session-1", "new-session-2");
        std::fs::write(from.join("old-session-1.jsonl"), b"{\"sessionId\":\"old-session-1\",\"n\":1}\n{\"sessionId\":\"old-session-1\",\"text\":\"about old-session-1x\"}\n").unwrap();
        std::fs::write(from.join("old-session-1").join("subagents").join("a.jsonl"), b"{\"sessionId\":\"old-session-1\"}\n").unwrap();
        std::fs::write(from.join("old-session-1").join("result.bin"), b"old-session-1 stays in what is not a line file").unwrap();
        let files = vec![
            ("old-session-1.jsonl".to_string(), from.join("old-session-1.jsonl")),
            ("old-session-1/subagents/a.jsonl".to_string(), from.join("old-session-1").join("subagents").join("a.jsonl")),
            ("old-session-1/result.bin".to_string(), from.join("old-session-1").join("result.bin")),
        ];
        assert!(place(CLAUDE, &home, &scratch, old, new, &files).unwrap());
        let folder = home.join("projects").join(crate::runtime::claude::project_dir(&scratch));
        assert_eq!(std::fs::read(folder.join("new-session-2.jsonl")).unwrap(), b"{\"sessionId\":\"new-session-2\",\"n\":1}\n{\"sessionId\":\"new-session-2\",\"text\":\"about new-session-2x\"}\n".to_vec());
        assert_eq!(std::fs::read(folder.join("new-session-2").join("subagents").join("a.jsonl")).unwrap(), b"{\"sessionId\":\"new-session-2\"}\n".to_vec());
        assert_eq!(std::fs::read(folder.join("new-session-2").join("result.bin")).unwrap(), b"old-session-1 stays in what is not a line file".to_vec());
        assert!(!folder.join("old-session-1.jsonl").exists());
        // a Codex thread: one rollout file, renamed, under today's folder
        std::fs::write(from.join("rollout-2026-11-20T10-00-00-old-session-1.jsonl"), b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"old-session-1\"}}\n").unwrap();
        let rollout = vec![("rollout-2026-11-20T10-00-00-old-session-1.jsonl".to_string(), from.join("rollout-2026-11-20T10-00-00-old-session-1.jsonl"))];
        assert!(place(CODEX, &home, &scratch, old, new, &rollout).unwrap());
        let found = crate::runtime::codex::find_rollout(&home, new).expect("the thread is found under its new id");
        assert_eq!(std::fs::read(&found.0).unwrap(), b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"new-session-2\"}}\n".to_vec());
        assert!(crate::runtime::codex::find_rollout(&home, old).is_none());
        // files that are no session of the harness, an id that is no id, a harness that keeps none
        assert!(!place(CLAUDE, &home, &scratch, old, new, &rollout).unwrap());
        assert!(!place(CODEX, &home, &scratch, old, new, &[]).unwrap());
        assert!(!place(CLAUDE, &home, &scratch, "../x", new, &files).unwrap());
        assert!(!place("antigravity", &home, &scratch, old, new, &files).unwrap());
        // an id too short to be a CLI's own is a word, and every mention of it would be rewritten
        let short = vec![("s-1.jsonl".to_string(), from.join("old-session-1.jsonl"))];
        assert!(!place(CLAUDE, &home, &scratch, "s-1", new, &short).unwrap());
        assert_eq!(replaced(b"aXbXX", b"X", b"yz"), b"ayzbyzyz".to_vec());
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("orgtree-sessions-"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_files_of_a_folder_are_listed_by_their_path_in_it() {
        let root = std::env::temp_dir().join(format!("orgtree-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("subagents")).unwrap();
        std::fs::create_dir_all(root.join("tool-results")).unwrap();
        std::fs::write(root.join("subagents").join("agent-1.jsonl"), b"{}").unwrap();
        std::fs::write(root.join("tool-results").join("r1.txt"), b"out").unwrap();
        std::fs::write(root.join("top.txt"), b"top").unwrap();
        let names: Vec<String> = files_under(&root).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, ["subagents/agent-1.jsonl", "tool-results/r1.txt", "top.txt"]);
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("orgtree-sessions-"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
