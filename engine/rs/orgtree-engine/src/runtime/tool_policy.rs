//! Built-in tool definitions follow the same scope as their execution.
//! Keep unclassified capabilities at their harness defaults.
use serde_json::Value;
use anyhow::{anyhow, Context, Result};

/// Codex's patch definition comes from model metadata, not the removed
/// `apply_patch_freeform` feature. Preserve the installed CLI's resolved catalog
/// (including a caller-supplied catalog) and change only the denied capability fields. Model-selected multi-agent v2
/// also overrides the feature switches unless its metadata is cleared.
#[logged]
pub fn scoped_catalog(mut catalog: Value, may_write: bool, may_subagents: bool) -> Result<Value> {
    let models = catalog.get_mut("models").and_then(Value::as_array_mut)
        .filter(|models| !models.is_empty()).ok_or_else(|| anyhow!("Codex returned no model catalog"))?;
    for model in models {
        let object = model.as_object_mut().ok_or_else(|| anyhow!("Codex returned an invalid model catalog"))?;
        if !may_write { object.insert("apply_patch_tool_type".into(), Value::Null); }
        if !may_subagents { object.insert("multi_agent_version".into(), Value::Null); }
    }
    Ok(catalog)
}

/// Environment contains the seat's credential lane: never log its arguments.
/// Fail closed if this CLI cannot supply metadata; running with edit tools
/// still present would misrepresent the scope to the model.
#[nolog]
pub async fn codex_scoped_catalog(
    exe: &std::path::Path, cwd: &std::path::Path, config: &[String], env: &[(String, String)],
    may_write: bool, may_subagents: bool,
) -> Result<Vec<String>> {
    use sha2::{Digest, Sha256};
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(config).args(["debug", "models"]).current_dir(cwd)
        .env_clear().envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await
        .context("Codex did not supply its tool catalog in time")??;
    if !output.status.success() {
        return Err(anyhow!("This Codex version could not supply the model catalog needed to hide scoped tools"));
    }
    let catalog: Value = serde_json::from_slice(&output.stdout).context("Codex returned an invalid model catalog")?;
    let bytes = serde_json::to_vec(&scoped_catalog(catalog, may_write, may_subagents)?)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let dir = cwd.join(".orgtree-tool-scope");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{digest}.json"));
    if !path.is_file() {
        let temporary = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&temporary, &bytes).await?;
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            if !path.is_file() { return Err(error.into()); }
        }
    }
    // JSON string escaping is also valid for this TOML basic string.
    Ok(vec!["-c".into(), format!("model_catalog_json={}", serde_json::to_string(&path.to_string_lossy())?)])
}

#[logged]
pub fn claude_disallowed(tools: &Value) -> Vec<String> {
    let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
    let mut names = vec!["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "CronCreate",
        "CronDelete", "CronList", "ScheduleWakeup", "Monitor", "RemoteTrigger"];
    if !on("bash") { names.extend(["Bash", "PowerShell", "BashOutput", "KillShell"]); }
    if !on("web") { names.extend(["WebSearch", "WebFetch"]); }
    if !on("edit") {
        names.extend(["Edit", "Write", "NotebookEdit", "MultiEdit", "EnterWorktree", "ExitWorktree"]);
    }
    if !on("subagents") { names.extend(["Task", "Agent", "SendMessage", "Workflow", "ListAgents", "TeamCreate", "TeamDelete"]); }
    // TaskStop controls both background shell commands and ephemeral agents.
    if !on("bash") && !on("subagents") { names.push("TaskStop"); }
    names.into_iter().map(str::to_owned).collect()
}

#[logged]
pub fn codex_overrides(tools: &Value) -> Vec<String> {
    let on = |k: &str| tools.get(k).and_then(Value::as_bool).unwrap_or(true);
    let mut settings = Vec::new();
    if !on("bash") {
        settings.extend(["features.shell_tool=false", "features.unified_exec=false", "features.code_mode=false"]);
    }
    if !on("web") {
        settings.extend(["web_search=\"disabled\"", "features.web_search_request=false", "features.web_search_cached=false",
            "features.standalone_web_search=false", "features.browser_use=false"]);
    }
    if !on("subagents") { settings.extend(["features.multi_agent=false", "features.multi_agent_v2=false"]); }
    settings.into_iter().flat_map(|setting| ["-c".to_owned(), setting.to_owned()]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replacements_are_always_removed_but_agent_messages_follow_subagent_scope() {
        let all = claude_disallowed(&json!({}));
        assert!(all.contains(&"Monitor".into()) && all.contains(&"CronCreate".into()));
        assert!(!all.contains(&"SendMessage".into()));
        let no_agents = claude_disallowed(&json!({"subagents":false}));
        for name in ["Agent", "Task", "SendMessage", "Workflow", "ListAgents"] {
            assert!(no_agents.iter().any(|n| n == name));
        }
        assert!(!no_agents.contains(&"TaskStop".into()));
        assert!(claude_disallowed(&json!({"bash":false,"subagents":false})).contains(&"TaskStop".into()));
        assert!(codex_overrides(&json!({})).is_empty());
    }

    #[test]
    fn readonly_catalog_changes_only_patch_capability() {
        let original = json!({"models":[{"slug":"proof","apply_patch_tool_type":"freeform",
            "context_window":65536,"shell_type":"unified_exec","base_instructions":"retain verbatim",
            "future_metadata":{"unknown":true}},{"slug":"no-patch","apply_patch_tool_type":null}],"revision":"proof"});
        let mut wanted = original.clone();
        wanted["models"][0]["apply_patch_tool_type"] = Value::Null;
        assert_eq!(scoped_catalog(original.clone(), false, true).unwrap(), wanted);
        assert_eq!(scoped_catalog(original.clone(), true, true).unwrap(), original);
        let without_agents = scoped_catalog(original, true, false).unwrap();
        assert!(without_agents["models"][0]["multi_agent_version"].is_null());
        assert_eq!(without_agents["models"][0]["apply_patch_tool_type"], "freeform");
        assert!(scoped_catalog(serde_json::json!({"models":[]}), false, false).is_err());
    }
}
