//! Renaming an org's DISPLAY name (Org settings > Basic > Name, docket
//! `org-settings-rename-an-org-s-display-name-4-5-10`; USER 2026-11-09
//! mabc0f5462fb8 "add it"). The slug never changes. Native checks, each on a
//! fresh database in an owned disposable rig cluster, never live data.
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};

use crate::engine::Engine;
use crate::http::settings::save_org;

/// A fresh, fully migrated database with two open orgs: "Old Name" (slug
/// `old-name`) and "Other" (slug `other`).
#[nolog]
async fn two_orgs(label: &str) -> (Arc<Engine>, Client, i64, i64) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("rename_{label}_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut c, conn) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = conn.await; });
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let mut ids = Vec::new();
    for (slug, name) in [("old-name", "Old Name"), ("other", "Other")] {
        ids.push(c.query_one("INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id", &[&slug, &name])
            .await.unwrap().get::<_, i64>(0));
    }
    let mut engine = Engine::for_tests(fixture.engine_root(&format!("rename-{label}-engine")));
    let manager = deadpool_postgres::Manager::from_config(cfg, NoTls,
        deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(manager).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    for (id, slug, name) in [(ids[0], "old-name", "Old Name"), (ids[1], "other", "Other")] {
        engine.orgs.insert(crate::orgs::provisional(id, uuid::Uuid::new_v4().to_string(), slug.into(), name.into()));
    }
    (engine, c, ids[0], ids[1])
}

#[nolog]
async fn stored(c: &Client, org: i64) -> (String, String) {
    let r = c.query_one("SELECT slug, name FROM ot.orgs WHERE id = $1", &[&org]).await.unwrap();
    (r.get(0), r.get(1))
}

#[nolog]
async fn rename(e: &Arc<Engine>, slug: &str, name: &str) -> Result<Json<Value>, crate::http::error::ApiError> {
    save_org(State(e.clone()), Path(slug.into()), Json(json!({ "org_name": name }).as_object().unwrap().clone())).await
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn a_rename_persists_and_the_slug_stays() {
    let (e, c, org, _) = two_orgs("persist").await;
    let out = rename(&e, "old-name", "  New Display Name ").await.unwrap();
    assert_eq!(out.0["name"], "New Display Name", "the reply names the trimmed name");
    assert_eq!(stored(&c, org).await, ("old-name".to_string(), "New Display Name".to_string()), "name saved, slug untouched");
    assert_eq!(e.orgs.get("old-name").unwrap().name.load().as_str(), "New Display Name", "agents read the new name next turn");
    assert!(e.orgs.get("new-display-name").is_none(), "no second slug appears");
    let ev: Value = c.query_one("SELECT detail FROM ot.events WHERE org_id = $1 AND op = 'org_renamed'", &[&org]).await.unwrap().get(0);
    assert_eq!(ev, json!({ "from": "Old Name", "to": "New Display Name" }));
    let list = crate::http::orgs::list(State(e.clone())).await.unwrap();
    let row = list.0.as_array().unwrap().iter().find(|o| o["slug"] == "old-name").expect("listed under its slug").clone();
    assert_eq!(row["name"], "New Display Name", "the org list shows the new name");
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn an_invalid_name_is_refused_with_the_create_rule_and_changes_nothing() {
    let (e, c, org, _) = two_orgs("invalid").await;
    for bad in ["", "   ", "!!! ---"] {
        let err = rename(&e, "old-name", bad).await.expect_err(bad);
        assert!(err.detail.contains("mandatory"), "{bad:?}: {err:?}");
    }
    assert_eq!(stored(&c, org).await.1, "Old Name");
    assert_eq!(e.orgs.get("old-name").unwrap().name.load().as_str(), "Old Name");
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn two_orgs_may_share_a_display_name() {
    let (e, c, _, other) = two_orgs("dup").await;
    let _ = rename(&e, "old-name", "Other").await.unwrap();
    assert_eq!(stored(&c, other).await, ("other".to_string(), "Other".to_string()));
    let n: i64 = c.query_one("SELECT count(*) FROM ot.orgs WHERE name = 'Other'", &[]).await.unwrap().get(0);
    assert_eq!(n, 2);
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn a_trashed_org_is_not_renamed() {
    let (e, c, org, _) = two_orgs("trashed").await;
    c.execute("UPDATE ot.orgs SET state = 'trashed', trashed_at = now() WHERE id = $1", &[&org]).await.unwrap();
    // the handle is still open here, so the database row is what refuses
    assert!(rename(&e, "old-name", "Ghost").await.is_err(), "a trashed org cannot be renamed");
    assert_eq!(stored(&c, org).await.1, "Old Name");
    assert_eq!(e.orgs.get("old-name").unwrap().name.load().as_str(), "Old Name", "the open handle keeps its name");
}
