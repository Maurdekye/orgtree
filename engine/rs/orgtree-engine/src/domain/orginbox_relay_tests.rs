//! Project queue relay (relay spec rev 1.4, USER 2026-11-04 16:10:28Z m8bb8c9368e2d), tests RL1-RL14: a `fair_queue` dog owned by
//! project Q and targeting project P re-enqueues P's jobs in Q's own queue. Same isolated `orginbox_queue_fixture` database as
//! `queue_tests`; run them one at a time:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::orginbox::relay_tests`.
use super::*;
use crate::domain::projects;
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
    engine.orgs.insert(crate::orgs::provisional(org, "queue-fixture".into(), "queue-fixture".into(), "fixture".into()));
    World { e: engine, c, org }
}

impl World {
    #[nolog]
    async fn agent(&self, name: &str, parent: Option<i64>) -> i64 {
        self.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-04') RETURNING id", &[&self.org, &name, &parent]).await.unwrap().get(0)
    }
    #[nolog]
    async fn project(&self, name: &str, ack: bool, parent: Option<i64>) -> i64 {
        let scope = json!({ "mail_queue": if ack { "ack" } else { "round_robin" } });
        self.c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,$2,$3,'project','project','live',$4,'2026-11-04') RETURNING id", &[&self.org, &name, &parent, &scope]).await.unwrap().get(0)
    }
    #[nolog]
    async fn grant(&self, name: &str) {
        self.c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,$2,'@extern','fixture')", &[&self.org, &name]).await.unwrap();
    }
    /// A passive agent listener (the way an agent's own `fair_queue` dog is stored).
    #[nolog]
    async fn listener(&self, agent: i64, name: &str, project: i64) {
        self.c.execute("INSERT INTO ot.watchdogs(org_id,uid,owner_agent_id,kind,state,memo,name,target,interval_s) VALUES($1,$2,$3,'fair_queue','armed',$4,$2,'x',15)",
            &[&self.org, &name, &agent, &json!({ "target_id": project.to_string(), "notice": true, "batch": 5 })]).await.unwrap();
    }
    /// The relay dog: project `q` listens to project `p` (stored the way `create` stores a project-owned fair_queue).
    #[nolog]
    async fn relay(&self, q: i64, p: i64, batch: i64) {
        self.c.execute("INSERT INTO ot.watchdogs(org_id,uid,owner_agent_id,owner_kind,kind,state,memo,name,target,interval_s) VALUES($1,$2,$3,'project','fair_queue','armed',$4,$2,(SELECT name FROM ot.agents WHERE id=$5),15)",
            &[&self.org, &format!("relay{q}{p}"), &q, &json!({ "target_id": p.to_string(), "batch": batch, "project_delivery": "queue" }), &p]).await.unwrap();
    }
    #[nolog]
    async fn arrive(&mut self, net_id: &str, body: &str, replies: Value) -> (String, jobs::Published) {
        let uid = uid("x");
        let first = replies.as_array().and_then(|a| a.first()).cloned();
        self.c.execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, net_id, hub, reply_to, replies) VALUES ($1,$2,'in','@net:bob.1',$3,$4,'hub1',$5,$6)",
            &[&uid, &self.org, &body, &net_id, &first, &replies]).await.unwrap();
        let tx = self.c.transaction().await.unwrap();
        let (p, _held) = publish_new(&self.e, &tx, self.org, &uid).await.unwrap();
        tx.commit().await.unwrap();
        (uid, p)
    }
    #[nolog]
    async fn extra(&self, mail_uid: &str) -> Value {
        self.c.query_one("SELECT extra FROM ot.mail WHERE uid=$1", &[&mail_uid]).await.unwrap().get(0)
    }
    /// The child job (in the relaying project's mailbox) of the job `job`.
    #[nolog]
    async fn child(&self, job: &str) -> String {
        self.c.query_one("SELECT uid FROM ot.mail WHERE extra->'relayed_from'->>'job'=$1", &[&job]).await.unwrap().get(0)
    }
    /// The copy `agent` was handed of the job `job`.
    #[nolog]
    async fn copy_of(&self, agent: i64, job: &str) -> (String, Value) {
        let r = self.c.query_one("SELECT uid, extra FROM ot.mail WHERE recipient_agent_id=$1 AND extra->'via_project'->>'mail'=$2", &[&agent, &job]).await.unwrap();
        (r.get(0), r.get(1))
    }
    #[nolog]
    async fn dispatch(&self, project: i64) {
        projects::dispatch(&self.e, self.org, project).await.unwrap();
    }
}

