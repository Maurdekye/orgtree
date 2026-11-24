//! Weak org-mailbox links (USER 2026-11-24 18:56:37Z m020bbd1926c3; docket
//! weak-org-mailbox-links-several-agents-may-send-a): beside the one primary link (`@extern`), any number of agents
//! may hold a weak link (`@extern-weak`). It lets them send as the org; new arriving mail still goes to the primary;
//! a reply to a mail an agent sent over its weak link goes back to that agent while the link stands.
//! Same isolated `orginbox_queue_fixture` database as `queue_tests`; run them one at a time:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::orginbox::weak_tests`.
use super::*;
use crate::domain::audiences::{grant, party, revoke};
use crate::domain::ops::Actor;
use tokio_postgres::NoTls;

const WEAK: &str = "@extern-weak";

struct World {
    e: Arc<Engine>,
    c: tokio_postgres::Client,
    org: i64,
    /// a second org on this machine, for `@org:` mail
    b: i64,
    boss: i64,
    front: i64,
    scout: i64,
}

/// Org A: top-level `boss`; under it `front` (the primary holder) and `scout`. Org B: `desk`, its primary.
#[nolog]
async fn world(multi: bool) -> World {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    assert_eq!(cfg.get_user(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let settings = json!({ "org_inbox_multi_holder": multi });
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'weak-a','a',$1) RETURNING id", &[&settings]).await.unwrap().get(0);
    let b: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'weak-b','b',$1) RETURNING id", &[&settings]).await.unwrap().get(0);
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_ORGINBOX_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    for (id, slug) in [(org, "weak-a"), (b, "weak-b")] {
        engine.orgs.insert(crate::orgs::provisional(id, slug.into(), slug.into(), slug.into()));
    }
    let agent = |org: i64, name: &'static str, parent: Option<i64>| {
        let c = &c;
        async move {
            c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-24') RETURNING id", &[&org, &name, &parent])
                .await.unwrap().get::<_, i64>(0)
        }
    };
    let boss = agent(org, "boss", None).await;
    let front = agent(org, "front", Some(boss)).await;
    let scout = agent(org, "scout", Some(boss)).await;
    agent(b, "desk", None).await;
    for (o, n) in [(org, "front"), (b, "desk")] {
        c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,$2,'@extern','fixture')", &[&o, &n]).await.unwrap();
    }
    World { e: engine, c, org, b, boss, front, scout }
}

