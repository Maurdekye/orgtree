//! The Connections lists' order times (USER 2026-10-29 m3e3829f0bf18) and
//! the hub's registrations for App settings → Mail hub (m12a433749fda).
use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};

use super::*;

#[nolog]
fn t(minutes_ago: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 29, 12, 0, 0).unwrap() - Duration::minutes(minutes_ago)
}

#[test]
#[nolog]
fn an_address_takes_the_newest_mail_any_org_exchanged_with_it_and_an_org_its_own_newest() {
    let rows = vec![
        (1, "alice.aa".to_string(), t(30)),
        (2, "alice.aa".to_string(), t(5)),
        (1, "Bob.BB".to_string(), t(50)),
        (2, "bob.bb".to_string(), t(70)),
    ];
    let plain = newest_by_address(&rows, &HashMap::new());
    assert_eq!(plain.len(), 2, "one time per address, case folded: {plain:?}");
    assert_eq!(plain["alice.aa"], t(5), "the newest of the two orgs' mail");
    assert_eq!(plain["bob.bb"], t(50));
    // an org's own address on the hub list: its own newest mail with the others
    let own = HashMap::from([(2, "home.two".to_string())]);
    let with_own = newest_by_address(&rows, &own);
    assert_eq!(with_own["home.two"], t(5));
    assert_eq!(with_own["alice.aa"], t(5));
    assert!(!with_own.contains_key("home.one"), "an org not listed as own adds nothing");
    assert!(newest_by_address(&[], &own).is_empty());
}

#[test]
#[nolog]
fn the_wire_form_is_slug_to_the_engine_timestamp_sorted() {
    let times = HashMap::from([("b.2".to_string(), t(1)), ("a.1".to_string(), t(2))]);
    let wire = recent_json(&times);
    assert_eq!(wire, json!({ "a.1": "2026-10-29T11:58:00.000Z", "b.2": "2026-10-29T11:59:00.000Z" }));
    let keys: Vec<&String> = wire.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["a.1", "b.2"]);
}

#[test]
#[nolog]
fn the_addresses_read_are_distinct_named_and_capped() {
    let rows = [json!({ "slug": "b.2" }), json!({ "slug": "" }), json!({ "slug": "a.1" }), json!({ "slug": "b.2" }),
        json!({ "name": "no slug" }), json!({ "slug": "c.3" })];
    assert_eq!(distinct_slugs(rows.iter(), 10), ["b.2", "a.1", "c.3"]);
    assert_eq!(distinct_slugs(rows.iter(), 2), ["b.2", "a.1"]);
    assert!(distinct_slugs(rows.iter(), 0).is_empty());
    assert_eq!(MAX_PROBES / 3, 16_666, "three orgs read at most this many addresses each");
}

#[test]
#[nolog]
fn a_hub_row_carries_only_the_roster_fields() {
    let raw = json!({ "slug": "chat.x1", "org_name": "", "username": "orgtree-rustengine", "blurb": "independent Claude Code chat",
        "online": false, "last_seen": "2026-10-29T10:00:00Z", "kind": "chat", "queued": 3, "picture": null,
        "picture_owner": "tok", "fingerprint": "f00" });
    let row = connection_row(&raw).unwrap();
    assert_eq!(row, json!({ "slug": "chat.x1", "org_name": "", "username": "orgtree-rustengine", "blurb": "independent Claude Code chat",
        "online": false, "last_seen": "2026-10-29T10:00:00Z", "kind": "chat", "picture_owner": "tok" }));
    assert!(connection_row(&json!({ "slug": "" })).is_none());
    assert!(connection_row(&json!({ "org_name": "nameless" })).is_none());
}

