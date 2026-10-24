//! Codex reasoning is often sealed. Save its existence, never its ciphertext.
mod rows;
mod timing;
pub use rows::row;
pub use timing::{Timing, timed_row};
#[cfg(test)]
use serde_json::json;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_thinking_sealed_step_keeps_identity_without_encrypted_or_invented_text() {
        let r=row(&json!({"id":"rs-1","type":"reasoning","summary":[],"content":[],"encrypted_content":"PRIVATE_CIPHER_CANARY"}),None,"now");
        assert_eq!(r["assistant_id"],"rs-1");assert_eq!(r["thinking_sealed"],true);
        assert_eq!(r["thinking"],"");assert_eq!(r["text"],"");assert!(r["tools"].as_array().unwrap().is_empty());
        assert!(r.get("think_secs").is_none());assert!(r.get("thinking_tokens").is_none());
        assert!(r.get("content_blocks").is_none());assert!(!r.to_string().contains("PRIVATE_CIPHER_CANARY"));
    }
    #[test]
    fn codex_thinking_readable_summary_and_content_fallback_keep_unicode_and_bounds() {
        let r=row(&json!({"id":"a","summary":["Readable 🦀","next line"],"content":["fallback"]}),None,"now");
        assert_eq!(r["thinking"],"Readable 🦀\nnext line");assert_eq!(r["thinking_sealed"],false);
        let r=row(&json!({"id":"b","summary":["  "],"content":["Fallback 🦀"]}),None,"now");
        assert_eq!(r["thinking"],"Fallback 🦀");
        let r=row(&json!({"id":"c","summary":["🦀".repeat(20_001)]}),None,"now");
        assert_eq!(r["thinking"].as_str().unwrap().chars().count(),20_000);
    }
    #[test]
    fn codex_thinking_replay_and_readable_upgrade_preserve_attached_tools() {
        let item=json!({"id":"same","summary":[]});let mut r=row(&item,None,"original");
        r["seq"]=json!(17);r["tools"]=json!([{"id":"tool-1","name":"Read","result":"kept"}]);
        let r=row(&json!({"id":"same","summary":["A supplied summary"]}),Some(r),"later");
        assert_eq!(r["thinking_sealed"],false);let r=row(&item,Some(r),"replay");
        assert_eq!(r["thinking"],"A supplied summary");assert_eq!(r["thinking_sealed"],false);
        assert_eq!(r["seq"],17);assert_eq!(r["ts"],"original");assert_eq!(r["tools"][0]["result"],"kept");
    }
    #[tokio::test]
    #[ignore = "requires the isolated Codex thinking author fixture"]
    async fn codex_thinking_rows_survive_history_reload_and_same_item_update() {
        let url=std::env::var("ORGTREE_CODEX_THINKING_TEST_URL").expect("synthetic fixture URL required");
        let cfg:tokio_postgres::Config=url.parse().unwrap();
        assert_eq!(cfg.get_dbname(),Some("codex_thinking_fixture"));assert_eq!(cfg.get_user(),Some("codex_thinking_fixture"));
        let (client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
        let connection=tokio::spawn(async move {connection.await.unwrap()});
        client.batch_execute("CREATE SCHEMA ot; CREATE TABLE ot.convo(agent_id bigint,seq bigint,ver bigint,body jsonb,tool_inputs jsonb,PRIMARY KEY(agent_id,seq));").await.unwrap();
        let mut writer=super::super::convo::ConvoWriter::load(&client,1).await.unwrap();
        let sealed=json!({"id":"sealed-1","type":"reasoning","summary":[],"encrypted_content":"CIPHER_NOT_TRANSCRIPT"});
        let seq=writer.append(&client,row(&sealed,None,"now")).await.unwrap();
        let mut persisted=row(&sealed,None,"now");persisted["tools"]=json!([{"id":"tool-1","name":"Read","result":"Kept tool output"}]);
        writer.update(&client,seq,persisted.clone()).await.unwrap();
        writer.update(&client,seq,row(&sealed,Some(persisted),"replay")).await.unwrap();
        writer.append(&client,row(&json!({"id":"readable-2","summary":["A supplied summary 🦀"]}),None,"now")).await.unwrap();
        writer.append(&client,row(&json!({"id":"sealed-3","summary":[],"content":[]}),None,"now")).await.unwrap();
        drop(writer);
        let writer=super::super::convo::ConvoWriter::load(&client,1).await.unwrap();assert_eq!(writer.seq,3);
        let page=super::super::convo::read(&client,1,80,None,None).await.unwrap();
        assert_eq!(page.messages.len(),3);assert_eq!(page.messages[0]["thinking_sealed"],true);
        assert_eq!(page.messages[0]["tools"][0]["result"],"Kept tool output");
        assert_eq!(page.messages[1]["thinking"],"A supplied summary 🦀");assert_eq!(page.messages[2]["thinking_sealed"],true);
        assert!(!serde_json::to_string(&page.messages).unwrap().contains("CIPHER_NOT_TRANSCRIPT"));
        if let Ok(path)=std::env::var("ORGTREE_CODEX_THINKING_FIXTURE") {std::fs::write(path,serde_json::to_string(&page.messages).unwrap()).unwrap();}
        drop(client);connection.await.unwrap();
    }
}
