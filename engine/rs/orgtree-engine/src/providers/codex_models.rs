//! Warm model capability discovery. Never launch a CLI from a staffing read.
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

#[derive(Default)]
pub struct Capabilities {
    pub efforts: BTreeMap<String, Vec<String>>,
    pub fast_modes: BTreeMap<String, String>,
}

#[logged]
async fn request(
    input: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    input.write_all(format!("{frame}\n").as_bytes()).await?;
    input.flush().await?;
    while let Some(line) = lines.next_line().await? {
        if line.len() > 4 * 1024 * 1024 {
            bail!("Codex capability response is too large");
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v["id"].as_i64() != Some(id) {
            continue;
        }
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            bail!(
                "Codex {method}: {}",
                e["message"].as_str().unwrap_or("request failed")
            );
        }
        return v
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Codex {method} returned no result"));
    }
    bail!("Codex closed before answering {method}")
}

/// Same model/list source as 3.x, including hidden rows and pagination. This
/// reads capabilities only: no thread, agent turn or inference is started.
#[logged]
pub async fn probe(exe: &Path) -> Result<Capabilities> {
    let mut cmd = Command::new(exe);
    cmd.arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (k, _) in std::env::vars() {
        if k.starts_with("ANTHROPIC_")
            || k.starts_with("CLAUDE_CODE_")
            || [
                "CLAUDECODE",
                "OPENAI_API_KEY",
                "CODEX_HOME",
                "ORGTREE_V2_TOKEN",
                "ORGTREE_DATA",
                "ELECTRON_RUN_AS_NODE",
            ]
            .contains(&k.as_str())
        {
            cmd.env_remove(&k);
        }
    }
    crate::winproc::no_window(&mut cmd);
    crate::winproc::own_group(&mut cmd);
    let mut child = cmd.spawn().context("start Codex capability discovery")?;
    let job = crate::winproc::child_job(&child);
    // nothing may drop the child (kill_on_drop) or its job (kill-on-close)
    // before stop_gracefully: either is a hard kill
    let grace = crate::runtime::codex::PROBE_GRACE;
    let (Some(mut input), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        crate::runtime::stop_gracefully(&mut child, job.as_ref(), "capability discovery", "no stdio", grace).await;
        bail!("Codex has no stdio");
    };
    let mut lines = BufReader::new(stdout).lines();
    let read = async {
        request(
            &mut input,
            &mut lines,
            1,
            "initialize",
            json!({
                "clientInfo": { "name": "orgtree", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true },
            }),
        )
        .await?;
        input
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{}}\n")
            .await?;
        let mut models = Capabilities::default();
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        for page in 0..20 {
            let v = request(
                &mut input,
                &mut lines,
                page + 2,
                "model/list",
                json!({ "limit": 100, "includeHidden": true, "cursor": cursor }),
            )
            .await?;
            let rows = v["data"]
                .as_array()
                .ok_or_else(|| anyhow!("model/list returned no data list"))?;
            for row in rows {
                let id = row["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow!("model/list row has no id"))?;
                let offered = row["supportedReasoningEfforts"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                // Codex's own level names, in rank order (user 2026-10-12)
                let efforts = super::catalog::EFFORT_ORDER
                    .iter()
                    .filter(|e| {
                        offered
                            .iter()
                            .any(|v| v["reasoningEffort"].as_str() == Some(**e))
                    })
                    .map(|e| (*e).to_string())
                    .collect();
                models.efforts.insert(id.to_string(), efforts);
                if let Some(tier) = super::fast_mode::advertised_tier(row) {
                    models.fast_modes.insert(id.to_string(), tier);
                }
            }
            cursor = v["nextCursor"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let Some(next) = &cursor else {
                return Ok(models);
            };
            if !seen.insert(next.clone()) {
                bail!("model/list repeated a cursor");
            }
        }
        bail!("model/list exceeded 20 pages")
    };
    let result = tokio::time::timeout(Duration::from_secs(25), read).await;
    // never a hard kill first: close its input and let it exit
    drop(input);
    let reason = match &result {
        Ok(Ok(_)) => "discovery answered",
        Ok(Err(_)) => "discovery failed",
        Err(_) => "discovery timed out",
    };
    crate::runtime::stop_gracefully(&mut child, job.as_ref(), "capability discovery", reason, grace).await;
    drop(job);
    result.map_err(|_| anyhow!("Codex capability discovery timed out"))?
}
