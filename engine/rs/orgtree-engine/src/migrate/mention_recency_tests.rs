//! Migration 0076 and the @ menu's read (USER 2026-10-27 m79e889ce1609: every
//! list newest first by the latest of mentioned / operated on / presented).
//! A pre-0076 database in an owned disposable rig cluster (never live data)
//! holds mail mentioning real-shaped tickets, presentations, apps, panels and
//! nodes; after the upgrade the read learns those mentions in bounded
//! batches and ranks, filters and pages the live things.
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};

use crate::domain::mention_candidates as mc;

#[test]
#[nolog]
fn mention_recency_migration_is_registered_bounded_and_starts_near_the_newest_mail() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let recency = at("0076_mention_recency").expect("0076 registered");
    assert!(recency > at("0075_app_panel_slugs").unwrap(), "after 0075");
    let sql = super::MIGRATIONS[recency].1;
    for needle in ["CREATE TABLE ot.mention_recency (", "PRIMARY KEY (org_id, kind, key)", "CHECK (kind IN ('node','item','doc','app','panel'))",
        "CREATE TABLE ot.mention_recency_state (", "greatest(0, coalesce(max(id), 0) - 20000) FROM ot.mail"] {
        assert!(sql.contains(needle), "0076 lacks {needle}");
    }
}

