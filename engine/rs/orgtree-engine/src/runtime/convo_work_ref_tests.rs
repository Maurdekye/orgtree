use super::{
    apply_tool_card, redact_tool_input, restore_result_refs, take_tool_inputs,
    tool_arg, tool_file_paths, tool_refs, tool_result_text, CREDENTIALS_HIDDEN,
};
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
        let (old_result, _) = tool_result_text(&recorded_result(body));
        let mut saved = vec![json!({"tools":[{"id":"saved-create","name":"mcp__orgtree__orgtree_work",
            "arg":"create","input_seq":7,"result":old_result,"refs":[{"kind":"agent","id":"worker"}]}]})];
        restore_result_refs(&mut saved);
        chips.push(saved[0]["tools"][0].clone());
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

#[test]
fn saved_timed_create_rows_regain_the_missing_ticket_without_inputs_or_rewrites() {
    let (text, _) = tool_result_text(&recorded_result(json!({"created":"restore-ticket-cards","slug":"restore-ticket-cards","rev":1})));
    let mut rows = vec![json!({"role":"assistant","tools":[{"id":"old-create","name":"mcp__orgtree__orgtree_work",
        "arg":"create","input_seq":7,"result":text,"refs":[{"kind":"agent","id":"worker"}]}]})];
    restore_result_refs(&mut rows);
    assert_eq!(rows[0]["tools"][0]["refs"],json!([
        {"kind":"agent","id":"worker"},{"kind":"ticket","id":"restore-ticket-cards"}]));
    let once = rows.clone();
    restore_result_refs(&mut rows);
    assert_eq!(rows,once,"page projection is idempotent and retains original tool text");
}

#[test]
fn saved_ref_repair_preserves_recorded_changes_and_does_not_repair_failed_calls() {
    let input=json!({"action":"update","slug":"restore-ticket-cards"});
    let (text, _) = tool_result_text(&recorded_result(json!({"updated":"restore-ticket-cards","previous_status":"open","status":"done"})));
    let original=json!({"kind":"ticket","id":"restore-ticket-cards","status_change":{"from":"blocked","to":"done"}});
    let mut rows=vec![json!({"tools":[
        {"name":"orgtree_work","input":input,"result":text,"refs":[original.clone()]},
        {"name":"orgtree_work","input":input,"result":text,"error":"refused","refs":[]}
    ]})];
    restore_result_refs(&mut rows);
    assert_eq!(rows[0]["tools"][0]["refs"],json!([original]));
    assert_eq!(rows[0]["tools"][1]["refs"],json!([]));
}

#[test]
fn agy_call_mcp_tool_unwraps_into_canonical_orgtree_tool_refs_and_args() {
    let work_call = json!({
        "ServerName": "orgtree_orgtree",
        "ToolName": "orgtree_work",
        "Arguments": {
            "action": "update",
            "slug": "antigravity-transcripts-lack-inline-tool-call-an",
            "owner": "mentions-argon",
            "status": "in_progress"
        }
    });
    let envelope = json!({
        "content": recorded_result(json!({
            "updated": "antigravity-transcripts-lack-inline-tool-call-an",
            "previous_status": "open",
            "status": "in_progress",
            "rev": 6
        }))
    }).to_string();
    assert_eq!(
        tool_refs("default_api:call_mcp_tool", &work_call, Some(&envelope)),
        json!([
            {"kind": "agent", "id": "mentions-argon"},
            {
                "kind": "ticket",
                "id": "antigravity-transcripts-lack-inline-tool-call-an",
                "status_change": {"from": "open", "to": "in_progress"}
            }
        ])
    );

    let wd_call = json!({
        "ServerName": "orgtree_orgtree",
        "ToolName": "orgtree_watchdog",
        "Arguments": {
            "action": "create",
            "kind": "slot",
            "target": "build-slot",
            "name": "agy-ref-test"
        }
    });
    let wd_envelope = json!({
        "content": recorded_result(json!({"id": "mentions-argon-agy-ref-test", "status": "armed"}))
    }).to_string();
    assert_eq!(
        tool_refs("default_api:call_mcp_tool", &wd_call, Some(&wd_envelope)),
        json!([{"kind": "watchdog", "id": "mentions-argon-agy-ref-test"}])
    );
    assert_eq!(tool_arg("default_api:call_mcp_tool", &wd_call), "agy-ref-test");

    let msg_call = json!({
        "ServerName": "orgtree_orgtree",
        "ToolName": "orgtree_message",
        "Arguments": {
            "metadata": {"to": ["coordinator-opus", "@net:maurdekye.77ded7"]},
            "body": "Completed AGY tool chip annotations"
        }
    });
    assert_eq!(
        tool_refs("default_api:call_mcp_tool", &msg_call, None),
        json!([
            {"kind": "agent", "id": "coordinator-opus"},
            {"kind": "hub", "id": "@net:maurdekye.77ded7"}
        ])
    );
    assert_eq!(tool_arg("default_api:call_mcp_tool", &msg_call), "Completed AGY tool chip annotations");
}

