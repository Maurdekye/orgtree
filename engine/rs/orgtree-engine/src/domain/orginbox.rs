//! The org inbox: the organization's one face to the outside world (other
//! orgs on this machine, and hosts reached through the mail hub).

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::domain::mail::{self, From, Outgoing, Sent};
use crate::domain::tree::ts;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::util::uid;

/// An `org_inbox` row → `OrgInboxEntry`.
pub fn entry(r: &Value) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), r["uid"].clone());
    o.insert("dir".into(), r["dir"].clone());
    o.insert("peer".into(), r["peer"].clone());
    o.insert("body".into(), r["body"].clone());
    o.insert("at".into(), ts(&r["at"]));
    if let Some(b) = r.get("by_name").filter(|v| !v.is_null()) {
        o.insert("by".into(), b.clone());
    }
    if let Some(s) = r.get("state").filter(|v| !v.is_null()) {
        o.insert("state".into(), s.clone());
    }
    if let Some(s) = r.get("state_at").filter(|v| !v.is_null()) {
        o.insert("state_at".into(), ts(s));
    }
    if let Some(n) = r.get("net_id").filter(|v| !v.is_null()) {
        o.insert("net_id".into(), n.clone());
    }
    let tries = r["tries"].as_i64().unwrap_or(0);
    if tries > 0 {
        o.insert("tries".into(), json!(tries));
    }
    if let Some(e) = r.get("last_err").filter(|v| !v.is_null()) {
        o.insert("last_err".into(), e.clone());
    }
    let att = r.get("attachments").cloned().unwrap_or(json!([]));
    if att.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        o.insert("attachments".into(), att);
    }
    Value::Object(o)
}

/// Mail to the outside: `@org:<slug>` (another org on this machine: one
/// transaction into both inboxes, then the receiving org's holders are
/// woken) or `@net:<slug>` (the mail hub).
#[logged]
pub async fn send_extern(engine: &Arc<Engine>, org_id: i64, out: &Outgoing) -> Result<Sent> {
    let to = out.to.trim().trim_start_matches('@');
    let Some(src) = engine.orgs.by_id(org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let client = engine.db.get().await?;
    let by = match &out.from {
        From::User => "user".to_string(),
        f => f.name(),
    };
    if let From::Agent { id, name, .. } = &out.from {
        let ok: bool = client
            .query_one(
                "SELECT (SELECT parent_id IS NULL FROM ot.agents WHERE id = $1)
                     OR EXISTS (SELECT 1 FROM ot.audiences WHERE org_id = $2 AND grantee = $3 AND grantor = '@extern'
                                  AND revoked_at IS NULL AND NOT paused)",
                &[id, &org_id, name],
            )
            .await?
            .get(0);
        if !ok {
            crate::refuse!(
                Forbidden,
                "outside mail goes out as the organization: it needs the org-inbox audience (top-level agents hold it); ask your superior"
            );
        }
    }
    drop(client);
    if let Some(peer) = to.strip_prefix("net:") {
        let (uid, to) = crate::net::queue(engine, org_id, peer, &out.body, &by, &out.attachments).await?;
        changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
        return Ok(Sent {
            uid,
            to,
            recipient_state: "remote".into(),
            delivery: "Queued for the mail hub; it leaves as soon as a hub accepts it (the org inbox shows its progress).".into(),
            deferred: false,
        });
    }
    let slug = to.strip_prefix("org:").unwrap_or(to).trim();
    let Some(dst) = engine.orgs.get(slug) else {
        crate::refuse!(NotFound, "no organization @org:{slug} on this machine (orgtree_list_orgs lists them)");
    };
    if dst.id == org_id {
        crate::refuse!(BadRequest, "@org:{slug} is this organization; write to the agent directly");
    }
    let client = engine.db.get().await?;
    let attachments = Value::Array(out.attachments.clone());
    let out_uid = uid("x");
    let in_uid = uid("x");
    let src_peer = format!("@org:{}", src.slug);
    let dst_peer = format!("@org:{}", dst.slug);
    client
        .execute(
            "WITH o AS (INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, attachments)
                        VALUES ($1, $2, 'out', $3, $4, $5, 'delivered', now(), $6))
             INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments) VALUES ($7, $8, 'in', $9, $4, $6)",
            &[&out_uid, &org_id, &dst_peer, &out.body, &by, &attachments, &in_uid, &dst.id, &src_peer],
        )
        .await?;
    let holders = holders(&client, dst.id).await?;
    drop(client);
    // the spark rides from the sender to the mailbox here, and from the mailbox to each holder there
    changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
    changes::notify(engine, &dst, vec![Change::OrgInbox]);
    for h in &holders {
        let mut m = Outgoing::new(From::Extern(src_peer.clone()), h, &out.body);
        m.kind = out.kind.clone();
        m.attachments = out.attachments.clone();
        if let Err(e) = mail::send(engine, dst.id, m).await {
            tracing::warn!(error = %format!("{e:#}"), holder = %h, "org inbox delivery failed");
        }
    }
    let delivery = if holders.is_empty() {
        format!("Stored in {}'s org inbox; it has no live agent to read it yet.", dst.slug)
    } else {
        format!("Delivered to {}'s org inbox and to {}.", dst.slug, holders.join(", "))
    };
    Ok(Sent { uid: out_uid, to: dst_peer, recipient_state: "live".into(), delivery, deferred: holders.is_empty() })
}

/// Who reads an org's outside mail: its org-inbox audience holders, else its
/// first top-level agent.
#[logged]
async fn holders(client: &tokio_postgres::Client, org_id: i64) -> Result<Vec<String>> {
    let mut holders: Vec<String> = client
        .query(
            "SELECT DISTINCT grantee FROM ot.audiences WHERE org_id = $1 AND grantor = '@extern' AND revoked_at IS NULL AND NOT paused",
            &[&org_id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if holders.is_empty() {
        holders = client
            .query(
                "SELECT name FROM ot.agents WHERE org_id = $1 AND parent_id IS NULL AND state = 'live' ORDER BY sibling_order, id LIMIT 1",
                &[&org_id],
            )
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect();
    }
    Ok(holders)
}

/// Mail that arrived over the mail hub: stored once (keyed by its hub id),
/// then handed to the org's outside-mail holders. Answers whether it was new.
#[logged]
pub async fn deliver_inbound(
    engine: &Arc<Engine>,
    org_id: i64,
    peer: &str,
    body: &str,
    attachments: Vec<Value>,
    net_id: &str,
    hub: &str,
) -> Result<bool> {
    let Some(org) = engine.orgs.by_id(org_id) else { return Ok(false) };
    let client = engine.db.get().await?;
    let n = client
        .execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, net_id, hub)
             SELECT $1, $2, 'in', $3, $4, $5, $6, $7
              WHERE NOT EXISTS (SELECT 1 FROM ot.org_inbox WHERE org_id = $2 AND dir = 'in' AND net_id = $6)",
            &[&uid("x"), &org_id, &peer, &body, &Value::Array(attachments.clone()), &net_id, &hub],
        )
        .await?;
    if n == 0 {
        return Ok(false);
    }
    let holders = holders(&client, org_id).await?;
    drop(client);
    changes::notify(engine, &org, vec![Change::OrgInbox]);
    for h in &holders {
        let mut m = Outgoing::new(From::Extern(peer.to_string()), h, body);
        m.attachments = attachments.clone();
        if let Err(e) = mail::send(engine, org_id, m).await {
            tracing::warn!(error = %format!("{e:#}"), holder = %h, "org inbox delivery failed");
        }
    }
    Ok(true)
}
