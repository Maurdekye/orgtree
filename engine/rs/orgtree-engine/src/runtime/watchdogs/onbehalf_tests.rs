//! RED tests for a watchdog created on behalf of a descendant (docket
//! `create-a-watchdog-on-behalf-of-a-descendant-owne`; spec rev 1.1 §3: WD1-WD7,
//! RB1-RB8, RA1-RA9, T1). The setter (a superior) creates a dog the descendant owns;
//! project-kind dogs may use a project reached by tree, an effective audience, or the
//! setter's own reach, checked once at create and kept in `memo.reach_grant`.
//!
//! Synthetic PG fixture in the style of `runtime/watchdogs/project_tests.rs`: run one at a
//! time (`--test-threads=1`) against a throwaway database and role named `projdogs_fixture`
//! (`ORGTREE_PROJDOGS_TEST_URL`, `ORGTREE_PROJDOGS_TEST_ROOT`).
use super::*;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use crate::orgs::OrgHandle;

/// C (top) > S > project P > w; C > project Q (C reaches it, w does not); X (top) > x.
/// Audience fixtures: C > A (project) > a1, A > N (project) > n1; C > B (project) > b1.
struct W {
    e: Arc<Engine>,
    org: Arc<OrgHandle>,
    c: i64,
    s: i64,
    p: i64,
    w: i64,
    q: i64,
    x_top: i64,
    x: i64,
}

#[nolog]
async fn world() -> W {
    let url = std::env::var("ORGTREE_PROJDOGS_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("projdogs_fixture"));
    assert_eq!(cfg.get_user(), Some("projdogs_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let org: i64 = client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'projdogs-fixture','fixture') RETURNING id", &[]).await.unwrap().get(0);
    let agent = |name: &'static str, parent: Option<i64>, kind: &'static str| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,$2,$3,$4,$5,'live',$6,'2026-11-04') RETURNING id",
                &[&org, &name, &parent, &kind, &if kind == "project" { "project" } else { "sol" }, &json!({"transparent": kind == "project"})]).await.unwrap().get::<_, i64>(0)
        }
    };
    let c = agent("C", None, "agent").await;
    let s = agent("S", Some(c), "agent").await;
    let p = agent("P", Some(s), "project").await;
    let w = agent("w", Some(p), "agent").await;
    let q = agent("Q", Some(c), "project").await;
    let x_top = agent("X", None, "agent").await;
    let x = agent("x", Some(x_top), "agent").await;
    let a = agent("A", Some(c), "project").await;
    agent("a1", Some(a), "agent").await;
    let n = agent("N", Some(a), "project").await;
    agent("n1", Some(n), "agent").await;
    let b = agent("B", Some(c), "project").await;
    agent("b1", Some(b), "agent").await;
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_PROJDOGS_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let handle = crate::orgs::provisional(org, "fixture".into(), "projdogs-fixture".into(), "fixture".into());
    engine.orgs.insert(handle.clone());
    W { e: engine, org: handle, c, s, p, w, q, x_top, x }
}

