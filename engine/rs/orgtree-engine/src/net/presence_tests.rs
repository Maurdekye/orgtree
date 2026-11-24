//! When an org tells a hub whether it is busy (Mail hub 2.3.0, `POST
//! /api/presence`): the first time, at once on a change, again after
//! `REFRESH` (the hub keeps it in memory only), and never again to a hub that
//! answered 404 (older than 2.3.0) until the connection comes back. Do not
//! disturb (the docket's addition, USER 2026-10-31 08:51Z md63cf5e0960f): an
//! org whose outside mail is set to Do not disturb says dnd, and busy with it.
//! Last active (Mail hub 2.6.0, USER 2026-11-24 med2518611a95): a change in
//! active or in the last turn end is said at once; an org stays active while
//! any agent in charge of its mailbox is mid-turn, and its time is the
//! newest finished turn's end.
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;

#[test]
#[nolog]
fn the_first_time_it_is_said() {
    let now = Instant::now();
    assert!(due(None, bd(false, false), now), "online, never said: say it");
    assert!(due(None, bd(true, false), now), "busy, never said: say it");
    assert!(due(None, bd(true, true), now), "DND, never said: say it");
}

#[test]
#[nolog]
fn a_change_is_said_at_once() {
    let t = Instant::now();
    let said = Said { says: bd(false, false), at: t, unsupported: false };
    assert!(due(Some(said), bd(true, false), t + Duration::from_secs(1)), "online -> busy");
    let said = Said { says: bd(true, false), at: t, unsupported: false };
    assert!(due(Some(said), bd(false, false), t + Duration::from_secs(1)), "busy -> online");
}

#[test]
#[nolog]
fn the_same_is_said_again_only_after_the_refresh() {
    let t = Instant::now();
    let said = Said { says: bd(true, false), at: t, unsupported: false };
    assert!(!due(Some(said), bd(true, false), t + REFRESH - Duration::from_secs(1)), "unchanged within the refresh: not again");
    assert!(due(Some(said), bd(true, false), t + REFRESH), "unchanged, refresh reached: again (a hub that restarted forgot it)");
    assert_eq!(REFRESH, Duration::from_secs(5 * 60));
}

#[test]
#[nolog]
fn a_hub_older_than_busy_is_not_asked_again() {
    let t = Instant::now();
    let said = Said { says: bd(false, false), at: t, unsupported: true };
    assert!(!due(Some(said), bd(true, false), t + REFRESH * 3), "a 404 hub is not asked again, changed or not");
    assert!(!due(Some(said), bd(true, true), t + REFRESH * 3), "nor for DND");
    assert!(!due(Some(said), Says { active: true, ..bd(false, false) }, t + REFRESH * 3), "nor for a turn");
}

#[test]
#[nolog]
fn a_change_in_do_not_disturb_alone_is_said_at_once() {
    let t = Instant::now();
    let said = Said { says: bd(true, false), at: t, unsupported: false };
    assert!(due(Some(said), bd(true, true), t + Duration::from_secs(1)), "busy -> DND");
    let said = Said { says: bd(true, true), at: t, unsupported: false };
    assert!(due(Some(said), bd(true, false), t + Duration::from_secs(1)), "DND -> busy");
    assert!(!due(Some(said), bd(true, true), t + Duration::from_secs(1)), "DND unchanged: not again");
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

/// Busy and DND alone, as before last active.
#[nolog]
fn bd(busy: bool, dnd: bool) -> Says {
    Says { busy, dnd, ..Says::default() }
}

#[test]
#[nolog]
fn a_change_in_active_or_the_last_turn_end_is_said_at_once() {
    let t = Instant::now();
    let idle = Says { active_at: Some(1_000), ..Says::default() };
    let said = Said { says: idle, at: t, unsupported: false };
    assert!(due(Some(said), Says { active: true, ..idle }, t + Duration::from_secs(1)), "a turn started: active");
    assert!(due(Some(said), Says { active_at: Some(2_000), ..idle }, t + Duration::from_secs(1)), "a turn ended: the newer end");
    assert!(due(Some(said), Says { active_at: None, ..idle }, t + Duration::from_secs(1)), "the holder changed to one that never ran");
    assert!(!due(Some(said), idle, t + Duration::from_secs(1)), "nothing new: not again");
}

#[test]
#[nolog]
fn an_org_stays_active_while_any_agent_in_charge_is_mid_turn() {
    // (mid-turn now, last finished turn's end in ms) per agent in charge
    assert_eq!(last_active(&[]), (false, None), "nobody in charge: not active, no time");
    assert_eq!(last_active(&[(false, None)]), (false, None), "a holder that never finished a turn: no time");
    assert_eq!(last_active(&[(true, None)]), (true, None), "its first turn running: active");
    // two holders, overlapping turns: ann runs 10..40, bob runs 20..30
    assert_eq!(last_active(&[(true, Some(5)), (false, Some(8))]), (true, Some(8)), "t=10: ann starts: active");
    assert_eq!(last_active(&[(true, Some(5)), (true, Some(8))]), (true, Some(8)), "t=20: bob starts too");
    assert_eq!(last_active(&[(true, Some(5)), (false, Some(30))]), (true, Some(30)),
        "t=30: bob ends while ann still runs: still active, and the time moves on to bob's end");
    assert_eq!(last_active(&[(false, Some(40)), (false, Some(30))]), (false, Some(40)), "t=40: ann ends too: idle, last active at the newest end");
    assert_eq!(last_active(&[(false, Some(40)), (false, Some(50))]), (false, Some(50)), "the newest end wins whoever's it is");
}

#[test]
#[nolog]
fn the_post_carries_active_and_the_last_turn_end() {
    let now = chrono::DateTime::from_timestamp_millis(1_764_000_060_000).unwrap();
    let says = Says { busy: false, dnd: false, active: false, active_at: Some(1_764_000_000_123) };
    assert_eq!(body("acme.1a2b3c", says, now), json!({ "slug": "acme.1a2b3c", "busy": false, "dnd": false, "active": false,
        "active_at": "2025-11-24T16:00:00.123Z", "now": "2025-11-24T16:01:00.000Z" }));
    let says = Says { busy: true, dnd: true, active: true, active_at: None };
    assert_eq!(body("acme.1a2b3c", says, now), json!({ "slug": "acme.1a2b3c", "busy": true, "dnd": true, "active": true,
        "active_at": null, "now": "2025-11-24T16:01:00.000Z" }));
}
