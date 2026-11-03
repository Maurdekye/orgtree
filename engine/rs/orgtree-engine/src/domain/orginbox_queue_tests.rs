//! Project holders of the org inbox (USER 2026-11-03 m99ee62b87e70, mdf5da6c51202, m896fa990fc53,
//! m63e16cf45188; spec rev 2.1 T4-T19). Each test builds its own disposable `ot` schema in the isolated
//! `orginbox_queue_fixture` database (`ORGTREE_ORGINBOX_TEST_URL`, user and database both
//! `orginbox_queue_fixture`; `ORGTREE_ORGINBOX_TEST_ROOT` = an owned engine root), so run them one at a time:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::orginbox::queue_tests`.
use super::*;
use tokio_postgres::NoTls;

struct World {
    e: Arc<Engine>,
    c: tokio_postgres::Client,
    org: i64,
}

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
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'queue-fixture','fixture',$1) RETURNING id", &[&settings]).await.unwrap().get(0);
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_ORGINBOX_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    World { e: engine, c, org }
}

impl World {
    #[nolog]
    async fn agent(&self, name: &str, parent: Option<i64>) -> i64 {
        self.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-03') RETURNING id", &[&self.org, &name, &parent]).await.unwrap().get(0)
    }
    #[nolog]
    async fn project(&self, name: &str, ack: bool) -> i64 {
        let scope = json!({ "mail_queue": if ack { "ack" } else { "round_robin" } });
        self.c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live',$3,'2026-11-03') RETURNING id", &[&self.org, &name, &scope]).await.unwrap().get(0)
    }
    #[nolog]
    async fn grant(&self, name: &str) {
        self.c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,$2,'@extern','fixture')", &[&self.org, &name]).await.unwrap();
    }
    /// A received hub message, published through the router. Returns its org-inbox uid.
    #[nolog]
    async fn arrive(&mut self, net_id: &str, peer: &str, body: &str, replies: Value) -> (String, jobs::Published) {
        let uid = uid("x");
        let first = replies.as_array().and_then(|a| a.first()).cloned();
        self.c.execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, net_id, hub, reply_to, replies) VALUES ($1,$2,'in',$3,$4,$5,'hub1',$6,$7)",
            &[&uid, &self.org, &peer, &body, &net_id, &first, &replies]).await.unwrap();
        let tx = self.c.transaction().await.unwrap();
        let (p, held) = publish_new(&self.e, &tx, self.org, &uid).await.unwrap();
        assert!(!held);
        tx.commit().await.unwrap();
        (uid, p)
    }
    #[nolog]
    async fn job_extra(&self, mail_uid: &str) -> Value {
        self.c.query_one("SELECT extra FROM ot.mail WHERE uid=$1", &[&mail_uid]).await.unwrap().get(0)
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t4_every_holder_gets_it_agents_as_copies_projects_as_one_job_each() {
    let mut w = world(true).await;
    w.agent("front", None).await;
    w.grant("front").await;
    let p1 = w.project("intake", true).await;
    let p2 = w.project("support", false).await;
    w.grant("intake").await;
    w.grant("support").await;
    let (uid, p) = w.arrive("n1", "@net:bob.1", "hello", json!([])).await;
    assert_eq!(p.copies.len(), 1, "one agent copy");
    assert_eq!(p.jobs.len(), 2, "one pending job per project holder");
    for (job, project) in p.jobs.iter().zip([p1, p2]) {
        assert_eq!(job.project, project);
        let r = w.c.query_one("SELECT sender, sender_agent_id, recipient_agent_id, state, net_id, net_hub, extra FROM ot.mail WHERE uid=$1", &[&job.mail]).await.unwrap();
        assert_eq!(r.get::<_, String>(0), "@net:bob.1", "the exact outside peer stays the sender");
        assert_eq!(r.get::<_, Option<i64>>(1), None);
        assert_eq!(r.get::<_, i64>(2), project);
        assert_eq!(r.get::<_, String>(3), "pending");
        assert_eq!(r.get::<_, Option<String>>(4).as_deref(), Some("n1"));
        assert_eq!(r.get::<_, Option<String>>(5).as_deref(), Some("hub1"));
        assert_eq!(r.get::<_, Value>(6)["org_inbox"], json!({ "uid": uid, "peer": "@net:bob.1" }));
    }
    let delivered: Value = w.c.query_one("SELECT delivered_to FROM ot.org_inbox WHERE uid=$1", &[&uid]).await.unwrap().get(0);
    assert_eq!(delivered, json!(["front", "intake", "support"]), "agents and projects in delivery order");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t6_an_unrunnable_agent_holder_with_a_project_holder_gets_a_waiting_copy_and_no_fallback() {
    let mut w = world(true).await;
    let front = w.agent("front", None).await;
    w.agent("other", None).await;
    w.grant("front").await;
    w.project("intake", true).await;
    w.grant("intake").await;
    w.c.execute("UPDATE ot.agents SET halt='{\"why\":\"fixture\"}'::jsonb WHERE id=$1", &[&front]).await.ok();
    let (_, p) = w.arrive("n2", "@net:bob.1", "hello", json!([])).await;
    assert_eq!(p.copies.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), vec!["front"], "the holder keeps its (waiting) copy");
    assert_eq!(p.jobs.len(), 1);
    let auto: i64 = w.c.query_one("SELECT count(*) FROM ot.audiences WHERE org_id=$1 AND grantee='other'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(auto, 0, "nobody is auto-granted while a project holder exists");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn single_holder_mode_newest_grant_wins_across_agents_and_projects() {
    let w = world(false).await;
    w.agent("front", None).await;
    w.project("intake", true).await;
    w.grant("front").await;
    w.grant("intake").await;
    assert_eq!(holder_rows(&w.c, w.org, false).await.unwrap(), vec![("intake".to_string(), "project".to_string())]);
    assert!(holder_agents(&w.c, w.org, false).await.unwrap().is_empty());
    assert_eq!(holder_agents(&w.c, w.org, true).await.unwrap(), vec!["front".to_string()]);
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t8_a_worker_replies_until_it_acks_and_never_to_anyone_else() {
    let mut w = world(true).await;
    w.agent("front", None).await;
    w.grant("front").await;
    let proj = w.project("intake", true).await;
    w.grant("intake").await;
    let worker = w.agent("worker", Some(proj)).await;
    let (_, p) = w.arrive("n3", "@net:bob.1", "hello", json!([])).await;
    let job = p.jobs[0].mail.clone();
    // hand it out the way the queue does: the claim and the worker's copy
    let copy = uid("m");
    w.c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES($1,$2,'@net:bob.1','agent',$3,'worker','hello','pending',$4)",
        &[&copy, &w.org, &worker, &json!({ "outside_job": job, "via_project": { "id": proj, "name": "intake", "mail": job, "ack": true, "outside": true } })]).await.unwrap();
    w.c.execute("UPDATE ot.mail SET state='read', extra = extra || $2 WHERE uid=$1", &[&job, &json!({ "claimed": { "by_id": worker, "ack": true, "copy": copy } })]).await.unwrap();
    let mk = |to: &str, reply: Option<Value>| {
        let mut o = Outgoing::new(From::Agent { id: worker, name: "worker".into(), generation: 1 }, to, "reply");
        o.reply_to = reply;
        o
    };
    let out = mk("@net:bob.1", Some(json!({ "id": copy, "from": "@net:bob.1" })));
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Allowed(j) if j == job), "before the ack");
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Allowed(_)), "and again: several replies are allowed");
    let elsewhere = mk("@net:mallory.9", out.reply_to.clone());
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &elsewhere).await.unwrap(), jobs::Reply::Refused), "only to the job's own sender");
    let bare = mk("@net:bob.1", None);
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &bare).await.unwrap(), jobs::Reply::NotApplicable), "no reply_to names no job");
    // the ACK ends the right
    w.c.execute("UPDATE ot.mail SET extra = jsonb_set(extra,'{claimed,acked_at}', to_jsonb(now())) WHERE uid=$1", &[&job]).await.unwrap();
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Refused), "after the ack");
    // round-robin handed (ack false): no limit even though acked_at is set
    w.c.execute("UPDATE ot.mail SET extra = jsonb_set(extra,'{claimed,ack}', 'false'::jsonb) WHERE uid=$1", &[&job]).await.unwrap();
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Allowed(_)), "without ACK mode the right has no end");
    // taken back: the job is pending again and unclaimed
    w.c.execute("UPDATE ot.mail SET state='pending', extra = extra - 'claimed' WHERE uid=$1", &[&job]).await.unwrap();
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Refused), "a taken-back job revokes it");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t14_a_hub_reply_to_an_agents_message_goes_to_that_agent_only() {
    let mut w = world(true).await;
    w.agent("front", None).await;
    w.grant("front").await;
    w.project("intake", true).await;
    w.grant("intake").await;
    let worker = w.agent("worker", None).await;
    let sent = uid("x");
    w.c.execute("INSERT INTO ot.org_inbox(uid,org_id,dir,peer,body,by_name,state,net_id,sender_agent_id,sender_generation,via_job) VALUES($1,$2,'out','@net:bob.1','q?','worker','delivered','out1',$3,1,'job-7')",
        &[&sent, &w.org, &worker]).await.unwrap();
    let quote = json!({ "kind": "mail", "box": "org", "id": sent, "peer": "@net:bob.1", "net_id": "out1", "gist": "q?" });
    let (_, p) = w.arrive("n4", "@net:bob.1", "answer", json!([quote])).await;
    assert_eq!(p.copies.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), vec!["worker"]);
    assert!(p.jobs.is_empty(), "no project and no other holder gets it");
    assert_eq!(w.job_extra(&p.copies[0].2).await["outside_job"], "job-7", "the thread keeps the worker's job right");
    // a retired sender falls through to every holder
    w.c.execute("UPDATE ot.agents SET state='deleted' WHERE id=$1", &[&worker]).await.unwrap();
    let (_, p) = w.arrive("n5", "@net:bob.1", "answer 2", json!([quote])).await;
    assert_eq!(p.copies.len(), 1);
    assert_eq!(p.copies[0].1, "front");
    assert_eq!(p.jobs.len(), 1);
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t15_to_t17_a_follow_up_is_bundled_sent_to_the_holder_or_made_a_new_job() {
    let mut w = world(true).await;
    let proj = w.project("intake", true).await;
    w.grant("intake").await;
    let worker = w.agent("worker", Some(proj)).await;
    let (first, p) = w.arrive("n6", "@net:bob.1", "original", json!([])).await;
    let job = p.jobs[0].mail.clone();
    let quote = json!({ "kind": "mail", "box": "org", "id": first, "peer": "@net:bob.1", "net_id": "n6", "gist": "original" });
    // T15: the job is pending: the follow-up is bundled with it
    let (_, p2) = w.arrive("n7", "@net:bob.1", "follow-up 1", json!([quote])).await;
    assert!(p2.jobs.is_empty(), "no new queue place");
    let b: (String, Value) = { let r = w.c.query_one("SELECT state, extra FROM ot.mail WHERE recipient_agent_id=$1 AND body='follow-up 1'", &[&proj]).await.unwrap(); (r.get(0), r.get(1)) };
    assert_eq!(b.0, "read");
    assert_eq!(b.1["bundled_with"], json!(job));
    // T16: claimed, not acked, ACK mode: straight to the holder
    let copy = uid("m");
    w.c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES($1,$2,'@net:bob.1','agent',$3,'worker','original','pending','{}')", &[&copy, &w.org, &worker]).await.unwrap();
    w.c.execute("UPDATE ot.mail SET state='read', extra = extra || $2 WHERE uid=$1", &[&job, &json!({ "claimed": { "by_id": worker, "ack": true, "copy": copy } })]).await.unwrap();
    let (_, p3) = w.arrive("n8", "@net:bob.1", "follow-up 2", json!([quote])).await;
    assert!(p3.jobs.is_empty());
    assert_eq!(p3.copies.len(), 1);
    assert_eq!(p3.copies[0].1, "worker");
    assert_eq!(w.job_extra(&p3.copies[0].2).await["outside_job"], json!(job));
    // T17: acked: a new job
    w.c.execute("UPDATE ot.mail SET extra = jsonb_set(extra,'{claimed,acked_at}', to_jsonb(now())) WHERE uid=$1", &[&job]).await.unwrap();
    let (_, p4) = w.arrive("n9", "@net:bob.1", "follow-up 3", json!([quote])).await;
    assert_eq!(p4.jobs.len(), 1, "a new job, threaded to the original");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t19_busy_counts_a_project_holder_with_a_runnable_listener() {
    let w = world(true).await;
    let proj = w.project("intake", true).await;
    w.grant("intake").await;
    let worker = w.agent("worker", Some(proj)).await;
    assert!(busy(&w.c, w.org, true).await.unwrap(), "a project nobody listens to is busy");
    w.c.execute("INSERT INTO ot.watchdogs(org_id,uid,owner_agent_id,kind,state,memo,name,target,interval_s) VALUES($1,'d1',$2,'fair_queue','armed',$3,'d1','intake',15)",
        &[&w.org, &worker, &json!({ "target_id": proj.to_string() })]).await.unwrap();
    assert!(!busy(&w.c, w.org, true).await.unwrap(), "a runnable listener makes it online");
    w.c.execute("UPDATE ot.agents SET halt='{\"why\":\"fixture\"}'::jsonb WHERE id=$1", &[&worker]).await.ok();
    assert!(busy(&w.c, w.org, true).await.unwrap(), "a halted listener does not");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t22_an_org_reply_carries_the_message_id_and_threads_back_to_the_sending_agent() {
    let w = world(true).await;
    let a_boss = w.agent("boss", None).await;
    let b: i64 = w.c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'queue-b','b',$1) RETURNING id", &[&json!({ "org_inbox_multi_holder": true })]).await.unwrap().get(0);
    let b_front: i64 = w.c.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'front','sol','live','2026-11-03') RETURNING id", &[&b]).await.unwrap().get(0);
    w.c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,'front','@extern','fixture')", &[&b]).await.unwrap();
    for (id, slug) in [(w.org, "queue-fixture"), (b, "queue-b")] {
        w.e.orgs.insert(crate::orgs::provisional(id, slug.into(), slug.into(), slug.into()));
    }
    // A's boss writes to B
    let sent = send_extern(&w.e, w.org, &Outgoing::new(From::Agent { id: a_boss, name: "boss".into(), generation: 1 }, "@org:queue-b", "question?")).await.unwrap();
    let out = w.c.query_one("SELECT net_id, sender_agent_id FROM ot.org_inbox WHERE org_id=$1 AND uid=$2", &[&w.org, &sent.uid]).await.unwrap();
    let id: String = out.get::<_, Option<String>>(0).expect("the sent row carries a message id");
    assert_eq!(id.len(), 32, "the hub's id format");
    assert_eq!(out.get::<_, Option<i64>>(1), Some(a_boss), "the sending agent is recorded");
    let inc = w.c.query_one("SELECT uid, net_id, hub FROM ot.org_inbox WHERE org_id=$1 AND dir='in'", &[&b]).await.unwrap();
    assert_eq!(inc.get::<_, Option<String>>(1).as_deref(), Some(id.as_str()), "the receiver's row has the same id");
    assert_eq!(inc.get::<_, Option<String>>(2), None, "hub stays NULL: it did not come over a mail hub");
    // B's front answers, quoting the message by its id
    let mut back = Outgoing::new(From::Agent { id: b_front, name: "front".into(), generation: 1 }, "@org:queue-fixture", "answer");
    back.reply_to = Some(json!({ "kind": "mail", "box": "org", "id": inc.get::<_, String>(0), "net_id": id, "peer": "@org:queue-fixture", "gist": "question?" }));
    send_extern(&w.e, b, &back).await.unwrap();
    // A's row of the answer points at A's own sent row, and the answer goes to the boss only
    let got = w.c.query_one("SELECT reply_to, delivered_to FROM ot.org_inbox WHERE org_id=$1 AND dir='in'", &[&w.org]).await.unwrap();
    assert_eq!(got.get::<_, Value>(0)["id"], json!(sent.uid), "re-pointed at the receiver's own row");
    assert_eq!(got.get::<_, Value>(1), json!(["boss"]));
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t1_t2_t3_a_project_holds_the_audience_like_an_agent_and_its_members_inherit_nothing() {
    use crate::domain::audiences::grant;
    use crate::domain::ops::Actor;
    for multi in [false, true] {
        let w = world(multi).await;
        let org = crate::orgs::provisional(w.org, "queue-fixture".into(), "queue-fixture".into(), "fixture".into());
        w.e.orgs.insert(org.clone());
        w.agent("front", None).await;
        let proj = w.project("intake", false).await; // any queue mode
        let worker = w.agent("worker", Some(proj)).await;
        grant(&w.e, &org, &Actor::User, "front", Some("extern"), "t").await.unwrap();
        grant(&w.e, &org, &Actor::User, "intake", Some("extern"), "t").await.unwrap();
        let holders = holder_rows(&w.c, w.org, multi).await.unwrap();
        if multi {
            assert_eq!(holders.len(), 2, "multi on: an agent and a project hold it together");
        } else {
            assert_eq!(holders, vec![("intake".to_string(), "project".to_string())], "multi off: the project replaced the agent");
            grant(&w.e, &org, &Actor::User, "front", Some("extern"), "t").await.unwrap();
            assert_eq!(holder_rows(&w.c, w.org, false).await.unwrap(), vec![("front".to_string(), "agent".to_string())], "and the reverse");
            grant(&w.e, &org, &Actor::User, "intake", Some("extern"), "t").await.unwrap();
        }
        // T3: the project's members inherit nothing and cannot manage its grants
        assert!(!may_send_extern(&w.e, w.org, worker, "worker").await.unwrap());
        let by_member = grant(&w.e, &org, &Actor::Agent { id: worker, name: "worker".into() }, "intake", Some("extern"), "t").await;
        assert!(by_member.is_err(), "a member does not manage the project's grants");
        let out = Outgoing::new(From::Agent { id: worker, name: "worker".into(), generation: 1 }, "@net:bob.1", "hi");
        assert!(send_extern(&w.e, w.org, &out).await.is_err(), "no job, no outside right");
        // control: a member of a top-level project that holds nothing keeps today's rights
        let plain = w.project("plain", true).await;
        let free = w.agent("free", Some(plain)).await;
        assert!(may_send_extern(&w.e, w.org, free, "free").await.unwrap(), "no grant on its project: unchanged");
        // and a revoked grant makes the first project's members top-level again for outside mail
        w.c.execute("UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantee='intake' AND grantor='@extern'", &[&w.org]).await.unwrap();
        assert!(may_send_extern(&w.e, w.org, worker, "worker").await.unwrap(), "revoked: top-level again");
    }
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn t21_purge_takes_bundled_follow_ups_and_the_follow_up_lookup_uses_its_index() {
    let mut w = world(true).await;
    let proj = w.project("intake", true).await;
    w.grant("intake").await;
    let (first, p) = w.arrive("n20", "@net:bob.1", "original", json!([])).await;
    let quote = json!({ "kind": "mail", "box": "org", "id": first, "peer": "@net:bob.1", "net_id": "n20", "gist": "original" });
    w.arrive("n21", "@net:bob.1", "bundled", json!([quote])).await;
    let _ = p;
    let tx = w.c.transaction().await.unwrap();
    assert_eq!(crate::domain::projects::purge_waiting(&tx, proj, "tester").await.unwrap(), 1);
    tx.commit().await.unwrap();
    let left: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1 AND state<>'retracted'", &[&proj]).await.unwrap().get(0);
    assert_eq!(left, 0, "the bundled follow-up went with its job");
    // the D14 lookup is index-driven on a seeded project mailbox
    w.c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
                 SELECT 'seed'||g, $1, '@net:x.1', 'agent', $2, 'intake', 'b', 'read', '{}'::jsonb FROM generate_series(1,10000) g", &[&w.org, &proj]).await.unwrap();
    w.c.batch_execute("ANALYZE ot.mail").await.unwrap();
    let plan: Vec<String> = w.c.query(
        "EXPLAIN SELECT uid FROM ot.mail WHERE recipient_agent_id=7 AND extra ? 'org_inbox' AND extra->'org_inbox'->>'uid'='u' AND NOT (extra ? 'bundled_with')", &[])
        .await.unwrap().iter().map(|r| r.get(0)).collect();
    let plan = plan.join("
");
    assert!(!plan.contains("Seq Scan on mail"), "no sequential scan of the project mailbox: {plan}");
}
