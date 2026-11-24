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

/// Refresh only identities already retained by a reader. Explicit coverage
/// distinguishes missing rows from an older engine ignoring the `ids` query.
#[nolog]
pub async fn selected_page(client: &Client, org: i64, agent: Option<i64>, folder: &str, ids: &str) -> Result<Value> {
    let ids: Vec<String> = serde_json::from_str(ids).map_err(|_| crate::domain::UserError::BadRequest("mail ids must be a JSON string array".into()))?;
    if ids.is_empty() || ids.len() > 200 || ids.iter().any(|id| id.is_empty()) {
        crate::refuse!(BadRequest, "refresh 1 to 200 mail ids at a time");
    }
    let sent = sent_folder(folder)?;
    let (user, node) = if sent { ("m.sender='@user'", "m.sender_agent_id=$3") }
        else { ("m.recipient_kind='user' AND m.state IN ('pending','read')",
                "m.recipient_agent_id=$3 AND m.recipient_kind='agent' AND m.state IN ('pending','delivering','delivered','read','retracted')") };
    let sql = format!("SELECT m.id,to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id)) FROM ot.mail m
        WHERE m.org_id=$1 AND m.uid=ANY($2) AND CASE WHEN $3::bigint IS NULL THEN {user} ELSE {node} END
        AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
          AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY m.id DESC LIMIT 200");
    let rows = client.query(&sql, &[&org, &ids, &agent]).await?;
    let mut page = project(rows, Some(sent), 200);
    page["refreshed_ids"] = json!(ids);
    Ok(page)
}

/// One chat's page is this many rows (the user's chats, 4.7.0: Hubchat's page size).
pub const PEER_PAGE: usize = 50;

/// Seek the existing mail_user_box/mail_user_sent indexes. One lookahead row
/// says whether there is another page; neither OFFSET nor a total is needed.
///
/// `peer` pages ONE counterparty's mail (the user's chats: USER 2026-11-24
/// m46fce69c48c9 "needs to load a maximum of X messages and dynamically load
/// more as i scroll up", coordinator m7939b5e5f292 "page at the source"): the
/// inbox folder holds only mail that sender wrote, the sent folder only mail
/// written to that recipient, `PEER_PAGE` rows a page, with the same cursor
/// and the same rows. A send to several recipients is one row per recipient,
/// so it is in each of their pages. Without `peer` nothing changes.
///
/// With a peer the folder may also be `chat`: BOTH directions in one page
/// under one cursor, which is what a conversation is. Two folders paged side
/// by side leave holes: fifty received messages may span two days while fifty
/// sent ones span ten, and the older sent ones would then stand in the chat
/// without what they answered.
#[nolog]
pub async fn user_page(client: &Client, org: i64, folder: &str, before: Option<i64>, peer: Option<&str>) -> Result<Value> {
    let before = before_id(before)?;
    let peer = peer.map(str::trim).filter(|p| !p.is_empty());
    if peer.is_some_and(|p| p.len() > 200) { crate::refuse!(BadRequest, "mail peer is too long"); }
    let chat = folder == "chat";
    if chat && peer.is_none() { crate::refuse!(BadRequest, "the chat folder needs a peer"); }
    let sent = if chat { false } else { sent_folder(folder)? };
    const RECEIVED: &str = "m.recipient_kind = 'user' AND m.state IN ('pending','read')";
    const WRITTEN: &str = "m.sender = '@user'";
    // the counterparty: who wrote it (received) or whom it was written to (the user's own)
    let predicate = if chat { format!("(({RECEIVED} AND m.sender = $3) OR ({WRITTEN} AND m.recipient_name = $3))") }
        else if sent { format!("{WRITTEN} AND ($3::text IS NULL OR m.recipient_name = $3)") }
        else { format!("{RECEIVED} AND ($3::text IS NULL OR m.sender = $3)") };
    let limit = if peer.is_some() { PEER_PAGE } else { 200 };
    let sql = format!("SELECT m.id,to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id))
        FROM ot.mail m WHERE m.org_id=$1 AND {predicate} AND m.id<$2
        AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
          AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable'
          AND m.extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
        ORDER BY m.id DESC LIMIT {}", limit + 1);
    let rows = client.query(&sql, &[&org, &before, &peer]).await?;
    Ok(project(rows, if chat { None } else { Some(sent) }, limit))
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
    Ok(project(rows, Some(sent), 150))
}

/// `sent`: the folder every row is of; `None` for a chat page, where a row is
/// the user's own when the user wrote it.
#[nolog]
fn project(rows: Vec<tokio_postgres::Row>, sent: Option<bool>, limit: usize) -> Value {
    let more = rows.len() > limit;
    let mut pending = Vec::new(); let mut delivered = Vec::new(); let mut outgoing = Vec::new();
    let mut cursor = None;
    for row in rows.into_iter().take(limit) {
        cursor = Some(row.get::<_, i64>(0).to_string());
        let raw: Value = row.get(1);
        let mut entry = crate::feed::compute::mail_entry(&raw);
        if sent.unwrap_or(raw["sender"] == "@user") { entry["to"] = raw["recipient_name"].clone(); outgoing.push(entry); }
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
