//! Process configuration, read once from the environment the launcher (the
//! desktop's engine.ts, or `host` mode) hands us.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

#[derive(Clone)]
pub struct Config {
    /// The data root (`%APPDATA%\Orgtree v2\data`), canonical absolute path.
    pub data_root: PathBuf,
    /// Exactly the string the launcher expects back as `dataRootId`.
    pub data_root_id: String,
    /// The per-launch desktop credential (`X-Orgtree-Desktop-Token`).
    pub desktop_token: String,
    /// Renderer bundle served at `/`.
    pub ui_dir: Option<PathBuf>,
    /// Parent process to outlive no longer than (desktop or boot host).
    pub parent_pid: Option<u32>,
    /// `postgresql\bin` holding postgres.exe / initdb.exe.
    pub pg_bin: Option<PathBuf>,
    /// The directory holding this executable (packaged: `resources\engine`).
    pub exe_dir: PathBuf,
    /// Whether a fresh data root may get a brand-new cluster.
    pub pg_bootstrap: bool,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("data_root", &self.data_root)
            .field("desktop_token", &if self.desktop_token.is_empty() { "" } else { "*****" })
            .field("ui_dir", &self.ui_dir)
            .field("parent_pid", &self.parent_pid)
            .field("pg_bin", &self.pg_bin)
            .field("exe_dir", &self.exe_dir)
            .field("pg_bootstrap", &self.pg_bootstrap)
            .finish()
    }
}

#[logged]
impl Config {
    pub fn from_env() -> Result<Self> {
        let data = std::env::var("ORGTREE_DATA")
            .context("ORGTREE_DATA is not set: the engine needs its data root")?;
        let data_root = PathBuf::from(&data);
        if !data_root.is_absolute() {
            bail!("ORGTREE_DATA must be an absolute path");
        }
        std::fs::create_dir_all(&data_root)
            .with_context(|| format!("could not create the data root {}", data_root.display()))?;
        let data_root = canonical(&data_root)?;
        let data_root_id = data_root.to_string_lossy().to_string();
        let desktop_token = std::env::var("ORGTREE_V2_TOKEN").unwrap_or_default();
        if !desktop_token.is_empty()
            && (desktop_token.len() < 32 || !desktop_token.chars().all(|c| c.is_ascii_hexdigit()))
        {
            bail!("ORGTREE_V2_TOKEN is malformed");
        }
        let ui_dir = std::env::var("ORGTREE_V2_UI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
        let parent_pid = std::env::var("ORGTREE_V2_PARENT_PID").ok().and_then(|s| s.parse().ok());
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        let pg_bin = std::env::var("ORGTREE_P03_PG_BIN")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                let p = exe_dir.join("postgresql").join("bin");
                p.join("postgres.exe").is_file().then_some(p)
            });
        let pg_bootstrap = std::env::var("ORGTREE_PG_BOOTSTRAP").map(|v| v == "1").unwrap_or(false);
        Ok(Config { data_root, data_root_id, desktop_token, ui_dir, parent_pid, pg_bin, exe_dir, pg_bootstrap })
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.data_root.join(rel)
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.data_root.join("diagnostics")
    }

    pub fn scratch_root(&self, org_slug: &str) -> PathBuf {
        self.data_root.join("scratch").join(org_slug)
    }

    pub fn workspace_dir(&self, org_slug: &str) -> PathBuf {
        self.data_root.join("workspaces").join(org_slug)
    }
}

/// Canonical path WITHOUT the `\\?\` verbatim prefix Windows' canonicalize adds:
/// the desktop compares `dataRootId` with `path.resolve(...)` output.
#[logged]
pub fn canonical(p: &Path) -> Result<PathBuf> {
    let c = std::fs::canonicalize(p).with_context(|| format!("could not resolve {}", p.display()))?;
    Ok(strip_verbatim(&c))
}

#[logged]
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}
