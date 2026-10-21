//! Optional template AGENTS.md snapshots. Never log their contents.
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

pub const FILE_MAX: usize = 16_000;
pub const TOTAL_MAX: usize = 128_000;

#[derive(Clone)]
pub struct Text(pub String);

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "[standing notes: {} bytes]", self.0.len()) }
}

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        validate(&text).map_err(serde::de::Error::custom)?;
        Ok(Text(text))
    }
}

/// A guard against recognizable credentials, not proof arbitrary prose is public.
#[nolog]
pub fn validate(text: &str) -> Result<(), String> {
    if text.len() > FILE_MAX { return Err(format!("each standing note is limited to {FILE_MAX} UTF-8 bytes")); }
    if text.contains('\0') { return Err("standing notes cannot contain NUL".into()); }
    let secrets = regex::Regex::new(r#"(?im)-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b[ \t]*[:=][ \t]*["']?[A-Za-z0-9_+/=-]{8,}|\bAuthorization:[ \t]*Bearer[ \t]+\S+"#).unwrap();
    if secrets.is_match(text) { return Err("standing notes contain a recognizable credential; remove it before copying".into()); }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Location {
    pub name: String,
    pub id: i64,
    pub personal: PathBuf,
    pub project: bool,
}

#[derive(Debug)]
pub struct Pending {
    pub path: PathBuf,
    pub text: Text,
}

#[nolog]
fn checked(root: &Path, file: &Path) -> Result<(), String> {
    if !file.starts_with(root) || file.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("standing notes must stay inside this organization's scratch folder".into());
    }
    crate::http::settings::plain_path(file)
}

/// Read just the fixed AGENTS.md, bounded before decoding; never follow a link.
#[nolog]
pub fn capture(root: &Path, file: &Path) -> Result<Option<Text>, String> {
    checked(root, file)?;
    match fs::symlink_metadata(file) {
        Ok(md) if !md.is_file() => return Err("standing notes must be regular files".into()),
        Ok(md) if md.len() > FILE_MAX as u64 => return Err(format!("each standing note is limited to {FILE_MAX} UTF-8 bytes")),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("could not inspect a standing-notes file".into()),
    }
    let mut input = match fs::File::open(file) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("could not read a standing-notes file".into()),
    };
    if !input.metadata().map_err(|_| "could not inspect a standing-notes file")?.is_file() {
        return Err("standing notes must be regular files".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut input).take((FILE_MAX + 1) as u64).read_to_end(&mut bytes).map_err(|_| "could not read standing notes")?;
    let text = String::from_utf8(bytes).map_err(|_| "standing notes must be valid UTF-8")?;
    validate(&text)?;
    Ok(Some(Text(text)))
}

#[nolog]
pub fn pending(root: &Path, t: &super::templates::Template, planned: &[super::templates::Planned], locations: &[Location]) -> Vec<Pending> {
    let mut out = Vec::new();
    if let Some(text) = &t.shared_agents_md {
        out.push(Pending { path: root.join("_shared/AGENTS.md"), text: text.clone() });
    }
    for p in planned {
        let Some(location) = locations.iter().find(|l| l.name == p.name) else { continue };
        if let Some(text) = &p.slot.team_agents_md {
            out.push(Pending { path: root.join("_teams").join(location.id.to_string()).join("AGENTS.md"), text: text.clone() });
        }
        if let Some(text) = &p.slot.scratch_agents_md {
            out.push(Pending { path: location.personal.join("AGENTS.md"), text: text.clone() });
        }
    }
    out
}

/// Called after commit, before any template kickoff/warm effect. Never replace a file.
#[nolog]
pub fn seed(root: &Path, pending: &[Pending]) -> Value {
    let (mut created, mut kept) = (0, 0);
    let mut warnings = Vec::new();
    for note in pending {
        let result = (|| -> Result<bool, String> {
            checked(root, &note.path)?;
            validate(&note.text.0)?;
            fs::create_dir_all(note.path.parent().ok_or("standing notes need a parent folder")?).map_err(|_| "could not create standing-notes folder")?;
            let mut output = match OpenOptions::new().write(true).create_new(true).open(&note.path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
                Err(_) => return Err("could not create standing-notes file".into()),
            };
            if output.write_all(note.text.0.as_bytes()).is_err() {
                drop(output);
                let _ = fs::remove_file(&note.path);
                return Err("could not write standing-notes file".into());
            }
            Ok(true)
        })();
        match result { Ok(true) => created += 1, Ok(false) => kept += 1, Err(e) => warnings.push(e) }
    }
    json!({ "created": created, "existing": kept, "warnings": warnings })
}

/// The save option captures only this org's known shared/team/personal files.
#[nolog]
pub fn capture_layout(root: &Path, locations: &[Location], template: &mut Value) -> Result<(), String> {
    let mut total = 0;
    #[nolog]
    fn attach(root: &Path, file: &Path, object: &mut Value, key: &str, total: &mut usize) -> Result<(), String> {
        if let Some(text) = capture(root, file)? {
            *total += text.0.len();
            if *total > TOTAL_MAX { return Err(format!("standing notes exceed {TOTAL_MAX} bytes in total")); }
            object[key] = json!(text.0);
        }
        Ok(())
    }
    attach(root, &root.join("_shared/AGENTS.md"), template, "shared_agents_md", &mut total)?;
    #[nolog]
    fn walk(root: &Path, slots: &mut [Value], locations: &[Location], total: &mut usize) -> Result<(), String> {
        for slot in slots {
            let location = locations.iter().find(|l| slot["name"].as_str() == Some(&l.name)).ok_or("standing-notes slot was not found")?;
            attach(root, &root.join("_teams").join(location.id.to_string()).join("AGENTS.md"), slot, "team_agents_md", total)?;
            if !location.project { attach(root, &location.personal.join("AGENTS.md"), slot, "scratch_agents_md", total)?; }
            if let Some(reports) = slot["reports"].as_array_mut() { walk(root, reports, locations, total)?; }
        }
        Ok(())
    }
    if let Some(slots) = template["agents"].as_array_mut() { walk(root, slots, locations, &mut total)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_are_bounded_and_do_not_print_or_copy_recognizable_secrets() {
        assert!(validate("# Practices\nUse private worktrees.\n").is_ok());
        for bad in ["sk-0123456789abcdefghijklmnop", "password=abcdefghijkl", "-----BEGIN PRIVATE KEY-----", "Authorization: Bearer abcdefghi"] {
            assert!(validate(bad).is_err());
            assert!(!format!("{:?}", Text(bad.into())).contains(bad));
        }
        assert!(validate(&"x".repeat(FILE_MAX + 1)).is_err());
        assert!(serde_json::from_value::<Text>(json!("a\0b")).is_err());
    }
    #[test]
    fn seeding_never_overwrites_and_capture_rejects_escape_and_invalid_utf8() {
        let root = std::env::temp_dir().join(format!("template-notes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("_shared/AGENTS.md");
        let pending = vec![Pending { path: file.clone(), text: Text("# Generic practices\n".into()) }];
        assert_eq!(seed(&root, &pending)["created"], 1);
        fs::write(&file, "# Existing\n").unwrap();
        assert_eq!(seed(&root, &pending)["existing"], 1);
        assert_eq!(capture(&root, &file).unwrap().unwrap().0, "# Existing\n");
        assert!(capture(&root, &root.join("../other/AGENTS.md")).is_err());
        fs::write(&file, [0xff]).unwrap();
        assert!(capture(&root, &file).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
