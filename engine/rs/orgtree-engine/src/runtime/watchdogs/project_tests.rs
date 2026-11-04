//! RED tests for project watchdogs (docket
//! `project-watchdogs-a-watchdog-owned-by-a-project-f`; spec rev 1 §8, tests
//! T1-T20). A watchdog owned by a project fires the project's event: every
//! armed `project_listener` receives it; nothing is ever mailed to the project.
//!
//! Synthetic PG fixture in the style of `domain/holdings/db_tests.rs`: no
//! provider, no CLI, no live DB. Each test builds its own disposable `ot`
//! schema, so run them one at a time (`--test-threads=1`) against a throwaway
//! database named and owned `projdogs_fixture`:
//! `ORGTREE_PROJDOGS_TEST_URL` (its URL) and `ORGTREE_PROJDOGS_TEST_ROOT`
//! (an owned engine root). Every listener here is passive (`notice`), so no
//! test starts a turn.
use super::*;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use crate::orgs::OrgHandle;

/// top (bash, web) > boss > project "stream" > member1..3; stranger is top-level.
struct World {
    e: Arc<Engine>,
    org: Arc<OrgHandle>,
    project: i64,
    top: i64,
    boss: i64,
    member: i64,
    stranger: i64,
}

#[nolog]
async fn world() -> World {
    let url = std::env::var("ORGTREE_PROJDOGS_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("projdogs_fixture"));
    assert_eq!(cfg.get_user(), Some("projdogs_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let id: i64 = client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'projdogs-fixture','fixture') RETURNING id", &[]).await.unwrap().get(0);
    let agent = |name: &'static str, parent: Option<i64>| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-03') RETURNING id", &[&id, &name, &parent]).await.unwrap().get::<_, i64>(0)
        }
    };
    let top = agent("top", None).await;
    let boss = agent("boss", Some(top)).await;
    let project: i64 = client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'stream',$2,'project','project','live',$3,'2026-11-03') RETURNING id",
        &[&id, &boss, &json!({"transparent":true})]).await.unwrap().get(0);
    let member = agent("member", Some(project)).await;
    agent("member2", Some(project)).await;
    agent("member3", Some(project)).await;
    let stranger = agent("stranger", None).await;
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_PROJDOGS_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org = crate::orgs::provisional(id, "fixture".into(), "projdogs-fixture".into(), "fixture".into());
    engine.orgs.insert(org.clone());
    World { e: engine, org, project, top, boss, member, stranger }
}

impl World {
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

    /// The project's event-listeners setting, written directly.
    #[nolog]
    async fn listeners_on(&self, on: bool) {
        self.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{event_listeners}',to_jsonb($2::boolean)) WHERE id=$1", &[&self.project, &on]).await;
    }

    /// A project command dog (`echo hi` never matching its pattern, so only the test's own fires happen).
    #[nolog]
    async fn dog_args(name: &str) -> Value {
        json!({"kind":"command","target":"echo hi","pattern":"never-matches-zzz","name":name,"project":"stream","interval_s":3600})
    }

    #[nolog]
    async fn put_dog(&self, caller: i64, name: &str) -> Result<Value> {
        create(&self.e, self.org.id, caller, &Self::dog_args(name).await).await
    }

    /// A passive event listener on the project owned by `agent`, optionally patterned.
    #[nolog]
    async fn listen(&self, agent: i64, pattern: Option<&str>) -> Value {
        let mut a = json!({"kind":"project_listener","target":"stream","notice":true});
        if let Some(p) = pattern { a["pattern"] = json!(p); }
        create(&self.e, self.org.id, agent, &a).await.unwrap()
    }

    /// (owner_kind, owner_agent_id, state, memo, fired) of the project's dog `uid`.
    #[nolog]
    async fn dog(&self, uid: &str) -> (String, Option<i64>, String, Value, i32, i64) {
        let r = self.e.db.get().await.unwrap().query_one("SELECT owner_kind, owner_agent_id, state, memo, fired, id FROM ot.watchdogs WHERE uid=$1 AND state<>'removed' ORDER BY id DESC LIMIT 1", &[&uid]).await.unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5))
    }

    /// Fire a loaded dog the way its runner does.
    #[nolog]
    async fn fire(&self, row: i64, lines: &[&str]) {
        let mut dog = load(&self.e, row).await.unwrap().unwrap();
        let lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        fire(&self.e, &mut dog, &lines, "").await.unwrap();
    }

    /// The watchdog-kind mail bodies a recipient holds.
    #[nolog]
    async fn mail(&self, agent: i64) -> Vec<String> {
        self.e.db.get().await.unwrap().query("SELECT body FROM ot.mail WHERE recipient_agent_id=$1 AND kind='watchdog' ORDER BY id", &[&agent]).await.unwrap()
            .iter().map(|r| r.get(0)).collect()
    }

    /// Passive System notices an agent holds.
    #[nolog]
    async fn notices(&self, agent: i64) -> Vec<String> {
        self.e.db.get().await.unwrap().query("SELECT body FROM ot.mail WHERE recipient_agent_id=$1 AND notice ORDER BY id", &[&agent]).await.unwrap()
            .iter().map(|r| r.get(0)).collect()
    }

    #[nolog]
    async fn op(&self, op: &str, node: &str) {
        crate::domain::ops::run(&self.e, &self.org, crate::domain::ops::Actor::User, &json!({"op":op,"node":node})).await.unwrap();
    }
}

#[nolog]
fn err(r: Result<Value>) -> String {
    format!("{:#}", r.expect_err("expected a refusal"))
}

/// T1 (D1, D3): a member below the project puts a dog on it; the row is the project's.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t01_member_creates_a_project_dog() {
    let w = world().await;
    w.listeners_on(true).await;
    let out = w.put_dog(w.member, "feed").await.unwrap();
    assert_eq!(out["project"], "stream", "{out}");
    assert_eq!(out["handle"], "stream/feed", "{out}");
    let (kind, owner, state, memo, _, _) = w.dog("feed").await;
    assert_eq!((kind.as_str(), owner, state.as_str()), ("project", Some(w.project), "armed"));
    assert_eq!(memo["created_by"]["kind"], "agent");
    assert_eq!(memo["created_by"]["id"], w.member);
    assert_eq!(memo["created_by"]["name"], "member");
}

