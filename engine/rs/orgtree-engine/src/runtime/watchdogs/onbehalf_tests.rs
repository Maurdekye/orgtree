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
    // a path both hold: the org workspace
    let target = w.e.cfg.workspace_dir("projdogs-fixture").join("watch.txt").to_string_lossy().into_owned();
    let out = create(&w.e, w.org.id, w.c, &json!({"kind":"file","target":target,"name":"feed","owner":"w"})).await.unwrap();
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

/// WD5 (W4, W5 rev 1.2): app_listener is refused; fire_actions outside the allow-list are refused at create.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn wd05_app_listener_and_unlisted_fire_actions_are_refused() {
    let w = world().await;
    let e = err(create(&w.e, w.org.id, w.c, &json!({"kind":"command","target":"echo hi","pattern":"z","owner":"w",
        "fire_actions":[{"tool":"orgtree_work","args":{"action":"list"}}]})).await);
    assert!(e.contains("fire_actions on a watchdog for w may use only orgtree_message, orgtree_send_notice, orgtree_watchdog (pause/resume/remove/send/list), orgtree_project fire_event and orgtree_status"), "{e}");
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

// ---------------------------------------------------------------- fire_actions limited to both (rev 1.2, FA1-FA8)

impl W {
    /// A delegated command dog whose fire runs `actions`; returns the dog row.
    #[nolog]
    async fn acting_dog(&self, setter: i64, owner: &str, name: &str, actions: Value) -> i64 {
        create(&self.e, self.org.id, setter, &json!({"kind":"command","target":"echo hi","pattern":"never-matches-zzz","name":name,"owner":owner,"interval_s":3600,"fire_actions":actions})).await.unwrap();
        self.dog(name).await.3
    }
    /// The newest fire mail w holds that carries fire actions.
    #[nolog]
    async fn fire_mail(&self, agent: i64) -> String {
        self.bodies(agent).await.into_iter().rev().find(|b| b.contains("Fire actions")).expect("a fire mail with its fire actions")
    }
}

fn say(to: &str, body: &str) -> Value {
    json!([{"tool":"orgtree_message","args":{"metadata":{"to":to},"body":body}}])
}

/// FA1: the call is made as the owner; the heading names the setter.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa01_a_call_both_may_make_runs() {
    let w = world().await;
    let row = w.acting_dog(w.c, "w", "act", say("S", "report from w")).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("Fire actions (run as you, limited to what both you and @C may do now):"), "{mail}");
    assert!(mail.contains("orgtree_message: ok"), "{mail}");
    assert_eq!(w.mail_with(w.s, "report from w").await, 1, "the message was sent as w");
}

/// FA2: the owner can reach x by an audience, the setter cannot: FAILED, nothing sent.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa02_the_setters_reach_over_the_recipient() {
    let w = world().await;
    w.audience("w", "x").await;
    let row = w.acting_dog(w.c, "w", "act", say("x", "should not arrive")).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("orgtree_message: FAILED") && mail.contains("@C cannot send to x"), "{mail}");
    assert_eq!(w.mail_with(w.x, "should not arrive").await, 0);
}

/// FA3: the user as recipient: the setter (not top-level, no user audience) cannot, though w holds one.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa03_the_user_needs_the_setters_own_route() {
    let w = world().await;
    w.audience("w", "@user").await;
    let row = w.acting_dog(w.s, "w", "act", say("user", "to the user")).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("orgtree_message: FAILED"), "{mail}");
    assert_eq!(w.count("SELECT count(*) FROM ot.mail WHERE recipient_kind='user' AND body LIKE '%to the user%'", &[]).await, 0);
}

/// FA4: the setter's tool groups lose messaging.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa04_the_setters_tool_groups() {
    let w = world().await;
    let row = w.acting_dog(w.c, "w", "act", say("S", "nope")).await;
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('orgtree',jsonb_build_object('messaging',false))) WHERE id=$1", &[&w.c]).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("orgtree_message: FAILED") && mail.contains("@C's tool groups do not allow orgtree_message"), "{mail}");
}

/// FA5: the setter retired, or the owner moved out of its line: every call fails; the fire mail is still delivered.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa05_a_retired_or_left_behind_setter() {
    let w = world().await;
    let row = w.acting_dog(w.c, "w", "act", say("S", "never")).await;
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.c]).await;
    w.fire(row, &["first"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("the setter @C is retired") && mail.contains("first"), "{mail}");
    w.sql("UPDATE ot.agents SET state='live' WHERE id=$1", &[&w.c]).await;
    w.sql("UPDATE ot.agents SET parent_id=$2 WHERE id=$1", &[&w.w, &w.x]).await;
    w.fire(row, &["second"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("the setter @C is no longer above you") && mail.contains("second"), "{mail}");
    assert_eq!(w.mail_with(w.s, "never").await, 0);
}

/// FA6: watchdog actions need the setter's management of the target dog.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa06_watchdog_actions_need_the_setters_management() {
    let w = world().await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo own","pattern":"z","name":"mine"})).await.unwrap();
    create(&w.e, w.org.id, w.x, &json!({"kind":"command","target":"echo far","pattern":"z","name":"far"})).await.unwrap();
    let actions = json!([{"tool":"orgtree_watchdog","args":{"action":"pause","id":"mine"}},{"tool":"orgtree_watchdog","args":{"action":"pause","id":"x/far"}}]);
    let row = w.acting_dog(w.c, "w", "act", actions).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert_eq!(w.dog("mine").await.1, "paused", "{mail}");
    assert_eq!(w.dog("far").await.1, "armed", "the far dog is untouched: {mail}");
    assert!(mail.contains("orgtree_watchdog: FAILED"), "{mail}");
}

