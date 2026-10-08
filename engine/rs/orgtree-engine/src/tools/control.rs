//! Acting on agents below you: interrupt, halt/unhalt, unstick,
//! continue on another account; and account limit marks.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{arg_str, downward, me, need_str, target, Done};
use crate::engine::Engine;
use crate::runtime::{self, freeze, AgentMsg, Caller};
use crate::util::iso;

/// Ask an agent's actor something and wait for the answer.
#[logged]
pub async fn ask_actor(
    engine: &Arc<Engine>,
    org_id: i64,
    agent_id: i64,
    make: impl FnOnce(oneshot::Sender<Value>) -> AgentMsg,
) -> Value {
    let (tx, rx) = oneshot::channel();
    let h = runtime::actor(engine, org_id, agent_id);
    if !h.send(make(tx)) {
        return json!({ "error": "the agent's runtime is stopping" });
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(v)) => v,
        _ => json!({ "error": "the agent did not answer in time" }),
    }
}

#[logged]
pub async fn interrupt(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let t = target(&client, me.org_id, node).await?;
    downward(&client, &me, &t, "interrupt").await?;
    drop(client);
    let r = ask_actor(engine, me.org_id, t.id, AgentMsg::Interrupt).await;
    Done::json(&json!({ "node": t.name, "result": r }))
}

/// Halt or unhalt one agent or a batch (3.x api.py orgtree_halt). Authority
/// for EVERY target is checked first and any refusal refuses the whole call
/// before anything changes. Then every target's actor is told at once, so the
/// processes are cut in parallel and the settle waits overlap instead of
/// queueing behind each other (30 s each, bounded). A single `node` keeps the
/// single-node shape and a failure is a tool error; a batch reports each
/// node's outcome in its own slot.
#[logged]
pub async fn halt(engine: &Arc<Engine>, caller: &Caller, args: &Value, on: bool) -> Result<Done> {
    let verb = if on { "halt" } else { "unhalt" };
    let names: Vec<String> = match &args["nodes"] {
        Value::Null => arg_str(args, "node").map(str::to_string).into_iter().collect(),
        Value::Array(a) => {
            let mut v: Vec<String> = Vec::new();
            for x in a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()) {
                if !v.iter().any(|y| y == x) {
                    v.push(x.to_string());
                }
            }
            v
        }
        _ => crate::refuse!(BadRequest, "nodes must be a list of node ids"),
    };
    if names.is_empty() {
        crate::refuse!(BadRequest, "name the agent (node) or agents (nodes)");
    }
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let mut targets = Vec::with_capacity(names.len());
    for n in &names {
        let t = target(&client, me.org_id, n).await?;
        downward(&client, &me, &t, verb).await?;
        if !targets.iter().any(|x: &super::Target| x.id == t.id) {
            targets.push(t);
        }
    }
    drop(client);
    let targets: Vec<(i64, String)> = targets.into_iter().map(|t| (t.id, t.name)).collect();
    Done::json(&halt_targets(engine, me.org_id, &targets, on, names.len() == 1).await?)
}

/// Shared F05 executor. Callers must validate every target before entering;
/// actor stop/settle waits overlap and batch failures remain per-node results.
#[logged]
pub(crate) async fn halt_targets(engine: &Arc<Engine>, org_id: i64, targets: &[(i64, String)], on: bool, single: bool) -> Result<Value> {
    let verb = if on { "halt" } else { "unhalt" };
    let results = futures::future::join_all(targets.iter().map(|(id, _)| async move {
        if on {
            ask_actor(engine, org_id, *id, AgentMsg::Halt).await
        } else {
            ask_actor(engine, org_id, *id, AgentMsg::Unhalt).await
        }
    }))
    .await;
    if single {
        let (t, mut r) = (&targets[0], results.into_iter().next().unwrap_or(Value::Null));
        if let Some(e) = r.get("error").and_then(Value::as_str) {
            crate::refuse!(Conflict, "could not {verb} {}: {e}", t.1);
        }
        if let Some(o) = r.as_object_mut() {
            o.insert("node".into(), json!(t.1));
        }
        return Ok(r);
    }
    let nodes: serde_json::Map<String, Value> =
        targets.iter().zip(results).map(|(t, r)| (t.1.clone(), r)).collect();
    Ok(json!({ "batch": targets.len(), "nodes": nodes }))
}

#[logged]
pub async fn unstick(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let t = target(&client, me.org_id, node).await?;
    downward(&client, &me, &t, "unstick").await?;
    drop(client);
    let released = freeze::thaw(engine, me.org_id, t.id, false).await?;
    Done::text(if released {
        format!("{} was released and continues its work.", t.name)
    } else {
        format!("{} was not frozen; nothing to release.", t.name)
    })
}

