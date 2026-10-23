//! Supplied disposable database only; no engine, CLI, warming or live auth.
use super::*;

#[tokio::test]
#[ignore = "requires an explicitly owned disposable PostgreSQL fixture"]
#[nolog]
async fn five_thousand_scope_ancestors_keep_project_transparency_and_refusals() {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let (mut client, connection) = fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection = tokio::spawn(connection);
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let tx = client.transaction().await.unwrap();
    let org: i64 = tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),gen_random_uuid()::text,'Deep scope test') RETURNING id", &[]).await.unwrap().get(0);
    tx.execute(
        "WITH ids AS MATERIALIZED (SELECT g,nextval(pg_get_serial_sequence('ot.agents','id')) AS id FROM generate_series(1,5000) g),
         nodes AS (SELECT g,id,lag(id) OVER(ORDER BY g) AS parent FROM ids)
         INSERT INTO ot.agents(id,org_id,name,parent_id,kind,tier,state,born,scope) OVERRIDING SYSTEM VALUE
         SELECT id,$1,'scope-'||g,parent,CASE WHEN g%2=1 THEN 'project' ELSE 'agent' END,
           CASE WHEN g%2=1 THEN 'project' ELSE 'sol' END,'live','synthetic',
           CASE WHEN g%2=1 THEN '{\"tools\":{\"bash\":false,\"mcp\":[]}}'::jsonb
                WHEN g=2 THEN '{\"tools\":{\"bash\":true,\"web\":false,\"mcp\":[\"allowed\"]}}'::jsonb
                ELSE '{\"tools\":{\"bash\":true,\"web\":true,\"mcp\":[\"*\"]}}'::jsonb END
         FROM nodes ORDER BY g", &[&org]).await.unwrap();
    let leaf: i64 = tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='scope-5000'", &[&org]).await.unwrap().get(0);
    let caller = Caller { org_id: org, org_slug: "synthetic".into(), agent_id: leaf, name: "scope-5000".into() };
    let started = std::time::Instant::now();
    let tools = caller_tools_in(&tx, &caller).await.unwrap();
    assert_eq!(tools["bash"], true, "project scopes are transparent");
    assert_eq!(tools["web"], false, "outer agent scope remains a ceiling");
    assert_eq!(tools["mcp"], json!(["allowed"]));
    eprintln!("CALLER_SCOPE_DEPTH_MEASURE depth=5000 seconds={:.6} bash={} web={} mcp={}", started.elapsed().as_secs_f64(), tools["bash"], tools["web"], tools["mcp"]);

    let outside = Caller { org_id: -1, ..caller.clone() };
    assert!(caller_tools_in(&tx, &outside).await.is_err(), "wrong org is refused");
    let missing = Caller { agent_id: -1, ..caller.clone() };
    assert!(caller_tools_in(&tx, &missing).await.is_err(), "missing caller is refused");
    tx.execute("UPDATE ot.agents SET parent_id=$1 WHERE org_id=$2 AND name='scope-1'", &[&leaf, &org]).await.unwrap();
    assert!(caller_tools_in(&tx, &caller).await.is_err(), "cycle is refused");
    tx.rollback().await.unwrap();
    drop(client);
    connection.await.unwrap().unwrap();
}
