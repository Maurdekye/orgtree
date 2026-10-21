//! Two-connection barrier against an explicitly supplied disposable rig cluster.
use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires the explicitly isolated listener-bounds rig cluster"]
#[nolog]
async fn claim_boundary_stale_reclaim() {
    let root=std::env::var("ORGTREE_CLAIM_TEST_ROOT").expect("synthetic root").replace('\\',"/");
    assert!(root.starts_with("D:/orgtree-work/rig/taskbar-orgs-sol-listener-bounds/runs/"));
    let cfg:tokio_postgres::Config=std::env::var("ORGTREE_CLAIM_TEST_URL").expect("scratch connection").parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("orgtree_engine"));
    assert_eq!(cfg.get_user(),Some("orgtree_admin"));
    let org:i64=std::env::var("ORGTREE_CLAIM_TEST_ORG").unwrap().parse().unwrap();
    let mut failures=Vec::new();
    for mode in ["other-holder","user-holder","same-holder-new-copy","acked","holder-recovered"] {
        let (mut b,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
        let project:i64=b.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,scope,born) VALUES($1,$2,'project','project','live','{\"mail_queue\":\"ack\"}', 'synthetic') RETURNING id",&[&org,&uid("claim-project")]).await.unwrap().get(0);
        let holder:i64=b.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,halt,born) VALUES($1,$2,$3,'sol','live','{\"phase\":\"halted\"}','synthetic') RETURNING id",&[&org,&uid("claim-owner"),&project]).await.unwrap().get(0);
        let other:i64=b.query_one("INSERT INTO ot.agents(org_id,name,parent_id,tier,state,born) VALUES($1,$2,$3,'sol','live','synthetic') RETURNING id",&[&org,&uid("claim-other"),&project]).await.unwrap().get(0);
        let first=uid("copy-first");let second=uid("copy-second");
        let row:i64=b.query_one("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,extra) VALUES($1,$2,'@user','agent',$3,'fixture','job','read',$4) RETURNING id",&[&uid("claim-job"),&org,&project,&json!({"attempts":1,"claimed":{"by_id":holder,"by":"fixture","copy":first,"ack":true,"at":iso(Utc::now())}})]).await.unwrap().get(0);
        // B owns the project lock while A starts reclaim with the OLD holder.
        let tx=b.transaction().await.unwrap();tx.query_one("SELECT id FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await.unwrap();
        let (mut a,conn)=cfg.connect(NoTls).await.unwrap();tokio::spawn(async move{let _=conn.await;});
        let (started,wait)=tokio::sync::oneshot::channel();
        let mut task=tokio::spawn(async move{
            let tx=a.transaction().await.unwrap();let _=started.send(());
            let got=reclaim_in(&tx,org,project,row,holder,"fixture","was halted","released","failed",false).await.unwrap().is_some();
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