#[test]
#[nolog]
fn the_migration_only_adds_the_probe_index() {
    let sql = include_str!("../../migrations/0078_org_inbox_peer_recency.sql");
    let statements: Vec<&str> = sql.lines().filter(|l| !l.trim_start().starts_with("--") && !l.trim().is_empty()).collect();
    assert_eq!(statements, ["CREATE INDEX IF NOT EXISTS org_inbox_peer_at ON ot.org_inbox (org_id, peer, at);"]);
    assert!(NEWEST_SQL.contains("i.org_id = o.id AND i.peer = '@net:' || p.slug") && NEWEST_SQL.contains("ORDER BY i.at DESC LIMIT 1"),
        "each pair is the index's own probe: equal org and peer, newest time");
}

#[tokio::test]
#[nolog]
async fn a_hub_that_is_not_running_lists_nothing() {
    let engine = crate::engine::Engine::for_tests(std::env::temp_dir().join("orgtree-recent-unused"));
    assert_eq!(hub_connections(&engine).await, json!({ "running": false, "connections": [], "recent": {} }));
}

/// A stand-in for the hub's main port: answers one request, and hands back
/// the request it got.
#[nolog]
async fn one_answer(status: &'static str, body: String) -> (String, tokio::sync::oneshot::Receiver<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });
    (address, rx)
}

#[tokio::test]
#[nolog]
async fn the_hub_list_is_its_operator_views_rows_read_without_credentials() {
    // the shape of the pinned hub's GET /ui/data (api/ops.rs ui_data): roster rows plus a queued count
    let body = json!({ "name": "maurdekye-net", "version": "2.2.0", "retention_days": null, "orgs": [
        { "slug": "alpha.home.1", "org_name": "alpha test", "username": "", "blurb": "", "online": true,
          "last_seen": "2026-10-29T11:00:00Z", "kind": "org", "picture_owner": "t1", "queued": 0 },
        { "slug": "cc.chat.2", "org_name": "", "username": "orgtree-rustengine", "blurb": "independent Claude Code chat",
          "online": false, "last_seen": null, "kind": "chat", "picture_owner": "t2", "queued": 2 },
        { "slug": "", "org_name": "nameless" } ] }).to_string();
    let (address, request) = one_answer("200 OK", body).await;
    let engine = crate::engine::Engine::for_tests(std::env::temp_dir().join("orgtree-recent-unused"));
    engine.hub.address.store(Some(Arc::new(address)));
    assert_eq!(hub_connections(&engine).await, json!({ "running": true, "recent": {}, "connections": [
        { "slug": "alpha.home.1", "org_name": "alpha test", "username": "", "blurb": "", "online": true,
          "last_seen": "2026-10-29T11:00:00Z", "kind": "org", "picture_owner": "t1" },
        { "slug": "cc.chat.2", "org_name": "", "username": "orgtree-rustengine", "blurb": "independent Claude Code chat",
          "online": false, "kind": "chat", "picture_owner": "t2" } ] }),
        "the roster's own fields; no org here uses the hub, so no times and no database read");
    let request = request.await.unwrap();
    assert!(request.starts_with("GET /ui/data HTTP/1.1\r\n"), "{request}");
    assert!(!request.to_ascii_lowercase().contains("x-org-auth"), "no credential is sent: {request}");
}

#[tokio::test]
#[nolog]
async fn a_hub_that_does_not_answer_says_why() {
    let engine = crate::engine::Engine::for_tests(std::env::temp_dir().join("orgtree-recent-unused"));
    let (address, _request) = one_answer("500 Internal Server Error", "{}".to_string()).await;
    engine.hub.address.store(Some(Arc::new(address)));
    let out = hub_connections(&engine).await;
    assert_eq!((out["running"].clone(), out["connections"].clone(), out["error"].clone()),
        (json!(true), json!([]), json!("the hub answered 500 Internal Server Error")));
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    engine.hub.address.store(Some(Arc::new(address)));
    let out = hub_connections(&engine).await;
    assert!(out["error"].as_str().is_some_and(|e| e.starts_with("the hub did not answer")), "{out}");
    assert_eq!(out["connections"], json!([]));
}

