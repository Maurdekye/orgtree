//! Migration 0075: apps and panels are identified by readable slugs (user
//! 2026-10-27 mc70ab563f21d). The slug becomes the id and the old generic id
//! stays as legacy_id. The native checks stage a pre-0075 database in an owned
//! disposable rig cluster (never live data), fill it with real-shaped apps,
//! panels and everything that names them, upgrade it, and then use the old ids
//! through the Apps tool and app_listener sources.
use std::sync::Arc;

use serde_json::{json, Value};
use tokio_postgres::{Client, Config, NoTls};

use crate::engine::Engine;
use crate::orgs::OrgHandle;

#[test]
#[nolog]
fn app_panel_slugs_migration_is_registered_with_triggers_resolvers_and_rewrite() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let slugs = at("0075_app_panel_slugs").expect("0075 registered");
    assert!(slugs > at("0073_document_slugs").unwrap(), "after 0073");
    let sql = super::MIGRATIONS[slugs].1;
    for needle in ["ALTER TABLE ot.custom_apps ADD COLUMN legacy_id text", "ALTER TABLE ot.custom_panels ADD COLUMN legacy_id text",
        "CREATE UNIQUE INDEX custom_apps_legacy_id ON ot.custom_apps (org_id, legacy_id) WHERE legacy_id IS NOT NULL",
        "CREATE UNIQUE INDEX custom_panels_legacy_id ON ot.custom_panels (org_id, legacy_id) WHERE legacy_id IS NOT NULL",
        // made like presentation slugs, one org at a time, on every insert path
        "ot.slug_base(p_name, 48) ELSE p_fallback", "pg_advisory_xact_lock(hashtextextended('ot.custom_apps.slug/'",
        "pg_advisory_xact_lock(hashtextextended('ot.custom_panels.slug/'", "CREATE TRIGGER custom_apps_slug BEFORE INSERT ON ot.custom_apps",
        "CREATE TRIGGER custom_panels_slug BEFORE INSERT ON ot.custom_panels", "ot.named_slug_base(NEW.name, 'app')",
        "rtrim(left(p_app, 32), '-') || ' ' || coalesce(p_label, ''), 'panel'",
        // an old id is taken, and a reference resolves in its own org only
        "(a.id = candidate OR a.legacy_id = candidate)", "(p.id = candidate OR p.legacy_id = candidate)",
        "WHERE org_id = p_org AND (id = p_ref OR legacy_id = p_ref)", "ORDER BY id = p_ref DESC LIMIT 1",
        // every key that names an app or panel moves, oldest first
        "pg_get_constraintdef(c.oid)", "ORDER BY org_id, created_at, id", "UPDATE ot.watchdogs w SET target = a.id",
        "jsonb_set(w.memo, '{panel}', to_jsonb(p.id))", "UPDATE ot.custom_app_permission_log h SET panel_id = p.id",
        "CHECK ((id COLLATE \"C\") ~ '^[a-z0-9]+(-[a-z0-9]+)*$')"] {
        assert!(sql.contains(needle), "0075 lacks {needle}");
    }
    // no insert path names an app or panel itself any more
    for (file, src) in [("storage.rs", include_str!("../domain/apps/storage.rs")), ("templates.rs", include_str!("../domain/apps/templates.rs"))] {
        assert!(!src.contains("uid(\"app\")") && !src.contains("uid(\"panel\")"), "{file} still makes a generic app or panel id");
    }
}

/// A fresh database in the owned rig cluster with every migration before 0075
/// applied and recorded the way `run` records them.
#[nolog]
async fn staged(label: &str) -> (crate::domain::native_fixture::Fixture, Config, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("app_slugs_{label}_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < "0075") {
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(sql).await.unwrap_or_else(|e| panic!("staging {name}: {e}"));
        tx.execute("INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)", &[name, &super::checksum(sql)]).await.unwrap();
        tx.commit().await.unwrap();
    }
    (fixture, cfg, client, task)
}

