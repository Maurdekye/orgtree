//! Superiors take back unacked project jobs (`orgtree_project held_jobs` / `take_back`; the take-back spec by stream-plan-opus
//! with Amendment 1, USER 2026-11-06 m2bc14aa1e045 + ma80a037dbd26). Tests TB1-TB18 follow the spec's §8 and A1.5.
//!
//! The database tests use the same disposable `holdings_fixture` database as `holdings::db_tests`, one at a time:
//! `ORGTREE_HOLDINGS_TEST_URL=... ORGTREE_HOLDINGS_TEST_ROOT=... cargo test -p orgtree-engine -- --ignored --test-threads=1 take_back_tests`.
//! The pure tests (reason, preview, tool request) run anywhere.
//!
//! Tree: X (agent) > P (ack project) > { C > A, B }; X > S; D top-level. A and B listen to P. C is above the holder A but is
//! neither above nor below P's queue except through P's subtree (C is BELOW P: it has reach but no project right).
use super::ops::{self, Actor};
use super::UserError;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::NoTls;

use crate::engine::Engine;
use crate::orgs::OrgHandle;

struct W {
    e: Arc<Engine>,
    org: Arc<OrgHandle>,
    p: i64,
    x: i64,
    c: i64,
    a: i64,
    b: i64,
    d: i64,
    s: i64,
    q: i64,
}

#[nolog]
async fn world(scope: Value) -> W {
    let url = std::env::var("ORGTREE_HOLDINGS_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("holdings_fixture"));
    assert_eq!(cfg.get_user(), Some("holdings_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let id: i64 = client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'take-back-fixture','fixture') RETURNING id", &[]).await.unwrap().get(0);
    let agent = |name: &'static str, parent: Option<i64>| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-06') RETURNING id", &[&id, &name, &parent]).await.unwrap().get::<_, i64>(0)
        }
    };
    let x = agent("X", None).await;
    let p: i64 = client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'P',$2,'project','project','live',$3,'2026-11-06') RETURNING id", &[&id, &x, &scope]).await.unwrap().get(0);
    let c = agent("C", Some(p)).await;
    let a = agent("A", Some(c)).await;
    let b = agent("B", Some(p)).await;
    let d = agent("D", None).await;
    let s = agent("S", Some(x)).await;
    // Q: a relay project under P's subtree, so an ancestor of Q that is not above P can be tested
    let q: i64 = client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'Q',$2,'project','project','live',$3,'2026-11-06') RETURNING id", &[&id, &c, &json!({"mail_queue":"ack"})]).await.unwrap().get(0);
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_HOLDINGS_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org = crate::orgs::provisional(id, "fixture".into(), "take-back-fixture".into(), "fixture".into());
    engine.orgs.insert(org.clone());
    W { e: engine, org, p, x, c, a, b, d, s, q }
}

fn ack() -> Value {
    json!({ "mail_queue": "ack" })
}

