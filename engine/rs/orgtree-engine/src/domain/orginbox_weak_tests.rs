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
    assert!(!busy(&w.c, w.org, false).await.unwrap(), "failover (USER 2026-11-25 m872c7d4f0973): a runnable weak link acts while the holder can't, and keeps the org online");
    assert_eq!(live_holders(&w.c, w.org, false).await.unwrap(), vec!["front"], "nor is it in charge of the inbox");
}

/// USER 2026-11-25 09:48Z meb7815aff52d: "a mail send from a weak link should update the last seen time, but it
/// shouldnt count as active now while a weak link holder is active".
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_weak_send_moves_last_seen_but_never_makes_the_org_active() {
    let w = world(false).await;
    w.weak("scout").await;
    let before = mark(&w.c, w.org).await;
    let t0 = chrono::Utc::now() - chrono::Duration::seconds(1);
    send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "seen")).await.unwrap();
    let after = mark(&w.c, w.org).await;
    assert!(after.is_some_and(|a| a >= t0 && before.is_none_or(|b| a > b)), "a weak send moves the org's last seen: {before:?} -> {after:?}");
    // the mark is the same high-water mark the turn ends raise: an older end never takes it back
    assert_eq!(raise_last_active(&w.c, w.org, Some(t0 - chrono::Duration::hours(1))).await.unwrap(), after);
    // and the weak link is still never in charge: its turns make no "active now"
    assert!(!in_charge(&w.c, w.org, false).await.unwrap().contains(&w.scout), "a weak link is never in charge");
}

/// The org's last-active mark (`ot.orgs.net.last_active_at`).
#[nolog]
async fn mark(c: &tokio_postgres::Client, org: i64) -> Option<chrono::DateTime<chrono::Utc>> {
    c.query_one("SELECT (net->>'last_active_at')::timestamptz FROM ot.orgs WHERE id=$1", &[&org]).await.unwrap().get(0)
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

// ── Failover (USER 2026-11-25 09:49:41Z m872c7d4f0973 and refinements; @coordinator-opus m22e544059017) ──────────────
// When every primary holder is unable to receive (frozen, halted, retired, none), the earliest-granted weak link that can
// run becomes the ACTING holder for online status, last seen and UNTHREADED new mail only; nothing is persisted. A reply
// always goes to whoever read or sent the message it answers, and waits for them (m459f4474ab14, m6786e284ed6c).

impl World {
    #[nolog]
    async fn desk(&self) -> i64 {
        self.c.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='desk'", &[&self.b]).await.unwrap().get(0)
    }
    /// B's desk writes to A; `refs` are quotes of earlier messages. Returns (B's sent uid, its net id, who in A got it).
    #[nolog]
    async fn from_desk(&self, body: &str, refs: Vec<Value>) -> (String, String, Value) {
        let mut out = Outgoing::new(From::Agent { id: self.desk().await, name: "desk".into(), generation: 1 }, "@org:weak-a", body);
        out.reply_to = refs.first().cloned();
        out.replies = refs;
        let sent = send_extern(&self.e, self.b, &out).await.unwrap();
        let net: String = self.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
        let got: Value = self.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&self.org, &net]).await.unwrap().get(0);
        (sent.uid, net, got)
    }
    /// A quote of a message B holds (its own uid there), by its shared net id.
    #[nolog]
    fn quote(uid: &str, net: &str, gist: &str) -> Value {
        json!({ "kind": "mail", "box": "org", "id": uid, "net_id": net, "peer": "@org:weak-a", "gist": gist })
    }
    #[nolog]
    async fn set(&self, sql: &str, id: i64) {
        self.c.execute(sql, &[&id]).await.unwrap();
    }
}

