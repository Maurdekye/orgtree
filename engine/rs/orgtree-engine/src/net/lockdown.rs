//! Org mailbox lockdown: RED STUB (the API its tests name, with today's
//! behaviour: no lockdown, nobody refused). The feature commit replaces it.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::engine::Engine;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserMode {
    Org,
    On,
    Off,
}

impl UserMode {
    #[nolog]
    pub fn parse(_s: &str) -> Option<Self> {
        None
    }
}

#[nolog]
pub fn effective(_user: UserMode, _org_on: bool) -> bool {
    false
}

#[nolog]
pub fn agent_may_change(_user: UserMode) -> bool {
    true
}

#[derive(Clone, Copy, Debug)]
pub enum Who<'a> {
    User,
    Agent(&'a str),
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Entry {
    pub hub: String,
    pub address: String,
}

#[derive(Clone, Debug, Default)]
pub struct Edit {
    pub user_mode: Option<UserMode>,
    pub on: Option<bool>,
    pub allow: Option<Vec<Entry>>,
    pub add: Vec<Entry>,
    pub remove: Vec<Entry>,
    pub set_aside: Option<bool>,
    pub expect_rev: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Deliver,
    Drop,
    SetAside,
}

#[nolog]
pub(super) fn lists_lockdown(_health: &Value) -> bool {
    false
}

#[logged]
pub async fn admit<C: tokio_postgres::GenericClient + Sync>(_c: &C, _org_id: i64, _hub: &str, _from: &str) -> Result<Admission> {
    Ok(Admission::Deliver)
}

#[logged]
pub async fn change(_engine: &Arc<Engine>, _org_id: i64, _who: Who<'_>, _edit: Edit) -> Result<Value> {
    anyhow::bail!("lockdown is not built yet")
}

#[logged]
pub async fn status(_engine: &Engine, _org_id: i64) -> Result<Value> {
    Ok(json!({}))
}
