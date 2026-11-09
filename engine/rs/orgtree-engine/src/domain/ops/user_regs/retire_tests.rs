//! Retire, dissolve, delete and the engine-start sweep clear the user's own
//! registrations on projects that are no longer live (docket
//! switchboard-clicking-the-user-s-own-watchdog-chi, USER 2026-11-09 20:30Z
//! "Clean up on retire"). Same disposable synthetic fixture as
//! `slot_limit_tests`: no serve, provider, native CLI or live DB.
use super::slot_limit_tests::fixture;
use super::*;

#[nolog]
async fn user_dog(e: &Arc<Engine>, org: i64, project: i64, uid: &str, kind: &str) {
    e.db.get().await.unwrap().execute(
        "INSERT INTO ot.watchdogs(uid, org_id, owner_agent_id, owner_kind, name, kind, target, interval_s, fire_mode, once, state, memo)
         VALUES ($1, $2, NULL, 'user', $1, $3, 'target', 60, 'event', false, 'armed', $4)",
        &[&uid, &org, &kind, &json!({ "target_id": project, "run": {} })],
    ).await.unwrap();
}

#[nolog]
async fn user_hold(e: &Arc<Engine>, org: i64, project: i64, uid: &str) {
    e.db.get().await.unwrap().execute(
        "INSERT INTO ot.slot_leases(uid, org_id, project_id, holder_agent_id, holder_kind, slot_no, slot_count) VALUES ($1, $2, $3, NULL, 'user', 9, 1)",
        &[&uid, &org, &project],
    ).await.unwrap();
}

#[nolog]
async fn state_of(e: &Arc<Engine>, uid: &str) -> String {
    e.db.get().await.unwrap().query_one("SELECT state FROM ot.watchdogs WHERE uid = $1", &[&uid]).await.unwrap().get(0)
}

#[nolog]
async fn lease_ended(e: &Arc<Engine>, uid: &str) -> bool {
    e.db.get().await.unwrap().query_one("SELECT ended_at IS NOT NULL FROM ot.slot_leases WHERE uid = $1", &[&uid]).await.unwrap().get(0)
}

#[nolog]
async fn arm_user_set(e: &Arc<Engine>, org: i64, project: i64, tag: &str) {
    user_dog(e, org, project, &format!("{tag}-listener"), "project_listener").await;
    user_dog(e, org, project, &format!("{tag}-watch"), "listener_watch").await;
    user_dog(e, org, project, &format!("{tag}-queue"), "fair_queue").await;
    user_dog(e, org, project, &format!("{tag}-slot"), "slot").await;
    user_hold(e, org, project, &format!("{tag}-lease")).await;
}

#[nolog]
async fn assert_cleared(e: &Arc<Engine>, tag: &str) {
    for k in ["listener", "watch", "queue", "slot"] {
        assert_eq!(state_of(e, &format!("{tag}-{k}")).await, "removed", "{tag}-{k}");
    }
    assert!(lease_ended(e, &format!("{tag}-lease")).await, "{tag}: the held slot is released");
}

#[tokio::test]
#[ignore = "requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn retiring_a_project_removes_the_users_registrations_and_leaves_agent_dogs_alone() {
    let (e, o, p, a) = fixture(10).await;
    arm_user_set(&e, o.id, p, "u").await;
    e.db.get().await.unwrap().execute(
        "INSERT INTO ot.watchdogs(uid, org_id, owner_agent_id, owner_kind, name, kind, target, interval_s, fire_mode, once, state, memo)
         VALUES ('agent-dog', $1, $2, 'agent', 'agent-dog', 'file', 'x', 60, 'event', false, 'armed', '{}')",
        &[&o.id, &a],
    ).await.unwrap();
    crate::domain::ops::run(&e, &o, Actor::User, &json!({ "op": "retire", "node": "resource" })).await.unwrap();
    assert_cleared(&e, "u").await;
    assert_ne!(state_of(&e, "agent-dog").await, "removed", "an agent's dog keeps its current retire behaviour (paused)");
    // restoring the project does not bring them back: they are gone, not paused
    e.db.get().await.unwrap().execute("UPDATE ot.agents SET state = 'live' WHERE id = $1", &[&p]).await.unwrap();
    assert_eq!(state_of(&e, "u-listener").await, "removed");
    e.shutdown.cancel();
}

#[tokio::test]
#[ignore = "requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn dissolving_a_parent_clears_the_users_registrations_on_every_project_below() {
    let (e, o, p, _a) = fixture(10).await;
    let c = e.db.get().await.unwrap();
    let boss: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'boss','sol','live','2026-10-21') RETURNING id", &[&o.id]).await.unwrap().get(0);
    let p2: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,'second',$2,'project','project','live',$3,'2026-10-21') RETURNING id", &[&o.id, &boss, &json!({})]).await.unwrap().get(0);
    c.execute("UPDATE ot.agents SET parent_id = $1 WHERE id = $2", &[&boss, &p]).await.unwrap();
    drop(c);
    arm_user_set(&e, o.id, p, "one").await;
    arm_user_set(&e, o.id, p2, "two").await;
    crate::domain::ops::run(&e, &o, Actor::User, &json!({ "op": "dissolve", "node": "boss" })).await.unwrap();
    assert_cleared(&e, "one").await;
    assert_cleared(&e, "two").await;
    e.shutdown.cancel();
}

#[tokio::test]
#[ignore = "requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn the_sweep_removes_orphans_on_archived_projects_and_keeps_live_ones() {
    let (e, o, p, _a) = fixture(10).await;
    let c = e.db.get().await.unwrap();
    let gone: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,'retired','project','project','archived',$2,'2026-10-21') RETURNING id", &[&o.id, &json!({})]).await.unwrap().get(0);
    drop(c);
    arm_user_set(&e, o.id, gone, "orphan").await;
    arm_user_set(&e, o.id, p, "live").await;
    crate::domain::user_regs::startup_sweep(&e).await;
    assert_cleared(&e, "orphan").await;
    assert_eq!(state_of(&e, "live-listener").await, "armed", "a registration on a live project stays");
    assert!(!lease_ended(&e, "live-lease").await);
    // idempotent: a second start finds nothing and changes nothing
    crate::domain::user_regs::startup_sweep(&e).await;
    assert_eq!(state_of(&e, "live-queue").await, "armed");
    e.shutdown.cancel();
}

#[tokio::test]
#[ignore = "requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn retiring_a_project_with_a_user_held_slot_ends_the_lease_and_grants_nothing() {
    let (e, o, p, _a) = fixture(10).await;
    user_hold(&e, o.id, p, "held").await;
    let before: i64 = e.db.get().await.unwrap().query_one("SELECT count(*)::bigint FROM ot.slot_leases WHERE project_id = $1", &[&p]).await.unwrap().get(0);
    crate::domain::ops::run(&e, &o, Actor::User, &json!({ "op": "retire", "node": "resource" })).await.unwrap();
    assert!(lease_ended(&e, "held").await, "the user's hold is released");
    let after: i64 = e.db.get().await.unwrap().query_one("SELECT count(*)::bigint FROM ot.slot_leases WHERE project_id = $1", &[&p]).await.unwrap().get(0);
    assert_eq!(after, before, "no new lease is granted on the retired project");
    e.shutdown.cancel();
}