/// P (holds the org inbox), Q (the relaying project) with a worker W that listens to Q.
#[nolog]
async fn rig(p_ack: bool, q_ack: bool, batch: i64) -> (World, i64, i64, i64) {
    let w = world(true).await;
    let p = w.project("P", p_ack, None).await;
    w.grant("P").await;
    let q = w.project("Q", q_ack, None).await;
    let worker = w.agent("W", Some(q)).await;
    w.listener(worker, "wq", q).await;
    w.relay(q, p, batch).await;
    (w, p, q, worker)
}

#[nolog]
fn reply_from(id: i64, name: &str, to: &str, body: &str, copy: &str, from: &str) -> Outgoing {
    let mut o = Outgoing::new(From::Agent { id, name: name.into(), generation: 1 }, to, body);
    o.reply_to = Some(json!({ "id": copy, "from": from }));
    o.wake = false;
    o
}

/// RL2: an outside message in P is claimed by the relay; the child job in Q carries `org_inbox` and `relayed_from`; the worker
/// that claims it gets `outside_job` = the child.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl2_an_outside_job_is_relayed_into_the_queue_of_q_and_its_worker_gets_the_reply_right() {
    let (mut w, p, q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let ex = w.extra(&job).await;
    assert_eq!(ex["claimed"]["by_project"], json!(q), "the relay holds the job");
    assert!(ex["claimed"]["by_id"].is_null() && ex["claimed"]["by_user"] == json!(false), "and nobody else: {ex}");
    let child = w.child(&job).await;
    assert_eq!(ex["relayed_to"], json!({ "project": q, "job": child }));
    let cx = w.extra(&child).await;
    assert_eq!(cx["relayed_from"]["job"], json!(job));
    assert_eq!(cx["relayed_from"]["chain"], json!([p]));
    assert!(cx.get("org_inbox").is_some(), "the child keeps org_inbox: {cx}");
    assert!(cx.get("outside_job").is_none(), "and is not a worker's copy");
    let (_, wx) = w.copy_of(worker, &child).await;
    assert_eq!(wx["outside_job"], json!(child), "W's copy names the child, so it may reply outside (D10)");
    assert_eq!(cx["claimed"]["by_id"], json!(worker));
}

/// RL3: W replies to the outside sender; the out row is W's (D13 follows); the reply is allowed by the child's right.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl3_the_final_worker_may_reply_outside_through_the_relayed_job() {
    let (mut w, p, _q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    let out = reply_from(worker, "W", "@net:bob.1", "answer", &copy, "@net:bob.1");
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Allowed(j) if j == child), "D10 through the chain");
    // the fixture has no mail hub: a synthetic roster entry makes the peer known, so the PRODUCTION send path queues the out row
    crate::net::test_know_peer(&w.e, "bob.1");
    send_extern(&w.e, w.org, &out).await.expect("queued by the production send path");
    let row = w.c.query_one("SELECT uid, net_id, sender_agent_id, via_job FROM ot.org_inbox WHERE org_id=$1 AND dir='out' AND body='answer'", &[&w.org]).await.unwrap();
    assert_eq!((row.get::<_, Option<i64>>(2), row.get::<_, Option<String>>(3)), (Some(worker), Some(child.clone())), "sender_agent_id=W, via_job=J2");
    // D13: the hub reply to that out row goes to W, and makes no new job
    let (out_uid, out_net): (String, Option<String>) = (row.get(0), row.get(1));
    let quote = json!({ "kind": "mail", "box": "org", "id": out_uid, "peer": "@net:bob.1", "net_id": out_net, "gist": "answer" });
    let (_, back) = w.arrive("n9", "thanks", json!([quote])).await;
    assert_eq!(back.copies.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), vec!["W"], "the hub reply goes to W");
    assert!(back.jobs.is_empty());
}

