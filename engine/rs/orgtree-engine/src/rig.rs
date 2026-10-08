//! Test-rig hooks: `tools/rig` runs this engine against a throwaway data
//! root (docs/rust-engine/test-rig.md). Debug builds only — a release build
//! compiles none of the hooks — and only when the rig asked for them on a rig
//! root: ORGTREE_ENGINE_SAFE_START=1, ORGTREE_ENGINE_RIG=1, the marker file
//! `.orgtree-rig-root` in the data root, and a root outside the live
//! `%APPDATA%\Orgtree v2` folder. Asked for anywhere else (or by a release
//! build), the engine refuses to start.
//!
//! In rig mode the engine never touches the user's real profile:
//! - every home-folder lookup (`~/.claude`, `~/.codex`, `~/.orgtree`, skills)
//!   resolves under `<root>\rig-home`;
//! - provider CLIs come only from ORGTREE_CLAUDE_BIN / ORGTREE_CODEX_BIN /
//!   ORGTREE_AGY_BIN (the rig's fake CLI), never from PATH or AppData;
//! - no usage probe runs (no network call, no provider CLI);
//! - `POST /api/rig/tool` calls any `orgtree_*` tool as a chosen live agent,
//!   through the same dispatcher the CLIs reach.

use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;

use crate::config::Config;

/// The file the rig writes into every data root it creates.
pub const MARKER: &str = ".orgtree-rig-root";

/// Some(fake home) in rig mode; decided once, at start.
static RIG: OnceLock<Option<PathBuf>> = OnceLock::new();

#[logged]
fn requested() -> bool {
    std::env::var("ORGTREE_ENGINE_RIG").as_deref() == Ok("1")
}

/// Decide rig mode once, before anything reads a home folder. Err: rig mode
/// was asked for where it may not run; the engine must not start.
#[cfg(debug_assertions)]
#[logged]
pub fn init(cfg: &Config) -> Result<()> {
    if !requested() {
        let _ = RIG.set(None);
        return Ok(());
    }
    if std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() != Ok("1") {
        anyhow::bail!("ORGTREE_ENGINE_RIG needs ORGTREE_ENGINE_SAFE_START=1");
    }
    if !cfg.data_root.join(MARKER).is_file() {
        anyhow::bail!("ORGTREE_ENGINE_RIG: {} has no {MARKER}; only tools/rig makes rig roots", cfg.data_root.display());
    }
    let root = cfg.data_root.to_string_lossy().to_lowercase();
    if let Some(live) = dirs::data_dir().map(|d| d.join("Orgtree v2")) {
        let live = crate::config::canonical(&live).unwrap_or(live).to_string_lossy().to_lowercase();
        if root == live || root.starts_with(&format!("{}\\", live.trim_end_matches('\\'))) {
            anyhow::bail!("ORGTREE_ENGINE_RIG: {} is inside the live Orgtree data folder", cfg.data_root.display());
        }
    }
    let home = cfg.data_root.join("rig-home");
    std::fs::create_dir_all(&home)?;
    let _ = RIG.set(Some(home));
    Ok(())
}

/// Say in the log that this engine runs in rig mode (`init` runs before the log opens).
#[logged]
pub fn announce() {
    if let Some(home) = RIG.get().cloned().flatten() {
        tracing::warn!(home = %home.display(), "rig mode: fake home, rig CLIs only, no usage probes, /api/rig/tool served");
    }
}

/// A release build has no rig mode: asking for it is a refusal to start.
#[cfg(not(debug_assertions))]
#[logged]
pub fn init(_cfg: &Config) -> Result<()> {
    if requested() {
        anyhow::bail!("ORGTREE_ENGINE_RIG: this release build has no rig mode");
    }
    let _ = RIG.set(None);
    Ok(())
}

#[nolog]
pub fn active() -> bool {
    RIG.get().map(Option::is_some).unwrap_or(false)
}

/// A rig run that asked for the restart path (`ORGTREE_RIG_RECOVER=1`):
/// what a safe start holds back (waking agents at start, re-arming every
/// watchdog, watchdog mail that wakes) runs there as it does for real; only
/// fake CLIs can run in rig mode.
#[nolog]
pub fn recovers() -> bool {
    active() && std::env::var("ORGTREE_RIG_RECOVER").as_deref() == Ok("1")
}

/// A rig run that asked for the automatic wakes (`ORGTREE_RIG_REMINDERS=1`):
/// the reminder sweep a safe start holds back (working checkups, idle docket
/// reminders, abandoned docket recovery) runs, every
/// `ORGTREE_RIG_REMINDER_SWEEP_S` seconds (1 to 60, else the product's 60)
/// so a proof need not wait a minute for each sweep. None outside rig mode.
#[logged]
pub fn reminder_sweep_s() -> Option<u64> {
    if !active() || std::env::var("ORGTREE_RIG_REMINDERS").as_deref() != Ok("1") {
        return None;
    }
    let every = std::env::var("ORGTREE_RIG_REMINDER_SWEEP_S").ok().and_then(|s| s.trim().parse::<u64>().ok());
    Some(every.filter(|n| (1..=60).contains(n)).unwrap_or(60))
}

