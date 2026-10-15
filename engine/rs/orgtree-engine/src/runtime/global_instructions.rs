//! Read-only personal instruction sources shared by every runtime. Discovery
//! never scans a project or writes into a harness profile. A snapshot owns the
//! exact bytes used both by the prompt and its startup fingerprint.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq)]
pub struct Roots {
    pub home: PathBuf,
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub gemini: PathBuf,
    pub agy: PathBuf,
    pub config: PathBuf,
    /// Only a rig sets this. Canonical targets, including directory links,
    /// must remain below this root before any contents are read.
    confined: bool,
}

impl Roots {
    #[nolog] // paths only; no environment values are logged
    pub fn current() -> Option<Self> {
        let home = crate::rig::home_dir()?;
        Some(Self::resolve(home, crate::rig::active(), |key| std::env::var_os(key).map(PathBuf::from)))
    }

    #[nolog]
    fn resolve(home: PathBuf, confined: bool, env: impl Fn(&str) -> Option<PathBuf>) -> Self {
        let root = |key: &str, fallback: PathBuf| {
            if confined { fallback } else { env(key).filter(|p| !p.as_os_str().is_empty() && p.is_absolute()).unwrap_or(fallback) }
        };
        Self {
            claude: root("CLAUDE_CONFIG_DIR", home.join(".claude")),
            codex: root("CODEX_HOME", home.join(".codex")),
            // Gemini 0.57's paths.homedir() treats this as a replacement HOME,
            // then Storage/getGlobalMemoryPaths append .gemini themselves.
            gemini: root("GEMINI_CLI_HOME", home.clone()).join(".gemini"),
            agy: home.join(".gemini/config"),
            config: root("XDG_CONFIG_HOME", home.join(".config")),
            home,
            confined,
        }
    }

    #[nolog] // the returned snapshot contains user instruction text
    pub fn read(&self) -> Snapshot {
        let mut scan = Scan { roots: self, result: Snapshot::default(), directories: HashSet::new() };
        scan.add(&self.claude.join("CLAUDE.md"));
        scan.rules(&self.claude.join("rules"), RuleKind::Claude);
        scan.first(&self.codex, &["AGENTS.override.md", "AGENTS.md"]);
        // The Gemini CLI allows a global filename or list of filenames. Only
        // filenames (not arbitrary paths) participate in global discovery.
        let names = scan.gemini_names();
        for name in names { scan.add(&self.gemini.join(name)); }
        scan.agy();
        scan.first(&self.config.join("muse"), &["AGENTS.md", "CLAUDE.md"]);
        scan.add(&self.config.join("opencode/AGENTS.md"));
        scan.result
    }
}

