//! Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
//! org-presence-busy-orange-when-no-org-inbox-holde): an org shows busy on
//! its hubs while none of its org-inbox holders can start a turn. One test
//! per holder state: none, one that can run, halted, frozen, retired, a
//! revoked grant, several holders, single-holder mode's newest grant, and
//! the org's killswitch. Each builds its own disposable `ot` schema in the
//! isolated `busy_presence_fixture` database (`ORGTREE_BUSY_TEST_URL`, user
//! and database both `busy_presence_fixture`), so run them one at a time:
//! `cargo test -p orgtree-engine --bin orgtree-engine -- --ignored --test-threads=1 domain::orginbox::busy_tests`.
use super::*;

#[nolog]
async fn fixture() -> (tokio_postgres::Client, tokio::task::JoinHandle<()>, i64) {
    let url = std::env::var("ORGTREE_BUSY_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("busy_presence_fixture"));
    assert_eq!(cfg.get_user(), Some("busy_presence_fixture"));
    let (mut client, connection) = cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection = tokio::spawn(async move {
        connection.await.unwrap();
    });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let org: i64 = client
        .query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'busy-fixture','fixture') RETURNING id", &[])
        .await
        .unwrap()
        .get(0);
    (client, connection, org)
}

/// A live top-level agent.
#[nolog]
async fn agent(c: &tokio_postgres::Client, org: i64, name: &str) -> i64 {
    c.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,$2,'sol','live','2026-10-30') RETURNING id", &[&org, &name])
        .await
        .unwrap()
        .get(0)
}

/// The org-inbox (@extern) audience for `name`.
#[nolog]
async fn grant(c: &tokio_postgres::Client, org: i64, name: &str) {
    c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, '@extern', 'fixture')", &[&org, &name])
        .await
        .unwrap();
}

#[nolog]
async fn run(c: &tokio_postgres::Client, sql: &str, id: i64) {
    c.execute(sql, &[&id]).await.unwrap();
}

#[nolog]
async fn done(c: tokio_postgres::Client, connection: tokio::task::JoinHandle<()>) {
    drop(c);
    connection.await.unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn with_no_org_inbox_holder_the_org_is_busy() {
    let (c, conn, org) = fixture().await;
    // a top-level agent that can run but holds nothing: the router would
    // still hand it outside mail, but the user's rule counts holders only
    agent(&c, org, "boss").await;
    assert!(busy(&c, org, false).await.unwrap(), "no holder: busy");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_holder_that_can_start_a_turn_makes_it_online() {
    let (c, conn, org) = fixture().await;
    agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    assert!(!busy(&c, org, false).await.unwrap(), "a live holder, not halted or frozen: online");
    assert!(!busy(&c, org, true).await.unwrap(), "the same with several holders allowed");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_halted_holder_makes_it_busy() {
    let (c, conn, org) = fixture().await;
    let front = agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    run(&c, "UPDATE ot.agents SET halt = '{\"by\":\"fixture\"}'::jsonb WHERE id = $1", front).await;
    assert!(busy(&c, org, false).await.unwrap(), "halted: busy");
    run(&c, "UPDATE ot.agents SET halt = NULL WHERE id = $1", front).await;
    assert!(!busy(&c, org, false).await.unwrap(), "unhalted: online again");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_frozen_holder_makes_it_busy() {
    let (c, conn, org) = fixture().await;
    let front = agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    // a usage-limit freeze (any freeze: limit, rate limit, auth, balance, account, lane)
    run(&c, "UPDATE ot.agents SET frozen = '{\"cause\":\"limit\"}'::jsonb WHERE id = $1", front).await;
    assert!(busy(&c, org, false).await.unwrap(), "frozen: busy");
    run(&c, "UPDATE ot.agents SET frozen = NULL WHERE id = $1", front).await;
    assert!(!busy(&c, org, false).await.unwrap(), "thawed: online again");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_retired_holder_makes_it_busy() {
    let (c, conn, org) = fixture().await;
    let front = agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    run(&c, "UPDATE ot.agents SET state = 'archived' WHERE id = $1", front).await;
    assert!(busy(&c, org, false).await.unwrap(), "retired: busy");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_revoked_grant_makes_it_busy() {
    let (c, conn, org) = fixture().await;
    agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    run(&c, "UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern'", org).await;
    assert!(busy(&c, org, false).await.unwrap(), "the audience revoked: busy");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn one_holder_of_several_that_can_start_a_turn_keeps_it_online() {
    let (c, conn, org) = fixture().await;
    let a = agent(&c, org, "ann").await;
    let b = agent(&c, org, "bob").await;
    grant(&c, org, "ann").await;
    grant(&c, org, "bob").await;
    run(&c, "UPDATE ot.agents SET frozen = '{\"cause\":\"limit\"}'::jsonb WHERE id = $1", a).await;
    assert!(!busy(&c, org, true).await.unwrap(), "ann frozen, bob can run: online");
    run(&c, "UPDATE ot.agents SET halt = '{\"by\":\"fixture\"}'::jsonb WHERE id = $1", b).await;
    assert!(busy(&c, org, true).await.unwrap(), "ann frozen and bob halted: busy");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn single_holder_mode_counts_the_newest_grant_only() {
    let (c, conn, org) = fixture().await;
    agent(&c, org, "old").await;
    let new = agent(&c, org, "new").await;
    grant(&c, org, "old").await;
    grant(&c, org, "new").await;
    run(&c, "UPDATE ot.agents SET frozen = '{\"cause\":\"limit\"}'::jsonb WHERE id = $1", new).await;
    assert!(busy(&c, org, false).await.unwrap(), "single-holder mode: the newest holder is frozen, busy");
    assert!(!busy(&c, org, true).await.unwrap(), "several holders allowed: the older one can run, online");
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn the_org_killswitch_makes_it_busy() {
    let (c, conn, org) = fixture().await;
    agent(&c, org, "front").await;
    grant(&c, org, "front").await;
    run(&c, "UPDATE ot.orgs SET killswitch = '{\"by\":\"fixture\"}'::jsonb WHERE id = $1", org).await;
    assert!(busy(&c, org, false).await.unwrap(), "stop all latched: busy");
    run(&c, "UPDATE ot.orgs SET killswitch = NULL WHERE id = $1", org).await;
    assert!(!busy(&c, org, false).await.unwrap(), "released: online again");
    done(c, conn).await;
}