impl W {
    #[nolog]
    async fn id(&self, name: &str) -> i64 {
        self.e.db.get().await.unwrap().query_one("SELECT id FROM ot.agents WHERE name=$1", &[&name]).await.unwrap().get(0)
    }
    #[nolog]
    async fn sql(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.e.db.get().await.unwrap().execute(text, params).await.unwrap();
    }
    #[nolog]
    async fn count(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> i64 {
        self.e.db.get().await.unwrap().query_one(text, params).await.unwrap().get(0)
    }
    /// (owner_agent_id, state, memo, id) of the newest live dog with this uid.
    #[nolog]
    async fn dog(&self, uid: &str) -> (Option<i64>, String, Value, i64) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT owner_agent_id, state, memo, id FROM ot.watchdogs WHERE uid=$1 AND state<>'removed' ORDER BY id DESC LIMIT 1", &[&uid]).await.unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    }
    #[nolog]
    async fn fire(&self, row: i64, lines: &[&str]) {
        let mut dog = load(&self.e, row).await.unwrap().unwrap();
        let lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        fire(&self.e, &mut dog, &lines, "").await.unwrap();
    }
    #[nolog]
    async fn bodies(&self, agent: i64) -> Vec<String> {
        self.e.db.get().await.unwrap().query("SELECT body FROM ot.mail WHERE recipient_agent_id=$1 ORDER BY id", &[&agent]).await.unwrap().iter().map(|r| r.get(0)).collect()
    }
    #[nolog]
    async fn mail_with(&self, agent: i64, needle: &str) -> i64 {
        self.count("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1 AND body LIKE '%'||$2||'%'", &[&agent, &needle]).await
    }
    /// A user post to a project's mailbox (it dispatches).
    #[nolog]
    async fn post(&self, project: &str, body: &str) {
        crate::domain::mail::send(&self.e, self.org.id, crate::domain::mail::Outgoing::new(crate::domain::mail::From::User, project, body)).await.unwrap();
    }
    /// A project's mail queue mode ack.
    #[nolog]
    async fn ack_mode(&self, project: i64) {
        self.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{mail_queue}','\"ack\"') WHERE id=$1", &[&project]).await;
    }
    /// Mutual audience: `grantee` holds an audience with `grantor`.
    #[nolog]
    async fn audience(&self, grantee: &str, grantor: &str) {
        self.sql("INSERT INTO ot.audiences(org_id,grantee,grantor) VALUES($1,$2,$3)", &[&self.org.id, &grantee, &grantor]).await;
    }
    #[nolog]
    async fn revoke(&self, grantee: &str, grantor: &str) {
        self.sql("UPDATE ot.audiences SET revoked_at=now() WHERE org_id=$1 AND grantee=$2 AND grantor=$3", &[&self.org.id, &grantee, &grantor]).await;
    }
    #[nolog]
    async fn no_bash(&self, agent: i64) {
        self.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('bash',false)) WHERE id=$1", &[&agent]).await;
    }
    /// A delegated command dog (never matching its pattern, so only the test's own fires happen).
    #[nolog]
    async fn cmd(&self, setter: i64, owner: &str, name: &str) -> Result<Value> {
        create(&self.e, self.org.id, setter, &json!({"kind":"command","target":"echo hi","pattern":"never-matches-zzz","name":name,"owner":owner,"interval_s":3600})).await
    }
    #[nolog]
    async fn queue_dog(&self, setter: i64, owner: &str, project: &str) -> Result<Value> {
        create(&self.e, self.org.id, setter, &json!({"kind":"fair_queue","target":project,"owner":owner,"notice":true})).await
    }
}

#[nolog]
fn err(r: Result<Value>) -> String {
    format!("{:#}", r.expect_err("expected a refusal"))
}

const GRANT_Q_SETTER: &str = "setter";

/// WD1 (W1, W8): C creates a file dog owned by w; the fire goes to w; created_by is C; w gets the notice.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd01_a_superior_creates_a_dog_its_descendant_owns() {
    let w = world().await;
    let out = create(&w.e, w.org.id, w.c, &json!({"kind":"file","target":"watch.txt","name":"feed","owner":"w"})).await.unwrap();
    assert_eq!(out["owner"], "w", "{out}");
    let (owner, state, memo, row) = w.dog("feed").await;
    assert_eq!((owner, state.as_str()), (Some(w.w), "armed"));
    assert_eq!((memo["created_by"]["kind"].clone(), memo["created_by"]["name"].clone(), memo["created_by"]["id"].clone()), (json!("agent"), json!("C"), json!(w.c)));
    w.fire(row, &["the file changed"]).await;
    let mail = w.bodies(w.w).await;
    assert!(mail.iter().any(|b| b.contains("the file changed")), "the fire reaches the owner: {mail:?}");
    assert!(w.bodies(w.c).await.is_empty(), "nothing goes to the setter");
    assert!(mail.iter().any(|b| b.starts_with("@C created watchdog w/feed (\"feed\", file · ") && b.contains("for you. Its fires come to you as your own; you can pause, configure or remove it (orgtree_watchdog action=list).")), "the W8 notice: {mail:?}");
    let notice: bool = w.e.db.get().await.unwrap().query_one("SELECT notice FROM ot.mail WHERE recipient_agent_id=$1 AND body LIKE '@C created watchdog%'", &[&w.w]).await.unwrap().get(0);
    assert!(notice, "the notice is passive");
}

