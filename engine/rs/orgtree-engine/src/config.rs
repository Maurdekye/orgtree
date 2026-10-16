//! Process configuration, read once from the environment the launcher (the
//! desktop's engine.ts, or `host` mode) hands us. Standalone mode
//! (`orgtree-engine standalone`, docs/rust-engine/STANDALONE-ENGINE.md) reads
//! the same environment plus its own variables, which every other mode
//! ignores.

use std::io::Write;
use std::net::IpAddr;
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
    /// `orgtree-engine standalone`: no desktop, mandatory token (held in
    /// `desktop_token`, so the existing API guard applies unchanged).
    pub standalone: bool,
    /// The address the HTTP listener binds. Loopback in every mode except a
    /// standalone run that sets `ORGTREE_BIND`.
    pub bind: IpAddr,
    /// `ORGTREE_PORT` (standalone only): bind exactly this port.
    pub port: Option<u16>,
    /// This standalone run generated its token (first run): `main` prints it
    /// to stderr once. Never logged.
    pub standalone_generated_token: bool,
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
            .field("standalone", &self.standalone)
            .field("bind", &self.bind)
            .field("port", &self.port)
            .finish()
    }
}

#[logged]
impl Config {
    pub fn from_env(standalone: bool) -> Result<Self> {
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
        // Standalone always has a token (fail-closed); other modes keep the
        // desktop's per-launch token, empty when a launcher set none.
        let (desktop_token, standalone_generated_token) = if standalone {
            let env_token = std::env::var("ORGTREE_STANDALONE_TOKEN").ok().filter(|s| !s.is_empty());
            resolve_standalone_token(&data_root, env_token.as_deref())?
        } else {
            let tok = std::env::var("ORGTREE_V2_TOKEN").unwrap_or_default();
            if !tok.is_empty() && (tok.len() < 32 || !tok.chars().all(|c| c.is_ascii_hexdigit())) {
                bail!("ORGTREE_V2_TOKEN is malformed");
            }
            (tok, false)
        };
        let bind = if standalone {
            parse_bind(std::env::var("ORGTREE_BIND").ok().as_deref())?
        } else {
            IpAddr::from([127, 0, 0, 1])
        };
        let port = if standalone {
            parse_port(std::env::var("ORGTREE_PORT").ok().as_deref())?
        } else {
            None
        };
        let ui_dir = std::env::var("ORGTREE_V2_UI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
        // A standalone engine outlives whatever started it: no parent watcher.
        let parent_pid = if standalone {
            None
        } else {
            std::env::var("ORGTREE_V2_PARENT_PID").ok().and_then(|s| s.parse().ok())
        };
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
                p.join(crate::util::exe_name("postgres")).is_file().then_some(p)
            });
        // A fresh standalone data root (a new Docker volume) gets its cluster.
        let pg_bootstrap = standalone || std::env::var("ORGTREE_PG_BOOTSTRAP").map(|v| v == "1").unwrap_or(false);
        Ok(Config { data_root, data_root_id, desktop_token, ui_dir, parent_pid, pg_bin, exe_dir, pg_bootstrap,
                    standalone, bind, port, standalone_generated_token })
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

    /// The org's shared notes folder, holding the one AGENTS.md every agent of
    /// the org reads and edits without a stored grant (user 2026-10-13 18:10Z).
    /// A leading `_` is never an agent's name (`ops::valid_name`), so no
    /// agent's folder can be it; org.md and the workspace stay out of reach.
    pub fn org_notes_dir(&self, org_slug: &str) -> PathBuf {
        self.scratch_root(org_slug).join(ORG_NOTES_DIR)
    }

    /// The org's team workspaces, one folder per subtree named by its root
    /// agent's id (`domain::teams`). Like `_shared`, a leading `_` is never an
    /// agent's name.
    pub fn teams_dir(&self, org_slug: &str) -> PathBuf {
        self.scratch_root(org_slug).join(TEAMS_DIR)
    }
}

/// the org's shared notes folder, under its scratch root (`org_notes_dir`)
pub const ORG_NOTES_DIR: &str = "_shared";
/// the org's team workspaces, under its scratch root (`teams_dir`)
pub const TEAMS_DIR: &str = "_teams";
/// the one file delivered from that folder
pub const ORG_NOTES_FILE: &str = "AGENTS.md";

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

