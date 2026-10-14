//! The Antigravity account's model registry, as `agy models` prints it: the
//! evidence the conditional Gemini tiers (Argon, Barium, Carbon) are offered
//! on. 3.x read it on every connect probe (`providers._antigravity_account`);
//! the 4.x port kept the state field but never filled it, so no conditional
//! tier was ever offered (docket gemini-4-argon-is-selectable-in-agy-but-orgtree-d).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::engine::Engine;

/// The effort suffixes `agy models` prints on registry ids
/// (`gemini-3.1-pro-high`, measured agy 1.2.14; `claude-opus-5-5-low`, 1.3.1).
pub const EFFORT_SUFFIXES: [&str; 4] = ["-low", "-medium", "-high", "-max"];

/// How long one `agy models` run may take (3.x: 45 s).
const TIMEOUT: Duration = Duration::from_secs(45);

/// The ids of `agy models` stdout. Registry rows are `<id>\t<label>`; the
/// "Fetching available models..." banner has spaces and no tab, and a
/// signed-out CLI prints no rows at all (its log says "Auth mode is
/// unspecified, skipping fetchAvailableModels").
#[nolog]
pub fn parse(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(id, _)| id.trim())
        .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))
        .map(str::to_string)
        .collect()
}

/// Whether the registry lists the BASE id `model`: bare, or with one of the
/// effort suffixes. Nothing else matches, no label and no other prefix
/// (user ruling 2026-10-01 for Argon: exact id).
#[nolog]
pub fn listed(model: &str, registry: &[String]) -> bool {
    !model.is_empty()
        && registry.iter().any(|id| {
            id == model || id.strip_prefix(model).is_some_and(|rest| EFFORT_SUFFIXES.contains(&rest))
        })
}

/// `agy --log-file <log> models`, run from the probe folder with the
/// updater off, no window and none of orgtree's or other providers' keys.
#[nolog]
fn command(exe: &Path, dir: &Path, log: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--log-file")
        .arg(log)
        .arg("models")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    for (k, _) in std::env::vars() {
        if k.starts_with("ANTHROPIC_")
            || ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ORGTREE_V2_TOKEN", "ELECTRON_RUN_AS_NODE"].contains(&k.as_str())
        {
            cmd.env_remove(&k);
        }
    }
    crate::winproc::no_window(&mut cmd);
    cmd
}

/// One read of the registry. `Err` is no evidence (signed out, refused,
/// timed out), and no evidence offers no conditional tier. Each probe writes
/// its own log, then moves it onto `models-probe.log` for anyone reading it
/// by hand (3.x: concurrent probes sharing one log lost lines).
#[nolog]
pub async fn read(engine: &Engine, exe: &Path) -> Result<Vec<String>, String> {
    let dir = engine.cfg.path("diagnostics").join("agy-probe");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log: PathBuf = dir.join(format!("models-probe.{}.{:x}.log", std::process::id(), rand::random::<u64>()));
    let out = run(engine, exe, command(exe, &dir, &log)).await;
    if std::fs::rename(&log, dir.join("models-probe.log")).is_err() {
        let _ = std::fs::remove_file(&log);
    }
    let out = out?;
    if !out.status.success() {
        return Err(format!("agy models exited {:?}", out.status.code()));
    }
    Ok(parse(&String::from_utf8_lossy(&out.stdout)))
}

/// The one place `agy models` is started.
#[nolog]
async fn run(_engine: &Engine, _exe: &Path, mut cmd: tokio::process::Command) -> Result<std::process::Output, String> {
    tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| "agy models timed out".to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{listed, parse};

    /// `agy models` for the user's account, measured 2026-10-01 (agy 1.2.14),
    /// as rows: the shape 3.x parsed.
    const MEASURED: &str = "Fetching available models...\n\
        gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
        gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
        gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\
        claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\
        gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

    #[test]
    fn rows_are_ids_and_the_banner_is_not() {
        let ids = parse(MEASURED);
        assert_eq!(ids, ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-high",
                         "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
        assert!(parse("").is_empty(), "signed out: no rows");
        assert!(parse("Fetching available models...\r\n").is_empty());
        assert_eq!(parse("gemini-4-argon-high\tGemini 4 Argon (High)\r\n"), ["gemini-4-argon-high"]);
        assert!(parse("not an id\tlabel\n").is_empty());
    }

    #[test]
    fn a_base_id_is_listed_bare_or_with_an_effort_suffix_only() {
        let without = parse(MEASURED);
        assert!(!listed("gemini-4-argon", &without));
        assert!(!listed("gemini-4-argon", &[]));
        for id in ["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-max"] {
            assert!(listed("gemini-4-argon", &[id.to_string()]), "{id}");
        }
        // exact id: another model sharing the prefix, or a label, is no evidence
        for id in ["gemini-4-argon-2", "gemini-4-argonite", "gemini-4-argon-preview", "Gemini 4 Argon (Medium)"] {
            assert!(!listed("gemini-4-argon", &[id.to_string()]), "{id}");
        }
        assert!(!listed("", &without));
    }
}
