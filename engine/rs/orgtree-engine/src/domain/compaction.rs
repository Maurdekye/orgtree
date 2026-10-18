//! One normal-compaction capability rule for runtime admission and the picker.
use std::sync::Arc;
use anyhow::Result;
use serde_json::Value;
use crate::engine::Engine;

/// Resolve the saved effective route without creating an actor or process.
#[logged]
pub async fn node_capability(engine: &Arc<Engine>, id: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    let row = client.query_one("SELECT tier,account,extra FROM ot.agents WHERE id=$1", &[&id]).await?;
    drop(client);
    let tier: String = row.get(0);
    let account: Option<String> = row.get(1);
    let extra: Value = row.get(2);
    let provider = crate::providers::catalog::provider_of(&tier);
    let harness = if crate::providers::catalog::is_openrouter(&tier) {
        let stamp = extra["harness"].as_str();
        stamp.map(str::to_string).or_else(|| Some(crate::openrouter::seat_harness(
            engine, account.as_deref(), stamp, extra["harness_pin"].as_bool().unwrap_or(false))))
    } else if crate::providers::catalog::is_langserver(&tier) {
        crate::langserver::route_of(engine, &tier)
            .and_then(|(server, _)| server["harness"].as_str().map(str::to_string))
    } else { None };
    Ok(normal_compact_capability(provider, harness.as_deref()))
}

/// Only desk commands establish user contact; tools retain the agent's origin.
#[derive(Clone, Copy)]
pub enum CommandOrigin { User, Agent }

impl CommandOrigin {
    #[nolog]
    pub fn establishes_user_contact(self) -> bool { matches!(self, Self::User) }
}
#[nolog]
pub fn normal_compact_supported(provider: &str, harness: Option<&str>) -> bool {
    matches!(provider, "claude" | "muse")
        || (matches!(provider, "openrouter" | "langserver") && harness == Some("claude-code"))
}

/// A refusal is an admission result, not a successful compaction.
#[nolog]
pub fn normal_compact_capability(provider: &str, harness: Option<&str>) -> serde_json::Value {
    let supported = normal_compact_supported(provider, harness);
    let reason = if supported {
        None
    } else {
        Some(match (provider, harness) {
            ("openai", _) | (_, Some("codex-cli")) => {
                "Normal compaction is not available for Codex in Orgtree."
            }
            ("google", _) => "Normal compaction is not available for Antigravity in Orgtree.",
            (_, Some("opencode")) => "Normal compaction is not available for OpenCode in Orgtree.",
            _ => "Normal compaction support is unknown for this harness.",
        })
    };
    serde_json::json!({"supported":supported,"reason":reason})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_compact_agent_origin_never_establishes_user_contact() {
        assert!(!CommandOrigin::Agent.establishes_user_contact());
        assert!(CommandOrigin::User.establishes_user_contact());
    }
    #[test]
    fn normal_compact_native_supported_controls() {
        assert!(normal_compact_supported("claude", None));
        assert!(normal_compact_supported("muse", None));
    }
    #[test]
    fn normal_compact_unsupported_controls() {
        assert!(!normal_compact_supported("openai", None));
        assert!(!normal_compact_supported("google", None));
        assert!(!normal_compact_supported("openrouter", Some("codex-cli")));
    }
    #[test]
    fn normal_compact_routes_only_implemented_harnesses() {
        assert!(normal_compact_supported("openrouter", Some("claude-code")));
        assert!(normal_compact_supported("langserver", Some("claude-code")));
        assert!(!normal_compact_supported("openrouter", Some("opencode")));
        assert!(!normal_compact_supported("langserver", Some("opencode")));
    }
    #[test]
    fn normal_compact_unknown_harness_must_not_promise_support() {
        assert!(!normal_compact_supported("openrouter", None));
        assert!(!normal_compact_supported("langserver", Some("future")));
    }
    #[test]
    fn normal_compact_disabled_reasons_and_supported_projection() {
        for (provider, harness, name) in [
            ("openai", None, "Codex"),
            ("google", None, "Antigravity"),
            ("openrouter", Some("opencode"), "OpenCode"),
            ("langserver", None, "unknown"),
        ] {
            let cap = normal_compact_capability(provider, harness);
            assert_eq!(cap["supported"], false);
            assert!(cap["reason"].as_str().unwrap().contains(name));
        }
        let cap = normal_compact_capability("muse", None);
        assert_eq!(cap["supported"], true);
        assert!(cap["reason"].is_null());
    }
}
