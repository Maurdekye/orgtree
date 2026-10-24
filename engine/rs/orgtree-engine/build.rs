use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().expect("built-in skill file type");
        assert!(!kind.is_symlink(), "built-in skills cannot contain links");
        if kind.is_dir() {
            files(&path, out);
        } else if kind.is_file() {
            out.push(path);
        }
    }
}

fn main() {
    let root =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../../docs/skills");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut found = Vec::new();
    files(&root, &mut found);
    let mut source = String::from("pub const BUILTIN_SKILLS: &[(&str, &[u8])] = &[\n");
    for path in found {
        let rel = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        source.push_str(&format!(
            "({rel:?}, include_bytes!({:?})),\n",
            path.to_string_lossy()
        ));
    }
    source.push_str("];\n");
    std::fs::write(
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("builtin_skills.rs"),
        source,
    )
    .unwrap();

    let repo = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    std::fs::write(
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("release_notes.rs"),
        release_notes(&repo.join("docs")),
    )
    .unwrap();
    println!("cargo:rerun-if-env-changed=ORGTREE_BUILD_COMMIT");
    if let Some(time) = build_commit_time(&repo) {
        println!("cargo:rustc-env=ORGTREE_BUILD_COMMIT_TIME={time}");
    }
}

/// The Changelog's notes (docket changelog-window-one-row-per-version-pinnable-po):
/// every `docs/release-notes-<x.y.z>.md`. Each is that GitHub release's own
/// description (release.yml publishes the file with `--notes-file`), so the
/// panel and the glossary carry what was published, offline. Pre-release drafts
/// (`-RC1`, `-beta.4`) stay out. Each file is watched, and so is
/// `docs/releases.json`; a notes file added since is bundled at the next
/// stamped build (`ORGTREE_BUILD_COMMIT` changes) or version bump.
fn release_notes(docs: &Path) -> String {
    println!("cargo:rerun-if-changed={}", docs.join("releases.json").display());
    let mut found: Vec<(Vec<u64>, String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(docs).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name
            .strip_prefix("release-notes-")
            .and_then(|n| n.strip_suffix(".md"))
        else {
            continue;
        };
        let parts: Option<Vec<u64>> = version.split('.').map(|p| p.parse().ok()).collect();
        let Some(parts) = parts.filter(|p| p.len() == 3) else {
            continue;
        };
        println!("cargo:rerun-if-changed={}", entry.path().display());
        found.push((parts, version.to_string(), entry.path()));
    }
    found.sort();
    let mut source = String::from("pub const RELEASE_NOTES: &[(&str, &[u8])] = &[\n");
    for (_, version, path) in found.iter().rev() {
        source.push_str(&format!(
            "({version:?}, include_bytes!({:?})),\n",
            path.to_string_lossy()
        ));
    }
    source.push_str("];\n");
    source
}

/// When the stamped build's commit (`ORGTREE_BUILD_COMMIT`, which packaged
/// builds set) was made: the release date & time of the engine's own row while
/// `docs/releases.json` does not list it, as for a local alpha. A build without
/// a stamp, or without git, has none.
fn build_commit_time(repo: &Path) -> Option<String> {
    let commit = std::env::var("ORGTREE_BUILD_COMMIT").ok()?;
    let commit = commit.trim();
    if commit.is_empty() || commit.starts_with('-') {
        return None;
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", "-s", "--format=%cI", commit])
        .output()
        .ok()?;
    let time = String::from_utf8(out.stdout).ok()?;
    let time = time.trim();
    (out.status.success() && !time.is_empty()).then(|| time.to_string())
}
