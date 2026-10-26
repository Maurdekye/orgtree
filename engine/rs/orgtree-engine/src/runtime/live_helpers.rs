//! Bounded, actor-owned first-level helper identities. Never a native file reader.
use serde_json::{json, Value};

#[derive(Default)]
pub struct Helpers;

#[nolog]
impl Helpers {
    pub fn claude(&mut self, _event: &Value, _at: &str) {}
    pub fn codex(&mut self, _item: &Value, _at: &str) {}
    pub fn muse(&mut self, _item: &Value, _done: bool, _at: &str) {}
    pub fn link(&mut self, _tool: &str, _seq: i64) {}
    pub fn finish_turn(&mut self) {}
    pub fn clear(&mut self) {}
    pub fn view(&self) -> Value { json!({"count":0,"items":[],"truncated":false}) }
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: &str = "2026-10-26T10:00:00Z";
    fn call(id: &str, background: bool) -> Value {
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Agent",
            "input":{"description":"Inspect widgets","subagent_type":"Explore","model":"small","run_in_background":background}}]}})
    }
    #[test]
    fn live_helpers_claude_details_and_private_locator() {
        let mut h=Helpers::default();h.claude(&call("a",false),AT);h.link("a",7);
        let v=h.view();assert_eq!(v["count"],1);let a=&v["items"][0];
        assert_eq!(a["description"],"Inspect widgets");assert_eq!(a["model"],"small");
        assert_eq!(a["kind"],"Explore");assert_eq!(a["started_at"],AT);assert_eq!(a["seq"],7);
        assert_eq!(a["transcript"],true);
    }
    #[test]
    fn live_helpers_result_ends_foreground_but_not_background_launch() {
        let mut h=Helpers::default();h.claude(&call("a",false),AT);h.claude(&call("b",true),AT);
        for id in ["a","b"] { h.claude(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"Async agent launched successfully"}]}}),AT); }
        assert_eq!(h.view()["count"],1);
        h.claude(&json!({"type":"system","subtype":"task_started","task_id":"btask","tool_use_id":"b","task_type":"local_agent"}),AT);
        h.claude(&json!({"type":"system","subtype":"task_notification","task_id":"btask","status":"completed"}),AT);
        assert_eq!(h.view()["count"],0);
    }
    #[test]
    fn live_helpers_no_shell_or_nested_helpers_and_no_double_count() {
        let mut h=Helpers::default();let mut nested=call("nested",false);nested["parent_tool_use_id"]=json!("outer");h.claude(&nested,AT);
        h.claude(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"shell","task_type":"local_bash"}]}),AT);
        assert_eq!(h.view()["count"],0);
        h.claude(&call("a",true),AT);
        h.claude(&json!({"type":"system","subtype":"task_started","task_id":"bg","tool_use_id":"a","task_type":"local_agent"}),AT);
        h.claude(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bg","task_type":"local_agent","tool_use_id":"a"}]}),AT);
        assert_eq!(h.view()["count"],1);
    }
    #[test]
    fn live_helpers_codex_native_running_survives_spawn_tool_completion() {
        let mut h=Helpers::default();h.codex(&json!({"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed",
            "model":"codex","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"running"}}}),AT);
        assert_eq!(h.view()["count"],1);assert_eq!(h.view()["items"][0]["transcript"],false);
        h.codex(&json!({"id":"wait","type":"collabAgentToolCall","tool":"wait","agentsStates":{"child":{"status":"completed"}}}),AT);
        assert_eq!(h.view()["count"],0);
    }
    #[test]
    fn live_helpers_codex_missing_state_is_not_invented() {
        let mut h=Helpers::default();h.codex(&json!({"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","receiverThreadIds":["child"]}),AT);
        assert_eq!(h.view()["count"],0);
    }
    #[test]
    fn live_helpers_muse_explicit_item_lifecycle() {
        let mut h=Helpers::default();let mut item=json!({"kind":"subagent","itemId":"item","subagentId":"sub","role":"research","objective":"Review widgets","status":"inProgress"});
        h.muse(&item,false,AT);assert_eq!(h.view()["count"],1);assert_eq!(h.view()["items"][0]["kind"],"research");
        item["status"]=json!("completed");h.muse(&item,true,AT);assert_eq!(h.view()["count"],0);
    }
    #[test]
    fn live_helpers_terminal_turn_and_process_cleanup() {
        let mut h=Helpers::default();h.claude(&call("a",false),AT);h.claude(&call("b",true),AT);
        h.finish_turn();assert_eq!(h.view()["count"],1);h.clear();assert_eq!(h.view()["count"],0);
    }
    #[test]
    fn live_helpers_bounded_metadata_and_honest_unknown_model() {
        let mut h=Helpers::default();for i in 0..70 {let mut c=call(&i.to_string(),false);c["message"]["content"][0]["input"].as_object_mut().unwrap().remove("model");h.claude(&c,AT);}
        let v=h.view();assert!(v["items"].as_array().unwrap().len()<=64);assert_eq!(v["truncated"],true);assert!(v["items"][0]["model"].is_null());
    }
}