/// The standalone token file in the data root (one token, one line).
pub const STANDALONE_TOKEN_FILE: &str = "standalone-token";

/// A standalone token must be sendable as a header value and long enough to
/// not be guessable: at least 32 visible-ASCII characters, no whitespace.
#[nolog]
fn valid_standalone_token(token: &str) -> bool {
    token.len() >= 32 && token.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// The standalone token: `ORGTREE_STANDALONE_TOKEN` when given, else the
/// token file in the data root, generated on first use. Returns the token
/// and whether this call generated it. The value is never logged.
#[nolog]
pub fn resolve_standalone_token(data_root: &Path, env_token: Option<&str>) -> Result<(String, bool)> {
    if let Some(token) = env_token {
        if !valid_standalone_token(token) {
            bail!("ORGTREE_STANDALONE_TOKEN is malformed: use at least 32 characters, no spaces");
        }
        return Ok((token.to_string(), false));
    }
    let file = data_root.join(STANDALONE_TOKEN_FILE);
    if let Ok(text) = std::fs::read_to_string(&file) {
        let token = text.trim().to_string();
        if !valid_standalone_token(&token) {
            bail!("{} does not hold a valid token (at least 32 characters, no spaces)", file.display());
        }
        return Ok((token, false));
    }
    let token = crate::util::random_hex(32);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(&file) {
        Ok(mut f) => {
            f.write_all(token.as_bytes())?;
            f.write_all(b"\n")?;
            f.flush()?;
            Ok((token, true))
        }
        // Another first run won the race: read its token instead.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("could not read {}", file.display()))?;
            let token = text.trim().to_string();
            if !valid_standalone_token(&token) {
                bail!("{} does not hold a valid token (at least 32 characters, no spaces)", file.display());
            }
            Ok((token, false))
        }
        Err(e) => Err(e).with_context(|| format!("could not create {}", file.display())),
    }
}

/// `ORGTREE_BIND`: an IP address to listen on; loopback when unset.
#[logged]
pub fn parse_bind(value: Option<&str>) -> Result<IpAddr> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(IpAddr::from([127, 0, 0, 1])),
        Some(s) => s.parse::<IpAddr>().with_context(|| format!("ORGTREE_BIND {s:?} is not an IP address")),
    }
}

/// `ORGTREE_PORT`: the port to bind exactly; unset keeps the persisted port.
#[logged]
pub fn parse_port(value: Option<&str>) -> Result<Option<u16>> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => match s.parse::<u16>() {
            Ok(0) => bail!("ORGTREE_PORT must not be 0"),
            Ok(p) => Ok(Some(p)),
            Err(_) => bail!("ORGTREE_PORT {s:?} is not a port number"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orgtree-config-test-{}", crate::util::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_token_wins_and_is_validated() {
        let dir = scratch();
        let good = "a".repeat(32);
        let (token, generated) = resolve_standalone_token(&dir, Some(&good)).unwrap();
        assert_eq!(token, good);
        assert!(!generated);
        assert!(resolve_standalone_token(&dir, Some("short")).is_err());
        assert!(resolve_standalone_token(&dir, Some(&"a ".repeat(20))).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn token_file_is_generated_once_then_reused() {
        let dir = scratch();
        let (first, generated) = resolve_standalone_token(&dir, None).unwrap();
        assert!(generated);
        assert_eq!(first.len(), 64);
        let (second, generated) = resolve_standalone_token(&dir, None).unwrap();
        assert!(!generated);
        assert_eq!(first, second);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_token_file_is_refused_not_rotated() {
        let dir = scratch();
        std::fs::write(dir.join(STANDALONE_TOKEN_FILE), "too-short\n").unwrap();
        assert!(resolve_standalone_token(&dir, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bind_and_port_parse() {
        assert_eq!(parse_bind(None).unwrap(), IpAddr::from([127, 0, 0, 1]));
        assert_eq!(parse_bind(Some("0.0.0.0")).unwrap(), IpAddr::from([0, 0, 0, 0]));
        assert!(parse_bind(Some("localhost")).is_err());
        assert_eq!(parse_port(None).unwrap(), None);
        assert_eq!(parse_port(Some("7430")).unwrap(), Some(7430));
        assert!(parse_port(Some("0")).is_err());
        assert!(parse_port(Some("nope")).is_err());
    }
}
