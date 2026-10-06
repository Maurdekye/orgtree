//! The agents' tree tools: the same operations the canvas runs, with the
//! calling agent as the actor (downward only, enforced in `domain::ops`).

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, me, Done};
use crate::domain::mail::{self, From, Outgoing};
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
            if arg_str(args, "hire_type") == Some("superior") {
                let Some(t) = arg_str(args, "target") else {
                    crate::refuse!(BadRequest, "hire_type superior needs the target seat to insert above");
                };
                req["above"] = json!(t);
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
        _ => {}
    }
    let actor = Actor::Agent { id: me.id, name: me.name.clone() };
    let op_name = req["op"].as_str().unwrap_or(op).to_string();
    let out = ops::run(engine, &org, actor, &req).await?;
    // a hire or rehire may open with a first message
    let mut told = String::new();
    if op_name == "hire" || op_name == "rehire" {
        if let (Some(kick), Some(node)) = (arg_str(args, "kickoff"), out["node"].as_str()) {
            let mut m = Outgoing::new(From::Agent { id: me.id, name: me.name.clone(), generation: me.generation }, node, kick);
            if let Some(k) = arg_str(args, "kickoff_kind") {
                m.kind = k.to_string();
            }
            match mail::send(engine, org.id, m).await {
                Ok(s) => told = format!(" Kickoff sent ({}).", s.uid),
                Err(e) => told = format!(" The kickoff could not be sent: {e}"),
            }
        }
    }
    if op_name == "hire" || op_name == "rehire" {
        if let (Some(item), Some(node)) = (arg_str(args, "work_item"), out["node"].as_str()) {
            let who = crate::domain::docket::Who::Agent { id: me.id, name: me.name.clone(), generation: me.generation };
            match crate::domain::docket::assign(engine, &org, &who, item, node).await {
                Ok(_) => told.push_str(&format!(" {node} now owns docket item {item} (its status is unchanged).")),
                Err(e) => told.push_str(&format!(" The docket item {item} could not be assigned: {e}")),
            }
        }
    }
    let mut text = serde_json::to_string_pretty(&out).unwrap_or_default();
    text.push_str(&told);
    Ok(Done { text, card: None })
}