const FROZEN: &str = "UPDATE ot.agents SET frozen='{\"cause\":\"limit\"}'::jsonb WHERE id=$1";
const HALTED: &str = "UPDATE ot.agents SET halt='{\"by\":\"t\"}'::jsonb WHERE id=$1";
const RETIRED: &str = "UPDATE ot.agents SET state='archived', archived_at=now() WHERE id=$1";
const BACK: &str = "UPDATE ot.agents SET frozen=NULL, halt=NULL, state='live', archived_at=NULL WHERE id=$1";

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn failover_the_earliest_runnable_weak_link_acts_while_every_holder_is_unable() {
    let w = world(false).await;
    let late: i64 = w.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24') RETURNING id", &[&w.org, &w.boss]).await.unwrap().get(0);
    w.weak("scout").await;
    w.weak("late").await;
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap(), None, "a holder that can receive: no failover");
    for (state, sql) in [("frozen", FROZEN), ("halted", HALTED), ("retired", RETIRED)] {
        w.set(sql, w.front).await;
        assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("scout"), "{state}: the earliest-granted weak link acts");
        assert!(!busy(&w.c, w.org, false).await.unwrap(), "{state}: the org stays online");
        assert!(in_charge(&w.c, w.org, false).await.unwrap().contains(&w.scout), "{state}: the acting link counts for active now and last seen");
        let (_, _, got) = w.from_desk(&format!("news {state}"), vec![]).await;
        assert_eq!(got, json!(["scout"]), "{state}: unthreaded new mail goes to the acting link");
        assert_eq!(w.rows("@extern").await, vec!["front"], "{state}: nothing granted or revoked");
        assert_eq!(w.rows(WEAK).await, vec!["scout", "late"], "{state}: the link stays weak");
        // the holder can receive again: at once back to it; what the acting link got stays with it
        w.set(BACK, w.front).await;
        assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap(), None, "{state}: handed back");
        assert!(!in_charge(&w.c, w.org, false).await.unwrap().contains(&w.scout));
        let (_, _, got) = w.from_desk(&format!("back {state}"), vec![]).await;
        assert_eq!(got, json!(["front"]), "{state}: new mail goes to the holder again");
        let kept: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body=$2", &[&w.org, &format!("news {state}")]).await.unwrap().get(0);
        assert_eq!(kept, json!(["scout"]), "{state}: no re-routing of delivered mail");
    }
    // the first weak link can't run either: the next one acts
    w.set(FROZEN, w.front).await;
    w.set(HALTED, w.scout).await;
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("late"));
    // none can run: today's behaviour (busy, and the top-level fallback takes the mail)
    w.set(FROZEN, late).await;
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap(), None);
    assert!(busy(&w.c, w.org, false).await.unwrap());
    let (_, _, got) = w.from_desk("nobody", vec![]).await;
    assert_eq!(got, json!(["boss"]), "no weak link can run: the top-level fallback, as before");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn failover_comes_before_the_auto_grant_when_no_holder_is_live() {
    // since the promotion rule (USER 2026-11-25 mff1aa564451b): with no primary grant at all, new mail promotes the weak
    // link rather than letting it act; the top-level auto-grant still never happens while a weak link exists
    let w = world(false).await;
    w.weak("scout").await;
    w.c.execute("UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantor='@extern'", &[&w.org]).await.unwrap();
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("scout"), "no holder at all: the weak link would act");
    let (_, _, got) = w.from_desk("first", vec![]).await;
    assert_eq!(got, json!(["scout"]));
    assert_eq!(w.rows("@extern").await, vec!["scout"], "the weak link is promoted, never a top-level agent");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_reply_in_the_holders_thread_waits_for_the_holder_even_during_failover() {
    // USER 2026-11-25 09:52:47Z m02f6172c9d3b: "i send an unthreaded reply. it goes to the primary holder. the primary
    // holder then freezes. i reply to my own message. ... it still goes straight to them."
    for (state, sql) in [("frozen", FROZEN), ("retired", RETIRED)] {
        let w = world(false).await;
        w.weak("scout").await;
        // a mail the holder SENT, answered after it became unable, also waits for it
        let mine = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.front, name: "front".into(), generation: 1 }, "@org:weak-b", "from front")).await.unwrap();
        let m_net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&mine.uid]).await.unwrap().get(0);
        let m_inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &m_net]).await.unwrap().get(0);
        let (uid, net, got) = w.from_desk("hello", vec![]).await;
        assert_eq!(got, json!(["front"]));
        w.set(sql, w.front).await;
        assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("scout"));
        let (_, _, got) = w.from_desk("hello again", vec![World::quote(&uid, &net, "hello")]).await;
        assert_eq!(got, json!(["front"]), "{state}: a reply to the desk's own message to the holder waits for the holder");
        let waiting: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND recipient_agent_id=$2 AND body LIKE '%hello again%'", &[&w.org, &w.front]).await.unwrap().get(0);
        assert_eq!(waiting, 1, "{state}: the holder has its copy (a rehire gets it)");
        let (_, _, got) = w.from_desk("re: from front", vec![World::quote(&m_inc, &m_net, "from front")]).await;
        assert_eq!(got, json!(["front"]), "{state}: a reply to the holder's own mail waits for it");
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_retired_weak_sender_stays_cut_off_during_failover() {
    // USER 09:55:22Z m39db776a6ae3 "removing the link cuts it off": its reply goes to the holders
    let w = world(false).await;
    w.weak("scout").await;
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q")).await.unwrap();
    let net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &net]).await.unwrap().get(0);
    w.set(RETIRED, w.scout).await;
    let (_, _, got) = w.from_desk("re: q", vec![World::quote(&inc, &net, "q")]).await;
    assert_eq!(got, json!(["front"]), "a retired weak sender is cut off: the holder gets the reply");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_multi_reply_goes_once_to_each_owner_and_a_frozen_holders_copy_waits() {
    // USER 09:55:57Z mc9c61d55a4ca on the recommendation: one copy per distinct owner; an unreachable owner's copy waits
    let w = world(false).await;
    w.weak("scout").await;
    let (h_uid, h_net, got) = w.from_desk("hello", vec![]).await;
    assert_eq!(got, json!(["front"]));
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q")).await.unwrap();
    let q_net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let q_inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &q_net]).await.unwrap().get(0);
    w.set(FROZEN, w.front).await;
    let (_, net, got) = w.from_desk("both", vec![World::quote(&q_inc, &q_net, "q"), World::quote(&h_uid, &h_net, "hello")]).await;
    let mut names: Vec<String> = got.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["front", "scout"], "one copy to each owner");
    let copies: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND net_id=$2", &[&w.org, &net]).await.unwrap().get(0);
    assert_eq!(copies, 2, "exactly one copy each");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn the_acting_holder_is_kept_as_state_and_each_change_is_told_once() {
    // @coordinator-opus Q3: the acting agent's name in ot.orgs.net, so a restart doesn't repeat the start notice
    let w = world(false).await;
    assert_eq!(note_acting(&w.c, w.org, Some("scout")).await.unwrap(), Some((None, Some("scout".to_string()))), "start");
    assert_eq!(note_acting(&w.c, w.org, Some("scout")).await.unwrap(), None, "unchanged: nothing to tell");
    let kept: Option<String> = w.c.query_one("SELECT net->>'acting_holder' FROM ot.orgs WHERE id=$1", &[&w.org]).await.unwrap().get(0);
    assert_eq!(kept.as_deref(), Some("scout"));
    assert_eq!(note_acting(&w.c, w.org, Some("late")).await.unwrap(), Some((Some("scout".to_string()), Some("late".to_string()))), "the next one");
    assert_eq!(note_acting(&w.c, w.org, None).await.unwrap(), Some((Some("late".to_string()), None)), "end");
    assert_eq!(note_acting(&w.c, w.org, None).await.unwrap(), None);
}

