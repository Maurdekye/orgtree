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

#[logged]
pub async fn halt(engine: &Arc<Engine>, caller: &Caller, args: &Value, on: bool) -> Result<Done> {
    let mut names: Vec<String> = args["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if let Some(n) = arg_str(args, "node") {
        names.push(n.to_string());
    }
    if names.is_empty() {
        crate::refuse!(BadRequest, "name the agent (node) or agents (nodes)");
    }
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let mut results = Vec::new();
    for n in names {
        let t = match target(&client, me.org_id, &n).await {
            Ok(t) => t,
            Err(e) => {
                results.push(json!({ "node": n, "error": e.to_string() }));
                continue;
            }
        };
        if let Err(e) = downward(&client, &me, &t, if on { "halt" } else { "unhalt" }).await {
            results.push(json!({ "node": t.name, "error": e.to_string() }));
            continue;
        }
        let r = if on {
            ask_actor(engine, me.org_id, t.id, AgentMsg::Halt).await
        } else {
            ask_actor(engine, me.org_id, t.id, AgentMsg::Unhalt).await
        };
        results.push(json!({ "node": t.name, "result": r }));
    }
    Done::json(&json!({ "results": results }))
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
    let Some(acc) = view.get(account).cloned() else {
        crate::refuse!(NotFound, "no account {account}");
    };
    let provider = crate::providers::catalog::provider_of(&tier);
    if acc.provider != provider {
        crate::refuse!(BadRequest, "{account} is a {} account; {} runs on {}", acc.provider, t.name, provider);
    }
    if let Some(until) = acc.limited(chrono::Utc::now()) {
        crate::refuse!(Conflict, "{account} is itself limited until {}; nothing changed", iso(until));
    }
    let r = freeze::continue_on(engine, me.org_id, t.id, account, &format!("orgtree_continue_on by {}", me.name)).await?;
    Done::json(&r)
}

#[logged]
pub async fn account_mark(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let action = need_str(args, "action")?;
    let account = need_str(args, "account")?.to_string();
    let view = engine.accounts.view();
    let id = view
        .all()
        .into_iter()
        .find(|a| a.id == account || a.label == account || a.email.as_deref() == Some(account.as_str()))
        .map(|a| a.id.clone())
        .unwrap_or(account.clone());
    let client = engine.db.get().await?;
    match action {
        "inspect" => {
            let rows = client
                .query("SELECT pool, until, provenance, win, at FROM ot.account_marks WHERE account = $1 ORDER BY pool", &[&id])
                .await?;
            let now = chrono::Utc::now();
            let marks: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let until: chrono::DateTime<chrono::Utc> = r.get(1);
                    json!({ "account": id, "pool": r.get::<_, String>(0), "until": iso(until), "active": until > now,
                            "provenance": r.get::<_, String>(2), "window": r.get::<_, Option<String>>(3),
                            "marked_at": iso(r.get(4)) })
                })
                .collect();
            Done::json(&json!({ "account": id, "marks": marks }))
        }
        "clear" => {
            let pool = arg_str(args, "pool").unwrap_or("default").to_string();
            let Some(reason) = arg_str(args, "reason") else {
                crate::refuse!(BadRequest, "clear needs a reason");
            };
            let n = client.execute("DELETE FROM ot.account_marks WHERE account = $1 AND pool = $2", &[&id, &pool]).await?;
            if n == 0 {
                return Done::json(&json!({ "cleared": false, "state": "missing" }));
            }
            let me = me(&client, caller).await?;
            client
                .execute(
                    "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'account_mark_cleared', $2, $3)",
                    &[&me.org_id, &me.name, &json!({ "account": id, "pool": pool, "reason": crate::util::gist(reason, 500) })],
                )
                .await?;
            drop(client);
            let _ = engine.accounts.reload(engine).await;
            crate::accounts::publish(engine);
            Done::json(&json!({ "cleared": true, "account": id, "pool": pool,
                                "note": "this adds no capacity and resumes nobody" }))
        }
        other => crate::refuse!(BadRequest, "unknown action {other} (inspect or clear)"),
    }
}