/// RL4: P and Q in ACK mode: W's ACK of the child ACKs the job in P, "relay Q".
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl4_the_workers_ack_acks_the_job_in_p_through_the_relay() {
    let (mut w, p, _q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    assert!(w.extra(&job).await["claimed"]["acked_at"].is_null(), "still outstanding in P while W works");
    let mut ack = Outgoing::new(From::Agent { id: worker, name: "W".into(), generation: 1 }, "Q", "done");
    ack.reply_to = Some(json!({ "id": copy, "from": "@net:bob.1" }));
    ack.wake = false;
    crate::domain::mail::send(&w.e, w.org, ack).await.expect("the ack");
    let ex = w.extra(&job).await;
    assert!(!ex["claimed"]["acked_at"].is_null(), "J is ACKed automatically: {ex}");
    assert_eq!(ex["claimed"]["acked_by"], json!("relay Q"));
}

/// RL5: Q in round-robin mode: custody of the child ends at its hand-out, so J in P (ACK mode) is ACKed then.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl5_a_round_robin_q_ends_custody_at_the_hand_out() {
    let (mut w, p, _q, _worker) = rig(true, false, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let ex = w.extra(&job).await;
    assert!(!ex["claimed"]["acked_at"].is_null(), "J is ACKed as soon as the child is handed to W: {ex}");
    assert_eq!(ex["claimed"]["acked_by"], json!("relay Q"));
}

/// RL6: the child dead-letters in Q, so J dead-letters in P with the relay reason and is not requeued.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl6_a_dead_lettered_child_dead_letters_the_job_in_p() {
    let (mut w, p, q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    w.c.execute("UPDATE ot.mail SET extra = extra || '{\"attempts\": 99}'::jsonb WHERE uid=$1", &[&child]).await.unwrap();
    let row: i64 = w.c.query_one("SELECT id FROM ot.mail WHERE uid=$1", &[&child]).await.unwrap().get(0);
    let tx = w.c.transaction().await.unwrap();
    let taken = projects::reclaim_in(&tx, w.org, q, row, worker, "tester", "let it go", "released", "taken_back", true, Some(&copy)).await;
    let taken = taken.unwrap().expect("reclaimed");
    assert!(taken.dead, "attempts exhausted: a dead letter");
    tx.commit().await.unwrap();
    let ex = w.extra(&job).await;
    assert_eq!(ex["dead_letter"]["why"], json!("relayed to project Q and dead-lettered there"));
    let state: String = w.c.query_one("SELECT state FROM ot.mail WHERE uid=$1", &[&job]).await.unwrap().get(0);
    assert_eq!(state, "read", "J is not requeued in P");
    assert!(ex.get("claimed").is_none());
    let _ = p;
}

/// RL7: Q has no worker; `batch` 2: two of four jobs are relayed, two stay in P (and go to P's own listener when it has one).
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl7_a_relay_into_a_queue_nobody_works_stops_at_its_batch() {
    let w = world(true).await;
    let mut w = w;
    let p = w.project("P", false, None).await;
    w.grant("P").await;
    let q = w.project("Q", true, None).await;
    w.relay(q, p, 2).await;
    for i in 0..4 {
        w.arrive(&format!("n{i}"), &format!("job {i}"), json!([])).await;
    }
    w.dispatch(p).await;
    let relayed: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1 AND extra ? 'relayed_from' AND state='pending'", &[&q]).await.unwrap().get(0);
    let waiting: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1 AND state='pending'", &[&p]).await.unwrap().get(0);
    assert_eq!((relayed, waiting), (2, 2), "two relayed, two left for P's other listeners");
}

/// RL8: a relay that would close a loop is refused at create; at run time a job whose chain contains Q is skipped.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl8_a_relay_loop_is_refused_and_a_job_that_already_passed_q_is_not_relayed_into_it_again() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    // create-time: Q relays P's queue (edge P -> Q), so P relaying Q's queue (edge Q -> P) closes a loop
    let e = crate::runtime::watchdogs::create_as(&w.e, w.org, None, &json!({ "kind": "fair_queue", "project": "P", "target": "Q", "name": "back" })).await
        .expect_err("a loop");
    assert!(format!("{e:#}").contains("would close a loop"), "{e:#}");
    // run time: a job whose chain already holds Q stays in P
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.c.execute("UPDATE ot.mail SET extra = extra || jsonb_build_object('relayed_from', jsonb_build_object('chain', jsonb_build_array($2::bigint))) WHERE uid=$1", &[&job, &q]).await.unwrap();
    w.dispatch(p).await;
    let ex = w.extra(&job).await;
    assert!(ex.get("claimed").is_none() && ex.get("relayed_to").is_none(), "skipped by the relay: {ex}");
}

