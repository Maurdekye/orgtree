//! The agents' tree tools: the same operations the canvas runs, with the
//! calling agent as the actor (downward only, enforced in `domain::ops`).

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, me, Done};
use crate::domain::ops::{self, Actor};
use crate::engine::Engine;
use crate::runtime::Caller;

/// Run `op` with the tool's arguments (old argument names mapped).
#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value, op: &str) -> Result<Done> {
    let Some(org) = engine.orgs.by_id(caller.org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    drop(client);
    let mut req = args.clone();
    if !req.is_object() {
        req = json!({});
    }
    req["op"] = json!(op);
    match op {
        "hire" => {
            req["_caller_generation"] = json!(me.generation);
            if arg_str(args, "hire_type") == Some("superior") {
                // No target means the authenticated ID, not a name that can be
                // renamed/reused between this lookup and the op transaction.
                req["above"] = arg_str(args, "target").or_else(|| arg_str(args, "parent")).map_or(Value::Null, |t| json!(t));
            } else if let Some(t) = arg_str(args, "target").or_else(|| arg_str(args, "parent")) {
                req["parent"] = json!(t);
            } else {
                req["parent"] = json!(me.name);
            }
        }
        "rehire" => {
            if let Some(t) = arg_str(args, "target") {
                req["parent"] = json!(t);
            }
        }
        "move" if args.get("moves").map(|m| m.is_array()).unwrap_or(false) => req["op"] = json!("moves"),
        "create_project" => match arg_str(args, "action") {
            Some("create") => {
                if arg_str(args, "parent").is_none() {
                    req["parent"] = json!(me.name);
                }
            }
            Some("describe") => {
                req["op"] = json!("set_description");
                req["node"] = args.get("name").cloned().unwrap_or(Value::Null);
            }
            // project slots (domain/slots.rs): release yours, or see them
            Some("release_slot") => {
                req["op"] = json!("slot_release");
            }
            Some("slots") => {
                req["op"] = json!("slot_status");
                req["node"] = args.get("name").cloned().unwrap_or(Value::Null);
            }
            Some("settings" | "configure" | "unqueue_slot" | "purge_waiting" | "presentations" | "read_presentation") => {
                req["op"] = json!(match arg_str(args,"action").unwrap() {
                    "settings" => "project_settings", "configure" => "configure_project", "unqueue_slot" => "slot_unqueue",
                    "purge_waiting" => "purge_mail_queue", _ => "project_presentations",
                });
                req["node"] = args.get("name").cloned().unwrap_or(Value::Null);
            }
            Some("broadcast") => return project_broadcast(engine, caller, args).await,
            _ => crate::refuse!(BadRequest, "orgtree_project takes create, describe, settings, configure, slots, release_slot, unqueue_slot, purge_waiting, broadcast, presentations or read_presentation. If these actions/tools are missing in your CLI, start a fresh CLI; running clients retain their startup tool schemas."),
        },
        _ => {}
    }
    let actor = Actor::Agent { id: me.id, name: me.name.clone() };
    let out = ops::run(engine, &org, actor, &req).await?;
    Ok(Done { text: serde_json::to_string_pretty(&out).unwrap_or_default(), card: None })
}

/// Megaphone convenience; ordinary message scope, reach and attachment rules apply to EVERY send.
#[logged]
async fn project_broadcast(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    if !crate::domain::tool_groups::allows(&super::caller_tools(engine,caller).await?, "orgtree_message") {
        crate::refuse!(Forbidden,"project broadcast needs your messaging tool group");
    }
    let client=engine.db.get().await?;
    let project=crate::domain::projects::by_name(&**client,caller.org_id,super::need_str(args,"name")?).await?
        .ok_or_else(|| anyhow::anyhow!("no such project"))?;
    crate::domain::projects::require_reach(&**client,caller.agent_id,&project,"broadcast").await?;
    if project.state!="live" { crate::refuse!(Conflict,"project {} is retired",project.name); }
    let through:i64=client.query_one("SELECT coalesce(max(id),0) FROM ot.agents WHERE org_id=$1",&[&caller.org_id]).await?.get(0);
    drop(client);
    let mut after=0i64;
    let mut outcomes=Vec::new();
    loop {
        let client=engine.db.get().await?;
        let rows=client.query("WITH RECURSIVE below(id,depth) AS (SELECT $1::bigint,0 UNION ALL SELECT a.id,b.depth+1 FROM ot.agents a JOIN below b ON a.parent_id=b.id WHERE a.org_id=$2 AND b.depth<1024) SELECT a.id,a.name FROM ot.agents a JOIN below b ON b.id=a.id WHERE a.org_id=$2 AND a.kind='agent' AND a.state='live' AND a.id>$3 AND a.id<=$4 ORDER BY a.id LIMIT 100", &[&project.id,&caller.org_id,&after,&through]).await?;
        drop(client);
        if rows.is_empty() { break; }
        for r in rows {
            after=r.get(0); let to:String=r.get(1);
            let letter=json!({"metadata":{"to":to,"notice":args["notice"],"attachments":args["attachments"]},"body":args["body"]});
            match super::mailtools::message(engine,caller,&letter,false).await {
                Ok(d)=>outcomes.push(json!({"to":to,"sent":true,"detail":d.text,"mail":d.card})),
                Err(e)=>outcomes.push(json!({"to":to,"sent":false,"error":e.to_string()})),
            }
        }
    }
    Done::json(&json!({"project":project.name,"outcomes":outcomes}))
}
