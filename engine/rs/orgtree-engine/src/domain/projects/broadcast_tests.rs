use super::*;

#[nolog]
async fn node(tx: &tokio_postgres::Transaction<'_>, org: i64, name: &str, parent: Option<i64>, kind: &str, state: &str) -> i64 {
    tx.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) VALUES($1,$2,$3,$4,$5,$6,'synthetic') RETURNING id",
        &[&org,&name,&parent,&kind,&if kind=="project" {"project"} else {"sol"},&state]).await.unwrap().get(0)
}

#[tokio::test]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn project_broadcast_preserves_deep_paging_caps_snapshot_and_cycle_safety() {
    let fixture=crate::domain::native_fixture::Fixture::from_env().await;
    let (mut client,connection)=fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move { connection.await });
    crate::migrate::run(&mut client,&|_|{}).await.unwrap();
    let tx=client.transaction().await.unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("broadcast-deep-{uuid}");
    let org:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,$2) RETURNING id",&[&uuid,&slug]).await.unwrap().get(0);
    let root=node(&tx,org,"root",None,"project","live").await;
    tx.execute("INSERT INTO ot.agents(org_id,name,kind,tier,state,born) SELECT $1,'project-'||n,'project','project','live','synthetic' FROM generate_series(1,2048) n ORDER BY n",&[&org]).await.unwrap();
    tx.execute("WITH ordered AS (SELECT id,lag(id,1,$2::bigint) OVER (ORDER BY id) parent FROM ot.agents WHERE org_id=$1 AND name LIKE 'project-%') UPDATE ot.agents a SET parent_id=o.parent FROM ordered o WHERE a.id=o.id",&[&org,&root]).await.unwrap();
    let bottom:i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='project-2048'",&[&org]).await.unwrap().get(0);
    tx.execute("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) SELECT $1,'member-'||n,$2,'agent','sol','live','synthetic' FROM generate_series(1,1050) n ORDER BY n",&[&org,&bottom]).await.unwrap();
    let first:i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='member-1'",&[&org]).await.unwrap().get(0);
    node(&tx,org,"excluded-agent-report",Some(first),"agent","live").await;
    let through:i64=tx.query_one("SELECT max(id) FROM ot.agents WHERE org_id=$1",&[&org]).await.unwrap().get(0);
    node(&tx,org,"late-member",Some(bottom),"agent","live").await;
    // A corrupt edge back to the root cannot duplicate recipients or loop.
    tx.execute("UPDATE ot.agents SET parent_id=$2 WHERE id=$1",&[&root,&bottom]).await.unwrap();
    let clock=std::time::Instant::now();let mut after=0;let mut actual=Vec::new();let mut pages=Vec::new();
    loop {
        let page=broadcast_members(&tx,root,BroadcastPage::Tool{after,through}).await.unwrap();
        if page.is_empty(){break}
        pages.push(page.len());after=page.last().unwrap().0;
        actual.extend(page.into_iter().map(|(_,name)| name));
    }
    let expected:Vec<String>=(1..=1050).map(|n|format!("member-{n}")).collect();
    assert_eq!(actual,expected,"tool pages include every project member exactly once, no agent reports or late IDs");
    assert_eq!(pages,vec![100,100,100,100,100,100,100,100,100,100,50]);
    let desktop=members(&tx,root).await.unwrap();
    assert_eq!(desktop,expected[..1000],"desktop retains its cap and sibling order at depth2048");
    std::fs::write(fixture.engine_root("broadcast-results").join("paging.json"),json!({"depth":2048,"tool_recipients":actual.len(),"desktop_recipients":desktop.len(),"pages":pages,"seconds":clock.elapsed().as_secs_f64(),"cycle":true,"late_id_excluded":true}).to_string()).unwrap();
    tx.rollback().await.unwrap();drop(client);connection.await.unwrap().unwrap();
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
    node(&tx,org,"retired-member",Some(root),"agent","archived").await;
    let retired=node(&tx,org,"retired-project",Some(root),"project","archived").await;
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