/// T2 (D4): an ancestor and the user may; an unrelated agent may not, and nothing is inserted.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t02_who_may_create() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "by-boss").await.unwrap();
    let mut other = World::dog_args("by-user").await;
    other["target"] = json!("echo ho");
    create_as(&w.e, w.org.id, None, &other).await.unwrap();
    assert_eq!(w.dog("by-user").await.3["created_by"], json!({"kind":"user"}));
    let before = w.count("SELECT count(*) FROM ot.watchdogs", &[]).await;
    let mut third = World::dog_args("nope").await;
    third["target"] = json!("echo hu");
    let e = err(create(&w.e, w.org.id, w.stranger, &third).await);
    assert!(e.contains("you are neither above nor below project stream, so you cannot put a watchdog on it"), "{e}");
    assert_eq!(before, w.count("SELECT count(*) FROM ot.watchdogs", &[]).await, "a refused create inserts nothing");
}

/// T3 (D9, D10, D11): a fire reaches each armed reaching listener once, never the project.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t03_a_fire_goes_to_the_listeners_and_never_to_the_project() {
    let w = world().await;
    let (m1, m2, m3) = (w.member, w.id("member2").await, w.id("member3").await);
    for a in [m1, m2, m3] { w.listen(a, None).await; }
    // a listener whose owner does not reach the project (moved out of its line)
    w.sql("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,memo) VALUES('far',$1,$2,'far','project_listener','stream',600,'armed',jsonb_build_object('target_id',$3::bigint,'notice',true))",
        &[&w.org.id, &w.stranger, &w.project]).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    // m3's listener is paused; the stranger's would not reach
    w.sql("UPDATE ot.watchdogs SET state='paused' WHERE owner_agent_id=$1 AND kind='project_listener'", &[&m3]).await;
    w.fire(row, &["hello from the feed"]).await;
    assert_eq!(w.count("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1", &[&w.project]).await, 0, "no mail to the project");
    for a in [m1, m2] {
        let mail = w.mail(a).await;
        assert_eq!(mail.len(), 1, "{mail:?}");
        assert!(mail[0].contains("watchdog @stream/feed (\"feed\", command · echo hi) fired the event on project @stream"), "{}", mail[0]);
        assert!(mail[0].contains("hello from the feed"), "{}", mail[0]);
    }
    assert!(w.mail(m3).await.is_empty(), "a paused listener gets nothing");
    let src = w.e.db.get().await.unwrap().query_one("SELECT source FROM ot.project_fires WHERE project_id=$1", &[&w.project]).await.unwrap().get::<_, Value>(0);
    assert_eq!(src["kind"], "watchdog");
    assert_eq!(src["dog"], "feed");
}

/// T4 (D10): with no armed listener the dog fires but nothing is kept.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t04_zero_listeners_record_nothing() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let (_, _, _, _, _, row) = w.dog("feed").await;
    w.fire(row, &["x"]).await;
    assert_eq!(w.dog("feed").await.4, 1, "the dog's own fire counted");
    assert_eq!(w.count("SELECT count(*) FROM ot.project_fires WHERE project_id=$1", &[&w.project]).await, 0);
    assert_eq!(w.count("SELECT count(*) FROM ot.project_event_dispatch", &[]).await, 0);
    let gist: String = w.e.db.get().await.unwrap().query_one("SELECT events->-1->>'gist' FROM ot.watchdogs WHERE id=$1", &[&row]).await.unwrap().get(0);
    assert!(gist.ends_with("(no listeners armed)"), "{gist}");
}

/// T5 (D14): the event-listeners setting decides whether the dog is armed.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t05_the_setting_off_pauses_the_dog() {
    let w = world().await;
    let out = w.put_dog(w.boss, "feed").await.unwrap();
    let (_, _, state, memo, _, row) = w.dog("feed").await;
    assert_eq!(state, "paused");
    assert_eq!(memo[crate::domain::listeners::OFF_MARK], true);
    let why = "project stream's event listeners are off; this watchdog arms when they are turned on (registering a listener turns them on)";
    assert_eq!(memo["paused_why"], why);
    assert!(out["note"].as_str().unwrap_or("").contains(why), "{out}");
    let e = err(act(&w.e, w.org.id, Some(w.boss), "stream/feed", "resume", None).await);
    assert!(e.contains("project stream's event listeners are off; a superior can turn them on in its settings, or registering a listener turns them on"), "{e}");
    w.listen(w.member, None).await; // registering a listener switches the setting on
    assert_eq!(w.dog("feed").await.2, "armed");
    let mut c = w.e.db.get().await.unwrap();
    let tx = c.transaction().await.unwrap();
    crate::domain::listeners::switch_off(&tx, w.project, "boss").await.unwrap();
    tx.commit().await.unwrap();
    let (_, _, state, memo, _, _) = w.dog("feed").await;
    assert_eq!((state.as_str(), &memo[crate::domain::listeners::OFF_MARK]), ("paused", &json!(true)));
    let _ = row;
}

/// T6 (D7): every other kind stays on an agent.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t06_other_kinds_are_refused() {
    let w = world().await;
    for kind in ["event", "usage", "activity", "fair_queue", "slot", "project_listener", "listener_watch", "app_listener"] {
        let e = err(create(&w.e, w.org.id, w.boss, &json!({"kind":kind,"target":"stream","project":"stream","count":1})).await);
        assert!(e.contains(&format!("a project watchdog can be file, command, process, stream, websocket or mqtt; {kind} stays on an agent")), "{kind}: {e}");
    }
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE owner_kind='project'", &[]).await, 0);
}

/// T7 (D8): the options with no agent to serve are refused.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t07_notice_and_fire_actions_are_refused() {
    let w = world().await;
    let mut a = World::dog_args("feed").await;
    a["notice"] = json!(true);
    let e = err(create(&w.e, w.org.id, w.boss, &a).await);
    assert!(e.contains("a project watchdog's fires go to the project's listeners; each listener's own notice flag decides whether it wakes"), "{e}");
    let mut a = World::dog_args("feed").await;
    a["fire_actions"] = json!([{"tool":"orgtree_chart","args":{}}]);
    let e = err(create(&w.e, w.org.id, w.boss, &a).await);
    assert!(e.contains("fire_actions run as an agent; put them on your project_listener instead"), "{e}");
}

/// T8 (D5): the caller's hands at create, the project's at run time.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t08_hands() {
    let w = world().await;
    // a member without bash cannot borrow the project's
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('bash',false)) WHERE id=$1", &[&w.member]).await;
    let e = err(w.put_dog(w.member, "feed").await);
    assert!(e.contains("bash"), "{e}");
    // top holds bash but the project's line (boss) does not
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('bash',false)) WHERE id=$1", &[&w.boss]).await;
    let e = err(w.put_dog(w.top, "feed").await);
    assert!(e.contains("project stream's line does not hold bash/web/that folder, so a watchdog on it could not run"), "{e}");
    // created while the line held bash, then the line loses it at run time
    w.sql("UPDATE ot.agents SET scope='{}'::jsonb WHERE id=$1 OR id=$2", &[&w.boss, &w.member]).await;
    w.listeners_on(true).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('bash',false)) WHERE id=$1", &[&w.boss]).await;
    let dog = load(&w.e, row).await.unwrap().unwrap();
    assert_eq!(authority_lost(&w.e, &dog).await.unwrap(), Some(NO_BASH));
    poll_once(&w.e, dog).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "paused");
    assert!(w.notices(w.member).await.iter().any(|b| b.contains("feed")), "the keeper (the live creator) is told, passively");
}

