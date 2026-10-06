//! The agent runtime: one task (actor) per agent that is doing something.
//! It owns that agent's live state and its provider CLI, takes turns from the
//! scheduler, and publishes its runtime overlay to the org feed.

pub mod sched;

use std::sync::Arc;

use crate::engine::Engine;

#[derive(Default)]
pub struct AgentRegistry {
    pub map: papaya::HashMap<i64, Arc<AgentHandle>>,
}

pub struct AgentHandle {
    pub id: i64,
    pub org_id: i64,
}

impl AgentRegistry {
    pub fn get(&self, id: i64) -> Option<Arc<AgentHandle>> {
        self.map.pin().get(&id).cloned()
    }
    pub fn count(&self) -> usize {
        self.map.pin().len()
    }
}

/// Agents running a turn right now, per org.
pub fn working_by_org(_engine: &Engine) -> std::collections::HashMap<i64, i64> {
    std::collections::HashMap::new()
}

/// Resume agents that were mid-turn when the last engine stopped.
pub async fn recover(_engine: &Arc<Engine>) {}

/// Stop admitting turns, end running ones (they resume on the next start).
pub async fn shutdown(_engine: &Arc<Engine>) {}
