//! Migration 0089: the automatic pins of 4.5.10 to 4.6.2 become LATEST (USER 2026-11-18 m18f3444ac04f "Unpin
//! them"); every other pin stays. A 4.6.2 database (every migration before 0089) in an owned disposable rig cluster
//! (never live data) is upgraded by the engine's own runner, twice.
use tokio_postgres::{Client, NoTls};

#[test]
#[nolog]
fn latest_model_version_migration_is_registered_and_clears_only_the_newest_pins() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let latest = at("0089_latest_model_version").expect("0089 registered");
    assert_eq!(latest, super::MIGRATIONS.len() - 1, "the newest migration");
    assert!(latest > at("0088_user_origin").unwrap(), "after 0088, the last of 4.6.2");
    let sql = super::MIGRATIONS[latest].1;
    for needle in ["UPDATE ot.agents SET scope = scope - 'model_version'", "(tier = 'fable' AND scope->>'model_version' = '5.2')",
        "(tier IN ('sol', 'astra') AND scope->>'model_version' = '6.2')"] {
        assert!(sql.contains(needle), "0089 lacks {needle}");
    }
    assert!(!sql.contains("state"), "seats in every state");
}

/// A fresh database in the owned rig cluster with every migration before 0089: the 4.6.2 schema.
#[nolog]
async fn staged() -> (crate::domain::native_fixture::Fixture, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("latest_version_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < "0089") {
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(sql).await.unwrap_or_else(|e| panic!("staging {name}: {e}"));
        tx.execute("INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)", &[name, &super::checksum(sql)]).await.unwrap();
        tx.commit().await.unwrap();
    }
    (fixture, client, task)
}

#[nolog]
async fn versions(c: &Client) -> Vec<(String, Option<String>)> {
    c.query("SELECT name, scope->>'model_version' FROM ot.agents ORDER BY name", &[]).await.unwrap()
        .iter().map(|r| (r.get(0), r.get(1))).collect()
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn an_upgrade_from_4_6_2_unpins_only_the_automatic_pins_once() {
    let (_fixture, mut c, task) = staged().await;
    c.batch_execute("
        INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'latest', 'Latest');
        INSERT INTO ot.agents (org_id, name, tier, state, born, scope)
          SELECT o.id, t.name, t.tier, t.state, 'synthetic', t.scope::jsonb FROM ot.orgs o,
            (VALUES ('fable-auto', 'fable', 'live', '{\"model_version\":\"5.2\",\"effort\":\"medium\"}'),
                    ('fable-old', 'fable', 'live', '{\"model_version\":\"5.1\"}'),
                    ('fable-plain', 'fable', 'live', '{}'),
                    ('sol-auto', 'sol', 'archived', '{\"model_version\":\"6.2\"}'),
                    ('sol-old', 'sol', 'live', '{\"model_version\":\"6.1\"}'),
                    ('astra-auto', 'astra', 'live', '{\"model_version\":\"6.2\"}'),
                    ('astra-old', 'astra', 'live', '{\"model_version\":\"6\"}'),
                    ('opus-pin', 'opus', 'live', '{\"model_version\":\"5\"}'),
                    ('terra-pin', 'terra', 'live', '{\"model_version\":\"5.6\"}')) AS t(name, tier, state, scope)
           WHERE o.slug = 'latest';
    ").await.unwrap();
    assert!(c.query_opt("SELECT 1 FROM public.ot_migrations WHERE name = '0089_latest_model_version'", &[]).await.unwrap().is_none(),
        "the staged database is 4.6.2");
    let want = [("astra-auto", None), ("astra-old", Some("6")), ("fable-auto", None), ("fable-old", Some("5.1")), ("fable-plain", None),
        ("opus-pin", Some("5")), ("sol-auto", None), ("sol-old", Some("6.1")), ("terra-pin", Some("5.6"))]
        .map(|(n, v)| (n.to_string(), v.map(str::to_string))).to_vec();
    super::run(&mut c, &|_| {}).await.unwrap();
    assert_eq!(versions(&c).await, want);
    let effort: Option<String> = c.query_one("SELECT scope->>'effort' FROM ot.agents WHERE name = 'fable-auto'", &[]).await.unwrap().get(0);
    assert_eq!(effort.as_deref(), Some("medium"), "only the version key goes");
    // the runner records it once; a pin made after the upgrade is never touched again
    c.execute("UPDATE ot.agents SET scope = scope || '{\"model_version\":\"6.2\"}'::jsonb WHERE name = 'astra-auto'", &[]).await.unwrap();
    super::run(&mut c, &|_| {}).await.unwrap();
    let applied: i64 = c.query_one("SELECT count(*) FROM public.ot_migrations WHERE name = '0089_latest_model_version'", &[]).await.unwrap().get(0);
    assert_eq!(applied, 1);
    assert_eq!(versions(&c).await[0], ("astra-auto".to_string(), Some("6.2".to_string())), "a pin chosen after the upgrade stays");
    // and the SQL itself changes nothing a second time
    c.batch_execute("UPDATE ot.agents SET scope = scope - 'model_version' WHERE name = 'astra-auto'").await.unwrap();
    c.batch_execute(super::MIGRATIONS.last().unwrap().1).await.unwrap();
    assert_eq!(versions(&c).await, want);
    drop(c);
    task.await.unwrap();
}
