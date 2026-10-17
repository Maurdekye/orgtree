//! Skill instructions/resources are private input, never Debug/Serialize/logged.
//! Discovery is read-only. Immutable snapshots are written only at launch boundaries.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
pub(crate) mod retention;
include!(concat!(env!("OUT_DIR"), "/builtin_skills.rs"));

const MAX_FILES: usize = 2048;
const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_BUNDLE: usize = 32 * 1024 * 1024;

#[derive(Clone)]
struct Bundle {
    name: String,
    sources: Vec<String>,
    files: Arc<BTreeMap<PathBuf, Vec<u8>>>,
    digest: String,
    executable: BTreeSet<PathBuf>,
}

#[derive(Default, Clone)]
pub struct Registry {
    initialized: bool,
    bundles: Vec<Bundle>,
    pub digest: String,
}

impl Registry {
    #[nolog]
    pub fn public(&self) -> Value {
        json!({"skills":self.bundles.iter().map(|b| json!({"name":b.name,"sources":b.sources})).collect::<Vec<_>>(),"digest":self.digest})
    }

    /// One stable path per complete content set; unchanged refresh never rewrites it.
    #[nolog]
    pub fn snapshot_path(&self, data: &Path) -> PathBuf {
        data.join("shared-skills").join(&self.digest)
    }

    #[nolog]
    pub fn materialize(&self, data: &Path) -> anyhow::Result<PathBuf> {
        let root = self.snapshot_path(data);
        reject_link(&root)?;
        if root.join("complete.json").is_file() {
            validate_export_tree(&root)?;
            return Ok(root);
        }
        let parent = data.join("shared-skills");
        reject_link(&parent)?;
        std::fs::create_dir_all(&parent)?;
        reject_link(&parent)?;
        let stage = parent.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&stage)?;
        std::fs::write(
            stage.join(".orgtree-skill.json"),
            serde_json::to_vec(&json!({"owner":"orgtree-skills-v1", "digest":self.digest}))?,
        )?;
        let result = (|| -> anyhow::Result<()> {
            std::fs::create_dir_all(stage.join("skills"))?;
            std::fs::create_dir_all(stage.join(".claude/skills"))?;
            for b in &self.bundles {
                if is_builtin(b) {
                    write_bundle(&stage.join("resources").join(&b.name), b)?;
                }
                for (tree, prefix) in [
                    ("skills", "../../resources"),
                    (".claude/skills", "../../../resources"),
                ] {
                    write_export(
                        &stage.join(tree).join(&b.name),
                        b,
                        &format!("{prefix}/{}", b.name),
                    )?;
                }
            }
            std::fs::write(
                stage.join("complete.json"),
                serde_json::to_vec(&self.public())?,
            )?;
            match std::fs::rename(&stage, &root) {
                Ok(()) => Ok(()),
                Err(_) if root.join("complete.json").is_file() => validate_export_tree(&root),
                Err(e) => Err(e.into()),
            }
        })();
        if stage.exists() {
            remove_owned(&parent, &stage)?;
        }
        result?;
        Ok(root)
    }

    #[nolog]
    pub fn names(&self) -> Vec<String> {
        self.bundles.iter().map(|b| b.name.clone()).collect()
    }

    /// Muse/AGY load native workspace folders. Names are reserved with orgtree-
    /// prefix; we only replace/remove bundles whose ownership marker matches.
    #[nolog]
    pub fn workspace(&self, scratch: &Path) -> anyhow::Result<()> {
        let root = scratch.join(".agents/skills");
        reject_link(&scratch.join(".agents"))?;
        reject_link(&root)?;
        std::fs::create_dir_all(&root)?;
        let names = workspace_names(&self.bundles);
        let want: BTreeSet<String> = names.iter().cloned().collect();
        for entry in sorted_entries(&root) {
            let path = entry.path();
            if owned(&path) && !want.contains(&entry.file_name().to_string_lossy().to_string()) {
                remove_owned(&root, &path)?;
            }
        }
        for (bundle, name) in self.bundles.iter().zip(names) {
            let mut b = bundle.clone();
            b.name = name;
            let dest = root.join(&b.name);
            reject_link(&dest)?;
            if is_builtin(&b) {
                let resources = scratch.join(".agents/orgtree-skill-resources")
                    .join(&self.digest).join(&b.name);
                reject_link(&resources)?;
                if resources.exists() {
                    anyhow::ensure!(owned(&resources), "unowned shared skill resources");
                    validate_export_tree(&resources)?;
                } else {
                    write_bundle(&resources, &b)?;
                }
            }
            if dest.exists() {
                validate_export_tree(&dest)?;
                anyhow::ensure!(
                    owned(&dest),
                    "a user-created skill occupies an Orgtree skill name"
                );
                let marker = super::plugins::json(&dest.join(".orgtree-skill.json"));
                if marker.as_ref().and_then(|v| v["digest"].as_str()) == Some(b.digest.as_str()) {
                    continue;
                }
                remove_owned(&root, &dest)?;
            }
            write_export(
                &dest,
                &b,
                &format!("../../orgtree-skill-resources/{}/{}", self.digest, b.name),
            )?;
        }
        Ok(())
    }
}

