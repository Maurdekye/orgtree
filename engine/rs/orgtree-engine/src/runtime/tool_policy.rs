//! Built-in tool definitions follow the same scope as their execution.
//! Keep unclassified capabilities at their harness defaults.
use serde_json::Value;

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
}