impl W {
    #[nolog]
    async fn sql(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.e.db.get().await.unwrap().execute(text, params).await.unwrap();
    }
    /// A passive queue listener on P for `agent`.
    #[nolog]
    async fn listen(&self, agent: i64) {
        crate::runtime::watchdogs::create(&self.e, self.org.id, agent, &json!({"kind":"fair_queue","target":"P","notice":true})).await.unwrap();
    }
    /// An un-acked job in P's mailbox held by `holder` (an agent id, its name), with the copy the holder was handed.
    #[nolog]
    async fn job(&self, uid: &str, holder: i64, by: &str, body: &str) {
        let copy = format!("copy-{uid}");
        self.sql(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
             VALUES($1,$2,'@user','agent',$3,'P',$4,'read',$5)",
            &[&uid, &self.org.id, &self.p, &body, &json!({"attempts":1,"claimed":{"by_id":holder,"by":by,"copy":copy,"ack":true,"inline":true,"at":crate::util::now_iso()}})],
        ).await;
        self.sql(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
             VALUES($1,$2,'@user','agent',$3,$4,$5,'unread',$6)",
            &[&copy, &self.org.id, &holder, &by, &body, &json!({"via_project":{"id":self.p,"name":"P","ack":true,"mail":uid}})],
        ).await;
    }
    /// A job held by relay project Q (R5).
    #[nolog]
    async fn relay_job(&self, uid: &str) {
        self.sql(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
             VALUES($1,$2,'@user','agent',$3,'P','relayed','read',$4)",
            &[&uid, &self.org.id, &self.p, &json!({"attempts":1,"claimed":{"by_project":self.q,"by":"Q","copy":null,"ack":true,"at":crate::util::now_iso()}})],
        ).await;
    }
    /// The user's own job.
    #[nolog]
    async fn user_job(&self, uid: &str) {
        self.sql(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
             VALUES($1,$2,'@user','agent',$3,'P','mine','read',$4)",
            &[&uid, &self.org.id, &self.p, &json!({"attempts":1,"claimed":{"by":"user","ack":true,"at":crate::util::now_iso()}})],
        ).await;
    }
    #[nolog]
    fn me(&self, id: i64, name: &str) -> Actor {
        Actor::Agent { id, name: name.into() }
    }
    #[nolog]
    async fn run(&self, actor: Actor, req: Value) -> anyhow::Result<Value> {
        ops::run(&self.e, &self.org, actor, &req).await
    }
    #[nolog]
    async fn take(&self, actor: Actor, mail: &str, reason: Option<&str>) -> anyhow::Result<Value> {
        self.run(actor, json!({"op":"mail_take_back","node":"P","mail":mail,"reason":reason})).await
    }
    #[nolog]
    async fn take_all(&self, actor: Actor, holder: &str) -> anyhow::Result<Value> {
        self.run(actor, json!({"op":"mail_take_back","node":"P","holder":holder})).await
    }
    /// (who holds the job now: the agent id, or none) and whether its row carries a dead-letter mark.
    #[nolog]
    async fn holder_of(&self, uid: &str) -> (Option<i64>, bool) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT (extra->'claimed'->>'by_id')::bigint, extra ? 'dead_letter' FROM ot.mail WHERE uid = $1", &[&uid]).await.unwrap();
        (r.get(0), r.get(1))
    }
    /// The newest ending recorded for a job: (how, why).
    #[nolog]
    async fn ending(&self, uid: &str) -> (String, Option<String>) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT how, why FROM ot.project_mail_endings WHERE mail_uid = $1 ORDER BY id DESC LIMIT 1", &[&uid]).await.unwrap();
        (r.get(0), r.get(1))
    }
    /// The system notices an agent has been sent, oldest first.
    #[nolog]
    async fn notices(&self, agent: i64) -> Vec<String> {
        self.e.db.get().await.unwrap()
            .query("SELECT body FROM ot.mail WHERE recipient_agent_id = $1 AND sender = '@system' AND notice ORDER BY id", &[&agent]).await.unwrap()
            .iter().map(|r| r.get(0)).collect()
    }
}

#[nolog]
fn refused(e: &anyhow::Error) -> &'static str {
    match e.downcast_ref::<UserError>() {
        Some(UserError::Forbidden(_)) => "forbidden",
        Some(UserError::Conflict(_)) => "conflict",
        Some(UserError::BadRequest(_)) => "bad_request",
        Some(UserError::NotFound(_)) => "not_found",
        _ => "other",
    }
}

/// TB1 `ancestor_takes_back_one_job`: X (above P) takes A's job; it ends taken_back and is next handed to B, the other listener.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb1_ancestor_takes_back_one_job_and_it_goes_to_the_other_listener() {
    let w = world(ack()).await;
    w.listen(w.a).await;
    w.listen(w.b).await;
    w.job("J", w.a, "A", "do the thing").await;
    let out = w.take(w.me(w.x, "X"), "J", None).await.unwrap();
    assert_eq!(out["taken"], true);
    assert_eq!(out["holder"], "A");
    assert_eq!(w.ending("J").await.0, "taken_back");
    assert_eq!(w.holder_of("J").await.0, Some(w.b), "the other listener takes it first");
    w.e.shutdown.cancel();
}

/// TB1 (second half): with only A listening, the job goes back to A.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb1b_with_only_the_holder_listening_the_job_goes_back_to_it() {
    let w = world(ack()).await;
    w.listen(w.a).await;
    w.job("J", w.a, "A", "do the thing").await;
    w.take(w.me(w.x, "X"), "J", None).await.unwrap();
    assert_eq!(w.holder_of("J").await.0, Some(w.a));
    w.e.shutdown.cancel();
}

