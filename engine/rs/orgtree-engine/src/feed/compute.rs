//! Database reads behind the feed: every read is keyed (ids, one org, one
//! agent) or a LIMITed newest-first window over an index. Nothing here grows
//! with inactive history.

use std::collections::HashMap;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::domain::tree::{ask_card, ts};

/// Window sizes (newest first).
pub const EVENTS_WINDOW: i64 = 300;
pub const USER_LOG_WINDOW: i64 = 200;
pub const USER_SENT_WINDOW: i64 = 200;
pub const USER_PENDING_WINDOW: i64 = 500;
pub const MAILBOX_WINDOW: i64 = 150;
pub const HISTORY_WINDOW: i64 = 200;
pub const ASK_HISTORY_KEEP: i64 = 12;

const AGENT_SQL: &str = r#"
SELECT a.id, (to_jsonb(a) - 'extra') || jsonb_build_object(
  'x_mail_pending', (SELECT count(*) FROM ot.mail m
                      WHERE m.recipient_agent_id = a.id AND m.state IN __UNREAD_STATES__),
  'x_retired_children', (SELECT count(*) FROM ot.agents c
                      WHERE c.org_id = a.org_id AND c.parent_id = a.id AND c.state IN ('archived','unrecoverable')),
  'x_children_hold', (SELECT coalesce(sum(c.seat + c.grant_credits), 0) FROM ot.agents c
                      WHERE c.parent_id = a.id AND c.state = 'live'),
  'x_turns', (SELECT coalesce(jsonb_agg(t ORDER BY t.id), '[]'::jsonb) FROM
               (SELECT id, started_at, ended_at, cost_usd, ms, toks, denials, approvals, killed, estimated, cost_source
                  FROM ot.turns WHERE agent_id = a.id ORDER BY id DESC LIMIT 8) t),
  'x_docs_count', (SELECT count(*) FROM ot.documents d WHERE d.agent_id = a.id AND NOT d.dismissed),
  'x_docs', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.uid, 'title', d.title, 'at', d.at,
                     'format', d.format, 'bytes', d.bytes) ORDER BY d.at DESC, d.id DESC), '[]'::jsonb)
               FROM (SELECT * FROM ot.documents WHERE agent_id = a.id AND NOT dismissed ORDER BY at DESC, id DESC LIMIT 20) d),
  'x_ask', (SELECT to_jsonb(k) FROM (SELECT * FROM ot.asks WHERE agent_id = a.id
               ORDER BY (status = 'open') DESC, id DESC LIMIT 1) k),
  'x_extra', a.extra
) AS raw
FROM ot.agents a
"#;

/// Raw rows for these agents (any state except deleted).
#[logged]
pub async fn agents(client: &Client, org_id: i64, ids: &[i64]) -> Result<HashMap<i64, Value>> {
    let sql = format!("{AGENT_SQL} WHERE a.org_id = $1 AND a.id = ANY($2) AND a.state <> 'deleted'")
        .replace("__UNREAD_STATES__", crate::domain::mail::UNREAD_STATES);
    let rows = client.query(&sql, &[&org_id, &ids]).await?;
    Ok(rows.into_iter().map(|r| (r.get::<_, i64>(0), r.get::<_, Value>(1))).collect())
}

/// Every live agent of the org (the shared set's agent records).
#[logged]
pub async fn live_agents(client: &Client, org_id: i64) -> Result<HashMap<i64, Value>> {
    let sql = format!("{AGENT_SQL} WHERE a.org_id = $1 AND a.state = 'live'")
        .replace("__UNREAD_STATES__", crate::domain::mail::UNREAD_STATES);
    let rows = client.query(&sql, &[&org_id]).await?;
    Ok(rows.into_iter().map(|r| (r.get::<_, i64>(0), r.get::<_, Value>(1))).collect())
}

/// Retired agents for a window: all of them, or the ones under one parent
/// (`None` = the top level).
#[logged]
pub async fn retired_agents(
    client: &Client,
    org_id: i64,
    under: Option<Option<i64>>,
) -> Result<HashMap<i64, Value>> {
    let rows = match under {
        None => {
            let sql = format!(
                "{AGENT_SQL} WHERE a.org_id = $1 AND a.state IN ('archived','unrecoverable') ORDER BY a.id LIMIT 5000"
            ).replace("__UNREAD_STATES__", crate::domain::mail::UNREAD_STATES);
            client.query(&sql, &[&org_id]).await?
        }
        Some(None) => {
            let sql = format!(
                "{AGENT_SQL} WHERE a.org_id = $1 AND a.parent_id IS NULL AND a.state IN ('archived','unrecoverable') ORDER BY a.id LIMIT 5000"
            ).replace("__UNREAD_STATES__", crate::domain::mail::UNREAD_STATES);
            client.query(&sql, &[&org_id]).await?
        }
        Some(Some(p)) => {
            let sql = format!(
                "{AGENT_SQL} WHERE a.org_id = $1 AND a.parent_id = $2 AND a.state IN ('archived','unrecoverable') ORDER BY a.id LIMIT 5000"
            ).replace("__UNREAD_STATES__", crate::domain::mail::UNREAD_STATES);
            client.query(&sql, &[&org_id, &p]).await?
        }
    };
    Ok(rows.into_iter().map(|r| (r.get::<_, i64>(0), r.get::<_, Value>(1))).collect())
}