/// FA7: a fire action cannot create a watchdog (a chain of delegations).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa07_a_fire_action_cannot_create() {
    let w = world().await;
    let row = w.acting_dog(w.c, "w", "act", say("S", "x")).await;
    // the create-time allow-list would refuse a create action, so plant it in the stored dog
    w.sql("UPDATE ot.watchdogs SET memo=jsonb_set(memo,'{fire_actions}',$2::jsonb) WHERE id=$1",
        &[&row, &json!([{"tool":"orgtree_watchdog","args":{"action":"create","kind":"command","target":"echo z","pattern":"q"}}])]).await;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("a fire action cannot create watchdogs on a watchdog created for you"), "{mail}");
}

/// FA8 (control): w's own dog: the unchanged heading and no setter check.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn fa08_an_own_dog_is_unchanged() {
    let w = world().await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo hi","pattern":"never-matches-zzz","name":"own","interval_s":3600,"fire_actions":say("S","own report")})).await.unwrap();
    let row = w.dog("own").await.3;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("Fire actions (run as you, with your current authority):") && !mail.contains("limited to what both"), "{mail}");
    assert_eq!(w.mail_with(w.s, "own report").await, 1);
}

// ---------------------------------------------------------------- management controls (rev 1.2 W9, MG1-MG3)

/// MG1 (control): an agent two levels above w, through project P, manages w's dog completely.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn mg01_any_ancestor_manages() {
    let w = world().await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo hi","pattern":"z","name":"mine"})).await.unwrap();
    w.sql("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,memo) VALUES('sock',$1,$2,'sock','websocket','ws://127.0.0.1:1/x',5,'paused','{\"connection_messages\":\"notice\",\"run\":{}}'::jsonb)", &[&w.org.id, &w.w]).await;
    // C is two levels above w (C > S > P > w)
    act(&w.e, w.org.id, Some(w.c), "w/mine", "pause", None).await.unwrap();
    assert_eq!(w.dog("mine").await.1, "paused");
    act(&w.e, w.org.id, Some(w.c), "w/mine", "resume", None).await.unwrap();
    assert_eq!(w.dog("mine").await.1, "armed");
    configure(&w.e, w.org.id, Some(w.c), "w/sock", &json!({"connection_messages":"wake"})).await.unwrap();
    assert_eq!(w.dog("sock").await.2["connection_messages"], "wake");
    act(&w.e, w.org.id, Some(w.c), "w/mine", "remove", None).await.unwrap();
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE uid='mine' AND state<>'removed'", &[]).await, 0);
}

/// MG2 (control): an agent above project P (not a member) pauses a P-owned dog; P's member resumes it.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn mg02_project_dogs_are_managed_from_above_and_from_inside() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}','true') WHERE id=$1", &[&w.p]).await;
    create(&w.e, w.org.id, w.s, &json!({"kind":"command","target":"echo hi","pattern":"z","name":"pd","project":"P"})).await.unwrap();
    act(&w.e, w.org.id, Some(w.s), "P/pd", "pause", None).await.unwrap();
    assert_eq!(w.dog("pd").await.1, "paused");
    act(&w.e, w.org.id, Some(w.w), "P/pd", "resume", None).await.unwrap();
    assert_eq!(w.dog("pd").await.1, "armed");
}

/// MG3 (control): x, not an ancestor, cannot pause w's dog.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn mg03_a_non_ancestor_cannot_manage() {
    let w = world().await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"command","target":"echo hi","pattern":"z","name":"mine"})).await.unwrap();
    let e = err(act(&w.e, w.org.id, Some(w.x), "w/mine", "pause", None).await);
    assert!(e.contains("only its owner and the owner's superiors manage this watchdog") || e.contains("no watchdog"), "{e}");
    assert_eq!(w.dog("mine").await.1, "armed");
}

// ---------------------------------------------------------------- configure edits (rev 1.4 §5, CE1-CE13)

