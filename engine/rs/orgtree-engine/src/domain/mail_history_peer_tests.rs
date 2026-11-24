//! One chat's own history pages (`GET /inbox?folder=…&peer=…`; the user's chats, 4.7.0: USER 2026-11-24
//! m46fce69c48c9, coordinator m88adfa46c3a3). The test builds its own disposable `ot` schema in the
//! isolated `orginbox_queue_fixture` database (`ORGTREE_ORGINBOX_TEST_URL`, user and database both
//! `orginbox_queue_fixture`), like domain/orginbox_queue_tests.rs, so run it alone:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::mail_history_peer_tests`.
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use super::mail_history::user_page;

struct World { c: tokio_postgres::Client, org: i64, n: std::cell::Cell<u32> }

#[nolog]
async fn world() -> World {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    assert_eq!(cfg.get_user(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'peer-fixture','fixture','{}') RETURNING id", &[]).await.unwrap().get(0);
    World { c, org, n: std::cell::Cell::new(0) }
}

impl World {
    /// The user writes to an agent. `replies`: the mails this one answers.
    #[nolog]
    async fn sent(&self, to: &str, body: &str, replies: Value) -> String {
        self.row("@user", "agent", to, body, "delivered", replies).await
    }
    /// An agent (or Orgtree itself) writes to the user.
    #[nolog]
    async fn received(&self, from: &str, body: &str, state: &str) -> String {
        self.row(from, "user", "user", body, state, json!([])).await
    }
    #[nolog]
    async fn row(&self, sender: &str, kind: &str, to: &str, body: &str, state: &str, replies: Value) -> String {
        self.n.set(self.n.get() + 1);
        let uid = format!("m-peer-{}", self.n.get());
        self.c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,body,state,replies) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            &[&uid, &self.org, &sender, &kind, &to, &body, &state, &replies]).await.unwrap();
        uid
    }
    #[nolog]
    async fn page(&self, folder: &str, peer: Option<&str>, before: Option<&str>) -> Value {
        user_page(&self.c, self.org, folder, before.map(|b| b.parse().unwrap()), peer).await.unwrap()
    }
}