/// TB2 `unrelated_agent_refused`: an agent with neither right is Forbidden on take_back and held_jobs; J is untouched.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb2_unrelated_agent_refused() {
    let w = world(ack()).await;
    w.job("J", w.a, "A", "x").await;
    for (id, name) in [(w.d, "D"), (w.s, "S"), (w.b, "B")] {
        let err = w.take(w.me(id, name), "J", None).await.unwrap_err();
        assert_eq!(refused(&err), "forbidden", "{name} has neither right");
    }
    for (id, name) in [(w.d, "D"), (w.s, "S")] {
        let err = w.run(w.me(id, name), json!({"op":"held_jobs","node":"P"})).await.unwrap_err();
        assert_eq!(refused(&err), "forbidden", "{name} may not list");
    }
    assert_eq!(w.holder_of("J").await, (Some(w.a), false), "J is untouched");
    w.e.shutdown.cancel();
}

/// TB3 `attempt_counted_and_dead_letter`: max_attempts 2, checkups on: the second take-back dead-letters J. With checkups off the
/// attempt is not counted.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb3_attempt_counted_and_dead_letter() {
    let w = world(json!({"mail_queue":"ack","max_attempts":2})).await;
    w.job("J", w.a, "A", "x").await;
    w.sql("UPDATE ot.mail SET extra = jsonb_set(extra,'{attempts}','2') WHERE uid = 'J'", &[]).await;
    let out = w.take(w.me(w.x, "X"), "J", None).await.unwrap();
    assert_eq!(out["dead_letter"], true, "the last attempt dead-letters it");
    assert!(w.holder_of("J").await.1, "and the row carries the dead-letter mark");
    // checkups off: the attempt is not counted
    w.job("K", w.a, "A", "y").await;
    w.sql("UPDATE ot.mail SET extra = jsonb_set(extra,'{attempts}','2') WHERE uid = 'K'", &[]).await;
    let mut c = w.e.db.get().await.unwrap();
    w.e.settings.merge(&mut c, json!({"runtime": {crate::runtime::reminders::KEY_CHECKUPS: false}})).await.unwrap();
    drop(c);
    let out = w.take(w.me(w.x, "X"), "K", None).await.unwrap();
    assert_eq!(out["dead_letter"], false, "with checkups off the attempt is not counted, as the desk does");
    w.e.shutdown.cancel();
}

/// TB4 `holder_told_and_late_ack_refused`: A gets one passive notice naming X and the reason; its later ack of J is refused.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb4_holder_told_and_late_ack_refused() {
    let w = world(ack()).await;
    w.job("J", w.a, "A", "x").await;
    w.take(w.me(w.x, "X"), "J", Some("stuck on a usage limit")).await.unwrap();
    let told = w.notices(w.a).await;
    assert_eq!(told.len(), 1, "one passive notice");
    assert!(told[0].contains("X") && told[0].contains("stuck on a usage limit"), "{}", told[0]);
    let c = w.e.db.get().await.unwrap();
    let late = super::projects::ack_of(&**c, w.p, w.a, "copy-J").await;
    assert!(late.is_err() || late.unwrap().is_none(), "a late ack is refused");
    w.e.shutdown.cancel();
}

/// TB5 `user_held_refused`: a single take-back and `holder:"user"` are refused with the spec's texts.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb5_user_held_refused() {
    let w = world(ack()).await;
    w.user_job("U").await;
    let err = w.take(w.me(w.x, "X"), "U", None).await.unwrap_err();
    assert_eq!(refused(&err), "forbidden");
    assert!(format!("{err:#}").contains("is the user's own job: only the user ends it, by acknowledging it"));
    let err = w.take_all(w.me(w.x, "X"), "user").await.unwrap_err();
    assert_eq!(refused(&err), "bad_request");
    assert!(format!("{err:#}").contains("the user's own jobs are ended only by the user, by acknowledging them"));
    w.e.shutdown.cancel();
}

/// TB6 `relay_job_taken_back`: J held by relay project Q goes back to P's front; a batch with holder "Q" does the same for all.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb6_relay_job_taken_back() {
    let w = world(ack()).await;
    w.relay_job("R1").await;
    w.relay_job("R2").await;
    let out = w.take(w.me(w.x, "X"), "R1", None).await.unwrap();
    assert_eq!(out["holder"], "Q");
    let still: i64 = w.e.db.get().await.unwrap().query_one("SELECT count(*) FROM ot.mail WHERE uid = 'R1' AND extra->'claimed'->>'by_project' IS NOT NULL", &[]).await.unwrap().get(0);
    assert_eq!(still, 0, "R1 is no longer held by the relay");
    let out = w.take_all(w.me(w.x, "X"), "Q").await.unwrap();
    assert_eq!(out["count"], 1, "the batch takes the rest of Q's jobs");
    w.e.shutdown.cancel();
}

