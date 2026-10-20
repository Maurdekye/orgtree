//! Synthetic native-history and PostgreSQL custody tests. No ambient database,
//! provider configuration, credentials or installed user history is consulted.
use super::opencode_mail::*;
use serde_json::json;

fn native_fixture() -> (tempfile::TempDir, std::path::PathBuf, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE session_v2(id TEXT PRIMARY KEY);
        CREATE TABLE session_inbox(id TEXT PRIMARY KEY, session_id TEXT, type TEXT);
        CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT);
        INSERT INTO session_v2 VALUES('ses_fixture');").unwrap();
    (dir, path, db)
}

#[test]
fn opencode_mail_native_pending_and_promoted_are_equivalent() {
    let (_dir, path, db) = native_fixture();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Absent);
    db.execute_batch("INSERT INTO session_inbox VALUES('msg_fixture','ses_fixture','user')").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Admitted);
    db.execute_batch("BEGIN; INSERT INTO session_message SELECT * FROM session_inbox;
        DELETE FROM session_inbox; COMMIT;").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Admitted);
}

#[test]
fn opencode_mail_native_identity_is_exact_and_never_reads_content() {
    let (_dir, path, db) = native_fixture();
    db.execute_batch("INSERT INTO session_message VALUES('msg_fixture','ses_other','user')").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Unknown);
    db.execute_batch("UPDATE session_message SET session_id='ses_fixture',type='assistant'").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Unknown);
    assert_eq!(native_evidence(&path, "missing_session", "msg_other"), Evidence::Unknown);
}

#[test]
fn opencode_mail_native_missing_corrupt_and_partial_schema_are_unknown() {
    let (dir, path, db) = native_fixture();
    assert_eq!(native_evidence(&dir.path().join("missing.db"), "ses_fixture", "msg_fixture"), Evidence::Unknown);
    assert!(!dir.path().join("missing.db").exists(), "read-only must not create a DB");
    db.execute_batch("DROP TABLE session_inbox").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Unknown);
    drop(db);
    std::fs::write(&path, b"not SQLite").unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Unknown);
}

#[test]
fn opencode_mail_native_sees_committed_wal_without_changing_it() {
    let (_dir, path, db) = native_fixture();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        INSERT INTO session_inbox VALUES('msg_fixture','ses_fixture','user')").unwrap();
    let wal = path.with_extension("db-wal");
    let before = std::fs::read(&wal).unwrap();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Admitted);
    assert_eq!(std::fs::read(&wal).unwrap(), before);
}

