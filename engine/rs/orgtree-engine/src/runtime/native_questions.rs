//! Restored native questions use private, bounded request cards. Native scope
//! never grants a user audience: other agents send the same superior mail as ask.
use std::sync::Arc;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;
use crate::{domain::asks, engine::Engine, runtime::Caller};

#[derive(Clone, Copy)]
pub enum Harness { Claude, Codex, Muse, ClaudePlan }

struct Question { id: String, text: String, options: Vec<Value>, multi: bool, min: usize, max: usize }
pub struct Reply { pub answers: Vec<Vec<String>>, pub approved: bool, pub reason: String }

#[nolog] // Questions and responses can contain private user text.
impl Reply {
    fn declined(reason: impl Into<String>) -> Self { Self { answers: vec![], approved: false, reason: reason.into() } }
}

#[nolog]
fn questions(harness: Harness, params: &Value) -> Result<Vec<Question>> {
    if serde_json::to_vec(params)?.len() > 65_536 { bail!("Native question exceeds 64 KiB") }
    if matches!(harness, Harness::ClaudePlan) {
        let plan = params["plan"].as_str().unwrap_or("The CLI supplied no plan text.");
        if plan.len() > 32_000 { bail!("Plan exceeds the 32 KiB approval limit; present a shorter plan") }
        return Ok(vec![Question { id: "approval".into(), text: format!("Approve exiting native plan mode? This approves this plan only and grants no additional Orgtree permissions.\n\n{plan}"),
            options: vec![json!({"label":"Approve"}), json!({"label":"Reject"})], multi:false, min:1, max:1 }]);
    }
    let rows = params["questions"].as_array().filter(|a| !a.is_empty() && a.len() <= 4)
        .ok_or_else(|| anyhow!("Native questions require 1–4 questions"))?;
    let mut out: Vec<Question> = Vec::new();
    for (i, q) in rows.iter().enumerate() {
        let text = q["question"].as_str().filter(|s| !s.trim().is_empty() && s.len() <= 8_000)
            .ok_or_else(|| anyhow!("Native question text is missing or exceeds 8 KiB"))?;
        let id = q["id"].as_str().map(str::to_owned).unwrap_or_else(|| i.to_string());
        if id.len() > 128 || out.iter().any(|old| old.id == id) { bail!("Invalid or duplicate native question identity") }
        let options = q["options"].as_array().cloned().unwrap_or_default();
        if options.len() > 16 || options.iter().any(|o| !o["label"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 500)) {
            bail!("Native question options are missing labels or exceed the supported limits")
        }
        let multi = q["multiSelect"].as_bool().unwrap_or(false) || q["selection"]["mode"] == "multiple";
        let min = q["selection"]["minSelections"].as_u64().unwrap_or(1).max(1) as usize;
        let max = q["selection"]["maxSelections"].as_u64().unwrap_or(if multi {16} else {1}) as usize;
        if max < min || max > 16 { bail!("Invalid native selection bounds") }
        out.push(Question { id, text:text.into(), options, multi, min, max });
    }
    Ok(out)
}

#[nolog]
fn form(questions: &[Question], plan: bool) -> Value {
    let mut props = Map::new();
    for (i, q) in questions.iter().enumerate() {
        let key = format!("q{i}");
        if !q.options.is_empty() {
            let labels: Vec<_> = q.options.iter().map(|o| o["label"].clone()).collect();
            let description = q.options.iter().filter_map(|o| o["description"].as_str().map(|d| format!("{}: {d}", o["label"].as_str().unwrap_or(""))))
                .collect::<Vec<_>>().join("\n");
            let mut field = if q.multi { json!({"type":"array","items":{"type":"string","enum":labels},"minItems":q.min,"maxItems":q.max}) }
                else { json!({"type":"string","enum":labels}) };
            field["title"] = json!(q.text); field["description"] = json!(description);
            props.insert(key.clone(), field);
        }
        if !plan {
            props.insert(format!("{key}_text"), json!({"type":"string","maxLength":500,
                "title":if q.options.is_empty() {q.text.clone()} else {"Or answer in your own words".into()}}));
        }
    }
    json!({"type":"object","properties":props,"additionalProperties":false})
}

/// Pure routing decision is shared with the focused authority controls.
#[nolog]
fn destination(enabled: bool, may_ask_user: bool, superior: Option<&str>) -> Result<bool> {
    if !enabled { bail!("Disabled by Orgtree is off for this agent") }
    if may_ask_user { return Ok(true) }
    if superior.is_some() { return Ok(false) }
    bail!("This agent cannot ask the user and has no superior")
}

