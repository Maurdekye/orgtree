//! Org mailbox lockdown (USER 2026-11-25 13:26Z m0388b64a9372; answers 13:37Z mf95eda126994, 14:08Z
//! m0bad0b3358ae, 14:10Z m16ef9bb35e25 + m405b44961ff5; docket org-mailbox-lockdown-allow-list-mode-that-denies).
//! The database tests use the isolated `orginbox_queue_fixture` database; run them one at a time:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 net::lockdown_tests`.
use super::lockdown::{admit, agent_may_change, effective, lists_lockdown, Admission, Edit, Entry, UserMode, Who};
use crate::domain::orginbox;
use crate::engine::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::NoTls;

#[test]
fn the_users_setting_decides_who_may_lock() {
    assert!(effective(UserMode::On, false) && !effective(UserMode::Off, true));
    assert!(effective(UserMode::Org, true) && !effective(UserMode::Org, false));
    assert!(agent_may_change(UserMode::Org));
    assert!(!agent_may_change(UserMode::On) && !agent_may_change(UserMode::Off), "the user's On/Off locks agents out");
    for (s, m) in [("org", UserMode::Org), ("on", UserMode::On), ("off", UserMode::Off), ("org decides", UserMode::Org)] {
        assert_eq!(UserMode::parse(s), Some(m), "{s}");
    }
    assert_eq!(UserMode::parse("maybe"), None);
}

#[test]
fn only_a_hub_listing_lockdown_keeps_one() {
    assert!(lists_lockdown(&json!({"version": "2.6.0", "features": ["blocking", "lockdown"]})));
    assert!(!lists_lockdown(&json!({"version": "2.6.0", "features": ["blocking"]})), "a 2.6.0 hub built before lockdown");
    assert!(!lists_lockdown(&json!({"version": "2.7.0"})));
}

#[test]
fn orgtree_lockdown_is_a_messaging_tool() {
    assert_eq!(crate::domain::tool_groups::required("orgtree_lockdown"), Some(&["messaging"][..]));
    assert!(crate::tools::defs::implemented().contains(&"orgtree_lockdown"));
}

#[test]
fn outside_communication_defaults_to_org_decides() {
    // USER 14:10:26Z: "a new default setting, org decides ... (default open)"
    assert_eq!(orginbox::user_mode(&json!({})), "org");
    assert_eq!(orginbox::org_choice(&json!({})), "normal");
    assert_eq!(orginbox::mode(&json!({})), "normal");
    assert_eq!(orginbox::user_mode(&json!({"org_inbox_enabled": false})), "closed", "a legacy off is the user's closed");
    // the user picks Org decides: the gate follows the org's stored choice
    let stored = json!({"org_inbox_mode": "closed", "org_inbox_enabled": false, "org_inbox_org_mode": "closed"});
    let mut patch = json!({"org_inbox_mode": "org"}).as_object().unwrap().clone();
    orginbox::normalize_patch(&mut patch).unwrap();
    orginbox::resolve_patch(&mut patch, &stored);
    assert_eq!(patch["org_inbox_enabled"], false, "the org had chosen closed");
    let stored = json!({"org_inbox_mode": "normal", "org_inbox_org_mode": "normal"});
    let mut patch = json!({"org_inbox_mode": "org"}).as_object().unwrap().clone();
    orginbox::normalize_patch(&mut patch).unwrap();
    orginbox::resolve_patch(&mut patch, &stored);
    assert_eq!(patch["org_inbox_enabled"], true);
    // an explicit value overrides, as before
    let mut patch = json!({"org_inbox_mode": "closed"}).as_object().unwrap().clone();
    orginbox::normalize_patch(&mut patch).unwrap();
    orginbox::resolve_patch(&mut patch, &json!({"org_inbox_mode": "org"}));
    assert_eq!(patch["org_inbox_enabled"], false);
    assert!(orginbox::normalize_patch(json!({"org_inbox_org_mode": "dnd"}).as_object_mut().unwrap()).is_err(), "the org chooses open or closed only");
    // the effective settings show the user's value, the org's choice and what is in force
    let effective = crate::feed::groups::effective_settings(&json!({"org_inbox_mode": "org", "org_inbox_org_mode": "closed", "org_inbox_enabled": false}), &Default::default());
    assert_eq!((effective["org_inbox_mode"].clone(), effective["org_inbox_org_mode"].clone(), effective["org_inbox_actual"].clone()), (json!("org"), json!("closed"), json!("closed")));
}