#[test]
fn opencode_mail_native_locked_is_bounded_unknown() {
    let (_dir, path, db) = native_fixture();
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let at = std::time::Instant::now();
    assert_eq!(native_evidence(&path, "ses_fixture", "msg_fixture"), Evidence::Unknown);
    assert!(at.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn opencode_mail_version_and_request_bounds_fail_closed() {
    assert!(supported(Some("2.0.28")));
    for version in [None, Some("2.0.27"), Some("2.0.29"), Some("2.0.28-dev"), Some("3.0.0")] {
        assert!(!supported(version));
    }
    assert!(request(&json!({"protocol":1,"op":"claim","sessionID":"ses_fixture"})).is_some());
    for value in [
        json!({"protocol":2,"op":"claim","sessionID":"ses_fixture"}),
        json!({"protocol":1,"op":"claim","sessionID":"../other"}),
        json!({"protocol":1,"op":"ack","sessionID":"ses_fixture","id":"not_message"}),
        json!({"protocol":1,"op":"read","sessionID":"ses_fixture"}),
        json!({"protocol":1,"op":"claim","sessionID":"x".repeat(129)}),
    ] { assert!(request(&value).is_none()); }
}

/// Deliberately ignored in ordinary workspace runs; the author rig creates a
/// fresh cluster with this exact role and database and runs --ignored explicitly.
#[tokio::test]
#[ignore = "requires isolated opencode_mail_fixture cluster"]
async fn opencode_mail_pg_custody_dnd_order_restart_duplicates_and_atomic_failure() {
    let url = std::env::var("ORGTREE_OPENCODE_MAIL_TEST_URL").expect("explicit synthetic URL required");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("opencode_mail_fixture"));
    assert_eq!(cfg.get_user(), Some("opencode_mail_fixture"));
    let (client, connection) = cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection = tokio::spawn(async move { connection.await.unwrap() });
    client.batch_execute("CREATE SCHEMA ot;
        CREATE TABLE ot.agents(id bigint PRIMARY KEY,org_id bigint,generation int,dnd bool);
        CREATE TABLE ot.turns(id bigint PRIMARY KEY,agent_id bigint);
        CREATE TABLE ot.orgs(id bigint PRIMARY KEY,settings jsonb);
        CREATE TABLE ot.mail(id bigint PRIMARY KEY,uid text,recipient_agent_id bigint,state text,
          turn_id bigint,org_id bigint,sender text,kind text DEFAULT 'message',body text,urgent bool,
          ev jsonb DEFAULT '{}',extra jsonb DEFAULT '{}',delivered_at timestamptz,net_id text,net_hub text);
        CREATE TABLE ot.convo(agent_id bigint,seq bigint,ver bigint,body jsonb
          CHECK(NOT body ? 'synthetic_reject'),tool_inputs jsonb,PRIMARY KEY(agent_id,seq));
        CREATE FUNCTION ot.agent_dnd(bigint) RETURNS boolean LANGUAGE sql AS
          'SELECT dnd FROM ot.agents WHERE id=$1';
        INSERT INTO ot.orgs VALUES(1,'{}');
        INSERT INTO ot.agents VALUES(1,1,1,true),(2,1,1,false);
        INSERT INTO ot.turns VALUES(10,1),(11,2);
        INSERT INTO ot.mail(id,uid,recipient_agent_id,state,org_id,sender,body,urgent)
          VALUES(1,'m1',1,'pending',1,'sender','normal',false),
                (2,'m2',1,'pending',1,'sender','urgent',true),
                (3,'m3',1,'pending',1,'sender','later',false),
                (4,'m4',2,'pending',1,'sender','other agent',false);").await.unwrap();
    client.batch_execute(include_str!("../../migrations/0042_opencode_mail.sql")).await.unwrap();
    let raw = claim(&client, 1, 10).await.unwrap();
    assert_eq!(raw.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![2]);
    let body = json!({"role":"user","text":"PRIVATE_CANARY","mail_ids":["m2"]});
    let batch = persist(&client, 1, 10, "ses_fixture", "PRIVATE_CANARY", &raw, &body).await.unwrap();
    let loaded = load(&client, 1).await.unwrap().unwrap();
    assert_eq!(batch.id, loaded.id, "actor reload retains provider id");
    assert_eq!(batch.text, loaded.text);
    assert!(claim(&client, 1, 10).await.unwrap().is_empty(), "outstanding custody blocks a second claim");
    assert!(acknowledge(&client, 2, "ses_fixture", &batch.id).await.unwrap().is_empty());
    assert!(acknowledge(&client, 1, "wrong", &batch.id).await.unwrap().is_empty());
    let receipts = acknowledge(&client, 1, "ses_fixture", &batch.id).await.unwrap();
    assert_eq!(receipts.len(), 1);
    assert!(acknowledge(&client, 1, "ses_fixture", &batch.id).await.unwrap().is_empty());
    assert!(load(&client, 1).await.unwrap().is_none());
    client.execute("UPDATE ot.agents SET dnd=false WHERE id=1", &[]).await.unwrap();
    let raw = claim(&client, 1, 10).await.unwrap();
    assert_eq!(raw.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1,3]);
    let batch = persist(&client, 1, 10, "ses_fixture", "more mail", &raw,
        &json!({"role":"user","synthetic_reject":true,"text":"PRIVATE_CANARY"})).await.unwrap();
    let failure = acknowledge(&client, 1, "ses_fixture", &batch.id).await.unwrap_err();
    assert!(!format!("{failure:?}").contains("PRIVATE_CANARY"));
    assert!(load(&client, 1).await.unwrap().is_some(), "rollback retains custody");
    let count: i64 = client.query_one("SELECT count(*) FROM ot.mail WHERE state='delivered'", &[]).await.unwrap().get(0);
    assert_eq!(count, 1, "ack and transcript must roll back together");
    assert!(release(&client, 1, &batch.id, true).await.unwrap());
    assert!(!release(&client, 1, &batch.id, true).await.unwrap(), "fallback happens once");
    assert!(load(&client, 1).await.unwrap().is_none(), "no held batch crosses a second turn boundary");
    assert!(claim(&client, 1, 10).await.unwrap().is_empty(), "ambiguous mail waits for ordinary next-turn delivery");
    let fallback: i64 = client.query_one("SELECT count(*) FROM ot.mail WHERE state='pending'
        AND extra->>'opencode_ambiguous'='true'", &[]).await.unwrap().get(0);
    assert_eq!(fallback, 2);
    let normal: i64 = client.query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id=2 AND state='pending'", &[]).await.unwrap().get(0);
    assert_eq!(normal, 1);
    drop(client); connection.await.unwrap();
}
