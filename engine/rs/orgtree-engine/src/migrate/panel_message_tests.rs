//! Migrations 0070 and 0071a: panel messages named like the old lifecycle rows
//! survive the History upgrade (4.5.0 high D14, review alpha4 99517050d4d6 F2).
//! Before 0071 the event action and orgtree.emit stored any name, so an agent's
//! or an app's message could be called panel.changed or state.changed exactly
//! like the engine's own lifecycle rows, which 0071 deletes by name alone
//! (USER 2026-10-26 md6edfebc1975, answer "Delete on upgrade"); 0071 also filed
//! messages named panel.started, panel.stopped or event.fired as History. 0071
//! shipped in 4.5.0-alpha.4 and never changes, so 0070 sets aside before it
//! every row whose payload is not the shape the engine itself wrote for that
//! name, and 0071a puts each back after it as a message under its own name.
//! A pre-0070 database in an owned disposable rig cluster (never live data)
//! holds both kinds of row; after the upgrade the engine's rows are gone or
//! stay History as before, and every message keeps its seq, name, payload,
//! actor and time. A database that already had 0071 is left exactly as it was.
use serde_json::json;
use tokio_postgres::{Client, NoTls};

#[test]
#[nolog]
fn panel_message_migrations_surround_the_shipped_history_migration() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let history = at("0071_custom_panel_history").expect("0071 registered");
    let keep = at("0070_keep_panel_messages").expect("0070 registered");
    let restore = at("0071a_restore_panel_messages").expect("0071a registered");
    assert_eq!((keep + 1, restore), (history, history + 1), "0070 runs right before the shipped 0071 and 0071a right after it");
    for needle in ["attname = 'kind'", "CREATE TABLE ot.upgrade_0070_panel_messages", "'upgrade-0070-message'"] {
        assert!(super::MIGRATIONS[keep].1.contains(needle), "0070 lacks {needle}");
    }
    for needle in ["to_regclass('ot.upgrade_0070_panel_messages')", "kind = 'message'", "DROP TABLE ot.upgrade_0070_panel_messages"] {
        assert!(super::MIGRATIONS[restore].1.contains(needle), "0071a lacks {needle}");
    }
}

/// A fresh database in the owned rig cluster with the migrations before
/// `upto`, except `skip`, applied and recorded the way `run` records them.
#[nolog]
async fn staged(label: &str, upto: &str, skip: &[&str]) -> (crate::domain::native_fixture::Fixture, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("panel_messages_{label}_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < upto).filter(|(n, _)| !skip.contains(n)) {
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(sql).await.unwrap_or_else(|e| panic!("staging {name}: {e}"));
        tx.execute("INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)", &[name, &super::checksum(sql)]).await.unwrap();
        tx.commit().await.unwrap();
    }
    client.batch_execute(r#"
        INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'messages', 'Messages');
        INSERT INTO ot.custom_apps (org_id, id, name, html, created_by) SELECT id, 'app-1', 'Board', '<p>x</p>', 'boss' FROM ot.orgs WHERE slug = 'messages';
        INSERT INTO ot.custom_panels (org_id, id, app_id, label, is_open) SELECT id, 'panel-1', 'app-1', 'Panel 1', false FROM ot.orgs WHERE slug = 'messages';
    "#).await.unwrap();
    (fixture, client, task)
}

/// Every panel event in seq order: seq, name, payload, actor, time and, once
/// 0071 has added it, kind.
#[nolog]
async fn events(c: &Client) -> Vec<(i64, String, String, String, String, Option<String>)> {
    let kind = c.query_opt("SELECT 1 FROM information_schema.columns WHERE table_schema = 'ot' AND table_name = 'custom_panel_events' AND column_name = 'kind'", &[])
        .await.unwrap().is_some();
    let sql = format!("SELECT seq, name, payload::text, actor, at::text, {} FROM ot.custom_panel_events ORDER BY seq", if kind { "kind" } else { "NULL::text" });
    c.query(&sql, &[]).await.unwrap().iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5))).collect()
}

