//! One normal-compaction capability rule for runtime admission and the picker.
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