#[logged]
pub async fn org_row(client: &Client, org_id: i64) -> Result<Value> {
    let row = client
        .query_one("SELECT to_jsonb(o) FROM ot.orgs o WHERE o.id = $1", &[&org_id])
        .await?;
    Ok(row.get(0))
}

/// Grantee name → grantor names (active audiences).
#[logged]
pub async fn audiences_held(client: &Client, org_id: i64) -> Result<HashMap<String, Vec<String>>> {
    let rows = client
        .query(
            "SELECT grantee, grantor FROM ot.audiences WHERE org_id = $1 AND revoked_at IS NULL AND NOT paused",
            &[&org_id],
        )
        .await?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for r in rows {
        out.entry(r.get(0)).or_default().push(r.get(1));
    }
    Ok(out)
}

pub fn mail_entry(m: &Value) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), m["uid"].clone());
    o.insert("from".into(), m["sender"].clone());
    o.insert("kind".into(), m["kind"].clone());
    o.insert("body".into(), m["body"].clone());
    o.insert("at".into(), ts(&m["created_at"]));
    if let Some(r) = m.get("relationship").filter(|v| !v.is_null()) {
        o.insert("relationship".into(), r.clone());
    }
    let att = m.get("attachments").cloned().unwrap_or(json!([]));
    if att.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        o.insert("attachments".into(), att);
    }
    if m["urgent"].as_bool().unwrap_or(false) {
        o.insert("urgent".into(), json!(true));
        o.insert("urgent_reason".into(), m["urgent_reason"].clone());
    }
    if let Some(ev) = m.get("ev").filter(|v| !v.is_null()) {
        let mut ev = ev.clone();
        // the 2.x engine stored these leaves without the body the row already holds
        let variant = ev["variant"].as_str().unwrap_or("");
        if (variant.starts_with("ordinary.") || variant == "reply.mail" || variant == "reply.document") && ev.get("body").is_none() {
            if let Some(obj) = ev.as_object_mut() {
                obj.insert("body".into(), m["body"].clone());
            }
        }
        o.insert("ev".into(), ev);
    }
    if let Some(rt) = m.get("reply_to").filter(|v| !v.is_null()) {
        o.insert("reply_to".into(), rt.clone());
    }
    if let Some(op) = m.get("client_op").filter(|v| !v.is_null()) {
        o.insert("client_op".into(), op.clone());
    }
    if m["notice"].as_bool().unwrap_or(false) {
        o.insert("notice".into(), json!(true));
    }
    if m["state"].as_str() == Some("retracted") {
        o.insert("retracted".into(), json!(true));
    }
    let state = m["state"].as_str().unwrap_or("");
    if state == "delivering" {
        o.insert("delivering".into(), json!(true));
    }
    Value::Object(o)
}

/// `(user_inbox, user_mail_log, user_outbox)` windows, keyed by mail id.
#[logged]
pub async fn user_mail(client: &Client, org_id: i64) -> Result<(Vec<(i64, Value)>, Vec<(i64, Value)>, Vec<(i64, Value)>)> {
    let pending = client
        .query(
            "SELECT id, to_jsonb(m) FROM ot.mail m WHERE org_id = $1 AND recipient_kind = 'user' AND state = 'pending'
             ORDER BY id DESC LIMIT $2",
            &[&org_id, &USER_PENDING_WINDOW],
        )
        .await?;
    let read = client
        .query(
            "SELECT id, to_jsonb(m) FROM ot.mail m WHERE org_id = $1 AND recipient_kind = 'user' AND state = 'read'
             ORDER BY id DESC LIMIT $2",
            &[&org_id, &USER_LOG_WINDOW],
        )
        .await?;
    let sent = client
        .query(
            "SELECT id, to_jsonb(m) FROM ot.mail m WHERE org_id = $1 AND sender = '@user'
             ORDER BY id DESC LIMIT $2",
            &[&org_id, &USER_SENT_WINDOW],
        )
        .await?;
    let map = |rows: Vec<tokio_postgres::Row>, sent: bool| -> Vec<(i64, Value)> {
        rows.into_iter()
            .map(|r| {
                let id: i64 = r.get(0);
                let m: Value = r.get(1);
                let mut e = mail_entry(&m);
                if sent {
                    e["to"] = m["recipient_name"].clone();
                }
                (id, e)
            })
            .collect()
    };
    Ok((map(pending, false), map(read, false), map(sent, true)))
}

