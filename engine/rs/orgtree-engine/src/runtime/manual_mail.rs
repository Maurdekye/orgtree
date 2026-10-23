//! Explicit inbox content reads become ordinary transcript mail after the
//! containing tool completes. These receipts never claim project queue mail.
use serde_json::{json, Value};
use std::collections::HashMap;

#[cfg(test)]
#[path = "manual_mail_security_tests.rs"]
mod security_tests;

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
    let mut allowed=Vec::new();
    for recipient in recipients {
        if recipient!=agent {
            let project=client.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND kind='project' AND state<>'deleted'",&[&recipient,&org]).await?.is_some();
            if !project || !crate::domain::projects::reaches(client,agent,recipient).await? {continue;}
        }
        allowed.push(recipient);
    }
    if allowed.is_empty() {return Ok(Vec::new());}
    let sql=format!("SELECT to_jsonb(m) FROM ot.mail m
        WHERE m.org_id=$3 AND m.uid=ANY($2) AND m.recipient_agent_id=ANY($4)
        AND (m.recipient_agent_id=$1 OR m.recipient_kind='agent') AND {}
        AND NOT EXISTS (SELECT 1 FROM ot.convo c WHERE c.agent_id=$1 AND c.body->>'role'='user' AND (c.body->'mail_ids') ? m.uid)
        ORDER BY array_position($2,m.uid)",crate::tools::PROJECT_MAIL_VISIBLE_SQL);
    let rows=client.query(&sql, &[&agent,&ids,&org,&allowed]).await?;
    Ok(rows.into_iter().map(|r|r.get::<_,Value>(0)).filter(|m|
        opened.iter().any(|o|o["uid"]==m["uid"]&&o["recipient"]==m["recipient_agent_id"])).collect())
}

/// Correlate only the original native Orgtree server identity. Display-name
/// unwrapping deliberately accepts broader aliases and is not an authority check.
#[nolog]
fn trusted_call(name:&str,args:&Value) -> Option<(String,Value)> {
    let native=name.strip_prefix("default_api:").unwrap_or(name);
    let own=|tool:&str|matches!(tool,"orgtree_inbox"|"orgtree_watchdog");
    if native.strip_prefix("mcp__orgtree__").is_some_and(own)
        || native.strip_prefix("mcp_orgtree_orgtree_").is_some_and(own) {
        return Some(crate::runtime::convo::unwrap_tool_call(name,args));
    }
    if native!="call_mcp_tool" {return None;}
    let server=one_alias(args,&["ServerName","server_name","serverName","server"])?.as_str()?.trim();
    let tool=one_alias(args,&["ToolName","tool_name","toolName","tool"])?.as_str()?.trim();
    if !matches!(server,"orgtree"|"orgtree_orgtree") || !own(tool) {return None;}
    one_alias(args,&["Arguments","arguments","args"])?;
    Some(crate::runtime::convo::unwrap_tool_call(name,args))
}

#[nolog]
fn one_alias<'a>(args:&'a Value,keys:&[&str]) -> Option<&'a Value> {
    let mut values=keys.iter().filter_map(|key|args.get(*key));
    let first=values.next()?;
    values.all(|value|value==first).then_some(first)
}

/// A result can correlate a private dispatcher receipt, never manufacture one.
/// The caller invokes this before consuming the annotation card and only after
/// successful native completion. Identical genuine reads remain interchangeable;
/// conflicting proofs fail closed.
#[nolog]
pub fn bind_fallback(cards:&HashMap<String,Value>,reads:&mut HashMap<String,Vec<Value>>,calls:&[&str],name:&str,args:&Value,text:&str) {
    let Some(target)=calls.first().copied() else{return;};
    let Some((tool,input))=trusted_call(name,args) else{return;};
    let Some(body)=output(name,args,text) else{return;};
    let base=tool.rsplit("__").next().unwrap_or(&tool);
    let mut matched:Vec<String>=cards.iter().filter(|(key,card)| {
        key.starts_with("mcp-card:") && reads.contains_key(*key)
            && card["_mcp_tool"]==base && card["_mcp_args"]==input
            && card["_mcp_text"].as_str().and_then(|s|
                serde_json::Deserializer::from_str(s).into_iter::<Value>().next()?.ok()).as_ref()==Some(&body)
    }).map(|(key,_)|key.clone()).collect();
    matched.sort();
    let Some(first)=matched.first() else{return;};
    let Some(proof)=reads.get(first).cloned() else{return;};
    if matched.iter().any(|key|reads.get(key)!=Some(&proof)) {return;}
    reads.remove(first);
    reads.entry(target.to_string()).or_default().extend(proof);
}