impl W {
    /// A file dog owned by w in the org workspace (a path every ancestor holds too).
    #[nolog]
    async fn file_dog(&self, name: &str) -> (i64, String) {
        let path = self.e.cfg.workspace_dir("projdogs-fixture").join(format!("{name}.txt")).to_string_lossy().into_owned();
        create(&self.e, self.org.id, self.w, &json!({"kind":"file","target":path,"name":name,"pattern":"alpha","interval_s":60})).await.unwrap();
        (self.dog(name).await.3, path)
    }
    #[nolog]
    async fn cfg(&self, actor: i64, id: &str, edit: Value) -> Result<Value> {
        configure(&self.e, self.org.id, Some(actor), id, &edit).await
    }
    #[nolog]
    async fn column(&self, uid: &str, col: &str) -> String {
        self.e.db.get().await.unwrap().query_one(&format!("SELECT {col}::text FROM ot.watchdogs WHERE uid=$1 AND state<>'removed' ORDER BY id DESC LIMIT 1"), &[&uid]).await.unwrap().get(0)
    }
}

/// CE1: the owner edits behaviour; id, fire count and ring stay; the edit fires nothing.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce01_the_owner_edits_behaviour() {
    let w = world().await;
    let (row, _) = w.file_dog("f").await;
    w.fire(row, &["first"]).await;
    let before = w.count("SELECT jsonb_array_length(events)::bigint FROM ot.watchdogs WHERE id=$1", &[&row]).await;
    let out = w.cfg(w.w, "f", json!({"pattern":"beta","interval_s":120})).await.unwrap();
    assert_eq!(out["id"], "f", "{out}");
    assert_eq!((w.column("f", "pattern").await.as_str(), w.column("f", "interval_s").await.as_str()), ("beta", "120"));
    assert_eq!(w.column("f", "fired").await, "1", "the fire count is kept");
    assert_eq!(w.count("SELECT jsonb_array_length(events)::bigint FROM ot.watchdogs WHERE id=$1", &[&row]).await, before, "the ring is kept and the edit adds no fire");
    assert_eq!(w.dog("f").await.1, "armed");
}

/// CE2/CE3: tier B target rechecks the hands of the editor and of the owner.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce02_ce03_target_edits_need_both_sets_of_hands() {
    let w = world().await;
    let (_, _) = w.file_dog("f").await;
    // a folder only the owner holds (its own working folder), edited in by an ancestor
    let owners = owner_scratch(&w.e, w.org.id, "w", None).join("private.txt").to_string_lossy().into_owned();
    let e = err(w.cfg(w.c, "w/f", json!({"target": owners})).await);
    assert!(e.contains("cannot watch"), "the editor lacks the folder: {e}");
    // a path neither holds
    let out = std::env::temp_dir().join("outside-everyone.txt").to_string_lossy().into_owned();
    let e = err(w.cfg(w.w, "f", json!({"target": out})).await);
    assert!(e.contains("cannot watch"), "the owner lacks it too: {e}");
    assert!(w.column("f", "target").await.ends_with("f.txt"), "nothing was written");
}

/// CE4: a websocket tier B edit reconnects; a pattern-only edit does not.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce04_a_hello_edit_reconnects_a_pattern_edit_does_not() {
    use crate::ws::testserver::{Opts, TestServer};
    let w = world().await;
    let server = TestServer::start(Opts::default()).await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"websocket","target":server.url("/v1/events"),"name":"sock"})).await.unwrap();
    assert!(server.until(10, |s| s.live() >= 1).await);
    let row = w.dog("sock").await.3;
    let dials = server.upgrades();
    // rev 1.6: a pattern edit reconnects too, so it takes effect now: a matching message fires, another does not
    w.cfg(w.w, "sock", json!({"pattern":"news","interval_s":5})).await.unwrap();
    assert!(server.until(10, |s| s.upgrades() > dials).await, "a pattern edit reconnects");
    assert!(server.until(10, |s| s.live() >= 1).await);
    server.push(tokio_tungstenite::tungstenite::Message::Text("sports: ignored".into()));
    server.push(tokio_tungstenite::tungstenite::Message::Text("news: matched".into()));
    for _ in 0..100 {
        if w.mail_with(w.w, "news: matched").await > 0 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert_eq!(w.mail_with(w.w, "news: matched").await, 1, "the edited pattern fires on a match");
    assert_eq!(w.mail_with(w.w, "sports: ignored").await, 0, "and not on a non-match");
    let dials = server.upgrades();
    w.cfg(w.w, "sock", json!({"hello":["hi there"]})).await.unwrap();
    assert!(server.until(10, |s| s.upgrades() > dials).await, "a tier B edit reconnects");
    assert_eq!(w.dog("sock").await.2["websocket"]["hello"], json!(["hi there"]));
    disarm(&w.e, row);
    server.stop();
}

/// CE5: kind, owner, project and name are fixed.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce05_fixed_fields() {
    let w = world().await;
    w.file_dog("f").await;
    for edit in [json!({"kind":"command"}), json!({"owner":"S"}), json!({"project":"P"}), json!({"name":"g"})] {
        let e = err(w.cfg(w.w, "f", edit.clone()).await);
        assert!(e.contains("kind, owner, project and name are fixed; create a new watchdog instead"), "{edit}: {e}");
    }
}