/// TB7 `batch_takes_all_of_one_holder`: A holds J1, J2, B holds J3: `holder:"A"` takes J1 and J2 (oldest first) and leaves J3.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb7_batch_takes_all_of_one_holder() {
    let w = world(ack()).await;
    w.job("J1", w.a, "A", "1").await;
    w.job("J2", w.a, "A", "2").await;
    w.job("J3", w.b, "B", "3").await;
    let out = w.take_all(w.me(w.x, "X"), "A").await.unwrap();
    assert_eq!(out["count"], 2);
    assert_eq!(out["taken"][0]["mail"], "J1");
    assert_eq!(out["taken"][1]["mail"], "J2");
    assert_eq!(w.holder_of("J3").await, (Some(w.b), false), "B's job is left");
    let err = w.take_all(w.me(w.x, "X"), "A").await.unwrap_err();
    assert_eq!(refused(&err), "conflict");
    assert!(format!("{err:#}").contains("holds no job"));
    let err = w.take_all(w.me(w.x, "X"), "Nobody").await.unwrap_err();
    assert_eq!(refused(&err), "bad_request");
    w.e.shutdown.cancel();
}

/// TB8 `reason_recorded_and_bounded`: the reason is in the ending's why, the event payload and the holder's notice; newlines become
/// spaces; 301 characters are refused; an empty reason keeps the old why.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb8_reason_recorded_and_bounded() {
    let w = world(ack()).await;
    w.job("J", w.a, "A", "x").await;
    w.take(w.me(w.x, "X"), "J", Some("  line one\nline two  ")).await.unwrap();
    assert_eq!(w.ending("J").await.1.as_deref(), Some("had it taken back by X: line one line two"));
    let ev: Value = w.e.db.get().await.unwrap().query_one("SELECT detail FROM ot.events WHERE op = 'mail_take_back' ORDER BY id DESC LIMIT 1", &[]).await.unwrap().get(0);
    assert_eq!(ev["reason"], "line one line two");
    assert_eq!(ev["via"], "project");
    assert!(w.notices(w.a).await[0].contains("line one line two"));
    w.job("K", w.a, "A", "y").await;
    let err = w.take(w.me(w.x, "X"), "K", Some(&"x".repeat(301))).await.unwrap_err();
    assert_eq!(refused(&err), "bad_request");
    w.take(w.me(w.x, "X"), "K", Some("   ")).await.unwrap();
    assert_eq!(w.ending("K").await.1.as_deref(), Some("had it taken back by X"), "an empty reason keeps the old why");
    w.e.shutdown.cancel();
}

/// TB9 `held_jobs_lists`: the row fields (no full text, attachments by name), a member below may list, round-robin returns the note.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb9_held_jobs_lists_with_text_and_names() {
    let w = world(ack()).await;
    w.job("J", w.a, "A", "hello there").await;
    w.sql("UPDATE ot.mail SET attachments = $1 WHERE uid = 'J'", &[&json!([{"name":"report.md","path":"C:\\secret\\dir\\report.md"},{"path":"/home/u/notes.txt"}])]).await;
    let out = w.run(w.me(w.b, "B"), json!({"op":"held_jobs","node":"P"})).await.unwrap();
    assert_eq!(out["ack"], true);
    let row = &out["held"][0];
    assert_eq!(row["mail"], "J");
    assert_eq!(row["holder"], "A");
    assert_eq!(row["relay"], false);
    assert_eq!(row["text"], "hello there");
    assert_eq!(row["truncated"], false);
    assert_eq!(row["attachments"], json!(["report.md", "notes.txt"]), "file names only");
    for k in ["copy", "attempts", "held_at", "waited_from", "held_for_s"] {
        assert!(row.get(k).is_some(), "{k}");
    }
    assert!(row.get("gist").is_none());
    w.e.shutdown.cancel();
    let w = world(json!({"mail_queue":"round_robin"})).await;
    let out = w.run(Actor::User, json!({"op":"held_jobs","node":"P"})).await.unwrap();
    assert_eq!(out["ack"], false);
    assert_eq!(out["note"], "round-robin queue: jobs are not held");
    w.e.shutdown.cancel();
}

