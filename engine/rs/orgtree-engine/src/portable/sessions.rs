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
//! - OpenCode (USER 2026-11-24 m4778ba0aed9e): a store of the agent's own,
//!   `profiles/opencode/<org id>/<agent id>/<generation>/` with its `data`
//!   and `state` parts. Both are carried whole into the new agent's own
//!   store.
//! - Antigravity: one database per conversation in the login's home,
//!   `.gemini/antigravity-cli/conversations/<id>.db`. NOT carried. Measured
//!   2026-11-24 with agy 1.5.14: a copy of the database under a new id is
//!   refused ("trajectory not found: <new id>", exit 1), because the id is
//!   also inside the database; and the store is shared by the login's agents
//!   and keeps a limited number of conversations. Its agents start with the
//!   handoff note, like Muse's.
//!
//! Muse keeps sessions inside the login's own store, shared by its agents.
//! Its agents start on a fresh session with the standing handoff note and
//! their whole earlier conversation saved in their folder, as any agent does
//! whose session could not be resumed.
//!
//! An imported session gets a NEW id: two agents of one computer must never
//! share a session (a duplicate and its original would write the same file).
//! OpenCode is the one exception, and only because its store is private to
//! each agent: the id stays, and no two agents read the same file.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::engine::Engine;
use crate::providers::catalog;

pub const CLAUDE: &str = "claude-code";
pub const CODEX: &str = "codex-cli";
pub const OPENCODE: &str = "opencode";
pub const AGY: &str = "antigravity";
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
        catalog::GOOGLE => AGY,
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

/// Where an OpenCode seat keeps what outlives a launch: its sessions (`data`) and its state.
/// The one place that names it, for the actor that starts the CLI and for an import.
#[nolog]
pub fn opencode_profile(engine: &Engine, org: i64, agent: i64, generation: i32) -> PathBuf {
    engine.cfg.path("profiles").join(OPENCODE).join(org.to_string()).join(agent.to_string()).join(generation.to_string())
}

/// The two parts of an OpenCode store that are carried.
const OPENCODE_PARTS: [&str; 2] = ["data", "state"];

/// Which agent it is, for a store that is kept under the engine's own numbers.
#[derive(Clone, Copy)]
pub struct Seat {
    pub org: i64,
    pub agent: i64,
    pub generation: i32,
}