/// Agy 1.3.5's shipped changelog names both legacy files and their config/
/// counterparts as native globals, including canonical-path deduplication.
/// Its customization docs also identify config/rules as a global rule root.
#[nolog]
pub(super) fn native_agy(home: &Path) -> BTreeMap<String, String> {
    let roots = Roots::resolve(home.to_path_buf(), crate::rig::active(), |_| None);
    let mut scan = Scan { roots: &roots, result: Snapshot::default(), directories: HashSet::new() };
    scan.agy();
    scan.result.files.into_iter().map(|(key, file)| (key, hex::encode(Sha256::digest(file.text.as_bytes())))).collect()
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum RuleKind { Claude, Agy }

/// File-triggered and on-demand rules are not personal "always read" notes.
/// Standalone GEMINI.md/AGENTS.md are added separately without frontmatter.
#[nolog]
fn always_on(text: &str, kind: RuleKind) -> bool {
    match kind {
        RuleKind::Claude => super::startup::startup_rule(text.as_bytes()),
        RuleKind::Agy => {
            let mut lines = text.trim_start_matches('\u{feff}').lines();
            if lines.next().map(str::trim) != Some("---") { return true; }
            for line in lines {
                let line = line.trim();
                if line == "---" { break; }
                if let Some(value) = line.strip_prefix("trigger:") {
                    let value = value.split('#').next().unwrap_or("").trim().trim_matches(['\'', '"']);
                    return value == "always_on";
                }
            }
            true
        }
    }
}

/// Deliberately no Debug/Serialize implementation: text is private to launch
/// planning. Public responses contain counts only.
#[derive(Default)]
pub struct Snapshot {
    files: BTreeMap<String, File>,
    faults: BTreeMap<String, &'static str>,
}

struct File {
    path: String,
    text: String,
}

impl Snapshot {
    #[nolog]
    pub fn keys(&self) -> impl Iterator<Item = &String> { self.files.keys() }

    #[nolog]
    pub fn count(&self) -> usize { self.files.len() }

    #[nolog]
    pub fn errors(&self) -> usize { self.faults.len() }

    /// Canonical ordering and explicit lengths prevent delimiter ambiguities;
    /// labels and errors participate as well as the exact supplied text.
    #[nolog]
    pub fn fingerprint(&self) -> String {
        if self.files.is_empty() && self.faults.is_empty() { return String::new(); }
        let mut hash = Sha256::new();
        for (key, file) in &self.files {
            for value in [key.as_str(), file.path.as_str(), file.text.as_str()] {
                hash.update((value.len() as u64).to_le_bytes()); hash.update(value.as_bytes());
            }
        }
        for (key, reason) in &self.faults {
            hash.update(b"error"); hash.update((key.len() as u64).to_le_bytes()); hash.update(key.as_bytes()); hash.update(reason.as_bytes());
        }
        hex::encode(hash.finalize())
    }

    #[nolog]
    pub fn notes(&self, native: &HashSet<String>) -> String {
        let mut out = String::new();
        for (key, file) in &self.files {
            if native.contains(key) { continue; }
            if out.is_empty() {
                out.push_str("\n\n[PERSONAL GLOBAL INSTRUCTIONS shared across harnesses]\nThese are the user's global instructions. Source files are read-only here; this delivery does not grant permission to edit them.\n");
            }
            out.push_str(&format!("\n--- {} ---\n{}\n", file.path.replace(['\r', '\n'], " "), file.text));
        }
        if !out.is_empty() { out.push_str("[END PERSONAL GLOBAL INSTRUCTIONS]\n"); }
        out
    }
}

struct Scan<'a> {
    roots: &'a Roots,
    result: Snapshot,
    directories: HashSet<(String, RuleKind)>,
}