impl World {
    #[nolog]
    fn handle(&self) -> Arc<crate::orgs::OrgHandle> {
        self.e.orgs.by_id(self.org).unwrap()
    }
    #[nolog]
    async fn weak(&self, name: &str) {
        grant(&self.e, &self.handle(), &Actor::User, name, Some("extern-weak"), "t").await.unwrap();
    }
    #[nolog]
    async fn rows(&self, grantor: &str) -> Vec<String> {
        self.c.query("SELECT grantee FROM ot.audiences WHERE org_id=$1 AND grantor=$2 AND revoked_at IS NULL ORDER BY id", &[&self.org, &grantor])
            .await.unwrap().iter().map(|r| r.get(0)).collect()
    }
    /// Scout writes to org B over its weak link; B's desk answers it, quoting it. Returns who in A got the answer.
    #[nolog]
    async fn exchange(&self, body: &str) -> Value {
        let sent = send_extern(&self.e, self.org, &Outgoing::new(From::Agent { id: self.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", body)).await.unwrap();
        let out = self.c.query_one("SELECT net_id FROM ot.org_inbox WHERE org_id=$1 AND uid=$2", &[&self.org, &sent.uid]).await.unwrap();
        let id: String = out.get(0);
        let inc = self.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&self.b, &id]).await.unwrap();
        let desk: i64 = self.c.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='desk'", &[&self.b]).await.unwrap().get(0);
        let mut back = Outgoing::new(From::Agent { id: desk, name: "desk".into(), generation: 1 }, "@org:weak-a", &format!("re: {body}"));
        back.reply_to = Some(json!({ "kind": "mail", "box": "org", "id": inc.get::<_, String>(0), "net_id": id, "peer": "@org:weak-a", "gist": body }));
        send_extern(&self.e, self.b, &back).await.unwrap();
        self.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' ORDER BY id DESC LIMIT 1", &[&self.org]).await.unwrap().get(0)
    }
}

#[test]
#[nolog]
fn the_weak_link_is_its_own_party() {
    for spelled in ["extern-weak", "@extern-weak", "weak-extern", "org-mailbox-weak", "org_mailbox_weak"] {
        assert_eq!(party(Some(spelled)), WEAK, "{spelled}");
    }
    assert_eq!(party(Some("extern")), "@extern", "the primary link is unchanged");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_weak_link_sends_as_the_org_and_new_mail_still_goes_to_the_primary() {
    for multi in [false, true] {
        let w = world(multi).await;
        assert!(!may_send_extern(&w.e, w.org, w.scout, "scout").await.unwrap(), "no link, not top-level: no outside mail");
        w.weak("scout").await;
        assert!(may_send_extern(&w.e, w.org, w.scout, "scout").await.unwrap(), "a weak link sends as the org");
        let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "hello")).await.unwrap();
        let via: bool = w.c.query_one("SELECT via_weak FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
        assert!(via, "the sent row says it went over the weak link");
        assert_eq!(w.rows("@extern").await, vec!["front"], "sending over a weak link grants nothing and replaces nobody");
        assert_eq!(w.rows(WEAK).await, vec!["scout"]);
        assert_eq!(holder_agents(&w.c, w.org, multi).await.unwrap(), vec!["front"], "a weak link is no holder");
        // new mail with no reply reference: the primary only
        let desk: i64 = w.c.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='desk'", &[&w.b]).await.unwrap().get(0);
        send_extern(&w.e, w.b, &Outgoing::new(From::Agent { id: desk, name: "desk".into(), generation: 1 }, "@org:weak-a", "news")).await.unwrap();
        let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='news'", &[&w.org]).await.unwrap().get(0);
        assert_eq!(got, json!(["front"]));
        // the primary's own send is unchanged: not via a weak link
        let own = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.front, name: "front".into(), generation: 1 }, "@org:weak-b", "from front")).await.unwrap();
        let via: bool = w.c.query_one("SELECT via_weak FROM ot.org_inbox WHERE uid=$1", &[&own.uid]).await.unwrap().get(0);
        assert!(!via);
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_reply_to_a_weak_send_goes_back_to_its_sender_while_the_link_stands() {
    let w = world(false).await;
    w.weak("scout").await;
    assert_eq!(w.exchange("q1").await, json!(["scout"]), "the reply goes back over the weak link, to the sender only");
    // the link revoked: the next reply to a weak send goes to the primary
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q2")).await.unwrap();
    revoke(&w.e, &w.handle(), &Actor::User, "scout", Some("extern-weak")).await.unwrap();
    let id: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &id]).await.unwrap().get(0);
    let desk: i64 = w.c.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='desk'", &[&w.b]).await.unwrap().get(0);
    let mut back = Outgoing::new(From::Agent { id: desk, name: "desk".into(), generation: 1 }, "@org:weak-a", "re: q2");
    back.reply_to = Some(json!({ "kind": "mail", "box": "org", "id": inc, "net_id": id, "peer": "@org:weak-a", "gist": "q2" }));
    send_extern(&w.e, w.b, &back).await.unwrap();
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='re: q2'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["front"]), "link revoked: the primary gets it");
    // granted again, then retired: the primary gets it
    w.weak("scout").await;
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q3")).await.unwrap();
    w.c.execute("UPDATE ot.agents SET state='deleted' WHERE id=$1", &[&w.scout]).await.unwrap();
    let id: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &id]).await.unwrap().get(0);
    let mut back = Outgoing::new(From::Agent { id: desk, name: "desk".into(), generation: 1 }, "@org:weak-a", "re: q3");
    back.reply_to = Some(json!({ "kind": "mail", "box": "org", "id": inc, "net_id": id, "peer": "@org:weak-a", "gist": "q3" }));
    send_extern(&w.e, w.b, &back).await.unwrap();
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='re: q3'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["front"]), "sender retired: the primary gets it");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_reply_held_by_do_not_disturb_is_released_to_the_weak_sender() {
    let w = world(false).await;
    w.weak("scout").await;
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"dnd\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    assert_eq!(w.exchange("held?").await, json!([]), "held while the org mailbox is on Do not disturb");
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"normal\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    release_page(&w.e, w.org).await.unwrap();
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='re: held?'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["scout"]), "released to the weak sender, not the primary");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn the_weak_link_and_the_primary_exclude_each_other_and_projects_hold_no_weak_link() {
    let w = world(false).await;
    let org = w.handle();
    assert!(grant(&w.e, &org, &Actor::User, "front", Some("extern-weak"), "t").await.is_err(), "the primary already sends");
    w.weak("scout").await;
    grant(&w.e, &org, &Actor::User, "scout", Some("extern"), "t").await.unwrap();
    assert_eq!(w.rows("@extern").await, vec!["scout"], "single-holder mode: the newest primary replaces the old one, as today");
    assert!(w.rows(WEAK).await.is_empty(), "becoming the primary drops the weak link");
    let proj: i64 = w.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'intake',$2,'project','project','live','{}','2026-11-24') RETURNING id", &[&w.org, &w.boss]).await.unwrap().get(0);
    let _ = proj;
    assert!(grant(&w.e, &org, &Actor::User, "intake", Some("extern-weak"), "t").await.is_err(), "agents only");
    // authority: a top-level agent grants one in its subtree; an agent that is neither top-level nor a holder cannot
    grant(&w.e, &org, &Actor::Agent { id: w.boss, name: "boss".into() }, "front", Some("extern-weak"), "t").await.unwrap();
    assert_eq!(w.rows(WEAK).await, vec!["front"]);
    let by_peer = grant(&w.e, &org, &Actor::Agent { id: w.front, name: "front".into() }, "scout", Some("extern-weak"), "t").await;
    assert!(by_peer.is_err(), "front is neither top-level nor above scout");
    // a weak holder may give up its own link
    revoke(&w.e, &org, &Actor::Agent { id: w.front, name: "front".into() }, "front", Some("extern-weak")).await.unwrap();
    assert!(w.rows(WEAK).await.is_empty());
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn busy_and_last_seen_count_the_primary_only() {
    let w = world(false).await;
    w.weak("scout").await;
    w.c.execute("UPDATE ot.agents SET halt='{\"by\":\"t\"}'::jsonb WHERE id=$1", &[&w.front]).await.unwrap();
    assert!(busy(&w.c, w.org, false).await.unwrap(), "a runnable weak holder does not keep the org online");
    assert_eq!(live_holders(&w.c, w.org, false).await.unwrap(), vec!["front"], "nor is it in charge of the inbox");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_top_level_agents_first_send_takes_a_weak_link_while_a_primary_exists() {
    // Q1 (USER 2026-11-24 19:06:02Z m61f5367a61e7): no silent takeover of the primary
    for multi in [false, true] {
        let w = world(multi).await;
        send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.boss, name: "boss".into(), generation: 1 }, "@org:weak-b", "hi")).await.unwrap();
        assert_eq!(w.rows("@extern").await, vec!["front"], "the primary stays");
        assert_eq!(w.rows(WEAK).await, vec!["boss"], "the top-level sender got a weak link");
    }
    // with no primary, the first send makes the primary, as today
    let w = world(false).await;
    w.c.execute("UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantor='@extern'", &[&w.org]).await.unwrap();
    send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.boss, name: "boss".into(), generation: 1 }, "@org:weak-b", "hi")).await.unwrap();
    assert_eq!(w.rows("@extern").await, vec!["boss"]);
    assert!(w.rows(WEAK).await.is_empty());
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_weak_holder_passes_weak_links_to_its_own_reports_only() {
    // Q4 (USER m61f5367a61e7)
    let w = world(false).await;
    let org = w.handle();
    w.weak("scout").await;
    w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'kid',$2,'sol','live','2026-11-24')", &[&w.org, &w.scout]).await.unwrap();
    let scout = Actor::Agent { id: w.scout, name: "scout".into() };
    grant(&w.e, &org, &scout, "kid", Some("extern-weak"), "t").await.unwrap();
    assert_eq!(w.rows(WEAK).await, vec!["scout", "kid"]);
    assert!(grant(&w.e, &org, &scout, "kid", Some("extern"), "t").await.is_err(), "a weak holder never hands out the primary");
    assert!(grant(&w.e, &org, &scout, "front", Some("extern-weak"), "t").await.is_err(), "front is not scout's report");
    revoke(&w.e, &org, &scout, "kid", Some("extern-weak")).await.unwrap();
    assert_eq!(w.rows(WEAK).await, vec!["scout"]);
}