/// WD2 (W2): not below, a project, a retired agent, an owner without the watchdog tools.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd02_who_may_be_the_owner() {
    let w = world().await;
    let e = err(w.cmd(w.c, "x", "a").await);
    assert!(e.contains("x is not below you; you can create watchdogs only for your descendants"), "{e}");
    let e = err(w.cmd(w.c, "P", "b").await);
    assert!(e.contains("P is a project; use project=P for a project's watchdog"), "{e}");
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.x]).await;
    let e = err(w.cmd(w.x_top, "x", "c").await);
    assert!(e.contains("no live agent named x"), "{e}");
    let e = err(w.cmd(w.c, "nobody", "d").await);
    assert!(e.contains("no live agent named nobody"), "{e}");
    // the owner must hold the watchdog tools to manage the dog
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('orgtree',jsonb_build_object('watchdogs',false))) WHERE id=$1", &[&w.w]).await;
    let e = err(w.cmd(w.c, "w", "e").await);
    assert!(e.contains("w does not hold the watchdog tools, so it could not manage this watchdog"), "{e}");
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs", &[]).await, 0, "a refused create inserts nothing");
}

/// WD3 (W3): the owner's bash is needed as for its own create (effective scope clamps down the line, so a
/// setter without bash leaves its owner without it too: the setter text is the same gate seen from above).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd03_both_hold_the_hands() {
    let w = world().await;
    w.no_bash(w.w).await;
    let e = err(w.cmd(w.c, "w", "a").await);
    assert!(e.contains("bash"), "the owner lacks bash, as for its own create: {e}");
    w.sql("UPDATE ot.agents SET scope='{}'::jsonb WHERE id=$1", &[&w.w]).await;
    w.no_bash(w.c).await;
    let e = err(w.cmd(w.c, "w", "b").await);
    assert!(e.contains("bash"), "{e}");
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs", &[]).await, 0);
}

/// WD4 (W1): owner and project are exclusive; owner is a create field only.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd04_owner_is_a_create_field_and_excludes_project() {
    let w = world().await;
    let e = err(create(&w.e, w.org.id, w.c, &json!({"kind":"command","target":"echo hi","pattern":"z","owner":"w","project":"P"})).await);
    assert!(e.contains("owner and project are exclusive: a project's watchdog has no agent owner"), "{e}");
    w.cmd(w.c, "w", "feed").await.unwrap();
    let e = err(act_args(&w, "pause").await);
    assert!(e.contains("owner is a create field; other actions take the watchdog id (owner/id)"), "{e}");
    // owner equal to the caller is an ordinary create: no created_by
    create(&w.e, w.org.id, w.c, &json!({"kind":"command","target":"echo ho","pattern":"z","name":"mine","owner":"C"})).await.unwrap();
    assert!(w.dog("mine").await.2.get("created_by").is_none());
}

/// `orgtree_watchdog action=pause owner=...` through the tool's argument gate.
#[nolog]
async fn act_args(w: &W, action: &str) -> Result<Value> {
    crate::tools::watchdog_owner_guard(&json!({"action": action, "id": "w/feed", "owner": "w"}))
        .map(|_| json!({}))
}

/// WD5 (W4, W5): fire_actions and app_listener are refused for a delegated dog.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd05_fire_actions_and_app_listener_are_refused() {
    let w = world().await;
    let e = err(create(&w.e, w.org.id, w.c, &json!({"kind":"command","target":"echo hi","pattern":"z","owner":"w",
        "fire_actions":[{"tool":"orgtree_status","args":{"status":"working"}}]})).await);
    assert!(e.contains("fire_actions on a watchdog for w would run with w's authority; w adds them itself"), "{e}");
    let e = err(create(&w.e, w.org.id, w.c, &json!({"kind":"app_listener","target":"x","owner":"w"})).await);
    assert!(e.contains("app_listener subscribes the owner's own app panels; w creates it itself"), "{e}");
}

/// WD6 (W9): list as w shows created_by; an ancestor manages; after w moves out the setter does not.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd06_management() {
    let w = world().await;
    w.cmd(w.c, "w", "feed").await.unwrap();
    let l = list(&w.e, w.w, &json!({})).await.unwrap();
    let dog = l["watchdogs"].as_array().or(l["dogs"].as_array()).expect("a list").iter().find(|d| d["id"] == "feed").expect("listed").clone();
    assert_eq!(dog["created_by"], "C", "{dog}");
    act(&w.e, w.org.id, Some(w.s), "w/feed", "pause", None).await.unwrap();
    assert_eq!(w.dog("feed").await.1, "paused");
    w.sql("UPDATE ot.agents SET parent_id=$2 WHERE id=$1", &[&w.w, &w.x]).await;
    let e = err(act(&w.e, w.org.id, Some(w.c), "w/feed", "resume", None).await);
    assert!(e.contains("only its owner and the owner's superiors manage this watchdog"), "{e}");
}

