use super::prompt::{self, Mail};
use serde_json::{json, Value};
use std::collections::HashMap;

#[nolog]
fn message(i: usize, bytes: usize) -> Mail {
    Mail { uid: format!("fixture-{i}"), sender: "sender".into(), kind: "message".into(), body: "x".repeat(bytes),
        at: chrono::DateTime::from_timestamp(0,0).unwrap(), attachments: json!([]), notice: i>0, urgent:false,
        reply_to: Value::Null, replies: json!([]), ev: Value::Null, via_project:None, via_project_ack:false }
}

/// Exercise the actor's actual claiming SQL, not a second row-cap model.
#[nolog]
fn actor_sql(needle: &str) -> String {
    source_sql(include_str!("actor.rs"),needle)
}
#[nolog]
fn source_sql(source:&str,needle: &str) -> String {
    let start=source.find(&format!("\"{needle}")).expect("production query located");
    let mut escaped=false;
    let mut end=start+1;
    for (i,c) in source[start+1..].char_indices() {
        if c=='"'&&!escaped {end=start+1+i;break;}
        if c=='\\' {escaped=!escaped;} else {escaped=false;}
    }
    serde_json::from_str(&source[start..=end].replace('\r',"").replace('\n',"\\n")).unwrap()
}

#[test]
fn byte_limited_batch_announces_automatic_ordered_followup() {
    let input:Vec<_>=(0..101).map(|i|message(i,12_000)).collect();
    let mut seen=Vec::new();
    while seen.len()<input.len() {
        let b=prompt::batch(&input[seen.len()..],"context",&HashMap::new(),None,prompt::OTHER_INPUT_BYTES,false).unwrap();
        assert!(!b.mail.is_empty()&&b.text.len()<=prompt::OTHER_INPUT_BYTES);
        let remaining=input.len()-seen.len()-b.mail.len();
        if remaining>0 {assert!(b.text.contains("automatically")&&b.text.contains(&format!("{remaining}")),"batch must tell the agent that ordered mail follows automatically");}
        seen.extend(b.mail.into_iter().map(|m|m.uid));
    }
    assert_eq!(seen,input.iter().map(|m|m.uid.clone()).collect::<Vec<_>>());
}

