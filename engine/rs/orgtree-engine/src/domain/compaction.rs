//! Normal-compaction routing, extracted from actor admission for capability tests.
#[nolog]
pub fn normal_compact_supported(provider:&str,harness:Option<&str>)->bool {
    matches!(provider,"claude"|"muse")
        || (matches!(provider,"openrouter"|"langserver") && harness!=Some("codex-cli"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_compact_native_supported_controls() {
        assert!(normal_compact_supported("claude",None));
        assert!(normal_compact_supported("muse",None));
    }
    #[test]
    fn normal_compact_unsupported_controls() {
        assert!(!normal_compact_supported("openai",None));
        assert!(!normal_compact_supported("google",None));
        assert!(!normal_compact_supported("openrouter",Some("codex-cli")));
    }
    #[test]
    fn normal_compact_routes_only_implemented_harnesses() {
        assert!(normal_compact_supported("openrouter",Some("claude-code")));
        assert!(normal_compact_supported("langserver",Some("claude-code")));
        assert!(!normal_compact_supported("openrouter",Some("opencode")));
        assert!(!normal_compact_supported("langserver",Some("opencode")));
    }
    #[test]
    fn normal_compact_unknown_harness_must_not_promise_support() {
        assert!(!normal_compact_supported("openrouter",None));
        assert!(!normal_compact_supported("langserver",Some("future")));
    }
}