/// CE6 (rev 1.6): an edit refuses only where create refuses; a smoke create only warns about is saved and the warning returned.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce06_a_broken_smoke_is_saved_with_a_warning() {
    let w = world().await;
    w.cmd(w.c, "w", "run").await.unwrap();
    let out = w.cfg(w.w, "run", json!({"target":"definitely-not-a-command-zzz --nope"})).await.unwrap();
    assert!(out["warning"].as_str().is_some_and(|t| t.contains("DOES NOT WORK")), "the warning is returned: {out}");
    assert_eq!(w.column("run", "target").await, "definitely-not-a-command-zzz --nope", "saved, as create would");
    // create's own refusals still apply: a command needs a pattern
    let e = err(w.cfg(w.w, "run", json!({"pattern":""})).await);
    assert!(e.contains("needs a pattern"), "{e}");
}

/// CE7: a fair_queue target edit is refused while the dog holds an un-ACKed job; after the ACK it is allowed, reach-checked with the editor as setter.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce07_queue_target_edit_needs_no_held_job() {
    let w = world().await;
    w.ack_mode(w.q).await;
    let id = w.queue_dog(w.c, "w", "Q").await.unwrap()["id"].as_str().unwrap().to_string();
    w.post("Q", "held job").await;
    let copy: String = w.e.db.get().await.unwrap().query_one("SELECT uid FROM ot.mail WHERE recipient_agent_id=$1 AND body LIKE '%held job%'", &[&w.w]).await.unwrap().get(0);
    let e = err(w.cfg(w.c, &format!("w/{id}"), json!({"target":"B"})).await);
    assert!(e.contains("ACK or hand back the 1 jobs you hold through this watchdog first"), "{e}");
    let mut ack = crate::domain::mail::Outgoing::new(crate::domain::mail::From::Agent { id: w.w, name: "w".into(), generation: 1 }, "Q", "done");
    ack.reply_to = Some(json!({"id": copy}));
    crate::domain::mail::send(&w.e, w.org.id, ack).await.unwrap();
    w.cfg(w.c, &format!("w/{id}"), json!({"target":"B"})).await.unwrap();
    let bid = w.id("B").await;
    assert_eq!(w.dog(&id).await.2["reach_grant"], json!({"project": bid, "via": "setter", "from": "C"}), "the grant is replaced, not carried over");
    // a project the editor does not reach either is refused
    let e = err(w.cfg(w.c, &format!("w/{id}"), json!({"target":"XQ-nothing"})).await);
    assert!(e.contains("no project named"), "{e}");
}

/// CE8: an ancestor edits fire_actions on a delegated dog: allow-list; actions_by = the editor.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce08_an_ancestor_sets_fire_actions() {
    let w = world().await;
    w.cmd(w.c, "w", "act").await.unwrap();
    let e = err(w.cfg(w.c, "w/act", json!({"fire_actions":[{"tool":"orgtree_work","args":{"action":"list"}}]})).await);
    assert!(e.contains("may use only orgtree_message"), "{e}");
    w.cfg(w.s, "w/act", json!({"fire_actions": say("S", "edited report")})).await.unwrap();
    assert_eq!(w.dog("act").await.2["actions_by"]["name"], "S");
    // S is retired: the fire-time check now uses S, not the creator C
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.s]).await;
    let row = w.dog("act").await.3;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("the setter @S is retired") && mail.contains("limited to what both you and @S"), "{mail}");
    // fire_actions: [] clears them
    w.sql("UPDATE ot.agents SET state='live' WHERE id=$1", &[&w.s]).await;
    w.cfg(w.s, "w/act", json!({"fire_actions": []})).await.unwrap();
    assert!(w.dog("act").await.2.get("fire_actions").is_none_or(|v| v.is_null() || v.as_array().is_some_and(|a| a.is_empty())));
}

/// CE9: the owner edits them itself: actions_by = "owner", no setter check at fire.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce09_the_owner_takes_the_actions_over() {
    let w = world().await;
    w.cmd(w.c, "w", "act").await.unwrap();
    w.cfg(w.w, "act", json!({"fire_actions": say("S", "by the owner")})).await.unwrap();
    assert_eq!(w.dog("act").await.2["actions_by"], "owner");
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.c]).await;
    let row = w.dog("act").await.3;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("Fire actions (run as you, with your current authority):") && mail.contains("orgtree_message: ok"), "{mail}");
}

/// CE15 (rev 1.6): the user's edit of fire_actions is recorded as actions_by "user"; no setter check at fire.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce15_a_user_edit_is_recorded_as_the_user() {
    let w = world().await;
    w.cmd(w.c, "w", "act").await.unwrap();
    configure(&w.e, w.org.id, None, "w/act", &json!({"fire_actions": say("S", "by the user")})).await.unwrap();
    assert_eq!(w.dog("act").await.2["actions_by"], "user");
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.c]).await;
    let row = w.dog("act").await.3;
    w.fire(row, &["go"]).await;
    let mail = w.fire_mail(w.w).await;
    assert!(mail.contains("orgtree_message: ok") && !mail.contains("the setter"), "{mail}");
}

