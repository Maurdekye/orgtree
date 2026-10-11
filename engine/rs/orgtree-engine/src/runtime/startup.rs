//! The instruction files a CLI reads ONCE, when its process starts (3.x
//! `warmpool.native_startup_context_digest` and `codex_startup_context_digest`;
//! decision 61). Claude Code and the Codex app-server hold what they read at
//! start, so an edit never reaches a parked process. Their digest is a part
//! of the launch fingerprint: after an edit the next turn respawns the CLI
//! and resumes the SAME session with the new text (3.x parity, user
//! 2026-10-09), never mid-turn, and the cache forecast names "startup".
//!
//! Native startup context, including the installed Claude Code AGENTS.md fallback.
//! - Claude: the managed-policy CLAUDE.md; <config>/CLAUDE.md; CLAUDE.md and
//!   CLAUDE.local.md from the root down to the cwd; <cwd>/.claude/CLAUDE.md;
//!   AGENTS.md fallback when the project chain has no nonempty Claude notes; unscoped rules in
//!   <config>/rules and <cwd>/.claude/rules; `@` imports, five hops deep; and
//!   the first 25 KiB / 200 lines of auto memory's MEMORY.md.
//! - Codex: <CODEX_HOME>/AGENTS.md, and in each folder from a `.git` root (or
//!   the cwd alone when there is none) down to the cwd, AGENTS.override.md or
//!   else AGENTS.md (an override replaces AGENTS.md in its folder).
//! - Deliberately not: memory topic files and path-scoped rules (read lazily,
//!   when needed), skills folders (the CLI watches them live), and CLAUDE.md
//!   for Codex. Granted-folder notes are mirrored by the engine unless native.
//!
//! The manifest holds paths and content hashes, never the text, and a
//! missing file adds nothing.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Auto memory loads at most this much of MEMORY.md at start (3.x `_memory_prefix`).
const MEMORY_BYTES: usize = 25 * 1024;
const MEMORY_LINES: usize = 200;
/// How deep CLAUDE.md `@` imports are followed (the CLI's documented ceiling).
const IMPORT_HOPS: usize = 5;
/// A rules tree is walked at most this deep and this wide.
const RULES_DEPTH: usize = 8;
const RULES_FILES: usize = 512;

/// Where one launch's startup files are: the cwd and the homes its CLI is
/// started with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and its granted folders.
#[derive(Debug, Clone, PartialEq)]
pub enum Inputs {
    Claude { cwd: PathBuf, config: PathBuf, home: PathBuf, add_dirs: Vec<PathBuf> },
    Codex { cwd: PathBuf, home: PathBuf },
    /// a lane whose CLI reads no such file at start (Antigravity)
    None,
}

/// The startup files' digest: equal exactly when no startup file changed.
#[logged]
pub fn digest(inputs: &Inputs) -> String {
    if matches!(inputs, Inputs::None) { return String::new(); }
    let files = native_files(inputs);
    let manifest = serde_json::to_vec(&files).unwrap_or_default();
    hex::encode(&Sha256::digest(&manifest)[..12])
}

/// Native files only: used both for cache invalidation and avoiding duplicate delivery.
#[nolog] // filesystem inventory helper; callers record the operation
fn native_files(inputs: &Inputs) -> BTreeMap<String, String> {
    match inputs {
        Inputs::Claude { cwd, config, home, .. } => claude(cwd, config, home),
        Inputs::Codex { cwd, home } => codex(cwd, home),
        Inputs::None => BTreeMap::new(),
    }
}

pub type Notes = Vec<(String, String)>;

/// Read both generations of standing notes without modifying either file. Native
/// files (including Claude imports) and repeated grants are delivered just once.
#[logged]
pub fn standing_notes(inputs: &Inputs, scratch: &Path, folders: &[PathBuf]) -> (Notes, Notes) {
    let mut seen: HashSet<String> = native_files(inputs).keys().map(|p| file_key(Path::new(p))).collect();
    let mut read = |root: &Path| -> Notes {
        ["AGENTS.md", "CLAUDE.md"].into_iter().filter_map(|name| {
            let path = root.join(name);
            if seen.contains(&file_key(&path)) { return None; }
            let text = std::fs::read_to_string(&path).ok()?;
            seen.insert(file_key(&path));
            Some((path.to_string_lossy().into_owned(), text))
        }).collect()
    };
    let own = read(scratch);
    let granted = folders.iter().flat_map(|p| read(p)).collect();
    (own, granted)
}

