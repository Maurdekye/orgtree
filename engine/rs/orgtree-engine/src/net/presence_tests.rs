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
    assert_eq!(body("acme.1a2b3c", says, true, now), json!({ "slug": "acme.1a2b3c", "busy": false, "dnd": false, "active": false,
        "active_at": "2025-11-24T16:00:00.123Z", "now": "2025-11-24T16:01:00.000Z" }));
    let says = Says { busy: true, dnd: true, active: true, active_at: None };
    assert_eq!(body("acme.1a2b3c", says, true, now), json!({ "slug": "acme.1a2b3c", "busy": true, "dnd": true, "active": true,
        "active_at": null, "now": "2025-11-24T16:01:00.000Z" }));
}

#[test]
#[nolog]
fn an_older_hub_gets_busy_and_dnd_alone() {
    let now = chrono::DateTime::from_timestamp_millis(1_764_000_060_000).unwrap();
    let says = Says { busy: true, dnd: false, active: true, active_at: Some(1_764_000_000_123) };
    assert_eq!(for_hub(says, false), Says { busy: true, dnd: false, active: false, active_at: None }, "a turn is no news to it");
    assert_eq!(for_hub(says, true), says);
    assert_eq!(body("acme.1a2b3c", says, false, now), json!({ "slug": "acme.1a2b3c", "busy": true, "dnd": false }), "today's body, byte for byte");
    // so a turn edge alone is never due for it
    let t = Instant::now();
    let said = Said { says: for_hub(Says { active: false, ..says }, false), at: t, unsupported: false };
    assert!(!due(Some(said), for_hub(says, false), t + Duration::from_secs(1)), "a turn started: an older hub hears nothing");
}

#[test]
#[nolog]
fn a_hubs_features_are_read_again_at_each_refresh_and_a_failed_read_keeps_the_answer() {
    let t = Instant::now();
    assert!(features_due(None, t), "never read on this connection");
    assert!(!features_due(Some((false, t)), t + REFRESH - Duration::from_secs(1)), "read lately: cached");
    assert!(features_due(Some((false, t)), t + REFRESH), "a refresh later: read again (a hub upgraded in place)");
    let later = t + REFRESH;
    assert_eq!(after_read(Some((false, t)), Some(true), later), (true, Some((true, later))), "upgraded: it has it now");
    assert_eq!(after_read(Some((true, t)), None, later), (true, Some((true, later))), "unreadable: the cached answer, until the next refresh");
    assert_eq!(after_read(None, None, later), (false, None), "never read and unreadable: without it, read again next pass");
    assert!(FEATURES_TIMEOUT <= Duration::from_secs(2), "an unreadable /healthz holds a pass 2 s at most");
}

#[test]
#[nolog]
fn the_agents_in_charge_follow_each_pass() {
    let state = State::default();
    state.set_in_charge(1, &[10, 11]);
    state.set_in_charge(2, &[20]);
    assert!(state.is_in_charge(10) && state.is_in_charge(11) && state.is_in_charge(20));
    state.set_in_charge(1, &[11, 12]);
    assert!(!state.is_in_charge(10), "no longer in charge: its turns kick nothing");
    assert!(state.is_in_charge(11) && state.is_in_charge(12) && state.is_in_charge(20), "the new one counts; another org's stays");
    state.set_in_charge(1, &[]);
    assert!(!state.is_in_charge(11) && !state.is_in_charge(12) && state.is_in_charge(20), "an org with no hub that lists last_active: none of its");
}

/// A hub that answers `/healthz` with these features and 200 to anything
/// else, and records each POST body.
async fn fake_hub(features: &'static [&'static str]) -> (String, tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let mut got = Vec::new();
            loop {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                let Some((head, body)) = text.split_once("\r\n\r\n") else {
                    if n == 0 { break } else { continue }
                };
                let want = head.to_ascii_lowercase().split("content-length:").nth(1).and_then(|v| v.trim().split_whitespace().next().and_then(|v| v.parse::<usize>().ok())).unwrap_or(0);
                if body.len() >= want || n == 0 { break }
            }
            let text = String::from_utf8_lossy(&got).to_string();
            let answer = if text.starts_with("GET /healthz") {
                json!({ "ok": true, "features": features }).to_string()
            } else {
                if let Some((_, b)) = text.split_once("\r\n\r\n") {
                    let _ = tx.send(serde_json::from_str::<serde_json::Value>(b).unwrap_or(serde_json::Value::Null));
                }
                "{\"ok\":true}".to_string()
            };
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len());
            let _ = socket.write_all(resp.as_bytes()).await;
        }
    });
    (address, rx)
}

