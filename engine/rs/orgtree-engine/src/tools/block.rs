//! `orgtree_block`: block or unblock an outside contact for the whole org on
//! its mail hubs (Mail hub 2.6.0; user 2026-11-24 18:56Z "users may block /
//! unblock, and so may agents", 18:57Z "agents will be told to use it if they
//! suspect abuse", 19:06Z Q1: the user and any agent holding the org mailbox,
//! primary or weak; an agent can't lift a block the user set). The hubs keep
//! and enforce it both ways (`net::blocks`).
use super::Done;
use crate::{engine::Engine, runtime::Caller};
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    address: Option<String>,
    reason: Option<String>,
}

/// Does the caller hold a link to the org mailbox, primary or weak? (The
/// same rows as `orginbox::holder_agents`, both grantors; weak links,
/// `@extern-weak`, come with @item:orgtree/weak-org-mailbox-links-several-agents-may-send-a.)
#[logged]
async fn holds_mailbox(engine: &Engine, caller: &Caller) -> Result<bool> {
    let c = engine.db.get().await?;
    Ok(c.query_opt(
        "SELECT 1 FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
          WHERE au.org_id = $1 AND au.grantee = $2 AND au.grantor IN ('@extern', '@extern-weak')
            AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live' AND a.id = $3 LIMIT 1",
        &[&caller.org_id, &caller.name, &caller.agent_id],
    )
    .await?
    .is_some())
}

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let input: Input = serde_json::from_value(args.clone())
        .map_err(|_| crate::domain::UserError::BadRequest("expected action block/unblock/list, address and (block) reason".into()))?;
    if !holds_mailbox(engine, caller).await? {
        crate::refuse!(Forbidden, "only an agent holding the org mailbox (primary or weak link) may block contacts; ask the holder or @user");
    }
    let out = match input.action.as_str() {
        "list" => crate::net::blocks::list(engine, caller.org_id).await?,
        "block" | "unblock" => {
            let Some(address) = input.address.as_deref().filter(|a| !a.trim().is_empty()) else {
                crate::refuse!(BadRequest, "{} needs address (@net:<address>)", input.action)
            };
            let reason = input.reason.as_deref().map(str::trim).filter(|r| !r.is_empty());
            if input.action == "block" && reason.is_none() {
                crate::refuse!(BadRequest, "block needs a reason (kept in Orgtree only, never sent to the hub)");
            }
            crate::net::blocks::set(engine, caller.org_id, address, input.action == "block", &caller.name, reason).await?
        }
        _ => crate::refuse!(BadRequest, "action must be block, unblock or list"),
    };
    Done::json(&out)
}
