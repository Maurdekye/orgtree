//! Tool-result presentation at the engine's common dispatch boundary.
use std::time::Duration;
use serde_json::{json, Value};

/// Baseline seam: the existing result is unchanged before timing is added.
#[nolog]
pub(super) fn finish(result: Value, _elapsed: Duration) -> Value { result }

/// Baseline extraction of the dynamic-tool adapter's existing text view.
#[nolog]
pub(crate) fn codex_result(result: &Value) -> Value {
    let text = result["content"].as_array().map(|a| a.iter()
        .filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    json!({"success":!result["isError"].as_bool().unwrap_or(false),
        "contentItems":[{"type":"inputText","text":text}]})
}

#[cfg(test)]
pub(crate) fn assert_time_line(text: &str) {
    let ms = text.strip_prefix("execution time: ").and_then(|s| s.strip_suffix("ms")).expect("timing line");
    let (whole, fraction) = ms.split_once('.').expect("decimal milliseconds");
    assert!(!whole.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(fraction.len(), 3);
    assert!(fraction.bytes().all(|b| b.is_ascii_digit()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::runtime::Caller;

    fn caller() -> Caller { Caller { org_id:1, org_slug:"fixture".into(), agent_id:7, name:"fixture".into() } }

    #[test]
    fn tool_result_timing_milliseconds_have_three_decimals_including_sub_ms() {
        for (ns, expected) in [(0,"0.000"),(432_000,"0.432"),(1_234_567,"1.235"),(1_500_000_000,"1500.000")] {
            let out=finish(json!({"content":[{"type":"text","text":"done"}]}),Duration::from_nanos(ns));
            assert_eq!(out["content"][1]["text"],format!("execution time: {expected}ms"));
        }
    }

    #[test]
    fn tool_result_timing_preserves_first_json_text_byte_for_byte() {
        let text=r#"{ "count": 2, "label": "a" }"#;
        let out=finish(json!({"content":[{"type":"text","text":text}]}),Duration::from_micros(432));
        assert_eq!(out["content"][0]["text"],text);
        assert_eq!(serde_json::from_str::<Value>(out["content"][0]["text"].as_str().unwrap()).unwrap()["count"],2);
        assert!(out.get("isError").is_none());
    }

    #[test]
    fn tool_result_timing_refusal_preserves_error_and_retry_hint_then_adds_time() {
        let text="delivery uncertain\nretry with delivery_id=original";
        let out=finish(json!({"content":[{"type":"text","text":text}],"isError":true}),Duration::from_millis(2));
        assert_eq!(out["isError"],true);
        assert_eq!(out["content"][0]["text"],text);
        assert_eq!(out["content"].as_array().unwrap().len(),2);
        assert_eq!(out["content"][1]["text"],"execution time: 2.000ms");
        assert_eq!(out.as_object().unwrap().len(),2,"no extra result fields");
    }

    #[test]
    fn tool_result_timing_empty_success_still_has_original_empty_block() {
        let out=finish(json!({"content":[{"type":"text","text":""}]}),Duration::ZERO);
        assert_eq!(out["content"][0]["text"],"");
        assert_eq!(out["content"].as_array().unwrap().len(),2);
        assert_time_line(out["content"][1]["text"].as_str().unwrap());
    }

    #[test]
    fn tool_result_timing_codex_preserves_two_blocks_not_one_joined_json() {
        let out=codex_result(&json!({"content":[{"type":"text","text":"{\"ok\":true}"},
            {"type":"text","text":"execution time: 0.432ms"}]}));
        assert_eq!(out["success"],true);
        assert_eq!(out["contentItems"].as_array().unwrap().len(),2);
        assert_eq!(out["contentItems"][0]["text"],"{\"ok\":true}");
        assert_eq!(out["contentItems"][1]["text"],"execution time: 0.432ms");
    }

    #[tokio::test]
    async fn tool_result_timing_argument_refusals_cover_split_and_flat_mcp() {
        let engine=Engine::for_tests("unused-tool-result-timing".into());
        for shape in [super::super::defs::MailShape::Split,super::super::defs::MailShape::Flat] {
            let out=super::super::handle_mcp_as(&engine,&caller(),&json!({"jsonrpc":"2.0","id":91,
                "method":"tools/call","params":{"name":"orgtree_chart","arguments":[]}}),shape).await;
            assert_eq!(out["id"],91);
            assert_eq!(out["result"]["isError"],true);
            assert_eq!(out["result"]["content"][0]["text"],"orgtree_chart: the arguments must be a JSON object");
            assert_eq!(out["result"]["content"].as_array().unwrap().len(),2);
            assert_time_line(out["result"]["content"][1]["text"].as_str().unwrap());
        }
    }

    #[tokio::test]
    async fn tool_result_timing_dispatch_refusals_also_get_a_measured_line() {
        let engine=Engine::for_tests("unused-tool-result-timing".into());
        let out=super::super::call_agent_tool(&engine,&caller(),"not_a_real_tool",&json!({}),None).await;
        assert_eq!(out["isError"],true);
        assert_eq!(out["content"][0]["text"],"unknown tool not_a_real_tool");
        assert_eq!(out["content"].as_array().unwrap().len(),2);
        assert_time_line(out["content"][1]["text"].as_str().unwrap());
    }

    #[tokio::test]
    async fn tool_result_timing_rig_legacy_view_does_not_break_existing_parsers() {
        let engine=Engine::for_tests("unused-tool-result-timing".into());
        let (ok,text)=super::super::call_tool(&engine,&caller(),"not_a_real_tool",&json!({}),None).await;
        assert!(!ok);assert_eq!(text,"unknown tool not_a_real_tool");
    }

    #[test]
    fn tool_result_timing_handshake_has_no_fake_execution_line() {
        let out=super::super::mcp_handshake(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}),vec![]);
        assert_eq!(out,json!({"jsonrpc":"2.0","id":1,"result":{}}));
    }
}
