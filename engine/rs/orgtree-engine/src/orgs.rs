//! The directory of open organizations: slug/id → handle (its feed and
//! rooms). Lock-free maps; handles are immutable apart from their name.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;
use arc_swap::ArcSwap;

use crate::engine::Engine;
use crate::feed::{self, rooms::Rooms, Key, OrgFeed};

pub struct OrgHandle {
    pub id: i64,
    pub uuid: String,
    pub slug: String,
    pub name: ArcSwap<String>,
    pub feed: OrgFeed,
    pub rooms: Rooms,
    /// agents running a turn right now
    pub working: AtomicI64,
    /// moves on every change to this org: the docket list's ETag
    pub docket: AtomicU64,
}

#[logged]
impl OrgHandle {
    /// A turn started (+1) or ended (-1); the app feed shows the count.
    pub fn turn_delta(&self, engine: &Engine, d: i64) {
        let n = (self.working.fetch_add(d, Ordering::SeqCst) + d).max(0);
        engine.app.working(self.id, n);
    }
    pub fn invalidate(&self, keys: impl IntoIterator<Item = Key>) {
        self.feed.invalidate(keys);
    }
    /// An org-wide pushed frame (pulses, mail sparks).
    pub fn emit(&self, frame: serde_json::Value) {
        self.rooms.emit_org(&frame);
    }
    /// A frame for windows with this agent's desk open.
    #[nolog]
    pub fn emit_agent(&self, agent: i64, frame: serde_json::Value) {
        self.rooms.emit_agent(agent, &frame);
    }
}

#[derive(Default)]
pub struct OrgDirectory {
    by_slug: papaya::HashMap<String, Arc<OrgHandle>>,
    by_id: papaya::HashMap<i64, Arc<OrgHandle>>,
}

#[logged]
impl OrgDirectory {
    pub fn get(&self, slug: &str) -> Option<Arc<OrgHandle>> {
        self.by_slug.pin().get(slug).cloned()
    }
    pub fn by_id(&self, id: i64) -> Option<Arc<OrgHandle>> {
        self.by_id.pin().get(&id).cloned()
    }
    pub fn insert(&self, h: Arc<OrgHandle>) {
        self.by_slug.pin().insert(h.slug.clone(), h.clone());
        self.by_id.pin().insert(h.id, h);
    }
    pub fn remove(&self, slug: &str) -> Option<Arc<OrgHandle>> {
        let h = self.by_slug.pin().remove(slug).cloned();
        if let Some(h) = &h {
            self.by_id.pin().remove(&h.id);
        }
        h
    }
    pub fn all(&self) -> Vec<Arc<OrgHandle>> {
        let mut v: Vec<Arc<OrgHandle>> = self.by_id.pin().values().cloned().collect();
        v.sort_by(|a, b| a.slug.cmp(&b.slug));
        v
    }
}

#[logged]
pub fn open(engine: &Arc<Engine>, id: i64, uuid: String, slug: String, name: String) -> Arc<OrgHandle> {
    let feed = feed::spawn(engine.clone(), id, uuid.clone());
    let h = Arc::new(OrgHandle { id, uuid, slug, name: ArcSwap::from_pointee(name), feed, rooms: Rooms::default(), working: AtomicI64::new(0),
                             docket: AtomicU64::new(0) });
    engine.orgs.insert(h.clone());
    h
}

#[logged]
pub async fn load_all(engine: &Arc<Engine>) -> Result<()> {
    let client = engine.db.get().await?;
    let rows = client
        .query("SELECT id, uuid::text, slug, name FROM ot.orgs WHERE state = 'active' ORDER BY id", &[])
        .await?;
    for r in rows {
        open(engine, r.get(0), r.get(1), r.get(2), r.get(3));
    }
    Ok(())
}
