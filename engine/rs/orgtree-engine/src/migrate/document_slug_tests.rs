//! Migration 0073: presentations are identified by a readable slug (user
//! 2026-10-27 m4efbc12ac94e). The native checks stage a pre-0073 database in an
//! owned disposable rig cluster (never live data), fill it with real-shaped
//! presentations, upgrade it, and resolve the old generic ids on every route.
//! Migration 0074: orgtree_present may ask for a slug, cleaned and made free
//! by the same trigger (user 2026-10-27 mdcb7ce9a8103).
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use tokio_postgres::{Client, Config, NoTls};

use crate::engine::Engine;
use crate::orgs::OrgHandle;

#[test]
#[nolog]
fn document_slugs_migration_is_registered_with_trigger_and_resolver() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let slugs = at("0073_document_slugs").expect("0073 registered");
    assert!(slugs > at("0072_custom_app_internet_access").unwrap(), "after 0072");
    let sql = super::MIGRATIONS[slugs].1;
    for needle in ["ADD COLUMN slug text", "CREATE UNIQUE INDEX documents_slug ON ot.documents (org_id, slug)",
        "CREATE TRIGGER documents_slug BEFORE INSERT ON ot.documents", "pg_advisory_xact_lock",
        "ALTER COLUMN slug SET NOT NULL", "CREATE FUNCTION ot.document_ref(p_org bigint, p_ref text)",
        // a slug wins over an old id, and a reference never leaves its org
        "WHERE org_id = p_org AND (slug = p_ref OR uid = p_ref)", "ORDER BY slug = p_ref DESC LIMIT 1",
        // an old id and the `viewed` route segment are never handed out as slugs
        "candidate = 'viewed' OR EXISTS", "(d.slug = candidate OR d.uid = candidate)"] {
        assert!(sql.contains(needle), "0073 lacks {needle}");
    }
}

#[test]
#[nolog]
fn requested_document_slugs_migration_is_registered() {
    let at = |name: &str| super::MIGRATIONS.iter().position(|(n, _)| *n == name);
    let requested = at("0074_requested_document_slugs").expect("0074 registered");
    assert!(requested > at("0073_document_slugs").unwrap(), "after 0073");
    let sql = super::MIGRATIONS[requested].1;
    for needle in ["CREATE OR REPLACE FUNCTION ot.assign_document_slug() RETURNS trigger",
        // one lock for both paths, so a requested slug never races a title
        "PERFORM pg_advisory_xact_lock(hashtextextended('ot.documents.slug/' || NEW.org_id, 0));",
        "NEW.slug := ot.document_slug(NEW.org_id, NEW.title);",
        // a requested slug gets the title's cleanup and clash suffixes
        "NEW.slug := ot.document_slug(NEW.org_id, NEW.slug);",
        // and one the cleanup leaves empty is refused, never `presentation`
        "RAISE EXCEPTION"] {
        assert!(sql.contains(needle), "0074 lacks {needle}");
    }
}

/// A fresh database in the owned rig cluster with every migration before 0073
/// applied and recorded the way `run` records them.
#[nolog]
async fn staged(label: &str) -> (crate::domain::native_fixture::Fixture, Config, Client, tokio::task::JoinHandle<()>) {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let mut cfg = fixture.cfg.clone();
    let (admin, conn) = cfg.connect(NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { let _ = conn.await; });
    let db = format!("document_slugs_{label}_{}", std::process::id());
    admin.batch_execute(&format!("CREATE DATABASE {db}")).await.unwrap();
    drop(admin);
    admin_task.await.unwrap();
    cfg.dbname(&db);
    let (mut client, conn) = cfg.connect(NoTls).await.unwrap();
    let task = tokio::spawn(async move { let _ = conn.await; });
    client.batch_execute("CREATE TABLE public.ot_migrations (name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    for (name, sql) in super::MIGRATIONS.iter().take_while(|(n, _)| *n < "0073") {
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(sql).await.unwrap_or_else(|e| panic!("staging {name}: {e}"));
        tx.execute("INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)", &[name, &super::checksum(sql)]).await.unwrap();
        tx.commit().await.unwrap();
    }
    (fixture, cfg, client, task)
}