#[nolog]
fn may_exit_plan(scope: &Value) -> bool { scope["permission_mode"] != "plan" }

#[nolog]
async fn authorized(engine: &Engine, caller: &Caller, plan: bool) -> Result<asks::Asker> {
    let held = asks::held_scope(engine, caller.org_id, caller.agent_id).await?;
    if plan && !may_exit_plan(&held) { bail!("Orgtree plan-only scope cannot exit plan mode; ask your superior to change its permission mode") }
    let asker = asks::asker(engine, caller.org_id, caller.agent_id).await?;
    destination(held["tools"]["orgtree_disabled"] == true, asker.may_ask_user, asker.superior.as_deref())?;
    Ok(asker)
}

#[nolog]
pub async fn request(engine: &Arc<Engine>, caller: &Caller, harness: Harness, params: &Value,
    process: uuid::Uuid, stop: &CancellationToken) -> Reply {
    match request_inner(engine, caller, harness, params, process, stop).await {
        Ok(reply) => reply,
        Err(error) => Reply::declined(format!("Native question refused: {error}. Use orgtree_ask or contact your superior.")),
    }
}

#[nolog]
async fn request_inner(engine: &Arc<Engine>, caller: &Caller, harness: Harness, params: &Value,
    process: uuid::Uuid, stop: &CancellationToken) -> Result<Reply> {
    if stop.is_cancelled() || engine.shutdown.is_cancelled() { return Ok(Reply::declined("Native question cancelled because the process stopped")) }
    let plan = matches!(harness, Harness::ClaudePlan);
    let asker = authorized(engine, caller, plan).await?;
    let qs = questions(harness, params)?;
    if !asker.may_ask_user {
        let org = engine.orgs.get(&caller.org_slug).ok_or_else(|| anyhow!("Organization unavailable"))?;
        let forwarded: Vec<_> = qs.iter().map(|q| json!({"question":format!("{}\n{}", q.text,
            q.options.iter().map(|o| format!("- {}",o["label"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))})).collect();
        let receipt = asks::ask(engine, &org, &asker, &json!({"questions":forwarded})).await?;
        return Ok(Reply::declined(format!("{receipt} No native approval was granted; the answer will arrive as mail.")))
    }
    let title = match harness { Harness::Claude => "Claude Code question", Harness::ClaudePlan => "Claude Code plan approval",
        Harness::Codex => "Codex question", Harness::Muse => "Muse question" };
    let args = json!({"serverName":title,"threadId":process.to_string(),"message":"Answer this native tool request. Other Orgtree permissions still apply.",
        "requestedSchema":form(&qs, plan)});
    let response = super::elicitation::native_request(engine, caller, &args, stop).await;
    if response["action"] != "accept" { return Ok(Reply::declined("Native question declined, cancelled or expired after five minutes")) }
    // Recheck a revoked scope/audience or replacement generation before replying.
    let current = authorized(engine, caller, plan).await?;
    if current.generation != asker.generation || !current.may_ask_user { bail!("Native question authorization changed") }
    let mut answers = Vec::new();
    for i in 0..qs.len() {
        let content = &response["content"];
        let values = if let Some(s) = content[format!("q{i}_text")].as_str().filter(|s| !s.trim().is_empty()) {
            vec![s.to_string()]
        } else { match &content[format!("q{i}")] {
            Value::String(s) => vec![s.clone()], Value::Array(a) => a.iter().filter_map(|s|s.as_str().map(str::to_owned)).collect(), _ => vec![],
        }};
        if values.is_empty() { return Ok(Reply::declined("Native question was submitted without an answer")) }
        answers.push(values);
    }
    let approved = !plan || answers.first().is_some_and(|a| a == &["Approve"]);
    Ok(Reply { answers, approved, reason:if approved {"Native request answered"} else {"The user rejected the plan"}.into() })
}

#[nolog]
pub fn codex_response(params: &Value, reply: &Reply) -> Value {
    let mut answers = Map::new();
    for (i, q) in params["questions"].as_array().into_iter().flatten().enumerate() {
        if let Some(id) = q["id"].as_str() {
            answers.insert(id.into(), json!({"answers":reply.answers.get(i).cloned().unwrap_or_else(||vec![reply.reason.clone()])}));
        }
    }
    json!({"answers":answers})
}

#[nolog]
pub fn claude_response(input: &Value, plan: bool, reply: &Reply) -> Value {
    if !reply.approved { return json!({"behavior":"deny","message":reply.reason}) }
    let mut updated = input.clone();
    if plan { if let Some(o) = updated.as_object_mut() { o.remove("allowedPrompts"); } }
    else {
        let mut answers = Map::new();
        for (i, q) in input["questions"].as_array().into_iter().flatten().enumerate() {
            if let Some(text) = q["question"].as_str() { answers.insert(text.into(), json!(reply.answers[i].join(", "))); }
        }
        updated["answers"] = Value::Object(answers);
    }
    json!({"behavior":"allow","updatedInput":updated})
}

/// Muse's offline-exported MSP 1 schema: answer all questions, or cancel with
/// an explicit reason. Never send an unrecognized guessed answer command.
#[nolog]
pub fn muse_command(params: &Value, reply: &Reply) -> (&'static str, Value) {
    let mut out = json!({"commandId":super::muse::uuid7(),"sessionId":params["sessionId"],"userInputId":params["userInputId"]});
    if !reply.approved { out["reason"] = json!(reply.reason); return ("userInput/cancel",out) }
    let mut answers = Vec::new();
    for (i, q) in params["questions"].as_array().into_iter().flatten().enumerate() {
        let mut a = json!({"questionId":q["id"]});
        let values = &reply.answers[i];
        let offered = |s: &String| q["options"].as_array().is_some_and(|opts| opts.iter().any(|o| o["label"].as_str() == Some(s)));
        if values.iter().all(offered) {
            if q["selection"]["mode"] == "multiple" { a["selectedLabels"] = json!(values); }
            else { a["selectedLabel"] = json!(values[0]); }
        } else { a["freeText"] = json!(values.join(", ")); }
        answers.push(a);
    }
    out["answers"] = json!(answers); ("userInput/answer",out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_tools_plan_approval_never_exits_an_orgtree_plan_only_scope() {
        assert!(!may_exit_plan(&json!({"permission_mode":"plan"})));
        assert!(may_exit_plan(&json!({"permission_mode":"default"})));
        assert!(may_exit_plan(&json!({"permission_mode":"acceptEdits"})));
        assert!(may_exit_plan(&json!({"permission_mode":"bypassPermissions"})));
    }
    #[test]
    fn native_tools_question_routing_obeys_the_flag_and_the_normal_ask_destination() {
        assert!(destination(false,true,None).is_err());
        assert!(destination(false,false,Some("superior")).is_err());
        assert_eq!(destination(true,true,None).unwrap(),true);
        assert_eq!(destination(true,true,Some("superior")).unwrap(),true);
        assert_eq!(destination(true,false,Some("superior")).unwrap(),false);
        assert!(destination(true,false,None).is_err());
    }
    #[test]
    fn native_tools_refusal_never_approves_a_plan_and_answers_preserve_native_ids() {
        let params=json!({"sessionId":"session-original","userInputId":"input-original",
            "questions":[{"id":"original","question":"Choose","selection":{"mode":"single"},"options":[{"label":"A"}]}]});
        let no=Reply::declined("expired");
        assert_eq!(codex_response(&params,&no)["answers"]["original"]["answers"],json!(["expired"]));
        assert_eq!(claude_response(&json!({"allowedPrompts":["anything"]}),true,&no)["behavior"],"deny");
        let yes=Reply {answers:vec![vec!["A".into()]],approved:true,reason:String::new()};
        assert_eq!(codex_response(&params,&yes)["answers"]["original"]["answers"],json!(["A"]));
        assert_eq!(claude_response(&params,false,&yes)["updatedInput"]["answers"]["Choose"],"A");
        assert!(claude_response(&json!({"allowedPrompts":["anything"]}),true,&yes)["updatedInput"].get("allowedPrompts").is_none());
        let (method,body)=muse_command(&params,&yes);
        assert_eq!(method,"userInput/answer");
        assert_eq!(body["sessionId"],"session-original");
        assert_eq!(body["userInputId"],"input-original");
        assert_eq!(body["answers"][0]["questionId"],"original");
        assert_eq!(body["answers"][0]["selectedLabel"],"A");
        assert_eq!(muse_command(&params,&no).0,"userInput/cancel");
    }
    #[test]
    fn native_tools_schema_keeps_multi_select_bounds_and_rejects_duplicate_ids() {
        let params=json!({"questions":[{"id":"q","question":"Choose","options":[{"label":"A"},{"label":"B"}],
            "selection":{"mode":"multiple","minSelections":1,"maxSelections":2}}]});
        let qs=questions(Harness::Muse,&params).unwrap();
        assert_eq!(form(&qs,false)["properties"]["q0"]["maxItems"],2);
        let mut duplicate=params.clone(); duplicate["questions"].as_array_mut().unwrap().push(params["questions"][0].clone());
        assert!(questions(Harness::Muse,&duplicate).is_err());
    }
}