impl Scan<'_> {
    /// Stat/canonicalize before reading. Missing is normal; any other failure
    /// is recorded without exposing its path or OS error text in the API.
    #[nolog]
    fn target(&mut self, path: &Path) -> Option<PathBuf> {
        match std::fs::canonicalize(path) {
            Ok(target) => {
                if self.roots.confined && !std::fs::canonicalize(&self.roots.home).is_ok_and(|root| target.starts_with(root)) {
                    self.result.faults.insert(key(path), "outside rig-home"); return None;
                }
                Some(target)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(path).is_ok() {
                    self.result.faults.insert(key(path), "unreadable link target");
                }
                None
            }
            Err(_) => { self.result.faults.insert(key(path), "unreadable"); None }
        }
    }

    #[nolog]
    fn bytes(&mut self, path: &Path) -> Option<(PathBuf, String)> {
        let target = self.target(path)?;
        match std::fs::read_to_string(&target) {
            Ok(text) => Some((target, text)),
            Err(_) => { self.result.faults.insert(key(path), "unreadable UTF-8 file"); None }
        }
    }

    #[nolog]
    fn add(&mut self, path: &Path) {
        let Some((target, text)) = self.bytes(path) else { return };
        if text.trim_start_matches('\u{feff}').trim().is_empty() { return; }
        self.result.files.entry(key(&target)).or_insert_with(|| File { path: path.to_string_lossy().into_owned(), text });
    }

    #[nolog]
    fn first(&mut self, root: &Path, names: &[&str]) {
        for name in names {
            let path = root.join(name);
            if self.target(&path).is_some() { self.add(&path); return; }
            // An unreadable override must not silently select the lower file.
            if self.result.faults.contains_key(&key(&path)) { return; }
        }
    }

    #[nolog]
    fn rules(&mut self, path: &Path, kind: RuleKind) {
        let Some(target) = self.target(path) else { return };
        if !self.directories.insert((key(&target), kind)) { return; }
        let entries = match std::fs::read_dir(&target) {
            Ok(entries) => entries,
            Err(_) => { self.result.faults.insert(key(path), "unreadable directory"); return; }
        };
        let mut files = Vec::new();
        for entry in entries {
            match entry {
                Ok(entry) => files.push(path.join(entry.file_name())),
                Err(_) => { self.result.faults.insert(key(path), "unreadable directory entry"); }
            }
        }
        files.sort();
        for file in files {
            // Resolve even directories before following them, including links.
            let Some(target) = self.target(&file) else { continue };
            if target.is_dir() { self.rules(&file, kind); }
            else if file.extension().is_some_and(|extension| extension == "md") {
                if let Some((target, text)) = self.bytes(&file) {
                    if !text.trim_start_matches('\u{feff}').trim().is_empty() && always_on(&text, kind) {
                        self.result.files.entry(key(&target)).or_insert_with(|| File { path: file.to_string_lossy().into_owned(), text });
                    }
                }
            }
        }
    }

    #[nolog]
    fn agy(&mut self) {
        for dir in [self.roots.home.join(".gemini"), self.roots.agy.clone()] {
            for name in ["GEMINI.md", "AGENTS.md"] { self.add(&dir.join(name)); }
        }
        self.rules(&self.roots.agy.join("rules"), RuleKind::Agy);
    }

    #[nolog]
    fn gemini_names(&mut self) -> Vec<String> {
        let path = self.roots.gemini.join("settings.json");
        let Some((_, text)) = self.bytes(&path) else { return vec!["GEMINI.md".into()] };
        let parsed = crate::providers::jsonc(&text).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let Some(settings) = parsed.filter(Value::is_object) else {
            self.result.faults.insert(key(&path), "invalid settings"); return vec!["GEMINI.md".into()];
        };
        let Some(names) = settings.pointer("/context/fileName") else { return vec!["GEMINI.md".into()] };
        let values: Vec<&Value> = names.as_array().map(|list| list.iter().collect()).unwrap_or_else(|| vec![names]);
        let mut result = Vec::new();
        for value in values {
            if let Some(name) = value.as_str().filter(|name| !name.is_empty() && !name.contains(['/', '\\', ':']) && *name != "." && *name != "..") {
                if !result.iter().any(|old| old == name) { result.push(name.to_string()); }
            } else { self.result.faults.insert(key(&path), "invalid context filename"); }
        }
        result
    }
}

#[nolog]
pub fn key(path: &Path) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = crate::config::strip_verbatim(&path).to_string_lossy().into_owned();
    if cfg!(windows) { text.replace('/', "\\").to_lowercase() } else { text }
}

/// Selected account profiles are native inputs, but their personal files must
/// still stay inside the synthetic home when a rig checks their fingerprints.
#[nolog]
pub(super) fn native_bytes(path: &Path) -> Option<Vec<u8>> {
    let home = if crate::rig::active() { Some(crate::rig::home_dir()?) } else { None };
    native_bytes_within(path, home.as_deref())
}

#[nolog]
fn native_bytes_within(path: &Path, home: Option<&Path>) -> Option<Vec<u8>> {
    let target = std::fs::canonicalize(path).ok()?;
    if home.is_some_and(|root| !std::fs::canonicalize(root).is_ok_and(|root| target.starts_with(root))) { return None; }
    std::fs::read(target).ok()
}