/// A rig run's pause between an automatic wake's reservation and its mail
/// (`ORGTREE_RIG_REMINDER_PAUSE_MS`, up to 30 s), so a proof can put real
/// work in the window a lost idle race needs. None outside rig mode.
#[logged]
pub fn reminder_pause() -> Option<std::time::Duration> {
    if reminder_sweep_s().is_none() {
        return None;
    }
    let ms = std::env::var("ORGTREE_RIG_REMINDER_PAUSE_MS").ok().and_then(|s| s.trim().parse::<u64>().ok())?;
    Some(std::time::Duration::from_millis(ms.min(30_000)))
}

/// Every home-folder lookup: the rig's fake home in rig mode, else the
/// user's profile folder.
#[logged]
pub fn home_dir() -> Option<PathBuf> {
    match RIG.get().cloned().flatten() {
        Some(home) => Some(home),
        None => dirs::home_dir(),
    }
}

/// A provider CLI in rig mode: only the one the rig named, if it exists.
#[logged]
pub fn cli_bin(var: &str) -> Option<(PathBuf, String)> {
    let p = PathBuf::from(std::env::var(var).ok()?);
    p.is_file().then(|| (p, "rig".to_string()))
}

/// A usage reading in rig mode, instead of a probe: the rig's canned
/// `<root>\rig-home\rig-usage\<lane>@<folder>.json` for the login whose
/// folder (Claude config folder, Codex home) is named `<folder>`, else
/// `<lane>.json`, else "unavailable". None outside rig mode (probe as usual).
#[logged]
pub fn usage(lane: &str, profile: Option<&str>) -> Option<serde_json::Value> {
    let home = RIG.get().cloned().flatten()?;
    let dir = home.join("rig-usage");
    let named = profile
        .and_then(|p| std::path::Path::new(p).file_name().map(|n| dir.join(format!("{lane}@{}.json", n.to_string_lossy()))));
    let canned = named
        .into_iter()
        .chain(std::iter::once(dir.join(format!("{lane}.json"))))
        .find_map(|p| std::fs::read(p).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()));
    Some(canned.unwrap_or_else(|| serde_json::json!({ "available": false, "error": "rig mode: no usage probe" })))
}

/// The OpenRouter key check in rig mode: what
/// `<root>\rig-home\rig-usage\openrouter-key.json` says — `{"status": 200,
/// "data": {...}}` (the key is accepted) or `{"status": 401}` (refused) — and
/// no network when there is no such file. None outside rig mode (the real check).
#[logged]
pub fn openrouter_key() -> Option<std::result::Result<serde_json::Map<String, serde_json::Value>, (bool, String)>> {
    let home = RIG.get().cloned().flatten()?;
    let canned = std::fs::read(home.join("rig-usage").join("openrouter-key.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    Some(match canned {
        None => Err((false, "rig mode: no network".into())),
        Some(v) => match v["status"].as_u64() {
            Some(200) => v["data"].as_object().cloned().ok_or_else(|| (false, "rig mode: the canned key check has no data".into())),
            Some(401 | 403) => Err((true, crate::openrouter::KEY_REFUSED.into())),
            other => Err((false, format!("openrouter.ai answered {} for the key check", other.unwrap_or(0)))),
        },
    })
}

#[cfg(debug_assertions)]
pub use routes::tool;

#[cfg(debug_assertions)]
mod routes {
    use std::sync::Arc;

    use axum::extract::State;
    use axum::Json;
    use serde::Deserialize;
    use serde_json::{json, Value};

    use crate::engine::Engine;
    use crate::http::error::{ApiError, ApiResult};
    use crate::runtime::Caller;

    #[derive(Deserialize, Debug)]
    pub struct ToolCall {
        org: String,
        agent: String,
        tool: String,
        #[serde(default)]
        args: Value,
        /// stands in for the CLI's tool-use id (`orgtree_send_file` keys its delivery on it)
        tool_use_id: Option<String>,
    }

    /// One `orgtree_*` tool call as a live agent, exactly as its CLI's
    /// `mcp_message` would make it: `{ok, text, json}` (`json` when the
    /// answer parses). Served only in rig mode.
    #[logged]
    pub async fn tool(State(e): State<Arc<Engine>>, Json(b): Json<ToolCall>) -> ApiResult<Json<Value>> {
        if !super::active() {
            return Err(ApiError::not_found("no route: rig mode is off"));
        }
        let o = crate::http::orgs::org(&e, &b.org)?;
        let client = e.db.get().await?;
        let row = client
            .query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&o.id, &b.agent])
            .await?
            .ok_or_else(|| ApiError::not_found(format!("no live agent named {} in {}", b.agent, o.slug)))?;
        drop(client);
        let caller = Caller { org_id: o.id, org_slug: o.slug.clone(), agent_id: row.get(0), name: row.get(1) };
        let span = crate::trace::request_from(&crate::trace::agent_client(caller.agent_id, &caller.name), crate::trace::current_rq().as_deref());
        let args = if b.args.is_null() { json!({}) } else { b.args.clone() };
        let (ok, text) = tracing::Instrument::instrument(
            crate::tools::call_tool(&e, &caller, &b.tool, &args, b.tool_use_id.as_deref()),
            span,
        )
        .await;
        let parsed = serde_json::from_str::<Value>(&text).ok();
        Ok(Json(json!({ "ok": ok, "text": text, "json": parsed })))
    }
}