/// T9 (D12, D13): the creator retires; the dog stays and keeper notices go up the line.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t09_the_creator_retires() {
    let w = world().await;
    w.listeners_on(true).await;
    w.listen(w.id("member2").await, None).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.member]).await;
    assert_eq!(w.dog("feed").await.2, "armed");
    w.fire(row, &["still firing"]).await;
    assert_eq!(w.mail(w.id("member2").await).await.len(), 1);
    // an alert about the dog goes to the live superior of the project
    let dog = load(&w.e, row).await.unwrap().unwrap();
    let lost = Lost { why: "broken", headline: "its target could not be run at all".into(), advice: "fix it", pause: false };
    alert(&w.e, &dog, &lost).await.unwrap();
    assert!(w.notices(w.boss).await.iter().any(|b| b.contains("went quiet")), "the keeper is the project's live superior");
    assert_eq!(w.count("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1", &[&w.project]).await, 0);
}

/// T10 (D13): project retire pauses its dogs, restore re-arms, delete removes.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t10_project_retire_restore_delete() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    w.op("retire", "stream").await;
    let (_, _, state, memo, _, _) = w.dog("feed").await;
    assert_eq!((state.as_str(), memo["paused_why"].as_str()), ("paused", Some(ARCHIVE_PAUSE)));
    w.op("rehire", "stream").await;
    assert_eq!(w.dog("feed").await.2, "armed", "restore re-arms the project's dogs");
    w.op("retire", "stream").await;
    w.op("delete", "stream").await;
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE owner_kind='project' AND state<>'removed'", &[]).await, 0);
}

/// T11 (D13): an engine start arms armed project dogs.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t11_restart_arms_project_dogs() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    disarm(&w.e, row);
    arm_armed(&w.e).await.unwrap();
    assert!(w.e.dogs.runners.pin().get(&row).is_some_and(|t| !t.is_cancelled()), "an armed dog of a live project is armed at start");
}

/// T12 (D16): one connection per project; a different hello is a different feed.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t12_duplicates() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let e = err(w.put_dog(w.member, "feed-again").await);
    assert!(e.contains("project stream already has this watchdog: stream/feed; listen to the project instead of adding another"), "{e}");
    let (a, b) = tokio::join!(w.put_dog(w.boss, "race-a2"), w.put_dog(w.member, "race-b2"));
    assert!(a.is_err() && b.is_err(), "both duplicate the armed feed");
    let mut other = World::dog_args("other").await;
    other["pattern"] = json!("ho");
    other["target"] = json!("echo ho");
    let mut other2 = other.clone();
    other2["name"] = json!("other2");
    let (x, y) = tokio::join!(create(&w.e, w.org.id, w.boss, &other), create(&w.e, w.org.id, w.member, &other2));
    assert_eq!(x.is_ok() as u8 + y.is_ok() as u8, 1, "two concurrent identical creates: exactly one succeeds");
}

/// T13 (D4): management by the reaching set and the user only.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t13_management() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    act(&w.e, w.org.id, Some(w.member), "stream/feed", "pause", None).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "paused");
    let e = err(act(&w.e, w.org.id, Some(w.stranger), "stream/feed", "resume", None).await);
    assert!(e.contains("only agents above or below project stream manage its watchdogs"), "{e}");
    act(&w.e, w.org.id, Some(w.member), "stream/feed", "resume", None).await.unwrap();
    act(&w.e, w.org.id, None, "stream/feed", "pause", None).await.unwrap();
    act(&w.e, w.org.id, None, "stream/feed", "resume", None).await.unwrap();
    act(&w.e, w.org.id, Some(w.member), "stream/feed", "remove", None).await.unwrap();
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE uid='feed' AND state<>'removed'", &[]).await, 0);
}

/// T15 (D17): a listener's pattern filters the event text, manual fires included.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t15_listener_pattern() {
    let w = world().await;
    let (plain, picky) = (w.member, w.id("member2").await);
    w.listen(plain, None).await;
    w.listen(picky, Some("donation")).await;
    crate::domain::listeners::fire(&w.e, w.org.id, w.project, "@boss", Some("a chat line")).await.unwrap();
    crate::domain::listeners::fire(&w.e, w.org.id, w.project, "@boss", Some("a donation arrived")).await.unwrap();
    assert_eq!(w.mail(plain).await.len(), 2);
    let got = w.mail(picky).await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(got[0].contains("donation"));
    let fired: i32 = w.e.db.get().await.unwrap().query_one("SELECT fired FROM ot.watchdogs WHERE owner_agent_id=$1 AND kind='project_listener'", &[&picky]).await.unwrap().get(0);
    assert_eq!(fired, 1, "a non-match does not count on the listener");
    let first = w.e.db.get().await.unwrap().query_one("SELECT jsonb_array_length(listeners) FROM ot.project_fires ORDER BY id LIMIT 1", &[]).await.unwrap().get::<_, i32>(0);
    assert_eq!(first, 1, "the history of a fire lists only the listeners it reached");
    // a listener_watch counts an armed listener whatever its pattern
    assert_eq!(crate::domain::listeners::armed_count(&**w.e.db.get().await.unwrap(), w.org.id, w.project).await.unwrap(), 2);
}

/// T16 (D10): a watchdog body is cut at a newline below 20,000 characters; a manual fire still refuses over 8,000.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t16_message_cap() {
    let w = world().await;
    w.listen(w.member, None).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    let line = format!("{}\n", "x".repeat(99));
    let big = line.repeat(300);
    w.fire(row, &[big.as_str()]).await;
    let body = w.mail(w.member).await.pop().unwrap();
    assert!(body.contains("… truncated: this fire's text exceeded 20000 characters"), "{}", &body[body.len().saturating_sub(300)..]);
    assert!(body.chars().count() < 21_000);
    let e = crate::domain::listeners::fire(&w.e, w.org.id, w.project, "@boss", Some(&"y".repeat(8001))).await.unwrap_err();
    assert!(format!("{e:#}").contains("at most 8000"));
}