/// CE16 (spec 5 recheck 4, D16): an edit may not turn one project dog into a duplicate of another (the dog itself excepted).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce16_project_dog_duplicates() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}','true') WHERE id=$1", &[&w.p]).await;
    create(&w.e, w.org.id, w.s, &json!({"kind":"command","target":"echo one","pattern":"p","project":"P","name":"one"})).await.unwrap();
    create(&w.e, w.org.id, w.s, &json!({"kind":"command","target":"echo two","pattern":"p","project":"P","name":"two"})).await.unwrap();
    let e = err(w.cfg(w.s, "P/two", json!({"target":"echo one"})).await);
    assert!(e.contains("project P already has this watchdog: P/one; listen to the project instead of adding another"), "{e}");
    assert_eq!(w.column("two", "target").await, "echo two", "nothing written");
    // editing a dog into its own tuple is fine
    w.cfg(w.s, "P/two", json!({"target":"echo two","interval_s":120})).await.unwrap();
    // a pattern edit that makes the pair identical is refused too
    create(&w.e, w.org.id, w.s, &json!({"kind":"command","target":"echo one","pattern":"q","project":"P","name":"three"})).await.unwrap();
    let e = err(w.cfg(w.s, "P/three", json!({"pattern":"p"})).await);
    assert!(e.contains("already has this watchdog: P/one"), "{e}");
}

/// CE17 (spec 5: tier B changes restart a stream): a shell-only edit of a stream dog replaces its process.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce17_a_stream_shell_edit_restarts() {
    let w = world().await;
    w.sql("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,memo) VALUES('strm',$1,$2,'strm','stream','echo hi',5,'paused','{\"run\":{}}'::jsonb)", &[&w.org.id, &w.w]).await;
    let row = w.dog("strm").await.3;
    let dog = load(&w.e, row).await.unwrap().unwrap();
    let plan = edit::plan(&w.e, w.org.id, Some(w.w), &dog, &json!({"shell":"native"})).await.unwrap();
    assert!(plan.restart, "a tier B shell edit restarts the stream: {plan:?}");
    let plan = edit::plan(&w.e, w.org.id, Some(w.w), &dog, &json!({"interval_s": 30})).await.unwrap();
    assert!(!plan.restart, "a tier A edit does not");
}

/// CE18 (spec 5 recheck 1): a project websocket dog's connection edit needs the EDITOR's web tool too, not only the project line's.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce18_project_network_edits_need_the_editors_web() {
    use crate::ws::testserver::{Opts, TestServer};
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}','true') WHERE id=$1", &[&w.p]).await;
    let server = TestServer::start(Opts::default()).await;
    create(&w.e, w.org.id, w.s, &json!({"kind":"websocket","target":server.url("/v1/events"),"project":"P","name":"sock"})).await.unwrap();
    let row = w.dog("sock").await.3;
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('web',false)) WHERE id=$1", &[&w.w]).await;
    let e = err(w.cfg(w.w, "P/sock", json!({"hello":["x"]})).await);
    assert!(e.contains("web tool"), "the editor lacks web: {e}");
    assert_eq!(w.dog("sock").await.2["websocket"]["hello"], json!([]), "nothing written");
    disarm(&w.e, row);
    server.stop();
}

/// Run `first` (a configure or create) paused just after its early checks, run `second` to completion,
/// then release `first`; returns (first, second). The pause is the test-only `race_hook`.
async fn interleave(
    op: &'static str,
    first: impl std::future::Future<Output = Result<Value>> + Send + 'static,
    second: impl std::future::Future<Output = Result<Value>>,
) -> (Result<Value>, Result<Value>) {
    let (reached, release) = race_hook::arm(op);
    let h = tokio::spawn(first);
    tokio::time::timeout(std::time::Duration::from_secs(20), reached.notified()).await.expect("the first call never reached its pause");
    let b = second.await;
    release.notify_one();
    (h.await.unwrap(), b)
}

impl W {
    fn cfg_task(&self, actor: i64, id: &str, edit: Value) -> impl std::future::Future<Output = Result<Value>> + Send + 'static {
        let (e, org, id) = (self.e.clone(), self.org.id, id.to_string());
        async move { configure(&e, org, Some(actor), &id, &edit).await }
    }
    async fn count_where(&self, sql: &str) -> i64 {
        self.e.db.get().await.unwrap().query_one(sql, &[]).await.unwrap().get(0)
    }
    /// two project command dogs `one` and `two` on project P
    async fn two_project_dogs(&self) {
        self.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}','true') WHERE id=$1", &[&self.p]).await;
        for n in ["one", "two"] {
            create(&self.e, self.org.id, self.s, &json!({"kind":"command","target":format!("echo {n}"),"pattern":"p","project":"P","name":n})).await.unwrap();
        }
    }
    /// two fair_queue dogs of C, on projects Q and A (both can be edited onto B); returns their uids in creation order
    async fn two_queue_dogs(&self) -> (String, String) {
        self.queue_dog(self.c, "C", "Q").await.unwrap();
        self.queue_dog(self.c, "C", "A").await.unwrap();
        let r = self.e.db.get().await.unwrap().query("SELECT uid FROM ot.watchdogs WHERE kind='fair_queue' AND owner_agent_id=$1 AND state<>'removed' ORDER BY id", &[&self.c]).await.unwrap();
        (r[0].get(0), r[1].get(0))
    }
}