#[nolog]
fn remove_owned(root: &Path, path: &Path) -> anyhow::Result<()> {
    reject_link(root)?;
    reject_link(path)?;
    validate_export_tree(path)?;
    let root = std::fs::canonicalize(root)?;
    let actual = std::fs::canonicalize(path)?;
    anyhow::ensure!(
        actual.starts_with(&root) && actual != root && owned(&actual),
        "invalid shared skill cleanup path"
    );
    // A snapshot contains many bundles: source per-bundle limits do not apply
    // to cleanup. Never follow a link while making our own copies removable.
    prepare_owned_removal(&actual)?;
    std::fs::remove_dir_all(actual)?;
    Ok(())
}

#[nolog]
fn prepare_owned_removal(dir: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let meta = std::fs::symlink_metadata(&path)?;
        reject_link(&path)?;
        if meta.is_dir() {
            prepare_owned_removal(&path)?;
        }
        #[cfg(windows)]
        if meta.is_file() {
            let mut permissions = meta.permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(&path, permissions)?;
        }
    }
    Ok(())
}

#[nolog]
fn owned(path: &Path) -> bool {
    super::plugins::json(&path.join(".orgtree-skill.json"))
        .is_some_and(|v| v["owner"] == "orgtree-skills-v1")
}

#[nolog]
fn workspace_names(bundles: &[Bundle]) -> Vec<String> {
    let mut used: BTreeSet<_> = bundles
        .iter()
        .filter(|b| is_builtin(b))
        .map(|b| b.name.clone())
        .collect();
    bundles
        .iter()
        .map(|b| {
            if is_builtin(b) {
                return b.name.clone();
            }
            let stem = format!("orgtree-{}", b.name);
            let mut name = stem.clone();
            let mut n = 2;
            while !used.insert(name.clone()) {
                name = format!("{stem}-{n}");
                n += 1;
            }
            name
        })
        .collect()
}

#[nolog]
fn write_bundle(dest: &Path, bundle: &Bundle) -> anyhow::Result<()> {
    reject_link(dest)?;
    if dest.exists() {
        anyhow::ensure!(owned(dest), "unowned shared skill destination");
        validate_export_tree(dest)?;
    }
    for (relative, bytes) in bundle.files.iter() {
        anyhow::ensure!(relative.components().all(|c| matches!(c, std::path::Component::Normal(_))), "invalid skill resource path");
        let path = dest.join(relative);
        reject_link(&path)?;
        std::fs::create_dir_all(path.parent().unwrap_or(dest))?;
        reject_link(&path)?;
        let content = if relative == Path::new("SKILL.md") {
            rename_header(bytes, &bundle.name)
        } else {
            bytes.clone()
        };
        if std::fs::read(&path).ok().as_deref() == Some(content.as_slice()) {
            continue;
        }
        std::fs::write(&path, content)?;
        let mut permissions = std::fs::metadata(&path)?.permissions();
        permissions.set_readonly(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(if bundle.executable.contains(relative) {
                0o555
            } else {
                0o444
            });
        }
        std::fs::set_permissions(&path, permissions)?;
    }
    reject_link(&dest.join(".orgtree-skill.json"))?;
    std::fs::write(
        dest.join(".orgtree-skill.json"),
        serde_json::to_vec(&json!({"owner":"orgtree-skills-v1","digest":bundle.digest}))?,
    )?;
    Ok(())
}