/// An engine whose pool is the staged database, with the orgs open.
#[nolog]
fn engine(fixture: &crate::domain::native_fixture::Fixture, cfg: &Config, label: &str, orgs: &[(i64, &str)]) -> Arc<Engine> {
    let mut engine = Engine::for_tests(fixture.engine_root(label));
    let manager = deadpool_postgres::Manager::from_config(cfg.clone(), NoTls,
        deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(manager).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    for (id, slug) in orgs {
        engine.orgs.insert(crate::orgs::provisional(*id, uuid::Uuid::new_v4().to_string(), slug.to_string(), slug.to_string()));
    }
    engine
}

#[nolog]
fn org(engine: &Engine, slug: &str) -> Arc<OrgHandle> {
    engine.orgs.get(slug).expect("open org")
}

#[nolog]
async fn one_i64(c: &Client, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> i64 {
    c.query_one(sql, params).await.unwrap().get(0)
}

#[nolog]
async fn one_text(c: &Client, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Option<String> {
    c.query_one(sql, params).await.unwrap().get(0)
}

#[nolog]
async fn count(c: &Client, sql: &str) -> i64 {
    one_i64(c, sql, &[]).await
}

#[nolog]
async fn app_ref(c: &Client, org: i64, reference: &str) -> Option<String> {
    one_text(c, "SELECT ot.custom_app_ref($1, $2)", &[&org, &reference]).await
}

#[nolog]
async fn panel_ref(c: &Client, org: i64, reference: &str) -> Option<String> {
    one_text(c, "SELECT ot.custom_panel_ref($1, $2)", &[&org, &reference]).await
}

/// A watchdog's target and listened panel.
#[nolog]
async fn dog(c: &Client, uid: &str) -> (String, Option<String>) {
    let row = c.query_one("SELECT target, memo->>'panel' FROM ot.watchdogs WHERE uid = $1", &[&uid]).await.unwrap();
    (row.get(0), row.get(1))
}

const LONG: &str = "Quarterly planning dashboard for the platform team and leadership reviews";

/// Two orgs of real-shaped apps, panels and everything that names them, all by
/// old generic ids, as a 4.5.0-alpha.5 database holds them. Returns (a, b).
#[nolog]
async fn fill(c: &Client) -> (i64, i64) {
    let a = one_i64(c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'apps-a', 'Apps A') RETURNING id", &[]).await;
    let b = one_i64(c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'apps-b', 'Apps B') RETURNING id", &[]).await;
    let writer = one_i64(c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    let other = one_i64(c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'other', 'sol', 'live', 'synthetic') RETURNING id", &[&b]).await;
    // (org, old id, name, minutes ago); created_at decides who keeps the plain slug
    let apps: Vec<(i64, &str, String, i32)> = vec![
        (a, "app00000000a001", "Caption board".into(), 90), (a, "app00000000a002", "Caption board".into(), 80),
        (a, "app00000000a003", "Caption Board!!".into(), 70), (a, "app00000000a004", "לוח כתוביות".into(), 60),
        (a, "app00000000a005", "日本語".into(), 50), (a, "app00000000a006", "app00000000a001".into(), 40),
        (a, "app00000000a007", LONG.into(), 30), (a, "app00000000a008", "Notes".into(), 20),
        (b, "app00000000b001", "Caption board".into(), 10),
    ];
    for (org, id, name, ago) in &apps {
        c.execute("INSERT INTO ot.custom_apps (org_id, id, name, html, created_by, declared_events, created_at)
                   VALUES ($1, $2, $3, '<p>app</p>', 'writer', '[{\"name\":\"caption.ready\"}]', now() - make_interval(mins => $4))",
            &[org, id, name, ago]).await.unwrap();
    }
    // (org, old id, app, label, minutes ago)
    let panels: Vec<(i64, &str, &str, &str, i32)> = vec![
        (a, "panel0000000a101", "app00000000a001", "Panel 1", 89), (a, "panel0000000a102", "app00000000a001", "Panel 2", 88),
        (a, "panel0000000a103", "app00000000a002", "Panel 1", 79), (a, "panel0000000a104", "app00000000a004", "Panel 1", 59),
        (a, "panel0000000a105", "app00000000a005", "Panel 1", 49), (a, "panel0000000a106", "app00000000a008", "Main view", 19),
        (a, "panel0000000a107", "app00000000a008", "Main view", 18), (a, "panel0000000a108", "app00000000a007", "Panel 1", 29),
        (b, "panel0000000b101", "app00000000b001", "Panel 1", 9),
    ];
    for (org, id, app, label, ago) in &panels {
        c.execute("INSERT INTO ot.custom_panels (org_id, id, app_id, label, is_open, is_running, created_at, used_at)
                   VALUES ($1, $2, $3, $4, false, false, now() - make_interval(mins => $5), now() - make_interval(mins => $5))",
            &[org, id, app, label, ago]).await.unwrap();
    }
    // History and messages, an event fire with its recipient, file grants and links, permission history
    c.batch_execute(&format!("
        INSERT INTO ot.custom_panel_events (org_id, panel_id, kind, name, payload, actor) VALUES
          ({a}, 'panel0000000a101', 'history', 'panel.started', '{{}}', 'user'),
          ({a}, 'panel0000000a101', 'message', 'note.saved', '{{\"text\":\"hi\"}}', 'app'),
          ({a}, 'panel0000000a106', 'history', 'panel.stopped', '{{}}', 'user');
        INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, interval_s, state, memo) VALUES
          ('dog-caption', {a}, {writer}, 'captions', 'app_listener', 'app00000000a001', 0, 'armed',
           '{{\"event_name\":\"caption.ready\",\"panel\":\"panel0000000a101\",\"all_panels\":false}}'),
          ('dog-notes', {a}, {writer}, 'notes-all', 'app_listener', 'app00000000a008', 0, 'paused',
           '{{\"event_name\":\"caption.ready\",\"panel\":null,\"all_panels\":true}}'),
          ('dog-gone', {a}, {writer}, 'gone', 'app_listener', 'app0000000dead', 0, 'paused',
           '{{\"event_name\":\"x\",\"panel\":\"panel000000dead\",\"all_panels\":false}}'),
          ('dog-file', {a}, {writer}, 'file', 'file', 'app00000000a001', 15, 'armed', '{{}}'),
          ('dog-other', {b}, {other}, 'other', 'app_listener', 'app00000000b001', 0, 'armed',
           '{{\"event_name\":\"caption.ready\",\"panel\":\"panel0000000b101\",\"all_panels\":false}}');
        INSERT INTO ot.app_event_fires (uid, org_id, app_id, panel_id, name, payload, producer, done) VALUES
          ('app-event-1', {a}, 'app00000000a001', 'panel0000000a101', 'caption.ready', '{{}}', '{{\"kind\":\"user\"}}', false);
        INSERT INTO ot.app_event_recipients (fire_id, dog_id)
          SELECT f.id, w.id FROM ot.app_event_fires f, ot.watchdogs w WHERE f.uid = 'app-event-1' AND w.uid = 'dog-caption';
        INSERT INTO ot.custom_app_file_grants (org_id, app_id, id, app_rev, scope, path, mode, implicit) VALUES
          ({a}, 'app00000000a001', 'app-grant-1', 1, 'orgtree', NULL, 'read', true);
        INSERT INTO ot.custom_app_file_refs (org_id, app_id, panel_id, id, app_rev, grant_id, path) VALUES
          ({a}, 'app00000000a001', 'panel0000000a101', 'file-1', 1, 'app-grant-1', 'notes.txt');
        INSERT INTO ot.custom_app_permission_log (org_id, app_id, capability, permission, via, actor, panel_id) VALUES
          ({a}, 'app00000000a001', 'net.fetch', 'deny', 'prompt', 'user', 'panel0000000a101'),
          ({a}, 'app00000000a001', 'net.fetch', 'once', 'prompt', 'user', 'panel000000dead');")).await.unwrap();
    (a, b)
}

/// Every foreign key that points at apps, panels or file grants, by name and definition.
#[nolog]
async fn keys(c: &Client) -> Vec<(String, String)> {
    c.query("SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'f'
              AND confrelid IN ('ot.custom_apps'::regclass, 'ot.custom_panels'::regclass, 'ot.custom_app_file_grants'::regclass)
              ORDER BY 1", &[]).await.unwrap().iter().map(|r| (r.get(0), r.get(1))).collect()
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn staged_pre_0075_apps_and_panels_get_slugs_on_upgrade() {
    let (fixture, _cfg, mut c, task) = staged("upgrade").await;
    let (a, b) = fill(&c).await;
    let before = keys(&c).await;
    assert!(before.len() >= 8, "the staged schema has its app and panel keys: {before:?}");
    assert!(c.query_opt("SELECT 1 FROM information_schema.columns WHERE table_schema = 'ot' AND table_name = 'custom_apps' AND column_name = 'legacy_id'", &[]).await.unwrap().is_none(),
        "the staged database is pre-0075");
    super::run(&mut c, &|_| {}).await.unwrap();

    // apps: oldest first keeps the plain slug; no Latin letters is `app`; an old id is never handed out
    let long = crate::util::slugify(LONG, 48);
    let want_apps = [(a, "app00000000a001", "caption-board".to_string()), (a, "app00000000a002", "caption-board-2".into()),
        (a, "app00000000a003", "caption-board-3".into()), (a, "app00000000a004", "app".into()), (a, "app00000000a005", "app-2".into()),
        (a, "app00000000a006", "app00000000a001-2".into()), (a, "app00000000a007", long.clone()), (a, "app00000000a008", "notes".into()),
        (b, "app00000000b001", "caption-board".into())];
    let mut got = serde_json::Map::new();
    for (org, old, want) in &want_apps {
        let id = one_text(&c, "SELECT id FROM ot.custom_apps WHERE org_id = $1 AND legacy_id = $2", &[org, old]).await;
        assert_eq!(id.as_deref(), Some(want.as_str()), "app {old}");
        got.insert(old.to_string(), json!(want));
    }
    // panels: their app's slug and label, unique in the whole org, oldest first
    let long_panel = crate::util::slugify(&format!("{} Panel 1", long[..32].trim_end_matches('-')), 48);
    let want_panels = [(a, "panel0000000a101", "caption-board-panel-1".to_string(), "caption-board"),
        (a, "panel0000000a102", "caption-board-panel-2".into(), "caption-board"), (a, "panel0000000a103", "caption-board-2-panel-1".into(), "caption-board-2"),
        (a, "panel0000000a104", "app-panel-1".into(), "app"), (a, "panel0000000a105", "app-2-panel-1".into(), "app-2"),
        (a, "panel0000000a106", "notes-main-view".into(), "notes"), (a, "panel0000000a107", "notes-main-view-2".into(), "notes"),
        (a, "panel0000000a108", long_panel.clone(), long.as_str()), (b, "panel0000000b101", "caption-board-panel-1".into(), "caption-board")];
    for (org, old, want, app) in &want_panels {
        let row = c.query_one("SELECT id, app_id FROM ot.custom_panels WHERE org_id = $1 AND legacy_id = $2", &[org, old]).await.unwrap();
        assert_eq!((row.get::<_, String>(0), row.get::<_, String>(1)), (want.clone(), app.to_string()), "panel {old}");
        got.insert(old.to_string(), json!(want));
    }
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.custom_apps WHERE legacy_id IS NULL", &[]).await, 0);
    // everything that named them now names the slugs
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_panel_events WHERE panel_id = 'caption-board-panel-1'").await, 2, "History and messages");
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_panel_events WHERE panel_id = 'notes-main-view'").await, 1);
    assert_eq!(count(&c, "SELECT count(*) FROM ot.app_event_fires WHERE app_id = 'caption-board' AND panel_id = 'caption-board-panel-1'").await, 1, "the pending fire");
    assert_eq!(count(&c, "SELECT count(*) FROM ot.app_event_recipients r JOIN ot.app_event_fires f ON f.id = r.fire_id WHERE f.uid = 'app-event-1'").await, 1);
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_app_file_grants WHERE app_id = 'caption-board' AND id = 'app-grant-1'").await, 1);
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_app_file_refs WHERE app_id = 'caption-board' AND panel_id = 'caption-board-panel-1' AND grant_id = 'app-grant-1'").await, 1);
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_app_permission_log WHERE app_id = 'caption-board' AND panel_id = 'caption-board-panel-1'").await, 1);
    assert_eq!(count(&c, "SELECT count(*) FROM ot.custom_app_permission_log WHERE app_id = 'caption-board' AND panel_id = 'panel000000dead'").await, 1,
        "a deleted panel's history keeps the id it had");
    assert_eq!(dog(&c, "dog-caption").await, ("caption-board".into(), Some("caption-board-panel-1".into())));
    assert_eq!(dog(&c, "dog-notes").await, ("notes".into(), None), "an all-panels listener");
    assert_eq!(dog(&c, "dog-gone").await, ("app0000000dead".into(), Some("panel000000dead".into())), "a removed source stays");
    assert_eq!(dog(&c, "dog-file").await.0, "app00000000a001", "only app listeners name apps");
    assert_eq!(dog(&c, "dog-other").await.0, "caption-board", "each org's own");
    // the keys are back exactly as they were, and still cascade
    assert_eq!(keys(&c).await, before, "every foreign key restored as it was");
    // references resolve by slug or old id, in their own org only
    assert_eq!(app_ref(&c, a, "app00000000a001").await.as_deref(), Some("caption-board"));
    assert_eq!(app_ref(&c, a, "caption-board").await.as_deref(), Some("caption-board"));
    assert_eq!(app_ref(&c, a, "app00000000a001-2").await.as_deref(), Some("app00000000a001-2"), "a slug wins over an old id");
    assert_eq!(app_ref(&c, a, "app00000000b001").await, None, "another org's old id");
    assert_eq!(app_ref(&c, b, "caption-board").await.as_deref(), Some("caption-board"));
    assert_eq!(panel_ref(&c, a, "panel0000000a101").await.as_deref(), Some("caption-board-panel-1"));
    assert_eq!(panel_ref(&c, a, "panel0000000b101").await, None);
    // from here on every id is a slug, made by the database
    assert!(c.execute("UPDATE ot.custom_apps SET id = 'Bad Id' WHERE org_id = $1 AND id = 'notes'", &[&a]).await.is_err(), "app id alphabet");
    assert!(c.execute("UPDATE ot.custom_panels SET id = 'a--b' WHERE org_id = $1 AND id = 'notes-main-view'", &[&a]).await.is_err(), "panel id alphabet");
    let made = one_text(&c, "INSERT INTO ot.custom_apps (org_id, name, html, created_by) VALUES ($1, 'Caption board', '<p>x</p>', 'user') RETURNING id", &[&a]).await;
    assert_eq!(made.as_deref(), Some("caption-board-4"));
    let asked = one_text(&c, "INSERT INTO ot.custom_apps (org_id, id, name, html, created_by) VALUES ($1, '  Weekly Status!! ', 'דו\"ח שבועי', '<p>x</p>', 'user') RETURNING id", &[&a]).await;
    assert_eq!(asked.as_deref(), Some("weekly-status"), "a requested slug is cleaned like a name");
    let err = c.execute("INSERT INTO ot.custom_apps (org_id, id, name, html, created_by) VALUES ($1, '★★', 'x', '<p>x</p>', 'user')", &[&a]).await.unwrap_err();
    assert!(err.to_string().contains("needs an ASCII letter or digit") || format!("{err:?}").contains("needs an ASCII letter or digit"), "{err:?}");
    let copy = one_text(&c, "INSERT INTO ot.custom_panels (org_id, app_id, label, is_open) VALUES ($1, 'caption-board', 'Panel 3', false) RETURNING id", &[&a]).await;
    assert_eq!(copy.as_deref(), Some("caption-board-panel-3"));
    let again = one_text(&c, "INSERT INTO ot.custom_panels (org_id, app_id, label, is_open) VALUES ($1, 'caption-board-2', 'Panel 1', false) RETURNING id", &[&a]).await;
    assert_eq!(again.as_deref(), Some("caption-board-2-panel-1-2"), "unique in the whole org");
    // a deletion still cascades through the restored keys
    c.execute("DELETE FROM ot.custom_apps WHERE org_id = $1 AND id = 'caption-board'", &[&a]).await.unwrap();
    // (org B's own caption-board stays)
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.custom_panels WHERE org_id = $1 AND app_id = 'caption-board'", &[&a]).await, 0);
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.custom_panel_events WHERE org_id = $1 AND panel_id = 'caption-board-panel-1'", &[&a]).await, 0);
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.custom_app_file_refs WHERE org_id = $1 AND app_id = 'caption-board'", &[&a]).await, 0);
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.custom_panels WHERE org_id = $1 AND app_id = 'caption-board'", &[&b]).await, 1);
    // an applied 0075 is a no-op on the next start
    super::run(&mut c, &|_| {}).await.unwrap();
    std::fs::write(fixture.engine_root("app-slugs").join("upgrade.json"),
        json!({ "ids": got, "keys_restored": before.len(), "made": [made, asked, copy, again], "rerun_noop": true }).to_string()).unwrap();
    drop(c);
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn old_ids_resolve_through_the_apps_tool_and_listeners_after_the_upgrade() {
    let (fixture, cfg, mut c, task) = staged("tool").await;
    let (a, b) = fill(&c).await;
    super::run(&mut c, &|_| {}).await.unwrap();
    let e = engine(&fixture, &cfg, "app-slug-tool", &[(a, "apps-a"), (b, "apps-b")]);
    let o = org(&e, "apps-a");
    let apps = |input: Value| { let (e, o) = (e.clone(), o.clone()); async move { crate::domain::apps::run(&e, &o, None, &input).await } };
    let mut proof = serde_json::Map::new();

    // reads by old id answer with the slug, and the mention token names the slug
    let got = apps(json!({ "action": "app_get", "app": "app00000000a001" })).await.unwrap();
    assert_eq!((got["id"].as_str(), got["ref"].as_str()), (Some("caption-board"), Some("@app:apps-a/caption-board")));
    let panel = apps(json!({ "action": "panel_get", "panel": "panel0000000a101" })).await.unwrap();
    assert_eq!((panel["id"].as_str(), panel["app"].as_str(), panel["ref"].as_str()),
        (Some("caption-board-panel-1"), Some("caption-board"), Some("@panel:apps-a/caption-board-panel-1")));
    let listed = apps(json!({ "action": "list", "kind": "panels", "app": "app00000000a001" })).await.unwrap();
    let ids: Vec<&str> = listed["items"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["caption-board-panel-1", "caption-board-panel-2"]);
    proof.insert("app_get".into(), got["id"].clone());
    proof.insert("panel_get".into(), panel["id"].clone());
    // mention labels: each answer echoes the reference it was asked by; another org's is left out
    let refs = apps(json!({ "action": "refs", "apps": ["app00000000a001", "notes", "missing", "app00000000b001"], "panels": ["panel0000000a106", "caption-board-panel-2"] })).await.unwrap();
    let asked: Vec<(&str, &str)> = refs["apps"].as_array().unwrap().iter().map(|r| (r["asked"].as_str().unwrap(), r["id"].as_str().unwrap())).collect();
    assert_eq!(asked, [("app00000000a001", "caption-board"), ("notes", "notes")]);
    let asked: Vec<(&str, &str, &str)> = refs["panels"].as_array().unwrap().iter()
        .map(|r| (r["asked"].as_str().unwrap(), r["id"].as_str().unwrap(), r["app_name"].as_str().unwrap())).collect();
    assert_eq!(asked, [("panel0000000a106", "notes-main-view", "Notes"), ("caption-board-panel-2", "caption-board-panel-2", "Caption board")]);
    proof.insert("refs".into(), refs.clone());
    let seen = apps(json!({ "action": "mark_seen", "apps": ["app00000000a008"] })).await.unwrap();
    assert_eq!(seen["seen"], json!(["notes"]));
    let listeners = apps(json!({ "action": "listeners", "app": "app00000000a001", "panel": "panel0000000a101" })).await.unwrap();
    assert_eq!(listeners["items"][0]["panel"], "caption-board-panel-1", "{listeners}");
    proof.insert("listeners".into(), listeners["items"][0]["panel"].clone());
    // a mutation by old id: the gate, the lock and the answer all use the slug
    let rev = panel["rev"].as_i64().unwrap();
    let renamed = apps(json!({ "action": "panel_update", "panel": "panel0000000a101", "expected_rev": rev, "label": "Studio" })).await.unwrap();
    assert_eq!((renamed["id"].as_str(), renamed["label"].as_str()), (Some("caption-board-panel-1"), Some("Studio")), "a slug never changes");
    // an app listener named by old ids keeps the current ones
    let (target, args) = crate::domain::apps::events::current_source(&e, a, "app00000000a001",
        &json!({ "kind": "app_listener", "panel": "panel0000000a101", "event_name": "caption.ready" })).await.unwrap();
    assert_eq!((target.as_str(), args.as_ref().map(|v| v["panel"].clone())), ("caption-board", Some(json!("caption-board-panel-1"))));
    let (target, args) = crate::domain::apps::events::current_source(&e, a, "caption-board", &json!({ "all_panels": true })).await.unwrap();
    assert_eq!((target.as_str(), args), ("caption-board", None));
    let (target, _) = crate::domain::apps::events::current_source(&e, a, "app00000000b001", &json!({})).await.unwrap();
    assert_eq!(target, "app00000000b001", "another org's old id stays unresolved, for the registration's refusal");
    proof.insert("listener_source".into(), json!("caption-board"));

    // new apps and panels take their slugs from the name, or ask for one
    let def = |name: &str| json!({ "name": name, "html": "<p>x</p>" });
    let made = apps(json!({ "action": "app_create", "definition": def("Caption board") })).await.unwrap();
    assert_eq!((made["id"].as_str(), made["ref"].as_str()), (Some("caption-board-4"), Some("@app:apps-a/caption-board-4")));
    let named = apps(json!({ "action": "app_create", "definition": def("לוח שבועי"), "slug": "Weekly board" })).await.unwrap();
    assert_eq!((named["id"].as_str(), named["name"].as_str()), (Some("weekly-board"), Some("לוח שבועי")), "an English slug for a Hebrew name");
    let unnamed = apps(json!({ "action": "app_create", "definition": def("לוח שבועי") })).await.unwrap();
    assert_eq!(unnamed["id"], "app-3", "no Latin letters and no slug");
    for (input, words) in [
        (json!({ "action": "app_create", "definition": def("x"), "slug": "שבועי" }), "no ASCII letter or digit"),
        (json!({ "action": "app_create", "definition": def("x"), "slug": 7 }), "slug is text"),
        (json!({ "action": "app_update", "app": "notes", "expected_rev": 1, "definition": def("Notes"), "slug": "renamed" }), "keeps its slug"),
        (json!({ "action": "panel_open", "panel": "notes-main-view", "slug": "renamed" }), "existing panel keeps its slug"),
    ] {
        let err = apps(input.clone()).await.unwrap_err().to_string();
        assert!(err.contains(words), "{input}: {err}");
    }
    let blank = apps(json!({ "action": "app_create", "definition": def("Blank slug"), "slug": "  " })).await.unwrap();
    assert_eq!(blank["id"], "blank-slug", "a blank slug is no slug");
    let copy = apps(json!({ "action": "panel_open", "app": "caption-board-4", "new": true })).await.unwrap();
    assert_eq!((copy["id"].as_str(), copy["label"].as_str()), (Some("caption-board-4-panel-1"), Some("Panel 1")));
    let asked = apps(json!({ "action": "panel_open", "app": "app00000000a008", "slug": "notes-desk" })).await.unwrap();
    assert_eq!((asked["id"].as_str(), asked["app"].as_str()), (Some("notes-desk"), Some("notes")), "a slug makes a new copy, by an old app id too");
    let dup_rev = apps(json!({ "action": "panel_get", "panel": "notes-main-view" })).await.unwrap()["rev"].as_i64().unwrap();
    let dup = apps(json!({ "action": "panel_duplicate", "panel": "panel0000000a106", "expected_rev": dup_rev })).await.unwrap();
    assert_eq!(dup["id"], "notes-main-view-copy");
    let imported = apps(json!({ "action": "app_import", "bundle": { "format": "orgtree-app", "version": 1, "definition": def("Notes"),
        "panels": [{ "label": "Panel 1", "state": {} }] } })).await.unwrap();
    assert_eq!((imported["imported"].as_str(), imported["panels"][0]["id"].as_str()), (Some("notes-2"), Some("notes-2-panel-1")));
    let mut client = e.db.get().await.unwrap();
    let tx = client.transaction().await.unwrap();
    crate::domain::apps::templates::restore(&tx, a, &[crate::domain::apps::templates::App(serde_json::from_value(def("Notes")).unwrap())]).await.unwrap();
    let restored: String = tx.query_one("SELECT id FROM ot.custom_apps WHERE org_id = $1 AND origin = 'template'", &[&a]).await.unwrap().get(0);
    tx.commit().await.unwrap();
    assert_eq!(restored, "notes-3");
    proof.insert("made".into(), json!([made["id"], named["id"], unnamed["id"], blank["id"], copy["id"], asked["id"], dup["id"],
        imported["imported"], imported["panels"][0]["id"], restored]));
    std::fs::write(fixture.engine_root("app-slugs").join("tool.json"), Value::Object(proof).to_string()).unwrap();
    drop(client);
    drop(e);
    drop(c);
    task.await.unwrap();
}
