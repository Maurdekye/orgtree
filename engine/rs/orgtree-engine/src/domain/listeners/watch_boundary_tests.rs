use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires isolated rig cluster and local v4.3.3 migration fixture"]
#[nolog]
async fn upgrade_boundary_v433_to_0050() {
    use sha2::{Digest,Sha256};
    let root=std::env::var("ORGTREE_CLAIM_TEST_ROOT").unwrap().replace('\\',"/");
    assert!(root.starts_with("D:/orgtree-work/rig/taskbar-orgs-sol-listener-bounds/runs/"));
    let mut cfg:tokio_postgres::Config=std::env::var("ORGTREE_CLAIM_TEST_URL").unwrap().parse().unwrap();
    let (c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
    c.batch_execute("CREATE DATABASE listener_upgrade_fixture").await.unwrap();
    cfg.dbname("listener_upgrade_fixture");
    let (mut c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
    c.batch_execute("CREATE TABLE public.ot_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    let path=std::env::var("ORGTREE_V433_MIGRATIONS").unwrap();assert!(path.replace('\\',"/").starts_with("C:/orgtree-build/taskbar-orgs-sol/"));
    let entries:Vec<Value>=serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(entries.len()>=24);
    for entry in entries {
        let sql=entry["sql"].as_str().unwrap();let name=entry["name"].as_str().unwrap();
        c.batch_execute(sql).await.unwrap();
        let checksum=hex::encode(Sha256::digest(sql.replace("\r\n","\n").as_bytes()));
        c.execute("INSERT INTO public.ot_migrations(name,checksum) VALUES($1,$2)",&[&name,&checksum]).await.unwrap();
    }
    let org:i64=c.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'upgrade-sentinel','Sentinel') RETURNING id",&[]).await.unwrap().get(0);
    c.execute("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'preserved-agent','sol','live','synthetic')",&[&org]).await.unwrap();
    crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    assert_eq!(c.query_one("SELECT name FROM ot.agents WHERE org_id=$1",&[&org]).await.unwrap().get::<_,String>(0),"preserved-agent");
    assert!(c.query_opt("SELECT 1 FROM public.ot_migrations WHERE name='0050_project_event_dispatch'",&[]).await.unwrap().is_some());
    assert!(c.query_one("SELECT to_regclass('ot.project_event_dispatch') IS NOT NULL AND to_regclass('ot.listener_fire_outbox') IS NOT NULL",&[]).await.unwrap().get::<_,bool>(0));
    crate::migrate::run(&mut c,&|_|{}).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated listener-bounds rig cluster"]
#[nolog]
async fn event_boundary_continues_same_event_after_page_commit() {
    let root=std::env::var("ORGTREE_CLAIM_TEST_ROOT").unwrap().replace('\\',"/");assert!(root.starts_with("D:/orgtree-work/rig/taskbar-orgs-sol-listener-bounds/runs/"));
    let cfg:tokio_postgres::Config=std::env::var("ORGTREE_CLAIM_TEST_URL").unwrap().parse().unwrap();
    let (mut c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    let org:i64=std::env::var("ORGTREE_CLAIM_TEST_ORG").unwrap().parse().unwrap();
    let project:i64=c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live','{\"event_listeners\":true}','synthetic') RETURNING id",&[&org,&uid("event-project")]).await.unwrap().get(0);
    // User registrations exercise the whole-page path without provider CLIs.
    c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,owner_kind,name,kind,target,interval_s,state,once,memo) SELECT $1::text||g,$2,NULL,'user','event-boundary','project_listener','synthetic',600,'armed',g IN(1,201),jsonb_build_object('target_id',$3::bigint) FROM generate_series(1,201) g",&[&uid("event-dog"),&org,&project]).await.unwrap();
    let mut engine=Engine::for_tests(std::path::PathBuf::from("C:/orgtree-build/taskbar-orgs-sol/event-boundary-engine"));
    let mgr=deadpool_postgres::Manager::from_config(cfg,NoTls,deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    STOP_AFTER_EVENT_PAGE.scope(true,fire(&engine,org,project,"@user",Some("same-event-after-restart"))).await.unwrap();
    let fired:i64=c.query_one("SELECT count(*) FROM ot.watchdogs WHERE (memo->>'target_id')::bigint=$1 AND fired=1",&[&project]).await.unwrap().get(0);assert_eq!(fired,200);
    recover_pending(&engine).await.unwrap();recover_pending(&engine).await.unwrap();
    assert_eq!(c.query_one("SELECT count(*) FROM ot.watchdogs WHERE (memo->>'target_id')::bigint=$1 AND fired=1",&[&project]).await.unwrap().get::<_,i64>(0),201);
    let fire_id:i64=c.query_one("SELECT id FROM ot.project_fires WHERE project_id=$1",&[&project]).await.unwrap().get(0);
    assert_eq!(c.query_one("SELECT count(*) FROM ot.mail WHERE (extra->'project_event'->>'fire_id')::bigint=$1",&[&fire_id]).await.unwrap().get::<_,i64>(0),201);
    assert_eq!(c.query_one("SELECT jsonb_array_length(listeners) FROM ot.project_fires WHERE id=$1",&[&fire_id]).await.unwrap().get::<_,i32>(0),201);
    assert_eq!(c.query_one("SELECT count(*) FROM ot.watchdogs WHERE (memo->>'target_id')::bigint=$1 AND once AND state='spent'",&[&project]).await.unwrap().get::<_,i64>(0),2);
}

#[tokio::test]
#[ignore = "requires explicitly isolated listener-bounds rig cluster"]
#[nolog]
async fn watch_boundary_restart_after_edge_commit() {
    let root=std::env::var("ORGTREE_CLAIM_TEST_ROOT").unwrap().replace('\\',"/");
    assert!(root.starts_with("D:/orgtree-work/rig/taskbar-orgs-sol-listener-bounds/runs/"));
    let cfg:tokio_postgres::Config=std::env::var("ORGTREE_CLAIM_TEST_URL").unwrap().parse().unwrap();
    let (mut c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
    let before:i64=c.query_one("SELECT count(*) FROM ot.agents",&[]).await.unwrap().get(0);
    crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    assert_eq!(before,c.query_one("SELECT count(*) FROM ot.agents",&[]).await.unwrap().get::<_,i64>(0),"additive upgrade preserves existing rows");
    let org:i64=std::env::var("ORGTREE_CLAIM_TEST_ORG").unwrap().parse().unwrap();
    let project:i64=c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live','{\"event_listeners\":true}','synthetic') RETURNING id",&[&org,&uid("watch-project")]).await.unwrap().get(0);
    let agent:i64=c.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','synthetic') RETURNING id",&[&org,&uid("watch-agent"),&project]).await.unwrap().get(0);
    for kind in [LISTENER_KIND,WATCH_KIND] {
        c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,once,memo) VALUES($1,$2,$3,'barrier-watch',$4,'synthetic',600,'armed',true,jsonb_build_object('target_id',$5::bigint,'count',1,'notice',true))",&[&uid("watch-dog"),&org,&agent,&kind,&project]).await.unwrap();
    }
    c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,owner_kind,name,kind,target,interval_s,state,once,memo) VALUES($1,$2,NULL,'user','barrier-user','listener_watch','synthetic',600,'armed',true,jsonb_build_object('target_id',$3::bigint,'count',1))",&[&uid("watch-user"),&org,&project]).await.unwrap();
    let mut engine=Engine::for_tests(std::path::PathBuf::from("C:/orgtree-build/taskbar-orgs-sol/claim-watch-engine"));
    let mgr=deadpool_postgres::Manager::from_config(cfg,NoTls,deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    STOP_AFTER_WATCH_EDGE.scope(true,evaluate_page(&engine,org,project,0)).await.unwrap();
    assert_eq!(c.query_one("SELECT count(*) FROM ot.watchdogs WHERE kind='listener_watch' AND (memo->>'target_id')::bigint=$1 AND memo->'run'->>'above'='true'",&[&project]).await.unwrap().get::<_,i64>(0),2);
    // The first worker is gone at the commit boundary. Recover only durable
    // state, without a new threshold crossing or another registration.
    recover_pending(&engine).await.unwrap();
    let count:i64=c.query_one("SELECT count(*) FROM ot.watchdogs WHERE kind='listener_watch' AND (memo->>'target_id')::bigint=$1 AND state='spent' AND fired=1",&[&project]).await.unwrap().get(0);
    let mails:i64=c.query_one("SELECT count(*) FROM ot.mail WHERE body LIKE '%barrier-%' AND body LIKE '%LISTENERS READY%'",&[]).await.unwrap().get(0);
    assert_eq!((count,mails),(2,2),"agent and user edge obligations survive commit-boundary restart");
    recover_pending(&engine).await.unwrap();
    assert_eq!(c.query_one("SELECT count(*) FROM ot.mail WHERE body LIKE '%barrier-%' AND body LIKE '%LISTENERS READY%'",&[]).await.unwrap().get::<_,i64>(0),2,"recovery cannot duplicate a one-shot fire");
}
