//! Actor-owned coalescing. No database writes, global locks or estimated occupancy.
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Snapshot { pub used: i64, pub window: Option<i64> }

#[derive(Default)]
pub struct Coalesced {
    pub published: Option<Snapshot>,
    pending: Option<Snapshot>,
    last: Option<Instant>,
    pub due: Option<Instant>,
}
impl Coalesced {
    #[nolog]
    pub fn observe(&mut self, snapshot: Option<Snapshot>, now: Instant) {
        let Some(snapshot) = snapshot else { return; }; // missing never clears a known observation
        if self.pending == Some(snapshot) { return; }
        if self.published == Some(snapshot) { self.pending = None; self.due = None; return; }
        self.pending = Some(snapshot);
        self.due.get_or_insert(self.last.map(|at| at + Duration::from_secs(1)).unwrap_or(now));
    }
    #[nolog]
    pub fn flush(&mut self, now: Instant) -> bool {
        if !self.due.is_some_and(|at| at <= now) { return false; }
        self.published = self.pending.take();
        self.last = Some(now);
        self.due = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_bursts_emit_latest_once_per_second_without_losing_last_pending_value() {
        let now = Instant::now();
        let mut c = Coalesced::default();
        let snapshot = |used| Some(Snapshot { used, window:Some(1000) });
        c.observe(snapshot(0),now);
        assert!(c.flush(now));
        for used in 1..100 {
            let at=now+Duration::from_millis(used);
            c.observe(snapshot(used as i64),at);
            assert!(!c.flush(at));
        }
        c.observe(None,now+Duration::from_millis(900));
        assert!(c.flush(now+Duration::from_secs(1)));
        assert_eq!(c.published,snapshot(99));
        c.observe(snapshot(99),now+Duration::from_secs(2));
        assert!(!c.flush(now+Duration::from_secs(2)));
    }
}
