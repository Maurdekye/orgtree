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
}
