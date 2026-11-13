//! Explicit synthetic fixture only; no actor or provider is started.
use super::*;
use crate::runtime::{AgentHandle, AgentMsg, Envelope};

#[test]
fn stall_alert_sender_classification() {
    for from in [From::User, From::Agent { id: 1, name: "sender".into(), generation: 1 }, From::Extern("@org:synthetic".into())] {
        assert!(wake_resets_fail_run(&from), "deliberate sender: {from:?}");
    }
    for from in [From::System, From::Watchdog { key: "dog".into(), name: "automatic".into() }] {
        assert!(!wake_resets_fail_run(&from), "automatic sender: {from:?}");
    }
}

#[nolog]
fn other_runs() -> Value {
    json!({"net_fail_run":2,"balance_probe_run":3,"parked_run":4,"last_wall":{"kind":"synthetic"},
        "ctx_reset_run":5,"native_ctx_retry_run":6,"rate_limit_run":7})
}

struct World {
    e: Arc<Engine>,
    c: tokio_postgres::Client,
    org: i64,
    sender: i64,
    target: i64,
    handle: Arc<AgentHandle>,
    rx: tokio::sync::mpsc::UnboundedReceiver<Envelope>,
}

#[nolog]
async fn world() -> World {
    // Same explicit fixture/migrations/pool pattern as orginbox_queue_tests.rs.
    let url = std::env::var("ORGTREE_STALL_ALERT_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("stall_alert_fixture"));
    assert_eq!(cfg.get_user(), Some("stall_alert_fixture"));
    let (mut c, connection) = cfg.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'stall-fixture','synthetic') RETURNING id", &[]).await.unwrap().get(0);
    let sender: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'sender','sol','live','synthetic') RETURNING id", &[&org]).await.unwrap().get(0);
    let target: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'target',$2,'sol','live','synthetic') RETURNING id", &[&org,&sender]).await.unwrap().get(0);
    let root = std::path::PathBuf::from(std::env::var("ORGTREE_STALL_ALERT_TEST_ROOT").expect("owned synthetic engine root"));
    let mut e = Engine::for_tests(root);
    let mgr = deadpool_postgres::Manager::from_config(cfg, tokio_postgres::NoTls,
        deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut e).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    e.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
    e.orgs.insert(crate::orgs::provisional(org, "synthetic".into(), "stall-fixture".into(), "synthetic".into()));
    // holdings/db_tests.rs inert-handle pattern: open receiver prevents actor spawn.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = Arc::new(AgentHandle { id: target, org_id: org, tx,
        view: arc_swap::ArcSwap::from_pointee(Value::Null),
        helpers: arc_swap::ArcSwap::from_pointee(json!({"count":0,"items":[],"truncated":false})) });
    e.agents.map.pin().insert(target, handle.clone());
    assert!(Arc::ptr_eq(&crate::runtime::actor(&e, org, target), &handle));
    World { e, c, org, sender, target, handle, rx }
}

impl World {
    #[nolog]
    async fn seed(&self) {
        let mut extra = other_runs();
        extra["hard_fail_run"] = json!(1);
        self.c.execute("UPDATE ot.agents SET extra=$2 WHERE id=$1", &[&self.target,&extra]).await.unwrap();
    }

    #[nolog]
    async fn extra(&self) -> Value {
        self.c.query_one("SELECT extra FROM ot.agents WHERE id=$1", &[&self.target]).await.unwrap().get(0)
    }

    #[nolog]
    fn drain_wakes(&mut self) -> usize {
        assert!(Arc::ptr_eq(&crate::runtime::actor(&self.e, self.org, self.target), &self.handle));
        let mut count = 0;
        while let Ok(envelope) = self.rx.try_recv() {
            assert!(matches!(envelope.msg, AgentMsg::Wake), "only test wake messages expected");
            count += 1;
        }
        count
    }
}

#[tokio::test]
#[ignore = "requires isolated stall_alert_fixture database"]
#[nolog]
async fn stall_alert_deliberate_mail_resets_only_hard_fail() {
    let mut w = world().await;
    for from in [From::User, From::Agent { id:w.sender, name:"sender".into(), generation:1 }] {
        w.seed().await;
        send(&w.e, w.org, Outgoing::new(from, "target", "synthetic deliberate wake")).await.unwrap();
        assert!(w.drain_wakes() > 0, "real send must deliver Wake to the inert handle");
        assert_eq!(w.extra().await, other_runs());
        assert_eq!(crate::runtime::recovery::bump(&w.e, w.target, "hard_fail_run").await.unwrap(), 1,
            "the next failure must be eligible to alert again");
    }
}

#[tokio::test]
#[ignore = "requires isolated stall_alert_fixture database"]
#[nolog]
async fn stall_alert_automatic_mail_and_extern_rejection_preserve_run() {
    let mut w = world().await;
    for from in [From::System, From::Watchdog { key:"synthetic-dog".into(), name:"automatic".into() }] {
        w.seed().await;
        let notice = matches!(from, From::System);
        let mut out = Outgoing::new(from, "target", "synthetic automatic message");
        out.notice = notice;
        send(&w.e, w.org, out).await.unwrap();
        assert!(w.drain_wakes() > 0, "existing automatic Wake behavior stays intact");
        let mut expected = other_runs(); expected["hard_fail_run"] = json!(1);
        assert_eq!(w.extra().await, expected);
    }
    w.seed().await;
    let error = send(&w.e, w.org, Outgoing::new(From::Extern("@org:synthetic".into()), "target", "synthetic external message")).await.unwrap_err();
    assert!(error.to_string().contains("outside mail must publish through the org mailbox"));
    assert_eq!(w.drain_wakes(), 0);
    let mut expected = other_runs(); expected["hard_fail_run"] = json!(1);
    assert_eq!(w.extra().await, expected);
}

#[tokio::test]
#[ignore = "requires isolated stall_alert_fixture database"]
#[nolog]
async fn stall_alert_repeated_failures_without_wake_keep_counting() {
    let mut w = world().await;
    w.c.execute("UPDATE ot.agents SET extra=$2 WHERE id=$1", &[&w.target,&other_runs()]).await.unwrap();
    assert_eq!(crate::runtime::recovery::bump(&w.e, w.target, "hard_fail_run").await.unwrap(), 1);
    assert_eq!(crate::runtime::recovery::bump(&w.e, w.target, "hard_fail_run").await.unwrap(), 2,
        "run == 1 alert gate must remain false for the second failure");
    let mut expected = other_runs(); expected["hard_fail_run"] = json!(2);
    assert_eq!(w.extra().await, expected);
    assert_eq!(w.drain_wakes(), 0);
}
