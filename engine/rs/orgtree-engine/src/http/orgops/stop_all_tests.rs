//! Stop All's latch, its app panel power-off and its watchdog pause commit
//! together, before any agent wait (4.5.0 review B10, alpha3 489e3953e566 F2;
//! USER 2026-10-26: Stop all powers off every app panel, hidden ones included,
//! and release starts none of them again). Native checks, each on a fresh
//! database in an owned disposable rig cluster, never live data: a Stop All
//! that ends right after its latch commits, or whose power-off fails, never
//! leaves a latched org whose panels are still marked to run, which a release
//! would hand back; and a start racing Stop All waits for its latch.
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use serde_json::json;
use tokio_postgres::{Client, NoTls};

use super::{killswitch, killswitch_release, STOP_AFTER_LATCH};
use crate::engine::Engine;

/// A fresh, fully migrated database in the owned rig cluster with one open org:
/// an app with a visible running panel, a hidden running copy and a closed copy,
/// and one armed watchdog. Returns an engine on it, a client, the org and its slug.
#[nolog]
async fn org_with_panels(label: &str) -> (Arc<Engine>, Client, i64, String) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("stop_all_{label}_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut c, conn) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = conn.await; });
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let slug = format!("stop-all-{label}");
    let org: i64 = c.query_one("INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), $1, 'Stop all') RETURNING id", &[&slug])
        .await.unwrap().get(0);
    let writer: i64 = c.query_one("INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&org])
        .await.unwrap().get(0);
    c.batch_execute(&format!("
        INSERT INTO ot.custom_apps (org_id, id, name, html, created_by) VALUES ({org}, 'board', 'Board', '<p>board</p>', 'writer');
        INSERT INTO ot.custom_panels (org_id, id, app_id, label, is_open, is_running) VALUES
          ({org}, 'board-shown', 'board', 'Panel 1', true, true),
          ({org}, 'board-hidden', 'board', 'Panel 2', false, true),
          ({org}, 'board-off', 'board', 'Panel 3', false, false);
        INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, interval_s, state, memo) VALUES
          ('stop-all-dog', {org}, {writer}, 'board-file', 'file', 'board.txt', 15, 'armed', '{{}}');")).await.unwrap();
    let mut engine = Engine::for_tests(fixture.engine_root(&format!("stop-all-{label}-engine")));
    let manager = deadpool_postgres::Manager::from_config(cfg, NoTls,
        deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(manager).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    engine.orgs.insert(crate::orgs::provisional(org, uuid::Uuid::new_v4().to_string(), slug.clone(), slug.clone()));
    (engine, c, org, slug)
}

/// What is committed: the latch, the panels still marked to run and the armed watchdogs.
#[nolog]
async fn committed(c: &Client, org: i64) -> (bool, Vec<String>, i64) {
    let latched: bool = c.query_one("SELECT killswitch IS NOT NULL FROM ot.orgs WHERE id = $1", &[&org]).await.unwrap().get(0);
    let marked: Vec<String> = c.query("SELECT id FROM ot.custom_panels WHERE org_id = $1 AND (is_running OR is_open) ORDER BY id", &[&org])
        .await.unwrap().iter().map(|r| r.get(0)).collect();
    let armed: i64 = c.query_one("SELECT count(*) FROM ot.watchdogs WHERE org_id = $1 AND state = 'armed'", &[&org]).await.unwrap().get(0);
    (latched, marked, armed)
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn stop_all_ended_after_its_latch_leaves_no_panel_marked_to_run() {
    let (engine, c, org, slug) = org_with_panels("ended").await;
    let out = STOP_AFTER_LATCH.scope(true, killswitch(State(engine.clone()), Path(slug.clone()))).await;
    assert!(out.is_err(), "the request ended right after its latch committed");
    let (latched, marked, armed) = committed(&c, org).await;
    assert!(latched, "the latch committed before the request ended");
    assert_eq!(marked, Vec::<String>::new(), "a latched org has no panel still marked to run");
    assert_eq!(armed, 0, "the watchdog pause committed with the latch");
    // After a restart the user releases the latch: nothing comes back.
    let released = killswitch_release(State(engine.clone()), Path(slug.clone())).await.unwrap();
    assert_eq!(released.0["released"], true);
    let (latched, marked, _) = committed(&c, org).await;
    assert!(!latched);
    assert_eq!(marked, Vec::<String>::new(), "release starts none of them again");
    let stopped: i64 = c.query_one("SELECT count(*) FROM ot.custom_panel_events WHERE org_id = $1 AND name = 'panel.stopped' AND payload->>'reason' = 'stop all'", &[&org])
        .await.unwrap().get(0);
    assert_eq!(stopped, 2, "both running panels record panel.stopped for Stop all");
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn stop_all_whose_power_off_fails_latches_nothing() {
    let (engine, c, org, slug) = org_with_panels("failed").await;
    // The power-off fails in this test's own database.
    c.batch_execute("CREATE FUNCTION public.refuse_power_off() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic failure powering a panel off'; END $$;
        CREATE TRIGGER refuse_power_off BEFORE UPDATE ON ot.custom_panels FOR EACH ROW
            WHEN (OLD.is_running AND NOT NEW.is_running) EXECUTE FUNCTION public.refuse_power_off();").await.unwrap();
    let out = killswitch(State(engine.clone()), Path(slug.clone())).await;
    assert!(out.is_err(), "the power-off failed");
    let (latched, marked, armed) = committed(&c, org).await;
    assert!(!latched, "a Stop All that could not power its panels off latches nothing");
    assert_eq!(armed, 1, "nor pauses a watchdog");
    assert_eq!(marked, ["board-hidden", "board-shown"], "the panels are as they were");
    // CONTROL: once the power-off works, Stop All latches with every panel off.
    c.batch_execute("DROP TRIGGER refuse_power_off ON ot.custom_panels").await.unwrap();
    let out = killswitch(State(engine.clone()), Path(slug.clone())).await.unwrap();
    assert_eq!((&out.0["latched"], &out.0["panels_stopped"]), (&json!(true), &json!(2)));
    let (latched, marked, armed) = committed(&c, org).await;
    assert!(latched && marked.is_empty() && armed == 0, "latched {latched}, marked {marked:?}, armed {armed}");
    killswitch_release(State(engine.clone()), Path(slug.clone())).await.unwrap();
    let (latched, marked, _) = committed(&c, org).await;
    assert!(!latched && marked.is_empty(), "release starts nothing: latched {latched}, marked {marked:?}");
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn a_start_racing_stop_all_waits_for_its_latch() {
    let (engine, mut c, org, slug) = org_with_panels("race").await;
    let o = engine.orgs.get(&slug).expect("open org");
    // Stop All's latch, written but not yet committed (its power-off still running).
    let latch = c.transaction().await.unwrap();
    latch.execute("UPDATE ot.orgs SET killswitch = '{\"by\":\"@user\"}' WHERE id = $1", &[&org]).await.unwrap();
    let mut start = tokio::spawn(async move {
        crate::domain::apps::run(&engine, &o, None, &json!({ "action": "panel_start", "panel": "board-off" })).await
    });
    // A start that did not wait would be done well within this.
    let early = tokio::time::timeout(Duration::from_secs(2), &mut start).await;
    let waited = early.is_err();
    latch.commit().await.unwrap();
    let out = match early { Ok(done) => done, Err(_) => start.await }.unwrap();
    assert!(waited, "a start waits while Stop All's latch is uncommitted; it returned {out:?}");
    let err = out.expect_err("a start that waited for Stop All sees its latch");
    assert!(format!("{err:#}").contains("Stop all is on"), "{err:#}");
    let (_, marked, _) = committed(&c, org).await;
    assert!(!marked.contains(&"board-off".to_string()), "the closed copy stays off: {marked:?}");
}