/// TB10 `id_xor_agent`: both or neither is a BadRequest at the tool (pure).
#[test]
#[nolog]
fn tb10_id_xor_agent() {
    use crate::tools::treetools::take_back_request;
    for args in [json!({"action":"take_back","name":"P"}), json!({"action":"take_back","name":"P","id":"J","agent":"A"})] {
        let err = take_back_request(&args).unwrap_err();
        assert_eq!(refused(&err), "bad_request");
        assert!(format!("{err:#}").contains("take_back takes id (one held job) or agent (all of one holder's jobs), not both"));
    }
    let one = take_back_request(&json!({"action":"take_back","name":"P","id":"J","reason":"r"})).unwrap();
    assert_eq!((one["op"].as_str(), one["node"].as_str(), one["mail"].as_str(), one["reason"].as_str()), (Some("mail_take_back"), Some("P"), Some("J"), Some("r")));
    let all = take_back_request(&json!({"action":"take_back","name":"P","agent":"A"})).unwrap();
    assert_eq!((all["holder"].as_str(), all["mail"].is_null()), (Some("A"), true));
}

/// TB11 `round_robin_refused`: take_back on a round-robin project is a Conflict.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb11_round_robin_refused() {
    let w = world(json!({"mail_queue":"round_robin"})).await;
    let err = w.take(w.me(w.x, "X"), "J", None).await.unwrap_err();
    assert_eq!(refused(&err), "conflict");
    assert!(format!("{err:#}").contains("hands out round-robin: nothing is held"));
    w.e.shutdown.cancel();
}

/// TB13 `held_jobs_shows_preview` (pure): 500-character cut, a multibyte character at the cut stays whole, CR removed.
#[test]
#[nolog]
fn tb13_preview_cuts_at_500_characters_never_mid_character() {
    let (t, cut) = super::projects::preview(&"a".repeat(1200));
    assert_eq!((t.chars().count(), cut), (500, true));
    let (t, cut) = super::projects::preview("short\r\ntext ");
    assert_eq!((t.as_str(), cut), ("short\ntext", false));
    let body = format!("{}é{}", "a".repeat(499), "b".repeat(10));
    let (t, cut) = super::projects::preview(&body);
    assert!(cut && t.ends_with('é') && t.chars().count() == 500, "the multibyte character at the cut is whole");
    assert_eq!(super::projects::preview(&"a".repeat(500)), ("a".repeat(500), false), "exactly 500 is not cut");
}

/// TB14 `chain_caller_lists_only_its_descendants_jobs`: C (above A, below P) lists A's rows only; a project ancestor sees both.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb14_chain_caller_lists_only_its_descendants_jobs() {
    let w = world(ack()).await;
    w.job("JA", w.a, "A", "a").await;
    w.job("JB", w.b, "B", "b").await;
    let out = w.run(w.me(w.c, "C"), json!({"op":"held_jobs","node":"P"})).await.unwrap();
    let ids: Vec<&str> = out["held"].as_array().unwrap().iter().filter_map(|r| r["mail"].as_str()).collect();
    assert_eq!(ids, vec!["JA"] , "C sees A's row only");
    let out = w.run(w.me(w.x, "X"), json!({"op":"held_jobs","node":"P"})).await.unwrap();
    assert_eq!(out["held"].as_array().unwrap().len(), 2, "a project ancestor sees both");
    w.e.shutdown.cancel();
}

/// TB15 `chain_caller_takes_back_descendants_jobs`: C takes back A's J by id and by holder; C on B's job or holder B is Forbidden.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb15_chain_caller_takes_back_descendants_jobs() {
    let w = world(ack()).await;
    w.listen(w.a).await;
    w.listen(w.b).await;
    w.job("JA", w.a, "A", "a").await;
    w.job("JA2", w.a, "A", "a2").await;
    w.job("JB", w.b, "B", "b").await;
    let out = w.take(w.me(w.c, "C"), "JA", Some("go")).await.unwrap();
    assert_eq!(out["taken"], true);
    assert_eq!(w.holder_of("JA").await.0, Some(w.b), "front of the queue, the other listener first");
    assert_eq!(w.ending("JA").await.1.as_deref(), Some("had it taken back by C, your superior: go"));
    let out = w.take_all(w.me(w.c, "C"), "A").await.unwrap();
    assert_eq!(out["count"], 1);
    let err = w.take(w.me(w.c, "C"), "JB", None).await.unwrap_err();
    assert_eq!(refused(&err), "forbidden");
    let err = w.take_all(w.me(w.c, "C"), "B").await.unwrap_err();
    assert_eq!(refused(&err), "forbidden");
    w.e.shutdown.cancel();
}