struct World {
    e: Arc<Engine>,
    c: tokio_postgres::Client,
    org: i64,
}

/// Org `lock-a` on hubs h1 and h2: `boss` top-level, `front` (primary holder), `scout` (weak link), `idle` (no link).
#[nolog]
async fn world() -> World {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let net = json!({"hubs": [{"id": "h1", "address": "http://127.0.0.1:9", "enabled": true}, {"id": "h2", "address": "http://127.0.0.1:10", "enabled": true}]});
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings,net) VALUES(gen_random_uuid(),'lock-a','a','{}',$1) RETURNING id", &[&net]).await.unwrap().get(0);
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_ORGINBOX_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    engine.orgs.insert(crate::orgs::provisional(org, "lock-a".into(), "lock-a".into(), "lock-a".into()));
    let mut ids = vec![];
    for (name, parent) in [("boss", None), ("front", Some(0usize)), ("scout", Some(0)), ("idle", Some(0))] {
        let p: Option<i64> = parent.map(|i| ids[i]);
        let id: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','2026-11-25') RETURNING id", &[&org, &name, &p]).await.unwrap().get(0);
        ids.push(id);
    }
    c.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1,'front','@extern','fixture'), ($1,'scout','@extern-weak','fixture')", &[&org]).await.unwrap();
    World { e: engine, c, org }
}

#[nolog]
fn entry(hub: &str, address: &str) -> Entry {
    Entry { hub: hub.into(), address: address.into() }
}

