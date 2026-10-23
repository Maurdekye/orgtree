use super::*;

#[nolog]
async fn node(tx: &tokio_postgres::Transaction<'_>, org: i64, name: &str, parent: Option<i64>, kind: &str, state: &str) -> i64 {
    tx.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) VALUES($1,$2,$3,$4,$5,$6,'synthetic') RETURNING id",
        &[&org,&name,&parent,&kind,&if kind=="project" {"project"} else {"sol"},&state]).await.unwrap().get(0)
}

#[tokio::test]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn project_broadcast_stops_at_agent_children() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let (mut client,connection)=fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move { connection.await });
    crate::migrate::run(&mut client,&|_|{}).await.unwrap();
    let tx=client.transaction().await.unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("broadcast-{uuid}");
    let org:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,$2) RETURNING id",&[&uuid,&slug]).await.unwrap().get(0);
    let root=node(&tx,org,"root",None,"project","live").await;
    let direct=node(&tx,org,"direct",Some(root),"agent","live").await;
    node(&tx,org,"agent-report",Some(direct),"agent","live").await;
    let hidden=node(&tx,org,"project-under-agent",Some(direct),"project","live").await;
    node(&tx,org,"hidden-report",Some(hidden),"agent","live").await;
    let project=node(&tx,org,"nested-project",Some(root),"project","live").await;
    let nested=node(&tx,org,"nested-member",Some(project),"agent","live").await;
    node(&tx,org,"nested-agent-report",Some(nested),"agent","live").await;
    let deeper=node(&tx,org,"deeper-project",Some(project),"project","live").await;
    node(&tx,org,"deep-member",Some(deeper),"agent","live").await;
    node(&tx,org,"retired-member",Some(root),"agent","retired").await;
    let retired=node(&tx,org,"retired-project",Some(root),"project","retired").await;
    node(&tx,org,"retired-branch",Some(retired),"agent","live").await;
    let other_uuid=uuid::Uuid::new_v4();let other_slug=format!("foreign-{other_uuid}");
    let other:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,$2) RETURNING id",&[&other_uuid,&other_slug]).await.unwrap().get(0);
    node(&tx,other,"foreign-member",Some(root),"agent","live").await;
    let foreign=node(&tx,other,"foreign-project",Some(root),"project","live").await;
    node(&tx,other,"foreign-nested",Some(foreign),"agent","live").await;
    let actual=members(&tx,root).await.unwrap();
    std::fs::write(fixture.engine_root("broadcast-results").join("topology.json"),json!({"actual":actual,"expected":["direct","nested-member","deep-member"]}).to_string()).unwrap();
    assert_eq!(actual,vec!["direct","nested-member","deep-member"],"broadcast crosses projects but stops at agent recipients");
    tx.rollback().await.unwrap();drop(client);connection.await.unwrap().unwrap();
}
