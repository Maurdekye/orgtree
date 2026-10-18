//! Native normal compaction: one strict descendant, never a cheap fallback.
use std::{future::Future, sync::Arc};
use anyhow::Result;
use serde_json::{json, Value};
use super::{caller_tools, control::ask_actor, downward, me, need_str, target, Done, Target};
use crate::{engine::Engine, runtime::{AgentMsg, Caller}};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Action { Capability, Compact }

#[nolog]
fn action(args: &Value) -> Result<Action> {
    match args.get("action") {
        None => Ok(Action::Compact),
        Some(Value::String(s)) if s == "compact" => Ok(Action::Compact),
        Some(Value::String(s)) if s == "capability" => Ok(Action::Capability),
        _ => crate::refuse!(BadRequest, "action must be capability or compact"),
    }
}

/// Recheck identity, inherited team scope and hierarchy at actor admission too.
/// No transaction or pooled connection spans a wait on the actor/native process.
#[logged]
pub(crate) async fn authorize_id(engine: &Arc<Engine>, caller: &Caller, id: i64) -> Result<Target> {
    let tools = caller_tools(engine, caller).await?;
    if !crate::domain::tool_groups::allows(&tools, "orgtree_compact") {
        crate::refuse!(Forbidden, "orgtree_compact is disabled by your Orgtree tool group scope");
    }
    let client = engine.db.get().await?;
    let who = me(&client, caller).await?;
    let row = client.query_opt(
        "SELECT id,name,state,parent_id,kind FROM ot.agents WHERE id=$1 AND org_id=$2 AND state <> 'deleted'",
        &[&id, &who.org_id]).await?;
    let Some(row) = row else { crate::refuse!(NotFound, "no such agent in this organization"); };
    let t = Target { id: row.get(0), name: row.get(1), state: row.get(2), parent_id: row.get(3) };
    let kind: String = row.get(4);
    if kind == crate::domain::projects::KIND {
        crate::refuse!(BadRequest, "{} is a project, not an agent; normal compaction requires an agent", t.name);
    }
    downward(&client, &who, &t, "compact").await?;
    Ok(t)
}

#[nolog]
fn response(node: &str, capability: &Value, admission: &Value) -> Value {
    let supported = admission["supported"].as_bool()
        .unwrap_or_else(|| capability["supported"].as_bool().unwrap_or(false));
    let started = supported && admission["started"].as_bool().unwrap_or(false);
    let reason = admission["reason"].as_str().or(admission["error"].as_str())
        .or(capability["reason"].as_str());
    json!({ "node": node, "supported": supported, "started": started, "reason": reason })
}

/// The capability and unsupported branches never evaluate the admission closure.
#[logged]
async fn execute<F, Fut>(which: Action, node: &str, cap: Value, admit: F) -> Value
where F: FnOnce() -> Fut, Fut: Future<Output = Value> {
    if which == Action::Capability || cap["supported"] != true {
        return response(node, &cap, &Value::Null);
    }
    response(node, &cap, &admit().await)
}

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let which = action(args)?;
    let node = need_str(args, "node")?;
    let client = engine.db.get().await?;
    let t = target(&client, caller.org_id, node).await?;
    drop(client);
    let t = authorize_id(engine, caller, t.id).await?;
    let cap = crate::domain::compaction::node_capability(engine, t.id).await?;
    let result = execute(which, &t.name, cap, || ask_actor(engine, caller.org_id, t.id,
        |reply| AgentMsg::CompactFromAgent { caller: caller.clone(), reply })).await;
    Done::json(&result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_compact_action_defaults_and_rejects_invalid_values() {
        assert_eq!(action(&json!({})).unwrap(), Action::Compact);
        assert_eq!(action(&json!({"action":"compact"})).unwrap(), Action::Compact);
        assert_eq!(action(&json!({"action":"capability"})).unwrap(), Action::Capability);
        for invalid in [json!(null), json!(false), json!("cheap"), json!("all")] {
            assert!(action(&json!({"action":invalid})).is_err());
        }
    }

    #[tokio::test]
    async fn normal_compact_capability_and_unsupported_never_admit() {
        for (which, cap) in [
            (Action::Capability, json!({"supported":true,"reason":null})),
            (Action::Capability, json!({"supported":false,"reason":"Codex"})),
            (Action::Compact, json!({"supported":false,"reason":"Codex"})),
        ] {
            let out = execute(which, "worker", cap.clone(), || async { panic!("must not contact actor") }).await;
            assert_eq!(out, json!({"node":"worker","supported":cap["supported"],"started":false,"reason":cap["reason"]}));
        }
    }

    #[tokio::test]
    async fn normal_compact_admission_reports_refusals_and_never_completion() {
        let cap = json!({"supported":true,"reason":null});
        for reason in ["a turn is running", "no conversation session", "not running", "runtime stopping", "authority changed"] {
            let out = execute(Action::Compact, "worker", cap.clone(), || async { json!({"started":false,"reason":reason}) }).await;
            assert_eq!(out["supported"], true);
            assert_eq!(out["started"], false);
            assert_eq!(out["reason"], reason);
        }
        let out = execute(Action::Compact, "worker", cap.clone(), || async { json!({"started":true}) }).await;
        assert_eq!(out, json!({"node":"worker","supported":true,"started":true,"reason":null}));
        let error = execute(Action::Compact, "worker", cap.clone(), || async { json!({"error":"did not answer in time"}) }).await;
        assert_eq!(error["started"], false);
        assert_eq!(error["reason"], "did not answer in time");
        let changed = execute(Action::Compact, "worker", cap, || async { json!({"supported":false,"reason":"route changed"}) }).await;
        assert_eq!(changed["supported"], false);
        assert_eq!(changed["started"], false);
    }
}