/// TB16 `holder_has_no_chain_right_over_itself`: A (below P, not above P) on its own J is Forbidden.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb16_holder_has_no_chain_right_over_itself() {
    let w = world(ack()).await;
    w.job("J", w.a, "A", "x").await;
    let err = w.take(w.me(w.a, "A"), "J", None).await.unwrap_err();
    assert_eq!(refused(&err), "forbidden");
    assert_eq!(w.holder_of("J").await, (Some(w.a), false));
    w.e.shutdown.cancel();
}

/// TB17 `chain_take_back_notices`: A's notice says "your superior"; P's nearest agent ancestor (X) gets one passive notice per call;
/// a project-ancestor take-back sends no such notice; the event carries via and reason.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb17_chain_take_back_notices() {
    let w = world(ack()).await;
    w.job("J1", w.a, "A", "1").await;
    w.job("J2", w.a, "A", "2").await;
    w.job("J3", w.a, "A", "3").await;
    w.take(w.me(w.c, "C"), "J1", Some("why")).await.unwrap();
    assert!(w.notices(w.a).await[0].contains("C, your superior"), "{:?}", w.notices(w.a).await);
    let to_x = w.notices(w.x).await;
    assert_eq!(to_x.len(), 1, "one notice to the project's nearest agent ancestor");
    assert!(to_x[0].contains("C (superior of A) took mail J1 back from A in project P: why"), "{}", to_x[0]);
    let ev: Value = w.e.db.get().await.unwrap().query_one("SELECT detail FROM ot.events WHERE op = 'mail_take_back' ORDER BY id DESC LIMIT 1", &[]).await.unwrap().get(0);
    assert_eq!((ev["via"].as_str(), ev["reason"].as_str()), (Some("holder_chain"), Some("why")));
    w.take_all(w.me(w.c, "C"), "A").await.unwrap();
    let to_x = w.notices(w.x).await;
    assert_eq!(to_x.len(), 2, "a batch sends one notice listing the ids");
    assert!(to_x[1].contains("J2") && to_x[1].contains("J3"));
    // a project-ancestor take-back sends X no extra notice
    w.job("J4", w.a, "A", "4").await;
    w.take(w.me(w.x, "X"), "J4", None).await.unwrap();
    assert_eq!(w.notices(w.x).await.len(), 2);
    w.e.shutdown.cancel();
}

/// TB18 `chain_right_on_relay_holder`: an ancestor of relay project Q that is not above P takes Q's job through the relay path.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn tb18_chain_right_on_relay_holder() {
    let w = world(ack()).await;
    w.relay_job("R1").await;
    let out = w.take(w.me(w.c, "C"), "R1", None).await.unwrap();
    assert_eq!((out["holder"].as_str(), out["taken"].as_bool()), (Some("Q"), Some(true)));
    let still: i64 = w.e.db.get().await.unwrap().query_one("SELECT count(*) FROM ot.mail WHERE uid = 'R1' AND extra->'claimed'->>'by_project' IS NOT NULL", &[]).await.unwrap().get(0);
    assert_eq!(still, 0);
    w.e.shutdown.cancel();
}

/// TB8 (pure half): the reason rules and the why wording.
#[test]
#[nolog]
fn tb8b_reason_and_why_wording() {
    let r = |v: Value| ops::take_back_reason(&json!({ "reason": v }));
    assert_eq!(r(json!("  a\r\nb\nc ")).unwrap().as_deref(), Some("a b c"));
    assert_eq!(r(json!("   ")).unwrap(), None);
    assert_eq!(ops::take_back_reason(&json!({})).unwrap(), None);
    assert!(r(json!("x".repeat(300))).is_ok());
    assert_eq!(refused(&r(json!("x".repeat(301))).unwrap_err()), "bad_request");
    assert_eq!(ops::take_back_why("X", "project", None), "had it taken back by X");
    assert_eq!(ops::take_back_why("X", "project", Some("r")), "had it taken back by X: r");
    assert_eq!(ops::take_back_why("C", "holder_chain", Some("r")), "had it taken back by C, your superior: r");
    assert_eq!(ops::take_back_why("C", "holder_chain", None), "had it taken back by C, your superior");
}
