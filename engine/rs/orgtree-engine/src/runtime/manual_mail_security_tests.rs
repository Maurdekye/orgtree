//! Synthetic-only authorization/provenance regressions for the real fallback,
//! canonical read and conversation writer. Never connect to an ambient database.
use super::*;

#[test]
fn foreign_server_and_unqualified_names_are_not_dispatcher_receipts() {
    let args=json!({"action":"fetch","project":"restricted"});
    let body=json!({"messages":[{"id":"restricted-mail","direction":"received"}]}).to_string();
    for name in ["mcp__other_server__orgtree_inbox","orgtree_inbox","other__mcp__orgtree__orgtree_inbox"] {
        assert!(output(name,&args,&body).is_none(),"foreign or unqualified name accepted: {name}");
    }
    for name in ["default_api:call_mcp_tool","mcp__foreign__call_mcp_tool"] {
        let args=json!({"ServerName":"other_server","ToolName":"orgtree_inbox","Arguments":args});
        assert!(output(name,&args,&body).is_none(),"foreign wrapper accepted");
    }
    let spoof=json!({"ServerName":"orgtree_orgtree","ToolName":"orgtree_inbox","Arguments":args});
    assert!(output("mcp__foreign__call_mcp_tool",&spoof,&body).is_none(),"a foreign wrapper cannot assert a trusted server");
    let queue=json!({"resolved":true,"registered":false,"messages":[{"id":"restricted-mail","direction":"received"}]}).to_string();
    assert!(output("mcp__foreign__orgtree_watchdog",&json!({"action":"create","kind":"fair_queue"}),&queue).is_none());
    assert!(output("call_mcp_tool",&json!({"ServerName":"orgtree","server":"foreign","ToolName":"orgtree_inbox","Arguments":args}),&body).is_none(),"conflicting provenance aliases fail closed");
}

#[test]
fn only_matching_dispatcher_receipts_bind_and_private_metadata_never_reaches_a_chip() {
    let input=json!({"action":"fetch","project":"allowed"});
    let result=json!({"messages":[{"id":"known","direction":"received"}]}).to_string();
    let mut cards=std::collections::HashMap::new();
    let mut reads=std::collections::HashMap::new();
    bind_fallback(&cards,&mut reads,&["no-proof"],"mcp__orgtree__orgtree_inbox",&input,&result);
    assert!(reads.is_empty(),"even a trusted-looking name/result cannot issue a receipt");
    for name in ["mcp__orgtree__orgtree_inbox","default_api:mcp_orgtree_orgtree_orgtree_inbox","default_api:call_mcp_tool"] {
        crate::runtime::convo::record_tool_card(&mut cards,&mut reads,"mcp-card:orgtree_inbox:same".into(),json!({
            "_manual_mail_reads":[{"uid":"known","recipient":9}],"_mcp_tool":"orgtree_inbox",
            "_mcp_args":input,"_mcp_text":result}));
        let args=if name.ends_with("call_mcp_tool") {json!({"ServerName":"orgtree_orgtree","ToolName":"orgtree_inbox","Arguments":input})} else {input.clone()};
        bind_fallback(&cards,&mut reads,&["foreign"],"mcp__foreign__orgtree_inbox",&input,&result);
        assert!(!reads.contains_key("foreign"));
        bind_fallback(&cards,&mut reads,&["wrong-result"],name,&args,"{\"messages\":[]}");
        assert!(!reads.contains_key("wrong-result"));
        bind_fallback(&cards,&mut reads,&["wrong-args"],name,&json!({"action":"fetch","project":"restricted"}),&result);
        assert!(!reads.contains_key("wrong-args"));
        bind_fallback(&cards,&mut reads,&["real"],name,&args,&result);
        assert_eq!(reads.remove("real"),Some(vec![json!({"uid":"known","recipient":9})]));
        bind_fallback(&cards,&mut reads,&["replay"],name,&args,&result);
        assert!(!reads.contains_key("replay"));
    }
    // The native-ID path has dispatcher provenance directly and does not need
    // to treat an unqualified tool name as proof of a server identity.
    crate::runtime::convo::record_tool_card(&mut cards,&mut reads,"native-direct".into(),json!({"_manual_mail_reads":[{"uid":"personal","recipient":1}]}));
    assert_eq!(reads["native-direct"],vec![json!({"uid":"personal","recipient":1})]);
    let key=cards.keys().next().expect("private dispatcher metadata retained").clone();
    let card=crate::runtime::convo::take_matching_tool_card(&mut cards,&[&key],"orgtree_inbox",&input,&result,true).unwrap();
    assert!(card.get("_manual_mail_reads").is_none());
    assert!(card.get("_mcp_text").is_none());
}

