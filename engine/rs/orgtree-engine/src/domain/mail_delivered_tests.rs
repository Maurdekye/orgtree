//! The two acknowledgements that settle claimed mail still run and still settle it, now that they
//! also say whether the user wrote a row (so the user's sent list is read again: the chats' check
//! mark, 4.7.0). Needs the isolated `orginbox_queue_fixture` database, like
//! domain/orginbox_queue_tests.rs; run alone:
//! `cargo test -p orgtree-engine -- --ignored --test-threads=1 domain::mail::delivered_tests`.
use super::*;
use tokio_postgres::NoTls;

#[tokio::test]
#[ignore = "requires an isolated orginbox_queue_fixture database"]
#[nolog]
async fn an_acknowledgement_settles_claimed_mail_and_knows_the_users_own() {
    let url = std::env::var("ORGTREE_ORGINBOX_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("orginbox_queue_fixture"));
    assert_eq!(cfg.get_user(), Some("orginbox_queue_fixture"));
    let (mut c, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    c.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut c, &|_| {}).await.unwrap();
    let org: i64 = c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES(gen_random_uuid(),'delivered-fixture','fixture','{}') RETURNING id", &[]).await.unwrap().get(0);
    let agent: i64 = c.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'boss','sol','live','2026-11-24') RETURNING id", &[&org]).await.unwrap().get(0);
    let engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_ORGINBOX_TEST_ROOT").expect("owned engine root")));
    let mut ids = Vec::new();
    for (uid, sender, turn) in [("m-d-1", "@user", 7i64), ("m-d-2", "mate", 7), ("m-d-3", "@user", 8), ("m-d-4", "@user", 9)] {
        let id: i64 = c.query_one("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,turn_id)
            VALUES($1,$2,$3,'agent',$4,'boss','hello','delivering',$5) RETURNING id", &[&uid, &org, &sender, &agent, &turn]).await.unwrap().get(0);
        ids.push(id);
    }
    let state = |uid: &'static str| { let c = &c; async move { c.query_one("SELECT state FROM ot.mail WHERE uid=$1", &[&uid]).await.unwrap().get::<_, String>(0) } };

    // one exact delivery of a turn
    let got = acknowledge(&engine, &c, agent, 7, &ids[..2]).await.unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!((state("m-d-1").await.as_str(), state("m-d-2").await.as_str(), state("m-d-3").await.as_str()), ("delivered", "delivered", "delivering"));
    // everything a finished turn still held
    let got = acknowledge_turn(&engine, &c, 8).await.unwrap();
    assert_eq!(got.iter().map(|(uid, _)| uid.as_str()).collect::<Vec<_>>(), vec!["m-d-3"]);
    assert_eq!((state("m-d-3").await.as_str(), state("m-d-4").await.as_str()), ("delivered", "delivering"));
    // the row the user's sent list is built from says so
    let raw: Value = c.query_one("SELECT to_jsonb(m) FROM ot.mail m WHERE uid='m-d-1'", &[]).await.unwrap().get(0);
    assert_eq!(crate::feed::compute::mail_entry(&raw)["delivered"], true);
    let raw: Value = c.query_one("SELECT to_jsonb(m) FROM ot.mail m WHERE uid='m-d-4'", &[]).await.unwrap().get(0);
    assert!(crate::feed::compute::mail_entry(&raw).get("delivered").is_none());
    // the sixth column the acknowledgements return: whether the user wrote the row
    let rows = c.query("UPDATE ot.mail SET state='delivered' WHERE turn_id=9 RETURNING uid,kind,org_id,net_id,net_hub,sender='@user'", &[]).await.unwrap();
    assert!(rows[0].try_get::<_, bool>(5).unwrap());
}