/// WD7 (W10): a ready-once dog resolves inline; the fire goes to the owner; no W8 notice.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd07_ready_once_resolves_inline_to_the_owner() {
    let w = world().await;
    let out = create(&w.e, w.org.id, w.c, &json!({"kind":"command","target":"echo hi","pattern":"hi","once":true,"name":"now","owner":"w"})).await.unwrap();
    assert_eq!((out["resolved"].clone(), out["registered"].clone(), out["owner"].clone()), (json!(true), json!(false), json!("w")), "{out}");
    assert!(out["status"].as_str().unwrap_or("").contains("resolved immediately; no watchdog registered. Its fire went to w"), "{out}");
    let mail = w.bodies(w.w).await;
    assert!(mail.iter().any(|b| b.contains("hi")), "{mail:?}");
    assert!(!mail.iter().any(|b| b.starts_with("@C created watchdog")), "no W8 notice for an inline resolve: {mail:?}");
}

/// RB1/RB2 (W6): a setter's reach lets w watch Q's queue; the grant is recorded; a job is handed to w and w acks it.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb01_rb02_the_setters_reach_hands_w_the_queue_and_its_ack() {
    let w = world().await;
    w.ack_mode(w.q).await;
    let out = w.queue_dog(w.c, "w", "Q").await.unwrap();
    let id = out["id"].as_str().unwrap().to_string();
    let (owner, _, memo, _) = w.dog(&id).await;
    assert_eq!(owner, Some(w.w));
    assert_eq!(memo["reach_grant"], json!({"project": w.q, "via": GRANT_Q_SETTER, "from": "C"}), "{memo}");
    w.post("Q", "job one").await;
    assert_eq!(w.mail_with(w.w, "job one").await, 1, "the job is handed to w");
    let copy: String = w.e.db.get().await.unwrap().query_one("SELECT uid FROM ot.mail WHERE recipient_agent_id=$1 AND body LIKE '%job one%'", &[&w.w]).await.unwrap().get(0);
    let mut ack = crate::domain::mail::Outgoing::new(crate::domain::mail::From::Agent { id: w.w, name: "w".into(), generation: 1 }, "Q", "done");
    ack.reply_to = Some(json!({"id": copy}));
    crate::domain::mail::send(&w.e, w.org.id, ack).await.expect("w's ack through the granted dog is accepted");
}

/// RB3 (W6): the setter moves away and retires; the dog and its grant stand.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb03_the_grant_outlives_the_setter() {
    let w = world().await;
    let id = w.queue_dog(w.c, "w", "Q").await.unwrap()["id"].as_str().unwrap().to_string();
    w.sql("UPDATE ot.agents SET parent_id=$2 WHERE id=$1", &[&w.c, &w.x_top]).await;
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.c]).await;
    assert_eq!(w.dog(&id).await.1, "armed");
    w.post("Q", "after the setter left").await;
    assert_eq!(w.mail_with(w.w, "after the setter left").await, 1, "the next mail is still handed to w");
}

/// RB4 (W6): a delegated project_listener on Q receives Q's event; list shows the grant.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb04_a_delegated_listener_receives_the_event() {
    let w = world().await;
    let out = create(&w.e, w.org.id, w.c, &json!({"kind":"project_listener","target":"Q","owner":"w","notice":true})).await.unwrap();
    crate::domain::listeners::fire(&w.e, w.org.id, w.q, "@C", Some("ping")).await.unwrap();
    assert_eq!(w.mail_with(w.w, "ping").await, 1);
    let l = list(&w.e, w.w, &json!({})).await.unwrap();
    let dog = l["watchdogs"].as_array().or(l["dogs"].as_array()).expect("a list").iter().find(|d| d["id"] == out["id"]).expect("listed").clone();
    assert_eq!(dog["reach_grant"], json!({"project": "Q", "via": "setter", "from": "C"}), "{dog}");
}

