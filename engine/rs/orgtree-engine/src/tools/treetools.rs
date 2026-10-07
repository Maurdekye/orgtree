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
            if arg_str(args, "hire_type") == Some("superior") {
                let t = arg_str(args, "target").or_else(|| arg_str(args, "parent")).unwrap_or(&me.name);
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
    let out = ops::run(engine, &org, actor, &req).await?;
    Ok(Done { text: serde_json::to_string_pretty(&out).unwrap_or_default(), card: None })
}