#[tokio::test]
#[ignore="requires isolated mail_overflow_fixture cluster; never an ambient DB"]
async fn waking_notice_backlog_reaches_input_without_inbox_reads() {
    let url=std::env::var("ORGTREE_MAIL_OVERFLOW_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg:tokio_postgres::Config=url.parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("mail_overflow_fixture"));
    assert_eq!(cfg.get_user(),Some("mail_overflow_fixture"));
    let (client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move{connection.await.unwrap();});
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; CREATE SCHEMA ot; CREATE TABLE ot.orgs(id bigint PRIMARY KEY,settings jsonb); INSERT INTO ot.orgs VALUES(1,'{}');
        CREATE TABLE ot.mail(id bigint PRIMARY KEY,uid text,sender text,recipient_agent_id bigint,state text,turn_id bigint,org_id bigint,notice boolean,urgent boolean,body text,created_at timestamptz,ev jsonb,extra jsonb);
        CREATE FUNCTION ot.agent_dnd(bigint) RETURNS boolean LANGUAGE sql AS 'SELECT false';").await.unwrap();
    let claim=actor_sql("WITH oldest AS");
    for bytes in [30usize,12_000] {
        client.batch_execute("TRUNCATE ot.mail").await.unwrap();
        let input:Vec<_>=(0..101).map(|i|message(i,bytes)).collect();
        for (i,m) in input.iter().enumerate() {client.execute("INSERT INTO ot.mail VALUES($1,$2,'sender',1,'pending',NULL,1,$3,false,$4,now(),'{}','{}')",&[&(i as i64+1),&m.uid,&m.notice,&m.body]).await.unwrap();}
        let mut seen=Vec::new();
        for turn in 1..=101i64 {
            let rows=client.query(&claim,&[&1i64,&turn]).await.unwrap();
            let mut claimed:Vec<(i64,Value)>=rows.iter().map(|r|(r.get(0),r.get(1))).collect();claimed.sort_by_key(|r|r.0);
            assert!(!claimed.is_empty(),"automatic admission must make progress");
            let messages:Vec<Mail>=claimed.iter().map(|(_,r)|{let mut m=message(0,0);m.uid=r["uid"].as_str().unwrap().into();m.notice=r["notice"].as_bool().unwrap();m.body=r["body"].as_str().unwrap().into();m}).collect();
            let batch=prompt::batch(&messages,"",&HashMap::new(),None,prompt::OTHER_INPUT_BYTES,false).unwrap();
            let deferred:Vec<i64>=claimed[batch.mail.len()..].iter().map(|r|r.0).collect();
            if !deferred.is_empty() {let sql=actor_sql("UPDATE ot.mail SET state='pending', turn_id=NULL, extra=CASE");client.execute(&sql,&[&1i64,&turn,&deferred,&true]).await.unwrap();}
            let selected:Vec<i64>=claimed[..batch.mail.len()].iter().map(|r|r.0).collect();
            client.execute("UPDATE ot.mail SET state='delivered' WHERE id=ANY($1)",&[&selected]).await.unwrap();
            assert!(batch.text.len()<=prompt::OTHER_INPUT_BYTES);
            seen.extend(batch.mail.into_iter().map(|m|m.uid));
            let waiting:i64=client.query_one("SELECT count(*) FROM ot.mail WHERE state='pending'",&[]).await.unwrap().get(0);
            if waiting==0 {break;}
            let wake:i64=client.query_one("SELECT count(*) FROM ot.mail WHERE state='pending' AND (NOT notice OR extra->>'input_budget_deferred'='true' OR extra->>'dnd_released'='true')",&[]).await.unwrap().get(0);
            assert!(wake>0,"pending notices must guarantee another admission instead of being stranded after row64");
        }
        assert_eq!(seen,input.iter().map(|m|m.uid.clone()).collect::<Vec<_>>(),"all101 in original order, no inbox read");
    }
    drop(client);connection.await.unwrap();
}

#[tokio::test]
#[ignore="requires isolated mail_overflow_fixture cluster; never an ambient DB"]
async fn explicit_fetch_consumes_received_pending_mail_outside_dnd() {
    let url=std::env::var("ORGTREE_MAIL_OVERFLOW_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg:tokio_postgres::Config=url.parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("mail_overflow_fixture"));assert_eq!(cfg.get_user(),Some("mail_overflow_fixture"));
    let (client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move{connection.await.unwrap();});
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; CREATE SCHEMA ot;
        CREATE TABLE ot.mail(uid text,kind text DEFAULT 'message',org_id bigint DEFAULT 1,net_id text,net_hub text,sender_agent_id bigint,recipient_agent_id bigint,state text,urgent boolean DEFAULT false,extra jsonb DEFAULT '{}',read_at timestamptz,delivered_at timestamptz);
        CREATE FUNCTION ot.agent_dnd(bigint) RETURNS boolean LANGUAGE sql AS 'SELECT false';
        INSERT INTO ot.mail(uid,recipient_agent_id,state) VALUES('opened',1,'pending'),('preview',1,'pending'),('already-delivered',1,'delivered'),('someone-else',2,'pending');").await.unwrap();
    let sql=source_sql(include_str!("../domain/mail.rs"),"UPDATE ot.mail SET state='read'");
    let ids=vec!["opened".to_string(),"already-delivered".to_string(),"someone-else".to_string()];
    let read=client.query(&sql,&[&1i64,&ids]).await.unwrap();
    assert_eq!(read.iter().map(|r|r.get::<_,String>(0)).collect::<Vec<_>>(),vec!["opened"],"successful content fetch must consume own pending mail even outside DND");
    assert!(client.query(&sql,&[&1i64,&ids]).await.unwrap().is_empty(),"repeat chunk cannot consume twice");
    let preview:String=client.query_one("SELECT state FROM ot.mail WHERE uid='preview'",&[]).await.unwrap().get(0);assert_eq!(preview,"pending");
    drop(client);connection.await.unwrap();
}
