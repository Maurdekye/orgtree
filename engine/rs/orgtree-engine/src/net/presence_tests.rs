//! When an org tells a hub whether it is busy (Mail hub 2.3.0, `POST
//! /api/presence`): the first time, at once on a change, again after
//! `REFRESH` (the hub keeps it in memory only), and never again to a hub that
//! answered 404 (older than 2.3.0) until the connection comes back. Do not
//! disturb (the docket's addition, USER 2026-10-31 08:51Z md63cf5e0960f): an
//! org whose outside mail is set to Do not disturb says dnd, and busy with it.
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;

#[test]
#[nolog]
fn the_first_time_it_is_said() {
    let now = Instant::now();
    assert!(due(None, false, false, now), "online, never said: say it");
    assert!(due(None, true, false, now), "busy, never said: say it");
    assert!(due(None, true, true, now), "DND, never said: say it");
}

#[test]
#[nolog]
fn a_change_is_said_at_once() {
    let t = Instant::now();
    let said = Said { busy: false, dnd: false, at: t, unsupported: false };
    assert!(due(Some(said), true, false, t + Duration::from_secs(1)), "online -> busy");
    let said = Said { busy: true, dnd: false, at: t, unsupported: false };
    assert!(due(Some(said), false, false, t + Duration::from_secs(1)), "busy -> online");
}

#[test]
#[nolog]
fn the_same_is_said_again_only_after_the_refresh() {
    let t = Instant::now();
    let said = Said { busy: true, dnd: false, at: t, unsupported: false };
    assert!(!due(Some(said), true, false, t + REFRESH - Duration::from_secs(1)), "unchanged within the refresh: not again");
    assert!(due(Some(said), true, false, t + REFRESH), "unchanged, refresh reached: again (a hub that restarted forgot it)");
    assert_eq!(REFRESH, Duration::from_secs(5 * 60));
}

#[test]
#[nolog]
fn a_hub_older_than_busy_is_not_asked_again() {
    let t = Instant::now();
    let said = Said { busy: false, dnd: false, at: t, unsupported: true };
    assert!(!due(Some(said), true, false, t + REFRESH * 3), "a 404 hub is not asked again, changed or not");
    assert!(!due(Some(said), true, true, t + REFRESH * 3), "nor for DND");
}

#[test]
#[nolog]
fn a_change_in_do_not_disturb_alone_is_said_at_once() {
    let t = Instant::now();
    let said = Said { busy: true, dnd: false, at: t, unsupported: false };
    assert!(due(Some(said), true, true, t + Duration::from_secs(1)), "busy -> DND");
    let said = Said { busy: true, dnd: true, at: t, unsupported: false };
    assert!(due(Some(said), true, false, t + Duration::from_secs(1)), "DND -> busy");
    assert!(!due(Some(said), true, true, t + Duration::from_secs(1)), "DND unchanged: not again");
}

#[test]
#[nolog]
fn an_org_on_do_not_disturb_says_dnd_and_busy() {
    for (settings, holders_busy, want, why) in [
        (json!({}), false, (false, false), "settings from before the mode: normal operations, online"),
        (json!({ "org_inbox_mode": "normal" }), true, (true, false), "normal, no holder can run: busy"),
        (json!({ "org_inbox_mode": "dnd" }), false, (true, true), "Do not disturb with holders able: DND, and busy for a hub or client that knows busy only"),
        (json!({ "org_inbox_mode": "dnd" }), true, (true, true), "Do not disturb and no holder can run: DND"),
        (json!({ "org_inbox_mode": "dnd", "org_inbox_enabled": false }), false, (false, false), "the older off switch closes the inbox: not DND"),
        (json!({ "org_inbox_mode": "closed", "org_inbox_enabled": false }), true, (true, false), "a closed inbox keeps today's presence"),
    ] {
        assert_eq!(presence_of(&settings, holders_busy), want, "{why}: {settings}");
    }
}
