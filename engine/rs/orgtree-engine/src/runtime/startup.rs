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
//! - Codex: <CODEX_HOME>/AGENTS.override.md or AGENTS.md, and in each folder from a `.git` root (or
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
    /// Muse Code: the actual config/muse root and trusted workspace rules.
    Muse { cwd: PathBuf, config: PathBuf },
    /// Antigravity's personal rules and workspace notes load natively;
    /// generated identity rules are excluded from startup input hashing.
    Agy { home: PathBuf, cwd: PathBuf },
    /// A lane with no native instruction manifest (e.g. isolated OpenCode).
    None,
    /// The native account/profile inputs plus the user's personal global
    /// sources. Paths, not text, are retained for idle boundary rechecks.
    Shared { native: Box<Inputs>, roots: super::global_instructions::Roots },
}

#[nolog]
pub fn with_globals(native: Inputs) -> Inputs {
    match super::global_instructions::Roots::current() {
        Some(roots) => Inputs::Shared { native: Box::new(native), roots },
        None => native,
    }
}

/// The startup files' digest: equal exactly when no startup file changed.
#[logged]
pub fn digest(inputs: &Inputs) -> String {
    snapshot(inputs).digest
}

/// No Debug/Serialize: this holds private instruction text for ONE plan.
pub struct Snapshot {
    pub digest: String,
    pub global_notes: String,
    handled: HashSet<String>,
}

/// Capture shared text and its digest together. A later edit cannot make the
/// fingerprint describe different bytes than the prompt this plan supplies.
#[nolog]
pub fn snapshot(inputs: &Inputs) -> Snapshot {
    let (native, global) = match inputs {
        Inputs::Shared { native, roots } => (native.as_ref(), roots.read()),
        native => (native, super::global_instructions::Snapshot::default()),
    };
    let files = native_files(native);
    let native_keys: HashSet<String> = files.keys().map(|path| file_key(Path::new(path))).collect();
    let global_notes = global.notes(&native_keys);
    let mut handled = native_keys;
    handled.extend(global.keys().cloned());
    let native_digest = if matches!(native, Inputs::None) || (matches!(native, Inputs::Agy { .. }) && files.is_empty()) { String::new() } else {
        hex::encode(&Sha256::digest(serde_json::to_vec(&files).unwrap_or_default())[..12])
    };
    let shared = global.fingerprint();
    let digest = if shared.is_empty() { native_digest } else {
        hex::encode(&Sha256::digest(format!("{native_digest}|global:{shared}").as_bytes())[..12])
    };
    Snapshot { digest, global_notes, handled }
}

/// Native files only: used both for cache invalidation and avoiding duplicate delivery.
#[nolog] // filesystem inventory helper; callers record the operation
fn native_files(inputs: &Inputs) -> BTreeMap<String, String> {
    match inputs {
        Inputs::Claude { cwd, config, home, .. } => claude(cwd, config, home),
        Inputs::Codex { cwd, home } => codex(cwd, home),
        Inputs::Muse { cwd, config } => muse(cwd, config),
        Inputs::Agy { home, cwd } => {
            let mut files = super::global_instructions::native_agy(home);
            files.extend(agy_project(cwd));
            files
        },
        Inputs::None => BTreeMap::new(),
        Inputs::Shared { native, .. } => native_files(native),
    }
}

/// The scratch workspace is agy's only --add-dir. Native standing notes must
/// not also be mirrored in identity. The generated rules are already accounted
/// for by system_prompt/org_notes, so never hash them back into startup.
#[nolog]
pub fn agy_project(cwd: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    for name in ["AGENTS.md", "GEMINI.md", ".agents/AGENTS.md", ".agents/GEMINI.md"] {
        let path = cwd.join(name);
        if let Ok(bytes) = std::fs::read(&path) { files.insert(norm(&path), sha(&bytes)); }
    }
    files
}

/// Muse 1.4.6 reads, in the session's workspace root, the first of these that
/// exists (its configuration docs; the workspace's AGENTS.md measured loaded
/// as a trusted project rule, 2026-10-12). A further workspace root's file
/// is not read (measured), so granted folders' notes stay in the prompt.
#[nolog] // `digest` logs the call
fn muse(cwd: &Path, config: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    // Pinned Muse 1.4.6 /rules measured AGENTS.md, then CLAUDE.md fallback.
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let global = config.join(name);
        if let Some(bytes) = super::global_instructions::native_bytes(&global) { files.insert(norm(&global), sha(&bytes)); break; }
    }
    for name in ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".claude/CLAUDE.md"] {
        let p = cwd.join(name);
        if let Ok(bytes) = std::fs::read(&p) {
            files.insert(norm(&p), sha(&bytes));
            break;
        }
    }
    files
}