/// Parse a successful, provenance-checked result before preview clipping. The
/// parsed body is used only to match dispatcher metadata, not to authorize IDs.
#[nolog]
pub fn output(name:&str,args:&Value,text:&str) -> Option<Value> {
    let (unwrapped_name, unwrapped_args) = trusted_call(name,args)?;
    let (name, args) = (unwrapped_name.as_str(), &unwrapped_args);
    let inbox=name.rsplit("__").next()==Some("orgtree_inbox") && matches!(args["action"].as_str(),Some("fetch"|"chunk"|"pull"));
    let inline=name.rsplit("__").next()==Some("orgtree_watchdog") && args["action"]=="create" && args["kind"]=="fair_queue";
    if !inbox && !inline {return None;}
    let body=serde_json::Deserializer::from_str(text).into_iter::<Value>().next()?.ok()?;
    if body["isError"]==true {return None;}
    let parsed=if let Some(blocks)=body["content"].as_array() {
        blocks.iter().filter_map(|b|b["text"].as_str()).find_map(|s|
            serde_json::Deserializer::from_str(s).into_iter::<Value>().next()?.ok())?
    } else {body};
    if inline && !(parsed["resolved"]==true && parsed["registered"]==false && parsed["messages"].is_array()) {return None;}
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_queue_tool_result_is_a_single_consumed_mail_receipt() {
        let args=json!({"action":"create","kind":"fair_queue"});
        let result=json!({"resolved":true,"registered":false,"messages":[{"id":"m1","direction":"received"}]});
        let parsed=output("mcp__orgtree__orgtree_watchdog",&args,&result.to_string()).unwrap();
        assert_eq!(opened(parsed["messages"].as_array().unwrap(),7,false),vec![json!({"uid":"m1","recipient":7})]);
        assert!(output("mcp__orgtree__orgtree_watchdog",&args,"{\"registered\":true}").is_none());
        assert!(output("shell",&args,&result.to_string()).is_none());
    }
    #[test]
    fn explicit_mail_receipts_exclude_sent_and_previews() {
        let items=vec![json!({"id":"received","direction":"received"}),json!({"id":"sent","direction":"sent"}),json!({"id":"received","direction":"received"})];
        assert_eq!(opened(&items,7,false),vec![json!({"uid":"received","recipient":7})]);
        assert_eq!(opened(&items[..2],9,true).len(),1);
        assert_eq!(opened(&[json!({"id":"legacy-project"})],9,true).len(),1);
        for action in ["list","conversation"] {assert!(output("mcp__orgtree__orgtree_inbox",&json!({"action":action}),"{}").is_none());}
        assert!(output("shell",&json!({"action":"fetch"}),"{}").is_none());
        assert_eq!(output("mcp__orgtree__orgtree_inbox",&json!({"action":"chunk"}),"{\"id\":\"received\",\"direction\":\"received\"}\nexecution time: 1ms").unwrap()["id"],"received");
        let envelope=json!({"content":[{"type":"text","text":"{\"id\":\"received\",\"direction\":\"received\"}"},{"type":"text","text":"execution time: 1ms"}]});
        assert_eq!(output("mcp__orgtree__orgtree_inbox",&json!({"action":"fetch"}),&envelope.to_string()).unwrap()["id"],"received");
        assert_eq!(
            output(
                "default_api:call_mcp_tool",
                &json!({"ServerName":"orgtree_orgtree","ToolName":"orgtree_inbox","Arguments":{"action":"fetch","id":"received"}}),
                &envelope.to_string()
            ).unwrap()["id"],
            "received"
        );
        assert!(output("mcp__orgtree__orgtree_inbox",&json!({"action":"fetch"}),"{\"isError\":true,\"content\":[]}").is_none());
        assert_eq!(crate::feed::compute::mail_entry(&json!({"state":"read","extra":{"manual_read":true}}))["dnd_read"],true);
    }
}
