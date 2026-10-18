//! Authorized, side-effect-free project mail history. Cursors bind the caller,
//! project and filters; every page and exact read rechecks current reach.
use super::{Done, Me};
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

const NOTE: &str = "Read-only project mail: reading never claims, acknowledges or marks mail read. Fair-queue watchdogs consume waiting mail.";
const VISIBLE_SQL: &str = "((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
    AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL)
    OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))";
const STATUS_SQL: &str = "CASE
 WHEN jsonb_typeof(m.extra->'dead_letter')='object' THEN 'dead-letter'
 WHEN m.extra->'claimed'->>'acked_at' IS NOT NULL OR m.extra->'claimed'->>'ack_waived_at' IS NOT NULL THEN 'acked'
 WHEN m.state IN ('pending','delivering') THEN 'waiting'
 WHEN (m.extra->'claimed'->>'ack')='true' THEN 'claimed'
 WHEN m.state IN ('read','delivered') THEN 'delivered'
 ELSE m.state END";

#[derive(Debug)]
struct Filter {
    folder: String,
    status: String,
}
impl Filter {
    #[nolog]
    fn parse(args: &Value) -> Result<Self> {
        let folder = match args.get("folder") {
            None | Some(Value::Null) => "inbox",
            Some(Value::String(s)) if matches!(s.as_str(), "inbox" | "sent") => s,
            _ => crate::refuse!(BadRequest, "project folder must be inbox or sent"),
        }
        .to_string();
        // Preserve the old waiting-only list unless a folder is explicitly chosen.
        let status = match args.get("status") {
            None | Some(Value::Null) => {
                if args.get("folder").is_none_or(|v| v.is_null()) && args["action"] == "list" {
                    "waiting"
                } else {
                    ""
                }
            }
            Some(Value::String(s))
                if ["waiting", "delivered", "claimed", "acked", "dead-letter"]
                    .contains(&s.as_str()) =>
            {
                s
            }
            _ => crate::refuse!(
                BadRequest,
                "project status must be waiting, delivered, claimed, acked or dead-letter"
            ),
        }
        .to_string();
        Ok(Self { folder, status })
    }
    #[nolog]
    fn cursor(&self, caller: i64, project: i64, row: i64) -> String {
        format!(
            "p1:{caller}:{project}:{}:{}:{row}",
            self.folder, self.status
        )
    }
    #[nolog]
    fn before(&self, args: &Value, caller: i64, project: i64) -> Result<i64> {
        let Some(cursor) = args.get("cursor").filter(|v| !v.is_null()) else {
            return Ok(i64::MAX);
        };
        let cursor = cursor.as_str().unwrap_or("");
        let Some((scope, row)) = cursor.rsplit_once(':') else {
            crate::refuse!(BadRequest, "invalid project mail cursor")
        };
        let expected = self.cursor(caller, project, 0);
        if scope != expected.strip_suffix(":0").unwrap() {
            crate::refuse!(
                BadRequest,
                "project mail cursor belongs to another caller, project or filter"
            )
        }
        let row = row
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow::anyhow!("invalid project mail cursor row"))?;
        Ok(row)
    }
    #[nolog]
    fn predicate(&self) -> &'static str {
        if self.folder == "sent" {
            "m.sender_agent_id=$2"
        } else {
            "m.recipient_agent_id=$2 AND m.recipient_kind='agent'"
        }
    }
}

#[nolog]
fn shown(raw: &Value, folder: &str) -> Value {
    let mut entry = crate::feed::compute::mail_entry(raw);
    entry["message_id"] = raw["uid"].clone();
    entry["state"] = raw["state"].clone();
    entry["status"] = raw["project_status"].clone();
    entry["kind"] = json!(crate::domain::mail::shown_kind(
        raw["kind"].as_str().unwrap_or("message")
    ));
    entry["direction"] = json!(if folder == "sent" { "sent" } else { "received" });
    entry["to"] = raw["recipient_name"].clone();
    entry
}

