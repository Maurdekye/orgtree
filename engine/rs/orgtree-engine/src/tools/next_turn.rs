//! Always-available self inspection, without a target or a mutation path.
use std::sync::Arc;
use anyhow::{anyhow, Result};
use serde_json::Value;
use crate::engine::Engine;
use crate::runtime::{self, AgentMsg, Caller};
use super::Done;

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    if !args.as_object().is_some_and(|o| o.is_empty()) {
        crate::refuse!(BadRequest, "orgtree_next_turn takes no arguments and reads only yourself");
    }
    {
        let client = engine.db.get().await?;
        if client.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2", &[&caller.agent_id,&caller.org_id]).await?.is_none() {
            crate::refuse!(Forbidden, "your agent is not available in this organization");
        }
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !runtime::actor(engine, caller.org_id, caller.agent_id).send(AgentMsg::NextTurn(tx)) {
        return Err(anyhow!("your runtime is stopping; next-turn evidence is unavailable"));
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx).await
        .map_err(|_| anyhow!("your runtime did not answer; next-turn evidence is unknown"))?
        .map_err(|_| anyhow!("your runtime stopped before answering"))??;
    Done::json(&result)
}
