//! Focused synthetic PG fixture for what a holder gives back (no serve, no
//! provider, no native CLI, no live DB). Each test builds its own disposable
//! `ot` schema, so run them one at a time (`--test-threads=1`) against a
//! throwaway database named and owned `holdings_fixture`.
//!
//! Every claim here is a passive `notice` slot claim, and no project has an
//! armed mail listener except where a test says so, so nothing wakes a CLI.
use super::*;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use crate::orgs::OrgHandle;

struct World {
    e: Arc<Engine>,
    org: Arc<OrgHandle>,
    project: i64,
    holder: i64,
    waiter: i64,
    /// a top-level agent: a place to move the holder to that is neither above nor below the project
    elsewhere: i64,
}

#[nolog]
async fn world(scope: Value) -> World {
    let url = std::env::var("ORGTREE_HOLDINGS_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("holdings_fixture"));
    assert_eq!(cfg.get_user(), Some("holdings_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let id: i64 = client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'holdings-fixture','fixture') RETURNING id", &[]).await.unwrap().get(0);
    let project: i64 = client.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,'build','project','project','live',$2,'2026-10-27') RETURNING id", &[&id, &scope]).await.unwrap().get(0);
    let agent = |name: &'static str, parent: Option<i64>| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-10-27') RETURNING id", &[&id, &name, &parent]).await.unwrap().get::<_, i64>(0)
        }
    };
    let holder = agent("holder", Some(project)).await;
    let waiter = agent("waiter", Some(project)).await;
    let elsewhere = agent("elsewhere", None).await;
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_HOLDINGS_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org = crate::orgs::provisional(id, "fixture".into(), "holdings-fixture".into(), "fixture".into());
    World { e: engine, org, project, holder, waiter, elsewhere }
}

impl World {
    /// `agent` claims one slot with a passive claim: the lease at once when one is free, else its place in line.
    #[nolog]
    async fn claim(&self, agent: i64) -> Value {
        crate::runtime::watchdogs::create(&self.e, self.org.id, agent, &json!({"kind":"slot","target":"build","notice":true})).await.unwrap()
    }

    #[nolog]
    async fn sql(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.e.db.get().await.unwrap().execute(text, params).await.unwrap();
    }

    /// (is it ended, what it recorded) for a lease.
    #[nolog]
    async fn lease(&self, uid: &str) -> (bool, Option<String>) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT ended_at IS NOT NULL, end_reason FROM ot.slot_leases WHERE uid = $1", &[&uid]).await.unwrap();
        (r.get(0), r.get(1))
    }

    /// How many leases an agent holds now.
    #[nolog]
    async fn holds(&self, agent: i64) -> i64 {
        self.e.db.get().await.unwrap().query_one("SELECT count(*) FROM ot.slot_leases WHERE holder_agent_id = $1 AND ended_at IS NULL", &[&agent]).await.unwrap().get(0)
    }

    /// Is there a System notice to the agent containing every needle?
    #[nolog]
    async fn told(&self, agent: i64, needles: &[&str]) -> bool {
        let rows = self.e.db.get().await.unwrap()
            .query("SELECT body FROM ot.mail WHERE recipient_agent_id = $1 AND sender = '@system' AND notice", &[&agent]).await.unwrap();
        rows.iter().any(|r| { let b: String = r.get(0); needles.iter().all(|n| b.contains(n)) })
    }

    /// An un-acked ack-mode job held by `agent` (what the project's copy of the mail looks like).
    #[nolog]
    async fn job(&self, agent: i64, copy: &str) -> i64 {
        self.e.db.get().await.unwrap().query_one(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
             VALUES($1,$2,'@user','agent',$3,'build','job','read',$4) RETURNING id",
            &[&format!("job-{copy}"), &self.org.id, &self.project,
              &json!({"attempts":1,"claimed":{"by_id":agent,"by":"holder","copy":copy,"ack":true,"at":crate::util::now_iso()}})],
        ).await.unwrap().get(0)
    }

    /// (state, still claimed, the reason it recorded) for a job.
    #[nolog]
    async fn job_state(&self, row: i64) -> (String, bool, Option<String>) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT state, extra ? 'claimed', extra->'released'->>'why' FROM ot.mail WHERE id = $1", &[&row]).await.unwrap();
        (r.get(0), r.get(1), r.get(2))
    }

    #[nolog]
    async fn freeze(&self, agent: i64) {
        self.sql("UPDATE ot.agents SET frozen = $2 WHERE id = $1", &[&agent, &json!({"until":"2099-01-01T00:00:00Z","limit":true,"error":"usage limit"})]).await;
    }
}

