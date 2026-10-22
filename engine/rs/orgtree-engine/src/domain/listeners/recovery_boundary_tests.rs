use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires isolated listener-bounds rig cluster"]
#[nolog]
async fn recovery_boundary_inactive_org_does_not_deliver_or_claim() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let cfg=fixture.cfg.clone();
    let (mut c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
    crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    let mut engine=Engine::for_tests(fixture.engine_root("recovery-boundary-engine"));
    let mgr=deadpool_postgres::Manager::from_config(cfg,NoTls,deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    for trashed in [true,false] {
        let slug=uid("recovery-org");
        let org:i64=c.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),$1,'Recovery boundary') RETURNING id",&[&slug]).await.unwrap().get(0);
        engine.orgs.insert(crate::orgs::provisional(org,uid("org"),slug.clone(),slug.clone()));
        let project:i64=c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,'project','project','project','live','{\"event_listeners\":true}','synthetic') RETURNING id",&[&org]).await.unwrap().get(0);
        let mut dogs=Vec::new();
        for kind in [LISTENER_KIND,WATCH_KIND,WATCH_KIND] {
            dogs.push(c.query_one("INSERT INTO ot.watchdogs(uid,org_id,owner_kind,name,kind,target,interval_s,state,once,memo) VALUES($1,$2,'user','recovery-boundary',$3,'synthetic',600,'armed',true,jsonb_build_object('target_id',$4::bigint,'count',1)) RETURNING id",&[&uid("recovery-dog"),&org,&kind,&project]).await.unwrap().get::<_,i64>(0));
        }
        // Allocate a saved delivery while active; halt before its action claim/wake.
        c.execute("INSERT INTO ot.listener_fire_outbox(org_id,project_id,watchdog_id,line) VALUES($1,$2,$3,'saved')",&[&org,&project,&dogs[2]]).await.unwrap();
        let (saved_id,saved)=stage_fire(&engine,org,project).await.unwrap().unwrap();let saved=saved.unwrap();
        c.execute("UPDATE ot.listener_fire_outbox SET processing_boot=NULL WHERE id=$1",&[&saved_id]).await.unwrap();
        c.execute("INSERT INTO ot.listener_fire_outbox(org_id,project_id,watchdog_id,line) VALUES($1,$2,$3,'owed edge')",&[&org,&project,&dogs[1]]).await.unwrap();
        let fire:i64=c.query_one("INSERT INTO ot.project_fires(org_id,project_id,kind,fired_by) VALUES($1,$2,'event','@user') RETURNING id",&[&org,&project]).await.unwrap().get(0);
        c.execute("INSERT INTO ot.project_event_dispatch(fire_id,org_id,project_id,high_water) VALUES($1,$2,$3,$4)",&[&fire,&org,&project,&dogs[0]]).await.unwrap();
        let snapshot_sql="SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM ot.watchdogs w WHERE org_id=$1),(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ot.mail m WHERE org_id=$1),(SELECT jsonb_agg(to_jsonb(d) ORDER BY fire_id) FROM ot.project_event_dispatch d WHERE org_id=$1),(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM ot.listener_fire_outbox f WHERE org_id=$1))";
        let before:Value=c.query_one(snapshot_sql,&[&org]).await.unwrap().get(0);
        if trashed {c.execute("UPDATE ot.orgs SET state='trashed' WHERE id=$1",&[&org]).await.unwrap();}
        else {engine.orgs.remove(&slug);}
        recover_pending(&engine).await.unwrap();
        // Direct entry points and the already-saved post-commit path must gate too.
        deliver_page(&engine,org,project).await.unwrap();stage_fire(&engine,org,project).await.unwrap();
        finish_fire(&engine,org,project,saved_id,&saved).await.unwrap();
        let after:Value=c.query_one(snapshot_sql,&[&org]).await.unwrap().get(0);
        assert_eq!(before,after,"inactive org must not mutate pending event/watch/saved delivery; trashed={trashed}");
        c.execute("UPDATE ot.orgs SET state='active' WHERE id=$1",&[&org]).await.unwrap();
        engine.orgs.insert(crate::orgs::provisional(org,uid("org"),slug.clone(),slug));
        recover_pending(&engine).await.unwrap();recover_pending(&engine).await.unwrap();
        assert_eq!(c.query_one("SELECT count(*) FROM ot.mail WHERE org_id=$1",&[&org]).await.unwrap().get::<_,i64>(0),3,"active recovery resumes exactly once");
        assert_eq!(c.query_one("SELECT count(*) FROM ot.listener_fire_outbox WHERE org_id=$1 AND (NOT done OR NOT actions_claimed)",&[&org]).await.unwrap().get::<_,i64>(0),0);
    }
}

#[tokio::test]
#[ignore = "requires isolated listener-bounds rig cluster"]
#[nolog]
async fn recovery_boundary_high_water_cost_ignores_inactive_tail() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let cfg=fixture.cfg.clone();
    let (mut c,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    let org=fixture.org;
    let project:i64=c.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,born) VALUES($1,$2,'project','project','live','synthetic') RETURNING id",&[&org,&uid("cost-project")]).await.unwrap().get(0);
    let dog:i64=c.query_one("INSERT INTO ot.watchdogs(uid,org_id,owner_kind,name,kind,target,interval_s,state,memo) VALUES($1,$2,'user','cost','project_listener','synthetic',600,'paused',jsonb_build_object('target_id',$3::bigint)) RETURNING id",&[&uid("cost-dog"),&org,&project]).await.unwrap().get(0);
    fn examined(v:&Value)->f64 {v["Actual Rows"].as_f64().unwrap_or(0.)+v["Rows Removed by Filter"].as_f64().unwrap_or(0.)+v["Plans"].as_array().map(|p|p.iter().map(examined).sum::<f64>()).unwrap_or(0.)}
    for added in [1000i32,20000i32] {
        c.execute("INSERT INTO ot.watchdogs(uid,org_id,owner_kind,name,kind,target,interval_s,state,memo) SELECT $1::text||g,$2,'user','removed-tail','project_listener','synthetic',600,'removed',jsonb_build_object('target_id',0) FROM generate_series(1,$3::int) g",&[&uid("cost-tail"),&org,&added]).await.unwrap();
        c.batch_execute("ANALYZE ot.watchdogs").await.unwrap();
        let sql=format!("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {EVENT_HIGH_WATER}");
        let plan:Value=c.query_one(&sql,&[&org,&project]).await.unwrap().get(0);
        println!("high-water inactive-tail+{added}: {plan}");
        assert_eq!(c.query_one(EVENT_HIGH_WATER,&[&org,&project]).await.unwrap().get::<_,i64>(0),dog,"paused creation-time registration remains included");
        assert!(examined(&plan[0]["Plan"])<=4.,"fixed active set must examine bounded rows despite inactive tail: {}",examined(&plan[0]["Plan"]));
    }
}