/// T17 (D18): the engine event carries its source and never the text.
#[test]
#[nolog]
fn t17_project_event_payload() {
    let src = json!({"kind":"watchdog","dog":"feed","dog_kind":"command"});
    let ev = crate::domain::listeners::project_event_payload("stream", 7, "stream/feed", 2, 9, true, Some(&src));
    assert_eq!(ev["source"], "watchdog");
    assert_eq!(ev["dog"], "stream/feed");
    assert_eq!(ev["dog_kind"], "command");
    assert_eq!(ev["has_message"], true);
    assert!(ev.get("message").is_none(), "never the message text");
    let manual = crate::domain::listeners::project_event_payload("stream", 7, "@boss", 2, 9, false, None);
    assert_eq!(manual["source"], "manual");
    assert!(manual.get("dog").is_none());
}

/// T18 (§7): the trigger enforces D2; the migration is idempotent and retires a seeded breach.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t18_migration() {
    let w = world().await;
    let cfg: tokio_postgres::Config = std::env::var("ORGTREE_PROJDOGS_TEST_URL").unwrap().parse().unwrap();
    let (mut c, conn) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = conn.await; });
    for (kind, owner) in [("agent", w.project), ("project", w.member)] {
        let r = c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,owner_kind,name,kind,target,interval_s,state,memo) VALUES('bad',$1,$2,$3,'bad','command','x',60,'armed','{}')",
            &[&w.org.id, &owner, &kind]).await;
        assert!(r.is_err(), "owner_kind {kind} on a mismatching owner row is rejected");
    }
    // seed a pre-migration breach (an agent dog owned by a project row), then re-run the migration
    c.batch_execute("DROP TRIGGER IF EXISTS watchdog_owner_kind_agrees ON ot.watchdogs").await.unwrap();
    c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,owner_kind,name,kind,target,interval_s,state,memo) VALUES('breach',$1,$2,'agent','breach','command','x',60,'armed','{}')",
        &[&w.org.id, &w.project]).await.unwrap();
    c.batch_execute("DELETE FROM public.ot_migrations WHERE name LIKE '%project_watchdogs%'").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap(); // a second run changes nothing
    let state: String = c.query_one("SELECT state FROM ot.watchdogs WHERE uid='breach'", &[]).await.unwrap().get(0);
    assert_eq!(state, "removed");
}

/// T19 (D9): `deliver` never mails a project.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t19_deliver_guard() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let dog = load(&w.e, w.dog("feed").await.5).await.unwrap().unwrap();
    deliver(&w.e, &dog, "body".into(), None).await;
    assert_eq!(w.count("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1", &[&w.project]).await, 0);
}

/// T20 (§3): list shows a manager its projects' dogs and a member the project's.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t20_list() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let all = list(&w.e, w.boss, &json!({})).await.unwrap();
    let d = all["watchdogs"].as_array().unwrap().iter().find(|d| d["id"] == "feed").expect("a manager sees the project's dog");
    assert_eq!((d["owner_kind"].as_str(), d["created_by"].as_str(), d["handle"].as_str()), (Some("project"), Some("member"), Some("stream/feed")));
    let scoped = list(&w.e, w.member, &json!({"project":"stream"})).await.unwrap();
    assert_eq!(scoped["watchdogs"].as_array().unwrap().len(), 1);
    let e = err(list(&w.e, w.stranger, &json!({"project":"stream"})).await);
    assert!(e.contains("neither above nor below"), "{e}");
}

/// T14 (D6): a reaching agent holding web sends on a project websocket dog and the server gets
/// it; one without the web tool, or one that does not reach the project, is refused.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t14_send_on_a_project_websocket_dog() {
    use crate::ws::testserver::{Opts, TestServer};
    let w = world().await;
    w.listeners_on(true).await;
    let server = TestServer::start(Opts::default()).await;
    let url = server.url("/v1/events");
    let out = create(&w.e, w.org.id, w.boss, &json!({"kind":"websocket","target":url,"name":"sock","project":"stream"})).await.unwrap();
    assert_eq!(out["handle"], "stream/sock", "{out}");
    assert!(server.until(10, |s| s.live() >= 1).await, "the project's one connection is up");
    let row = w.dog("sock").await.5;
    for _ in 0..50 {
        if w.e.dogs.ws.link(row).is_some() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(w.e.dogs.ws.link(row).is_some(), "the dog's runner holds the live connection");
    // a member below the project, holding web, writes on it
    let sent = send(&w.e, w.org.id, Some(w.member), "stream/sock", &json!({"message":"hello from a member"})).await.unwrap();
    assert_eq!(sent["sent"], true, "{sent}");
    assert!(server.until(5, |s| s.got().iter().any(|(_, t)| t == "hello from a member")).await, "the server received it");
    // without the web tool: refused, nothing sent
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('tools',jsonb_build_object('web',false)) WHERE id=$1", &[&w.member]).await;
    let e = err(send(&w.e, w.org.id, Some(w.member), "stream/sock", &json!({"message":"blocked"})).await);
    assert!(e.contains("web tool"), "{e}");
    // an agent that does not reach the project may not even resolve the dog
    let e = err(send(&w.e, w.org.id, Some(w.stranger), "stream/sock", &json!({"message":"blocked"})).await);
    assert!(e.contains("only agents above or below project stream manage its watchdogs"), "{e}");
    assert!(!server.got().iter().any(|(_, t)| t == "blocked"));
    disarm(&w.e, row);
    server.stop();
}

/// T21 (D19): a template export skips project dogs and says how many.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn t21_templates_skip_project_dogs() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    // an agent dog stays in the template
    create(&w.e, w.org.id, w.boss, &json!({"kind":"command","target":"echo hi","pattern":"zzz-never","name":"mine","interval_s":3600})).await.unwrap();
    let include: crate::domain::templates::Include = serde_json::from_value(json!({"watchdogs": true})).unwrap();
    let mut root = json!({});
    crate::domain::template_links::capture(&w.e, w.org.id, &[], &include, &mut root).await.unwrap();
    let saved: Vec<String> = root["watchdogs"].as_array().cloned().unwrap_or_default().iter().filter_map(|d| d["name"].as_str().map(str::to_string)).collect();
    assert!(!saved.iter().any(|n| n == "feed"), "the project's dog is not exported: {saved:?}");
    let warnings = root["warnings"].to_string();
    assert!(warnings.contains("project watchdogs are not included in templates yet (1 skipped)"), "{warnings}");
}

