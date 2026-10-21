use super::*;
use tokio_postgres::NoTls;

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