/// A project with one slot, and the same in ack mode (its un-acked jobs are held).
fn one_slot() -> Value {
    json!({"slots_capacity":1})
}

fn ack_mode() -> Value {
    json!({"slots_capacity":1,"mail_queue":"ack"})
}

/// The incident: a frozen holder kept its slot until it was retired, while the line waited.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_frozen_holder_gives_back_its_lease_and_the_next_waiter_gets_it_at_once() {
    let w = world(one_slot()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().expect("a free slot is granted inline").to_string();
    let queued = w.claim(w.waiter).await;
    assert_ne!(queued["resolved"], true, "the only slot is taken, so the waiter stands in line");
    w.freeze(w.holder).await;
    projects::recheck_holder(&w.e, w.org.id, w.holder).await;
    assert_eq!(w.lease(&lease).await, (true, Some("frozen".into())), "a frozen holder's lease ends at once");
    assert_eq!(w.holds(w.holder).await, 0);
    assert_eq!(w.holds(w.waiter).await, 1, "the next waiter in FIFO order is granted the freed slot");
    assert!(w.told(w.holder, &[&lease, "you were frozen by a usage limit", "slot watchdog"]).await, "the frozen holder reads what was released at its next turn");
    w.e.shutdown.cancel();
}

/// Control (the existing rule): a halted holder's lease already went back at once.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_halted_holder_gives_back_its_lease_and_the_next_waiter_gets_it_at_once() {
    let w = world(one_slot()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    w.claim(w.waiter).await;
    w.sql("UPDATE ot.agents SET halt = $2 WHERE id = $1", &[&w.holder, &json!({"phase":"halted"})]).await;
    projects::recheck_holder(&w.e, w.org.id, w.holder).await;
    assert_eq!(w.lease(&lease).await, (true, Some("halted".into())));
    assert_eq!(w.holds(w.waiter).await, 1);
    assert!(w.told(w.holder, &[&lease, "you were halted"]).await);
    w.e.shutdown.cancel();
}

/// Control: nothing about a live, running, reachable holder changes.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_live_holder_that_reaches_the_project_keeps_its_lease() {
    let w = world(one_slot()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    w.claim(w.waiter).await;
    projects::recheck_holder(&w.e, w.org.id, w.holder).await;
    slots::check(&w.e, w.org.id, w.project).await.unwrap();
    assert_eq!(w.lease(&lease).await, (false, None));
    assert_eq!(w.holds(w.waiter).await, 0, "the line keeps waiting");
    assert!(!w.told(w.holder, &["took back"]).await);
    w.e.shutdown.cancel();
}

/// A waiting claimant that is frozen is passed over like a halted one, keeps its place, and is granted when it thaws.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_frozen_waiter_is_passed_over_and_granted_after_it_thaws() {
    let w = world(one_slot()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    w.claim(w.waiter).await;
    w.freeze(w.waiter).await;
    w.sql("UPDATE ot.slot_leases SET ended_at = now(), end_reason = 'released' WHERE uid = $1", &[&lease]).await;
    slots::grant(&w.e, w.org.id, w.project).await.unwrap();
    assert_eq!(w.holds(w.waiter).await, 0, "a frozen claimant cannot run, so it is not handed the slot");
    w.sql("UPDATE ot.agents SET frozen = NULL WHERE id = $1", &[&w.waiter]).await;
    projects::recheck_holder(&w.e, w.org.id, w.waiter).await;
    assert_eq!(w.holds(w.waiter).await, 1, "it keeps its place and takes the slot once it can run");
    w.e.shutdown.cancel();
}

/// User 2026-10-27 16:17Z: an agent moved out of a project returns its slots at once.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn moving_out_of_the_project_gives_back_the_lease_and_a_move_inside_keeps_it() {
    let w = world(one_slot()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    w.claim(w.waiter).await;
    // inside: under the waiter, still below the project
    let run = |node: &str, to: &str| crate::domain::ops::run(&w.e, &w.org, crate::domain::ops::Actor::User, &json!({"op":"move","node":node,"new_parent":to}));
    run("holder", "waiter").await.unwrap();
    assert_eq!(w.lease(&lease).await, (false, None), "a move that stays below the project keeps the lease");
    // outside: under an agent that is neither above nor below the project
    run("holder", "elsewhere").await.unwrap();
    assert_eq!(w.lease(&lease).await, (true, Some("moved out of the project".into())), "the move ends the lease at once");
    assert_eq!(w.holds(w.waiter).await, 1, "and the next waiter is granted it");
    assert!(w.told(w.holder, &[&lease, "you moved out of the project"]).await);
    let _ = w.elsewhere;
    w.e.shutdown.cancel();
}