#[nolog]
fn reject_link(path: &Path) -> anyhow::Result<()> {
    // Check missing leaves' existing ancestors too; Windows junctions are
    // reparse points even when file_type().is_symlink() does not identify them.
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() { continue; }
        let meta = match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = meta.file_type().is_symlink();
        anyhow::ensure!(!linked, "skill destination contains a link");
    }
    Ok(())
}

/// Cached ownership/completion markers are not authority to follow resource links.
#[nolog]
fn validate_export_tree(root: &Path) -> anyhow::Result<()> {
    reject_link(root)?;
    if !root.is_dir() { return Ok(()); }
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            reject_link(&path)?;
            if std::fs::symlink_metadata(&path)?.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(())
}

#[nolog]
fn is_builtin(bundle: &Bundle) -> bool {
    bundle.sources.iter().any(|s| s == "orgtree")
}

/// Nested built-in SKILL.md pages are resources, not additional advertised skills.
/// Preserve the whole tree outside native discovery; only retarget entry links.
#[nolog]
fn write_export(dest: &Path, bundle: &Bundle, resources: &str) -> anyhow::Result<()> {
    if !is_builtin(bundle) {
        return write_bundle(dest, bundle);
    }
    let mut entry = bundle.clone();
    let bytes = &bundle.files[Path::new("SKILL.md")];
    let text = String::from_utf8_lossy(bytes);
    let links = regex::Regex::new(r"(?m)(\]\(|^\s*\[[^\]]+\]:\s*)([^\s)]+)")
        .expect("static skill link regex");
    let rewritten = links.replace_all(&text, |c: &regex::Captures<'_>| {
        let target = &c[2];
        if target.starts_with(['#', '/']) || target.contains(':') {
            return c[0].to_string();
        }
        format!("{}{resources}/{}", &c[1], target.trim_start_matches("./"))
    });
    entry.files = Arc::new(BTreeMap::from([(
        PathBuf::from("SKILL.md"),
        rewritten.into_owned().into_bytes(),
    )]));
    write_bundle(dest, &entry)
}