/// Review 1 (D5): the CALLER must hold a credentials path too, not only the project.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r1_the_caller_must_hold_the_credentials_path() {
    let w = world().await;
    w.listeners_on(true).await;
    let dir = std::path::PathBuf::from(std::env::var("ORGTREE_PROJDOGS_TEST_ROOT").unwrap()).join("secret-dir");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("creds.json");
    std::fs::write(&file, r#"{"bearer":"x"}"#).unwrap();
    // the project's line (boss) holds the folder; the member below does not
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('add_dirs',jsonb_build_array(jsonb_build_object('path',$2::text,'mode','rw'))) WHERE id=$1",
        &[&w.boss, &dir.to_string_lossy().to_string()]).await;
    let e = err(create(&w.e, w.org.id, w.member, &json!({"kind":"websocket","target":"ws://127.0.0.1:9/x","name":"leak","project":"stream","credentials":file.to_string_lossy()})).await);
    assert!(e.contains("folder"), "a member without the folder is refused: {e}");
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE uid='leak'", &[]).await, 0);
}

/// Review 2: after listeners go off and on, a dog with NO keeper is armed again (runner running).
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r2_switch_on_arms_a_dog_without_a_keeper() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    // no creator, no live superior: no keeper
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=ANY($1)", &[&vec![w.member, w.boss, w.top]]).await;
    let req = |on: bool| json!({"op":"set_event_listeners","node":"stream","enabled":on});
    crate::domain::ops::run(&w.e, &w.org, crate::domain::ops::Actor::User, &req(false)).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "paused");
    disarm(&w.e, row);
    crate::domain::ops::run(&w.e, &w.org, crate::domain::ops::Actor::User, &req(true)).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "armed");
    for _ in 0..30 {
        if w.e.dogs.runners.pin().get(&row).is_some_and(|t| !t.is_cancelled()) { return; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("the re-armed project dog has no runner");
}

/// Review 4: a silence dog re-armed by a switch-on does not fire WENT QUIET straight away.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r4_switch_on_resets_silence_timing() {
    let w = world().await;
    w.listeners_on(true).await;
    let mut a = World::dog_args("quiet").await;
    a["fire_mode"] = json!("silence");
    a["quiet_period_s"] = json!(600);
    create(&w.e, w.org.id, w.boss, &a).await.unwrap();
    let row = w.dog("quiet").await.5;
    w.sql("UPDATE ot.watchdogs SET next_silence_at = now() - interval '1 hour', silence_since = now() - interval '2 hours' WHERE id=$1", &[&row]).await;
    let req = |on: bool| json!({"op":"set_event_listeners","node":"stream","enabled":on});
    crate::domain::ops::run(&w.e, &w.org, crate::domain::ops::Actor::User, &req(false)).await.unwrap();
    crate::domain::ops::run(&w.e, &w.org, crate::domain::ops::Actor::User, &req(true)).await.unwrap();
    assert_eq!(w.count("SELECT count(*) FROM ot.watchdogs WHERE id=$1 AND next_silence_at > now()", &[&row]).await, 1, "the quiet clock restarts");
}

/// Review 5: a stream exit with nobody listening does not rewrite the previous fire's ring entry.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r5_stream_exit_leaves_the_previous_ring_entry_alone() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    w.sql("UPDATE ot.watchdogs SET events=jsonb_build_array(jsonb_build_object('at','2026-11-03T00:00:00Z','gist','earlier fire')) WHERE id=$1", &[&row]).await;
    let dog = load(&w.e, row).await.unwrap().unwrap();
    fire_exited(&w.e, &dog, &["exit 1".to_string()]).await.unwrap();
    let gist: String = w.e.db.get().await.unwrap().query_one("SELECT events->-1->>'gist' FROM ot.watchdogs WHERE id=$1", &[&row]).await.unwrap().get(0);
    assert_eq!(gist, "earlier fire");
}

/// Review 6: the keeper learns when a project dog disables itself because listeners are off.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r6_the_keeper_is_told_of_a_listeners_off_disable() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    disarm(&w.e, row);
    w.listeners_on(false).await;
    let dog = load(&w.e, row).await.unwrap().unwrap();
    run(&w.e, dog, &CancellationToken::new(), false).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "paused");
    assert!(w.notices(w.member).await.iter().any(|b| b.contains("stream/feed") && b.contains("event listeners are off")), "{:?}", w.notices(w.member).await);
}

/// Review 7 (A6): keeper notices name the project and the dog's handle.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r7_keeper_notice_wording() {
    let w = world().await;
    w.listeners_on(true).await;
    w.put_dog(w.member, "feed").await.unwrap();
    let dog = load(&w.e, w.dog("feed").await.5).await.unwrap().unwrap();
    pause(&w.e, &dog, "its owner no longer holds bash").await.unwrap();
    let n = w.notices(w.member).await.join("\n");
    assert!(n.contains("Project stream's watchdog stream/feed (\"feed\") was paused"), "{n}");
    assert!(n.contains("You get this as its keeper: its creator, or the nearest live agent above project stream."), "{n}");
}

/// Review 9 (D16): a trailing slash or a different case of scheme/host is the same feed.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r9_duplicate_urls_are_normalised() {
    use crate::ws::testserver::{Opts, TestServer};
    let w = world().await;
    w.listeners_on(true).await;
    let server = TestServer::start(Opts::default()).await;
    let url = server.url("/feed");
    create(&w.e, w.org.id, w.boss, &json!({"kind":"websocket","target":url,"name":"one","project":"stream"})).await.unwrap();
    let again = url.replacen("ws://", "WS://", 1).replacen("127.0.0.1", "127.0.0.1", 1) + "/";
    let e = err(create(&w.e, w.org.id, w.member, &json!({"kind":"websocket","target":again,"name":"two","project":"stream"})).await);
    assert!(e.contains("already has this watchdog"), "{e}");
    server.stop();
}

/// Review follow-up (D5): a RELATIVE credentials path is judged against the project's folder,
/// the base the running dog reads it from, not the caller's own folder.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r10_relative_credentials_are_checked_against_the_project_folder() {
    let w = world().await;
    w.listeners_on(true).await;
    let dir = std::path::PathBuf::from(std::env::var("ORGTREE_PROJDOGS_TEST_ROOT").unwrap()).join("project-folder");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("creds.json"), r#"{"bearer":"x"}"#).unwrap();
    // the project's folder is held by its line (boss) only
    w.sql("UPDATE ot.agents SET scratch_dir=$2 WHERE id=$1", &[&w.project, &dir.to_string_lossy().to_string()]).await;
    w.sql("UPDATE ot.agents SET scope=jsonb_build_object('add_dirs',jsonb_build_array(jsonb_build_object('path',$2::text,'mode','rw'))) WHERE id=$1",
        &[&w.boss, &dir.to_string_lossy().to_string()]).await;
    let e = err(create(&w.e, w.org.id, w.member, &json!({"kind":"websocket","target":"ws://127.0.0.1:9/x","name":"rel","project":"stream","credentials":"creds.json"})).await);
    assert!(e.contains("folder"), "{e}");
}

