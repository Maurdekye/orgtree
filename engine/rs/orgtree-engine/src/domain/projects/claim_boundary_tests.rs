//! Two-connection barrier against an explicitly supplied disposable rig cluster.
use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires explicitly isolated listener-bounds rig cluster"]
#[nolog]
async fn claim_boundary_reminder_does_not_increment_a_later_claim() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let cfg=fixture.cfg.clone();
    let org=fixture.org;
    let (mut b,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
    let project:i64=b.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live','{\"mail_queue\":\"ack\"}','synthetic') RETURNING id",&[&org,&uid("reminder-project")]).await.unwrap().get(0);
    let holder:i64=b.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','synthetic') RETURNING id",&[&org,&uid("reminder-owner"),&project]).await.unwrap().get(0);
    let copy=uid("reminder-old-copy");let new_copy=uid("reminder-new-copy");
    let row:i64=b.query_one("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES($1,$2,'@user','agent',$3,'fixture','job','read',$4) RETURNING id",&[&uid("reminder-job"),&org,&project,&json!({"attempts":1,"claimed":{"by_id":holder,"by":"fixture","copy":copy,"ack":true,"wakes":0}})]).await.unwrap().get(0);
    let mut engine=Engine::for_tests(fixture.engine_root("reminder-boundary-engine"));
    let mgr=deadpool_postgres::Manager::from_config(cfg,NoTls,deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let tx=b.transaction().await.unwrap();tx.query_one("SELECT id FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await.unwrap();tx.query_one("SELECT id FROM ot.mail WHERE id=$1 FOR UPDATE",&[&row]).await.unwrap();
    let (started,wait)=tokio::sync::oneshot::channel();
    let worker=engine.clone();
    let mut task=tokio::spawn(async move{let _=started.send(());ack_timeouts(&worker,org,holder,"fixture").await.unwrap()});
    wait.await.unwrap();assert!(tokio::time::timeout(std::time::Duration::from_millis(50),&mut task).await.is_err());
    tx.execute("UPDATE ot.mail SET extra=jsonb_set(jsonb_set(extra,'{claimed,copy}',to_jsonb($2::text)),'{attempts}','2') WHERE id=$1",&[&row,&new_copy]).await.unwrap();tx.commit().await.unwrap();
    assert!(task.await.unwrap().is_empty(),"the old copy must not be returned for a reminder");
    assert_eq!(b.query_one("SELECT (extra->'claimed'->>'wakes')::int FROM ot.mail WHERE id=$1",&[&row]).await.unwrap().get::<_,i32>(0),0,"old reminder cannot increment a same-holder new-copy attempt");
    let kept=ack_timeouts(&engine,org,holder,"fixture").await.unwrap();assert_eq!(kept[0].0,new_copy);
    assert_eq!(b.query_one("SELECT (extra->'claimed'->>'wakes')::int FROM ot.mail WHERE id=$1",&[&row]).await.unwrap().get::<_,i32>(0),1,"a current claim still gets its normal reminder");
}

#[tokio::test]
#[ignore = "requires the explicitly isolated listener-bounds rig cluster"]
#[nolog]
async fn claim_boundary_stale_reclaim() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let cfg=fixture.cfg.clone();
    assert_eq!(cfg.get_dbname(),Some("orgtree_engine"));
    assert_eq!(cfg.get_user(),Some("orgtree_admin"));
    let org=fixture.org;
    let mut failures=Vec::new();
    for mode in ["other-holder","user-holder","same-holder-new-copy","acked","holder-recovered"] {
        let (mut b,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
        let project:i64=b.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live','{\"mail_queue\":\"ack\"}', 'synthetic') RETURNING id",&[&org,&uid("claim-project")]).await.unwrap().get(0);
        let holder:i64=b.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,halt,born) VALUES($1,$2,$3,'sol','live','{\"phase\":\"halted\"}','synthetic') RETURNING id",&[&org,&uid("claim-owner"),&project]).await.unwrap().get(0);
        let other:i64=b.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','synthetic') RETURNING id",&[&org,&uid("claim-other"),&project]).await.unwrap().get(0);
        b.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,memo) VALUES($1,$2,$3,'claim-listener','fair_queue','synthetic',600,'armed',jsonb_build_object('target_id',$4::bigint))",&[&uid("claim-listener"),&org,&holder,&project]).await.unwrap();
        let first=uid("copy-first");let second=uid("copy-second");
        let row:i64=b.query_one("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES($1,$2,'@user','agent',$3,'fixture','job','read',$4) RETURNING id",&[&uid("claim-job"),&org,&project,&json!({"attempts":1,"claimed":{"by_id":holder,"by":"fixture","copy":first,"ack":true,"at":iso(Utc::now())}})]).await.unwrap().get(0);
        // B owns the project lock while A starts reclaim with the OLD holder.
        let tx=b.transaction().await.unwrap();tx.query_one("SELECT id FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await.unwrap();
        let (mut a,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
        let (started,wait)=tokio::sync::oneshot::channel();
        let observed=first.clone();
        let mut task=tokio::spawn(async move{
            let tx=a.transaction().await.unwrap();let _=started.send(());
            let got=reclaim_in(&tx,org,project,row,holder,"fixture","was halted","released","failed",false,Some(&observed)).await.unwrap().is_some();
            tx.rollback().await.unwrap();got
        });
        wait.await.unwrap();assert!(tokio::time::timeout(std::time::Duration::from_millis(50),&mut task).await.is_err(),"A must be blocked behind B's project lock");
        let mut replacement=json!({"by_id":other,"by":"other","copy":second,"ack":true,"at":iso(Utc::now())});
        if mode=="user-holder" {replacement["by_id"]=Value::Null;replacement["by"]=json!("@user");replacement["by_user"]=json!(true);}
        if mode=="same-holder-new-copy" {replacement["by_id"]=json!(holder);}
        if mode=="acked" {replacement["acked_at"]=json!(iso(Utc::now()));}
        if mode=="holder-recovered" {replacement["by_id"]=json!(holder);replacement["copy"]=json!(first);tx.execute("UPDATE ot.agents SET halt=NULL WHERE id=$1",&[&holder]).await.unwrap();}
        tx.execute("UPDATE ot.mail SET extra=jsonb_build_object('attempts',2,'claimed',$2::jsonb) WHERE id=$1",&[&row,&replacement]).await.unwrap();tx.commit().await.unwrap();
        if task.await.unwrap() {failures.push(mode);}
    }
    assert!(failures.is_empty(),"stale reclaim crossed claim boundary: {failures:?}");
}
