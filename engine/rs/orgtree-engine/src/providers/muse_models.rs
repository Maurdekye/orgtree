//! Muse Code discovery: the installed binary, the MSP schema it speaks, its
//! sign-in state and the signed-in account's model catalog, read from a
//! short-lived metadata host (`muse serve --no-session-log`). It sends only
//! `initialize`, `account/read`, `model/list` and `usage/read`: never a
//! session, a turn or inference, and never the updater launcher.
//!
//! Measured on Muse 1.4.6 (2026-10-12): a host whose data home holds no
//! fetched catalog answers `model/list` with source `bundledCatalog` (rows the
//! binary ships, `profileId` null, no limits); the signed-in account's own
//! catalog comes back as source `providerCatalog`, and Muse can merge bundled
//! rows into it. Only rows from the account's catalog (non-null `profileId`)
//! are evidence that the account offers a model.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

/// The MSP envelope schema this adapter speaks.
pub const SCHEMA_VERSION: i64 = 1;
/// Stable-surface fingerprints of the Muse builds this adapter was verified
/// against (`initialize` → `schema.fingerprint`). Another fingerprint is a
/// warning, not a refusal (MSP §1.4.1): the build runs, marked unverified.
pub const VERIFIED_FINGERPRINTS: &[(&str, &str)] =
    &[("1.4.6", "sha256:eae467ab60cb9a5d5af4de616830f065e59375c987fd59269c8cc33ed2a1137f")];

/// One model the catalog lists.
#[derive(Clone, Debug, PartialEq)]
pub struct MuseModel {
    pub id: String,
    pub is_default: bool,
    /// the effort tiers the model takes, as the catalog names them
    pub variants: Vec<String>,
    pub default_effort: Option<String>,
    pub context: Option<i64>,
    pub output: Option<i64>,
    /// the row came from the signed-in account's catalog (not a bundled row)
    pub account_row: bool,
}

/// The catalog one `model/list` answered.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MuseCatalog {
    /// providerCatalog | bundledCatalog | … (verbatim)
    pub source: String,
    pub models: Vec<MuseModel>,
}

impl MuseCatalog {
    /// The account's own row for `model`, if its catalog lists it.
    #[nolog]
    pub fn offered(&self, model: &str) -> Option<&MuseModel> {
        if self.source != "providerCatalog" {
            return None;
        }
        self.models.iter().find(|m| m.id == model && m.account_row)
    }
}

/// What one metadata host reported. The account label (an email) is for
/// display only and never logged.
#[derive(Clone, Default)]
pub struct MuseProbe {
    pub server_version: Option<String>,
    pub schema_version: Option<i64>,
    pub fingerprint: Option<String>,
    /// accountLogin | apiKey | loggedOut | … (verbatim)
    pub account_state: Option<String>,
    pub label: Option<String>,
    pub catalog: Option<MuseCatalog>,
    /// `usage/read`'s `usage` member: None when the host has observed nothing
    pub usage: Option<Value>,
}

impl std::fmt::Debug for MuseProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MuseProbe")
            .field("server_version", &self.server_version)
            .field("schema_version", &self.schema_version)
            .field("fingerprint", &self.fingerprint)
            .field("account_state", &self.account_state)
            .field("label", &self.label.as_ref().map(|_| "*****"))
            .field("catalog", &self.catalog)
            .field("usage", &self.usage.is_some())
            .finish()
    }
}

/// Whether `fingerprint` is one this adapter was verified against.
#[logged]
pub fn verified(fingerprint: Option<&str>) -> bool {
    fingerprint.is_some_and(|f| VERIFIED_FINGERPRINTS.iter().any(|(_, v)| *v == f))
}

/// The binary in a Muse install folder: the one `.muse-version` names, else
/// the newest-named `muse-bin-*` beside it. The `muse` launcher itself (a
/// PowerShell updater) is never run.
#[logged]
pub fn bin_in(dir: &Path) -> Option<PathBuf> {
    let exe = |v: &str| dir.join(crate::util::exe_name(&format!("muse-bin-{v}")));
    if let Ok(v) = std::fs::read_to_string(dir.join(".muse-version")) {
        let p = exe(v.trim());
        if !v.trim().is_empty() && p.is_file() {
            return Some(p);
        }
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("muse-bin-")))
        .collect();
    found.sort();
    found.pop()
}

