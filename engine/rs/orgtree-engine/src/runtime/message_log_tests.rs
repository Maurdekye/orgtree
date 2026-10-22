//! The actor mailbox uses Debug fallback in verbose entry logging. Payloads
//! remain intact for the actor, but no provider/tool body belongs in that log.
use super::*;

#[tokio::test]
async fn provider_tool_message_is_opaque_in_actual_mailbox_log() {
    const CANARY: &str = "SYNTHETIC-ACTOR-CREDENTIAL-184a";
    let capture = crate::trace::LogCapture::start().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = AgentHandle { id: 7, org_id: 3, tx, view: ArcSwap::from_pointee(json!({})) };
    let payload = json!({"method":"item/started","params":{"item":{"type":"mcpToolCall",
        "name":"orgtree_watchdog","arguments":{"credentials":{"bearer":CANARY},
            "headers":{"X-Auth":CANARY},"query":{"session_key":CANARY},"opaque":CANARY}}}});
    assert!(handle.send(AgentMsg::Codex(uuid::Uuid::nil(), payload.clone())));
    match rx.try_recv().expect("real mailbox received the message").msg {
        AgentMsg::Codex(_, value) => assert_eq!(value, payload, "logging must never sanitize the delivered message"),
        _ => panic!("wrong mailbox message"),
    }
    let log = capture.finish().await;
    assert!(log.contains("AgentHandle.send") && log.contains("Codex") && log.contains("true"),
        "actual verbose entry, message kind and successful return must still be logged");
    println!("mailbox_log_bytes={} synthetic_canary_occurrences={}", log.len(), log.matches(CANARY).count());
    assert!(!log.contains(CANARY), "raw synthetic tool-call credentials entered the actor mailbox log");
}

#[test]
fn provider_hook_and_control_debug_never_formats_payload_fields() {
    const CANARY: &str = "SYNTHETIC-OPAQUE-ACTOR-PAYLOAD-93d2";
    let payload = json!({"unrecognized_field": CANARY});
    let (reply, _) = oneshot::channel();
    let messages = [
        ("Claude", AgentMsg::Claude(uuid::Uuid::nil(), payload.clone())),
        ("Codex", AgentMsg::Codex(uuid::Uuid::nil(), payload.clone())),
        ("Agy", AgentMsg::Agy(uuid::Uuid::nil(), payload.clone())),
        ("Muse", AgentMsg::Muse(uuid::Uuid::nil(), payload.clone())),
        ("Acp", AgentMsg::Acp(uuid::Uuid::nil(), payload.clone())),
        ("Hook", AgentMsg::Hook { process: uuid::Uuid::nil(), input: payload.clone(), reply }),
        ("ToolCard", AgentMsg::ToolCard(CANARY.into(), payload)),
        ("Command", AgentMsg::Command(CANARY.into(), oneshot::channel().0)),
        ("ProcExited", AgentMsg::ProcExited { process: uuid::Uuid::nil(), reason: CANARY.into() }),
        ("Loading", AgentMsg::Loading(Some(CANARY.into()))),
    ];
    for (kind, msg) in messages {
        let text = format!("{msg:?}");
        assert!(text.contains(kind), "message kind diagnostic lost");
        assert!(!text.contains(CANARY), "payload entered {kind} Debug fallback");
    }
}