#[nolog] // per candidate path
fn file_key(path: &Path) -> String {
    norm(&std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

#[nolog] // per candidate file
fn nonempty(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| !text.trim().is_empty())
}

#[nolog] // `digest` logs the call
fn claude(cwd: &Path, config: &Path, home: &Path) -> BTreeMap<String, String> {
    let mut m = Manifest { files: BTreeMap::new(), seen: HashSet::new(), home: home.to_path_buf() };
    // managed policy, then the user's own instructions
    if cfg!(windows) {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        m.add(&pf.join("ClaudeCode").join("CLAUDE.md"), 0, false, false);
    } else {
        m.add(Path::new("/etc/claude-code/CLAUDE.md"), 0, false, false);
        m.add(Path::new("/Library/Application Support/ClaudeCode/CLAUDE.md"), 0, false, false);
    }
    m.add(&config.join("CLAUDE.md"), 0, false, false);
    // project instructions, from the root down to the cwd
    let chain: Vec<&Path> = cwd.ancestors().collect();
    // Measured installed CLI: any nonempty project CLAUDE.md/CLAUDE.local.md
    // suppresses AGENTS.md fallback for the whole ancestor chain. User config
    // notes do not suppress it; empty project files do not suppress it either.
    let project_notes = chain.iter().any(|dir| ["CLAUDE.md", "CLAUDE.local.md"].iter()
        .any(|name| nonempty(&dir.join(name)))) || nonempty(&cwd.join(".claude/CLAUDE.md"));
    for dir in chain.iter().rev() {
        m.add(&dir.join("CLAUDE.md"), 0, false, false);
        m.add(&dir.join("CLAUDE.local.md"), 0, false, false);
        if !project_notes { m.add(&dir.join("AGENTS.md"), 0, false, false); }
    }
    m.add(&cwd.join(".claude").join("CLAUDE.md"), 0, false, false);
    // --add-dir does not load notes by default; claude::spawn clears the opt-in env flag.
    // unscoped rules load at start; path-scoped ones only when a matching file is read
    for rules in [config.join("rules"), cwd.join(".claude").join("rules")] {
        let mut found = Vec::new();
        rule_files(&rules, 0, &mut found);
        for f in found {
            m.add(&f, 0, false, true);
        }
    }
    // auto memory: only the prefix the CLI loads
    let memory = config.join("projects").join(super::claude::project_dir(cwd)).join("memory").join("MEMORY.md");
    m.add(&memory, 0, true, false);
    m.files
}

#[nolog] // `digest` logs the call
fn codex(cwd: &Path, home: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut add = |p: &Path| {
        if let Ok(bytes) = std::fs::read(p) {
            files.insert(norm(p), sha(&bytes));
        }
    };
    add(&home.join("AGENTS.md"));
    // up to a `.git` root; without one codex reads the cwd alone
    let mut chain: Vec<&Path> = Vec::new();
    let mut rooted = false;
    for dir in cwd.ancestors() {
        chain.push(dir);
        if dir.join(".git").exists() {
            rooted = true;
            break;
        }
    }
    if !rooted {
        chain = vec![cwd];
    }
    for dir in chain.iter().rev() {
        for name in ["AGENTS.override.md", "AGENTS.md"] {
            let p = dir.join(name);
            if p.is_file() {
                add(&p);
                break;
            }
        }
    }
    files
}

struct Manifest {
    files: BTreeMap<String, String>,
    seen: HashSet<String>,
    home: PathBuf,
}

impl Manifest {
    /// One instruction file (and what it imports). Missing or unreadable adds nothing.
    #[nolog] // runs per candidate path; its work is a stat and a small read
    fn add(&mut self, path: &Path, depth: usize, memory: bool, rule: bool) {
        let Ok(bytes) = std::fs::read(path) else { return };
        if rule && !startup_rule(&bytes) {
            return;
        }
        let key = std::fs::canonicalize(path).map(|p| norm(&p)).unwrap_or_else(|_| norm(path));
        if !self.seen.insert(key) {
            return;
        }
        let data = if memory { memory_prefix(&bytes) } else { &bytes[..] };
        self.files.insert(norm(path), sha(data));
        if depth >= IMPORT_HOPS {
            return;
        }
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        for token in imports(&String::from_utf8_lossy(data)) {
            let target = if let Some(rest) = token.strip_prefix('~') {
                self.home.join(rest.trim_start_matches(['/', '\\']))
            } else if Path::new(&token).is_absolute() {
                PathBuf::from(&token)
            } else {
                dir.join(&token)
            };
            self.add(&target, depth + 1, false, false);
        }
    }
}

/// `@path` imports in an instruction file: an `@` not preceded by a word
/// character or another `@`, then everything up to whitespace or a quote or
/// angle bracket, without trailing punctuation (3.x `_STARTUP_IMPORT_RE`).
#[nolog] // scans a whole instruction file
fn imports(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let free = i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_' || chars[i - 1] == '@');
        if chars[i] != '@' || !free {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && !chars[j].is_whitespace() && !matches!(chars[j], '`' | '"' | '\'' | '<' | '>') {
            j += 1;
        }
        let token: String = chars[i + 1..j].iter().collect();
        let token = token.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}']);
        if !token.is_empty() {
            out.push(token.to_string());
        }
        i = j.max(i + 1);
    }
    out
}