/// The installed version a Muse install folder names (`.muse-version`).
#[logged]
pub fn installed_version(exe: &Path) -> Option<String> {
    let v = std::fs::read_to_string(exe.parent()?.join(".muse-version")).ok()?;
    Some(v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The environment naming a managed Muse login's own roots: Muse keeps its
/// sign-in under `$XDG_CONFIG_HOME/muse` and its sessions, catalog and
/// usage cache under `$XDG_DATA_HOME/muse`. The user's own login (None)
/// names nothing: it keeps whatever the user's environment says.
#[logged]
pub fn login_env(root: Option<&Path>) -> Vec<(String, String)> {
    let Some(root) = root else { return Vec::new() };
    vec![
        ("XDG_CONFIG_HOME".into(), root.join("config").to_string_lossy().to_string()),
        ("XDG_DATA_HOME".into(), root.join("data").to_string_lossy().to_string()),
    ]
}

/// The environment a Muse process gets: the engine's, minus every other
/// provider's credentials and Orgtree's own secrets, minus any inherited
/// `META_API_KEY` (an API key outranks the subscription login, so an
/// inherited one would silently move a subscription seat onto paid
/// inference). `extra` is added after: a registered login names its own
/// `XDG_CONFIG_HOME`/`XDG_DATA_HOME` there; the user's own login keeps
/// whatever the user's environment says.
#[nolog] // the environment holds secrets
pub fn clean_env(extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            !(k.starts_with("ANTHROPIC_")
                || k.starts_with("CLAUDE_CODE_")
                || [
                    "CLAUDECODE", "OPENAI_API_KEY", "CODEX_HOME", "META_API_KEY", "MUSE_AUTH_PATH", "MUSE_TRANSPORT_TRACE",
                    "GEMINI_API_KEY", "GOOGLE_API_KEY", "ELECTRON_RUN_AS_NODE",
                    // the engine's own secrets and data root, as the Codex lane strips them
                    "ORGTREE_ACCOUNT_ID", "ORGTREE_V2_TOKEN", "ORGTREE_DATA",
                ]
                .contains(&k.as_str()))
        })
        .filter(|(k, _)| !extra.iter().any(|(x, _)| x == k))
        .collect();
    env.push(("MUSE_NO_AUTO_UPDATE".into(), "1".into()));
    env.extend(extra.iter().cloned());
    env
}

/// Not logged: answers carry the account label.
#[nolog]
async fn request(input: &mut ChildStdin, lines: &mut Lines<BufReader<ChildStdout>>, id: i64, method: &str, params: Value) -> Result<Value> {
    let mut frame = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    if !params.is_null() {
        frame["params"] = params;
    }
    input.write_all(format!("{frame}\n").as_bytes()).await?;
    input.flush().await?;
    while let Some(line) = lines.next_line().await? {
        if line.len() > 4 * 1024 * 1024 {
            bail!("Muse {method} answer is too large");
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        // a server-initiated request (none is expected here) or a notification
        if v.get("method").is_some() || v["id"].as_i64() != Some(id) {
            continue;
        }
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            bail!("Muse {method}: {}", e["message"].as_str().unwrap_or("request failed"));
        }
        return v.get("result").cloned().ok_or_else(|| anyhow!("Muse {method} returned no result"));
    }
    bail!("Muse closed before answering {method}")
}