/// A fresh database in the owned rig cluster with every migration before 0076.
#[nolog]
async fn staged() -> (crate::domain::native_fixture::Fixture, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("mention_recency_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < "0076") {
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

#[nolog]
fn ids(page: &Value) -> Vec<String> {
    page["items"].as_array().unwrap().iter().map(|i| format!("{}:{}", i["kind"].as_str().unwrap(), i["id"].as_str().unwrap())).collect()
}

#[nolog]
fn ask(kinds: &[&str], text: &str, after: Option<&Value>, limit: i64) -> mc::Ask {
    mc::Ask { kinds: kinds.iter().map(|k| k.to_string()).collect(), words: mc::words(text),
        after: after.and_then(|c| c.as_str()).and_then(mc::Cursor::decode), limit }
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn the_menu_ranks_live_things_by_their_latest_mention_or_use_and_pages_them() {
    let (fixture, mut c, task) = staged().await;
    // Two orgs; times are minutes ago, so a larger number is older.
    c.batch_execute("
        INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'menu-a', 'Menu A'), (gen_random_uuid(), 'menu-b', 'Menu B');
        INSERT INTO ot.agents (org_id, name, tier, state, born) SELECT id, 'boss', 'sol', 'live', 'synthetic' FROM ot.orgs WHERE slug = 'menu-a';
        INSERT INTO ot.agents (org_id, name, tier, state, born) SELECT id, 'writer', 'sol', 'live', 'synthetic' FROM ot.orgs WHERE slug = 'menu-a';
        INSERT INTO ot.agents (org_id, name, tier, state, born) SELECT id, 'boss', 'sol', 'live', 'synthetic' FROM ot.orgs WHERE slug = 'menu-b';
        -- tickets: live ones, one done long ago (the docket's archive), one dropped, one archived
        INSERT INTO ot.work_items (org_id, slug, title, status, created_by, updated_at)
          SELECT o.id, t.slug, t.title, t.status, '{}'::jsonb, now() - make_interval(mins => t.ago) FROM ot.orgs o,
            (VALUES ('fix-login', 'Fix the login page', 'in_progress', 50), ('caption-review', 'Review the caption board', 'open', 30),
                    ('old-done', 'Done long ago', 'done', 600), ('gone', 'Dropped work', 'dropped', 5), ('weekly-plan', 'Weekly plan', 'backlogged', 400)) AS t(slug, title, status, ago)
           WHERE o.slug = 'menu-a';
        UPDATE ot.work_items SET archived_at = now() WHERE slug = 'weekly-plan';
        -- presentations: the newest presenting counts; a dismissed one is never offered
        INSERT INTO ot.documents (uid, org_id, node_name, title, body, at, dismissed)
          SELECT 'd-' || t.slug, o.id, 'writer', t.title, 'x', now() - make_interval(mins => t.ago), t.dismissed FROM ot.orgs o,
            (VALUES ('weekly-status', 'Weekly status', 40, false), ('launch-deck', 'Launch deck', 200, false), ('draft', 'Draft caption notes', 1, true)) AS t(slug, title, ago, dismissed)
           WHERE o.slug = 'menu-a';
        -- apps and panels made by the 0075 triggers (ids from names)
        INSERT INTO ot.custom_apps (org_id, name, html, created_by, updated_at)
          SELECT id, 'Caption board', '<p>x</p>', 'writer', now() - interval '300 minutes' FROM ot.orgs WHERE slug = 'menu-a';
        INSERT INTO ot.custom_apps (org_id, name, html, created_by, updated_at)
          SELECT id, 'Notes', '<p>x</p>', 'writer', now() - interval '20 minutes' FROM ot.orgs WHERE slug = 'menu-a';
        INSERT INTO ot.custom_panels (org_id, app_id, label, is_open, used_at, updated_at)
          SELECT id, 'caption-board', 'Panel 1', false, now() - interval '250 minutes', now() - interval '250 minutes' FROM ot.orgs WHERE slug = 'menu-a';
    ").await.unwrap();
    let a = one_i64(&c, "SELECT id FROM ot.orgs WHERE slug = 'menu-a'").await;
    let b = one_i64(&c, "SELECT id FROM ot.orgs WHERE slug = 'menu-b'").await;
    // mail mentioning them: the launch deck and the caption board panel recently, by an old doc uid too
    for (body, ago, org) in [
        ("Please look at @doc:menu-a/d-launch-deck and @panel:menu-a/caption-board-panel-1, ask @writer", 3, a),
        ("Old note on @item:menu-a/weekly-plan and @item:menu-a/fix-login", 100, a),
        ("Other org: @doc:menu-a/weekly-status is not ours to name here", 2, b),
        ("@app:menu-b/notes is another org's token", 1, a),
    ] {
        c.execute("INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_name, body, state, created_at)
                   VALUES (gen_random_uuid()::text, $1, '@user', 'agent', 'boss', $2, 'delivered', now() - make_interval(mins => $3))",
            &[&org, &body, &ago]).await.unwrap();
    }
    assert!(c.query_opt("SELECT 1 FROM information_schema.tables WHERE table_schema = 'ot' AND table_name = 'mention_recency'", &[]).await.unwrap().is_none(),
        "the staged database is pre-0076");
    super::run(&mut c, &|_| {}).await.unwrap();
    assert_eq!(one_i64(&c, "SELECT mail_id FROM ot.mention_recency_state").await, 0, "a small history is read from its start");
    mc::catch_up(&mut c).await.unwrap();
    let learned: Vec<(String, String)> = c.query("SELECT kind, key FROM ot.mention_recency WHERE org_id = $1 ORDER BY kind, key", &[&a]).await.unwrap()
        .iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(learned, [("doc", "launch-deck"), ("item", "fix-login"), ("item", "weekly-plan"), ("node", "writer"), ("panel", "caption-board-panel-1")]
        .map(|(k, v)| (k.to_string(), v.to_string())), "an old uid names the slug; another org's tokens are not this org's");
    assert_eq!(one_i64(&c, "SELECT mail_id FROM ot.mention_recency_state").await, one_i64(&c, "SELECT max(id) FROM ot.mail").await);

    // everything, newest first by the latest of mention and use
    let all = mc::page(&c, a, &ask(&mc::KINDS, "", None, 20)).await.unwrap();
    // (the deck and the panel share one mail's time: then by name)
    assert_eq!(ids(&all), ["panel:caption-board-panel-1", "doc:launch-deck", "app:notes", "item:caption-review", "doc:weekly-status",
        "item:fix-login", "app:caption-board"], "{all}");
    assert_eq!(all["nodes"], json!([{ "name": "writer", "at": all["nodes"][0]["at"].clone() }]));
    assert_eq!(all["next_cursor"], Value::Null);
    let panel = &all["items"][0];
    assert_eq!((panel["label"].as_str(), panel["app"].as_str(), panel["panel_label"].as_str()), (Some("Caption board · Panel 1"), Some("caption-board"), Some("Panel 1")));
    // one kind: all of it; words narrow without reordering
    assert_eq!(ids(&mc::page(&c, a, &ask(&["item"], "", None, 20)).await.unwrap()), ["item:caption-review", "item:fix-login"]);
    assert_eq!(ids(&mc::page(&c, a, &ask(&mc::KINDS, "caption", None, 20)).await.unwrap()),
        ["panel:caption-board-panel-1", "item:caption-review", "app:caption-board"], "the dismissed Draft caption notes is not offered");
    assert_eq!(ids(&mc::page(&c, a, &ask(&["doc", "app"], "deck LAUNCH", None, 20)).await.unwrap()), ["doc:launch-deck"]);
    // pages of two walk the same order once
    let mut walked = Vec::new();
    let mut after: Option<Value> = None;
    loop {
        let page = mc::page(&c, a, &ask(&mc::KINDS, "", after.as_ref(), 2)).await.unwrap();
        assert!(page["items"].as_array().unwrap().len() <= 2);
        assert_eq!(page.get("nodes").is_some(), after.is_none(), "node times come with a first page only");
        walked.extend(ids(&page));
        if page["next_cursor"].is_null() { break }
        after = Some(page["next_cursor"].clone());
    }
    assert_eq!(walked, ids(&all));
    // new mail naming the oldest thing moves it to the top; nothing new changes nothing
    c.execute("INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_name, body, state)
               VALUES (gen_random_uuid()::text, $1, 'boss', 'user', 'user', 'Opened @app:menu-a/caption-board again', 'delivered')", &[&a]).await.unwrap();
    mc::catch_up(&mut c).await.unwrap();
    mc::catch_up(&mut c).await.unwrap();
    let top = mc::page(&c, a, &ask(&mc::KINDS, "", None, 1)).await.unwrap();
    assert_eq!(ids(&top), ["app:caption-board"]);
    std::fs::write(fixture.engine_root("mention-recency").join("menu.json"),
        json!({ "learned": learned.len(), "order": ids(&all), "walked": walked, "top_after_mention": ids(&top) }).to_string()).unwrap();
    drop(c);
    task.await.unwrap();
}