/// The first 25 KiB, then at most 200 lines of that (line ends kept).
#[nolog] // works on a whole file
fn memory_prefix(data: &[u8]) -> &[u8] {
    let data = &data[..data.len().min(MEMORY_BYTES)];
    let (mut lines, mut i) = (0, 0);
    while i < data.len() && lines < MEMORY_LINES {
        match data[i] {
            b'\n' => lines += 1,
            b'\r' => {
                if data.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                lines += 1;
            }
            _ => {}
        }
        i += 1;
    }
    &data[..i]
}

/// A rule without a `paths:` key in its front matter loads at start.
#[nolog] // works on a whole file
fn startup_rule(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(data);
    let Some(rest) = text.strip_prefix("---") else { return true };
    let front = rest.find("\n---").map(|end| &rest[..end]).unwrap_or(rest);
    !front.lines().any(|line| line.strip_prefix("paths").is_some_and(|after| after.trim_start().starts_with(':')))
}

/// The `.md` files of a rules tree, in sorted order.
#[nolog] // a helper of `claude`, which `digest` logs
fn rule_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > RULES_DEPTH || out.len() >= RULES_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= RULES_FILES {
            return;
        }
        if p.is_dir() {
            rule_files(&p, depth + 1, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

#[nolog] // per file
fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// A path as the manifest keys it: case-folded where the file system is.
#[nolog] // per file
fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) { s.replace('/', "\\").to_lowercase() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standing_notes_preserve_both_files_and_skip_native_imports_and_repeat_grants() {
        let root = std::env::temp_dir().join(format!("standing-notes-{}", uuid::Uuid::new_v4()));
        let own = root.join("own");
        let grant = root.join("grant");
        for dir in [&own, &grant] { std::fs::create_dir_all(dir).unwrap(); }
        std::fs::write(own.join("AGENTS.md"), "canonical own").unwrap();
        std::fs::write(grant.join("AGENTS.md"), "canonical grant").unwrap();
        std::fs::write(grant.join("CLAUDE.md"), "legacy grant").unwrap();
        let claude = Inputs::Claude { cwd: own.clone(), config: root.join("config"), home: root.clone(), add_dirs: vec![grant.clone()] };
        let dirs = vec![grant.clone(), grant.clone(), own.clone()];
        let (o, g) = standing_notes(&claude, &own, &dirs);
        assert!(o.is_empty()); // native fallback
        assert_eq!(g.len(), 2);
        let before = digest(&claude);
        std::fs::write(own.join("AGENTS.md"), "canonical own edited").unwrap();
        assert_ne!(before, digest(&claude));
        std::fs::write(own.join("CLAUDE.md"), "legacy own").unwrap();
        let (o, g) = standing_notes(&claude, &own, &dirs);
        assert_eq!(o.iter().map(|(_,t)| t.as_str()).collect::<Vec<_>>(), ["canonical own edited"]);
        assert_eq!(g.len(), 2);
        std::fs::write(own.join("CLAUDE.md"), "legacy own\n@AGENTS.md").unwrap();
        assert!(standing_notes(&claude, &own, &dirs).0.is_empty());
        let codex = Inputs::Codex { cwd: own.clone(), home: root.join("codex") };
        assert_eq!(standing_notes(&codex, &own, &dirs).0.len(), 1); // legacy only
        std::fs::write(own.join("AGENTS.override.md"), "native override").unwrap();
        assert_eq!(standing_notes(&codex, &own, &dirs).0.len(), 2); // canonical not read natively
        let (o, g) = standing_notes(&Inputs::None, &own, &dirs);
        assert_eq!((o.len(), g.len()), (2, 2)); // Antigravity
        assert_eq!(std::fs::read_to_string(own.join("CLAUDE.md")).unwrap(), "legacy own\n@AGENTS.md");
        // Only this test's verified unique temporary root is removed.
        std::fs::remove_dir_all(root).unwrap();
    }
}
