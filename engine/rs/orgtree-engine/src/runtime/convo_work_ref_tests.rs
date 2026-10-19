use super::{apply_tool_card, tool_arg, tool_refs, tool_result_text};
use serde_json::{json, Value};

fn recorded_result(body: Value) -> Value {
    // The MCP blocks introduced by result_timing::finish, flattened by the
    // Claude/history and Codex settled-tool adapters before tool_refs runs.
    json!([
        {"type":"text", "text":serde_json::to_string_pretty(&body).unwrap()},
        {"type":"text", "text":"execution time: 18.000ms"}
    ])
}

#[test]
fn timed_work_create_records_the_result_slug_beside_its_owner() {
    let input = json!({"action":"create", "title":"Restore ticket cards", "kind":"code",
        "objective":"Restore the recorded tool's docket link", "owner":"worker"});
    let body = json!({"created":"restore-ticket-cards", "slug":"restore-ticket-cards", "rev":1,
        "status":"open", "owner":"worker"});
    let content = recorded_result(body.clone());
    let (text, _) = tool_result_text(&content);
    let expected = json!([{"kind":"agent","id":"worker"},{"kind":"ticket","id":"restore-ticket-cards"}]);
    let mut chips = Vec::new();
    // Both the flattened settled call and an MCP envelope (AGY) must work.
    for result in [&text, &json!({"content":content}).to_string()] {
        let refs = tool_refs("mcp__orgtree__orgtree_work", &input, Some(result));
        assert_eq!(refs, expected);
        chips.push(json!({"id":"create-ticket", "name":"mcp__orgtree__orgtree_work",
            "arg":tool_arg("orgtree_work", &input), "input":input, "result":result, "refs":refs}));
    }
    // Creation variants that provide only one of the established result keys.
    for key in ["slug", "created", "work_item"] {
        let mut result = json!({"rev":1}); result[key] = json!("restore-ticket-cards");
        let (text, _) = tool_result_text(&recorded_result(result));
        assert_eq!(tool_refs("orgtree_work", &input, Some(&text)), expected);
    }
    if let Ok(path) = std::env::var("ORGTREE_WORK_REF_CAPTURE") {
        let update = json!({"action":"update", "slug":"restore-ticket-cards", "owner":"worker", "status":"in_progress"});
        let (text, _) = tool_result_text(&recorded_result(json!({"updated":"restore-ticket-cards",
            "previous_status":"open", "status":"in_progress", "rev":2})));
        chips.truncate(1);
        chips.push(json!({"id":"update-ticket", "name":"mcp__orgtree__orgtree_work",
            "arg":tool_arg("orgtree_work", &update), "refs":tool_refs("orgtree_work", &update, Some(&text))}));
        std::fs::write(path, serde_json::to_vec_pretty(&chips).unwrap()).unwrap();
    }
}

#[test]
fn timed_work_actions_keep_argument_slugs_and_recorded_status_changes() {
    for action in ["update", "get", "assign", "evidence", "accept", "participants", "archive",
        "handoff", "supersede", "move", "delete"] {
        let input = json!({"action":action,"slug":"restore-ticket-cards"});
        let (text, _) = tool_result_text(&recorded_result(json!({"rev":2})));
        assert_eq!(tool_refs("orgtree_work", &input, Some(&text)),
            json!([{"kind":"ticket","id":"restore-ticket-cards"}]), "{action}");
    }
    let (text, _) = tool_result_text(&recorded_result(json!({"updated":"restore-ticket-cards",
        "previous_status":"open", "status":"in_progress"})));
    assert_eq!(tool_refs("orgtree_work", &json!({"action":"update","slug":"restore-ticket-cards"}), Some(&text)),
        json!([{"kind":"ticket","id":"restore-ticket-cards","status_change":{"from":"open","to":"in_progress"}}]));
    assert_eq!(tool_refs("orgtree_work", &json!({"action":"list"}), Some(&text)), json!([]));
}

