//! Migration 0077 and fire bodies (USER 2026-10-27 mc308cabf3c5f "Save
//! exactly" and "Agents see bodies", after mda08162683ef "this should show the
//! event's body as it was transmitted"). A pre-0077 database in an owned
//! disposable rig cluster (never live data) holds a copy whose History has a
//! fire the delivery outbox still holds, one it no longer holds, and a start.
//! After the upgrade the first shows the outbox's body, the others none. A new
//! fire through the engine's own publish keeps its body exactly as sent, and
//! its History row and the subscription's fires list both return it.
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};

#[test]
#[nolog]
fn fire_body_migration_is_registered_after_mention_recency() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let bodies = at("0077_panel_event_bodies").expect("0077 registered");
    assert!(bodies > at("0076_mention_recency").unwrap(), "after 0076");
    let sql = super::MIGRATIONS[bodies].1;
    for needle in ["ADD COLUMN body text", "octet_length(body) <= 131072", "CREATE INDEX custom_panel_events_fire",
        "SET body = f.payload::text", "f.uid = e.payload->>'id'"] {
        assert!(sql.contains(needle), "0077 lacks {needle}");
    }
}

/// A fresh database in the owned rig cluster with every migration before 0077.
#[nolog]
async fn staged() -> (crate::domain::native_fixture::Fixture, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("fire_bodies_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < "0077") {
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(sql).await.unwrap_or_else(|e| panic!("staging {name}: {e}"));
        tx.execute("INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)", &[name, &super::checksum(sql)]).await.unwrap();
        tx.commit().await.unwrap();
    }
    (fixture, client, task)
}

#[nolog]
async fn one_i64(c: &Client, sql: &str) -> i64 {
    c.query_one(sql, &[]).await.unwrap().get(0)
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn fires_keep_their_body_as_sent_and_older_fires_keep_what_the_outbox_still_holds() {
    let (fixture, mut c, task) = staged().await;
    c.batch_execute(r#"
        INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'bodies', 'Bodies');
        INSERT INTO ot.agents (org_id, name, tier, state, born) SELECT id, 'watcher', 'sol', 'live', 'synthetic' FROM ot.orgs WHERE slug = 'bodies';
        INSERT INTO ot.custom_apps (org_id, name, html, created_by, declared_events)
          SELECT id, 'Runner', '<p>x</p>', 'watcher', '[{"name":"run.ended"}]' FROM ot.orgs WHERE slug = 'bodies';
        INSERT INTO ot.custom_panels (org_id, app_id, label, is_open) SELECT id, 'runner', 'Panel 1', false FROM ot.orgs WHERE slug = 'bodies';
        -- before the upgrade: a fire the outbox still holds, one it no longer holds, and a start
        INSERT INTO ot.app_event_fires (uid, org_id, app_id, panel_id, name, payload, producer, done)
          SELECT 'app-event-kept', id, 'runner', 'runner-panel-1', 'run.ended', '{"z": 1, "a": [1, 2]}', '{"kind":"user"}', true FROM ot.orgs WHERE slug = 'bodies';
        INSERT INTO ot.custom_panel_events (org_id, panel_id, kind, name, payload, actor)
          SELECT o.id, 'runner-panel-1', 'history', x.name, x.payload::jsonb, 'user' FROM ot.orgs o, (VALUES
            (1, 'panel.started', '{"reason":"opened"}'),
            (2, 'event.fired', '{"event":"run.ended","id":"app-event-gone","subscribers":0}'),
            (3, 'event.fired', '{"event":"run.ended","id":"app-event-kept","subscribers":0}')) AS x(n, name, payload)
          WHERE o.slug = 'bodies' ORDER BY x.n;
    "#).await.unwrap();
    let org = one_i64(&c, "SELECT id FROM ot.orgs WHERE slug = 'bodies'").await;
    assert!(c.query_opt("SELECT 1 FROM information_schema.columns WHERE table_schema = 'ot' AND table_name = 'custom_panel_events' AND column_name = 'body'", &[])
        .await.unwrap().is_none(), "the staged database is pre-0077");
    super::run(&mut c, &|_| {}).await.unwrap();
    let upgraded: Vec<(String, Option<String>)> = c.query("SELECT coalesce(payload->>'id', name), body FROM ot.custom_panel_events WHERE org_id = $1 ORDER BY seq", &[&org])
        .await.unwrap().iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(upgraded, vec![("panel.started".to_string(), None), ("app-event-gone".to_string(), None),
        ("app-event-kept".to_string(), Some(r#"{"a": [1, 2], "z": 1}"#.to_string()))],
        "an older fire shows the body the outbox still holds, as jsonb stored it; none where it is gone, and a start has none");

    // A new fire through the engine's own publish, with a listener so its fires list can show it.
    let watcher = one_i64(&c, "SELECT id FROM ot.agents WHERE name = 'watcher'").await;
    c.execute(r#"INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, interval_s, state, memo)
        VALUES ('dog-runs', $1, $2, 'runs', 'app_listener', 'runner', 0, 'armed', '{"event_name":"run.ended","panel":"runner-panel-1","all_panels":false}')"#,
        &[&org, &watcher]).await.unwrap();
    // key order, an escaped quote and tab, braces in a string, a non-ASCII letter, a decimal
    let sent = r#"{"z":1,"a":{"y":"é","b":[1,2.5,null,true]},"n":10,"note":"tab\tquote\" brace{"}"#;
    let payload: Value = serde_json::from_str(sent).unwrap();
    let tx = c.transaction().await.unwrap();
    let fired = crate::domain::apps::events::publish(&tx, org, "runner-panel-1", "run.ended", &payload, json!({"kind": "user"})).await.unwrap();
    tx.commit().await.unwrap();
    let uid = fired["event"].as_str().unwrap().to_string();
    assert_eq!(fired["subscribers"], 1);
    let row = c.query_one("SELECT payload, body FROM ot.custom_panel_events WHERE org_id = $1 AND payload->>'id' = $2", &[&org, &uid]).await.unwrap();
    let (meta, body): (Value, Option<String>) = (row.get(0), row.get(1));
    assert_eq!(body.as_deref(), Some(sent), "History keeps the body exactly as sent");
    assert_eq!(meta, json!({"event": "run.ended", "id": uid, "subscribers": 1}), "beside the fire's metadata");
    let outbox: String = c.query_one("SELECT payload::text FROM ot.app_event_fires WHERE uid = $1", &[&uid]).await.unwrap().get(0);
    assert_ne!(outbox, sent, "the outbox's jsonb copy is normalized; only History keeps the text as sent");

    // Delivered (as the dispatcher would record it): the subscription's fires list carries the same body.
    c.execute(r#"UPDATE ot.app_event_recipients SET done = true, delivery = '{"notice":true}' WHERE fire_id = (SELECT id FROM ot.app_event_fires WHERE uid = $1)"#, &[&uid])
        .await.unwrap();
    let tx = c.transaction().await.unwrap();
    let fires = crate::domain::apps::events::listener_fires(&tx, org, "runner", "watcher/dog-runs", ("<", "DESC", i64::MAX), 50).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(fires["fires"].as_array().map(Vec::len), Some(1), "{fires}");
    assert_eq!(fires["fires"][0]["body"].as_str(), Some(sent), "Connections shows the body its History row keeps");
    std::fs::write(fixture.engine_root("fire-bodies").join("bodies.json"),
        json!({ "upgraded": upgraded, "sent": sent, "history": body, "outbox": outbox, "connections": fires["fires"][0]["body"] }).to_string()).unwrap();
    drop(c);
    task.await.unwrap();
}