#[tokio::test]
#[nolog]
async fn a_turn_edge_of_an_agent_in_charge_kicks_the_pass_and_the_post_says_it() {
    use std::sync::Arc;
    let engine = crate::engine::Engine::for_tests(std::env::temp_dir().join("orgtree-presence-unused"));
    let (ann, boss) = (101_i64, 102_i64);
    let mut rx_keep = Vec::new();
    for id in [ann, boss] {
        let (tx, r) = tokio::sync::mpsc::unbounded_channel();
        rx_keep.push(r);
        engine.agents.map.pin().insert(id, Arc::new(crate::runtime::AgentHandle { id, org_id: 7, tx,
            view: arc_swap::ArcSwap::from_pointee(json!({ "busy": false })),
            helpers: arc_swap::ArcSwap::from_pointee(json!({ "count": 0, "items": [], "truncated": false })) }));
    }
    engine.net.presence.set_in_charge(7, &[ann]);
    async fn kicked(engine: &crate::engine::Engine) -> bool {
        tokio::time::timeout(Duration::from_millis(200), engine.net.kick.notified()).await.is_ok()
    }

    // boss holds nothing: its turns kick nothing
    turn_edge(&engine, boss, &json!({ "busy": false }), &json!({ "busy": true }));
    assert!(!kicked(&engine).await, "an agent not in charge: no kick");
    // ann's turn starts: the pass runs at once
    engine.agents.get(ann).unwrap().view.store(Arc::new(json!({ "busy": true })));
    turn_edge(&engine, ann, &json!({ "busy": false }), &json!({ "busy": true }));
    assert!(kicked(&engine).await, "a turn of an agent in charge kicks the pass");
    turn_edge(&engine, ann, &json!({ "busy": true }), &json!({ "busy": true }));
    assert!(!kicked(&engine).await, "no flip (another runtime change): no kick");

    // the pass: mid-turn from the live view
    assert!(running(&engine, ann) && !running(&engine, boss));
    let (active, at) = last_active(&[(running(&engine, ann), Some(1_764_000_000_123)), (running(&engine, boss), None)]);
    assert_eq!((active, at), (true, Some(1_764_000_000_123)), "ann mid-turn: active, with the newest finished turn's end");
    drop(rx_keep);
}

/// The post of the pass to each hub. `tell` goes out through the org mailbox's admission gate (`isolation::run` ->
/// `orginbox::require_enabled`, which reads `ot.orgs`), so this half runs against the same isolated
/// `orginbox_queue_fixture` database as `domain::orginbox::queue_tests`:
/// `cargo test -p orgtree-engine -- --ignored --test-threads=1 net::presence::tests::the_pass_tells`.
#[tokio::test]
#[ignore = "needs the orginbox_queue_fixture PostgreSQL database (ORGTREE_ORGINBOX_TEST_URL, ORGTREE_ORGINBOX_TEST_ROOT)"]
#[nolog]
async fn the_pass_tells_a_hub_with_last_active_the_turn_and_an_older_hub_only_a_change() {
    use std::sync::Arc;
    use tokio_postgres::NoTls;
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    assert_eq!(cfg.get_user(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'acme','Acme','{}') RETURNING id", &[]).await.unwrap().get(0);
    let mut engine = crate::engine::Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_ORGINBOX_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    engine.orgs.insert(crate::orgs::provisional(org, "acme".into(), "acme".into(), "Acme".into()));

    let says = Says { busy: false, dnd: false, active: true, active_at: Some(1_764_000_000_123) };
    let (new_hub, mut new_rx) = fake_hub(&["busy", "dnd", "last_active"]).await;
    let (old_hub, mut old_rx) = fake_hub(&["busy", "dnd"]).await;
    assert!(hub_last_active(&engine, org, "new", &new_hub).await, "a hub that lists last_active");
    assert!(!hub_last_active(&engine, org, "old", &old_hub).await, "a hub that doesn't");
    let p = super::Part { org_id: org, slug: "acme".into(), name: "Acme".into(), net_slug: "acme.user.abc123".into(), secret: "s3cret".into(),
        hubs: vec![("new".into(), new_hub.clone()), ("old".into(), old_hub.clone())],
        registered: ["new".to_string(), "old".to_string()].into_iter().collect() };
    tell(&engine, &p, &[("new", new_hub.as_str(), true), ("old", old_hub.as_str(), false)], says).await;
    let got = new_rx.try_recv().expect("the new hub is told");
    assert_eq!((got["active"].clone(), got["active_at"].clone()), (json!(true), json!("2025-11-24T16:00:00.123Z")), "{got}");
    assert!(got["now"].is_string(), "{got}");
    assert_eq!(old_rx.try_recv().expect("the old hub is told too, as ever"), json!({ "slug": "acme.user.abc123", "busy": false, "dnd": false }));

    // the turn ends: the new hub hears it, the old one nothing
    let says = Says { active: false, active_at: Some(1_764_000_100_000), ..says };
    tell(&engine, &p, &[("new", new_hub.as_str(), true), ("old", old_hub.as_str(), false)], says).await;
    assert_eq!(new_rx.try_recv().expect("the turn end is said")["active_at"], json!("2025-11-24T16:01:40.000Z"));
    assert!(old_rx.try_recv().is_err(), "an older hub's traffic stays as it was: a turn is no news to it");
}