/// An engine whose pool is the staged database, with the org open.
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

/// Titles real presentations carry, with the slug each must get. Every
/// title with an ASCII letter or digit gets what docket slugs get
/// (util::slugify at 48); the rest are `presentation`.
#[nolog]
fn long_titles() -> (String, String, String) {
    // 47 letters, a space, then more: the cut keeps the '-' and one letter,
    // as util::slugify does (49 characters)
    let edge = format!("{} bcdef", "a".repeat(47));
    let plain = "x".repeat(60);
    let words = "Quarterly planning review for the platform team covering hiring budget roadmap risks and the open questions for leadership".to_string();
    (edge, plain, words)
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn staged_pre_0073_presentations_get_readable_slugs_on_upgrade() {
    let (fixture, _cfg, mut c, task) = staged("upgrade").await;
    let a = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'slugs-a', 'Slugs A') RETURNING id", &[]).await;
    let b = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'slugs-b', 'Slugs B') RETURNING id", &[]).await;
    let writer = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    let reviewer = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'reviewer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    let launch = one_i64(&c, "INSERT INTO ot.agents (org_id, name, parent_id, kind, tier, state, born) VALUES ($1, 'launch', $2, 'project', 'project', 'live', 'synthetic') RETURNING id", &[&a, &writer]).await;
    let other = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'other', 'sol', 'live', 'synthetic') RETURNING id", &[&b]).await;
    let (edge, plain, words) = long_titles();
    // (uid, org, agent, node, title, format, dismissed, expected slug)
    let rows: Vec<(&str, i64, Option<i64>, &str, String, &str, bool, &str)> = vec![
        ("d00000000a001", a, Some(writer), "writer", "Q3 release plan".into(), "markdown", false, "q3-release-plan"),
        ("d00000000a002", a, Some(writer), "writer", "Q3 release plan".into(), "markdown", false, "q3-release-plan-2"),
        ("d00000000a003", a, Some(reviewer), "reviewer", "Q3 Release Plan!!".into(), "markdown", false, "q3-release-plan-3"),
        ("d00000000a004", a, Some(writer), "writer", String::new(), "markdown", false, "presentation"),
        ("d00000000a005", a, Some(writer), "writer", "שלום עולם".into(), "markdown", false, "presentation-2"),
        ("d00000000a006", a, Some(writer), "writer", "Résumé — naïve café 🚀".into(), "markdown", false, "r-sum-na-ve-caf"),
        ("d00000000a007", a, Some(writer), "writer", edge.clone(), "markdown", false, ""),
        ("d00000000a008", a, Some(writer), "writer", plain.clone(), "markdown", false, ""),
        ("d00000000a009", a, Some(writer), "writer", words.clone(), "markdown", false, ""),
        ("d00000000a010", a, Some(writer), "writer", "Viewed".into(), "markdown", false, "viewed-2"),
        ("d00000000a011", a, Some(writer), "writer", "d00000000a001".into(), "markdown", false, "d00000000a001-2"),
        ("d00000000a012", a, Some(launch), "launch", "Launch deck".into(), "html", false, "launch-deck"),
        ("d00000000a013", a, Some(writer), "writer", "Dismissed draft".into(), "markdown", true, "dismissed-draft"),
        ("d00000000a014", a, None, "gone", "Imported notes".into(), "markdown", false, "imported-notes"),
        ("d00000000a015", a, Some(writer), "writer", "2026-10-27: status / week 43".into(), "markdown", false, "2026-10-27-status-week-43"),
        ("d00000000b001", b, Some(other), "other", "Q3 release plan".into(), "markdown", false, "q3-release-plan"),
    ];
    for (uid, org, agent, node, title, format, dismissed, _) in &rows {
        let presented_by: Option<&str> = (*node == "launch").then_some("writer");
        let preview: Option<&str> = (*format == "html").then_some("<!doctype html><title>Launch</title><p>deck</p>");
        c.execute("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, dismissed, preview, presented_by, at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 12, $8, $9, $10, now() - interval '1 day')",
            &[uid, org, agent, node, title, &format!("Body of {title}"), format, dismissed, &preview, &presented_by]).await.unwrap();
    }
    assert!(c.query_opt("SELECT 1 FROM information_schema.columns WHERE table_schema = 'ot' AND table_name = 'documents' AND column_name = 'slug'", &[]).await.unwrap().is_none(),
        "the staged database is pre-0073");
    super::run(&mut c, &|_| {}).await.unwrap();
    let mut got = serde_json::Map::new();
    for (uid, _, _, _, title, _, _, expected) in &rows {
        let slug: String = c.query_one("SELECT slug FROM ot.documents WHERE uid = $1", &[uid]).await.unwrap().get(0);
        let expected = if expected.is_empty() { crate::util::slugify(title, 48) } else { expected.to_string() };
        assert_eq!(slug, expected, "{uid} {title:?}");
        got.insert(uid.to_string(), json!(slug));
    }
    assert_eq!(c.query_one("SELECT slug FROM ot.documents WHERE uid = 'd00000000a007'", &[]).await.unwrap().get::<_, String>(0).len(), 49,
        "a '-' at the cut keeps one more letter, like docket slugs");
    // every row has one, unique in its org, in the token alphabet
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.documents WHERE slug IS NULL", &[]).await, 0);
    assert!(c.execute("UPDATE ot.documents SET slug = 'q3-release-plan' WHERE uid = 'd00000000a002'", &[]).await.is_err(), "unique per org");
    assert!(c.execute("UPDATE ot.documents SET slug = 'Bad Slug' WHERE uid = 'd00000000a002'", &[]).await.is_err(), "slug alphabet");
    assert!(c.execute("UPDATE ot.documents SET slug = 'a--b' WHERE uid = 'd00000000a002'", &[]).await.is_err(), "no empty word");
    // the database and Rust agree on the base for real and hostile titles
    let corpus: Vec<String> = vec!["Q3 release plan".into(), "  --Leading and trailing!!  ".into(), "ÅÄÖ only".into(), "日本語のタイトル v2".into(),
        "tabs\tand\nnewlines".into(), "MiXeD CaSe 123".into(), "a_b.c/d\\e".into(), "İstanbul ıi".into(), "ﬁligree ﬀ".into(),
        "x".repeat(48), "x".repeat(49), format!("{} {}", "y".repeat(46), "zz"), format!("{}-{}", "y".repeat(47), "z"),
        format!("{} {}", "y".repeat(48), "z"), edge, plain, words, "emoji 🚀🚀 end".into(), "1".repeat(200)];
    for title in &corpus {
        let sql: String = c.query_one("SELECT ot.slug_base($1, 48)", &[title]).await.unwrap().get(0);
        assert_eq!(sql, crate::util::slugify(title, 48), "SQL and util::slugify differ on {title:?}");
    }
    for title in ["", "   ", "—", "שלום", "🚀"] {
        let sql: String = c.query_one("SELECT ot.slug_base($1, 48)", &[&title]).await.unwrap().get(0);
        assert_eq!(sql, "presentation", "{title:?}");
    }
    // an applied 0073 is a no-op on the next start
    super::run(&mut c, &|_| {}).await.unwrap();
    std::fs::write(fixture.engine_root("document-slugs").join("upgrade.json"),
        json!({ "slugs": got, "corpus_agrees": corpus.len(), "rerun_noop": true }).to_string()).unwrap();
    drop(c);
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn old_ids_resolve_on_every_route_after_the_upgrade() {
    let (fixture, cfg, mut c, task) = staged("routes").await;
    let a = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'routes-a', 'Routes A') RETURNING id", &[]).await;
    let b = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'routes-b', 'Routes B') RETURNING id", &[]).await;
    let writer = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    let launch = one_i64(&c, "INSERT INTO ot.agents (org_id, name, parent_id, kind, tier, state, born) VALUES ($1, 'launch', $2, 'project', 'project', 'live', 'synthetic') RETURNING id", &[&a, &writer]).await;
    let other = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'other', 'sol', 'live', 'synthetic') RETURNING id", &[&b]).await;
    for (uid, org, agent, node, title, format) in [
        ("d00000000c001", a, writer, "writer", "Weekly status", "markdown"),
        ("d00000000c002", a, launch, "launch", "Launch deck", "html"),
        ("d00000000c003", a, writer, "writer", "Weekly status", "markdown"),
        ("d00000000c009", b, other, "other", "Elsewhere", "markdown"),
    ] {
        let preview: Option<&str> = (format == "html").then_some("<!doctype html><title>Launch</title><p>deck</p>");
        c.execute("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, preview, presented_by, at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 12, $8, CASE WHEN $4 = 'launch' THEN 'writer' END, now() - interval '1 hour')",
            &[&uid, &org, &agent, &node, &title, &format!("Body of {title} for @user"), &format, &preview]).await.unwrap();
    }
    super::run(&mut c, &|_| {}).await.unwrap();
    let e = engine(&fixture, &cfg, "document-routes", &[(a, "routes-a"), (b, "routes-b")]);
    let (o, slug) = (org(&e, "routes-a"), "routes-a".to_string());
    let old = "d00000000c001";
    let mut proof = serde_json::Map::new();

    // the reader
    let Json(doc) = crate::http::docs::get(State(e.clone()), Path((slug.clone(), old.into()))).await.unwrap();
    assert_eq!((doc["id"].as_str(), doc["title"].as_str()), (Some("weekly-status"), Some("Weekly status")));
    let Json(by_slug) = crate::http::docs::get(State(e.clone()), Path((slug.clone(), "weekly-status-2".into()))).await.unwrap();
    assert_eq!(by_slug["title"], "Weekly status");
    assert!(crate::http::docs::get(State(e.clone()), Path((slug.clone(), "d00000000c009".into()))).await.is_err(), "another org's old id");
    assert!(crate::http::docs::get(State(e.clone()), Path((slug.clone(), "elsewhere".into()))).await.is_err(), "another org's slug");
    proof.insert("get".into(), json!(doc["id"]));
    // the sandboxed HTML preview and the download
    let mockup = crate::http::docs::mockup(State(e.clone()), Path((slug.clone(), "d00000000c002".into()))).await.unwrap();
    assert_eq!(mockup.status(), 200);
    assert!(mockup.headers().get("content-security-policy").is_some());
    let download = crate::http::docs::download(State(e.clone()), Path((slug.clone(), old.into()))).await.unwrap();
    assert_eq!(download.status(), 200);
    assert!(download.headers()["content-disposition"].to_str().unwrap().contains("Weekly status.md"));
    proof.insert("mockup".into(), json!(200));
    proof.insert("download".into(), json!(200));
    // the gallery: locate, mention labels
    let q = |v: Value| Query(serde_json::from_value::<crate::http::docs::ListQuery>(v).unwrap());
    let Json(page) = crate::http::docs::list(State(e.clone()), Path(slug.clone()), q(json!({ "locate": old }))).await.unwrap();
    assert_eq!((page["located"].as_str(), page["located_id"].as_str()), (Some(old), Some("weekly-status")));
    assert!(page["documents"].as_array().unwrap().iter().all(|d| !d["id"].as_str().unwrap().starts_with("d00000000")), "the gallery lists slugs");
    let Json(refs) = crate::http::docs::list(State(e.clone()), Path(slug.clone()),
        q(json!({ "refs": format!("{old},launch-deck,missing,d00000000c009") }))).await.unwrap();
    let labels: Vec<Value> = refs["refs"].as_array().unwrap().iter()
        .map(|r| json!({ "ref": r["ref"], "id": r["id"], "title": r["title"], "format": r["format"] })).collect();
    assert_eq!(labels, vec![
        json!({ "ref": old, "id": "weekly-status", "title": "Weekly status", "format": "markdown" }),
        json!({ "ref": "launch-deck", "id": "launch-deck", "title": "Launch deck", "format": "html" })]);
    // the read times a mention tells unread from modified with (ref flares)
    assert!(refs["refs"].as_array().unwrap().iter().all(|r| r["at"].is_string() && r.get("viewed_at").is_some()), "{refs}");
    // one more than http::docs::REFS_MAX (64)
    let many = (0..=64).map(|n| format!("r{n}")).collect::<Vec<_>>().join(",");
    assert!(crate::http::docs::list(State(e.clone()), Path(slug.clone()), q(json!({ "refs": many }))).await.is_err(), "bounded");
    proof.insert("locate".into(), page["located_id"].clone());
    proof.insert("refs".into(), refs["refs"].clone());
    // the composer's @ list (user mb21c096e5dc4): title and slug words, newest first, this org only
    let found = |page: Value| page["documents"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let search = |text: &str| crate::http::docs::list(State(e.clone()), Path(slug.clone()), q(json!({ "search": text })));
    assert_eq!(found(search("weekly").await.unwrap().0), ["weekly-status-2", "weekly-status"]);
    assert_eq!(found(search("DECK launch").await.unwrap().0), ["launch-deck"]);
    assert_eq!(found(search("status-2").await.unwrap().0), ["weekly-status-2"]);
    assert!(found(search("elsewhere").await.unwrap().0).is_empty(), "another org's presentations");
    assert_eq!(found(search("").await.unwrap().0).len(), 3, "a bare @ offers the newest");
    proof.insert("search".into(), json!(found(search("weekly").await.unwrap().0)));
    // viewed marks from an old record, then the opening reader restored by its old id
    let at: chrono::DateTime<chrono::Utc> = c.query_one("SELECT at FROM ot.documents WHERE uid = $1", &[&old]).await.unwrap().get(0);
    let marks = serde_json::from_value::<crate::http::docs::ViewedBody>(json!({ "marks": [
        { "id": old, "at": crate::util::iso(at) }, { "id": "launch-deck", "at": crate::util::iso(chrono::Utc::now()) },
        { "id": "weekly-status-2", "at": crate::util::iso(chrono::Utc::now()) }] })).unwrap();
    let Json(marked) = crate::http::docs::viewed(State(e.clone()), Path(slug.clone()), Json(marks)).await.unwrap();
    assert_eq!(marked["ok"], true);
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.documents WHERE org_id = $1 AND viewed_at IS NULL", &[&a]).await, 0);
    let Json(opening) = crate::http::docs::list(State(e.clone()), Path(slug.clone()),
        q(json!({ "opening": "1", "previous": old, "visible": true }))).await.unwrap();
    assert_eq!(opening["opening_id"], "weekly-status");
    proof.insert("viewed".into(), json!(true));
    proof.insert("opening".into(), opening["opening_id"].clone());
    // the user's reply to a presentation, and a selection reply's source
    let quote = crate::http::nodes::resolve_target(&e, &o, &json!({ "kind": "document", "org": slug, "id": old }), None).await.unwrap().unwrap();
    assert_eq!(quote["id"], "weekly-status");
    let part = crate::domain::selections::Part::parse(&json!({ "part": "document.title" })).unwrap();
    let source = crate::domain::reply_sources::load(&e, &o, &crate::domain::reply_sources::Reader::User,
        &json!({ "kind": "presentation", "org": slug, "id": old }), &part).await.unwrap();
    assert_eq!((source.text.as_str(), source.quote["id"].as_str()), ("Weekly status", Some("weekly-status")));
    proof.insert("reply_quote".into(), quote["id"].clone());
    proof.insert("reply_source".into(), source.quote["id"].clone());
    // orgtree_project read_presentation names it by the old id
    let read = crate::domain::ops::run(&e, &o, crate::domain::ops::Actor::User,
        &json!({ "op": "project_presentations", "action": "read_presentation", "node": "launch", "document": "d00000000c002" })).await.unwrap();
    assert_eq!((read["documents"][0]["id"].as_str(), read["documents"][0]["ref"].as_str()), (Some("launch-deck"), Some("@doc:routes-a/launch-deck")));
    proof.insert("read_presentation".into(), read["documents"][0]["id"].clone());
    // the feed and the notification keep their old key and open by the slug
    let feed = crate::feed::compute::agents(&c, a, &[writer]).await.unwrap();
    let ids: Vec<&str> = feed[&writer]["x_docs"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["weekly-status-2", "weekly-status"]);
    let notices = crate::domain::notices::for_org(&c, a, &slug).await.unwrap();
    let notice = notices.iter().find(|n| n["id"] == format!("doc:{old}")).expect("the old notice key");
    assert_eq!(notice["source_id"], "weekly-status");
    proof.insert("feed".into(), json!(ids));
    proof.insert("notice".into(), json!([notice["id"], notice["source_id"]]));
    // orgtree_present replaces by the old id: the card keeps its slug when the title changes
    let p = crate::domain::docs::presenter_in(&e, &o, writer, &c).await.unwrap();
    let (text, card) = crate::domain::docs::present(&e, &o, &p, &json!({ "title": "Weekly status, week 44", "body": "new", "replaces": old })).await.unwrap();
    assert_eq!(card["presentation"]["id"], "weekly-status");
    assert_eq!(card["presentation"]["ref"], "@doc:routes-a/weekly-status");
    assert!(text.contains("id weekly-status") && text.contains("@doc:routes-a/weekly-status"), "{text}");
    let (_, card2) = crate::domain::docs::present(&e, &o, &p, &json!({ "title": "Weekly status, week 45", "body": "newer", "replaces": "weekly-status" })).await.unwrap();
    assert_eq!(card2["presentation"]["id"], "weekly-status");
    assert_eq!(c.query_one("SELECT title FROM ot.documents WHERE uid = $1", &[&old]).await.unwrap().get::<_, String>(0), "Weekly status, week 45");
    assert!(crate::domain::docs::present(&e, &o, &p, &json!({ "title": "x", "body": "x", "replaces": "d00000000c009" })).await.is_err(),
        "another org's old id is not yours to replace");
    proof.insert("replaces_old_id".into(), card["presentation"]["id"].clone());
    // dismissing by the old id
    let Json(gone) = crate::http::docs::dismiss(State(e.clone()), Path((slug.clone(), old.into()))).await.unwrap();
    assert_eq!(gone["node"], "writer");
    assert!(c.query_one("SELECT dismissed FROM ot.documents WHERE uid = $1", &[&old]).await.unwrap().get::<_, bool>(0));
    assert_eq!(found(search("weekly").await.unwrap().0), ["weekly-status-2"], "a dismissed presentation is not offered");
    proof.insert("dismiss".into(), json!(true));
    std::fs::write(fixture.engine_root("document-slugs").join("routes.json"), Value::Object(proof).to_string()).unwrap();
    drop(e);
    drop(c);
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn new_presentations_get_free_slugs_one_org_at_a_time() {
    let (fixture, cfg, mut c, task) = staged("present").await;
    super::run(&mut c, &|_| {}).await.unwrap();
    let a = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'present-a', 'Present A') RETURNING id", &[]).await;
    let writer = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    c.execute("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body) VALUES ('d00000000e001', $1, $2, 'writer', 'Old one', 'x')", &[&a, &writer]).await.unwrap();
    let e = engine(&fixture, &cfg, "document-present", &[(a, "present-a")]);
    let o = org(&e, "present-a");
    let p = crate::domain::docs::presenter_in(&e, &o, writer, &c).await.unwrap();
    let mut made = Vec::new();
    for title in ["Design review", "Design review", "Design Review?", "Viewed", "d00000000e001", "   ", "Old one"] {
        let (_, card) = crate::domain::docs::present(&e, &o, &p, &json!({ "title": if title.trim().is_empty() { "★" } else { title }, "body": "b" })).await.unwrap();
        made.push(card["presentation"]["id"].as_str().unwrap().to_string());
    }
    assert_eq!(made, ["design-review", "design-review-2", "design-review-3", "viewed-2", "d00000000e001-2", "presentation", "old-one-2"],
        "free slugs: a clash, the `viewed` segment and an old id are skipped");
    // the same title from two connections at once: the second waits for the first
    let (mut first, conn) = cfg.connect(NoTls).await.unwrap();
    let first_task = tokio::spawn(async move { let _ = conn.await; });
    let (second, conn) = cfg.connect(NoTls).await.unwrap();
    let second_task = tokio::spawn(async move { let _ = conn.await; });
    let tx = first.transaction().await.unwrap();
    let held: String = tx.query_one("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body) VALUES ('d00000000e101', $1, $2, 'writer', 'Same time', 'x') RETURNING slug",
        &[&a, &writer]).await.unwrap().get(0);
    let racer = tokio::spawn(async move {
        let slug: String = second.query_one("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body) VALUES ('d00000000e102', $1, $2, 'writer', 'Same time', 'x') RETURNING slug",
            &[&a, &writer]).await.unwrap().get(0);
        drop(second);
        slug
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(!racer.is_finished(), "the second insert waits for the org's slug lock");
    tx.commit().await.unwrap();
    let raced = racer.await.unwrap();
    assert_eq!((held.as_str(), raced.as_str()), ("same-time", "same-time-2"));
    drop(first);
    first_task.await.unwrap();
    second_task.await.unwrap();
    std::fs::write(fixture.engine_root("document-slugs").join("present.json"),
        json!({ "made": made, "concurrent": [held, raced] }).to_string()).unwrap();
    drop(e);
    drop(c);
    task.await.unwrap();
}

/// orgtree_present as an agent calls it.
#[nolog]
async fn present(e: &Arc<Engine>, o: &Arc<OrgHandle>, p: &crate::domain::docs::Presenter, args: Value) -> anyhow::Result<(String, Value)> {
    crate::domain::docs::present(e, o, p, &args).await
}

/// User 2026-10-27 mea228250b31e: "just encourage agents to use an english
/// name for the slug, the actual name can be whatever it needs to be in any
/// language"; mdcb7ce9a8103: "Add the field (recommended)".
#[tokio::test]
#[ignore = "requires an owned disposable rig cluster (native fixture); never an ambient DB"]
#[nolog]
async fn requested_slugs_name_new_presentations_only() {
    let (fixture, cfg, mut c, task) = staged("requested").await;
    super::run(&mut c, &|_| {}).await.unwrap();
    let a = one_i64(&c, "INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'requested-a', 'Requested A') RETURNING id", &[]).await;
    let writer = one_i64(&c, "INSERT INTO ot.agents (org_id, name, tier, state, born) VALUES ($1, 'writer', 'sol', 'live', 'synthetic') RETURNING id", &[&a]).await;
    c.execute("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body) VALUES ('d00000000f001', $1, $2, 'writer', 'Old one', 'x')", &[&a, &writer]).await.unwrap();
    let e = engine(&fixture, &cfg, "document-requested", &[(a, "requested-a")]);
    let o = org(&e, "requested-a");
    let p = crate::domain::docs::presenter_in(&e, &o, writer, &c).await.unwrap();
    let title = "דוח שבועי";
    let (text, card) = present(&e, &o, &p, json!({ "title": title, "body": "b", "slug": "weekly-report" })).await.unwrap();
    assert_eq!((card["presentation"]["id"].as_str(), card["presentation"]["title"].as_str()), (Some("weekly-report"), Some(title)),
        "an English slug names a Hebrew title");
    assert_eq!(card["presentation"]["ref"], "@doc:requested-a/weekly-report");
    assert!(text.contains("id weekly-report"), "{text}");
    // the title's cleanup and clash suffixes; an empty slug is no slug
    let x48 = "x".repeat(48);
    let mut made = Vec::new();
    for slug in [json!("weekly-report"), json!("  Weekly Report!  "), json!("viewed"), json!("d00000000f001"), json!("old-one"),
                 json!("x".repeat(60)), json!("Résumé 2026"), json!(""), json!("   "), Value::Null] {
        let (_, card) = present(&e, &o, &p, json!({ "title": title, "body": "b", "slug": slug })).await.unwrap();
        made.push(card["presentation"]["id"].as_str().unwrap().to_string());
    }
    let (_, card) = present(&e, &o, &p, json!({ "title": title, "body": "b" })).await.unwrap();
    made.push(card["presentation"]["id"].as_str().unwrap().to_string());
    assert_eq!(made, ["weekly-report-2", "weekly-report-3", "viewed-2", "d00000000f001-2", "old-one-2", x48.as_str(), "r-sum-2026",
        "presentation", "presentation-2", "presentation-3", "presentation-4"]);
    // refused: a slug with replaces (slugs stay fixed once made), one the
    // cleanup leaves empty (never a silent `presentation`), one that is no text
    let before = one_i64(&c, "SELECT count(*) FROM ot.documents WHERE org_id = $1", &[&a]).await;
    let refused = |r: anyhow::Result<(String, Value)>| r.err().map(|e| e.to_string()).unwrap_or_default();
    let mut refusals = Vec::new();
    let fixed = refused(present(&e, &o, &p, json!({ "title": "Weekly report", "body": "c", "slug": "weekly-report", "replaces": "weekly-report" })).await);
    assert!(fixed.contains("slug") && fixed.contains("replaces"), "{fixed:?}");
    refusals.push(fixed);
    for slug in ["שלום", "—", "-- __ --"] {
        let empty = refused(present(&e, &o, &p, json!({ "title": title, "body": "b", "slug": slug })).await);
        assert!(empty.contains("English"), "{slug:?}: {empty:?}");
        refusals.push(empty);
    }
    let wrong = refused(present(&e, &o, &p, json!({ "title": title, "body": "b", "slug": 7 })).await);
    assert!(wrong.contains("slug"), "{wrong:?}");
    refusals.push(wrong);
    assert_eq!(one_i64(&c, "SELECT count(*) FROM ot.documents WHERE org_id = $1", &[&a]).await, before, "a refused call makes nothing");
    assert_eq!(c.query_one("SELECT title FROM ot.documents WHERE org_id = $1 AND slug = 'weekly-report'", &[&a]).await.unwrap().get::<_, String>(0), title,
        "the refused replace changed nothing");
    // a replace without a slug keeps the slug, as before
    let (_, kept) = present(&e, &o, &p, json!({ "title": "Weekly report", "body": "c", "replaces": "weekly-report" })).await.unwrap();
    assert_eq!(kept["presentation"]["id"], "weekly-report");
    // the database names every insert, so another path's requested slug is cleaned there too
    let sql: String = c.query_one("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, slug) VALUES ('d00000000f101', $1, $2, 'writer', 'שלום', 'x', 'Weekly Report') RETURNING slug",
        &[&a, &writer]).await.unwrap().get(0);
    assert_eq!(sql, "weekly-report-4");
    let err = c.execute("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, slug) VALUES ('d00000000f102', $1, $2, 'writer', 'x', 'x', 'שלום')",
        &[&a, &writer]).await.unwrap_err();
    let raised = err.as_db_error().map(|d| d.message().to_string()).unwrap_or_default();
    assert!(raised.contains("ASCII letter or digit"), "{err:?}");
    // one lock for both paths: a requested slug waits while a title holds it
    let (mut first, conn) = cfg.connect(NoTls).await.unwrap();
    let first_task = tokio::spawn(async move { let _ = conn.await; });
    let (second, conn) = cfg.connect(NoTls).await.unwrap();
    let second_task = tokio::spawn(async move { let _ = conn.await; });
    let tx = first.transaction().await.unwrap();
    let held: String = tx.query_one("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body) VALUES ('d00000000f201', $1, $2, 'writer', 'Mixed race', 'x') RETURNING slug",
        &[&a, &writer]).await.unwrap().get(0);
    let racer = tokio::spawn(async move {
        let slug: String = second.query_one("INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, slug) VALUES ('d00000000f202', $1, $2, 'writer', 'שלום', 'x', 'mixed-race') RETURNING slug",
            &[&a, &writer]).await.unwrap().get(0);
        drop(second);
        slug
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(!racer.is_finished(), "the requested slug waits for the org's slug lock");
    tx.commit().await.unwrap();
    let raced = racer.await.unwrap();
    assert_eq!((held.as_str(), raced.as_str()), ("mixed-race", "mixed-race-2"));
    drop(first);
    first_task.await.unwrap();
    second_task.await.unwrap();
    std::fs::write(fixture.engine_root("document-slugs").join("requested.json"),
        json!({ "first": "weekly-report", "made": made, "refusals": refusals, "sql": [sql, raised], "concurrent": [held, raced] }).to_string()).unwrap();
    drop(e);
    drop(c);
    task.await.unwrap();
}