/// RB5 (W6): a delegated slot claim is admitted and granted to w.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb05_a_delegated_slot_claim_is_granted() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{slots_capacity}','1') WHERE id=$1", &[&w.q]).await;
    let out = create(&w.e, w.org.id, w.c, &json!({"kind":"slot","target":"Q","owner":"w"})).await.unwrap();
    let _ = out;
    for _ in 0..30 {
        if w.count("SELECT count(*) FROM ot.slot_leases WHERE holder_agent_id=$1 AND ended_at IS NULL", &[&w.w]).await == 1 { return; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("w holds no lease: the delegated claim was not granted");
}

/// RB6 (W6): the borrowed reach stays in the dog: w cannot mail Q, fire its event or own a project dog on it.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb06_the_borrowed_reach_stays_in_the_dog() {
    let w = world().await;
    w.queue_dog(w.c, "w", "Q").await.unwrap();
    let me = crate::domain::mail::From::Agent { id: w.w, name: "w".into(), generation: 1 };
    assert!(crate::domain::mail::send(&w.e, w.org.id, crate::domain::mail::Outgoing::new(me, "Q", "hello")).await.is_err(), "w mails Q: refused");
    let c = w.e.db.get().await.unwrap();
    assert!(!crate::domain::projects::reaches(&**c, w.w, w.q).await.unwrap());
    drop(c);
    let e = err(create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo q","pattern":"z","project":"Q"})).await);
    assert!(e.contains("you are neither above nor below project Q, so you cannot put a watchdog on it"), "{e}");
}

/// RB7 (control): x creates for its own descendant a queue dog on a project only x reaches.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb07_the_same_rule_anywhere() {
    let w = world().await;
    let (xp, xd) = (w.id("A").await, w.x);
    let _ = (xp, xd);
    w.sql("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'XQ',$2,'project','project','live','{\"transparent\":true}','2026-11-04')", &[&w.org.id, &w.x_top]).await;
    w.sql("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'xd',$2,'sol','live','2026-11-04')", &[&w.org.id, &w.x]).await;
    create(&w.e, w.org.id, w.x_top, &json!({"kind":"fair_queue","target":"XQ","owner":"xd","notice":true})).await.expect("allowed");
}

/// RB8 (control): an owner who reaches Q by tree gets no grant; moving away loses it as today.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn rb08_tree_reach_stores_no_grant() {
    let w = world().await;
    let id = w.queue_dog(w.c, "S", "P").await.unwrap()["id"].as_str().unwrap().to_string();
    // S is above P: tree reach
    assert!(w.dog(&id).await.2.get("reach_grant").is_none());
}