/// RL9: a two-level chain P -> Q -> R: a worker in R holds the job; the sender's follow-up goes to that worker, not to a new job.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl9_a_follow_up_travels_down_a_two_level_chain_to_the_final_holder() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    let r = w.project("R", true, None).await;
    let wr = w.agent("WR", Some(r)).await;
    w.listener(wr, "wrq", r).await;
    // Q's own worker W no longer works: take its listener away so R's relay is the way on
    w.c.execute("UPDATE ot.watchdogs SET state='paused' WHERE uid='wq'", &[]).await.unwrap();
    w.relay(r, q, 5).await;
    let (first, published) = w.arrive("n1", "original", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let grandchild = w.child(&child).await;
    let gx = w.extra(&grandchild).await;
    assert_eq!(gx["relayed_from"]["chain"], json!([p, q]), "two layers deep");
    let (_, wx) = w.copy_of(wr, &grandchild).await;
    assert_eq!(wx["outside_job"], json!(grandchild), "WR holds the last job");
    let quote = json!({ "kind": "mail", "box": "org", "id": first, "peer": "@net:bob.1", "net_id": "n1", "gist": "original" });
    let (_, f) = w.arrive("n2", "follow-up", json!([quote])).await;
    assert!(f.jobs.is_empty(), "no new job anywhere");
    assert_eq!(f.copies.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), vec!["WR"], "the follow-up goes to the final holder");
}

/// RL10 + GR6: agent mail (not outside) to P is relayed as a plain job (no `org_inbox`); the final worker answers the sender.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl10_agent_mail_is_relayed_as_a_plain_job_and_its_worker_replies_to_the_sender() {
    let (w, p, q, worker) = rig(true, true, 5).await;
    let a = w.agent("A", None).await;
    w.c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,'A','P','fixture')", &[&w.org]).await.unwrap();
    let mut o = Outgoing::new(From::Agent { id: a, name: "A".into(), generation: 1 }, "P", "do this");
    o.wake = false;
    let job = crate::domain::mail::send(&w.e, w.org, o).await.unwrap().uid;
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let cx = w.extra(&child).await;
    assert!(cx.get("org_inbox").is_none(), "a plain job: {cx}");
    assert_eq!(cx["relayed_from"]["project"], json!(p));
    let (copy, _) = w.copy_of(worker, &child).await;
    crate::domain::mail::send(&w.e, w.org, reply_from(worker, "W", "A", "done", &copy, "A")).await.expect("G1 at the last layer (GR6)");
    let n: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND sender='W' AND recipient_name='A' AND body='done'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(n, 1);
    let _ = q;
}

/// RL11: the user takes J back from P's desk while W holds the child: J is pending in P again, the child is revoked, W's outside
/// reply is refused.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl11_taking_the_job_back_from_the_relay_revokes_the_childs_reply_right() {
    let (mut w, p, _q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    let row: i64 = w.c.query_one("SELECT id FROM ot.mail WHERE uid=$1", &[&job]).await.unwrap().get(0);
    let tx = w.c.transaction().await.unwrap();
    assert!(projects::relay_take_back(&tx, w.org, p, row, "had it taken back by the user").await.unwrap());
    tx.commit().await.unwrap();
    let state: String = w.c.query_one("SELECT state FROM ot.mail WHERE uid=$1", &[&job]).await.unwrap().get(0);
    let ex = w.extra(&job).await;
    assert_eq!(state, "pending", "J is back in P's queue");
    assert!(ex.get("claimed").is_none() && ex.get("relayed_to").is_none(), "{ex}");
    assert_eq!(w.extra(&child).await["revoked"], json!(true));
    let out = reply_from(worker, "W", "@net:bob.1", "late", &copy, "@net:bob.1");
    assert!(matches!(jobs::reply_right(&w.e, w.org, worker, &out).await.unwrap(), jobs::Reply::Refused), "revoked: W keeps the job, not the right");
}