const D16: &str = "project P already has this watchdog: P/";
const LIMIT: &str = "per agent per project";
const ON_SAME: &str = "SELECT count(*) FROM ot.watchdogs WHERE target='echo same' AND state<>'removed'";
const ON_B: &str = "SELECT count(*) FROM ot.watchdogs WHERE kind='fair_queue' AND target='B' AND state<>'removed'";

fn new_command(w: &W) -> impl std::future::Future<Output = Result<Value>> + Send + 'static {
    let (e, org, s) = (w.e.clone(), w.org.id, w.s);
    async move { create(&e, org, s, &json!({"kind":"command","target":"echo same","pattern":"p","project":"P","name":"three"})).await }
}
fn new_queue(w: &W) -> impl std::future::Future<Output = Result<Value>> + Send + 'static {
    let (e, org, c) = (w.e.clone(), w.org.id, w.c);
    async move { create(&e, org, c, &json!({"kind":"fair_queue","target":"B","owner":"C","notice":true})).await }
}

/// CE19 (D16 through configure, edit vs edit): the first edit is paused after its early check, a second edit writes
/// the same tuple; exactly one wins, the loser is refused with the D16 text and writes nothing.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19_project_edit_vs_edit() {
    let w = world().await;
    w.two_project_dogs().await;
    let first = w.cfg_task(w.s, "P/one", json!({"target":"echo same"}));
    let (a, b) = interleave("configure", first, w.cfg(w.s, "P/two", json!({"target":"echo same"}))).await;
    b.unwrap();
    let e = format!("{:#}", a.expect_err("the paused edit must be refused"));
    assert!(e.contains(D16) && e.contains("two"), "{e}");
    assert_eq!(w.column("one", "target").await, "echo one", "the loser wrote nothing");
    assert_eq!(w.column("two", "target").await, "echo same");
}

/// CE19c (D16, edit vs create): the edit is paused after its early check, a create writes the same tuple first.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19c_project_edit_vs_create() {
    let w = world().await;
    w.two_project_dogs().await;
    let first = w.cfg_task(w.s, "P/one", json!({"target":"echo same"}));
    let (a, b) = interleave("configure", first, new_command(&w)).await;
    b.unwrap();
    let e = format!("{:#}", a.expect_err("the paused edit must be refused"));
    assert!(e.contains(D16) && e.contains("three"), "{e}");
    assert_eq!(w.column("one", "target").await, "echo one");
    assert_eq!(w.count_where(ON_SAME).await, 1);
}

/// CE19d (D16, create vs edit): the create is paused after its early checks, an edit writes the tuple first.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19d_project_create_vs_edit() {
    let w = world().await;
    w.two_project_dogs().await;
    let (a, b) = interleave("create", new_command(&w), w.cfg(w.s, "P/one", json!({"target":"echo same"}))).await;
    b.unwrap();
    let e = format!("{:#}", a.expect_err("the paused create must be refused"));
    assert!(e.contains(D16) && e.contains("one"), "{e}");
    assert_eq!(w.count_where(ON_SAME).await, 1);
}

/// CE19e (per-owner limit through configure, edit vs edit).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19e_owner_edit_vs_edit() {
    let w = world().await;
    let (q, a) = w.two_queue_dogs().await;
    let first = w.cfg_task(w.c, &q, json!({"target":"B"}));
    let (r1, r2) = interleave("configure", first, w.cfg(w.c, &a, json!({"target":"B"}))).await;
    r2.unwrap();
    let e = format!("{:#}", r1.expect_err("the paused edit must be refused"));
    assert!(e.contains(LIMIT), "{e}");
    assert_eq!(w.count_where(ON_B).await, 1);
}

/// CE19f (per-owner limit, edit vs create): the edit is paused, a create takes the slot on B first.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19f_owner_edit_vs_create() {
    let w = world().await;
    let (q, _) = w.two_queue_dogs().await;
    let first = w.cfg_task(w.c, &q, json!({"target":"B"}));
    let (r1, r2) = interleave("configure", first, new_queue(&w)).await;
    r2.unwrap();
    let e = format!("{:#}", r1.expect_err("the paused edit must be refused"));
    assert!(e.contains(LIMIT), "{e}");
    assert_eq!(w.count_where(ON_B).await, 1);
}

/// CE19g (per-owner limit, create vs edit): the create is paused, an edit takes B first.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19g_owner_create_vs_edit() {
    let w = world().await;
    let (q, _) = w.two_queue_dogs().await;
    let (r1, r2) = interleave("create", new_queue(&w), w.cfg(w.c, &q, json!({"target":"B"}))).await;
    r2.unwrap();
    let e = format!("{:#}", r1.expect_err("the paused create must be refused"));
    assert!(e.contains(LIMIT), "{e}");
    assert_eq!(w.count_where(ON_B).await, 1);
}