#[nolog]
pub(super) async fn read(
    client: &Client,
    me: &Me,
    name: &str,
    action: &str,
    args: &Value,
) -> Result<Done> {
    use crate::domain::projects;
    let Some(p) = projects::by_name(client, me.org_id, name).await? else {
        crate::refuse!(NotFound, "no project named {name} in this organization")
    };
    projects::require_reach(client, me.id, &p, "inspect its mailbox").await?;
    let filter = Filter::parse(args)?;
    if action == "list" {
        let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
        let before = filter.before(args, me.id, p.id)?;
        // Fixed keys bound previews even for large mail. No OFFSET or historical
        // total scan: one extra id establishes continuation.
        let sql=format!("SELECT m.id,jsonb_build_object('uid',m.uid,'sender',m.sender,'kind',m.kind,'state',m.state,
            'created_at',m.created_at,'body',left(m.body,301),'notice',m.notice,'urgent',m.urgent,
            'urgent_reason',m.urgent_reason,'recipient_name',m.recipient_name,'extra',m.extra,'project_status',({STATUS_SQL}))
            FROM ot.mail m WHERE m.org_id=$1 AND {} AND {VISIBLE_SQL} AND m.id<$3 AND ($4='' OR ({STATUS_SQL})=$4)
            ORDER BY m.id DESC LIMIT $5",filter.predicate());
        let rows = client
            .query(
                &sql,
                &[&me.org_id, &p.id, &before, &filter.status, &(limit + 1)],
            )
            .await?;
        let more = rows.len() > limit as usize;
        let rows = &rows[..rows.len().min(limit as usize)];
        let messages: Vec<Value> = rows
            .iter()
            .map(|r| {
                let raw: Value = r.get(1);
                let mut item = shown(&raw, &filter.folder);
                item.as_object_mut().unwrap().remove("body");
                item["preview"] = json!(crate::util::gist(raw["body"].as_str().unwrap_or(""), 300));
                item
            })
            .collect();
        let next = if more {
            rows.last().map(|r| filter.cursor(me.id, p.id, r.get(0)))
        } else {
            None
        };
        let waiting:i64=client.query_one(&format!("SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id=$1 AND m.state='pending' AND {VISIBLE_SQL}"),&[&p.id]).await?.get(0);
        let watchers:i64=client.query_one("SELECT count(*) FROM ot.watchdogs WHERE kind='fair_queue' AND state='armed' AND memo->>'target_id'=$1",&[&p.id.to_string()]).await?.get(0);
        return Done::json(
            &json!({"project":p.name,"folder":filter.folder,"status":if filter.status.is_empty(){None}else{Some(&filter.status)},
            "waiting":waiting,"fair_queue_watchers":watchers,"messages":messages,"has_more":more,"next_cursor":next,"note":NOTE}),
        );
    }
    let ids = if action == "chunk" {
        vec![super::need_str(args, "message_id")?.to_string()]
    } else {
        let Some(ids) = args["message_ids"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 20 && a.iter().all(Value::is_string))
        else {
            crate::refuse!(BadRequest, "fetch needs 1 to 20 message IDs")
        };
        let mut out = Vec::new();
        for id in ids.iter().filter_map(Value::as_str) {
            if !out.iter().any(|s| s == id) {
                out.push(id.to_string())
            }
        }
        out
    };
    let sql=format!("SELECT to_jsonb(m)||jsonb_build_object('project_status',({STATUS_SQL})) FROM ot.mail m
        WHERE m.org_id=$1 AND {} AND {VISIBLE_SQL} AND m.uid=ANY($3) AND ($4='' OR ({STATUS_SQL})=$4) LIMIT 20",filter.predicate());
    let rows = client
        .query(&sql, &[&me.org_id, &p.id, &ids, &filter.status])
        .await?;
    let raw: Vec<Value> = rows.iter().map(|r| r.get(0)).collect();
    let mut items = Vec::new();
    let mut missing = Vec::new();
    let mut deferred = Vec::new();
    let mut budget = 256 * 1024usize;
    for id in ids {
        let Some(raw) = raw.iter().find(|m| m["uid"] == id) else {
            missing.push(id);
            continue;
        };
        let index = if action == "chunk" {
            args["chunk_index"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| anyhow::anyhow!("chunk needs a nonnegative chunk_index"))?
        } else {
            0
        };
        let mut chunk = super::mailtools::mail_chunk(raw["body"].as_str().unwrap_or(""), index)?;
        let did = format!(
            "project:{}:{}:{}:{}",
            me.id,
            p.id,
            id,
            chunk["body_sha256"].as_str().unwrap()
        );
        if action == "chunk" && args["delivery_id"].as_str() != Some(&did) {
            crate::refuse!(
                BadRequest,
                "delivery_id does not match this project message and body"
            )
        }
        let bytes = chunk["content"].as_str().unwrap().len();
        if bytes > budget {
            deferred.push(id);
            continue;
        }
        budget -= bytes;
        let mut item = shown(raw, &filter.folder);
        item.as_object_mut().unwrap().remove("body");
        // Structured quotes may themselves contain a whole long message. A
        // project read returns the body chunk and bounded queue metadata only.
        for key in ["ev", "reply_to", "replies"] {
            item.as_object_mut().unwrap().remove(key);
        }
        item.as_object_mut()
            .unwrap()
            .append(chunk.as_object_mut().unwrap());
        item["delivery_id"] = json!(did);
        item["project"] = json!(p.name);
        if let Some(attachments) = item["attachments"].as_array_mut() {
            attachments.retain(|a| a["transfer_removed"] != true)
        }
        items.push(item);
    }
    if action == "chunk" {
        return match items.first() {
            Some(v) => Done::json(v),
            None => {
                crate::refuse!(NotFound, "message not found in this project folder")
            }
        };
    }
    Done::json(
        &json!({"project":p.name,"folder":filter.folder,"messages":items,"not_found":missing,"not_waiting":missing,"deferred_ids":deferred,"note":NOTE}),
    )
}

#[cfg(test)]
mod project_agent_tool_tests {
    use super::*;
    #[test]
    fn project_tools_history_defaults_are_explicit_and_cursors_cannot_cross_scope() {
        assert_eq!(
            Filter::parse(&json!({"action":"list"})).unwrap().status,
            "waiting"
        );
        for folder in ["inbox", "sent"] {
            let f = Filter::parse(&json!({"action":"list","folder":folder})).unwrap();
            assert_eq!(f.status, "");
            let cursor = f.cursor(1, 2, 41);
            assert_eq!(f.before(&json!({"cursor":cursor}), 1, 2).unwrap(), 41);
            assert!(f.before(&json!({"cursor":cursor}), 3, 2).is_err());
            assert!(f.before(&json!({"cursor":cursor}), 1, 3).is_err());
            let changed = Filter {
                folder: folder.into(),
                status: "acked".into(),
            };
            assert!(changed.before(&json!({"cursor":cursor}), 1, 2).is_err());
        }
        for bad in [
            json!({"folder":"other"}),
            json!({"status":"bogus"}),
            json!({"status":4}),
        ] {
            assert!(Filter::parse(&bad).is_err())
        }
    }
    #[test]
    fn project_tools_history_projection_keeps_delivery_and_ack_metadata() {
        let raw = json!({"uid":"m1","body":"long body","kind":"request","state":"read","project_status":"acked",
            "extra":{"claimed":{"by":"a","at":"now","ack":true,"acked_at":"later"}}});
        let out = shown(&raw, "inbox");
        assert_eq!(out["state"], "read");
        assert_eq!(out["status"], "acked");
        assert_eq!(out["queue"]["held_by"], "a");
        assert_eq!(out["queue"]["acked_at"], "later");
        assert_eq!(out["kind"], "request");
    }
}