/// A catalog answer as rows this engine reads.
#[logged]
pub fn parse_catalog(result: &Value) -> MuseCatalog {
    let models = result["models"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|m| {
                    let id = m["modelId"].as_str().filter(|s| !s.is_empty())?.to_string();
                    Some(MuseModel {
                        id,
                        is_default: m["isDefault"].as_bool().unwrap_or(false),
                        variants: m["variants"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                        default_effort: m["defaultReasoningEffort"].as_str().map(str::to_string),
                        context: m["contextLimit"].as_i64().filter(|c| *c > 0),
                        output: m["outputLimit"].as_i64().filter(|c| *c > 0),
                        account_row: m["profileId"].as_str().is_some_and(|p| !p.is_empty()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    MuseCatalog { source: result["source"].as_str().unwrap_or("").to_string(), models }
}

/// One metadata read of the login whose config and data roots `env` names
/// (none: the user's own). Zero inference; the host is ended by closing its
/// input, and only terminated when it outlives the grace.
#[nolog] // its answer carries the account label; `discover` logs a summary
pub async fn probe(exe: &Path, env: &[(String, String)], cwd: &Path) -> Result<MuseProbe> {
    let mut cmd = Command::new(exe);
    cmd.args(["serve", "--provider", "meta", "--no-session-log"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    crate::winproc::no_window(&mut cmd);
    crate::winproc::own_group(&mut cmd);
    let mut child = cmd.spawn().context("start Muse capability discovery")?;
    let job = crate::winproc::child_job(&child);
    let grace = crate::runtime::codex::PROBE_GRACE;
    let (Some(mut input), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        crate::runtime::stop_gracefully(&mut child, job.as_ref(), "Muse capability discovery", "no stdio", grace).await;
        bail!("Muse has no stdio");
    };
    let mut lines = BufReader::new(stdout).lines();
    let read = async {
        let init = request(
            &mut input,
            &mut lines,
            1,
            "initialize",
            json!({ "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true, "userInputDialogs": false } }),
        )
        .await?;
        input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}\n").await?;
        let mut out = MuseProbe {
            server_version: init.pointer("/serverInfo/version").and_then(Value::as_str).map(str::to_string),
            schema_version: init.pointer("/schema/version").and_then(Value::as_i64),
            fingerprint: init.pointer("/schema/fingerprint").and_then(Value::as_str).map(str::to_string),
            ..Default::default()
        };
        if out.schema_version != Some(SCHEMA_VERSION) {
            bail!("Muse speaks MSP schema {:?}; this Orgtree speaks {SCHEMA_VERSION}", out.schema_version);
        }
        // experimental in 1.4.6: a refusal leaves the state unknown, not signed out
        if let Ok(a) = request(&mut input, &mut lines, 2, "account/read", Value::Null).await {
            out.account_state = a["state"].as_str().map(str::to_string);
            out.label = a["label"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        }
        out.catalog = Some(parse_catalog(&request(&mut input, &mut lines, 3, "model/list", Value::Null).await?));
        out.usage = request(&mut input, &mut lines, 4, "usage/read", Value::Null).await.ok().and_then(|u| u.get("usage").cloned());
        Ok::<_, anyhow::Error>(out)
    };
    let result = tokio::time::timeout(Duration::from_secs(25), read).await;
    drop(input);
    let reason = match &result {
        Ok(Ok(_)) => "discovery answered",
        Ok(Err(_)) => "discovery failed",
        Err(_) => "discovery timed out",
    };
    crate::runtime::stop_gracefully(&mut child, job.as_ref(), "Muse capability discovery", reason, grace).await;
    drop(job);
    result.map_err(|_| anyhow!("Muse capability discovery timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_rows_are_not_entitlement() {
        // the 19:58Z 2026-10-12 shape: three account rows plus a bundled Full row
        let c = parse_catalog(&json!({ "source": "providerCatalog", "models": [
            { "modelId": "muse-wonder-1.0", "profileId": "tbh", "isDefault": true, "contextLimit": 1007997, "outputLimit": 128000,
              "variants": ["minimal","low","medium","high","xhigh","max"], "defaultReasoningEffort": "high" },
            { "modelId": "muse-wonder-full-1.0", "profileId": null, "isDefault": false, "contextLimit": null, "outputLimit": null,
              "variants": ["minimal","low","medium","high","xhigh"], "defaultReasoningEffort": "high" } ] }));
        assert!(c.offered("muse-wonder-1.0").is_some());
        assert!(c.offered("muse-wonder-full-1.0").is_none());
        assert_eq!(c.offered("muse-wonder-1.0").unwrap().context, Some(1_007_997));
        // a bundled catalog offers nothing at all
        let b = parse_catalog(&json!({ "source": "bundledCatalog", "models": [
            { "modelId": "muse-wonder-1.0", "profileId": "tbh", "variants": ["high"] } ] }));
        assert!(b.offered("muse-wonder-1.0").is_none());
    }

    #[test]
    fn fingerprints_gate_verification_only() {
        assert!(verified(Some("sha256:eae467ab60cb9a5d5af4de616830f065e59375c987fd59269c8cc33ed2a1137f")));
        assert!(!verified(Some("sha256:0000")));
        assert!(!verified(None));
    }
}
