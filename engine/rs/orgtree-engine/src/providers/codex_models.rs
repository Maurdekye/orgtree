//! Warm model capability discovery. Never launch a CLI from a staffing read.
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

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
pub async fn probe(exe: &Path) -> Result<BTreeMap<String, Vec<String>>> {
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
    let mut child = cmd.spawn().context("start Codex capability discovery")?;
    let job = crate::winproc::child_job(&child);
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Codex has no stdin"))?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Codex has no stdout"))?,
    )
    .lines();
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
        let mut models = BTreeMap::new();
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
                let efforts = super::catalog::EFFORTS
                    .iter()
                    .filter(|e| {
                        offered
                            .iter()
                            .any(|v| v["reasoningEffort"].as_str() == Some(**e))
                    })
                    .map(|e| (*e).to_string())
                    .collect();
                models.insert(id.to_string(), efforts);
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
    if let Some(job) = &job {
        job.terminate();
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result.map_err(|_| anyhow!("Codex capability discovery timed out"))?
}