/// Change only the top-level name; retain description, unknown metadata and body.
#[nolog]
fn rename_header(bytes: &[u8], name: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return bytes.to_vec();
    }
    let mut out = format!("---\nname: {name}\n");
    let mut header = true;
    for line in lines {
        if header && line.starts_with("name:") {
            continue;
        }
        if line.trim() == "---" {
            header = false;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.into_bytes()
}

#[nolog]
pub(super) fn discover(providers: &super::Providers, refresh: bool) -> Arc<Registry> {
    let current = providers.skills.load_full();
    if current.initialized && !refresh {
        return current;
    }
    let home = super::home();
    let installed = [
        super::locate_claude().is_some(),
        super::locate_codex().is_some(),
        super::locate_agy().is_some(),
        super::locate_muse().is_some(),
        crate::runtime::opencode::locate().is_some(),
    ];
    let codex = env_root("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let xdg = env_root("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let roots = [
        vec![
            env_root("CLAUDE_CONFIG_DIR")
                .unwrap_or_else(|| home.join(".claude"))
                .join("skills"),
        ],
        vec![home.join(".agents/skills"), codex.join("skills")],
        vec![
            home.join(".gemini/antigravity-cli/skills"),
            home.join(".gemini/config/skills"),
            home.join(".gemini/antigravity/skills"),
        ],
        vec![xdg.join("muse/skills"), home.join(".agents/skills")],
        vec![xdg.join("opencode/skills"), xdg.join("opencode/skill")],
    ];
    let sources = ["claude", "codex", "antigravity", "muse", "opencode"];
    let mut bundles = builtin();
    for (i, paths) in roots.iter().enumerate().filter(|(i, _)| installed[*i]) {
        for root in paths {
            scan(root, sources[i], 0, &mut bundles);
        }
    }
    if installed[4] {
        let config = env_root("OPENCODE_CONFIG_DIR").unwrap_or_else(|| xdg.join("opencode"));
        for dir in ["skills", "skill"] {
            scan(&config.join(dir), "opencode", 0, &mut bundles);
        }
        opencode_paths(&config, &home, &mut bundles);
    }
    if installed[0] {
        plugin_skills(&home, &[], &mut bundles);
    }
    let next = Arc::new(merge(bundles));
    providers.skills.store(next.clone());
    next
}

#[nolog]
fn env_root(name: &str) -> Option<PathBuf> {
    if crate::rig::active() {
        None
    } else {
        std::env::var_os(name)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    }
}

#[nolog]
fn opencode_paths(config: &Path, home: &Path, bundles: &mut Vec<Bundle>) {
    for name in ["opencode.json", "opencode.jsonc"] {
        let file = config.join(name);
        if !std::fs::metadata(&file).is_ok_and(|m| m.len() <= MAX_FILE) {
            continue;
        }
        let Some(doc) = std::fs::read_to_string(file)
            .ok()
            .and_then(|s| super::mcp::jsonc(&s).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        else {
            continue;
        };
        for value in doc["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let path = value
                .strip_prefix("~/")
                .map(|s| home.join(s))
                .unwrap_or_else(|| config.join(value));
            if crate::rig::active()
                && !std::fs::canonicalize(&path).is_ok_and(|p| p.starts_with(home))
            {
                continue;
            }
            scan(&path, "opencode", 0, bundles);
        }
    }
}

/// Per-agent sources never enter the global registry or another agent's scope.
#[nolog]
pub fn for_agent(global: &Registry, folders: &[PathBuf]) -> Registry {
    let mut bundles = global.bundles.clone();
    for folder in folders {
        if crate::rig::active()
            && !crate::rig::home_dir()
                .and_then(|h| std::fs::canonicalize(h).ok())
                .is_some_and(|h| std::fs::canonicalize(folder).is_ok_and(|p| p.starts_with(h)))
        {
            continue;
        }
        for (dir, source) in [
            (".claude/skills", "claude"),
            (".agents/skills", "workspace"),
            (".codex/skills", "codex"),
            (".agent/skills", "antigravity"),
            (".opencode/skills", "opencode"),
            (".opencode/skill", "opencode"),
        ] {
            scan(&folder.join(dir), source, 0, &mut bundles);
        }
    }
    if super::locate_claude().is_some() {
        plugin_skills(&super::home(), folders, &mut bundles);
    }
    merge(bundles)
}

#[nolog]
fn plugin_skills(home: &Path, folders: &[PathBuf], bundles: &mut Vec<Bundle>) {
    for plugin in super::plugins::installed(home, folders) {
        scan(&plugin.root.join("skills"), "claude-plugin", 0, bundles);
        let paths: Vec<&str> = match &plugin.manifest["skills"] {
            Value::String(s) => vec![s],
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for path in paths {
            if let Some(root) = super::plugins::within(&plugin.root, path) {
                scan(&root, "claude-plugin", 0, bundles);
            }
        }
    }
}

#[nolog]
fn sorted_entries(path: &Path) -> Vec<std::fs::DirEntry> {
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .take(MAX_FILES + 1)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    entries
}

#[nolog]
fn excluded(name: &str) -> bool {
    matches!(
        name,
        ".trash" | ".git" | ".in_use" | "node_modules" | ".orgtree-skill.json"
    )
}

#[nolog]
fn scan(root: &Path, source: &str, depth: usize, out: &mut Vec<Bundle>) {
    if depth > 10 || out.len() >= 512 || owned(root) {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(root) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    if root.join("SKILL.md").is_file() {
        if let Some(b) = read_bundle(root, source) {
            let total: usize = out
                .iter()
                .flat_map(|x| x.files.values())
                .map(Vec::len)
                .sum();
            let size: usize = b.files.values().map(Vec::len).sum();
            if total + size <= 64 * 1024 * 1024 {
                out.push(b);
            }
        }
        return;
    }
    for entry in sorted_entries(root) {
        if excluded(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if depth == 0 && source == "opencode" && entry.path().extension().is_some_and(|e| e == "md")
        {
            if let Some(b) = read_flat(&entry.path(), source) {
                let total: usize = out
                    .iter()
                    .flat_map(|x| x.files.values())
                    .map(Vec::len)
                    .sum();
                if total + b.files.values().map(Vec::len).sum::<usize>() <= 64 * 1024 * 1024 {
                    out.push(b);
                }
            }
        } else {
            scan(&entry.path(), source, depth + 1, out);
        }
    }
}

/// OpenCode 2.x also accepts top-level markdown skills. Preserve sibling
/// resources so relative references retain the same meaning after export.
#[nolog]
fn read_flat(file: &Path, source: &str) -> Option<Bundle> {
    let root = file.parent()?;
    let mut files = BTreeMap::new();
    let mut size = 0;
    for path in walk_files(root, root, 0, &mut 0).ok()? {
        let bytes = std::fs::read(&path).ok()?;
        size += bytes.len();
        if size > MAX_BUNDLE {
            return None;
        }
        let relative = if path == file {
            PathBuf::from("SKILL.md")
        } else {
            path.strip_prefix(root).ok()?.to_path_buf()
        };
        files.insert(relative, bytes);
    }
    bundle_from_files(files, source, &file.file_stem()?.to_string_lossy())
}

#[nolog]
fn walk_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    count: &mut usize,
) -> anyhow::Result<Vec<PathBuf>> {
    anyhow::ensure!(depth <= 12, "skill bundle is too deep");
    let mut out = Vec::new();
    for entry in sorted_entries(dir) {
        if excluded(&entry.file_name().to_string_lossy()) {
            continue;
        }
        *count += 1;
        anyhow::ensure!(*count <= MAX_FILES, "too many skill files");
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path)?;
        // Do not follow links outside a granted bundle, or copy them into exports.
        if meta.file_type().is_symlink() {
            anyhow::bail!("linked skill resource");
        }
        anyhow::ensure!(path.starts_with(root), "invalid skill resource path");
        if meta.is_dir() {
            out.extend(walk_files(root, &path, depth + 1, count)?);
        } else if meta.is_file() {
            anyhow::ensure!(meta.len() <= MAX_FILE, "skill resource too large");
            out.push(path);
        }
    }
    Ok(out)
}

#[nolog]
fn read_bundle(root: &Path, source: &str) -> Option<Bundle> {
    let mut files = BTreeMap::new();
    let mut size = 0;
    for file in walk_files(root, root, 0, &mut 0).ok()? {
        let bytes = std::fs::read(&file).ok()?;
        size += bytes.len();
        if size > MAX_BUNDLE {
            return None;
        }
        files.insert(file.strip_prefix(root).ok()?.to_path_buf(), bytes);
    }
    let mut bundle = bundle_from_files(
        files,
        source,
        &root.file_name().unwrap_or_default().to_string_lossy(),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for relative in bundle.files.keys() {
            if std::fs::metadata(root.join(relative))
                .ok()?
                .permissions()
                .mode()
                & 0o111
                != 0
            {
                bundle.executable.insert(relative.clone());
            }
        }
    }
    // Mode changes matter to scripts and therefore to snapshot identity too.
    if !bundle.executable.is_empty() {
        let mut sha = Sha256::new();
        sha.update(bundle.digest.as_bytes());
        for relative in &bundle.executable {
            sha.update(relative.to_string_lossy().as_bytes());
            sha.update([0]);
        }
        bundle.digest = hex::encode(sha.finalize());
    }
    Some(bundle)
}

#[nolog]
fn builtin() -> Vec<Bundle> {
    let mut groups: BTreeMap<String, BTreeMap<PathBuf, Vec<u8>>> = BTreeMap::new();
    for (path, bytes) in BUILTIN_SKILLS {
        if let Some((name, relative)) = path.split_once('/') {
            groups
                .entry(name.into())
                .or_default()
                .insert(PathBuf::from(relative), bytes.to_vec());
        }
    }
    groups
        .into_iter()
        .filter_map(|(name, files)| bundle_from_files(files, "orgtree", &name))
        .collect()
}

#[nolog]
fn bundle_from_files(
    files: BTreeMap<PathBuf, Vec<u8>>,
    source: &str,
    fallback: &str,
) -> Option<Bundle> {
    let text = std::str::from_utf8(files.get(Path::new("SKILL.md"))?).ok()?;
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let header: Vec<_> = lines.take_while(|l| l.trim() != "---").collect();
    if !header.iter().any(|l| l.starts_with("description:")) {
        return None;
    }
    let name = header
        .iter()
        .find_map(|l| l.strip_prefix("name:"))
        .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
        .unwrap_or_else(|| fallback.to_string());
    let name = portable_name(&name);
    if name.is_empty() {
        return None;
    }
    let mut sha = Sha256::new();
    for (path, bytes) in &files {
        sha.update(path.to_string_lossy().replace('\\', "/").as_bytes());
        sha.update([0]);
        sha.update((bytes.len() as u64).to_le_bytes());
        sha.update(bytes);
    }
    Some(Bundle {
        name,
        sources: vec![source.into()],
        files: Arc::new(files),
        digest: hex::encode(sha.finalize()),
        executable: BTreeSet::new(),
    })
}

#[nolog]
fn portable_name(name: &str) -> String {
    name.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(45)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

#[nolog]
fn merge(mut entries: Vec<Bundle>) -> Registry {
    // Built-in category names are reserved by the explicit user ruling.
    entries.sort_by_key(|b| !is_builtin(b));
    let mut bundles: Vec<Bundle> = Vec::new();
    for mut b in entries {
        if let Some(existing) = bundles.iter_mut().find(|x| x.digest == b.digest) {
            for source in b.sources {
                if !existing.sources.contains(&source) {
                    existing.sources.push(source);
                }
            }
            continue;
        }
        let original = b.name.clone();
        if bundles.iter().any(|x| x.name == b.name) {
            let suffix = portable_name(&b.sources[0]);
            let suffix: String = suffix.chars().take(18).collect();
            let stem: String = original.chars().take(30).collect();
            b.name = format!("{stem}-{suffix}");
            let mut n = 2;
            while bundles.iter().any(|x| x.name == b.name) {
                b.name = format!("{stem}-{suffix}-{n}");
                n += 1;
            }
        }
        bundles.push(b);
    }
    let mut sha = Sha256::new();
    sha.update(b"shared-skills-export-v2\0");
    for b in &bundles {
        sha.update(b.name.as_bytes());
        sha.update([0]);
        sha.update(b.digest.as_bytes());
    }
    Registry {
        initialized: true,
        digest: hex::encode(sha.finalize()),
        bundles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str, body: &str, resource: &str, source: &str) -> Bundle {
        bundle_from_files(BTreeMap::from([
            (PathBuf::from("SKILL.md"), format!("---\nname: {name}\ndescription: 'Use this fixture'\n---\n{body}\nSee references/data.txt\n").into_bytes()),
            (PathBuf::from("references/data.txt"), resource.as_bytes().to_vec()),
        ]), source, name).unwrap()
    }

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("orgtree-skills-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            fn clear(p: &Path) {
                for e in sorted_entries(p) {
                    let p = e.path();
                    let meta = std::fs::symlink_metadata(&p).unwrap();
                    #[cfg(windows)]
                    let linked = {
                        use std::os::windows::fs::MetadataExt;
                        meta.file_attributes() & 0x400 != 0
                    };
                    #[cfg(not(windows))]
                    let linked = meta.file_type().is_symlink();
                    if linked { continue; }
                    if meta.is_dir() {
                        clear(&p);
                    }
                    #[cfg(windows)]
                    if p.is_file() {
                        let mut permissions = std::fs::metadata(&p).unwrap().permissions();
                        permissions.set_readonly(false);
                        std::fs::set_permissions(&p, permissions).unwrap();
                    }
                }
            }
            clear(&self.0);
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[cfg(any(unix, windows))]
    pub(super) fn directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let link = crate::config::strip_verbatim(link).to_string_lossy().replace('/', "\\");
            let target = crate::config::strip_verbatim(target).to_string_lossy().replace('/', "\\");
            let result = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link).arg(&target).output().unwrap();
            assert!(result.status.success(), "fixture junction creation failed: status={:?}, stdout={}, stderr={}",
                result.status.code(), String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_import_rejects_linked_resource_ancestors_and_cached_exports() {
        let tmp = Temp::new();
        let outside = tmp.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("canary"), "untouched").unwrap();
        let registry = merge(vec![fixture("builtin", "entry", "asset", "orgtree")]);
        let scratch = tmp.0.join("scratch");
        let resources = scratch.join(".agents/orgtree-skill-resources");
        std::fs::create_dir_all(&resources).unwrap();
        let link = resources.join(&registry.digest);
        directory_link(&outside, &link);
        assert!(registry.workspace(&scratch).is_err());
        assert!(!outside.join("builtin").exists(), "must not write through digest ancestor");
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();

        registry.workspace(&scratch).unwrap();
        let bundle = resources.join(&registry.digest).join("builtin");
        std::fs::rename(bundle.join("references"), bundle.join("saved-references")).unwrap();
        let link = bundle.join("references");
        directory_link(&outside, &link);
        assert!(registry.workspace(&scratch).is_err(), "cached marker cannot authorize linked resources");
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        assert_eq!(std::fs::read_to_string(outside.join("canary")).unwrap(), "untouched");
        assert!(!outside.join("data.txt").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_import_rejects_linked_snapshot_cache() {
        let tmp = Temp::new();
        let registry = merge(vec![fixture("one", "entry", "asset", "claude")]);
        let data = tmp.0.join("data");
        let root = registry.materialize(&data).unwrap();
        let outside = tmp.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = root.join("skills/one/references");
        std::fs::rename(&link, root.join("skills/one/saved-references")).unwrap();
        directory_link(&outside, &link);
        assert!(registry.materialize(&data).is_err(), "complete marker cannot authorize linked cache");
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
    }

    #[test]
    fn skills_import_builtin_categories_keep_names_and_hide_nested_pages_from_catalogs() {
        let tmp = Temp::new();
        let mut builtin = fixture(
            "orgtree-working",
            "[section](runtime/SKILL.md) [web](https://example.invalid)",
            "asset",
            "orgtree",
        );
        Arc::make_mut(&mut builtin.files).insert(
            PathBuf::from("runtime/SKILL.md"),
            b"# Runtime\n[leaf](tools/orgtree_status/SKILL.md)\n[back](../SKILL.md)\n".to_vec(),
        );
        Arc::make_mut(&mut builtin.files).insert(
            PathBuf::from("runtime/tools/orgtree_status/SKILL.md"),
            b"# Status\nTool details unchanged\n".to_vec(),
        );
        let user = fixture("orgtree-working", "user", "asset", "claude");
        let registry = merge(vec![user, builtin]);
        assert_eq!(
            registry.names(),
            ["orgtree-working", "orgtree-working-claude"]
        );
        let root = registry.materialize(&tmp.0.join("data")).unwrap();
        for tree in ["skills", ".claude/skills"] {
            let entry = root.join(tree).join("orgtree-working");
            assert!(!entry.join("runtime/SKILL.md").exists());
            let text = std::fs::read_to_string(entry.join("SKILL.md")).unwrap();
            assert!(text.contains("resources/orgtree-working/runtime/SKILL.md"));
            assert!(text.contains("https://example.invalid"));
        }
        let resource =
            root.join("resources/orgtree-working/runtime/tools/orgtree_status/SKILL.md");
        assert_eq!(
            std::fs::read(&resource).unwrap(),
            b"# Status\nTool details unchanged\n"
        );
        registry.workspace(&tmp.0.join("scratch")).unwrap();
        assert!(
            !tmp.0
                .join("scratch/.agents/skills/orgtree-working/runtime")
                .exists()
        );
        assert!(
            tmp.0
                .join("scratch/.agents/orgtree-skill-resources")
                .join(&registry.digest)
                .join("orgtree-working/runtime/SKILL.md")
                .is_file()
        );
    }

    #[test]
    fn skills_import_dedupes_entire_bundles_and_keeps_resource_collisions() {
        let a = fixture("shared", "text", "one", "claude");
        let mut identical = a.clone();
        identical.sources = vec!["codex".into()];
        let b = fixture("shared", "text", "two", "codex");
        let r = merge(vec![a, identical, b]);
        assert_eq!(r.names(), ["shared", "shared-codex"]);
        assert_eq!(r.bundles[0].sources, ["claude", "codex"]);
        let public = r.public().to_string();
        assert!(!public.contains("references") && !public.contains("Use this fixture"));
    }

    #[test]
    fn skills_import_snapshot_paths_and_bytes_stay_identical_until_content_changes() {
        let tmp = Temp::new();
        let r = merge(vec![fixture("one", "instructions", "asset", "claude")]);
        let root = r.materialize(&tmp.0).unwrap();
        let file = root.join("skills/one/SKILL.md");
        let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
        let bytes = std::fs::read(&file).unwrap();
        let again = merge(vec![fixture("one", "instructions", "asset", "claude")]);
        assert_eq!(r.digest, again.digest);
        assert_eq!(root, again.materialize(&tmp.0).unwrap());
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), stamp);
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        assert_eq!(
            std::fs::read(root.join(".claude/skills/one/references/data.txt")).unwrap(),
            b"asset"
        );
        let changed = merge(vec![fixture("one", "changed", "asset", "claude")]);
        assert_ne!(changed.digest, r.digest);
        changed.materialize(&tmp.0).unwrap();
        assert_eq!(
            std::fs::read(&file).unwrap(),
            bytes,
            "old running snapshot remains unchanged"
        );
    }

    #[test]
    fn skills_import_native_workspace_preserves_user_files_and_changes_only_at_boundary() {
        let tmp = Temp::new();
        let root = tmp.0.join(".agents/skills");
        std::fs::create_dir_all(root.join("user-skill")).unwrap();
        std::fs::write(root.join("user-skill/canary"), "untouched").unwrap();
        let r = merge(vec![fixture("one", "old", "asset", "claude")]);
        r.workspace(&tmp.0).unwrap();
        let file = root.join("orgtree-one/SKILL.md");
        let old = std::fs::read(&file).unwrap();
        let changed = merge(vec![fixture("one", "new", "asset", "claude")]);
        assert_eq!(std::fs::read(&file).unwrap(), old);
        changed.workspace(&tmp.0).unwrap();
        assert_ne!(std::fs::read(&file).unwrap(), old);
        assert_eq!(
            std::fs::read_to_string(root.join("user-skill/canary")).unwrap(),
            "untouched"
        );
        let mut discovered = Vec::new();
        scan(&root, "workspace", 0, &mut discovered);
        assert!(
            discovered.is_empty(),
            "generated copies are not re-imported"
        );
        merge(Vec::new()).workspace(&tmp.0).unwrap();
        assert!(!file.exists());
        assert!(root.join("user-skill/canary").is_file());
        std::fs::create_dir_all(root.join("orgtree-one")).unwrap();
        assert!(
            r.workspace(&tmp.0).is_err(),
            "never overwrite an unowned directory"
        );
    }

    #[test]
    fn skills_import_installed_plugin_reader_excludes_marketplace_and_expands_mcp_root() {
        let tmp = Temp::new();
        let plugin = tmp.0.join(".claude/plugins/cache/example/1");
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            br#"{"name":"example"}"#,
        )
        .unwrap();
        std::fs::write(plugin.join(".mcp.json"), br#"{"mcpServers":{"fixture":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/run.js"]}}}"#).unwrap();
        std::fs::write(tmp.0.join(".claude/plugins/installed_plugins.json"), serde_json::to_vec(&json!({"version":2,"plugins":{"example@test":[{"scope":"user","installPath":plugin}]}})).unwrap()).unwrap();
        let plugins = super::super::plugins::installed(&tmp.0, &[]);
        assert_eq!(plugins.len(), 1);
        let defs = super::super::plugins::mcp(&plugins[0]);
        assert_eq!(defs.len(), 1);
        assert!(defs[0].1["args"][0].as_str().unwrap().ends_with("/run.js"));
        assert!(!defs[0].1.to_string().contains("CLAUDE_PLUGIN_ROOT"));
    }

    #[test]
    fn skills_import_refresh_scan_skips_trash_and_reads_nested_and_flat_native_formats() {
        let tmp = Temp::new();
        let root = &tmp.0;
        let skill = fixture("nested", "body", "data", "codex");
        // Write a source fixture without the generated ownership marker.
        for (relative, bytes) in skill.files.iter() {
            let path = root.join(".system/nested").join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        std::fs::create_dir_all(root.join(".trash/deleted")).unwrap();
        std::fs::write(
            root.join(".trash/deleted/SKILL.md"),
            &skill.files[Path::new("SKILL.md")],
        )
        .unwrap();
        let mut before = Vec::new();
        scan(root, "codex", 0, &mut before);
        assert_eq!(merge(before).names(), ["nested"]);
        std::fs::write(
            root.join("flat.md"),
            "---\nname: flat\ndescription: Flat skill\n---\nFlat body\n",
        )
        .unwrap();
        let mut after = Vec::new();
        scan(root, "opencode", 0, &mut after);
        let r = merge(after);
        assert!(r.names().contains(&"flat".into()) && r.names().contains(&"nested".into()));
    }
}
