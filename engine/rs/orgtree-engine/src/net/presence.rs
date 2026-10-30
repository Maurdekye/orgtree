//! Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
//! org-presence-busy-orange-when-no-org-inbox-holde): each org tells the hubs
//! it is on whether it is busy. Red: when to say it is not decided yet.

use std::time::{Duration, Instant};

/// How long an unchanged busy stands before it is said again: the hub keeps
/// it in memory only, so one that restarted unnoticed hears it within this.
pub(crate) const REFRESH: Duration = Duration::from_secs(5 * 60);

/// What an org last told one hub.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Said {
    pub(crate) busy: bool,
    pub(crate) at: Instant,
    /// the hub answered 404: older than Mail hub 2.3.0
    pub(crate) unsupported: bool,
}

/// Whether to tell the hub now. Red: never.
#[nolog]
pub(crate) fn due(_last: Option<Said>, _busy: bool, _now: Instant) -> bool {
    false
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
