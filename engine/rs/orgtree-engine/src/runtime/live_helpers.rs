//! Bounded, actor-owned first-level helper identities. Never a native file reader.
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Helpers {
    items: BTreeMap<String, Value>,
    truncated: bool,
}

#[nolog]
impl Helpers {
    fn put(&mut self, key: String, mut item: Value) {
        if let Some(old)=self.items.get(&key) {
            for field in ["started_at","seq","tool","task_id"] {
                if !old[field].is_null() && (field=="started_at" || item[field].is_null()) {item[field]=old[field].clone();}
            }
            for field in ["description","kind","model"] {
                if item[field].is_null() || item[field]=="" {item[field]=old[field].clone();}
            }
        } else if self.items.len()>=64 {
            if let Some(ended)=self.items.iter().find(|(_,v)|v["live"]!=true).map(|(k,_)|k.clone()) {self.items.remove(&ended);}
            else {self.truncated=true;return;}
        }
        item["id"]=json!(key);self.items.insert(key,item);
    }
    pub fn claude(&mut self, v: &Value, at: &str) {
        if v.get("parent_tool_use_id").is_some_and(|p|!p.is_null()) {return;}
        match v["type"].as_str().unwrap_or("") {
            "assistant"=>for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if b["type"]!="tool_use" || !matches!(b["name"].as_str(),Some("Agent"|"Task")) {continue;}
                let Some(tool)=id(&b["id"]) else {continue};let input=&b["input"];
                self.put(format!("claude:{tool}"),json!({"harness":"claude","tool":tool,"kind":text(&input["subagent_type"],80),
                    "description":text(&input["description"],400),"model":text(&input["model"],120),"started_at":at,"start_source":"observed",
                    "status":"running","live":true,"background":input["run_in_background"]==true,"transcript":true}));
            },
            "user"=>for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if b["type"]!="tool_result" {continue;}
                if let Some(tool)=id(&b["tool_use_id"]) {if let Some(item)=self.items.get_mut(&format!("claude:{tool}")) {
                    // A background launch reply is not the child's completion.
                    if item["background"]!=true {item["live"]=json!(false);item["status"]=json!(if b["is_error"]==true {"failed"} else {"completed"});}
                }}
            },
            "system"=>{
                let sub=v["subtype"].as_str().unwrap_or("");
                let rows:Vec<&Value>=if sub=="background_tasks_changed" {v["tasks"].as_array().into_iter().flatten().collect()} else {vec![v]};
                let mut present=std::collections::HashSet::new();
                for row in rows {
                    let Some(task)=id(&row["task_id"]) else {continue};
                    let existing=self.items.iter().find(|(_,i)|i["harness"]=="claude" && i["task_id"]==task).map(|(k,_)|k.clone());
                    let key=existing.or_else(||id(&row["tool_use_id"]).map(|t|format!("claude:{t}")));
                    let Some(key)=key else {continue};
                    // Only a known Agent/Task call can own a background identity.
                    // Native background snapshots also contain ordinary shell jobs.
                    let Some(item)=self.items.get_mut(&key) else {continue};
                    item["task_id"]=json!(task);present.insert(key);
                    if sub=="task_notification" {
                        if let Some(status)=row["status"].as_str().filter(|s|matches!(*s,"completed"|"failed"|"stopped"|"cancelled"|"killed")) {
                            item["live"]=json!(false);item["status"]=json!(status);
                        }
                    } else if sub=="task_started" || sub=="background_tasks_changed" {
                        item["background"]=json!(sub=="background_tasks_changed" || item["background"]==true || row["is_background"]==true);
                        item["status"]=json!("running");item["live"]=json!(true);
                    }
                }
                if sub=="background_tasks_changed" && v["tasks"].is_array() {
                    for (key,item) in &mut self.items {if item["harness"]=="claude" && item["background"]==true && !item["task_id"].is_null() && !present.contains(key) {
                        item["live"]=json!(false);item["status"]=json!("ended");
                    }}
                }
            },
            "result"=>self.finish_turn(),
            _=>{}
        }
    }
    pub fn codex(&mut self, item: &Value, at: &str) {
        if item["type"]!="collabAgentToolCall" {return;}
        let states=item["agentsStates"].as_object();
        let receivers:Vec<String>=item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(id)
            .chain(states.into_iter().flat_map(|m|m.keys().filter(|k|k.len()<=160).cloned())).collect();
        for child in receivers {
            let key=format!("codex:{child}");let native=states.and_then(|m|m.get(&child));
            let status=native.and_then(|v|v["status"].as_str()).unwrap_or("unknown");
            if status=="unknown" && self.items.contains_key(&key) {continue;}
            self.put(key,json!({"harness":"codex","child_id":child,"tool":text(&item["id"],160),"kind":"Helper agent",
                "description":text(&item["prompt"],400),"model":text(&item["model"],120),"started_at":at,"start_source":"observed",
                "status":status,"live":status=="running","background":true,"transcript":false}));
        }
    }
    pub fn muse(&mut self, item: &Value, done: bool, at: &str) {
        if item["kind"]!="subagent" {return;}let Some(child)=id(&item["subagentId"]) else {return};
        let status=item["status"].as_str().unwrap_or(if done {"ended"} else {"unknown"});
        self.put(format!("muse:{child}"),json!({"harness":"muse","child_id":child,"tool":text(&item["itemId"],160),
            "kind":text(&item["role"],80),"description":text(&item["objective"],400),"model":text(&item["model"],120),
            "started_at":at,"start_source":"observed","status":status,"live":!done && status=="inProgress","transcript":false}));
    }
    pub fn link(&mut self, tool: &str, seq: i64) {
        for item in self.items.values_mut() {if item["tool"]==tool {item["seq"]=json!(seq);}}
    }
    pub fn finish_turn(&mut self) {
        for item in self.items.values_mut() {if item["background"]!=true && item["live"]==true {
            item["live"]=json!(false);item["status"]=json!("unknown after parent turn");
        }}
    }
    pub fn clear(&mut self) {*self=Self::default();}
    pub fn view(&self) -> Value {
        json!({"count":self.count(),"items":self.items.values().collect::<Vec<_>>(),"truncated":self.truncated})
    }
    pub fn count(&self) -> usize {self.items.values().filter(|v|v["live"]==true).count()}
}