/// Review follow-up (§5.4): a fire's recorded source says whether its dog is gone.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn r11_history_says_whether_the_source_dog_is_gone() {
    let w = world().await;
    w.listen(w.member, None).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["one"]).await;
    let c = w.e.db.get().await.unwrap();
    let h = crate::domain::listeners::history(&**c, w.project, None).await.unwrap();
    assert_eq!(h["history"][0]["source"]["gone"], false, "{h}");
    drop(c);
    act(&w.e, w.org.id, None, "stream/feed", "remove", None).await.unwrap();
    let c = w.e.db.get().await.unwrap();
    let h = crate::domain::listeners::history(&**c, w.project, None).await.unwrap();
    assert_eq!(h["history"][0]["source"]["gone"], true, "{h}");
}

// ---------------------------------------------------------------- delivery forms (spec rev 2.1 §13, PF1-PF17)

const BROADCAST_LINE: &str = "watchdog @stream/feed (\"feed\", command · echo hi) broadcast to the members of project @stream";
const QUEUE_LINE: &str = "watchdog @stream/feed (\"feed\", command · echo hi) queued a job on project @stream";

impl World {
    /// A project command dog in `form` created by `caller` (extra members merged into the args).
    #[nolog]
    async fn form_dog(&self, caller: i64, name: &str, form: &str, extra: Value) -> Result<Value> {
        let mut a = Self::dog_args(name).await;
        a["project_delivery"] = json!(form);
        if let Value::Object(x) = extra {
            for (k, v) in x { a[k.as_str()] = v; }
        }
        create(&self.e, self.org.id, caller, &a).await
    }

    /// The last ring gist of the dog's row.
    #[nolog]
    async fn gist(&self, row: i64) -> String {
        self.e.db.get().await.unwrap().query_one("SELECT events->-1->>'gist' FROM ot.watchdogs WHERE id=$1", &[&row]).await.unwrap().get(0)
    }

    /// (uid, state, body, extra) of every mail sitting in the project's own mailbox.
    #[nolog]
    async fn jobs(&self) -> Vec<(String, String, String, Value)> {
        self.e.db.get().await.unwrap().query("SELECT uid, state, body, extra FROM ot.mail WHERE recipient_agent_id=$1 ORDER BY id", &[&self.project]).await.unwrap()
            .iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect()
    }

    /// A passive fair_queue listener on the project owned by `agent`.
    #[nolog]
    async fn worker(&self, agent: i64) -> Value {
        create(&self.e, self.org.id, agent, &json!({"kind":"fair_queue","target":"stream","notice":true})).await.unwrap()
    }

    /// Mail an agent holds whose body contains `needle`.
    #[nolog]
    async fn mail_with(&self, agent: i64, needle: &str) -> i64 {
        self.count("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=$1 AND body LIKE '%'||$2||'%'", &[&agent, &needle]).await
    }
}

/// PF1 (F4): a broadcast dog mails each live agent directly under the project once, and nobody else.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf01_broadcast_reaches_direct_members_only() {
    let w = world().await;
    w.listeners_on(true).await;
    // a nested project with its own agent: not walked
    let sub: i64 = w.e.db.get().await.unwrap().query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'sub',$2,'project','project','live','{\"transparent\":true}','2026-11-04') RETURNING id", &[&w.org.id, &w.project]).await.unwrap().get(0);
    w.sql("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'deep',$2,'sol','live','2026-11-04')", &[&w.org.id, &sub]).await;
    let (m2, m3, deep) = (w.id("member2").await, w.id("member3").await, w.id("deep").await);
    w.form_dog(w.boss, "feed", "broadcast", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["hello"]).await;
    for a in [w.member, m2, m3] {
        let mail = w.mail(a).await;
        assert_eq!(mail.len(), 1, "{mail:?}");
        assert!(mail[0].contains(BROADCAST_LINE), "{}", mail[0]);
        assert!(mail[0].contains("hello"), "{}", mail[0]);
    }
    assert!(w.mail(deep).await.is_empty(), "a nested project's agent gets nothing");
    assert!(w.mail(w.boss).await.is_empty() && w.mail(w.project).await.is_empty());
    assert_eq!(w.count("SELECT count(*) FROM ot.project_fires WHERE project_id=$1", &[&w.project]).await, 0, "a broadcast is not a project event");
}

/// PF2 (F4): no direct agent members means no mail and a gist saying so.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf02_broadcast_with_no_members() {
    let w = world().await;
    w.sql("UPDATE ot.agents SET state='archived' WHERE parent_id=$1 AND kind='agent'", &[&w.project]).await;
    w.form_dog(w.boss, "feed", "broadcast", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["x"]).await;
    assert_eq!(w.count("SELECT count(*) FROM ot.mail WHERE kind='watchdog'", &[]).await, 0);
    assert!(w.gist(row).await.ends_with(" (no members)"), "{}", w.gist(row).await);
}

/// PF3 (F4, D8): `notice:true` makes the broadcast passive; event and queue still refuse it.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf03_broadcast_notice_is_passive_and_other_forms_still_refuse_it() {
    let w = world().await;
    w.listeners_on(true).await;
    w.form_dog(w.boss, "feed", "broadcast", json!({"notice":true})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["x"]).await;
    let passive: Vec<bool> = w.e.db.get().await.unwrap().query("SELECT notice FROM ot.mail WHERE recipient_agent_id=$1 AND kind='watchdog'", &[&w.member]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(passive, vec![true]);
    // default (notice omitted) wakes
    let mut again = World::dog_args("loud").await;
    again["project_delivery"] = json!("broadcast");
    again["target"] = json!("echo ho");
    create(&w.e, w.org.id, w.boss, &again).await.unwrap();
    let loud = w.dog("loud").await.5;
    w.fire(loud, &["y"]).await;
    let flags: Vec<bool> = w.e.db.get().await.unwrap().query("SELECT notice FROM ot.mail WHERE recipient_agent_id=$1 AND kind='watchdog' AND body LIKE '%loud%' ORDER BY id", &[&w.member]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(flags, vec![false], "an omitted notice wakes");
    for form in ["event", "queue"] {
        let e = err(w.form_dog(w.boss, &format!("n-{form}"), form, json!({"notice":true, "target": format!("echo {form}")})).await);
        assert!(e.contains("a project watchdog's fires go to the project's listeners; each listener's own notice flag decides whether it wakes"), "{form}: {e}");
    }
}

/// PF4 (F7): a member below the project may not pick broadcast, at create or at configure.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf04_only_the_user_or_an_agent_above_picks_broadcast() {
    let w = world().await;
    w.listeners_on(true).await;
    let text = "only the user or an agent above project stream may make its watchdog broadcast to the project's members";
    let e = err(w.form_dog(w.member, "feed", "broadcast", json!({})).await);
    assert!(e.contains(text), "{e}");
    w.form_dog(w.boss, "mine", "event", json!({"target":"echo a"})).await.unwrap();
    let e = err(configure(&w.e, w.org.id, Some(w.member), "stream/mine", &json!({"project_delivery":"broadcast"})).await);
    assert!(e.contains(text), "{e}");
    assert_eq!(w.dog("mine").await.3["project_delivery"], "event", "the refused configure changed nothing");
    // the user and an agent above may
    let mut a = World::dog_args("byuser").await;
    a["project_delivery"] = json!("broadcast");
    a["target"] = json!("echo u");
    create_as(&w.e, w.org.id, None, &a).await.unwrap();
    configure(&w.e, w.org.id, Some(w.boss), "stream/mine", &json!({"project_delivery":"broadcast"})).await.unwrap();
    assert_eq!(w.dog("mine").await.3["project_delivery"], "broadcast");
}

