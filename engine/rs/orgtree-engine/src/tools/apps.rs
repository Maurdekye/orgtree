use std::sync::Arc;
use anyhow::Result;
use serde_json::Value;
use crate::{engine::Engine,runtime::Caller};
use super::Done;
#[nolog]
pub async fn run(engine:&Arc<Engine>,caller:&Caller,args:&Value)->Result<Done>{
    let org=engine.orgs.by_id(caller.org_id).ok_or_else(||crate::domain::UserError::NotFound("organization not open".into()))?;
    Done::json(&crate::domain::apps::run(engine,&org,Some(caller),args).await?)
}
