//! Explicit history pages; the pushed mail windows stay small and live.
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

/// Validate the cursor before querying; ids, not timestamps, break ties.
#[nolog]
pub fn before_id(before: Option<i64>) -> Result<i64> {
    let id = before.unwrap_or(i64::MAX);
    if id < 1 { crate::refuse!(BadRequest, "mail cursor must be a positive id"); }
    Ok(id)
}

#[nolog]
pub fn sent_folder(folder: &str) -> Result<bool> {
    match folder {
        "inbox" => Ok(false), "sent" => Ok(true),
        _ => crate::refuse!(BadRequest, "mail folder must be inbox or sent"),
    }
}

/// Seek the existing mail_user_box/mail_user_sent indexes. One lookahead row
/// says whether there is another page; neither OFFSET nor a total is needed.
#[nolog]
pub async fn user_page(client: &Client, org: i64, folder: &str, before: Option<i64>) -> Result<Value> {
    let before = before_id(before)?;
    let sent = sent_folder(folder)?;
    let predicate = if sent { "m.sender = '@user'" }
        else { "m.recipient_kind = 'user' AND m.state IN ('pending','read')" };
    let sql = format!("SELECT m.id,to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id))
        FROM ot.mail m WHERE m.org_id=$1 AND {predicate} AND m.id<$2
        AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
          AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable'
          AND m.extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY m.id DESC LIMIT 201");
    let rows = client.query(&sql, &[&org, &before]).await?;
    Ok(project(rows, sent, 200))
}

/// Agent and project boxes share admitted ids and mail state projection.
#[nolog]
pub async fn agent_page(client: &Client, org: i64, agent: i64, folder: &str, before: Option<i64>) -> Result<Value> {
    let before = before_id(before)?;
    let sent = sent_folder(folder)?;
    let predicate = if sent { "m.sender_agent_id=$3".to_string() }
        else { format!("m.recipient_agent_id=$3 AND m.recipient_kind='agent' AND (m.state IN {} OR m.state IN ('delivered','read','retracted'))", crate::domain::mail::UNREAD_STATES) };
    let sql = format!("SELECT m.id,to_jsonb(m) FROM ot.mail m
        WHERE m.org_id=$1 AND {predicate} AND m.id<$2
        AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
          AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable'
          AND m.extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY m.id DESC LIMIT 151");
    let rows = client.query(&sql, &[&org, &before, &agent]).await?;
    Ok(project(rows, sent, 150))
}

#[nolog]
fn project(rows: Vec<tokio_postgres::Row>, sent: bool, limit: usize) -> Value {
    let more = rows.len() > limit;
    let mut pending = Vec::new(); let mut delivered = Vec::new(); let mut outgoing = Vec::new();
    let mut cursor = None;
    for row in rows.into_iter().take(limit) {
        cursor = Some(row.get::<_, i64>(0).to_string());
        let raw: Value = row.get(1);
        let mut entry = crate::feed::compute::mail_entry(&raw);
        if sent { entry["to"] = raw["recipient_name"].clone(); outgoing.push(entry); }
        else if matches!(raw["state"].as_str(), Some("pending" | "delivering")) {
            if raw["recipient_kind"] == "agent" {
                entry["stage"] = json!(if raw["state"] == "delivering" { "turn" } else { "queued" });
            }
            pending.push(entry);
        }
        else { delivered.push(entry); }
    }
    json!({"pending":pending,"delivered":delivered,"sent":outgoing,"next_cursor":if more {cursor} else {None}})
}