/// Insert rows (name, payload, actor) in order, one minute apart, with `kind`
/// when the table has it.
#[nolog]
async fn insert(c: &Client, rows: &[(&str, &str, &str)], kind: Option<&[&str]>) {
    for (i, (name, payload, actor)) in rows.iter().enumerate() {
        let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
        let at = format!("2026-10-20 10:{:02}:00+00", i);
        let done = match kind {
            None => c.execute("INSERT INTO ot.custom_panel_events (org_id, panel_id, name, payload, actor, at)
                SELECT id, 'panel-1', $1, $2, $3, $4::text::timestamptz FROM ot.orgs WHERE slug = 'messages'", &[name, &payload, actor, &at]).await,
            Some(kinds) => c.execute("INSERT INTO ot.custom_panel_events (org_id, panel_id, name, payload, actor, at, kind)
                SELECT id, 'panel-1', $1, $2, $3, $4::text::timestamptz, $5 FROM ot.orgs WHERE slug = 'messages'", &[name, &payload, actor, &at, &kinds[i]]).await,
        };
        done.unwrap_or_else(|e| panic!("seeding {name}: {e}"));
    }
}

#[nolog]
async fn holding_table(c: &Client) -> bool {
    c.query_one("SELECT to_regclass('ot.upgrade_0070_panel_messages') IS NOT NULL", &[]).await.unwrap().get(0)
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn messages_named_like_lifecycle_rows_survive_the_history_upgrade() {
    let (fixture, mut c, task) = staged("upgrade", "0070", &[]).await;
    // (name, payload, actor, what the upgrade makes of it)
    let rows: &[(&str, &str, &str, &str)] = &[
        // every shape the engine wrote itself before 0071 (domain/apps storage.rs, runtime.rs, events.rs)
        ("panel.created", "{}", "boss", "deleted"),
        ("panel.opened", "{}", "user", "deleted"),
        ("state.changed", r#"{"rev": 2}"#, "boss", "deleted"),
        ("panel.duplicated", r#"{"source": "panel-0"}"#, "user", "deleted"),
        ("panel.changed", "{}", "user", "deleted"),
        ("panel.started", "{}", "user", "history"),
        ("panel.stopped", "{}", "user", "history"),
        ("panel.stopped", r#"{"reason": "code changed"}"#, "boss", "history"),
        ("panel.stopped", r#"{"reason": "stop all"}"#, "user", "history"),
        ("event.fired", r#"{"id": "app-event-1", "event": "run.ended", "subscribers": 2}"#, "boss", "history"),
        // messages agents and apps sent under those names: the review's case first
        ("panel.changed", r#"{"note": "keep me"}"#, "boss", "message"),
        ("panel.opened", r#""a string""#, "user", "message"),
        ("panel.created", "[1, 2]", "boss", "message"),
        ("state.changed", r#"{"rev": "3"}"#, "boss", "message"),
        ("state.changed", r#"{"by": "agent", "rev": 4}"#, "boss", "message"),
        ("panel.duplicated", r#"{"source": 7}"#, "boss", "message"),
        ("panel.duplicated", "{}", "boss", "message"),
        ("panel.started", r#"{"x": 1}"#, "boss", "message"),
        ("panel.stopped", r#"{"reason": "bored"}"#, "boss", "message"),
        ("event.fired", r#"{"event": "run.ended"}"#, "boss", "message"),
        ("event.fired", "null", "boss", "message"),
        // ordinary messages, one named like 0070's own placeholder
        ("chat.posted", r#"{"text": "hi"}"#, "boss", "message"),
        ("upgrade-0070-message", r#"{"text": "mine"}"#, "boss", "message"),
    ];
    insert(&c, &rows.iter().map(|(n, p, a, _)| (*n, *p, *a)).collect::<Vec<_>>(), None).await;
    let before = events(&c).await;
    assert_eq!(before.len(), rows.len());
    assert!(before.iter().all(|row| row.5.is_none()), "the staged database is pre-0071");
    super::run(&mut c, &|_| {}).await.unwrap();
    let after = events(&c).await;
    let want: Vec<_> = before.iter().zip(rows).filter(|(_, row)| row.3 != "deleted")
        .map(|(b, row)| (b.0, b.1.clone(), b.2.clone(), b.3.clone(), b.4.clone(), Some(row.3.to_string()))).collect();
    std::fs::write(fixture.engine_root("panel-messages").join("upgrade.json"),
        json!({ "before": before, "after": after, "want": want }).to_string()).unwrap();
    let lost: Vec<_> = want.iter().filter(|w| !after.contains(w)).collect();
    assert!(lost.is_empty(), "lost or changed by the upgrade: {lost:?}\nafter: {after:?}");
    assert_eq!(after, want, "only the engine's own lifecycle rows are deleted; its starts, stops and fires stay History; every message is kept as it was");
    assert!(!holding_table(&c).await, "0071a drops 0070's holding table");
    drop(c);
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn a_database_that_already_had_the_history_migration_is_left_as_it_was() {
    // 4.5.0-alpha.4 and later applied 0071 without 0070 or 0071a.
    let (_fixture, mut c, task) = staged("applied", "0072", &["0070_keep_panel_messages", "0071a_restore_panel_messages"]).await;
    // rows today's engine writes: History in its newer shapes, and messages under any name
    let rows: &[(&str, &str, &str)] = &[
        ("panel.started", r#"{"reason": "opened"}"#, "user"),
        ("panel.stopped", r#"{"reason": "stop all"}"#, "user"),
        ("event.fired", r#"{"id": "app-event-2", "event": "run.ended", "subscribers": 0}"#, "boss"),
        ("panel.changed", "{}", "boss"),
        ("panel.changed", r#"{"note": "sent after 0071"}"#, "boss"),
        ("panel.started", r#"{"x": 1}"#, "boss"),
        ("state.changed", r#"{"rev": 1}"#, "boss"),
    ];
    insert(&c, rows, Some(&["history", "history", "history", "message", "message", "message", "message"])).await;
    let before = events(&c).await;
    assert!(before.iter().all(|row| row.5.is_some()), "the staged database has 0071's kind");
    super::run(&mut c, &|_| {}).await.unwrap();
    assert_eq!(events(&c).await, before, "0070 and 0071a change nothing once 0071 has run");
    assert!(!holding_table(&c).await, "no holding table is made");
    drop(c);
    task.await.unwrap();
}