/// User 2026-10-27 16:18Z: a turn that dies gives back slots AND un-acked jobs at once.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_turn_that_dies_gives_back_its_leases_and_its_unacked_jobs() {
    let w = world(ack_mode()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    w.claim(w.waiter).await;
    let job = w.job(w.holder, "copy-1").await;
    let death = crate::domain::holdings::died(&Ending { error: Some("the Claude process exited during the turn"), ..Ending::default() }).expect("an exit is a death");
    let given = release_after_death(&w.e, w.org.id, w.holder, "holder", &death).await.unwrap();
    assert_eq!((given.leases.len(), given.jobs.len()), (1, 1));
    assert_eq!(w.lease(&lease).await, (true, Some("turn ended abnormally".into())));
    assert_eq!(w.holds(w.waiter).await, 1, "the next waiter is granted the freed slot");
    let (state, claimed, why) = w.job_state(job).await;
    assert_eq!((state.as_str(), claimed), ("pending", false), "the job is back at the front of the queue");
    assert!(why.unwrap().contains("its turn ended abnormally"), "the job's record names the third-person reason");
    let how: String = w.e.db.get().await.unwrap().query_one("SELECT how FROM ot.project_mail_endings WHERE mail_uid = $1", &[&format!("job-copy-1")]).await.unwrap().get(0);
    assert_eq!(how, "failed", "it is recorded as a failed job, as every engine release is");
    assert!(w.told(w.holder, &[&lease, "mail copy-1", "your turn ended abnormally", "an ack of a released job is refused"]).await);
    w.e.shutdown.cancel();
}

/// A job that has used its last attempt goes to the dead letters, as every other release of it would.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_dead_turns_job_on_its_last_attempt_is_dead_lettered() {
    let w = world(json!({"slots_capacity":1,"mail_queue":"ack","mail_queue_max_attempts":1})).await;
    let job = w.job(w.holder, "copy-last").await;
    let death = Death::engine_restart();
    let given = release_after_death(&w.e, w.org.id, w.holder, "holder", &death).await.unwrap();
    // the working-checkup switch decides whether attempts count; with it on, the attempt limit applies
    let counted = crate::runtime::reminders::switches(&w.e).checkups;
    assert_eq!(given.jobs[0].dead, counted, "dead-lettering follows the existing attempt rule");
    let (state, claimed, _) = w.job_state(job).await;
    assert!(!claimed, "either way the holder no longer holds it ({state})");
    w.e.shutdown.cancel();
}

/// A frozen holder's un-acked job goes back to the queue too, and its next turn is told.
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn a_frozen_holders_unacked_job_goes_back_to_the_queue() {
    let w = world(ack_mode()).await;
    let job = w.job(w.holder, "copy-frozen").await;
    w.freeze(w.holder).await;
    projects::recheck_holder(&w.e, w.org.id, w.holder).await;
    let (state, claimed, why) = w.job_state(job).await;
    assert_eq!((state.as_str(), claimed), ("pending", false));
    assert_eq!(why.as_deref(), Some("was frozen by a usage limit"));
    assert!(w.told(w.holder, &["mail copy-frozen", "you were frozen by a usage limit"]).await);
    w.e.shutdown.cancel();
}

/// Control: a manual interrupt, or an agent ending its turn, is not a death: the decision function
/// says so and the holder keeps what it holds (the Ack timeout still covers an idle holder).
#[tokio::test]
#[ignore = "requires the disposable holdings_fixture DB/role; never an ambient DB"]
async fn an_interrupt_or_a_deliberate_end_keeps_the_holdings() {
    let w = world(ack_mode()).await;
    let lease = w.claim(w.holder).await["lease"].as_str().unwrap().to_string();
    let job = w.job(w.holder, "copy-kept").await;
    for ending in [Ending { interrupted: true, ..Ending::default() }, Ending::default()] {
        assert!(crate::domain::holdings::died(&ending).is_none());
    }
    // what the actor runs at a turn's end for these: nothing; so the state is untouched
    slots::check(&w.e, w.org.id, w.project).await.unwrap();
    projects::dispatch(&w.e, w.org.id, w.project).await.unwrap();
    assert_eq!(w.lease(&lease).await, (false, None));
    assert_eq!(w.job_state(job).await.1, true);
    w.e.shutdown.cancel();
}
