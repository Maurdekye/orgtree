//! Supplied disposable database only; no engine, CLI, warming or live auth.
use super::*;

#[tokio::test]
#[ignore = "requires an explicitly owned disposable PostgreSQL fixture"]
#[nolog]
async fn five_thousand_ancestors_preserve_outer_scope_and_root_first_order() {
    let fixture = crate::domain::native_fixture::Fixture::from_env().await;
    let (mut client, connection) = fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection = tokio::spawn(async move { connection.await });
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let tx = client.transaction().await.unwrap();
    let org: i64 = tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),gen_random_uuid()::text,'Deep chain test') RETURNING id", &[]).await.unwrap().get(0);
    tx.execute("WITH ids AS MATERIALIZED (SELECT g,nextval(pg_get_serial_sequence('ot.agents','id')) AS id FROM generate_series(1,5000) g), nodes AS (SELECT g,id,lag(id) OVER(ORDER BY g) AS parent FROM ids) INSERT INTO ot.agents(id,org_id,name,parent_id,tier,state,born,scope) OVERRIDING SYSTEM VALUE SELECT id,$1,'deep-'||g,parent,'sol','live','synthetic',CASE WHEN g=1 THEN '{\"tools\":{\"bash\":false},\"org_visibility\":\"self\",\"permission_mode\":\"plan\"}'::jsonb ELSE '{\"tools\":{\"bash\":true},\"org_visibility\":\"full\",\"permission_mode\":\"bypassPermissions\"}'::jsonb END FROM nodes ORDER BY g", &[&org]).await.unwrap();
    let leaf: i64 = tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='deep-5000'", &[&org]).await.unwrap().get(0);
    let started = std::time::Instant::now();
    let path = chain(&tx, leaf).await.unwrap();
    let actual = path.len();
    let effective = capability(&tx, leaf, &json!({"dirs":[]})).await.unwrap();
    eprintln!("CHAIN_DEPTH_MEASURE depth=5000 ancestors={actual} seconds={:.6} bash={} visibility={} permission={}", started.elapsed().as_secs_f64(), effective["tools"]["bash"],effective["org_visibility"],effective["permission_mode"]);
    assert_eq!(effective["tools"]["bash"], false, "outer ancestor capability must not be lost");
    assert_eq!(effective["org_visibility"], "self");
    assert_eq!(effective["permission_mode"], "plan");
    assert_eq!(actual, 5000);
    for (i,n) in path.iter().enumerate() { assert_eq!(n.name, format!("deep-{}", i+1)); }
    // A malformed cycle is refused before rows are locked or scope is derived.
    tx.execute("UPDATE ot.agents SET parent_id=$1 WHERE org_id=$2 AND name='deep-1'", &[&leaf,&org]).await.unwrap();
    assert!(chain(&tx, leaf).await.is_err(), "cycle must not hang or silently truncate");
    tx.rollback().await.unwrap(); drop(client);
    connection.await.unwrap().unwrap();
}