#[nolog]
fn id(value: &Value) -> Option<String> {
    value.as_str().filter(|s|!s.is_empty() && s.len()<=160 && !s.contains('\0')).map(str::to_owned)
}
#[nolog]
fn text(value: &Value, cap: usize) -> Value {
    value.as_str().map(|s|json!(s.chars().filter(|c|*c!='\0').take(cap).collect::<String>())).unwrap_or(Value::Null)
}

/// Callers authenticate/authorize the parent agent before entering here. Never
/// accepts a child session or filesystem path, and never starts an actor/CLI.
#[nolog]
pub fn list(engine: &crate::engine::Engine, agent: i64) -> Value {
    engine.agents.get(agent).map(|h|h.helpers.load().as_ref().clone())
        .unwrap_or_else(||json!({"count":0,"items":[],"truncated":false}))
}

#[nolog]
pub async fn transcript(engine: &crate::engine::Engine, agent: i64, seq: i64, tool: &str) -> anyhow::Result<Value> {
    if seq<1 || id(&json!(tool)).is_none() {crate::refuse!(BadRequest,"helper requires a positive seq and a retained tool ID");}
    let client=engine.db.get().await?;
    let row=client.query_opt("SELECT body, tool_inputs -> $3::text -> 'helper_transcript' FROM ot.convo WHERE agent_id = $1 AND seq = $2",&[&agent,&seq,&tool]).await?
        .ok_or_else(||crate::domain::user_err(crate::domain::UserError::NotFound,"That tool call is not retained."))?;
    let body:Value=row.get(0);
    let chip=body["tools"].as_array().into_iter().flatten().find(|c|c["id"].as_str()==Some(tool))
        .ok_or_else(||crate::domain::user_err(crate::domain::UserError::NotFound,"That tool call is not retained."))?;
    let live=chip.get("result").is_none() && chip.get("error").is_none() && chip.get("ended_at").is_none()
        && engine.agents.get(agent).is_some_and(|h| {
            let runtime=h.view.load();
            let call=chip["started_at"].as_str().and_then(crate::util::parse_ts);
            let turn=runtime["turn_started_at"].as_str().and_then(crate::util::parse_ts);
            runtime["busy"]==true && call.zip(turn).is_some_and(|(call,turn)|call>=turn)
        });
    let Some(mut snapshot)=row.get::<_,Option<Value>>(1) else {
        let waiting=live && chip["helper_transcript"]==true;
        return Ok(json!({"messages":[],"live":waiting,"note":if waiting {"Waiting for helper transcript records…"} else {
            "A helper transcript was not retained for this call. New Claude Code helpers are captured during their parent's turn; a transcript is not available for this harness or older call."
        }}));
    };
    super::helper_transcript::redact_snapshot(&mut snapshot);snapshot["live"]=json!(live);Ok(snapshot)
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