/// PF5 (F5): a queue dog puts one job in the project's mailbox, handed to the fair_queue listener; no project event.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf05_queue_makes_one_job_handed_to_the_listener() {
    let w = world().await;
    w.listeners_on(true).await;
    w.worker(w.member).await;
    w.form_dog(w.boss, "feed", "queue", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["hello"]).await;
    let jobs = w.jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert!(jobs[0].2.contains(QUEUE_LINE) && jobs[0].2.contains("hello"), "{}", jobs[0].2);
    assert_ne!(jobs[0].1, "pending", "the listener took it: {}", jobs[0].1);
    assert_eq!(w.mail_with(w.member, QUEUE_LINE).await, 1, "the worker holds its copy");
    assert_eq!(w.count("SELECT count(*) FROM ot.project_fires WHERE project_id=$1", &[&w.project]).await, 0);
    let from: String = w.e.db.get().await.unwrap().query_one("SELECT sender FROM ot.mail WHERE recipient_agent_id=$1", &[&w.project]).await.unwrap().get(0);
    assert!(from.contains("feed"), "sent as the watchdog: {from}");
}

/// PF6 (F5): in ACK mode the job is claimed; acking it sends nothing back; a reply to the dog is refused.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf06_queue_ack_mode() {
    let w = world().await;
    w.listeners_on(true).await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{mail_queue}','\"ack\"') WHERE id=$1", &[&w.project]).await;
    w.worker(w.member).await;
    w.form_dog(w.boss, "feed", "queue", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["hello"]).await;
    let jobs = w.jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0].3["claimed"]["ack"], true, "claimed and awaiting its ack: {}", jobs[0].3);
    let copy = jobs[0].3["claimed"]["copy"].as_str().expect("the handed copy").to_string();
    let before = w.count("SELECT count(*) FROM ot.mail WHERE kind='watchdog'", &[]).await;
    let mut ack = crate::domain::mail::Outgoing::new(crate::domain::mail::From::Agent { id: w.member, name: "member".into(), generation: 1 }, "stream", "done");
    ack.reply_to = Some(json!({"id": copy}));
    crate::domain::mail::send(&w.e, w.org.id, ack).await.unwrap();
    assert_eq!(before, w.count("SELECT count(*) FROM ot.mail WHERE kind='watchdog'", &[]).await, "the ack goes nowhere");
    let reply = crate::domain::mail::Outgoing::new(crate::domain::mail::From::Agent { id: w.member, name: "member".into(), generation: 1 }, "stream/feed", "thanks");
    assert!(crate::domain::mail::send(&w.e, w.org.id, reply).await.is_err(), "a watchdog is no recipient");
}

/// PF7 (F5, rev 2.1 "Always queue"): with no fair_queue listener the fire still queues one waiting job, with no note or gist suffix; a later listener receives it.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf07_queue_always_queues_and_a_later_listener_gets_it() {
    let w = world().await;
    w.listeners_on(true).await;
    let out = w.form_dog(w.boss, "feed", "queue", json!({})).await.unwrap();
    assert!(out.get("note").is_none_or(Value::is_null), "no create note: {out}");
    let row = w.dog("feed").await.5;
    w.fire(row, &["first"]).await;
    let jobs = w.jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0].1, "pending");
    assert!(!w.gist(row).await.contains("(no "), "no gist suffix: {}", w.gist(row).await);
    w.worker(w.member).await;
    assert_eq!(w.mail_with(w.member, QUEUE_LINE).await, 1, "the later listener receives the waiting job");
}

/// PF8 (F5 ACK timeout): a job nobody has taken never ages into attempts or a dead letter.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf08_an_unclaimed_job_does_not_time_out() {
    let w = world().await;
    w.listeners_on(true).await;
    w.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{mail_queue}','\"ack\"') WHERE id=$1", &[&w.project]).await;
    w.form_dog(w.boss, "feed", "queue", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["waiting"]).await;
    w.sql("UPDATE ot.mail SET created_at=now()-interval '3 days' WHERE recipient_agent_id=$1", &[&w.project]).await;
    crate::domain::projects::dispatch(&w.e, w.org.id, w.project).await.unwrap();
    crate::domain::projects::release_stale(&w.e, w.org.id, w.project).await.unwrap();
    let jobs = w.jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0].1, "pending");
    assert!(jobs[0].3.get("dead_letter").is_none() && jobs[0].3["attempts"].as_i64().unwrap_or(0) == 0, "{}", jobs[0].3);
}

/// PF9 (F1, control): a dog row without the key is an event dog, and `list` says so.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf09_a_missing_key_means_event() {
    let w = world().await;
    w.listen(w.member, None).await;
    w.put_dog(w.boss, "feed").await.unwrap();
    let (_, _, _, memo, _, row) = w.dog("feed").await;
    assert!(memo.get("project_delivery").is_none(), "the default stores nothing: {memo}");
    w.fire(row, &["hi"]).await;
    assert_eq!(w.mail_with(w.member, "fired the event on project @stream").await, 1);
    let l = list(&w.e, w.boss, &json!({})).await.unwrap();
    let dog = l["watchdogs"].as_array().or(l["dogs"].as_array()).expect("a list").iter().find(|d| d["id"] == "feed").expect("the dog is listed").clone();
    assert_eq!(dog["project_delivery"], "event", "{dog}");
}