/// The read's plan, measured (EXPLAIN ANALYZE, JSON).
#[nolog]
async fn explain(c: &tokio_postgres::Client, orgs: Vec<i64>, slugs: &[String]) -> anyhow::Result<Value> {
    let sql = format!("EXPLAIN (ANALYZE, FORMAT JSON) {NEWEST_SQL}");
    Ok(c.query_one(&sql, &[&orgs, &slugs]).await?.get(0))
}

/// A throwaway cluster in an empty folder the test owner owns below its build
/// scope; never an ambient or live database.
#[nolog]
fn owned_root() -> std::path::PathBuf {
    let root = std::path::PathBuf::from(std::env::var("ORGTREE_RECENT_TEST_ROOT").expect("ORGTREE_RECENT_TEST_ROOT: an owned empty folder"));
    let owner = std::env::var("ORGTREE_AGENT").expect("ORGTREE_AGENT");
    assert!(!owner.is_empty() && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "invalid owner");
    let base = std::path::Path::new("C:/orgtree-build").join(&owner).canonicalize().expect("the owner's build scope");
    assert!(root.is_absolute(), "the test root must be absolute");
    let root_c = root.canonicalize().expect("the test root exists");
    assert!(root_c.starts_with(&base) && root_c != base, "the test root must be below {}", base.display());
    assert_eq!(std::fs::read_dir(&root_c).unwrap().count(), 0, "the test root must start empty");
    // checked in canonical form; used as given: initdb refuses the verbatim path that canonicalize() returns
    root
}

