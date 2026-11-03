//! Rooms: per-org fan-out of pushed frames to exactly the sockets that want
//! them. The org room reaches every socket of the org; an agent's transcript
//! room reaches only sockets with that agent's desk open.
//!
//! Membership changes are copy-on-write (`ArcSwap`), so emitting never takes
//! a lock and never waits on a slow socket: a full socket queue drops the
//! frame, and the socket's own recovery (refetch on nudge, gap catch-up)
//! repairs it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;
use tokio::sync::mpsc;

pub type SocketId = u64;
pub type Out = mpsc::Sender<Arc<str>>;

static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);

#[logged]
pub fn next_socket_id() -> SocketId {
    NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone)]
pub struct Member {
    pub id: SocketId,
    pub out: Out,
}

#[derive(Default)]
pub struct Rooms {
    org: ArcSwap<Vec<Member>>,
    agents: papaya::HashMap<i64, Arc<ArcSwap<Vec<Member>>>>,
    /// socket → agents it watches, so a disconnect leaves every room
    watching: papaya::HashMap<SocketId, Arc<Vec<i64>>>,
}

#[logged]
impl Rooms {
    pub fn join_org(&self, m: Member) {
        self.org.rcu(|cur| {
            let mut v: Vec<Member> = cur.iter().filter(|x| x.id != m.id).cloned().collect();
            v.push(m.clone());
            v
        });
    }

    pub fn leave(&self, id: SocketId) {
        self.org.rcu(|cur| cur.iter().filter(|x| x.id != id).cloned().collect::<Vec<_>>());
        let prev = self.watching.pin().remove(&id).cloned();
        if let Some(agents) = prev {
            for a in agents.iter() {
                self.leave_agent(*a, id);
            }
        }
    }

    fn room(&self, agent: i64) -> Arc<ArcSwap<Vec<Member>>> {
        self.agents
            .pin()
            .get_or_insert_with(agent, || Arc::new(ArcSwap::from_pointee(Vec::new())))
            .clone()
    }

    fn leave_agent(&self, agent: i64, id: SocketId) {
        if let Some(room) = self.agents.pin().get(&agent).cloned() {
            room.rcu(|cur| cur.iter().filter(|x| x.id != id).cloned().collect::<Vec<_>>());
        }
    }

    /// Replace the set of transcript rooms `m` is in.
    pub fn watch(&self, m: &Member, agents: Vec<i64>) {
        let prev = self.watching.pin().insert(m.id, Arc::new(agents.clone())).cloned();
        let prev = prev.map(|p| p.as_ref().clone()).unwrap_or_default();
        for a in prev.iter().filter(|a| !agents.contains(a)) {
            self.leave_agent(*a, m.id);
        }
        for a in agents.iter().filter(|a| !prev.contains(a)) {
            let room = self.room(*a);
            room.rcu(|cur| {
                let mut v: Vec<Member> = cur.iter().filter(|x| x.id != m.id).cloned().collect();
                v.push(m.clone());
                v
            });
        }
    }

    #[nolog]
    pub fn emit_org(&self, frame: &serde_json::Value) {
        let members = self.org.load();
        if members.is_empty() {
            return;
        }
        let text: Arc<str> = Arc::from(frame.to_string());
        for m in members.iter() {
            let _ = m.out.try_send(text.clone());
        }
    }

    #[nolog]
    pub fn emit_agent(&self, agent: i64, frame: &serde_json::Value) {
        crate::rig::stream_probe("room", frame["node"].as_str().unwrap_or(""), frame);
        let Some(room) = self.agents.pin().get(&agent).cloned() else { return };
        let members = room.load();
        if members.is_empty() {
            return;
        }
        let text: Arc<str> = Arc::from(frame.to_string());
        for m in members.iter() {
            let _ = m.out.try_send(text.clone());
        }
    }

    #[nolog]
    pub fn watched(&self, agent: i64) -> bool {
        self.agents.pin().get(&agent).map(|r| !r.load().is_empty()).unwrap_or(false)
    }

    #[nolog]
    pub fn socket_count(&self) -> usize {
        self.org.load().len()
    }

    #[nolog]
    pub fn socket_rooms(&self) -> HashMap<SocketId, usize> {
        self.watching.pin().iter().map(|(k, v)| (*k, v.len())).collect()
    }
}

#[cfg(test)]
mod attract_tests {
    use super::*;

    fn member(id: SocketId) -> Member {
        let (tx, _rx) = mpsc::channel::<Arc<str>>(4);
        Member { id, out: tx }
    }

    #[test]
    fn attract_refusal_is_live_state_of_connected_windows() {
        let rooms = Rooms::default();
        assert!(!rooms.attract_refusing(), "no window reports attract: nothing is refused");
        rooms.join_org(member(1));
        rooms.join_org(member(2));
        rooms.set_attract(1, Some(true));
        assert!(rooms.attract_refusing(), "one window running with the setting on refuses");
        rooms.set_attract(1, None);
        assert!(!rooms.attract_refusing(), "stopped: allowed again");
        rooms.set_attract(1, Some(false));
        assert!(!rooms.attract_refusing(), "running with the setting off: allowed");
        rooms.set_attract(2, Some(true));
        assert!(rooms.attract_refusing(), "any window running counts");
        rooms.leave(2);
        assert!(!rooms.attract_refusing(), "a disconnect clears that window's flag");
        rooms.set_attract(1, Some(true));
        rooms.leave(1);
        assert!(!rooms.attract_refusing());
    }

    #[test]
    fn attract_report_from_a_departed_socket_is_not_kept() {
        let rooms = Rooms::default();
        rooms.set_attract(9, Some(true));
        rooms.leave(9);
        assert!(!rooms.attract_refusing());
    }
}