/// RA1 (W6): w holds an explicit audience with Q; its own fair_queue on Q is refused before, created after; a mail is handed to w.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra01_an_audience_lets_w_watch_the_queue() {
    let w = world().await;
    let e = err(create(&w.e, w.org.id, w.w, &json!({"kind":"fair_queue","target":"Q","notice":true})).await);
    assert!(e.contains("only agents above or below project Q, or holding an audience with it, may watch it; cannot watch its mailbox"), "{e}");
    w.audience("w", "Q").await;
    let id = create(&w.e, w.org.id, w.w, &json!({"kind":"fair_queue","target":"Q","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(w.dog(&id).await.2["reach_grant"], json!({"project": w.q, "via": "audience", "from": null}));
    w.post("Q", "audience job").await;
    assert_eq!(w.mail_with(w.w, "audience job").await, 1);
}

/// RA2 (W6): the audience is inherited from w's project.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra02_an_inherited_audience_counts() {
    let w = world().await;
    w.audience("P", "Q").await;
    let id = create(&w.e, w.org.id, w.w, &json!({"kind":"fair_queue","target":"Q","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    w.post("Q", "inherited job").await;
    assert_eq!(w.mail_with(w.w, "inherited job").await, 1);
    let _ = id;
}

/// RA3 (W6): revoking the audience takes nothing back; a manual pause then resume works.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra03_revoking_the_audience_changes_nothing() {
    let w = world().await;
    w.audience("w", "Q").await;
    let id = create(&w.e, w.org.id, w.w, &json!({"kind":"fair_queue","target":"Q","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    w.revoke("w", "Q").await;
    assert_eq!(w.dog(&id).await.1, "armed");
    w.post("Q", "after revoke").await;
    assert_eq!(w.mail_with(w.w, "after revoke").await, 1, "the next mail is still handed out");
    act(&w.e, w.org.id, Some(w.w), &id, "pause", None).await.unwrap();
    act(&w.e, w.org.id, Some(w.w), &id, "resume", None).await.unwrap();
    assert_eq!(w.dog(&id).await.1, "armed");
}

/// RA4 (W6): a setter with only an audience with Q creates a delegated listener; Q's event reaches w.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra04_the_setters_audience_counts() {
    let w = world().await;
    w.sql("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'cs',NULL,'sol','live','2026-11-04')", &[&w.org.id]).await;
    let cs = w.id("cs").await;
    w.sql("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'cw',$2,'sol','live','2026-11-04')", &[&w.org.id, &cs]).await;
    let cw = w.id("cw").await;
    w.audience("cs", "Q").await;
    let id = create(&w.e, w.org.id, cs, &json!({"kind":"project_listener","target":"Q","owner":"cw","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(w.dog(&id).await.2["reach_grant"], json!({"project": w.q, "via": "setter_audience", "from": "cs"}));
    crate::domain::listeners::fire(&w.e, w.org.id, w.q, "@cs", Some("hello q")).await.unwrap();
    assert_eq!(w.mail_with(cw, "hello q").await, 1);
}

/// RA5 (control): an audience does not let w own a project dog.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra05_an_audience_is_not_enough_for_a_project_owned_dog() {
    let w = world().await;
    w.audience("w", "Q").await;
    let e = err(create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo q","pattern":"z","project":"Q"})).await);
    assert!(e.contains("you are neither above nor below project Q, so you cannot put a watchdog on it"), "{e}");
}

/// RA6 (W6, the [verify]): project A holds an audience with B; a1 directly under A watches B (grant) and A (tree).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra06_project_to_project_audience() {
    let w = world().await;
    w.audience("A", "B").await;
    let a1 = w.id("a1").await;
    let held = w.count("SELECT count(*) FROM ot.effective_audiences WHERE org_id=$1 AND grantee='a1' AND grantor='B'", &[&w.org.id]).await;
    assert_eq!(held, 1, "the inherited effective_audiences row for A's direct member exists");
    let qb = create(&w.e, w.org.id, a1, &json!({"kind":"fair_queue","target":"B","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    let la = create(&w.e, w.org.id, a1, &json!({"kind":"project_listener","target":"A","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(w.dog(&qb).await.2["reach_grant"]["via"], "audience");
    assert_eq!(w.dog(&qb).await.2["reach_grant"]["from"], Value::Null);
    assert!(w.dog(&la).await.2.get("reach_grant").is_none(), "A is reached by tree: no grant");
}

/// RA7 (control): one-way grant; b1 under B cannot watch A until B also holds an audience with A.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra07_one_way_then_mutual() {
    let w = world().await;
    w.audience("A", "B").await;
    let b1 = w.id("b1").await;
    let a = json!({"kind":"fair_queue","target":"A","notice":true});
    let e = err(create(&w.e, w.org.id, b1, &a).await);
    assert!(e.contains("only agents above or below project A, or holding an audience with it, may watch it"), "{e}");
    w.audience("B", "A").await;
    create(&w.e, w.org.id, b1, &a).await.expect("created after the reverse grant");
}

/// RA8 (control): n1 in a project nested under A inherits nothing.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra08_no_nested_relay() {
    let w = world().await;
    w.audience("A", "B").await;
    let n1 = w.id("n1").await;
    let e = err(create(&w.e, w.org.id, n1, &json!({"kind":"fair_queue","target":"B","notice":true})).await);
    assert!(e.contains("only agents above or below project B, or holding an audience with it, may watch it"), "{e}");
}

/// RA9: after RA6, revoking A's audience with B leaves a1's B dog running.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ra09_revoking_a_project_audience_changes_nothing() {
    let w = world().await;
    w.audience("A", "B").await;
    let a1 = w.id("a1").await;
    let id = create(&w.e, w.org.id, a1, &json!({"kind":"fair_queue","target":"B","notice":true})).await.unwrap()["id"].as_str().unwrap().to_string();
    w.revoke("A", "B").await;
    assert_eq!(w.dog(&id).await.1, "armed");
    w.post("B", "late job").await;
    assert_eq!(w.mail_with(a1, "late job").await, 1);
}