/// Hold the dog's row lock from outside, start an edit, wait until it blocks on that lock, then try the
/// parent row with NOWAIT: it must already be locked by the edit (parent row first, then the dog row).
async fn parent_locked_before_dog(w: &W, dog_uid: &str, actor: i64, id: &str, edit: Value, parent_row: i64) -> bool {
    let dog_row = w.dog(dog_uid).await.3;
    // a paused dog has no runner polling (and locking) its row, so the only waiter on the holder is the edit
    w.sql("UPDATE ot.watchdogs SET state='paused' WHERE id=$1", &[&dog_row]).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let mut holder = w.e.db.get().await.unwrap();
    let tx = holder.transaction().await.unwrap();
    tx.query_one("SELECT id FROM ot.watchdogs WHERE id=$1 FOR UPDATE", &[&dog_row]).await.unwrap();
    let holder_pid: i32 = tx.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    let task = tokio::spawn(w.cfg_task(actor, id, edit));
    // wait for the backend that THIS holder blocks, and check it is configure's dog-row SELECT ... FOR UPDATE
    // (not an unrelated poller's lock wait)
    let mut blocked = false;
    for _ in 0..200 {
        let n = w.count_where(&format!(
            "SELECT count(*) FROM pg_stat_activity WHERE {holder_pid} = ANY(pg_blocking_pids(pid))              AND query LIKE 'SELECT state, memo FROM ot.watchdogs WHERE id = %' AND query LIKE '%FOR UPDATE'")).await;
        if n > 0 {
            blocked = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !blocked {
        let rows = w.e.db.get().await.unwrap().query(
            "SELECT pid, pg_blocking_pids(pid)::text, wait_event_type, left(query, 120) FROM pg_stat_activity WHERE datname=current_database() AND state='active'", &[]).await.unwrap();
        let dump: Vec<String> = rows.iter().map(|r| format!("{}|{}|{:?}|{}", r.get::<_, i32>(0), r.get::<_, String>(1), r.get::<_, Option<String>>(2), r.get::<_, String>(3))).collect();
        panic!("the edit never blocked on the dog row (waiting on the holder {holder_pid}'s lock); active backends: {dump:#?}");
    }
    let mut probe = w.e.db.get().await.unwrap();
    let ptx = probe.transaction().await.unwrap();
    let locked = ptx.query_one("SELECT id FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE NOWAIT", &[&parent_row]).await.is_err();
    drop(ptx);
    tx.rollback().await.unwrap();
    let _ = task.await;
    locked
}

/// CE19h: configure locks the parent row (project for a project dog, owner for an agent dog) BEFORE the dog row.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce19h_parent_row_is_locked_before_the_dog() {
    let w = world().await;
    w.two_project_dogs().await;
    assert!(parent_locked_before_dog(&w, "one", w.s, "P/one", json!({"interval_s":90}), w.p).await, "a project dog: the project row must be locked first");
    let (q, _) = w.two_queue_dogs().await;
    assert!(parent_locked_before_dog(&w, &q, w.c, &q, json!({"target":"B"}), w.c).await, "an agent dog: the owner row must be locked first");
}

/// CE10: a waiting slot claim is re-admitted at the back; a held lease refuses the edit.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce10_slot_edits() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{slots_capacity}','1') WHERE id=$1", &[&w.q]).await;
    // C takes the only slot (granted inline, so no dog); the delegated claim for w waits
    create(&w.e, w.org.id, w.c, &json!({"kind":"slot","target":"Q","name":"mine"})).await.unwrap();
    let waiting = create(&w.e, w.org.id, w.c, &json!({"kind":"slot","target":"Q","owner":"w","name":"wait"})).await.unwrap();
    let wid = waiting["id"].as_str().unwrap().to_string();
    assert_eq!(w.dog(&wid).await.1, "armed");
    let before: i64 = w.dog(&wid).await.2["queued_at"].as_i64().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    w.cfg(w.c, &format!("w/{wid}"), json!({"slots": 1})).await.unwrap();
    let after: i64 = w.dog(&wid).await.2["queued_at"].as_i64().unwrap();
    assert!(after > before, "re-admitted at the back of the queue");
    // a held lease refuses the edit
    w.sql("UPDATE ot.watchdogs SET memo = memo || '{\"lease\":\"L1\"}'::jsonb WHERE uid=$1", &[&wid]).await;
    let e = err(w.cfg(w.c, &format!("w/{wid}"), json!({"slots": 1})).await);
    assert!(e.contains("release the held slot first (release_slot), then edit") || e.contains("spent"), "{e}");
}

/// CE11: a paused dog stays paused; a spent dog is refused.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce11_states() {
    let w = world().await;
    let (_, _) = w.file_dog("f").await;
    act(&w.e, w.org.id, Some(w.w), "f", "pause", None).await.unwrap();
    w.cfg(w.w, "f", json!({"interval_s": 90})).await.unwrap();
    assert_eq!(w.dog("f").await.1, "paused", "an edit never resumes");
    w.sql("UPDATE ot.watchdogs SET state='spent' WHERE uid='f'", &[]).await;
    let e = err(w.cfg(w.w, "f", json!({"interval_s": 30})).await);
    assert!(e.contains("a spent watchdog cannot be configured"), "{e}");
}