/// RL12: Q is retired with an outstanding relay claim: at P's next release the job goes back to P's queue.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl12_a_retired_relaying_project_gives_its_claims_back() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    assert_eq!(w.extra(&job).await["claimed"]["by_project"], json!(q));
    w.c.execute("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&q]).await.unwrap();
    let released = projects::release_stale(&w.e, w.org, p).await.unwrap();
    assert_eq!(released, vec!["relay Q".to_string()]);
    let state: String = w.c.query_one("SELECT state FROM ot.mail WHERE uid=$1", &[&job]).await.unwrap().get(0);
    assert_eq!(state, "pending");
    assert_eq!(w.extra(&job).await["released"]["why"], json!("the relaying project Q was retired"));
}

/// RL1 + RL13: `create kind=fair_queue project=Q target=P`; who may create it and what it records.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl1_rl13_creating_a_relay_checks_both_projects_and_records_a_reach_grant() {
    let w = world(true).await;
    let p = w.project("P", true, None).await;
    let boss = w.agent("boss", None).await;
    let q = w.project("Q", true, Some(boss)).await;
    let _ = (p, q);
    // the options a relay refuses
    for bad in [json!({ "project_delivery": "event" }), json!({ "once": true })] {
        let mut args = json!({ "kind": "fair_queue", "project": "Q", "target": "P", "name": "r" });
        args.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        crate::runtime::watchdogs::create_as(&w.e, w.org, None, &args).await.expect_err("refused");
    }
    // RL13: boss is above Q but reaches P neither by the tree nor an audience
    let e = crate::runtime::watchdogs::create_as(&w.e, w.org, Some(boss), &json!({ "kind": "fair_queue", "project": "Q", "target": "P", "name": "r" })).await.expect_err("refused");
    assert!(format!("{e:#}").contains("neither Q nor you reach project P"), "{e:#}");
    // with an audience on P it is created, and the grant is recorded
    w.c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,'boss','P','fixture')", &[&w.org]).await.unwrap();
    let ok = crate::runtime::watchdogs::create_as(&w.e, w.org, Some(boss), &json!({ "kind": "fair_queue", "project": "Q", "target": "P", "name": "r" })).await.expect("created");
    assert_eq!(ok["project_delivery"], json!("queue"));
    assert_eq!(ok["reach_grant"]["project"], json!(p), "{ok}");
}

/// RL14 control: an agent under P listening to P directly works as before (no relay link on the job).
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl14_control_a_direct_listener_is_unaffected() {
    let mut w = world(true).await;
    let p = w.project("P", true, None).await;
    w.grant("P").await;
    let m = w.agent("M", Some(p)).await;
    w.listener(m, "mq", p).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let ex = w.extra(&job).await;
    assert_eq!(ex["claimed"]["by_id"], json!(m));
    assert!(ex.get("relayed_to").is_none());
    let (_, mx) = w.copy_of(m, &job).await;
    assert_eq!(mx["outside_job"], json!(job));
}