#[nolog]
async fn fixture() -> (tokio_postgres::Client,tokio::task::JoinHandle<()>) {
    let url=std::env::var("ORGTREE_MAIL_OVERFLOW_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg:tokio_postgres::Config=url.parse().unwrap();
    assert_eq!(cfg.get_dbname(),Some("mail_overflow_fixture"));
    assert_eq!(cfg.get_user(),Some("mail_overflow_fixture"));
    let (client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move{connection.await.unwrap();});
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; CREATE SCHEMA ot;
        CREATE TABLE ot.orgs(id bigint PRIMARY KEY,settings jsonb);
        INSERT INTO ot.orgs VALUES(1,'{\"org_inbox_enabled\":false}'),(2,'{}');
        CREATE TABLE ot.agents(id bigint PRIMARY KEY,org_id bigint,name text,kind text,state text,parent_id bigint);
        INSERT INTO ot.agents VALUES(1,1,'reader','agent','live',9),(9,1,'allowed','project','live',NULL),
            (10,1,'restricted','project','live',NULL),(20,2,'other-org','project','live',NULL);
        CREATE TABLE ot.convo(agent_id bigint,seq bigint,ver bigint,body jsonb,tool_inputs jsonb,PRIMARY KEY(agent_id,seq));
        CREATE INDEX mail_receipts ON ot.convo USING gin ((body->'mail_ids')) WHERE body->>'role'='user';
        CREATE TABLE ot.mail(id bigint PRIMARY KEY,uid text,org_id bigint,recipient_agent_id bigint,recipient_kind text,
            sender text,recipient_name text,kind text,body text,created_at timestamptz,state text,notice boolean,
            urgent boolean,attachments jsonb,extra jsonb,ev jsonb);
        INSERT INTO ot.mail VALUES
        (1,'allowed-mail',1,9,'agent','sender','allowed','message','AUTHORIZED SYNTHETIC BODY',now(),'pending',false,false,'[]','{}','{}'),
        (2,'restricted-mail',1,10,'agent','sender','restricted','message','RESTRICTED SYNTHETIC CANARY',now(),'pending',false,false,'[]','{}','{}'),
        (3,'hidden-net',1,9,'agent','@net:synthetic','allowed','message','HIDDEN SYNTHETIC NET',now(),'pending',false,false,'[]','{}','{}'),
        (4,'hidden-org',1,9,'agent','@org:synthetic','allowed','message','HIDDEN SYNTHETIC ORG',now(),'pending',false,false,'[]','{}','{}'),
        (5,'hidden-event',1,9,'agent','sender','allowed','message','HIDDEN SYNTHETIC EVENT',now(),'pending',false,false,'[]','{}','{\"variant\":\"runtime.external_unroutable\"}'),
        (6,'hidden-transfer',1,9,'agent','sender','allowed','message','HIDDEN SYNTHETIC TRANSFER',now(),'pending',false,false,'[]','{\"transfer_failure\":true}','{}'),
        (7,'personal',1,1,'agent','sender','reader','message','PERSONAL SYNTHETIC BODY',now(),'read',false,false,'[]','{}','{}'),
        (8,'wrong-kind',1,9,'user','sender','allowed','message','WRONG RECIPIENT KIND',now(),'pending',false,false,'[]','{}','{}'),
        (9,'other-org',2,9,'agent','sender','allowed','message','WRONG ORGANIZATION',now(),'pending',false,false,'[]','{}','{}');").await.unwrap();
    (client,connection)
}

#[tokio::test]
#[ignore="requires isolated mail_overflow_fixture; never live data"]
async fn foreign_mcp_with_known_valid_restricted_uid_cannot_append_mail() {
    let (client,connection)=fixture().await;
    let mut writer=crate::runtime::convo::ConvoWriter::load(&client,1).await.unwrap();
    let args=json!({"action":"fetch","project":"restricted"});
    let result=json!({"messages":[{"id":"restricted-mail","direction":"received"}]}).to_string();
    let mut cards=std::collections::HashMap::new();
    let mut receipts=std::collections::HashMap::new();
    for (name,input) in [
        ("mcp__other_server__orgtree_inbox",args.clone()),
        ("default_api:call_mcp_tool",json!({"ServerName":"other_server","ToolName":"orgtree_inbox","Arguments":args})),
        ("mcp__foreign__call_mcp_tool",json!({"ServerName":"orgtree_orgtree","ToolName":"orgtree_inbox","Arguments":{"action":"fetch","project":"restricted"}}))] {
        writer.append(&client,json!({"role":"assistant","text":"","tools":[{"id":"foreign","name":name,"ended_at":"now"}]})).await.unwrap();
        bind_fallback(&cards,&mut receipts,&["foreign"],name,&input,&result);
        assert!(!receipts.contains_key("foreign"),"result JSON alone cannot create dispatcher receipts");
        let opened=receipts.remove("foreign").unwrap_or_default();
        let rows=unseen(&client,1,1,&opened).await.unwrap();
        if !rows.is_empty() {writer.append(&client,crate::runtime::actor::mail_row(&rows,None)).await.unwrap();}
    }
    // Even an apparently genuine native name cannot create a receipt from JSON.
    bind_fallback(&cards,&mut receipts,&["unissued"],"mcp__orgtree__orgtree_inbox",&args,&result);
    assert!(!receipts.contains_key("unissued"));
    // A real dispatcher receipt captured before a reach change still cannot be
    // rebound by a foreign tool, even with identical arguments/result.
    crate::runtime::convo::record_tool_card(&mut cards,&mut receipts,"mcp-card:orgtree_inbox:old".into(),json!({
        "_manual_mail_reads":[{"uid":"restricted-mail","recipient":10}],
        "_mcp_tool":"orgtree_inbox","_mcp_args":args,"_mcp_text":result}));
    bind_fallback(&cards,&mut receipts,&["foreign"],"mcp__foreign__orgtree_inbox",&args,&result);
    assert!(!receipts.contains_key("foreign"));
    let count:i64=client.query_one("SELECT count(*) FROM ot.convo WHERE body->>'role'='user'",&[]).await.unwrap().get(0);
    assert_eq!(count,0,"foreign output must never import canonical restricted mail into the transcript");
    drop(client);connection.await.unwrap();
}

#[tokio::test]
#[ignore="requires isolated mail_overflow_fixture; never live data"]
async fn canonical_read_rechecks_project_reach_visibility_and_receipt_pairs() {
    let (client,connection)=fixture().await;
    let requests=vec![json!({"uid":"allowed-mail","recipient":9}),json!({"uid":"restricted-mail","recipient":10}),
        json!({"uid":"hidden-net","recipient":9}),json!({"uid":"hidden-org","recipient":9}),
        json!({"uid":"hidden-event","recipient":9}),json!({"uid":"hidden-transfer","recipient":9}),
        json!({"uid":"wrong-kind","recipient":9}),json!({"uid":"other-org","recipient":9}),
        json!({"uid":"personal","recipient":10})];
    let rows=unseen(&client,1,1,&requests).await.unwrap();
    assert_eq!(rows.iter().map(|r|r["uid"].as_str().unwrap()).collect::<Vec<_>>(),vec!["allowed-mail"]);
    client.execute("UPDATE ot.orgs SET settings='{}' WHERE id=1",&[]).await.unwrap();
    let rows=unseen(&client,1,1,&requests).await.unwrap();
    assert_eq!(rows.len(),5,"only normal visible project mail becomes available when org inbox is enabled");
    client.execute("UPDATE ot.agents SET parent_id=NULL WHERE id=1",&[]).await.unwrap();
    assert!(unseen(&client,1,1,&requests).await.unwrap().is_empty(),"a completed dispatcher receipt cannot survive revoked project reach");
    assert_eq!(unseen(&client,1,1,&[json!({"uid":"personal","recipient":1})]).await.unwrap().len(),1);
    assert!(unseen(&client,1,2,&requests).await.unwrap().is_empty());
    drop(client);connection.await.unwrap();
}

#[tokio::test]
#[ignore="requires isolated mail_overflow_fixture; never live data"]
async fn genuine_authorized_read_projects_once_after_tool_and_does_not_claim_mail() {
    let (client,connection)=fixture().await;
    let mut writer=crate::runtime::convo::ConvoWriter::load(&client,1).await.unwrap();
    let name="default_api:call_mcp_tool";
    let args=json!({"action":"fetch","project":"allowed"});
    let wrapped=json!({"ServerName":"orgtree_orgtree","ToolName":"orgtree_inbox","Arguments":args});
    let result=json!({"messages":[{"id":"allowed-mail","direction":"received"}]}).to_string();
    let tool=writer.append(&client,json!({"role":"assistant","text":"","tools":[{"id":"trusted","name":name,"ended_at":"now"}]})).await.unwrap();
    let mut cards=std::collections::HashMap::new();
    let mut receipts=std::collections::HashMap::new();
    crate::runtime::convo::record_tool_card(&mut cards,&mut receipts,"mcp-card:orgtree_inbox:real".into(),json!({
        "_manual_mail_reads":[{"uid":"allowed-mail","recipient":9}],
        "_mcp_tool":"orgtree_inbox","_mcp_args":args,"_mcp_text":result}));
    bind_fallback(&cards,&mut receipts,&["trusted"],name,&wrapped,&result);
    let opened=receipts.remove("trusted").expect("genuine ID-less dispatcher receipt binds");
    let raw=unseen(&client,1,1,&opened).await.unwrap();
    assert_eq!(raw.len(),1);
    let row=writer.append(&client,crate::runtime::actor::mail_row(&raw,None)).await.unwrap();
    assert_eq!(row,tool+1);
    let _:crate::runtime::convo::ConvoWriter=crate::runtime::convo::ConvoWriter::load(&client,1).await.unwrap();
    assert!(unseen(&client,1,1,&opened).await.unwrap().is_empty());
    let state:String=client.query_one("SELECT state FROM ot.mail WHERE uid='allowed-mail'",&[]).await.unwrap().get(0);
    assert_eq!(state,"pending");
    drop(client);connection.await.unwrap();
}