/// The current session's files of an agent, when its harness keeps them as files that can
/// be carried and they are there.
#[nolog]
pub fn find(engine: &Engine, seat: Seat, tier: &str, account: Option<&str>, session: Option<&str>, extra: &Value, scratch: &Path) -> Option<Found> {
    let session = session.filter(|s| plain_id(s))?;
    match harness_of(tier, extra).as_str() {
        OPENCODE => {
            let profile = opencode_profile(engine, seat.org, seat.agent, seat.generation);
            let mut files = Vec::new();
            for part in OPENCODE_PARTS {
                files.extend(files_under(&profile.join(part)).into_iter().map(|(inner, path)| (format!("{part}/{inner}"), path)));
            }
            // a session is in `data`: a store with only state holds none
            files.iter().any(|(inner, _)| inner.starts_with("data/")).then_some(Found { harness: OPENCODE, files })
        }
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
/// folder, a Codex home, the agent's own OpenCode store. `None` for a harness whose sessions
/// cannot be carried.
#[nolog]
pub fn home(engine: &Engine, harness: &str, account: Option<&str>, seat: Seat) -> Option<PathBuf> {
    let own = account.and_then(|id| engine.accounts.view().get(id).and_then(|a| a.config_dir.clone())).map(PathBuf::from);
    match harness {
        CLAUDE => Some(own.unwrap_or_else(crate::runtime::claude::default_config_dir)),
        CODEX => Some(own.unwrap_or_else(crate::runtime::codex::default_home)),
        OPENCODE => Some(opencode_profile(engine, seat.org, seat.agent, seat.generation)),
        _ => None,
    }
}

/// Whether a carried session of this harness keeps its id. Only a store that is private to
/// the agent may: under any shared one, a duplicate and its original would be one session.
#[nolog]
pub fn keeps_id(harness: &str) -> bool {
    harness == OPENCODE
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
        OPENCODE => {
            // the agent's own store, as it was, under the id it had; never over a store that holds something
            if old != new || OPENCODE_PARTS.iter().any(|part| !files_under(&home.join(part)).is_empty()) {
                return Ok(false);
            }
            let mut sessions = 0;
            for (inner, path) in files {
                let Some(part) = OPENCODE_PARTS.iter().find(|part| inner.starts_with(&format!("{part}/"))) else { continue };
                let Some(parts) = super::names::safe_parts(inner) else { continue };
                let mut to = home.to_path_buf();
                to.extend(parts);
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(path, &to)?;
                sessions += usize::from(*part == "data");
            }
            Ok(sessions > 0)
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
        assert!(!place("muse", &home, &scratch, old, new, &files).unwrap());
        // an id too short to be a CLI's own is a word, and every mention of it would be rewritten
        let short = vec![("s-1.jsonl".to_string(), from.join("old-session-1.jsonl"))];
        assert!(!place(CLAUDE, &home, &scratch, "s-1", new, &short).unwrap());
        assert_eq!(replaced(b"aXbXX", b"X", b"yz"), b"ayzbyzyz".to_vec());
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("orgtree-sessions-"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_opencode_store_is_placed_whole_under_the_id_it_had() {
        let root = std::env::temp_dir().join(format!("orgtree-sessions-{}", uuid::Uuid::new_v4()));
        let (from, profile) = (root.join("unpacked"), root.join("profiles").join("opencode").join("2").join("31").join("1"));
        std::fs::create_dir_all(from.join("data").join("opencode").join("storage")).unwrap();
        std::fs::create_dir_all(from.join("state")).unwrap();
        std::fs::write(from.join("data").join("opencode").join("storage").join("ses_0123456789.json"), b"{\"id\":\"ses_0123456789\"}").unwrap();
        std::fs::write(from.join("state").join("kv.json"), b"{}").unwrap();
        std::fs::write(from.join("stray.txt"), b"not a part of the store").unwrap();
        let files = vec![
            ("data/opencode/storage/ses_0123456789.json".to_string(), from.join("data").join("opencode").join("storage").join("ses_0123456789.json")),
            ("state/kv.json".to_string(), from.join("state").join("kv.json")),
            ("stray.txt".to_string(), from.join("stray.txt")),
            ("data/../../outside.json".to_string(), from.join("stray.txt")),
        ];
        let id = "ses_0123456789";
        assert!(keeps_id(OPENCODE) && !keeps_id(CLAUDE) && !keeps_id(CODEX) && !keeps_id(AGY));
        // never under another id: nothing in the store's own format is rewritten
        assert!(!place(OPENCODE, &profile, &root, id, "ses_another_id", &files).unwrap());
        assert!(!profile.exists());
        assert!(place(OPENCODE, &profile, &root, id, id, &files).unwrap());
        assert_eq!(std::fs::read(profile.join("data").join("opencode").join("storage").join("ses_0123456789.json")).unwrap(), b"{\"id\":\"ses_0123456789\"}".to_vec());
        assert!(profile.join("state").join("kv.json").is_file());
        assert!(!profile.join("stray.txt").exists() && !root.join("profiles").join("opencode").join("2").join("outside.json").exists());
        // and never over a store that already holds something
        assert!(!place(OPENCODE, &profile, &root, id, id, &files).unwrap());
        // state alone is no session
        let other = root.join("profiles").join("opencode").join("2").join("32").join("1");
        assert!(!place(OPENCODE, &other, &root, id, id, &files[1..2]).unwrap());
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
