use super::*;
use serde_json::json;

#[nolog]
fn work(slug: &str, status: &str, to: &str, attention: bool) -> WorkRow {
    WorkRow {slug:slug.into(),title:slug.into(),status:status.into(),to:Some(to.into()),role:"owner",attention}
}

#[test]
fn reminder_pages_keep_display_bounded_and_count_the_omitted_work() {
    let mut scan=Sweep::default();
    for i in 0..51 {scan.add(work(&format!("w-{i:03}"),"open","worker",false));}
    scan.add(work("attention","open","worker",true));
    scan.add(work("blocked","blocked","worker",false));
    let items=scan.items("worker",true);
    assert_eq!(items.total,51);assert_eq!(items.shown.len(),20);
    assert_eq!(items.total-items.shown.len(),31);assert_eq!(items.shown[19].slug,"w-019");
    assert_eq!(scan.items("other",true).total,0);
}

#[test]
fn reminder_pages_skip_deploy_ready_like_blocked_ones() {
    // deploy_ready: built, waiting for the user's review or a release (user 2026-10-28), so not idle work.
    // Like blocked work it is left out of the ordinary reminder; unlike blocked work it has no fallback.
    let mut scan=Sweep::default();
    scan.add(work("ready","deploy_ready","boss",false));
    scan.add(WorkRow{role:"deployer",..work("handoff","deploy_ready","boss",false)});
    scan.add(work("open","open","boss",false));
    let boss=scan.items("boss",false);
    assert_eq!(boss.total,1);assert_eq!(boss.shown[0].slug,"open");
    let mut only=Sweep::default();
    only.add(work("ready","deploy_ready","boss",false));
    assert_eq!(only.items("boss",false).total,0);
    assert_eq!(only.items("boss",true).total,0,"the blocked option must not list deploy_ready work either");
}

#[test]
fn reminder_pages_blocked_fallback_and_timeout_off_preserve_their_guards() {
    let mut scan=Sweep::default();scan.add(work("blocked","blocked","worker",false));
    assert_eq!(scan.items("worker",false).total,0);
    assert_eq!(scan.items("worker",true).shown[0].status,"blocked");
    let off=json!({"mail_queue_ack_timeout":false,"mail_queue_ack_reminders":3});
    let on=json!({"mail_queue_ack_timeout":true,"mail_queue_ack_reminders":3});
    assert!(!crate::domain::projects::ack_reminders_exhausted(&off,100));
    assert!(!crate::domain::projects::ack_reminders_exhausted(&on,2));
    assert!(crate::domain::projects::ack_reminders_exhausted(&on,3));
}