// ── Failover, gap review (@hubchat-web-fable via @coordinator-opus m163ffaa606f6) ──────────────────────────────────

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn while_acting_one_copy_goes_to_the_acting_link_and_nothing_waits_for_the_holder() {
    // item 2: route.to = [acting], no job, no waiting copies to the unable holders
    let w = world(false).await;
    w.weak("scout").await;
    w.set(FROZEN, w.front).await;
    let (_, net, got) = w.from_desk("one copy", vec![]).await;
    assert_eq!(got, json!(["scout"]));
    let copies: Vec<String> = w.c.query("SELECT recipient_name FROM ot.mail WHERE org_id=$1 AND net_id=$2", &[&w.org, &net]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(copies, vec!["scout"], "exactly one copy, to the acting link");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_reply_to_mail_a_retired_weak_link_received_waits_for_the_holders() {
    // items 3 and 6: the thread resolves, but its owner is cut off (a retired weak link): the holders, waiting
    let w = world(false).await;
    w.weak("scout").await;
    w.set(FROZEN, w.front).await;
    let (uid, net, got) = w.from_desk("hello", vec![]).await;
    assert_eq!(got, json!(["scout"]), "acting: the weak link got it");
    w.set(RETIRED, w.scout).await;
    let (_, _, got) = w.from_desk("hello again", vec![World::quote(&uid, &net, "hello")]).await;
    assert_eq!(got, json!(["front"]), "the retired weak link is cut off: the frozen holder's copy waits (not the top-level fallback)");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn only_a_retired_owner_waits_a_deleted_or_unrecoverable_one_falls_to_the_holders() {
    // item 5, per state; the old holder lost its link to a new primary first
    for (state, sql, want) in [
        ("retired", RETIRED, "front"),
        ("deleted", "UPDATE ot.agents SET state='deleted' WHERE id=$1", "late"),
        ("unrecoverable", "UPDATE ot.agents SET state='unrecoverable' WHERE id=$1", "late"),
    ] {
        let w = world(false).await;
        w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
        let (uid, net, got) = w.from_desk("hello", vec![]).await;
        assert_eq!(got, json!(["front"]));
        grant(&w.e, &w.handle(), &Actor::User, "late", Some("extern"), "t").await.unwrap();
        w.set(sql, w.front).await;
        let (_, _, got) = w.from_desk("again", vec![World::quote(&uid, &net, "hello")]).await;
        assert_eq!(got, json!([want]), "{state}");
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_recipient_without_a_link_loses_the_thread_to_the_holders() {
    // item 6: the top-level fallback got the mail (no link); a reply to it goes to the holders
    let w = world(false).await;
    w.set(FROZEN, w.front).await;
    let (uid, net, got) = w.from_desk("nobody home", vec![]).await;
    assert_eq!(got, json!(["boss"]), "no weak link: the top-level fallback, as before");
    w.set(BACK, w.front).await;
    let (_, _, got) = w.from_desk("anyone?", vec![World::quote(&uid, &net, "nobody home")]).await;
    assert_eq!(got, json!(["front"]), "boss holds no link: the holder gets the reply");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_retired_holders_grant_still_means_a_primary_exists_for_a_first_send() {
    // item 7: a top-level agent's first send during failover takes a weak link, never the primary
    let w = world(false).await;
    w.set(RETIRED, w.front).await;
    send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.boss, name: "boss".into(), generation: 1 }, "@org:weak-b", "hi")).await.unwrap();
    assert_eq!(w.rows("@extern").await, vec!["front"], "the retired holder keeps its grant");
    assert_eq!(w.rows(WEAK).await, vec!["boss"], "the sender got a weak link");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn failover_is_told_at_the_first_diverted_mail_on_a_change_and_at_the_end() {
    // items 9, 10, 12, 13: no notice for a freeze that diverts nothing; start at the first diverted mail; A to B in one
    // line; at the end the user, the acting agent and the returning holder (with the contacts handled)
    let w = world(false).await;
    w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
    w.weak("scout").await;
    w.weak("late").await;
    w.set(FROZEN, w.front).await;
    watch_failover(&w.e).await.unwrap();
    assert!(user(&w.c, w.org).await.is_empty(), "a freeze that diverts nothing tells nobody");
    w.from_desk("n1", vec![]).await;
    let said = user(&w.c, w.org).await;
    assert_eq!(said.len(), 1);
    assert!(said[0].contains("@scout is now the acting holder"), "{said:?}");
    assert!(to(&w.c, w.org, "scout").await.iter().any(|b| b.contains("You are now the acting holder")));
    w.from_desk("n2", vec![]).await;
    assert_eq!(user(&w.c, w.org).await.len(), 1, "the same acting link: told once");
    // A to B
    w.set(HALTED, w.scout).await;
    w.from_desk("n3", vec![]).await;
    let said = user(&w.c, w.org).await;
    assert_eq!(said.len(), 2);
    assert!(said[1].contains("changed from @scout to @late"), "{said:?}");
    assert!(to(&w.c, w.org, "late").await.iter().any(|b| b.contains("You are now the acting holder")));
    // the end
    w.set(BACK, w.front).await;
    watch_failover(&w.e).await.unwrap();
    let said = user(&w.c, w.org).await;
    assert_eq!(said.len(), 3);
    assert!(said[2].contains("@late is no longer acting holder") && said[2].contains("@org:weak-b"), "{said:?}");
    assert!(to(&w.c, w.org, "late").await.iter().any(|b| b.contains("no longer the acting holder")));
    assert!(to(&w.c, w.org, "front").await.iter().any(|b| b.contains("@late was the acting holder") && b.contains("@org:weak-b")));
    watch_failover(&w.e).await.unwrap();
    assert_eq!(user(&w.c, w.org).await.len(), 3, "the end is told once");
    let kept: Option<String> = w.c.query_one("SELECT net->>'acting_holder' FROM ot.orgs WHERE id=$1", &[&w.org]).await.unwrap().get(0);
    assert_eq!(kept, None);
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_multi_reply_copy_carries_the_job_of_the_earliest_reference_its_owner_has() {
    // M2: two messages scout sent for two jobs, answered together: one copy, stamped with the first one's job
    let w = world(false).await;
    w.weak("scout").await;
    for (n, job) in [("N-one", "J1"), ("N-two", "J2")] {
        w.c.execute("INSERT INTO ot.org_inbox(uid,org_id,dir,peer,body,by_name,state,net_id,sender_agent_id,sender_generation,via_job,via_weak)
                     VALUES($1,$2,'out','@org:weak-b',$3,'scout','sent',$4,$5,1,$6,true)",
            &[&format!("x-{n}"), &w.org, &format!("for {job}"), &n, &w.scout, &job]).await.unwrap();
    }
    let (_, net, got) = w.from_desk("both jobs", vec![World::quote("b1", "N-one", "for J1"), World::quote("b2", "N-two", "for J2")]).await;
    assert_eq!(got, json!(["scout"]));
    let jobs: Vec<Option<String>> = w.c.query("SELECT extra->>'outside_job' FROM ot.mail WHERE org_id=$1 AND net_id=$2", &[&w.org, &net]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(jobs, vec![Some("J1".to_string())], "one copy, with the earliest reference's job");
}

/// The system's notices to the user in this org, oldest first.
#[nolog]
async fn user(c: &tokio_postgres::Client, org: i64) -> Vec<String> {
    c.query("SELECT body FROM ot.mail WHERE org_id=$1 AND recipient_kind='user' AND sender='@system' ORDER BY id", &[&org]).await.unwrap()
        .iter().map(|r| r.get::<_, String>(0)).collect()
}

/// The system's notices to one agent, oldest first.
#[nolog]
async fn to(c: &tokio_postgres::Client, org: i64, name: &str) -> Vec<String> {
    c.query("SELECT body FROM ot.mail WHERE org_id=$1 AND recipient_name=$2 AND sender='@system' ORDER BY id", &[&org, &name]).await.unwrap()
        .iter().map(|r| r.get::<_, String>(0)).collect()
}

// ── Failover Stage 1 (@coordinator-opus m838cc2f28dde: A3, A6, A10 and the delivered_to fix) ─────────────────────────

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_reply_to_mail_two_holders_got_keeps_both_in_delivered_to() {
    // today's multi-recipient D14: each publish rewrote delivered_to from the stale row, so only the last name stayed
    let w = world(true).await;
    w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
    grant(&w.e, &w.handle(), &Actor::User, "late", Some("extern"), "t").await.unwrap();
    let (uid, net, got) = w.from_desk("hello all", vec![]).await;
    let mut both: Vec<String> = got.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    both.sort();
    assert_eq!(both, vec!["front", "late"]);
    let (_, net2, got) = w.from_desk("again all", vec![World::quote(&uid, &net, "hello all")]).await;
    let mut again: Vec<String> = got.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    again.sort();
    assert_eq!(again, vec!["front", "late"], "both recipients stay in delivered_to");
    let copies: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND net_id=$2", &[&w.org, &net2]).await.unwrap().get(0);
    assert_eq!(copies, 2);
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a3_owner_sets_survive_a_reply_to_the_multi_reply_a_repeat_and_a_rehire() {
    let w = world(false).await;
    w.weak("scout").await;
    let (h_uid, h_net, _) = w.from_desk("hello", vec![]).await;
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q")).await.unwrap();
    let q_net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let q_inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &q_net]).await.unwrap().get(0);
    // a repeated reference: one copy
    let (_, net, got) = w.from_desk("twice", vec![World::quote(&q_inc, &q_net, "q"), World::quote(&q_inc, &q_net, "q")]).await;
    assert_eq!(got, json!(["scout"]));
    let copies: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND net_id=$2", &[&w.org, &net]).await.unwrap().get(0);
    assert_eq!(copies, 1, "a repeated reference makes one copy");
    // the holder retired: its share waits; the weak sender reads its own; a rehire still finds the holder's copy
    w.set(RETIRED, w.front).await;
    let (b_uid, b_net, got) = w.from_desk("both", vec![World::quote(&q_inc, &q_net, "q"), World::quote(&h_uid, &h_net, "hello")]).await;
    let mut names: Vec<String> = got.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["front", "scout"]);
    w.c.execute("UPDATE ot.mail SET state='read' WHERE org_id=$1 AND net_id=$2 AND recipient_name='scout'", &[&w.org, &b_net]).await.unwrap();
    w.set(BACK, w.front).await;
    let front_copy: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND net_id=$2 AND recipient_name='front' AND state<>'read'", &[&w.org, &b_net]).await.unwrap().get(0);
    assert_eq!(front_copy, 1, "the rehired holder still has its own unread copy");
    // a reply to the multi-reply itself reaches both owners again
    let (_, _, got) = w.from_desk("about both", vec![World::quote(&b_uid, &b_net, "both")]).await;
    let mut names: Vec<String> = got.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["front", "scout"], "a reply to the multi-reply keeps every owner");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a10_the_sending_org_hears_delivered_or_waiting_never_the_receivers_names() {
    let w = world(false).await;
    w.weak("scout").await;
    w.set(FROZEN, w.front).await;
    let out = Outgoing::new(From::Agent { id: w.desk().await, name: "desk".into(), generation: 1 }, "@org:weak-a", "who got it?");
    let sent = send_extern(&w.e, w.b, &out).await.unwrap();
    assert_eq!(sent.delivery, "Delivered to weak-a's org mailbox.");
    assert!(!sent.delivery.contains("scout") && !sent.delivery.contains("front"));
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a6_releasing_a_held_reply_in_a_retired_holders_thread_grants_nothing() {
    let w = world(false).await;
    let (uid, net, got) = w.from_desk("hello", vec![]).await;
    assert_eq!(got, json!(["front"]));
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"dnd\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    w.set(RETIRED, w.front).await;
    let (_, _, got) = w.from_desk("held reply", vec![World::quote(&uid, &net, "hello")]).await;
    assert_eq!(got, json!([]), "held under Do not disturb");
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"normal\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    release_page(&w.e, w.org).await.unwrap();
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='held reply'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["front"]), "released into the retired holder's thread, waiting");
    assert_eq!(w.rows("@extern").await, vec!["front"], "no new primary was granted by the release");
}

// ── Promotion (USER 2026-11-25 11:54:27Z mff1aa564451b; edges @coordinator-opus m423778515c90) ──────────────────────
// With NO primary grant at all, new mail promotes a weak link to primary (persisted; its weak link drops): the
// earliest-granted that can run, else the earliest-granted. No weak links: today's auto-grant. A retired holder whose
// grant stands is not "removed" (failover applies instead).

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_removed_primary_is_replaced_by_promoting_a_weak_link() {
    let revoke_primary = "UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantor='@extern'";
    // the earliest-granted weak link that can run
    let w = world(false).await;
    w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
    w.weak("scout").await;
    w.weak("late").await;
    w.c.execute(revoke_primary, &[&w.org]).await.unwrap();
    w.set(HALTED, w.scout).await;
    let (_, _, got) = w.from_desk("news", vec![]).await;
    assert_eq!(got, json!(["late"]), "the runnable weak link is promoted and gets the mail");
    assert_eq!(w.rows("@extern").await, vec!["late"], "a real, persisted primary");
    assert_eq!(w.rows(WEAK).await, vec!["scout"], "its weak link dropped");
    assert!(user(&w.c, w.org).await.iter().any(|b| b.contains("@late was promoted")), "{:?}", user(&w.c, w.org).await);
    assert!(to(&w.c, w.org, "late").await.iter().any(|b| b.contains("You are now the holder of the org mailbox")));
    // none can run: the earliest-granted, whose copy waits
    let w = world(false).await;
    w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
    w.weak("scout").await;
    w.weak("late").await;
    w.c.execute(revoke_primary, &[&w.org]).await.unwrap();
    w.set(HALTED, w.scout).await;
    w.c.execute("UPDATE ot.agents SET frozen='{\"cause\":\"limit\"}'::jsonb WHERE org_id=$1 AND name='late'", &[&w.org]).await.unwrap();
    let (_, _, got) = w.from_desk("news", vec![]).await;
    assert_eq!(got, json!(["scout"]));
    assert_eq!(w.rows("@extern").await, vec!["scout"]);
    // no weak links: today's auto-grant
    let w = world(false).await;
    w.c.execute(revoke_primary, &[&w.org]).await.unwrap();
    let (_, _, got) = w.from_desk("news", vec![]).await;
    assert_eq!(got, json!(["boss"]));
    assert_eq!(w.rows("@extern").await, vec!["boss"]);
    // a retired holder whose grant stands is not removed: failover, no promotion
    let w = world(false).await;
    w.weak("scout").await;
    w.set(RETIRED, w.front).await;
    let (_, _, got) = w.from_desk("news", vec![]).await;
    assert_eq!(got, json!(["scout"]), "the weak link acts");
    assert_eq!(w.rows("@extern").await, vec!["front"], "nobody promoted");
    assert_eq!(w.rows(WEAK).await, vec!["scout"]);
}

// ── Open decisions A-H, approved "all good" (USER 2026-11-25 11:54:27Z mff1aa564451b; text @coordinator-opus ma62987a91396) ──

/// A fresh connection to the fixture, for a test that needs its own transaction.
#[nolog]
async fn own_client() -> tokio_postgres::Client {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let (c, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn a_a_reply_follows_an_agent_only_while_it_holds_a_link() {
    // A: a replaced primary (live, no link) and a retired primary whose grant was revoked lose their threads
    for retire in [false, true] {
        let w = world(false).await;
        w.c.execute("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24')", &[&w.org, &w.boss]).await.unwrap();
        let mine = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.front, name: "front".into(), generation: 1 }, "@org:weak-b", "from front")).await.unwrap();
        let net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&mine.uid]).await.unwrap().get(0);
        let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &net]).await.unwrap().get(0);
        grant(&w.e, &w.handle(), &Actor::User, "late", Some("extern"), "t").await.unwrap(); // replaces front
        if retire { w.set(RETIRED, w.front).await; }
        let (_, _, got) = w.from_desk("re: from front", vec![World::quote(&inc, &net, "from front")]).await;
        assert_eq!(got, json!(["late"]), "retired={retire}: front holds no link, so the current holder gets it");
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn b_an_unidentifiable_original_is_new_mail_and_the_users_own_goes_to_the_holders() {
    let w = world(false).await;
    w.weak("scout").await;
    w.set(FROZEN, w.front).await;
    // an original this org can't identify: new mail, so the stand-in takes it
    let (_, _, got) = w.from_desk("re: ???", vec![World::quote("nowhere", "N-unknown", "???")]).await;
    assert_eq!(got, json!(["scout"]));
    // a reply to mail the user sent from the org mailbox (no agent owner): the holders
    w.c.execute("INSERT INTO ot.org_inbox(uid,org_id,dir,peer,body,by_name,state,net_id) VALUES('x-user',$1,'out','@org:weak-b','from the user','user','sent','N-user')", &[&w.org]).await.unwrap();
    let (_, _, got) = w.from_desk("re: from the user", vec![World::quote("b-user", "N-user", "from the user")]).await;
    assert_eq!(got, json!(["front"]), "the holder, waiting, never the stand-in");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn c_mail_waiting_before_the_takeover_goes_to_the_stand_in() {
    let w = world(false).await;
    w.weak("scout").await;
    w.set(FROZEN, w.front).await;
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"dnd\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    let (_, _, got) = w.from_desk("held news", vec![]).await;
    assert_eq!(got, json!([]), "held under the org's Do not disturb");
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"normal\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    release_page(&w.e, w.org).await.unwrap();
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='held news'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["scout"]), "released to the stand-in");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn e_the_stand_in_is_a_weak_link_not_on_do_not_disturb() {
    let w = world(false).await;
    let late: i64 = w.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'late',$2,'sol','live','2026-11-24') RETURNING id", &[&w.org, &w.boss]).await.unwrap().get(0);
    w.weak("scout").await;
    w.weak("late").await;
    w.set(FROZEN, w.front).await;
    w.c.execute("INSERT INTO ot.turns(agent_id, started_at, do_not_disturb) VALUES($1, now(), true)", &[&w.scout]).await.unwrap();
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("late"), "the earliest one is on DND: the next");
    w.c.execute("INSERT INTO ot.turns(agent_id, started_at, do_not_disturb) VALUES($1, now(), true)", &[&late]).await.unwrap();
    assert_eq!(acting_weak(&w.c, w.org, false).await.unwrap().as_deref(), Some("scout"), "all on DND: the earliest");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn f_a_pull_under_do_not_disturb_never_takes_another_agents_reply() {
    let w = world(false).await;
    w.weak("scout").await;
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q")).await.unwrap();
    let net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &net]).await.unwrap().get(0);
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"dnd\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    w.from_desk("re: q", vec![World::quote(&inc, &net, "q")]).await;
    w.from_desk("plain news", vec![]).await;
    let mut c = own_client().await;
    let tx = c.transaction().await.unwrap();
    let row = |body: &str| format!("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id={} AND dir='in' AND body='{body}'", w.org);
    let reply: Value = tx.query_one(&row("re: q"), &[]).await.unwrap().get(0);
    let news: Value = tx.query_one(&row("plain news"), &[]).await.unwrap().get(0);
    assert!(!jobs::pullable(&tx, w.org, &reply, "front").await.unwrap(), "scout's reply stays for scout");
    assert!(jobs::pullable(&tx, w.org, &news, "front").await.unwrap(), "unthreaded mail can be pulled");
    assert!(jobs::pullable(&tx, w.org, &reply, "scout").await.unwrap(), "its owner may");
    let source = include_str!("../tools/org_inbox.rs");
    assert!(source.contains("jobs_pullable(") || source.contains("pullable("), "the pull checks each row");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn g_a_cut_off_reply_with_no_holder_waits_for_the_next_holder() {
    let w = world(false).await;
    w.weak("scout").await;
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: w.scout, name: "scout".into(), generation: 1 }, "@org:weak-b", "q")).await.unwrap();
    let net: String = w.c.query_one("SELECT net_id FROM ot.org_inbox WHERE uid=$1", &[&sent.uid]).await.unwrap().get(0);
    let inc: String = w.c.query_one("SELECT uid FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND net_id=$2", &[&w.b, &net]).await.unwrap().get(0);
    revoke(&w.e, &w.handle(), &Actor::User, "scout", Some("extern-weak")).await.unwrap();
    w.c.execute("UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantor='@extern'", &[&w.org]).await.unwrap();
    let (_, _, got) = w.from_desk("re: q", vec![World::quote(&inc, &net, "q")]).await;
    assert_eq!(got, json!([]), "no real holder: it waits");
    assert!(w.rows("@extern").await.is_empty(), "and grants nobody");
    // new mail: no weak link left, so today's auto-grant; the waiting reply follows to the new holder
    let (_, _, got) = w.from_desk("news", vec![]).await;
    assert_eq!(got, json!(["boss"]));
    let got: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND body='re: q'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(got, json!(["boss"]), "the next holder gets the waiting reply");
}
