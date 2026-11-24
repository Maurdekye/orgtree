//! Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
//! org-presence-busy-orange-when-no-org-inbox-holde): an org shows busy on
//! its hubs while none of its org-mailbox holders can start a turn. One test
//! per holder state: none, one that can run, halted, frozen, retired, a
//! revoked grant, several holders, single-holder mode's newest grant, and
//! the org's killswitch. Last active (Mail hub 2.6.0): the agents in charge
//! and their last finished turns' ends, with two holders' turns overlapping.
//! Each builds its own disposable `ot` schema in the
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

/// The org-mailbox (@extern) audience for `name`.
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

/// A turn of `agent` from `start` to `end` (None: still running), times as
/// SQL literals.
#[nolog]
async fn turn(c: &tokio_postgres::Client, agent: i64, start: &str, end: Option<&str>) {
    c.execute(
        "INSERT INTO ot.turns (agent_id, started_at, ended_at) VALUES ($1, $2::text::timestamptz, $3::text::timestamptz)",
        &[&agent, &start, &end],
    )
    .await
    .unwrap();
}

#[nolog]
fn at(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    Some(chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc))
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn the_agents_in_charge_and_their_last_turn_ends() {
    let (c, conn, org) = fixture().await;
    let ann = agent(&c, org, "ann").await;
    let bob = agent(&c, org, "bob").await;
    let boss = agent(&c, org, "boss").await;
    grant(&c, org, "ann").await;
    grant(&c, org, "bob").await;
    assert_eq!(in_charge(&c, org, true).await.unwrap(), vec![ann, bob], "holders only");
    assert_eq!(last_turn_ends(&c, &[ann, bob]).await.unwrap(), vec![(ann, None), (bob, None)], "never ran: no end");
    // overlapping turns: ann 10:00-10:40 then a new one running; bob 10:20-10:30
    turn(&c, ann, "2026-11-24T10:00:00Z", Some("2026-11-24T10:40:00Z")).await;
    turn(&c, bob, "2026-11-24T10:20:00Z", Some("2026-11-24T10:30:00Z")).await;
    turn(&c, ann, "2026-11-24T10:50:00Z", None).await;
    turn(&c, boss, "2026-11-24T11:00:00Z", Some("2026-11-24T11:05:00Z")).await;
    assert_eq!(
        last_turn_ends(&c, &[ann, bob]).await.unwrap(),
        vec![(ann, at("2026-11-24T10:40:00Z")), (bob, at("2026-11-24T10:30:00Z"))],
        "each one's last FINISHED turn (ann's running one doesn't hide her 10:40 end)"
    );
    run(&c, "UPDATE ot.agents SET halt = '{\"by\":\"fixture\"}'::jsonb WHERE id = $1", bob).await;
    assert_eq!(in_charge(&c, org, true).await.unwrap(), vec![ann, bob], "a halted holder still counts");
    assert_eq!(in_charge(&c, org, false).await.unwrap(), vec![bob], "single-holder mode: the newest grant only");
    run(&c, "UPDATE ot.agents SET state = 'archived' WHERE id = $1", bob).await;
    assert_eq!(in_charge(&c, org, true).await.unwrap(), vec![ann], "a retired holder is not in charge");
    done(c, conn).await;
}

/// One pass of org_presence's last-active part: the newest finished turn end
/// of those in charge raises the org's mark (single-holder mode).
#[nolog]
async fn pass(c: &tokio_postgres::Client, org: i64) -> Option<chrono::DateTime<chrono::Utc>> {
    let ids = in_charge(c, org, false).await.unwrap();
    let newest = last_turn_ends(c, &ids).await.unwrap().into_iter().filter_map(|e| e.1).max();
    raise_last_active(c, org, newest).await.unwrap()
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn the_last_active_time_never_goes_back() {
    let (c, conn, org) = fixture().await;
    let ann = agent(&c, org, "ann").await;
    let bob = agent(&c, org, "bob").await;
    grant(&c, org, "ann").await;
    turn(&c, ann, "2026-11-24T10:00:00Z", Some("2026-11-24T10:40:00Z")).await;
    turn(&c, bob, "2026-11-24T10:20:00Z", Some("2026-11-24T10:30:00Z")).await;
    // what org_presence does each pass: the newest end of those in charge raises the mark
    assert_eq!(pass(&c, org).await, at("2026-11-24T10:40:00Z"), "ann's end");
    // single-holder mode: the audience moves to bob, who last ran at 10:30
    grant(&c, org, "bob").await;
    assert_eq!(pass(&c, org).await, at("2026-11-24T10:40:00Z"), "a holder swap to an older-run agent keeps the time");
    // bob retired, the mailbox given to a hire that never ran
    run(&c, "UPDATE ot.agents SET state = 'archived' WHERE id = $1", bob).await;
    agent(&c, org, "newbie").await;
    grant(&c, org, "newbie").await;
    assert_eq!(pass(&c, org).await, at("2026-11-24T10:40:00Z"), "a never-run hire keeps the time");
    // every audience revoked: nobody in charge
    run(&c, "UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern'", org).await;
    assert_eq!(pass(&c, org).await, at("2026-11-24T10:40:00Z"), "a revoked audience keeps the time");
    // the engine restarts: the mark is in the database
    let mark: Option<String> = c.query_one("SELECT net->>'last_active_at' FROM ot.orgs WHERE id = $1", &[&org]).await.unwrap().get(0);
    assert!(mark.is_some(), "kept in ot.orgs.net");
    assert_eq!(raise_last_active(&c, org, None).await.unwrap(), at("2026-11-24T10:40:00Z"), "read back as it was");
    // a newer end raises it
    assert_eq!(raise_last_active(&c, org, at("2026-11-24T11:00:00Z")).await.unwrap(), at("2026-11-24T11:00:00Z"));
    done(c, conn).await;
}

#[tokio::test]
#[ignore = "requires an isolated busy_presence_fixture database (ORGTREE_BUSY_TEST_URL)"]
#[nolog]
async fn a_turn_the_engine_start_closed_is_no_turn_end() {
    let (c, conn, org) = fixture().await;
    let ann = agent(&c, org, "ann").await;
    grant(&c, org, "ann").await;
    turn(&c, ann, "2026-11-24T10:00:00Z", Some("2026-11-24T10:40:00Z")).await;
    // the PC went down mid-turn at 18:00; recover() closed it at the next start
    c.execute(
        "INSERT INTO ot.turns (agent_id, started_at, ended_at, killed, error)
         VALUES ($1, '2026-11-24T17:55:00Z', '2026-11-27T09:00:00Z', true, 'the engine stopped during this turn')",
        &[&ann],
    )
    .await
    .unwrap();
    assert_eq!(last_turn_ends(&c, &[ann]).await.unwrap(), vec![(ann, at("2026-11-24T10:40:00Z"))], "the recovered turn leaves the time as it was");
    // an ordinary killed turn (the user stopped it) is a turn end
    c.execute(
        "INSERT INTO ot.turns (agent_id, started_at, ended_at, killed) VALUES ($1, '2026-11-27T09:10:00Z', '2026-11-27T09:12:00Z', true)",
        &[&ann],
    )
    .await
    .unwrap();
    assert_eq!(last_turn_ends(&c, &[ann]).await.unwrap(), vec![(ann, at("2026-11-27T09:12:00Z"))]);
    done(c, conn).await;
}
