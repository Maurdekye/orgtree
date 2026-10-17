//! Managed org/team scratch initialization, shared by startup, launch and HTTP.

use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};

/// Anchor trusted data-root aliases, then check each managed component before
/// creating the next. Never follow a managed link/reparse point or overwrite
/// notes, including an empty file. Only engine-owned shared/team targets qualify.
#[logged]
pub fn ensure(data_root: &Path, org_root: &Path, target: &Path) -> Result<PathBuf> {
    let local = target.strip_prefix(org_root).context("folder escapes org scratch")?;
    let header = match local.components().collect::<Vec<_>>().as_slice() {
        [Component::Normal(dir)] if *dir == crate::config::ORG_NOTES_DIR =>
            "# Shared standing notes for this organization\n",
        [Component::Normal(dir), Component::Normal(id)]
            if *dir == "_teams" && id.to_str().and_then(|s| s.parse::<i64>().ok()).is_some_and(|id| id > 0) =>
            "# Shared standing notes for this team\n",
        _ => bail!("invalid managed scratch folder"),
    };
    let relative = target.strip_prefix(data_root).context("folder escapes data root")?;
    ensure!(relative.components().all(|c| matches!(c, Component::Normal(_))), "invalid managed scratch folder");
    let mut checked = std::fs::canonicalize(data_root).context("scratch data root is unavailable")?;
    for component in relative.components() {
        checked.push(component.as_os_str());
        match std::fs::symlink_metadata(&checked) {
            Ok(_) => {},
            Err(error) if error.kind() == ErrorKind::NotFound => {
                match std::fs::create_dir(&checked) {
                    Ok(_) => {},
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
                    Err(error) => return Err(error).context("could not create scratch folder"),
                }
            },
            Err(error) => return Err(error).context("could not inspect scratch folder"),
        }
        let meta = std::fs::symlink_metadata(&checked).context("scratch folder is unavailable")?;
        #[cfg(windows)]
        let linked = std::os::windows::fs::MetadataExt::file_attributes(&meta) & 0x400 != 0;
        #[cfg(not(windows))]
        let linked = meta.file_type().is_symlink();
        ensure!(!linked && meta.is_dir(), "managed scratch path contains a link or non-directory");
    }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(checked.join(crate::config::ORG_NOTES_FILE)) {
        Ok(mut file) => file.write_all(header.as_bytes()).context("could not initialize shared notes")?,
        // create_new also leaves existing leaf symlinks untouched, never following
        // them for a write. Existing user content is never read or serialized here.
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
        Err(error) => return Err(error).context("could not create shared notes"),
    }
    Ok(crate::config::strip_verbatim(&checked))
}