/// PF10 (F6): the event-listeners setting gates the event form only.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf10_the_setting_gates_only_the_event_form() {
    let w = world().await;
    w.listeners_on(false).await;
    w.form_dog(w.boss, "b", "broadcast", json!({"target":"echo b"})).await.unwrap();
    w.form_dog(w.boss, "q", "queue", json!({"target":"echo q"})).await.unwrap();
    w.form_dog(w.boss, "e", "event", json!({"target":"echo e"})).await.unwrap();
    for (name, want) in [("b", "armed"), ("q", "armed"), ("e", "paused")] {
        let (_, _, state, memo, _, _) = w.dog(name).await;
        assert_eq!(state, want, "{name}");
        assert_eq!(memo.get(crate::domain::listeners::OFF_MARK).is_some(), name == "e", "{name}: {memo}");
    }
    w.listeners_on(true).await;
    let mut c = w.e.db.get().await.unwrap();
    let tx = c.transaction().await.unwrap();
    crate::domain::listeners::switch_off(&tx, w.project, "boss").await.unwrap();
    tx.commit().await.unwrap();
    for (name, want) in [("b", "armed"), ("q", "armed"), ("e", "paused")] {
        assert_eq!(w.dog(name).await.2, want, "after switch_off: {name}");
    }
}

/// PF11 (F8): configure moves a dog between forms; the OFF mark follows the setting.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf11_configure_and_the_off_mark() {
    let w = world().await;
    w.listeners_on(false).await;
    w.form_dog(w.boss, "feed", "event", json!({})).await.unwrap();
    assert_eq!(w.dog("feed").await.2, "paused");
    let out = configure(&w.e, w.org.id, Some(w.boss), "stream/feed", &json!({"project_delivery":"broadcast"})).await.unwrap();
    assert!(out["note"].as_str().unwrap_or("").contains("re-armed: broadcast and queue dogs don't depend on the event-listeners setting"), "{out}");
    let (_, _, state, memo, _, _) = w.dog("feed").await;
    assert_eq!(state, "armed");
    assert!(memo.get(crate::domain::listeners::OFF_MARK).is_none() && memo["project_delivery"] == "broadcast", "{memo}");
    let out = configure(&w.e, w.org.id, Some(w.boss), "stream/feed", &json!({"project_delivery":"event"})).await.unwrap();
    assert!(out["note"].as_str().unwrap_or("").contains("event listeners are off"), "{out}");
    let (_, _, state, memo, _, _) = w.dog("feed").await;
    assert_eq!((state.as_str(), memo.get(crate::domain::listeners::OFF_MARK).is_some()), ("paused", true));
}

/// PF12 (F8): leaving broadcast resets notice, and says so; both settings apply together.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf12_leaving_broadcast_resets_notice() {
    let w = world().await;
    w.listeners_on(true).await;
    w.form_dog(w.boss, "feed", "broadcast", json!({"notice":true})).await.unwrap();
    let out = configure(&w.e, w.org.id, Some(w.boss), "stream/feed", &json!({"project_delivery":"queue"})).await.unwrap();
    assert!(out["note"].as_str().unwrap_or("").contains("notice was reset to false: only broadcast dogs may be passive"), "{out}");
    let memo = w.dog("feed").await.3;
    assert_eq!((memo["notice"].clone(), memo["project_delivery"].clone()), (json!(false), json!("queue")));
    // invalid in one half: neither applies
    let e = err(configure(&w.e, w.org.id, Some(w.boss), "stream/feed", &json!({"project_delivery":"event","connection_messages":"loud"})).await);
    assert!(e.contains("connection_messages must be notice, wake or off") || e.contains("only for mqtt and websocket"), "{e}");
    assert_eq!(w.dog("feed").await.3["project_delivery"], "queue");
}

/// PF13 (F11): a pattern-filtered listener sees event-form fires only.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf13_listeners_never_see_other_forms() {
    let w = world().await;
    let m2 = w.id("member2").await;
    w.listen(m2, Some("hello")).await;
    w.form_dog(w.boss, "feed", "broadcast", json!({})).await.unwrap();
    let row = w.dog("feed").await.5;
    w.fire(row, &["hello there"]).await;
    let fired: i32 = w.e.db.get().await.unwrap().query_one("SELECT fired FROM ot.watchdogs WHERE owner_agent_id=$1 AND kind='project_listener'", &[&m2]).await.unwrap().get(0);
    assert_eq!(fired, 0);
    assert_eq!(w.mail_with(m2, "fired the event on project").await, 0);
}

/// PF14 (F1): the parameter is for project dogs, and only three values.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf14_project_delivery_validation() {
    let w = world().await;
    w.listeners_on(true).await;
    let e = err(create(&w.e, w.org.id, w.boss, &json!({"kind":"command","target":"echo hi","pattern":"zzz","project_delivery":"queue"})).await);
    assert!(e.contains("project_delivery is for project watchdogs"), "{e}");
    let e = err(w.form_dog(w.boss, "feed", "carrier-pigeon", json!({})).await);
    assert!(e.contains("project_delivery is event, broadcast or queue"), "{e}");
    w.put_dog(w.boss, "plain").await.unwrap();
    let e = err(configure(&w.e, w.org.id, Some(w.boss), "stream/plain", &json!({"project_delivery":"carrier-pigeon"})).await);
    assert!(e.contains("project_delivery is event, broadcast or queue"), "{e}");
    // configure on an agent dog
    create(&w.e, w.org.id, w.boss, &json!({"kind":"command","target":"echo hi","pattern":"zzz","name":"mine"})).await.unwrap();
    let e = err(configure(&w.e, w.org.id, Some(w.boss), "mine", &json!({"project_delivery":"queue"})).await);
    assert!(e.contains("project_delivery is for project watchdogs"), "{e}");
}

/// PF15 (F9): a ready-once broadcast dog sends at create and says how many; the queue form always queues.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf15_ready_once_resolves_inline() {
    let w = world().await;
    let out = w.form_dog(w.boss, "feed", "broadcast", json!({"pattern":"hi","once":true})).await.unwrap();
    assert_eq!((out["resolved"].clone(), out["registered"].clone(), out["sent"].clone()), (json!(true), json!(false), json!(3)), "{out}");
    assert_eq!(w.mail(w.member).await.len(), 1);
    let q = w.form_dog(w.boss, "feed2", "queue", json!({"pattern":"hi2","once":true,"target":"echo hi2"})).await.unwrap();
    assert_eq!((q["resolved"].clone(), q["registered"].clone()), (json!(true), json!(false)), "{q}");
    assert!(q["queued"].as_str().is_some_and(|u| !u.is_empty()), "{q}");
    assert_eq!(w.jobs().await.len(), 1);
}

/// PF16 (F11): the form is not part of the duplicate key.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn pf16_a_second_dog_on_the_same_source_is_refused_whatever_its_form() {
    let w = world().await;
    w.listeners_on(true).await;
    w.form_dog(w.boss, "feed", "queue", json!({})).await.unwrap();
    let e = err(w.form_dog(w.boss, "again", "broadcast", json!({})).await);
    assert!(e.contains("project stream already has this watchdog: stream/feed; listen to the project instead of adding another"), "{e}");
}
