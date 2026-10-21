//! Focused synthetic PG fixture: no serve, provider, native CLI or live DB.
use super::*;
use tokio_postgres::NoTls;

#[nolog]
async fn fixture(cap: i64) -> (Arc<Engine>, Arc<OrgHandle>, i64, i64) {
    let url=std::env::var("ORGTREE_SLOT_LIMIT_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg:tokio_postgres::Config=url.parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("slot_limit_fixture"));
    assert_eq!(cfg.get_user(),Some("slot_limit_fixture"));
    let (mut client,connection)=cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _=connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client,&|_|{}).await.unwrap();
    let id:i64=client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'slot-limit-fixture','fixture') RETURNING id",&[]).await.unwrap().get(0);
    let project:i64=client.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,'resource','project','project','live',$2,'2026-10-21') RETURNING id",&[&id,&json!({"slots_capacity":cap})]).await.unwrap().get(0);
    let agent:i64=client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'reader',$2,'sol','live','2026-10-21') RETURNING id",&[&id,&project]).await.unwrap().get(0);
    let other:i64=client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,'other',$2,'sol','live','2026-10-21') RETURNING id",&[&id,&project]).await.unwrap().get(0);
    let mut engine=Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_SLOT_LIMIT_TEST_ROOT").unwrap()));
    let mgr=deadpool_postgres::Manager::from_config(cfg,NoTls,deadpool_postgres::ManagerConfig {recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org=crate::orgs::provisional(id,"fixture".into(),"slot-limit-fixture".into(),"fixture".into());
    // Occupy the rest so accepted claims stay queued and never wake a CLI.
    client.execute("INSERT INTO ot.slot_leases(uid,org_id,project_id,holder_agent_id,slot_no,slot_count) VALUES('other-lease',$1,$2,$3,1,$4)",&[&id,&project,&other,&((cap-3) as i32)]).await.unwrap();
    (engine,org,project,agent)
}

#[nolog]
async fn hold(engine:&Arc<Engine>,org:&Arc<OrgHandle>,project:i64,agent:Option<i64>) {
    engine.db.get().await.unwrap().execute("INSERT INTO ot.slot_leases(uid,org_id,project_id,holder_agent_id,holder_kind,slot_no,slot_count) VALUES('mine',$1,$2,$3,CASE WHEN $3::bigint IS NULL THEN 'user' ELSE 'agent' END,2,3)",&[&org.id,&project,&agent]).await.unwrap();
}

#[nolog]
fn conflict(error:anyhow::Error) -> String {
    assert!(matches!(error.downcast_ref::<crate::domain::UserError>(),Some(crate::domain::UserError::Conflict(_))));
    error.to_string()
}

#[tokio::test]
#[ignore="requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn slot_limit_agent_accepts_remaining_and_refuses_second_pending() {
    let (e,o,p,a)=fixture(10).await; hold(&e,&o,p,Some(a)).await;
    let result=crate::runtime::watchdogs::create(&e,o.id,a,&json!({"kind":"slot","target":"resource","slots":7,"notice":true})).await;
    assert!(result.is_ok(),"an existing holder may queue its remaining seven: {result:?}");
    let error=crate::runtime::watchdogs::create(&e,o.id,a,&json!({"kind":"slot","target":"resource","slots":1,"notice":true})).await.unwrap_err();
    assert!(conflict(error).contains("claim"));
    e.shutdown.cancel();
}

#[tokio::test]
#[ignore="requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn slot_limit_agent_over_limit_refusal_explains_remaining() {
    let (e,o,p,a)=fixture(10).await; hold(&e,&o,p,Some(a)).await;
    let error=crate::runtime::watchdogs::create(&e,o.id,a,&json!({"kind":"slot","target":"resource","slots":8,"notice":true})).await.unwrap_err();
    let text=conflict(error);assert!(text.contains('7')&&text.contains("release"),"{text}");
    assert_eq!(e.db.get().await.unwrap().query_one("SELECT count(*)::bigint FROM ot.watchdogs WHERE kind='slot'",&[]).await.unwrap().get::<_,i64>(0),0);
}

#[tokio::test]
#[ignore="requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn slot_limit_user_held_and_pending_share_remaining_limit() {
    let (e,o,p,_)=fixture(10).await;hold(&e,&o,p,None).await;
    let mut c=e.db.get().await.unwrap();
    let tx=c.transaction().await.unwrap();let mut fx=Effects::default();
    let error=super::slot_hold(&o,&tx,&Actor::User,&json!({"node":"resource","slots":8}),&mut fx).await.unwrap_err();
    conflict(error);tx.rollback().await.unwrap();
    let tx=c.transaction().await.unwrap();let mut fx=Effects::default();
    super::slot_hold(&o,&tx,&Actor::User,&json!({"node":"resource","slots":7}),&mut fx).await.unwrap();tx.commit().await.unwrap();
    let tx=c.transaction().await.unwrap();let mut fx=Effects::default();
    let error=super::slot_hold(&o,&tx,&Actor::User,&json!({"node":"resource","slots":1}),&mut fx).await.unwrap_err();
    conflict(error);tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore="requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn slot_limit_resume_rechecks_capacity_without_arming() {
    let (e,o,p,a)=fixture(10).await;hold(&e,&o,p,Some(a)).await;
    e.db.get().await.unwrap().execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,once,state,memo) VALUES('paused-claim',$1,$2,'paused-claim','slot','resource',60,true,'paused',$3)",&[&o.id,&a,&json!({"target_id":p,"slots":7,"queued_at":1})]).await.unwrap();
    e.db.get().await.unwrap().execute("UPDATE ot.agents SET scope=jsonb_build_object('slots_capacity',6) WHERE id=$1",&[&p]).await.unwrap();
    let error=crate::runtime::watchdogs::act(&e,o.id,Some(a),"paused-claim","resume",None).await.unwrap_err();
    conflict(error);
    assert_eq!(e.db.get().await.unwrap().query_one("SELECT state FROM ot.watchdogs WHERE uid='paused-claim'",&[]).await.unwrap().get::<_,String>(0),"paused");
}

#[test]
fn slot_limit_measured_capacity_and_large_anchor_are_supported() {
    assert_eq!(crate::domain::slots::capacity(&json!({"slots_capacity":9_999_999})),9_999_999);
    assert_eq!(crate::domain::slots::requested(&json!({"slots":9_999_999})),9_999_999);
}

#[tokio::test]
#[ignore="requires disposable slot_limit_fixture DB/role; never an ambient DB"]
async fn slot_limit_large_capacity_is_persisted_without_capacity_sized_allocation() {
    assert_eq!(crate::domain::slots::MAX_CAPACITY,9_999_999);
    let (e,o,p,a)=fixture(9_999_999).await;hold(&e,&o,p,Some(a)).await;
    let result=crate::runtime::watchdogs::create(&e,o.id,a,&json!({"kind":"slot","target":"resource","slots":9_999_996,"notice":true})).await.unwrap();
    assert!(result["id"].is_string());
    assert_eq!(crate::domain::slots::free_slots(9_999_999,&[1,3]).take(2).collect::<Vec<_>>(),vec![2,4]);
    e.shutdown.cancel();
}