/// CE12: a non-owner edit tells the owner; the event lists field names only.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce12_notice_and_record() {
    let w = world().await;
    w.file_dog("f").await;
    w.cfg(w.c, "w/f", json!({"pattern":"SECRETISH-VALUE"})).await.unwrap();
    assert_eq!(w.mail_with(w.w, "@C changed your watchdog w/f: pattern.").await, 1);
    let detail: Value = w.e.db.get().await.unwrap().query_one("SELECT detail FROM ot.events WHERE op='watchdog_configure' ORDER BY id DESC LIMIT 1", &[]).await.unwrap().get(0);
    assert_eq!(detail["changed"], json!(["pattern"]), "{detail}");
    assert!(!detail.to_string().contains("SECRETISH"), "values are never recorded: {detail}");
    // the owner's own edit tells nobody
    let before = w.mail_with(w.w, "changed your watchdog").await;
    w.cfg(w.w, "f", json!({"interval_s": 75})).await.unwrap();
    assert_eq!(w.mail_with(w.w, "changed your watchdog").await, before);
}

/// CE13: a member edits a project dog's pattern (D4); notice:true on an event-form project dog is refused (D8).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce13_project_dogs() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}','true') WHERE id=$1", &[&w.p]).await;
    create(&w.e, w.org.id, w.s, &json!({"kind":"command","target":"echo hi","pattern":"p1","project":"P","name":"pd"})).await.unwrap();
    w.cfg(w.w, "P/pd", json!({"pattern":"p2"})).await.unwrap();
    assert_eq!(w.column("pd", "pattern").await, "p2");
    let e = err(w.cfg(w.w, "P/pd", json!({"notice": true})).await);
    assert!(e.contains("a project watchdog's fires go to the project's listeners"), "{e}");
}

/// CE20: a configure edit that reuses a dog's stored (unsealed) credentials must not put them in the verbose call log,
/// neither as text nor as the numeric byte array the logger renders an `Option<&[u8]>` argument as.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce20_stored_credentials_never_reach_the_call_log() {
    use crate::ws::testserver::{Opts, TestServer};
    const CANARY: &str = "tok-canary-7q2x9";
    let w = world().await;
    let capture = crate::trace::LogCapture::start().await;
    let need = Opts { require: vec![("authorization".to_string(), format!("Bearer {CANARY}"))], ..Opts::default() };
    let a = TestServer::start(need).await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"websocket","target":a.url("/v1/events"),"name":"sock","credentials":{"bearer":CANARY}})).await.unwrap();
    assert!(a.until(10, |s| s.live() >= 1).await, "connected with the bearer");
    let row = w.dog("sock").await.3;
    // the edit reuses the stored credentials: they are unsealed and handed to the websocket validation
    w.cfg(w.w, "sock", json!({"hello":["hi"]})).await.unwrap();
    disarm(&w.e, row);
    a.stop();
    let log = capture.finish().await;
    assert!(log.contains("validate("), "positive control: the validation call line was logged
{log}");
    assert!(!log.contains(CANARY), "the credential text reached the log");
    let bytes: Vec<String> = CANARY.bytes().map(|b| b.to_string()).collect();
    for sep in [",", ", "] {
        let run = bytes[..6].join(sep);
        assert!(!log.contains(&run), "the credential bytes reached the log as numbers ({run:?})");
    }
}

/// CE14 (rev 1.5 5b): a hello edit reconnects on the STORED credentials; a target edit to another host needs credentials re-supplied.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn ce14_stored_credentials() {
    use crate::ws::testserver::{Opts, TestServer};
    let w = world().await;
    let need = Opts { require: vec![("authorization".to_string(), "Bearer tok-1".to_string())], ..Opts::default() };
    let a = TestServer::start(need.clone()).await;
    let b = TestServer::start(need).await;
    create(&w.e, w.org.id, w.w, &json!({"kind":"websocket","target":a.url("/v1/events"),"name":"sock","credentials":{"bearer":"tok-1"}})).await.unwrap();
    assert!(a.until(10, |s| s.live() >= 1).await, "connected with the bearer");
    let row = w.dog("sock").await.3;
    let dials = a.upgrades();
    w.cfg(w.w, "sock", json!({"hello":["hi"]})).await.unwrap();
    assert!(a.until(10, |s| s.upgrades() > dials).await, "the edit reconnected on the stored credentials");
    let e = err(w.cfg(w.w, "sock", json!({"target": b.url("/v1/events")})).await);
    assert!(e.contains("the new target is a different host; re-supply credentials with this edit (stored ones are never sent to a new host)"), "{e}");
    w.cfg(w.w, "sock", json!({"target": b.url("/v1/events"), "credentials":{"bearer":"tok-1"}})).await.unwrap();
    assert!(b.until(10, |s| s.live() >= 1).await, "now on the new host");
    disarm(&w.e, row);
    a.stop();
    b.stop();
}