/// Refresh does not alter an active process or write a file. Actor launch and
/// idle checks independently read fresh snapshots at their existing boundary.
#[logged]
pub fn refresh() -> Result<Value, usize> {
    let snapshot = Roots::current().map(|roots| roots.read()).unwrap_or_default();
    if snapshot.errors() > 0 { Err(snapshot.errors()) }
    else { Ok(json!({ "files": snapshot.count(), "refreshed": true })) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::startup::{self, Inputs};

    struct Fixture { root: PathBuf, roots: Roots }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("global-notes-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let roots = Roots::resolve(root.join("home"), true, |_| None);
            std::fs::create_dir_all(&roots.home).unwrap();
            Self { root, roots }
        }

        fn write(&self, relative: &str, text: &str) -> PathBuf {
            let path = self.roots.home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        }

        fn shared(&self, native: Inputs) -> Inputs {
            Inputs::Shared { native: Box::new(native), roots: self.roots.clone() }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn discovers_personal_sources_and_skips_empty_scoped_and_project_files() {
        let f = Fixture::new();
        for (file, text) in [
            (".claude/CLAUDE.md", "CLAUDE_GLOBAL"),
            (".claude/rules/z.md", "RULE_Z"),
            (".claude/rules/nested/a.md", "RULE_A"),
            (".claude/rules/empty.md", "\u{feff} \r\n"),
            (".claude/rules/scoped.md", "---\npaths: ['src/**']\n---\nLAZY_RULE"),
            (".codex/AGENTS.md", "CODEX_GLOBAL"),
            (".gemini/GEMINI.md", "GEMINI_GLOBAL"),
            (".gemini/config/rules/user.md", "AGY_GLOBAL"),
            (".config/muse/AGENTS.md", "MUSE_GLOBAL"),
            (".config/opencode/AGENTS.md", "OPENCODE_GLOBAL"),
            ("AGENTS.md", "PROJECT_ONLY"),
            ("project/.claude/CLAUDE.md", "PROJECT_ONLY"),
        ] { f.write(file, text); }
        let snapshot = f.roots.read();
        assert_eq!(snapshot.errors(), 0);
        assert_eq!(snapshot.count(), 8);
        let notes = snapshot.notes(&HashSet::new());
        for marker in ["CLAUDE_GLOBAL", "RULE_Z", "RULE_A", "CODEX_GLOBAL", "GEMINI_GLOBAL", "AGY_GLOBAL", "MUSE_GLOBAL", "OPENCODE_GLOBAL"] {
            assert_eq!(notes.matches(marker).count(), 1, "{marker}");
        }
        assert!(!notes.contains("LAZY_RULE"));
        assert!(!notes.contains("PROJECT_ONLY"));
        assert!(!notes.contains("empty.md"));
        assert!(notes.contains(".claude"));
    }

    #[test]
    fn native_profile_dedup_and_isolated_profile_delivery_use_actual_paths() {
        let f = Fixture::new();
        let source = f.write(".codex/AGENTS.md", "PERSONAL_CODEX");
        f.write(".gemini/GEMINI.md", "PERSONAL_GEMINI");
        let cwd = f.root.join("workspace");
        std::fs::create_dir_all(&cwd).unwrap();
        let same = f.shared(Inputs::Codex { cwd: cwd.clone(), home: f.roots.codex.clone() });
        let native = startup::snapshot(&same);
        assert!(!native.global_notes.contains("PERSONAL_CODEX"));
        assert_eq!(native.global_notes.matches("PERSONAL_GEMINI").count(), 1);
        let isolated = f.shared(Inputs::Codex { cwd: cwd.clone(), home: f.root.join("isolated-profile") });
        let mirrored = startup::snapshot(&isolated);
        assert_eq!(mirrored.global_notes.matches("PERSONAL_CODEX").count(), 1);
        let (_, grants) = mirrored.standing_notes(&cwd, &[source.parent().unwrap().to_path_buf()]);
        assert!(grants.is_empty(), "a granted personal root must not duplicate the shared file");
    }

    #[test]
    fn muse_uses_its_selected_config_for_native_exclusion_without_losing_foreign_rules() {
        let f = Fixture::new();
        f.write(".config/muse/AGENTS.md", "MUSE_PERSONAL");
        f.write(".claude/CLAUDE.md", "CLAUDE_PERSONAL");
        let cwd = f.root.join("workspace");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join("AGENTS.md"), "MUSE_PROJECT").unwrap();
        let same = startup::snapshot(&f.shared(Inputs::Muse { cwd: cwd.clone(), config: f.roots.config.join("muse") }));
        assert!(!same.global_notes.contains("MUSE_PERSONAL"));
        assert_eq!(same.global_notes.matches("CLAUDE_PERSONAL").count(), 1);
        assert!(same.standing_notes(&cwd, &[]).0.is_empty(), "native project rules stay native");
        let isolated = startup::snapshot(&f.shared(Inputs::Muse { cwd, config: f.root.join("separate/config/muse") }));
        assert_eq!(isolated.global_notes.matches("MUSE_PERSONAL").count(), 1);
    }

    #[test]
    fn muse_legacy_global_is_used_only_when_canonical_file_is_absent() {
        let f = Fixture::new();
        f.write(".config/muse/CLAUDE.md", "MUSE_LEGACY");
        let native = f.shared(Inputs::Muse { cwd: f.root.clone(), config: f.roots.config.join("muse") });
        assert!(f.roots.read().notes(&HashSet::new()).contains("MUSE_LEGACY"));
        assert!(startup::snapshot(&native).global_notes.is_empty());
        f.write(".config/muse/AGENTS.md", "MUSE_CANONICAL");
        let notes = f.roots.read().notes(&HashSet::new());
        assert!(notes.contains("MUSE_CANONICAL"));
        assert!(!notes.contains("MUSE_LEGACY"));
        assert!(startup::snapshot(&native).global_notes.is_empty());
    }

    #[test]
    fn agy_legacy_config_and_always_on_rules_load_once_and_stay_native() {
        let f = Fixture::new();
        for (file, text) in [
            (".gemini/GEMINI.md", "LEGACY_GEMINI"),
            (".gemini/AGENTS.md", "LEGACY_AGENTS"),
            (".gemini/config/GEMINI.md", "CONFIG_GEMINI"),
            (".gemini/config/AGENTS.md", "CONFIG_AGENTS"),
            (".gemini/config/rules/always.md", "---\ntrigger: always_on\n---\nALWAYS_RULE"),
            (".gemini/config/rules/lazy.md", "---\ntrigger: model_decision\n---\nLAZY_RULE"),
            (".gemini/config/rules/file.md", "---\ntrigger: glob\nglobs: '*.rs'\n---\nFILE_RULE"),
            (".claude/CLAUDE.md", "FOREIGN_CLAUDE"),
        ] { f.write(file, text); }
        let global = f.roots.read();
        assert_eq!(global.errors(), 0);
        assert_eq!(global.count(), 6);
        let shared = global.notes(&HashSet::new());
        for marker in ["LEGACY_GEMINI", "LEGACY_AGENTS", "CONFIG_GEMINI", "CONFIG_AGENTS", "ALWAYS_RULE"] {
            assert_eq!(shared.matches(marker).count(), 1);
        }
        assert!(!shared.contains("LAZY_RULE"));
        assert!(!shared.contains("FILE_RULE"));
        let native = startup::snapshot(&f.shared(Inputs::Agy { home: f.roots.home.clone() }));
        assert!(native.global_notes.contains("FOREIGN_CLAUDE"));
        assert!(!native.global_notes.contains("LEGACY_"));
        assert!(!native.global_notes.contains("CONFIG_"));
        assert!(!native.global_notes.contains("ALWAYS_RULE"));
    }

    #[test]
    fn codex_global_override_replaces_regular_file_in_discovery_and_native_manifest() {
        let f = Fixture::new();
        f.write(".codex/AGENTS.md", "LOWER_PRIORITY");
        f.write(".codex/AGENTS.override.md", "OVERRIDE_PRIORITY");
        let snapshot = f.roots.read();
        let notes = snapshot.notes(&HashSet::new());
        assert_eq!(snapshot.count(), 1);
        assert!(notes.contains("OVERRIDE_PRIORITY"));
        assert!(!notes.contains("LOWER_PRIORITY"));
        let cwd = f.root.join("workspace");
        std::fs::create_dir_all(&cwd).unwrap();
        let native = startup::snapshot(&f.shared(Inputs::Codex { cwd, home: f.roots.codex.clone() }));
        assert!(native.global_notes.is_empty());
    }

    #[test]
    fn identical_reads_are_byte_identical_and_captured_text_survives_later_edits() {
        let f = Fixture::new();
        let path = f.write(".gemini/GEMINI.md", "FIRST_BYTES\n");
        let inputs = f.shared(Inputs::None);
        let first = startup::snapshot(&inputs);
        let identical = startup::snapshot(&inputs);
        assert_eq!(first.digest, identical.digest);
        assert_eq!(first.global_notes, identical.global_notes);
        std::fs::write(&path, "SECOND_BYTES\n").unwrap();
        let next = startup::snapshot(&inputs);
        assert_ne!(next.digest, first.digest);
        assert!(first.global_notes.contains("FIRST_BYTES"));
        assert!(!first.global_notes.contains("SECOND_BYTES"));
        assert!(next.global_notes.contains("SECOND_BYTES"));
        assert_eq!(startup::digest(&inputs), next.digest);
        std::fs::remove_file(path).unwrap();
        assert_ne!(startup::digest(&inputs), next.digest);
        assert!(startup::snapshot(&inputs).global_notes.is_empty());
    }

    #[test]
    fn root_overrides_are_respected_normally_and_ignored_in_rig_mode() {
        let f = Fixture::new();
        let external = f.root.join("external");
        let normal = Roots::resolve(f.roots.home.clone(), false, |_| Some(external.clone()));
        for root in [&normal.claude, &normal.codex, &normal.config] { assert_eq!(root, &external); }
        assert_eq!(normal.gemini, external.join(".gemini"));
        let rig = Roots::resolve(f.roots.home.clone(), true, |_| Some(external.clone()));
        assert_eq!(rig, f.roots);
    }

    #[test]
    fn canonical_aliases_share_one_block_and_native_identity_excludes_it() {
        let f = Fixture::new();
        let path = f.write(".claude/CLAUDE.md", "SHARED_ALIAS_MARKER");
        f.write(".claude/settings.json", r#"{"context":{"fileName":"CLAUDE.md"}}"#);
        std::fs::create_dir_all(f.roots.claude.join("alias")).unwrap();
        let mut roots = f.roots.clone();
        roots.gemini = roots.claude.join("alias/..");
        let snapshot = roots.read();
        assert_eq!(snapshot.count(), 1);
        assert_eq!(snapshot.notes(&HashSet::new()).matches("SHARED_ALIAS_MARKER").count(), 1);
        assert!(snapshot.notes(&HashSet::from([key(&path)])).is_empty());
    }

    #[test]
    fn rig_rejects_external_targets_before_reading_their_contents() {
        let f = Fixture::new();
        let outside = f.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("CLAUDE.md"), "DO_NOT_IMPORT_THIS").unwrap();
        let mut roots = f.roots.clone();
        roots.claude = outside;
        let snapshot = roots.read();
        assert!(snapshot.errors() > 0);
        assert_eq!(snapshot.count(), 0);
        assert!(!snapshot.notes(&HashSet::new()).contains("DO_NOT_IMPORT_THIS"));
    }

    #[test]
    fn native_personal_fingerprints_obey_the_same_rig_home_boundary() {
        let f = Fixture::new();
        let inside = f.write(".config/muse/AGENTS.md", "INSIDE");
        let outside = f.root.join("outside.md");
        std::fs::write(&outside, "OUTSIDE").unwrap();
        assert_eq!(native_bytes_within(&inside, Some(&f.roots.home)), Some(b"INSIDE".to_vec()));
        assert!(native_bytes_within(&outside, Some(&f.roots.home)).is_none());
        assert_eq!(native_bytes_within(&outside, None), Some(b"OUTSIDE".to_vec()));
    }

    #[cfg(unix)]
    #[test]
    fn rig_rejects_symlink_escape_and_rule_directory_cycles_terminate() {
        let f = Fixture::new();
        let outside = f.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("CLAUDE.md"), "OUTSIDE").unwrap();
        std::os::unix::fs::symlink(&outside, &f.roots.claude).unwrap();
        assert!(f.roots.read().errors() > 0);
        f.write(".gemini/config/rules/inside.md", "INSIDE");
        std::os::unix::fs::symlink(f.roots.agy.join("rules"), f.roots.agy.join("rules/loop")).unwrap();
        assert_eq!(f.roots.read().count(), 1);
    }

    #[test]
    fn malformed_or_unreadable_existing_sources_are_explicit_errors() {
        let f = Fixture::new();
        f.write(".gemini/settings.json", "{broken");
        f.write(".gemini/GEMINI.md", "KNOWN_FILE");
        std::fs::create_dir_all(f.roots.codex.join("AGENTS.override.md")).unwrap();
        f.write(".codex/AGENTS.md", "MUST_NOT_FALL_BACK");
        let path = f.write(".claude/CLAUDE.md", "");
        std::fs::write(path, [0xff, 0xfe, 0x00]).unwrap();
        let snapshot = f.roots.read();
        assert_eq!(snapshot.errors(), 3);
        let notes = snapshot.notes(&HashSet::new());
        assert!(notes.contains("KNOWN_FILE"));
        assert!(!notes.contains("MUST_NOT_FALL_BACK"));
    }

    #[test]
    fn configured_gemini_filenames_cannot_become_arbitrary_paths() {
        let f = Fixture::new();
        f.write(".gemini/settings.json", r#"{"context":{"fileName":["PERSONAL.md","PERSONAL.md","../other.md"]}}"#);
        f.write(".gemini/PERSONAL.md", "CUSTOM_FILENAME");
        f.write("other.md", "OUT_OF_SCOPE");
        let snapshot = f.roots.read();
        assert_eq!(snapshot.errors(), 1);
        assert_eq!(snapshot.count(), 1);
        let notes = snapshot.notes(&HashSet::new());
        assert_eq!(notes.matches("CUSTOM_FILENAME").count(), 1);
        assert!(!notes.contains("OUT_OF_SCOPE"));
    }

    #[test]
    fn gemini_comment_settings_select_names_and_preserve_quoted_slashes() {
        let f = Fixture::new();
        f.write(".gemini/settings.json", "{ // user's global configuration\n\"context\": {\"fileName\": [\"PERSONAL.md\"]}, /* comment */ \"ignored\": \"https://example.invalid/\"}");
        f.write(".gemini/PERSONAL.md", "CONFIGURED_GEMINI");
        let global = f.roots.read();
        assert_eq!(global.errors(), 0);
        assert_eq!(global.count(), 1);
        assert!(global.notes(&HashSet::new()).contains("CONFIGURED_GEMINI"));
    }

    #[test]
    fn no_global_files_preserve_the_existing_native_digest() {
        let f = Fixture::new();
        let native = Inputs::Codex { cwd: f.root.clone(), home: f.roots.codex.clone() };
        assert_eq!(startup::digest(&native), startup::digest(&f.shared(native.clone())));
        assert_eq!(startup::digest(&f.shared(Inputs::None)), "");
        assert_eq!(startup::digest(&f.shared(Inputs::Agy { home: f.roots.home.clone() })), "");
        let empty = f.write(".gemini/GEMINI.md", " \r\n");
        assert_eq!(startup::digest(&f.shared(Inputs::None)), "");
        assert_eq!(std::fs::read_to_string(empty).unwrap(), " \r\n");
    }
}