#[tokio::test]
#[ignore = "requires an isolated reminder_pages_fixture database and role"]
async fn reminder_pages_cross_old_limits_with_real_queries_and_durable_rotation() {
    let url=std::env::var("ORGTREE_REMINDER_PAGES_TEST_URL").expect("synthetic fixture URL required");
    let cfg:tokio_postgres::Config=url.parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("reminder_pages_fixture"));assert_eq!(cfg.get_user(),Some("reminder_pages_fixture"));
    let (mut c,conn)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let conn=tokio::spawn(async move {conn.await.unwrap()});
    crate::migrate::run(&mut c,&|_|{}).await.unwrap();
    c.batch_execute("INSERT INTO ot.orgs(uuid,slug,name) VALUES('00000000-0000-4000-8000-000000000001','fixture','Fixture');
      INSERT INTO ot.agents(org_id,name,state,tier,born)
       SELECT 1,'a'||g,'live','sol','fixture' FROM generate_series(1,5005) g;
      INSERT INTO ot.work_items(org_id,slug,title,status,owner,owner_agent_id,created_by,reviewer,reviewer_agent_id)
       SELECT 1,'w-'||lpad(g::text,5,'0'),'Work '||g,CASE WHEN g=5001 THEN 'review' ELSE 'blocked' END,
        '{\"node\":\"a1\",\"generation\":1}'::jsonb,1,'{}'::jsonb,
        CASE WHEN g=5001 THEN '{\"node\":\"a5005\",\"generation\":1}'::jsonb END,
        CASE WHEN g=5001 THEN 5005 END FROM generate_series(1,5001) g;
      UPDATE ot.agents SET parent_id=5005 WHERE id=1;
      INSERT INTO ot.work_items(org_id,slug,title,status,owner,owner_agent_id,created_by)
       VALUES(1,'w-05002','Deployment','deploy_ready','{\"node\":\"a1\",\"generation\":1}',1,'{}');").await.unwrap();
    let mut scan=Sweep::default();
    assert!(!scan.prepare(&c,1,true).await.unwrap());assert!(scan.everyone.is_empty());
    c.batch_execute("INSERT INTO ot.agents(org_id,name,state,tier,born) VALUES(1,'new-after-boundary','live','sol','fixture')").await.unwrap();
    assert_eq!(scan.work_after.as_deref(),Some("w-05000"));
    assert!(!all_blocked(&c,1).await.unwrap(),"an unblocked row after 5000 must veto blocked reminders");
    assert!(scan.prepare(&c,1,true).await.unwrap());
    let routed=scan.items("a5005",false);assert_eq!(routed.total,2);assert_eq!(routed.shown[0].role,"reviewer");assert_eq!(routed.shown[1].role,"deployer");
    assert_eq!(scan.items("a1",true).total,5000);assert_eq!(scan.items("a1",true).shown.len(),20);
    eprintln!("reminder_pages: reporting/work beyond5000 and late reviewer routed; whole-org veto and20+omitted display pass");
    let mut after=0;let mut seen=Vec::new();
    loop {let rows=agent_rows(&c,1,false,after,scan.upper).await.unwrap();assert!(rows.len()<=AGENTS as usize);
        if rows.is_empty(){break}for r in rows {after=r.get(0);seen.push(after);}}
    assert_eq!(seen.len(),5005);assert_eq!(seen.last(),Some(&5005));
    c.batch_execute("UPDATE ot.agents SET halt='{}' WHERE id=1; UPDATE ot.agents SET frozen='{}' WHERE id=2;
      UPDATE ot.agents SET limit_locked=true WHERE id=3; UPDATE ot.agents SET inflight_at=now() WHERE id=4;
      UPDATE ot.agents SET extra='{\"session\":\"signed-in\"}' WHERE id=5;
      INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state)
       VALUES('waking',1,'@system','agent',6,'a6','wake','pending');").await.unwrap();
    let early=agent_rows(&c,1,true,0,10).await.unwrap();
    assert_eq!(early.iter().map(|r|r.get::<_,i64>(0)).collect::<Vec<_>>(),vec![7,8,9,10]);
    eprintln!("reminder_pages: agent continuation beyond5000, finite boundary, sign-in and admission exclusions pass");
    c.batch_execute("UPDATE ot.work_items SET status='blocked' WHERE status<>'blocked'").await.unwrap();
    assert!(all_blocked(&c,1).await.unwrap());
    c.batch_execute("UPDATE ot.work_items SET archived_at=now()").await.unwrap();
    assert!(!all_blocked(&c,1).await.unwrap());
    c.batch_execute("INSERT INTO ot.work_items(org_id,slug,title,status,created_by) VALUES(1,'backlog','Backlog','backlogged','{}'),(1,'done','Done','done','{}');
       INSERT INTO ot.work_items(org_id,slug,title,status,created_by,extra) VALUES(1,'deleted','Deleted','open','{}','{\"deleted\":true}');").await.unwrap();
    assert!(!all_blocked(&c,1).await.unwrap());
    eprintln!("reminder_pages: complete all-blocked true, empty/archived/backlog/deleted false pass");
    let project_off:i64=c.query_one("INSERT INTO ot.agents(org_id,name,state,tier,born,kind,scope) VALUES(1,'off','live','','fixture','project','{\"mail_queue\":\"ack\",\"mail_queue_ack_timeout\":false}') RETURNING id",&[]).await.unwrap().get(0);
    let project_on:i64=c.query_one("INSERT INTO ot.agents(org_id,name,state,tier,born,kind,scope) VALUES(1,'on','live','','fixture','project','{\"mail_queue\":\"ack\",\"mail_queue_ack_timeout\":true}') RETURNING id",&[]).await.unwrap().get(0);
    c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra)
       SELECT 'job-'||g,1,'@user','agent',CASE WHEN g<=20 THEN $1::bigint ELSE $2::bigint END,'project','job','read',
        jsonb_build_object('claimed',jsonb_build_object('by_id',1,'ack',true,'copy','copy-'||g,'wakes',0)) FROM generate_series(1,41) g",&[&project_off,&project_on]).await.unwrap();
    c.execute("INSERT INTO ot.slot_leases(uid,org_id,project_id,holder_agent_id,slot_no,slot_count)
       SELECT 'lease-'||g,1,CASE WHEN g<=20 THEN $1::bigint ELSE $2::bigint END,1,g,CASE WHEN g=41 THEN 3 ELSE 1 END FROM generate_series(1,41) g",&[&project_off,&project_on]).await.unwrap();
    for (key,is_slot) in [(crate::domain::checkup_pages::JOBS,false),(crate::domain::checkup_pages::SLOTS,true)] {
        let mut ids=Vec::new();
        for (n,expected) in [20usize,20,1].into_iter().enumerate() {
            let rows=if is_slot {crate::domain::slots::idle_timeouts_page(&c,1).await.unwrap()} else {crate::domain::projects::ack_timeouts_page(&c,1).await.unwrap()};
            assert_eq!(rows.len(),expected);
            for r in &rows {ids.push(r.get::<_,i64>(0));let scope:serde_json::Value=r.get(if is_slot{6}else{3});
                assert_eq!(crate::domain::projects::ack_timeout(&scope),n!=0);}
            crate::domain::checkup_pages::advance(&c,1,key,&rows).await.unwrap();
            if n==0 {
                // New arrivals must not extend the in-progress rotation and
                // indefinitely postpone a second visit to its oldest holds.
                if is_slot {
                    c.execute("INSERT INTO ot.slot_leases(uid,org_id,project_id,holder_agent_id,slot_no) VALUES('lease-new',1,$1,1,42)",&[&project_on]).await.unwrap();
                } else {
                    c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES('job-new',1,'@user','agent',$1,'on','new','read','{\"claimed\":{\"by_id\":1,\"ack\":true,\"copy\":\"new-copy\"}}')",&[&project_on]).await.unwrap();
                }
            }
        }
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(),41);
        // A fresh read uses the persisted cursor, then wraps after the last ID.
        let wrapped=if is_slot {crate::domain::slots::idle_timeouts_page(&c,1).await.unwrap()} else {crate::domain::projects::ack_timeouts_page(&c,1).await.unwrap()};
        assert_eq!(wrapped[0].get::<_,i64>(0),ids[0]);assert_eq!(wrapped.len(),20);
    }
    eprintln!("reminder_pages:41 jobs and41 leases each20/20/1 then wrap; timeout-off prefix cannot starve enabled tail; multi-slot lease kept whole");
    c.batch_execute("SET enable_seqscan=off; ANALYZE ot.work_items;").await.unwrap();
    let plan=c.query(&format!("EXPLAIN SELECT 1 FROM ot.work_items WHERE org_id=1 AND {UNFINISHED} AND status<>'blocked' LIMIT 1"),&[]).await.unwrap();
    assert!(plan.iter().any(|r|r.get::<_,String>(0).contains("work_items_reminder_unblocked")));
    eprintln!("reminder_pages:0057 migration applied; exact all-blocked counterexample probe uses active-only index");
    drop(c);conn.await.unwrap();
}
