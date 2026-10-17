//! Private Codex state for this data root, one home per source login.
//! Source profiles are read only; credentials never pass through logs.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// Native and imported logins keep separate state without putting paths in
/// directory names. Windows spelling differences identify the same login.
#[logged]
pub fn path(data_root: &Path, source: Option<&str>) -> PathBuf {
    let source = source
        .map(PathBuf::from)
        .unwrap_or_else(super::codex::default_home);
    let key = crate::config::strip_verbatim(&source)
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let key = key.replace('/', "\\").to_lowercase();
    data_root
        .join("codex-home")
        .join(hex::encode(Sha256::digest(key.as_bytes())))
}

/// Bootstrap independent settings and a copy of the selected sign-in. Keep
/// Codex's refreshed private auth while the source is unchanged; an explicit
/// new sign-in in the source is adopted on the next launch/probe.
#[logged]
pub fn prepare(data_root: &Path, source: Option<&str>) -> Result<PathBuf> {
    let home = path(data_root, source);
    let root = data_root.join("codex-home");
    std::fs::create_dir_all(&root)?;
    if crate::config::canonical(&root)? != crate::config::canonical(data_root)?.join("codex-home") {
        bail!("the private Codex state folder must not redirect outside its data root");
    }
    std::fs::create_dir_all(&home)?;
    if crate::config::canonical(&home)?
        != crate::config::canonical(&root)?.join(home.file_name().unwrap())
    {
        bail!("the private Codex home must not be a link to another profile");
    }
    let source = source
        .map(PathBuf::from)
        .unwrap_or_else(super::codex::default_home);
    for name in ["config.toml", "AGENTS.md", "AGENTS.override.md"] {
        copy_file(&source.join(name), &home.join(name), false)?;
    }
    let auth = source.join("auth.json");
    let marker = home.join("auth-source.sha256");
    let auth_exists = regular_file(&home.join("auth.json"))?;
    regular_file(&marker)?;
    match std::fs::read(&auth) {
        Ok(bytes) => {
            let digest = hex::encode(Sha256::digest(&bytes));
            let previous = std::fs::read_to_string(&marker).unwrap_or_default();
            if previous != digest || !auth_exists {
                copy_file(&auth, &home.join("auth.json"), true)?;
                let temp = marker.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                let result =
                    std::fs::write(&temp, digest).and_then(|_| std::fs::rename(&temp, &marker));
                let _ = std::fs::remove_file(&temp);
                result.context("publish the Codex source-login marker")?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("read the selected Codex sign-in cache"),
    }
    Ok(home)
}

/// Publish a complete private copy, never a link to the source. A temporary
/// sibling keeps simultaneous account launches from exposing partial JSON.
#[logged]
fn copy_file(from: &Path, to: &Path, replace: bool) -> Result<()> {
    if regular_file(to)? && !replace {
        return Ok(());
    }
    if !from.is_file() {
        return Ok(());
    }
    let temp = to.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        std::fs::copy(from, &temp).context("copy a Codex profile file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
        }
        if !replace && to.exists() {
            return Ok(());
        }
        std::fs::rename(&temp, to).context("publish a private Codex profile file")?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temp);
    result
}

#[logged]
fn regular_file(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => bail!(
            "private Codex profile files must be regular files: {}",
            path.display()
        ),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => return Err(e).context("inspect the private Codex profile"),
    }
}

/// Command-line overrides win over copied config and profile settings.
/// Even an inherited SQLite/log path must not share the desktop's state.
#[logged]
pub fn overrides(home: &Path) -> Vec<String> {
    let log = serde_json::to_string(&home.join("log").to_string_lossy()).unwrap();
    let home = serde_json::to_string(&home.to_string_lossy()).unwrap();
    vec![
        "-c".into(),
        format!("sqlite_home={home}"),
        "-c".into(),
        format!("log_dir={log}"),
        "-c".into(),
        "cli_auth_credentials_store=\"file\"".into(),
    ]
}