#[nolog]
fn denied(r: anyhow::Result<Value>) -> String {
    let e = r.expect_err("expected a refusal");
    format!("{e:#}")
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn holders_lock_and_lift_under_org_decides() {
    let w = world().await;
    let s = super::lockdown::status(&w.e, w.org).await.unwrap();
    assert_eq!((s["setting"].clone(), s["on"].clone()), (json!("org"), json!(false)), "Org decides, off, by default: {s}");
    let on = Edit { on: Some(true), allow: Some(vec![entry("h1", "ann.1a2b3c")]), ..Edit::default() };
    let why = denied(super::lockdown::change(&w.e, w.org, Who::Agent("idle"), on.clone()).await);
    assert!(why.contains("holding the org mailbox"), "{why}");
    let s = super::lockdown::change(&w.e, w.org, Who::Agent("front"), on).await.unwrap();
    assert_eq!((s["on"].clone(), s["rev"].clone(), s["set_by"].clone()), (json!(true), json!(1), json!("front")), "{s}");
    assert_eq!(s["allow"].as_array().unwrap().len(), 1);
    // a weak link may edit too
    let s = super::lockdown::change(&w.e, w.org, Who::Agent("scout"), Edit { add: vec![entry("h2", "bob.4d5e6f")], ..Edit::default() }).await.unwrap();
    assert_eq!((s["allow"].as_array().unwrap().len(), s["rev"].clone()), (2, json!(2)));
    // an agent can't touch the user's setting
    let why = denied(super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { user_mode: Some(UserMode::Off), ..Edit::default() }).await);
    assert!(why.contains("only the user"), "{why}");
    // a stale revision is refused; off raises it too
    let why = denied(super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(false), expect_rev: Some(1), ..Edit::default() }).await);
    assert!(why.contains("changed meanwhile"), "{why}");
    let s = super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(false), expect_rev: Some(2), ..Edit::default() }).await.unwrap();
    assert_eq!((s["on"].clone(), s["rev"].clone(), s["coverage"].clone()), (json!(false), json!(3), json!("off")));
    // the user and the holders are told on and off, once each
    let told: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND recipient_kind='user' AND extra ? 'lockdown'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(told, 2, "on and off; the list edit a moment after the on notice is folded into it (one a minute)");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn the_users_on_and_off_override_the_agents() {
    let w = world().await;
    let s = super::lockdown::change(&w.e, w.org, Who::User, Edit { user_mode: Some(UserMode::On), ..Edit::default() }).await.unwrap();
    assert_eq!((s["on"].clone(), s["agents_may_change"].clone()), (json!(true), json!(false)), "forced on, with an empty list: nobody outside: {s}");
    for edit in [Edit { on: Some(false), ..Edit::default() }, Edit { add: vec![entry("h1", "ann.1a2b3c")], ..Edit::default() }, Edit { set_aside: Some(true), ..Edit::default() }] {
        let why = denied(super::lockdown::change(&w.e, w.org, Who::Agent("front"), edit).await);
        assert!(why.contains("only the user can change it"), "{why}");
    }
    let s = super::lockdown::change(&w.e, w.org, Who::User, Edit { add: vec![entry("h1", "ann.1a2b3c")], ..Edit::default() }).await.unwrap();
    assert_eq!(s["allow"][0]["added_by"], json!("@user"), "under On the user edits the list");
    super::lockdown::change(&w.e, w.org, Who::User, Edit { user_mode: Some(UserMode::Off), ..Edit::default() }).await.unwrap();
    let why = denied(super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(true), ..Edit::default() }).await);
    assert!(why.contains("only the user can change it"), "forced off: {why}");
    let s = super::lockdown::change(&w.e, w.org, Who::User, Edit { user_mode: Some(UserMode::Org), ..Edit::default() }).await.unwrap();
    assert_eq!(s["on"], json!(false), "back to Org decides: the org's own choice (off)");
    let s = super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(true), ..Edit::default() }).await.unwrap();
    assert_eq!(s["on"], json!(true), "the holders decide again");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn admission_follows_the_list_on_each_hub() {
    let w = world().await;
    assert_eq!(admit(&w.c, w.org, "h1", "eve.000000").await.unwrap(), Admission::Deliver, "no lockdown: everyone");
    super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(true), allow: Some(vec![entry("h1", "ann.1a2b3c")]), ..Edit::default() }).await.unwrap();
    assert_eq!(admit(&w.c, w.org, "h1", "@net:ann.1a2b3c").await.unwrap(), Admission::Deliver);
    assert_eq!(admit(&w.c, w.org, "h2", "ann.1a2b3c").await.unwrap(), Admission::Drop, "the same name on another hub is someone else (B3)");
    assert_eq!(admit(&w.c, w.org, "h1", "eve.000000").await.unwrap(), Admission::Drop);
    let refused: i64 = w.c.query_one("SELECT refused FROM ot.net_lockdown WHERE org_id=$1", &[&w.org]).await.unwrap().get(0);
    assert_eq!(refused, 2, "dropped letters are counted");
    super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { set_aside: Some(true), ..Edit::default() }).await.unwrap();
    assert_eq!(admit(&w.c, w.org, "h1", "eve.000000").await.unwrap(), Admission::SetAside);
    super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(false), ..Edit::default() }).await.unwrap();
    assert_eq!(admit(&w.c, w.org, "h2", "eve.000000").await.unwrap(), Admission::Deliver, "lifted");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn set_aside_mail_is_never_released_or_delivered() {
    let w = world().await;
    let m = json!({"id": "net-1", "from": "eve.000000", "to": "lock-a", "body": "flood", "attachments": [{"id": "f1", "name": "x.bin", "bytes": 9}]});
    orginbox::set_aside_inbound(&w.e, w.org, "h1", &m).await.unwrap();
    orginbox::set_aside_inbound(&w.e, w.org, "h1", &m).await.unwrap();
    let rows = w.c.query("SELECT id, set_aside_at IS NOT NULL, body FROM ot.org_inbox WHERE org_id=$1 AND dir='in'", &[&w.org]).await.unwrap();
    assert_eq!(rows.len(), 1, "once");
    assert!(rows[0].get::<_, bool>(1));
    assert!(rows[0].get::<_, String>(2).contains("not downloaded"), "files are not fetched");
    orginbox::resume_pending(&w.e, w.org).await;
    let untouched: bool = w.c.query_one("SELECT NOT read AND pulled_by IS NULL AND NOT dnd_held FROM ot.org_inbox WHERE org_id=$1 AND dir='in'", &[&w.org]).await.unwrap().get(0);
    assert!(untouched, "the release pass skips set-aside mail (review B4)");
    let mail: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND recipient_kind='agent'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(mail, 0, "no copy, no notice");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn holders_open_and_close_outside_communication_under_org_decides() {
    let w = world().await;
    // existing orgs move to Org decides with their mode as the org's choice; DnD stays the user's
    let sql = include_str!("../../migrations/0093_net_lockdown.sql");
    let carry = &sql[sql.find("UPDATE ot.orgs").unwrap()..];
    for (slug, settings) in [("old-closed", json!({"org_inbox_mode": "closed", "org_inbox_enabled": false})), ("old-legacy-off", json!({"org_inbox_enabled": false})),
                             ("old-normal", json!({"org_inbox_mode": "normal", "org_inbox_enabled": true})), ("old-dnd", json!({"org_inbox_mode": "dnd", "org_inbox_enabled": true})), ("old-none", json!({}))] {
        w.c.execute("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),$1,$1,$2)", &[&slug, &settings]).await.unwrap();
    }
    w.c.batch_execute(carry).await.unwrap();
    for (slug, user, actual) in [("old-closed", "org", "closed"), ("old-legacy-off", "org", "closed"), ("old-normal", "org", "normal"), ("old-dnd", "dnd", "dnd"), ("old-none", "org", "normal")] {
        let s: Value = w.c.query_one("SELECT settings FROM ot.orgs WHERE slug=$1", &[&slug]).await.unwrap().get(0);
        assert_eq!((orginbox::user_mode(&s), orginbox::mode(&s)), (user, actual), "{slug}: {s}");
    }
    let why = format!("{:#}", orginbox::set_org_choice(&w.e, w.org, "idle", "closed").await.unwrap_err());
    assert!(why.contains("holding the org mailbox"), "{why}");
    orginbox::set_org_choice(&w.e, w.org, "scout", "closed").await.unwrap();
    let s: Value = w.c.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&w.org]).await.unwrap().get(0);
    assert_eq!((orginbox::user_mode(&s), orginbox::mode(&s), s["org_inbox_enabled"].clone()), ("org", "closed", json!(false)), "{s}");
    orginbox::set_org_choice(&w.e, w.org, "front", "normal").await.unwrap();
    // the user's explicit value wins and locks agents out
    w.c.execute("UPDATE ot.orgs SET settings = settings || '{\"org_inbox_mode\":\"normal\"}' WHERE id=$1", &[&w.org]).await.unwrap();
    let why = format!("{:#}", orginbox::set_org_choice(&w.e, w.org, "front", "closed").await.unwrap_err());
    assert!(why.contains("only the user can change it"), "{why}");
}