#[test]
fn agy_native_tools_extract_file_paths_and_command_args() {
    for tool in ["default_api:read_file", "default_api:write_file", "default_api:edit_file", "read_file", "write_file", "edit_file"] {
        let input = json!({
            "Path": "D:/orgtree-work/worktrees/mentions-argon-mentions/engine/rs/orgtree-engine/src/runtime/convo.rs",
            "StartLine": 1,
            "EndLine": 80
        });
        let paths = tool_file_paths(tool, &input).expect(tool);
        assert_eq!(
            paths,
            json!([{
                "path": "D:\\orgtree-work\\worktrees\\mentions-argon-mentions\\engine\\rs\\orgtree-engine\\src\\runtime\\convo.rs",
                "link": true
            }])
        );
        assert_eq!(
            tool_arg(tool, &input),
            "D:/orgtree-work/worktrees/mentions-argon-mentions/engine/rs/orgtree-engine/src/runtime/con"
        );
    }

    let cmd_input = json!({
        "CommandLine": "git status --short",
        "toolSummary": "Git status check",
        "WaitMsBeforeAsync": 5000
    });
    assert_eq!(tool_arg("default_api:run_command", &cmd_input), "Git status check");
    assert_eq!(
        tool_arg("default_api:run_command", &json!({"CommandLine": "cargo test -j1"})),
        "cargo test -j1"
    );
    assert!(tool_file_paths("default_api:run_command", &json!({"CommandLine": "cat C:/secret.txt"})).is_none());
}

#[test]
fn agy_watchdog_credentials_redact_inside_call_mcp_tool_and_take_tool_inputs_unwraps() {
    let mut wrapped = json!({
        "ServerName": "orgtree_orgtree",
        "ToolName": "orgtree_watchdog",
        "Arguments": {
            "action": "create",
            "kind": "mqtt",
            "target": "mqtts://alice:topsecret@broker.example.com/topic",
            "credentials": {"username": "alice", "password": "topsecret"},
            "password": "topsecret"
        }
    });
    redact_tool_input("default_api:call_mcp_tool", &mut wrapped);
    assert_eq!(wrapped["Arguments"]["password"], "[redacted]");
    assert_eq!(wrapped["Arguments"]["credentials"], CREDENTIALS_HIDDEN);
    assert!(!wrapped.to_string().contains("topsecret"));

    let mut row = json!({
        "tools": [
            {
                "id": "agy-step-1",
                "name": "default_api:read_file",
                "arg": "",
                "input": {"Path": "D:/orgtree-work/src/convo.rs", "StartLine": 1}
            },
            {
                "id": "agy-step-2",
                "name": "default_api:call_mcp_tool",
                "arg": "orgtree_orgtree",
                "input": {
                    "ServerName": "orgtree_orgtree",
                    "ToolName": "orgtree_work",
                    "Arguments": {"action": "get", "slug": "antigravity-transcripts-lack-inline-tool-call-an"}
                },
                "refs": []
            }
        ]
    });
    let retained = take_tool_inputs(&mut row, 42);
    assert_eq!(row["tools"][0]["name"], "read_file");
    assert_eq!(row["tools"][0]["arg"], "D:/orgtree-work/src/convo.rs");
    assert_eq!(row["tools"][0]["file_paths"], json!([{"path": "D:\\orgtree-work\\src\\convo.rs", "link": true}]));
    assert!(row["tools"][0].get("input").is_none());

    assert_eq!(row["tools"][1]["name"], "mcp__orgtree__orgtree_work");
    assert_eq!(row["tools"][1]["arg"], "get");
    assert_eq!(
        row["tools"][1]["refs"],
        json!([{"kind": "ticket", "id": "antigravity-transcripts-lack-inline-tool-call-an"}])
    );
    assert_eq!(
        retained["agy-step-2"]["input"],
        json!({"action": "get", "slug": "antigravity-transcripts-lack-inline-tool-call-an"})
    );
}

#[test]
fn restore_result_refs_repairs_agy_wrapped_chips_and_preserves_non_agy_inputs() {
    let mut rows = vec![json!({
        "role": "assistant",
        "tools": [
            {
                "id": "agy-step-3",
                "name": "default_api:read_file",
                "arg": "",
                "input": {"Path": "D:/orgtree-work/src/main.rs"},
                "result": "1: fn main() {}",
                "refs": []
            },
            {
                "id": "agy-step-4",
                "name": "default_api:call_mcp_tool",
                "arg": "orgtree_orgtree",
                "input": {
                    "ServerName": "orgtree_orgtree",
                    "ToolName": "orgtree_watchdog",
                    "Arguments": {"action": "create", "kind": "slot", "target": "build-slot", "name": "slot-dog"}
                },
                "result": json!({"content": recorded_result(json!({"id": "mentions-argon-slot"}))}).to_string(),
                "refs": []
            }
        ]
    })];
    restore_result_refs(&mut rows);
    let file_chip = &rows[0]["tools"][0];
    assert_eq!(file_chip["name"], "read_file");
    assert_eq!(file_chip["arg"], "D:/orgtree-work/src/main.rs");
    assert_eq!(file_chip["file_paths"], json!([{"path": "D:\\orgtree-work\\src\\main.rs", "link": true}]));

    let mcp_chip = &rows[0]["tools"][1];
    assert_eq!(mcp_chip["name"], "mcp__orgtree__orgtree_watchdog");
    assert_eq!(mcp_chip["arg"], "slot-dog");
    assert_eq!(mcp_chip["refs"], json!([{"kind": "watchdog", "id": "mentions-argon-slot"}]));

    // Non-AGY tool inputs containing a `tool` key stay byte-identical through take_tool_inputs.
    let mut ordinary_row = json!({
        "tools": [{
            "id": "call-ordinary",
            "name": "mcp__search__query",
            "arg": "keep me",
            "input": {"tool": "search", "query": "keep me"}
        }]
    });
    let retained = take_tool_inputs(&mut ordinary_row, 99);
    assert_eq!(retained["call-ordinary"]["input"], json!({"tool": "search", "query": "keep me"}));
}