#[nolog]
fn bodies(page: &Value, field: &str) -> Vec<String> {
    page[field].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap().to_string()).collect()
}
#[nolog]
fn count(page: &Value) -> usize { ["pending", "delivered", "sent"].iter().map(|f| page[*f].as_array().unwrap().len()).sum() }

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_peer_pages_one_chat_fifty_rows_at_a_time_in_each_folder_and_in_both_directions() {
    let w = world().await;
    // the mailbox, oldest first: boss and aide interleaved, so a page of the whole mailbox mixes them
    for i in 0..60 {
        w.sent("boss", &format!("to boss {i}"), json!([])).await;
        if i < 3 { w.sent("aide", &format!("to aide {i}"), json!([])).await; }
        if i < 55 { w.received("boss", &format!("from boss {i}"), if i == 54 { "pending" } else { "read" }).await; }
        if i < 2 { w.received("aide", &format!("from aide {i}"), "read").await; }
    }
    w.received("@system", "from orgtree", "read").await;
    // ONE SEND TO SEVERAL RECIPIENTS (the megaphone) is one row for each of them
    for to in ["aide", "mate"] { w.sent(to, "to both", json!([])).await; }
    // A REPLY THAT ANSWERS SEVERAL MAILS is one row, to its one recipient
    let first = w.c.query("SELECT uid FROM ot.mail WHERE org_id=$1 AND sender='boss' ORDER BY id LIMIT 2", &[&w.org]).await.unwrap();
    let targets: Vec<Value> = first.iter().map(|r| json!({"kind": "mail", "org": "peer-fixture", "box": "user", "id": r.get::<_, String>(0)})).collect();
    w.sent("boss", "answering two", Value::Array(targets)).await;

    // ---- without a peer nothing changes: the whole mailbox, 200 a page
    let all = w.page("sent", None, None).await;
    assert_eq!(all["sent"].as_array().unwrap().len(), 66, "POSITIVE CONTROL: every sent row, every recipient mixed");
    assert_eq!(count(&w.page("inbox", None, None).await), 58);

    // ---- the sent folder, by recipient
    let s1 = w.page("sent", Some("boss"), None).await;
    assert_eq!(s1["sent"].as_array().unwrap().len(), 50, "fifty rows a page");
    assert!(s1["sent"].as_array().unwrap().iter().all(|m| m["to"] == "boss"), "all to that recipient");
    assert_eq!(s1["sent"][0]["body"], "answering two", "newest first");
    assert_eq!(count(&s1), 50);
    let s2 = w.page("sent", Some("boss"), s1["next_cursor"].as_str()).await;
    assert_eq!((s2["sent"].as_array().unwrap().len(), s2["next_cursor"].is_null()), (11, true), "the cursor walks to the end of that chat");
    let mut boss = bodies(&s1, "sent"); boss.extend(bodies(&s2, "sent"));
    assert_eq!(boss.iter().filter(|b| b.starts_with("to boss ")).count(), 60, "every message to boss, once");
    assert_eq!(boss.iter().filter(|b| *b == "answering two").count(), 1, "a reply that answers several mails is one message in its recipient's chat");
    assert_eq!(s1["sent"][0]["replies"].as_array().map(Vec::len), Some(2), "with every mail it answers");
    // one send to two recipients is in the page of each of them, once, and in nobody else's
    let aide = w.page("sent", Some("aide"), None).await;
    let mate = w.page("sent", Some("mate"), None).await;
    assert_eq!(bodies(&aide, "sent").iter().filter(|b| *b == "to both").count(), 1);
    assert_eq!(bodies(&mate, "sent"), vec!["to both".to_string()]);
    assert_eq!((aide["sent"].as_array().unwrap().len(), aide["next_cursor"].is_null()), (4, true));
    assert!(!boss.iter().any(|b| b == "to both"));

    // ---- the inbox folder, by sender
    let i1 = w.page("inbox", Some("boss"), None).await;
    assert_eq!((i1["pending"].as_array().unwrap().len(), i1["delivered"].as_array().unwrap().len()), (1, 49), "unread mail stays unread in a peer page");
    assert_eq!(i1["pending"][0]["body"], "from boss 54");
    let i2 = w.page("inbox", Some("boss"), i1["next_cursor"].as_str()).await;
    assert_eq!((count(&i2), i2["next_cursor"].is_null()), (5, true));
    assert_eq!(bodies(&w.page("inbox", Some("@system"), None).await, "delivered"), vec!["from orgtree".to_string()], "Orgtree's own chat");

    // ---- the chat folder: both directions under one cursor, newest first
    let c1 = w.page("chat", Some("boss"), None).await;
    assert_eq!(count(&c1), 50, "fifty rows of the conversation, whoever wrote them");
    assert_eq!(c1["sent"][0]["body"], "answering two");
    assert!(c1["sent"].as_array().unwrap().iter().all(|m| m["to"] == "boss"));
    assert!(c1["delivered"].as_array().unwrap().iter().chain(c1["pending"].as_array().unwrap()).all(|m| m["from"] == "boss"));
    assert!(!c1["sent"].as_array().unwrap().is_empty() && count(&c1) > c1["sent"].as_array().unwrap().len(), "both directions in one page");
    let (mut seen, mut cursor, mut pages) = (Vec::new(), None::<String>, 0);
    loop {
        let p = w.page("chat", Some("boss"), cursor.as_deref()).await;
        for f in ["pending", "delivered", "sent"] { seen.extend(p[f].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string())); }
        pages += 1;
        match p["next_cursor"].as_str() { Some(c) => cursor = Some(c.to_string()), None => break }
    }
    assert_eq!((seen.len(), pages), (116, 3), "61 written and 55 received, in three pages");
    seen.sort(); seen.dedup();
    assert_eq!(seen.len(), 116, "no row twice");
    // a page has no hole: nothing of the chat lies between its newest and its oldest row that it lacks
    let ids: Vec<i64> = w.c.query("SELECT id FROM ot.mail WHERE org_id=$1 AND ((sender='@user' AND recipient_name='boss') OR (sender='boss' AND recipient_kind='user')) ORDER BY id DESC LIMIT 50", &[&w.org])
        .await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(c1["next_cursor"].as_str(), Some(ids[49].to_string().as_str()), "the page is the chat's newest fifty rows exactly");
    let aide_chat = w.page("chat", Some("aide"), None).await;
    assert_eq!((aide_chat["sent"].as_array().unwrap().len(), aide_chat["delivered"].as_array().unwrap().len(), aide_chat["next_cursor"].is_null()), (4, 2, true));
    assert_eq!(count(&w.page("chat", Some("nobody"), None).await), 0, "an unknown peer has an empty chat");

    // ---- refusals
    assert!(user_page(&w.c, w.org, "chat", None, None).await.is_err(), "the chat folder needs a peer");
    assert!(user_page(&w.c, w.org, "chat", None, Some("  ")).await.is_err());
    assert!(user_page(&w.c, w.org, "drafts", None, Some("boss")).await.is_err(), "an unknown folder is refused as before");
    assert!(user_page(&w.c, w.org, "sent", None, Some(&"x".repeat(201))).await.is_err());
}