/// An inbound @net letter delivered the ordinary way (copies to the holder).
#[nolog]
async fn arrive(w: &World, from: &str, id: &str, body: &str) {
    orginbox::deliver_inbound_replies(&w.e, w.org, &format!("@net:{from}"), body, vec![], id, "h1", &[]).await.unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn turning_on_with_set_aside_takes_unread_unlisted_mail_out_of_delivery() {
    // USER 13:37Z Q5 + 14:08Z answer 2: waiting mail and unread delivered copies from unlisted addresses
    let w = world().await;
    arrive(&w, "eve.000000", "n-1", "flood 1").await;
    arrive(&w, "eve.000000", "n-2", "flood 2").await;
    arrive(&w, "ann.1a2b3c", "n-3", "friend").await;
    arrive(&w, "bob.4d5e6f", "n-4", "already read").await;
    w.c.execute("UPDATE ot.mail SET state='read', read_at=now() WHERE org_id=$1 AND net_id='n-4'", &[&w.org]).await.unwrap();
    let s = super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(true), set_aside: Some(true), allow: Some(vec![entry("h1", "ann.1a2b3c")]), ..Edit::default() }).await.unwrap();
    assert_eq!(s["set_aside_now"], json!({"letters": 2, "unread_copies": 2, "unclaimed_jobs": 0}), "{s}");
    let rows = w.c.query("SELECT net_id, set_aside_at IS NOT NULL FROM ot.org_inbox WHERE org_id=$1 AND dir='in' ORDER BY net_id", &[&w.org]).await.unwrap();
    let got: Vec<(String, bool)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(got, vec![("n-1".into(), true), ("n-2".into(), true), ("n-3".into(), false), ("n-4".into(), false)], "listed and already-read letters stay");
    let states: Vec<(String, String)> = w.c.query("SELECT net_id, state FROM ot.mail WHERE org_id=$1 AND recipient_kind='agent' AND net_id IS NOT NULL ORDER BY net_id", &[&w.org]).await.unwrap()
        .iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(states, vec![("n-1".into(), "retracted".into()), ("n-2".into(), "retracted".into()), ("n-3".into(), "pending".into()), ("n-4".into(), "read".into())]);
    // lifting keeps them aside (answer 3); turning on again takes nothing twice
    super::lockdown::change(&w.e, w.org, Who::Agent("front"), Edit { on: Some(false), ..Edit::default() }).await.unwrap();
    let aside: i64 = w.c.query_one("SELECT count(*) FROM ot.org_inbox WHERE org_id=$1 AND set_aside_at IS NOT NULL", &[&w.org]).await.unwrap().get(0);
    assert_eq!(aside, 2, "set-aside stays set aside when the lockdown lifts");
}

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn set_aside_letters_are_read_one_at_a_time_by_the_user_and_real_holders() {
    // USER 14:08Z answer 8; Fable I3
    let w = world().await;
    for (i, from) in ["eve.000000", "eve.000000", "mal.111111"].iter().enumerate() {
        let m = json!({"id": format!("s-{i}"), "from": from, "to": "lock-a", "body": format!("letter {i}")});
        orginbox::set_aside_inbound(&w.e, w.org, "h1", &m).await.unwrap();
    }
    let page = super::lockdown::set_aside_list(&w.e, w.org, Some("front"), 2, None).await.unwrap();
    assert_eq!((page["total"].clone(), page["unread"].clone(), page["set_aside"].as_array().unwrap().len()), (json!(3), json!(3), 2), "{page}");
    assert!(page["set_aside"][0].get("body").is_none(), "a list carries envelopes, never bodies");
    assert_eq!(page["top_senders"][0], json!({"from": "@net:eve.000000", "letters": 2}));
    let next = super::lockdown::set_aside_list(&w.e, w.org, Some("front"), 2, page["next_before"].as_str()).await.unwrap();
    assert_eq!(next["set_aside"].as_array().unwrap().len(), 1);
    let id = page["set_aside"][0]["id"].as_str().unwrap().to_string();
    let one = super::lockdown::set_aside_read(&w.e, w.org, Some("front"), &id).await.unwrap();
    assert_eq!(one["body"], json!("letter 2"));
    let still: bool = w.c.query_one("SELECT set_aside_at IS NOT NULL AND set_aside_read_by = 'front' FROM ot.org_inbox WHERE uid=$1", &[&id]).await.unwrap().get(0);
    assert!(still, "read, recorded, and still set aside");
    let copies: i64 = w.c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1 AND recipient_kind='agent'", &[&w.org]).await.unwrap().get(0);
    assert_eq!(copies, 0, "reading routes nothing");
    let why = format!("{:#}", super::lockdown::set_aside_list(&w.e, w.org, Some("idle"), 20, None).await.unwrap_err());
    assert!(why.contains("only the user and agents holding the org mailbox"), "{why}");
    let weak = super::lockdown::set_aside_list(&w.e, w.org, Some("scout"), 20, None).await.unwrap();
    assert_eq!(weak["total"], json!(0), "a weak link reads only replies to its own mail");
    let user = super::lockdown::set_aside_read(&w.e, w.org, None, &id).await.unwrap();
    assert_eq!(user["from"], json!("@net:mal.111111"));
}