#[logged]
pub async fn continue_on(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let account = need_str(args, "account")?;
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let t = target(&client, me.org_id, node).await?;
    downward(&client, &me, &t, "move").await?;
    let tier: String = client.query_one("SELECT tier FROM ot.agents WHERE id = $1", &[&t.id]).await?.get(0);
    drop(client);
    let view = engine.accounts.view();
    let Some(acc) = view.get(account).filter(|a| a.available_to(Some(&caller.org_slug))).cloned() else {
        crate::refuse!(NotFound, "no account {account}");
    };
    let provider = crate::providers::catalog::provider_of(&tier);
    if acc.provider != provider {
        crate::refuse!(BadRequest, "{account} is a {} account; {} runs on {}", acc.provider, t.name, provider);
    }
    if let Some(until) = acc.limited(chrono::Utc::now()) {
        crate::refuse!(Conflict, "{account} is itself limited until {}; nothing changed", iso(until));
    }
    let r = freeze::continue_on(engine, me.org_id, t.id, account, &format!("orgtree_continue_on by {}", me.name), &[]).await?;
    Done::json(&r)
}

/// 3.x parity F01/F02: inspect returns each mark's `expected` fingerprint;
/// clear is compare-and-set on it, with its audit in the same transaction.
/// Another org's legacy org key is refused exactly like an unknown account.
#[logged]
pub async fn account_mark(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let action = need_str(args, "action")?;
    let account = need_str(args, "account")?.trim().to_string();
    let view = engine.accounts.view();
    let visible: Vec<&crate::accounts::AccountInfo> =
        view.all().into_iter().filter(|a| a.available_to(Some(&caller.org_slug))).collect();
    let hidden = || -> anyhow::Error {
        crate::domain::user_err(crate::domain::UserError::NotFound, format!("no account {account:?} is visible here"))
    };
    match action {
        "inspect" => {
            let Some(row) = visible
                .iter()
                .find(|a| a.id == account || a.label == account || a.email.as_deref() == Some(account.as_str()))
            else {
                return Err(hidden());
            };
            let (id, provider, name) = (row.id.clone(), row.provider.clone(), row.display());
            drop(view);
            let client = engine.db.get().await?;
            let marks = crate::account_marks::describe(&client, &id).await?;
            Done::json(&json!({ "account": id, "name": name, "provider": provider, "marks": marks,
                                "note": "Clearing a mark adds no capacity and resumes no agent; if the provider still refuses, the account is marked again." }))
        }
        "clear" => {
            match arg_str(args, "source").unwrap_or("registry") {
                "registry" => {}
                "legacy-roster" => crate::refuse!(BadRequest, "this engine has no legacy roster; every mark is in the registry (source registry)"),
                other => crate::refuse!(BadRequest, "source must be registry, not {other}"),
            }
            if !visible.iter().any(|a| a.id == account) {
                if let Some(a) = visible.iter().find(|a| a.label == account || a.email.as_deref() == Some(account.as_str())) {
                    crate::refuse!(BadRequest, "{account:?} names {:?}; a clear takes the exact account id that inspect returned", a.id);
                }
                return Err(hidden());
            }
            drop(view);
            let Some(pool) = arg_str(args, "pool") else {
                crate::refuse!(BadRequest, "clear needs the mark entry's pool");
            };
            let Some(reason) = arg_str(args, "reason").filter(|r| !r.trim().is_empty()) else {
                crate::refuse!(BadRequest, "clear needs a reason");
            };
            let expected = args.get("expected").cloned().unwrap_or(Value::Null);
            let client = engine.db.get().await?;
            let me = me(&client, caller).await?;
            drop(client);
            let by = crate::account_marks::ClearBy {
                actor: &me.name,
                org_slug: Some(&caller.org_slug),
                org_id: Some(me.org_id),
                via: "orgtree_account_mark",
            };
            let mut out =
                crate::account_marks::clear(engine, &account, pool, &expected, args.get("companion_expected"), reason, &by).await?;
            if out["result"] == "cleared" {
                // read-only hint: clearing resumes nobody
                let client = engine.db.get().await?;
                let frozen: Vec<String> = client
                    .query(
                        "SELECT name FROM ot.agents WHERE org_id = $1 AND account = $2 AND state = 'live' AND frozen IS NOT NULL ORDER BY name LIMIT 50",
                        &[&me.org_id, &account],
                    )
                    .await?
                    .iter()
                    .map(|r| r.get(0))
                    .collect();
                out["frozen_here"] = json!(frozen);
                out["note"] = json!("this adds no capacity and resumes nobody");
            }
            Done::json(&out)
        }
        other => crate::refuse!(BadRequest, "unknown action {other} (inspect or clear)"),
    }
}
