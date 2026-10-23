use super::*;
use serde_json::json;

#[logged]
fn ordinary_wrapper(value: &Value) -> anyhow::Result<Value> {
    Ok(value.clone())
}

#[tokio::test]
async fn thinking_never_enters_captured_trace_through_tool_json_wrappers() {
    const CANARY: &str = "PRIVATE_THINKING_CANARY_444";
    let capture = LogCapture::start().await;
    let transcript = json!({"node":"fixture", "messages":[{
        "role":"assistant", "text":"PUBLIC_REPLY_CONTROL", "thinking":CANARY,
        "thinking_sealed":false, "tools":[{"name":"Read","result":"PUBLIC_TOOL_CONTROL"}]
    }]});
    let done = crate::tools::Done::json(&transcript).unwrap();
    assert!(done.text.contains(CANARY), "redaction must not change the actual tool reply");
    let mut wire = json!({"content":[{"type":"text","text":done.text}],"isError":false});
    for _ in 0..4 {
        assert_eq!(ordinary_wrapper(&wire).unwrap(), wire);
        wire = json!({"result":wire.to_string(),"public":"PUBLIC_DIAGNOSTIC_CONTROL"});
    }
    for value in [transcript, json!({"blocks":[{"type":"thinking","text":CANARY}]}),
        json!({"content":[{"type":"text","text":json!({"Thinking":CANARY}).to_string()}]})] {
        ordinary_wrapper(&value).unwrap();
    }
    let log = capture.finish().await;
    if let Ok(out) = std::env::var("ORGTREE_THINKING_TRACE_TEST_OUT") {
        std::fs::write(out, &log).unwrap();
    }
    assert!(log.contains("Done.json") && log.contains("ordinary_wrapper"), "real logged calls must execute");
    assert!(log.contains("PUBLIC_DIAGNOSTIC_CONTROL"), "ordinary diagnostics remain visible");
    assert!(!log.contains(CANARY), "supplied thinking leaked into captured trace");
    assert!(log.contains("PUBLIC_REPLY_CONTROL") && log.contains("PUBLIC_TOOL_CONTROL"));
}