/// R10: what the desk reads. P's Working row names the holder as a relay project; Q's Working row says where the job came from;
/// the Recently Finished row after the ACK is the relay's, with its dog; the relay is in Q's Listeners sources.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl15_the_desk_data_names_the_relay_as_holder_and_the_source_project() {
    let (mut w, p, q, worker) = rig(true, true, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let scope = |id: i64| { let c = &w.c; async move { c.query_one("SELECT scope FROM ot.agents WHERE id=$1", &[&id]).await.unwrap().get::<_, Value>(0) } };
    let hist_p = projects::queue_history(&w.c, p, "P", &scope(p).await, None, false).await.unwrap();
    let held = &hist_p["working"][0];
    assert_eq!(held["relay"], json!(true), "{held}");
    assert_eq!(held["holder_project"], json!("Q"), "{held}");
    assert_eq!(held["dog"]["id"], json!(format!("Q/relay{q}{p}")), "the relay dog is named: {held}");
    let hist_q = projects::queue_history(&w.c, q, "Q", &scope(q).await, None, false).await.unwrap();
    assert_eq!(hist_q["working"][0]["relayed_from"], json!("P"), "{}", hist_q["working"][0]);
    // the ACK ends it: P's Recently Finished row is the relay's
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    let mut ack = Outgoing::new(From::Agent { id: worker, name: "W".into(), generation: 1 }, "Q", "done");
    ack.reply_to = Some(json!({ "id": copy, "from": "@net:bob.1" }));
    ack.wake = false;
    crate::domain::mail::send(&w.e, w.org, ack).await.unwrap();
    let hist_p = projects::queue_history(&w.c, p, "P", &scope(p).await, None, false).await.unwrap();
    let done = &hist_p["history"][0];
    assert_eq!(done["agent"], json!("relay Q"), "{done}");
    assert_eq!(done["how"], json!("acked"));
    assert_eq!(done["dog"]["id"], json!(format!("Q/relay{q}{p}")), "{done}");
    let status = crate::domain::listeners::status(&w.c, w.org, q, "Q").await.unwrap();
    assert!(status["sources"].as_array().unwrap().iter().any(|s| s["kind"] == "fair_queue" && s["target"] == "P" && s["project_delivery"] == "queue"), "{status}");
}

/// R3: a relay's target edit is refused while jobs it took are still outstanding in the old project, allowed after their
/// custody ends; and a target edit that would close a loop is refused.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl16_a_relay_target_edit_waits_for_its_outstanding_jobs_and_refuses_loops() {
    let (mut w, p, q, worker) = rig(true, true, 5).await;
    w.project("P2", true, None).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let id = format!("Q/relay{q}{p}");
    let e = crate::runtime::watchdogs::configure(&w.e, w.org, None, &id, &json!({ "target": "P2" })).await.expect_err("outstanding");
    assert!(format!("{e:#}").contains("still outstanding in the old project"), "{e:#}");
    let child = w.child(&job).await;
    let (copy, _) = w.copy_of(worker, &child).await;
    let mut ack = Outgoing::new(From::Agent { id: worker, name: "W".into(), generation: 1 }, "Q", "done");
    ack.reply_to = Some(json!({ "id": copy, "from": "@net:bob.1" }));
    ack.wake = false;
    crate::domain::mail::send(&w.e, w.org, ack).await.unwrap();
    crate::runtime::watchdogs::configure(&w.e, w.org, None, &id, &json!({ "target": "P2" })).await.expect("allowed once the job is ACKed");
    // a loop: P2 relays Q (edge Q -> P2); Q's relay now sits on P2 (edge P2 -> Q), so retargeting it at Q itself is refused
    let e = crate::runtime::watchdogs::configure(&w.e, w.org, None, &id, &json!({ "target": "Q" })).await.expect_err("self");
    assert!(format!("{e:#}").contains("cannot relay into itself"), "{e:#}");
}

/// R1 on configure: the options create refuses for a relay are refused when editing it, too.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl17_configure_keeps_a_relay_a_queue_dog_without_once_or_notice() {
    let (w, p, q, _worker) = rig(true, true, 5).await;
    let id = format!("Q/relay{q}{p}");
    for bad in [json!({ "project_delivery": "event" }), json!({ "project_delivery": "broadcast" }), json!({ "once": true }), json!({ "notice": true })] {
        let e = crate::runtime::watchdogs::configure(&w.e, w.org, None, &id, &bad).await.expect_err("refused");
        assert!(format!("{e:#}").contains("relay"), "{bad}: {e:#}");
    }
    crate::runtime::watchdogs::configure(&w.e, w.org, None, &id, &json!({ "batch": 3 })).await.expect("a batch edit is fine");
}

