//! When an org tells a hub whether it is busy (Mail hub 2.3.0, `POST
//! /api/presence`): the first time, at once on a change, again after
//! `REFRESH` (the hub keeps it in memory only), and never again to a hub that
//! answered 404 (older than 2.3.0) until the connection comes back.
use std::time::{Duration, Instant};

use super::*;

#[test]
#[nolog]
fn the_first_time_it_is_said() {
    let now = Instant::now();
    assert!(due(None, false, now), "online, never said: say it");
    assert!(due(None, true, now), "busy, never said: say it");
}

#[test]
#[nolog]
fn a_change_is_said_at_once() {
    let t = Instant::now();
    let said = Said { busy: false, at: t, unsupported: false };
    assert!(due(Some(said), true, t + Duration::from_secs(1)), "online -> busy");
    let said = Said { busy: true, at: t, unsupported: false };
    assert!(due(Some(said), false, t + Duration::from_secs(1)), "busy -> online");
}

#[test]
#[nolog]
fn the_same_is_said_again_only_after_the_refresh() {
    let t = Instant::now();
    let said = Said { busy: true, at: t, unsupported: false };
    assert!(!due(Some(said), true, t + REFRESH - Duration::from_secs(1)), "unchanged within the refresh: not again");
    assert!(due(Some(said), true, t + REFRESH), "unchanged, refresh reached: again (a hub that restarted forgot it)");
    assert_eq!(REFRESH, Duration::from_secs(5 * 60));
}

#[test]
#[nolog]
fn a_hub_older_than_busy_is_not_asked_again() {
    let t = Instant::now();
    let said = Said { busy: false, at: t, unsupported: true };
    assert!(!due(Some(said), true, t + REFRESH * 3), "a 404 hub is not asked again, changed or not");
}
