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