pub type Notes = Vec<(String, String)>;

/// Read both generations of standing notes without modifying either file. Native
/// files (including Claude imports) and repeated grants are delivered just once.
#[logged]
pub fn standing_notes(inputs: &Inputs, scratch: &Path, folders: &[PathBuf]) -> (Notes, Notes) {
    snapshot(inputs).standing_notes(scratch, folders)
}

impl Snapshot {
    /// Personal globals and native files are already delivered. Repeated
    /// grants of those same files must not add another copy to the identity.
    #[nolog]
    pub fn standing_notes(&self, scratch: &Path, folders: &[PathBuf]) -> (Notes, Notes) {
        let mut seen = self.handled.clone();
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
}

#[nolog] // per candidate path
fn file_key(path: &Path) -> String {
    super::global_instructions::key(path)
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
    for name in ["AGENTS.override.md", "AGENTS.md"] {
        let path = home.join(name);
        if path.is_file() {
            if let Some(bytes) = super::global_instructions::native_bytes(&path) { files.insert(norm(&path), sha(&bytes)); }
            break;
        }
    }
    let mut add = |p: &Path| {
        if let Ok(bytes) = std::fs::read(p) {
            files.insert(norm(p), sha(&bytes));
        }
    };
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
pub(super) fn startup_rule(data: &[u8]) -> bool {
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
    fn agy_notes_are_native_once_and_rule_writes_do_not_feed_back_into_startup() {
        let root = std::env::temp_dir().join(format!("agy-native-notes-{}", uuid::Uuid::new_v4()));
        let own = root.join("own");
        let grant = root.join("grant");
        std::fs::create_dir_all(own.join(".agents/rules")).unwrap();
        std::fs::create_dir_all(&grant).unwrap();
        std::fs::write(own.join("AGENTS.md"), "own notes").unwrap();
        std::fs::write(own.join("CLAUDE.md"), "legacy own notes").unwrap();
        std::fs::write(grant.join("AGENTS.md"), "granted notes").unwrap();
        let inputs = Inputs::Agy { home: root.join("home"), cwd: own.clone() };
        let notes = standing_notes(&inputs, &own, &[grant.clone()]);
        assert_eq!(notes.0.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>(), ["legacy own notes"]);
        assert_eq!(notes.1.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>(), ["granted notes"]);
        let first = digest(&inputs);
        std::fs::write(own.join(".agents/rules/orgtree-identity-0000.md"), "generated identity").unwrap();
        assert_eq!(first, digest(&inputs));
        assert_eq!(notes, standing_notes(&inputs, &own, &[grant]));
        std::fs::write(own.join("AGENTS.md"), "own notes changed").unwrap();
        assert_ne!(first, digest(&inputs));
        assert!(native_files(&inputs).contains_key(&norm(&own.join("AGENTS.md"))));
        std::fs::remove_dir_all(root).unwrap();
    }

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

    /// Muse reads only its workspace root's rules file (measured 2026-10-12):
    /// the agent's own AGENTS.md is native, and every granted folder's notes
    /// travel in the identity the way they do for the other lanes.
    #[test]
    fn muse_reads_its_own_rules_natively_and_gets_granted_folders_in_the_prompt() {
        let root = std::env::temp_dir().join(format!("standing-notes-muse-{}", uuid::Uuid::new_v4()));
        let own = root.join("own");
        let grant = root.join("grant");
        for dir in [&own, &grant] { std::fs::create_dir_all(dir).unwrap(); }
        std::fs::write(own.join("AGENTS.md"), "own rules").unwrap();
        std::fs::write(grant.join("AGENTS.md"), "granted rules").unwrap();
        std::fs::write(grant.join("CLAUDE.md"), "granted legacy").unwrap();
        let muse = Inputs::Muse { cwd: own.clone(), config: root.join("config/muse") };
        let (o, g) = standing_notes(&muse, &own, &[grant.clone()]);
        assert!(o.is_empty(), "the workspace root's AGENTS.md is Muse's own project rule");
        assert_eq!(g.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>(), ["granted rules", "granted legacy"]);
        // an edit to the native file is a startup-file change (a changed prefix)
        let before = digest(&muse);
        std::fs::write(own.join("AGENTS.md"), "own rules edited").unwrap();
        assert_ne!(before, digest(&muse));
        // with no AGENTS.md Muse falls back to CLAUDE.md, which is then native
        std::fs::remove_file(own.join("AGENTS.md")).unwrap();
        std::fs::write(own.join("CLAUDE.md"), "own legacy").unwrap();
        assert!(standing_notes(&muse, &own, &[grant.clone()]).0.is_empty());
        // Only this test's verified unique temporary root is removed.
        std::fs::remove_dir_all(root).unwrap();
    }
}