pub fn event_entry(e: &Value) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("at".into(), ts(&e["at"]));
    o.insert("op".into(), e["op"].clone());
    o.insert("actor".into(), e["actor"].clone());
    o.insert("detail".into(), e.get("detail").cloned().unwrap_or(json!({})));
    if let Some(w) = e.get("warnings").filter(|v| !v.is_null()) {
        o.insert("warnings".into(), w.clone());
    }
    Value::Object(o)
}

#[logged]
pub async fn events_window(client: &Client, org_id: i64) -> Result<(Vec<(i64, Value)>, i64)> {
    let rows = client
        .query(
            "SELECT id, to_jsonb(e) FROM ot.events e WHERE org_id = $1 ORDER BY id DESC LIMIT $2",
            &[&org_id, &EVENTS_WINDOW],
        )
        .await?;
    let count: i64 = client
        .query_one("SELECT count(*) FROM ot.events WHERE org_id = $1", &[&org_id])
        .await?
        .get(0);
    Ok((rows.into_iter().map(|r| (r.get::<_, i64>(0), event_entry(&r.get::<_, Value>(1)))).collect(), count))
}

/// One agent's mailbox window: `MailRecord {folder, order, mail}` keyed by mail id.
#[logged]
pub async fn agent_mailbox(client: &Client, agent_id: i64) -> Result<Vec<(String, Value)>> {
    let pending = client
        .query(
            &format!("SELECT id, to_jsonb(m) FROM ot.mail m WHERE recipient_agent_id = $1 AND state IN {}
             ORDER BY id LIMIT $2", crate::domain::mail::UNREAD_STATES),
            &[&agent_id, &MAILBOX_WINDOW],
        )
        .await?;
    let delivered = client
        .query(
            "SELECT id, to_jsonb(m) FROM ot.mail m WHERE recipient_agent_id = $1 AND recipient_kind = 'agent'
               AND state IN ('delivered','read','retracted')
             ORDER BY id DESC LIMIT $2",
            &[&agent_id, &MAILBOX_WINDOW],
        )
        .await?;
    let sent = client
        .query(
            "SELECT id, to_jsonb(m) FROM ot.mail m WHERE sender_agent_id = $1 ORDER BY id DESC LIMIT $2",
            &[&agent_id, &MAILBOX_WINDOW],
        )
        .await?;
    let mut out = Vec::new();
    for (folder, rows) in [("pending", pending), ("delivered", delivered), ("sent", sent)] {
        for r in rows {
            let id: i64 = r.get(0);
            let m: Value = r.get(1);
            let mut mail = mail_entry(&m);
            if folder == "sent" {
                mail["to"] = m["recipient_name"].clone();
            }
            if folder == "pending" {
                let stage = if m["state"].as_str() == Some("delivering") { "turn" } else { "queued" };
                mail["stage"] = json!(stage);
            }
            out.push((format!("{folder}:{id}"), json!({ "folder": folder, "order": [id], "mail": mail })));
        }
    }
    Ok(out)
}

/// One agent's history window: its events, newest first.
#[logged]
pub async fn agent_history(client: &Client, agent_id: i64) -> Result<Vec<(String, Value)>> {
    let rows = client
        .query(
            "SELECT id, to_jsonb(e) FROM ot.events e WHERE subject_agent_id = $1 ORDER BY id DESC LIMIT $2",
            &[&agent_id, &HISTORY_WINDOW],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let id: i64 = r.get(0);
            let e: Value = r.get(1);
            let item = json!({
                "at": ts(&e["at"]),
                "kind": e["op"],
                "actor": e["actor"],
                "detail": e.get("detail").cloned().unwrap_or(json!({})),
                "warnings": e.get("warnings").cloned().filter(|w| !w.is_null()).unwrap_or(json!([])),
            });
            (format!("event:{id}"), item)
        })
        .collect())
}

/// Open asks plus the newest resolved ones, as `AskInfo`, with the asker's name.
#[logged]
pub async fn asks(client: &Client, org_id: i64) -> Result<Vec<Value>> {
    let rows = client
        .query(
            "(SELECT to_jsonb(k), a.name FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
               WHERE k.org_id = $1 AND k.status = 'open' ORDER BY k.id)
             UNION ALL
             (SELECT to_jsonb(k), a.name FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
               WHERE k.org_id = $1 AND k.resolved_at IS NOT NULL ORDER BY k.resolved_at DESC LIMIT $2)",
            &[&org_id, &ASK_HISTORY_KEEP],
        )
        .await?;
    Ok(rows.into_iter().map(|r| ask_card(&r.get::<_, Value>(0), &r.get::<_, String>(1))).collect())
}