#[tokio::test]
#[ignore = "needs ORGTREE_P03_PG_BIN and an owned empty ORGTREE_RECENT_TEST_ROOT (a throwaway cluster); never an ambient database"]
#[nolog]
async fn newest_mail_is_one_index_probe_per_pair_and_skips_pairs_with_no_mail() {
    let root = owned_root();
    let mut engine = crate::engine::Engine::for_tests(root.join("data"));
    {
        let e = Arc::get_mut(&mut engine).unwrap();
        e.cfg.pg_bin = Some(std::env::var("ORGTREE_P03_PG_BIN").expect("ORGTREE_P03_PG_BIN").into());
        e.cfg.pg_bootstrap = true;
    }
    let mut pg = crate::pg::Cluster::start(&engine.cfg, &|_| {}).await.unwrap();
    let outcome: anyhow::Result<()> = async {
        pg.ensure_database(crate::pg::ENGINE_DB).await?;
        let (mut c, conn) = pg.connect_config(crate::pg::ENGINE_DB).connect(tokio_postgres::NoTls).await?;
        let task = tokio::spawn(conn);
        crate::migrate::run(&mut c, &|_| {}).await?;
        let index: Option<String> = c.query_one("SELECT indexdef FROM pg_indexes WHERE schemaname = 'ot' AND indexname = 'org_inbox_peer_at'", &[]).await?.get(0);
        assert_eq!(index.as_deref(), Some("CREATE INDEX org_inbox_peer_at ON ot.org_inbox USING btree (org_id, peer, at)"));
        c.batch_execute("
            INSERT INTO ot.orgs (uuid, slug, name) VALUES (gen_random_uuid(), 'conn-a', 'Conn A'), (gen_random_uuid(), 'conn-b', 'Conn B');
            -- conn-a: mail with alice both ways, bob in, an internal @org: peer; carol never
            INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, at)
              SELECT 'x-' || n, (SELECT id FROM ot.orgs WHERE slug = 'conn-a'), d, p, 'synthetic', now() - make_interval(mins => m)
                FROM (VALUES (1, 'in', '@net:alice.aa', 50), (2, 'out', '@net:alice.aa', 10), (3, 'in', '@net:bob.bb', 30),
                             (4, 'out', '@org:local-org', 1)) v(n, d, p, m);
            -- conn-b: alice most recently of all
            INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, at)
              SELECT 'x-b1', id, 'in', '@net:alice.aa', 'synthetic', now() - make_interval(mins => 5) FROM ot.orgs WHERE slug = 'conn-b';
            -- a long history with other addresses, so a read that grew with it would show
            INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, at)
              SELECT 'f-' || g, (SELECT id FROM ot.orgs WHERE slug = 'conn-a'), CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END,
                     '@net:filler.' || (g % 40), 'synthetic', now() - make_interval(secs => g)
                FROM generate_series(1, 40000) g;
            ANALYZE ot.org_inbox;").await?;
        let ids: HashMap<String, i64> = c.query("SELECT slug, id FROM ot.orgs WHERE slug LIKE 'conn-%'", &[]).await?
            .iter().map(|r| (r.get(0), r.get(1))).collect();
        let (a, b) = (ids["conn-a"], ids["conn-b"]);
        let slugs: Vec<String> = ["alice.aa", "bob.bb", "carol.cc", "local-org"].map(String::from).to_vec();
        let mut found = newest_mail(&c, &[a, b], &slugs).await?;
        found.sort_by(|x, y| (x.0, &x.1).cmp(&(y.0, &y.1)));
        let ago = |row: &(i64, String, DateTime<Utc>)| (Utc::now() - row.2).num_minutes();
        let shape: Vec<(i64, &str, i64)> = found.iter().map(|r| (r.0, r.1.as_str(), ago(r))).collect();
        assert_eq!(shape, [(a, "alice.aa", 10), (a, "bob.bb", 30), (b, "alice.aa", 5)],
            "newest per pair, either way; carol and the @org: peer have none");
        let own = HashMap::from([(b, "conn-b.home".to_string())]);
        let by = newest_by_address(&found, &own);
        assert_eq!(((Utc::now() - by["alice.aa"]).num_minutes(), (Utc::now() - by["conn-b.home"]).num_minutes()), (5, 5));
        // The plan: one backward probe of the new index per (org, address)
        // pair, each reading at most one row, whatever the history.
        let scans = |plan: &Value| {
            let mut out = Vec::new();
            let mut stack = vec![plan[0]["Plan"].clone()];
            while let Some(node) = stack.pop() {
                if node["Relation Name"] == "org_inbox" {
                    out.push((node["Node Type"].as_str().unwrap_or("").to_string(), node["Index Name"].as_str().unwrap_or("").to_string(),
                        node["Actual Loops"].as_f64().unwrap_or(0.0), node["Actual Rows"].as_f64().unwrap_or(0.0),
                        node["Rows Removed by Filter"].as_f64().unwrap_or(0.0)));
                }
                stack.extend(node["Plans"].as_array().cloned().unwrap_or_default());
            }
            out
        };
        let with_index = scans(&explain(&c, vec![a, b], &slugs).await?);
        println!("RECENT_PLAN with the index (node, index, loops, rows per loop, removed per loop): {with_index:?}");
        assert_eq!(with_index.len(), 1, "one scan of org_inbox: {with_index:?}");
        let (node, index, loops, rows, removed) = with_index[0].clone();
        assert!(node.starts_with("Index") && index == "org_inbox_peer_at", "probes org_inbox_peer_at: {with_index:?}");
        assert_eq!(loops, 8.0, "two orgs x four addresses");
        assert!(rows <= 1.0 && removed == 0.0, "at most one row per probe, nothing filtered: {with_index:?}");
        // Control: without the index the same read walks the history.
        c.batch_execute("DROP INDEX ot.org_inbox_peer_at").await?;
        let without = scans(&explain(&c, vec![a, b], &slugs).await?);
        let walked: f64 = without.iter().map(|s| s.2 * (s.3 + s.4)).sum();
        println!("RECENT_PLAN without it: {without:?}; rows walked {walked}");
        assert!(without.iter().all(|s| s.1 != "org_inbox_peer_at") && walked > 1000.0,
            "the control reads the history without the index: {without:?}");
        drop(c);
        task.abort();
        anyhow::Ok(())
    }
    .await;
    pg.stop().await;
    outcome.unwrap();
}