#[test]
fn timed_work_results_never_invent_a_ticket_from_failed_or_unrelated_text() {
    for result in ["plain failure", "{\"created\":\"fake\"", "{\"created\":\"fake\"}\nnot timing",
        "{}\n{\"created\":\"fake\"}", "{\"created\":\"fake\",\"isError\":true}",
        "{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"{\\\"created\\\":\\\"fake\\\"}\"}]}\nexecution time: 1.000ms"] {
        assert_eq!(tool_refs("orgtree_work", &json!({"action":"create","title":"No inferred slug"}), Some(result)), json!([]));
    }
    assert_eq!(tool_refs("Bash", &json!({"command":"orgtree_work create"}), Some("{\"created\":\"fake\"}\nexecution time: 1.000ms")), json!([]));
}

#[test]
fn timed_hire_keeps_the_new_agent_and_work_item() {
    let input = json!({"name":"new-worker","parent":"manager","work_item":"restore-ticket-cards"});
    let (text, _) = tool_result_text(&recorded_result(json!({"hired":"new-worker"})));
    assert_eq!(tool_refs("orgtree_hire", &input, Some(&text)), json!([
        {"kind":"agent","id":"new-worker"},{"kind":"agent","id":"manager"},
        {"kind":"ticket","id":"restore-ticket-cards"}]));
}

#[test]
fn timed_staff_create_keeps_the_new_agent_and_result_ticket() {
    let input = json!({"action":"create","name":"new-worker","title":"Restore ticket cards"});
    let (text, _) = tool_result_text(&recorded_result(json!({"created":"restore-ticket-cards","slug":"restore-ticket-cards"})));
    assert_eq!(tool_refs("orgtree_staff", &input, Some(&text)), json!([
        {"kind":"agent","id":"new-worker"},{"kind":"ticket","id":"restore-ticket-cards"}]));
}

#[test]
fn timed_project_create_keeps_the_named_project() {
    let input = json!({"action":"create","name":"new-project","parent":"manager"});
    let (text, _) = tool_result_text(&recorded_result(json!({"created":"new-project","kind":"project"})));
    assert_eq!(tool_refs("orgtree_project", &input, Some(&text)), json!([
        {"kind":"agent","id":"new-project"},{"kind":"agent","id":"manager"}]));
}

#[test]
fn timed_watchdog_create_keeps_the_result_id() {
    let input = json!({"action":"create","name":"build-ready","kind":"file","target":"build.log"});
    let (text, _) = tool_result_text(&recorded_result(json!({"id":"worker/build-ready","status":"armed"})));
    assert_eq!(tool_refs("orgtree_watchdog", &input, Some(&text)),
        json!([{"kind":"watchdog","id":"worker/build-ready"}]));
}

fn settled_card(name: &str, input: Value, text: &str, card: Value) -> Value {
    // The production settlement helper receives the handler's ToolCard after
    // result text/refs are recorded. Timing never becomes the card's identity.
    let done = crate::tools::Done { text:text.into(), card:Some(card) };
    let (text, _) = tool_result_text(&json!([
        {"type":"text","text":done.text},{"type":"text","text":"execution time: 18.000ms"}]));
    let mut chip = json!({"name":name,"result":text,"refs":tool_refs(name,&input,Some(&text))});
    apply_tool_card(&mut chip, &done.card.unwrap());
    serde_json::from_str(&chip.to_string()).unwrap()
}

#[test]
fn timed_present_keeps_the_document_card_and_project() {
    let chip = settled_card("orgtree_present",json!({"project":"new-project"}),"Presented report",
        json!({"presentation":{"id":"doc-1","title":"Report","format":"markdown"}}));
    assert_eq!(chip["presentation"]["id"],"doc-1");
    assert_eq!(chip["refs"],json!([{"kind":"agent","id":"new-project"}]));
}

#[test]
fn timed_message_keeps_mail_ids_and_agent_links() {
    let card=json!({"mail":{"id":"mail-1","to":"worker"},"mails":[{"id":"mail-1","to":"worker"},{"id":"mail-2","to":"manager"}]});
    let chip = settled_card("orgtree_message",json!({"metadata":{"to":["worker","manager"]}}),"Sent to both",card.clone());
    assert_eq!(chip["mail"],card["mail"]);
    assert_eq!(chip["mails"],card["mails"]);
    assert_eq!(chip["refs"],json!([{"kind":"agent","id":"worker"},{"kind":"agent","id":"manager"}]));
}
