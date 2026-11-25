//! `orgtree_lockdown`: the org mailbox's last-straw defense against a flood
//! of new outside accounts (USER 2026-11-25 13:26Z m0388b64a9372; answers
//! 13:37Z, 14:08Z, 14:10Z). Agents holding the org mailbox (primary or weak
//! link) turn the lockdown on and off, edit the allow list and the set-aside
//! flag, and open or close outside communication, while the user's settings
//! are on Org decides. The hubs and the engine enforce it (`net::lockdown`).
use super::Done;
use crate::net::lockdown::{self, Edit, Entry, Who};
use crate::{engine::Engine, runtime::Caller};
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    /// add/remove: one address; on: the list
    address: Option<String>,
    addresses: Option<Vec<String>>,
    hub: Option<String>,
    set_aside: Option<bool>,
    /// outside: open or closed
    mode: Option<String>,
    rev: Option<i64>,
}

#[logged]
async fn resolve(engine: &Engine, org_id: i64, list: &[String], hub: Option<&str>) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for a in list {
        out.extend(lockdown::entries(engine, org_id, a, hub).await?);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let input: Input = serde_json::from_value(args.clone()).map_err(|_| {
        crate::domain::UserError::BadRequest("expected action status/on/off/add/remove/configure/outside, with address(es), hub, set_aside, mode or rev".into())
    })?;
    let org = caller.org_id;
    let who = Who::Agent(&caller.name);
    let mut edit = Edit { expect_rev: input.rev, ..Edit::default() };
    let one = || -> Result<Vec<String>> {
        match (&input.address, &input.addresses) {
            (Some(a), None) => Ok(vec![a.clone()]),
            (None, Some(l)) if !l.is_empty() => Ok(l.clone()),
            _ => crate::refuse!(BadRequest, "{} needs address (or addresses)", input.action),
        }
    };
    let out = match input.action.as_str() {
        "status" => lockdown::status(engine, org).await?,
        "on" => {
            edit.on = Some(true);
            edit.set_aside = input.set_aside;
            if input.address.is_some() || input.addresses.is_some() {
                edit.allow = Some(resolve(engine, org, &one()?, input.hub.as_deref()).await?);
            }
            lockdown::change(engine, org, who, edit).await?
        }
        "off" => {
            edit.on = Some(false);
            lockdown::change(engine, org, who, edit).await?
        }
        "add" | "remove" => {
            let list = resolve(engine, org, &one()?, input.hub.as_deref()).await?;
            if input.action == "add" { edit.add = list } else { edit.remove = list }
            lockdown::change(engine, org, who, edit).await?
        }
        "configure" => {
            let Some(flag) = input.set_aside else { crate::refuse!(BadRequest, "configure needs set_aside (true or false)") };
            edit.set_aside = Some(flag);
            lockdown::change(engine, org, who, edit).await?
        }
        "outside" => {
            let mode = match input.mode.as_deref().map(str::trim) {
                Some("open" | "normal") => "normal",
                Some("closed") => "closed",
                _ => crate::refuse!(BadRequest, "outside needs mode=open or mode=closed"),
            };
            crate::domain::orginbox::set_org_choice(engine, org, &caller.name, mode).await?
        }
        _ => crate::refuse!(BadRequest, "action must be status, on, off, add, remove, configure or outside"),
    };
    Done::json(&out)
}
