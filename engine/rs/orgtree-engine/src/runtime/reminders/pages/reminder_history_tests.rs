use super::*;

#[tokio::test]
#[ignore = "requires an isolated reminder_pages_fixture database and role"]
async fn working_only_skips_retired_history_and_docket_routes_relevant_chains() {
    let url = std::env::var("ORGTREE_REMINDER_PAGES_TEST_URL").unwrap();
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("reminder_pages_fixture"));
    assert_eq!(cfg.get_user(), Some("reminder_pages_fixture"));
    let (mut client, conn) = cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let conn = tokio::spawn(async move { conn.await.unwrap() });
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let c = client.transaction().await.unwrap();
    // Explicit fixture IDs and rollback keep the sibling identity-sequence
    // controls independent of test order. No real org/profile is involved.
    c.batch_execute("INSERT INTO ot.orgs(id,uuid,slug,name) OVERRIDING SYSTEM VALUE
      VALUES(1001,'00000000-0000-4000-8000-000000001001','history-fixture','History fixture');
      INSERT INTO ot.agents(id,org_id,name,state,tier,born,last_status) OVERRIDING SYSTEM VALUE VALUES
       (1000001,1001,'worker','live','sol','fixture','{\"status\":\"working\",\"at\":\"2000-01-01T00:00:00Z\"}'),
       (1000002,1001,'boss','live','sol','fixture',NULL),
       (1000003,1001,'retired-parent','archived','sol','fixture',NULL),
       (1000004,1001,'reviewer','live','sol','fixture',NULL),
       (1000005,1001,'retired-cycle','archived','sol','fixture',NULL),
       (1000006,1001,'wrapper','live','','fixture',NULL),
       (1000007,1001,'cycle-worker','live','sol','fixture',NULL),
       (1000008,1001,'retired-cycle-peer','archived','sol','fixture',NULL);
      UPDATE ot.agents SET kind='project' WHERE id=1000006;
      UPDATE ot.agents SET parent_id=1000006 WHERE id=1000001;
      UPDATE ot.agents SET parent_id=1000003 WHERE id=1000006;
      UPDATE ot.agents SET parent_id=1000002 WHERE id=1000003;
      UPDATE ot.agents SET parent_id=1000005 WHERE id IN (1000008,1000007);
      UPDATE ot.agents SET parent_id=1000008 WHERE id=1000005;
      INSERT INTO ot.agents(id,org_id,name,state,tier,born) OVERRIDING SYSTEM VALUE
       SELECT 2000000+g,1001,'unrelated-retired-'||g,'archived','sol','fixture' FROM generate_series(1,6001) g;").await.unwrap();
    let mut scan = Sweep::default();
    let ready = scan.prepare(&c, 1001, false).await.unwrap();
    eprintln!("working-only: first-tick-ready={ready}, reporting rows loaded={}", scan.routing_rows);
    assert!(ready, "working-only checkups must not wait for retired reporting pages");
    assert_eq!(scan.routing_rows, 0, "no reporting/docket preparation with idle reminders off");
    assert_eq!(scan.upper, 1000007, "finite wake boundary uses live agents, not retired history");
    assert!(scan.work_upper.is_none());
    let rows = agent_rows(&c, 1001, false, 0, scan.upper).await.unwrap();
    assert!(rows.iter().any(|r| r.get::<_,i64>(0) == 1000001));
    let sw = super::super::Switches { checkups:true, idle:false, blocked:true };
    assert_eq!(super::super::wakes(sw, false, true, false), (false,true));
    c.batch_execute("INSERT INTO ot.work_items(org_id,slug,title,status,owner,owner_agent_id,created_by,reviewer,reviewer_agent_id) VALUES
      (1001,'deploy','Deployment','deploy_ready','{\"node\":\"worker\",\"generation\":1}',1000001,'{}',NULL,NULL),
      (1001,'review','Review','review','{\"node\":\"worker\",\"generation\":1}',1000001,'{}','{\"node\":\"reviewer\",\"generation\":1}',1000004),
      (1001,'stale','Stale reviewer','review','{\"node\":\"worker\",\"generation\":1}',1000001,'{}','{\"node\":\"reviewer\",\"generation\":1}',9999999),
      (1001,'reused','Reused owner','deploy_ready','{\"node\":\"worker\",\"generation\":1}',9999999,'{}',NULL,NULL),
      (1001,'cycle','Cycle owner','deploy_ready','{\"node\":\"cycle-worker\",\"generation\":1}',1000007,'{}',NULL,NULL);").await.unwrap();
    assert!(scan.prepare(&c, 1001, true).await.unwrap(), "mode change must start docket preparation immediately");
    assert_eq!(scan.routing_rows, 7, "only three referenced agents and their four needed ancestors are loaded");
    assert_eq!(scan.items("boss",false).total,0,"deploy_ready is never listed, not even for its deployer");
    let reviewer=scan.items("reviewer",false); assert_eq!(reviewer.total,1); assert_eq!(reviewer.shown[0].role,"reviewer");
    let worker=scan.items("worker",false); assert_eq!(worker.total,1);
    assert!(worker.shown.iter().any(|r|r.role=="stale_reviewer"));
    assert_eq!(scan.items("cycle-worker",false).total,0);
    assert!(scan.everyone.is_empty(), "routing map is page-local, not retained history");
    eprintln!("docket: reporting rows loaded={} despite6001 unrelated retired rows; reviewer/deployer/generation/project/cycle controls pass",scan.routing_rows);
    c.rollback().await.unwrap(); drop(client); conn.await.unwrap();
}