/// R3 rule 7 under a race: a job the relay takes between configure's plan and its locked apply makes the edit refuse, and the
/// target stays as it was.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl18_a_claim_committed_between_plan_and_apply_stops_the_target_edit() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    w.project("P2", true, None).await;
    let id = format!("Q/relay{q}{p}");
    let (reached, release) = crate::runtime::watchdogs::race_hook::arm("configure");
    let (e, org, idc) = (w.e.clone(), w.org, id.clone());
    let edit = tokio::spawn(async move { crate::runtime::watchdogs::configure(&e, org, None, &idc, &json!({ "target": "P2" })).await });
    tokio::time::timeout(std::time::Duration::from_secs(20), reached.notified()).await.expect("configure reached its pause");
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    assert!(w.extra(&job).await["claimed"]["by_project"] == json!(q), "the relay took the job while the edit was between plan and apply");
    release.notify_one();
    let err = edit.await.unwrap().expect_err("refused in the locked apply");
    assert!(format!("{err:#}").contains("still outstanding in the old project"), "{err:#}");
    let target: String = w.c.query_one("SELECT memo->>'target_id' FROM ot.watchdogs WHERE uid=$1", &[&format!("relay{q}{p}")]).await.unwrap().get(0);
    assert_eq!(target, p.to_string(), "nothing was written");
}

/// R5b: a dead letter at any depth dead-letters every ancestor; the reason names where it died.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl6b_a_dead_letter_two_levels_down_dead_letters_both_ancestors() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    let r = w.project("R", true, None).await;
    let wr = w.agent("WR", Some(r)).await;
    w.listener(wr, "wrq", r).await;
    w.c.execute("UPDATE ot.watchdogs SET state='paused' WHERE uid='wq'", &[]).await.unwrap();
    w.relay(r, q, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let grandchild = w.child(&child).await;
    let (copy, _) = w.copy_of(wr, &grandchild).await;
    w.c.execute("UPDATE ot.mail SET extra = extra || '{\"attempts\": 99}'::jsonb WHERE uid=$1", &[&grandchild]).await.unwrap();
    let row: i64 = w.c.query_one("SELECT id FROM ot.mail WHERE uid=$1", &[&grandchild]).await.unwrap().get(0);
    let tx = w.c.transaction().await.unwrap();
    assert!(projects::reclaim_in(&tx, w.org, r, row, wr, "tester", "let it go", "released", "taken_back", true, Some(&copy)).await.unwrap().expect("reclaimed").dead);
    tx.commit().await.unwrap();
    for (uid, dead_at) in [(&child, "R"), (&job, "R")] {
        let ex = w.extra(uid).await;
        assert_eq!(ex["dead_letter"]["why"], json!(format!("relayed to project {dead_at} and dead-lettered there")), "{uid}: {ex}");
    }
}

/// R5b: a take-back at P revokes every active descendant, so the final holder loses the reply right and nothing is left waiting.
#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn rl11b_a_take_back_at_p_revokes_every_descendant() {
    let (mut w, p, q, _worker) = rig(true, true, 5).await;
    let r = w.project("R", true, None).await;
    let wr = w.agent("WR", Some(r)).await;
    w.listener(wr, "wrq", r).await;
    w.c.execute("UPDATE ot.watchdogs SET state='paused' WHERE uid='wq'", &[]).await.unwrap();
    w.relay(r, q, 5).await;
    let (_, published) = w.arrive("n1", "hello", json!([])).await;
    let job = published.jobs[0].mail.clone();
    w.dispatch(p).await;
    let child = w.child(&job).await;
    let grandchild = w.child(&child).await;
    let (copy, _) = w.copy_of(wr, &grandchild).await;
    let row: i64 = w.c.query_one("SELECT id FROM ot.mail WHERE uid=$1", &[&job]).await.unwrap().get(0);
    let tx = w.c.transaction().await.unwrap();
    assert!(projects::relay_take_back(&tx, w.org, p, row, "had it taken back by the user").await.unwrap());
    tx.commit().await.unwrap();
    for uid in [&child, &grandchild] {
        assert_eq!(w.extra(uid).await["revoked"], json!(true), "{uid} is revoked");
    }
    let ex = w.extra(&child).await;
    assert!(ex.get("claimed").is_none(), "the middle job's relay claim ends: {ex}");
    let out = reply_from(wr, "WR", "@net:bob.1", "late", &copy, "@net:bob.1");
    assert!(matches!(jobs::reply_right(&w.e, w.org, wr, &out).await.unwrap(), jobs::Reply::Refused), "the final holder keeps the job, not the right");
}
