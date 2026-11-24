//! The @ menu's read ranks a ticket by its latest STATUS CHANGE (USER 2026-11-24 mbad08856cdb4: "can
//! tickets be ordered based on most recent status update in the mentions menu if they aren't mentioned in
//! the transcript / chat?"; coordinator ma1bbf0c2c8d4: the docket's status_at, newest first, pages stable,
//! presentations, apps and panels as before). The window still lifts what the open conversation mentions
//! above this order. Needs the isolated `orginbox_queue_fixture` database, like
//! domain/orginbox_queue_tests.rs; run alone:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::mention_candidates::status_tests`.
use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn tickets_rank_by_their_latest_status_change_and_the_other_kinds_as_before() {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    assert_eq!(cfg.get_user(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'rank-fixture','fixture','{}') RETURNING id", &[]).await.unwrap().get(0);
    // three tickets with distinct status changes, none of them in any conversation. Their other times
    // point the other way: the one whose status changed LAST was edited FIRST and never mentioned, and
    // the one whose status changed FIRST was edited and mentioned last.
    for (slug, status_at, updated_at, docket_at) in [
        ("first-changed", Some("2026-11-01T10:00:00Z"), "2026-11-20T10:00:00Z", Some("2026-11-20T10:00:00Z")),
        ("then-changed", Some("2026-11-05T10:00:00Z"), "2026-11-10T10:00:00Z", None),
        ("last-changed", Some("2026-11-09T10:00:00Z"), "2026-11-02T10:00:00Z", None),
        // a ticket from before status_at was recorded: its creation stands in, as in the docket's own sort
        ("never-changed", None, "2026-11-21T10:00:00Z", None),
    ] {
        c.execute("INSERT INTO ot.work_items(org_id,slug,title,status,created_by,created_at,updated_at,docket_at,status_at)
            VALUES($1,$2,$2,'open','{}'::jsonb,'2026-11-03T10:00:00Z'::text::timestamptz,$3::text::timestamptz,$4::text::timestamptz,$5::text::timestamptz)",
            &[&org, &slug, &updated_at, &docket_at, &status_at]).await.unwrap();
    }
    c.execute("INSERT INTO ot.mention_recency(org_id,kind,key,at) VALUES($1,'item','first-changed','2026-11-22T10:00:00Z')", &[&org]).await.unwrap();
    // a presentation keeps its own rule: the latest of its presenting and its last mention
    c.execute("INSERT INTO ot.documents(uid,org_id,node_name,title,slug,at) VALUES('d1',$1,'boss','An old note','an-old-note','2026-10-01T10:00:00Z')", &[&org]).await.unwrap();
    c.execute("INSERT INTO ot.mention_recency(org_id,kind,key,at) VALUES($1,'doc','an-old-note','2026-11-07T10:00:00Z')", &[&org]).await.unwrap();

    let ask = |kinds: &[&str], after: Option<Cursor>, limit: i64| Ask { kinds: kinds.iter().map(|k| k.to_string()).collect(), words: vec![], after, limit };
    let ids = |v: &Value| v["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();

    let tickets = page(&c, org, &ask(&["item"], None, 50)).await.unwrap();
    assert_eq!(ids(&tickets), vec!["last-changed", "then-changed", "never-changed", "first-changed"],
        "newest status change first; a ticket without one stands at its creation; an edit or a mention elsewhere does not move a ticket");
    assert!(tickets["items"][0]["at"].as_str().unwrap().starts_with("2026-11-09T10:00:00"), "and the time it carries is that status change");

    // every kind in one order, by each kind's own time
    let all = page(&c, org, &ask(&["item", "doc"], None, 50)).await.unwrap();
    assert_eq!(ids(&all), vec!["last-changed", "an-old-note", "then-changed", "never-changed", "first-changed"],
        "the presentation still ranks by its last mention (7 Nov), between the tickets' status changes");

    // pages are stable: one row a page walks the same order, each row once
    let (mut walked, mut after) = (Vec::new(), None);
    for _ in 0..10 {
        let p = page(&c, org, &ask(&["item", "doc"], after.clone(), 1)).await.unwrap();
        walked.extend(ids(&p));
        match p["next_cursor"].as_str() { Some(raw) => after = Some(Cursor::decode(raw).unwrap()), None => break }
    }
    assert_eq!(walked, ids(&all), "paged one at a time: the same order, nothing twice, nothing lost");
}
