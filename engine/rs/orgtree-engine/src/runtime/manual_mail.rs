//! Explicit inbox content reads become ordinary transcript mail after the
//! containing tool completes. These receipts never claim project queue mail.
use serde_json::{json, Value};

/// The tool handler supplies only content actually returned, never previews,
/// missing IDs or IDs deferred by its output budget.
#[nolog]
pub fn opened(items: &[Value], recipient: i64, project: bool) -> Vec<Value> {
    let mut out=Vec::new();
    for item in items {
        // Project inbox results now also expose Sent history. Keep explicit
        // sent rows out of both ToolCard and AGY fallback transcript receipts.
        if item["direction"]=="sent" { continue; }
        if !project && item["direction"]!="received" { continue; }
        if let Some(uid)=item["id"].as_str() {
            let entry=json!({"uid":uid,"recipient":recipient});
            if !out.contains(&entry) { out.push(entry); }
        }
    }
    out
}

/// A single actor owns its transcript. The existing indexed mail_ids receipts
/// deduplicate earlier automatic delivery, repeated chunks and actor reloads.
#[nolog]
pub async fn unseen(client:&tokio_postgres::Client, agent:i64, org:i64, opened:&[Value]) -> anyhow::Result<Vec<Value>> {
    let mut ids=Vec::<String>::new();
    let mut recipients=Vec::<i64>::new();
    for item in opened {
        if let (Some(uid),Some(recipient))=(item["uid"].as_str(),item["recipient"].as_i64()) {
            if !ids.iter().any(|id|id==uid) {ids.push(uid.to_owned());}
            if !recipients.contains(&recipient) {recipients.push(recipient);}
        }
    }
    if ids.is_empty() {return Ok(Vec::new());}
    let rows=client.query("SELECT to_jsonb(m) FROM ot.mail m
        WHERE m.org_id=$3 AND m.uid=ANY($2) AND m.recipient_agent_id=ANY($4)
        AND NOT EXISTS (SELECT 1 FROM ot.convo c WHERE c.agent_id=$1 AND c.body->>'role'='user' AND (c.body->'mail_ids') ? m.uid)
        ORDER BY array_position($2,m.uid)", &[&agent,&ids,&org,&recipients]).await?;
    Ok(rows.into_iter().map(|r|r.get::<_,Value>(0)).filter(|m|
        opened.iter().any(|o|o["uid"]==m["uid"]&&o["recipient"]==m["recipient_agent_id"])).collect())
}

/// AGY's external MCP result lacks ToolCard metadata. Accept only a successful
/// built-in content-read result, parsed before preview clipping.
#[nolog]
pub fn output(name:&str,args:&Value,text:&str) -> Option<Value> {
    if name.rsplit("__").next()!=Some("orgtree_inbox") || !matches!(args["action"].as_str(),Some("fetch"|"chunk")) {return None;}
    let body=serde_json::Deserializer::from_str(text).into_iter::<Value>().next()?.ok()?;
    if body["isError"]==true {return None;}
    if let Some(blocks)=body["content"].as_array() {
        return blocks.iter().filter_map(|b|b["text"].as_str()).find_map(|s|
            serde_json::Deserializer::from_str(s).into_iter::<Value>().next()?.ok());
    }
    Some(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_mail_receipts_exclude_sent_and_previews() {
        let items=vec![json!({"id":"received","direction":"received"}),json!({"id":"sent","direction":"sent"}),json!({"id":"received","direction":"received"})];
        assert_eq!(opened(&items,7,false),vec![json!({"uid":"received","recipient":7})]);
        assert_eq!(opened(&items[..2],9,true).len(),1);
        assert_eq!(opened(&[json!({"id":"legacy-project"})],9,true).len(),1);
        for action in ["list","conversation"] {assert!(output("orgtree_inbox",&json!({"action":action}),"{}").is_none());}
        assert!(output("shell",&json!({"action":"fetch"}),"{}").is_none());
        assert_eq!(output("mcp__orgtree__orgtree_inbox",&json!({"action":"chunk"}),"{\"id\":\"received\",\"direction\":\"received\"}\nexecution time: 1ms").unwrap()["id"],"received");
        let envelope=json!({"content":[{"type":"text","text":"{\"id\":\"received\",\"direction\":\"received\"}"},{"type":"text","text":"execution time: 1ms"}]});
        assert_eq!(output("orgtree_inbox",&json!({"action":"fetch"}),&envelope.to_string()).unwrap()["id"],"received");
        assert!(output("orgtree_inbox",&json!({"action":"fetch"}),"{\"isError\":true,\"content\":[]}").is_none());
        assert_eq!(crate::feed::compute::mail_entry(&json!({"state":"read","extra":{"manual_read":true}}))["dnd_read"],true);
    }
}
