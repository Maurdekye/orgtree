//! Desktop notices: everything waiting on the user in one org, as the
//! inventory the desktop's notification layer diffs (questions, urgent and
//! routine mail, ticket attention, frozen agents, new documents).

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::{Client, Row};

use crate::util::gist;

#[logged]
pub async fn for_org(client: &Client, org_id: i64, slug: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let asks = all_rows(client,
            "SELECT k.uid, a.name, a.generation, k.body, k.id FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
              WHERE k.org_id = $1 AND k.status = 'open' AND a.state = 'live' AND k.id > $2 ORDER BY k.id LIMIT 200",
            org_id, 0,
        )
        .await?;
    for r in &asks {
        let uid: String = r.get(0);
        let agent: String = r.get(1);
        let body: Value = r.get(3);
        let q = body
            .get("question")
            .and_then(Value::as_str)
            .or_else(|| {
                body.pointer("/questions/0/question")
                    .and_then(Value::as_str)
            })
            .unwrap_or("has a question for you");
        out.push(json!({
            "id": format!("ask:{uid}"), "source_id": uid, "kind": "question", "org": slug,
            "agent": agent, "generation": r.get::<_, i32>(2),
            "title": format!("{agent} asks"), "body": gist(q, 300),
        }));
    }
    let mail = all_rows(client,
            "SELECT uid, sender, body, urgent, urgent_reason, ev, reply_to, replies, id FROM ot.mail
              WHERE org_id = $1 AND recipient_kind = 'user' AND state = 'pending' AND id < $2 ORDER BY id DESC LIMIT 200",
            org_id, i64::MAX,
        )
        .await?;
    for r in &mail {
        let uid: String = r.get(0);
        let sender: String = r.get(1);
        let body: String = r.get(2);
        let urgent: bool = r.get(3);
        let reason: Option<String> = r.get(4);
        let ev: Option<Value> = r.get(5);
        let reply_to: Option<Value> = r.get(6);
        let replies: Option<Value> = r.get(7);
        let attention = super::mail_attention::qualifies(&json!({
            "urgent": urgent, "body": &body, "ev": &ev, "reply_to": &reply_to, "replies": &replies
        }));
        out.push(mail_notice(slug, &uid, &sender, urgent, attention,
            &reason.unwrap_or(body), &ev));
    }
    let work = all_rows(
        client,
        "SELECT slug, title, manual_attention, notification_attention_epoch, id FROM ot.work_items
              WHERE org_id = $1 AND manual_attention IS NOT NULL AND id > $2 ORDER BY id LIMIT 200",
        org_id,
        0,
    )
    .await?;
    for r in &work {
        let item: String = r.get(0);
        let att: Value = r.get(2);
        let rev = att.get("set_rev").and_then(Value::as_i64).unwrap_or(1);
        let epoch = r.get::<_, Option<i64>>(3).unwrap_or(rev);
        out.push(json!({
            "id": format!("work:{item}:{epoch}"), "kind": "work-attention", "org": slug, "item": item, "rev": rev,
            "title": format!("Ticket needs you: {}", gist(&r.get::<_, String>(1), 120)),
            "body": gist(att.get("reason").and_then(Value::as_str).unwrap_or(""), 300),
        }));
    }
    // Match the existing count's duplicate-mail exclusion: expose the same
    // pending marker, rather than inventing a second counter or poller.
    let mentions = all_rows(client,
        &format!("SELECT a.name, a.generation, a.extra->'user_mention', a.id FROM ot.agents a
          WHERE a.org_id = $1 AND a.state = 'live' AND a.id > $2
            AND a.extra->'user_mention' IS NOT NULL AND a.extra->>'user_mention' <> 'null'
            AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE m.org_id=$1 AND m.recipient_kind='user'
              AND m.state='pending' AND {}) ORDER BY a.id LIMIT 200", super::mail_attention::DUPLICATE_MENTION_SQL),
        org_id, 0).await?;
    for r in &mentions {
        let agent: String = r.get(0);
        let generation: i32 = r.get(1);
        let marker: Value = r.get(2);
        out.push(mention_notice(slug, &agent, generation, &marker));
    }
    let work_mentions = all_rows(
        client,
        "SELECT slug, title, extra->'user_mention', id FROM ot.work_items
              WHERE org_id = $1 AND archived_at IS NULL
                AND NOT coalesce((extra->>'deleted')::boolean, false)
                AND extra->'user_mention' IS NOT NULL AND extra->>'user_mention' <> 'null'
                AND id > $2 ORDER BY id LIMIT 200",
        org_id,
        0,
    )
    .await?;
    for r in &work_mentions {
        let item: String = r.get(0);
        let title: String = r.get(1);
        let marker: Value = r.get(2);
        out.push(work_mention_notice(slug, &item, &title, &marker));
    }
    let frozen = all_rows(client,
            "SELECT name, generation, frozen, id FROM ot.agents WHERE org_id = $1 AND state = 'live' AND frozen IS NOT NULL AND id > $2 ORDER BY id LIMIT 200",
            org_id, 0,
        )
        .await?;
    for r in &frozen {
        let name: String = r.get(0);
        let gen: i32 = r.get(1);
        let fz: Value = r.get(2);
        let at = fz.get("at").and_then(Value::as_str).unwrap_or("");
        out.push(json!({
            "id": format!("frozen:{name}:{gen}:{at}"), "kind": "agent-frozen", "org": slug, "agent": name,
            "generation": gen, "title": format!("{name} is frozen"),
            "body": gist(fz.get("error").and_then(Value::as_str).unwrap_or("usage limit reached"), 300),
        }));
    }
    let docs = all_rows(
        client,
        "SELECT uid, node_name, title, COALESCE(presented_by, node_name),
                CASE WHEN (viewed_at IS NULL OR viewed_at < at) AND format = 'markdown' AND (title ~* '@user' OR body ~* '@user')
                     THEN concat_ws(E'\n', title, body)
                     WHEN (viewed_at IS NULL OR viewed_at < at) AND title ~* '@user'
                     THEN title
                     ELSE NULL END,
                id FROM ot.documents
              WHERE org_id = $1 AND NOT dismissed AND id < $2 ORDER BY id DESC LIMIT 200",
        org_id,
        i64::MAX,
    )
    .await?;
    for r in &docs {
        let uid: String = r.get(0);
        let node_name: String = r.get(1);
        let title: String = r.get(2);
        let presenter: String = r.get(3);
        out.push(json!({
            "id": format!("doc:{uid}"), "source_id": uid, "kind": "document", "org": slug,
            "agent": node_name, "title": format!("{node_name} presented a document"),
            "body": gist(&title, 300),
        }));
        if let Some(prose) = r.get::<_, Option<String>>(4) {
            if let Some(blurb) = crate::runtime::convo::user_mention_blurb(&prose) {
                out.push(doc_mention_notice(slug, &uid, &presenter, &title, &blurb));
            }
        }
    }
    Ok(out)
}

#[nolog]
fn mail_notice(slug: &str, uid: &str, sender: &str, urgent: bool, attention: bool,
    body: &str, event: &Option<Value>) -> Value {
    let excerpt = if !urgent && attention {
        crate::runtime::convo::user_mention_blurb(body).unwrap_or_else(|| body.to_string())
    } else {
        body.to_string()
    };
    json!({
        "id": format!("mail:{uid}"), "source_id": uid,
        // Failure kind controls toast policy; preserve the canonical urgent-or-
        // mention qualification separately for taskbar attention eligibility.
        "kind": mail_kind(urgent, attention, event), "attention": attention, "org": slug, "agent": sender,
        "title": if urgent { format!("Urgent from {sender}") } else if attention {format!("Mention from {sender}")} else { format!("Mail from {sender}") },
        "body": gist(if excerpt.is_empty() { "Mentioned you" } else { &excerpt }, 300),
    })
}

#[nolog]
fn mention_notice(slug: &str, agent: &str, generation: i32, marker: &Value) -> Value {
    let mut v = json!({
        "id": format!("mention:{agent}:{generation}:{}", marker["id"].as_str().unwrap_or("unknown")),
        "kind": "mention", "org": slug, "agent": agent, "generation": generation,
        "title": format!("{agent} mentioned you"),
        "body": gist(marker["blurb"].as_str().filter(|s| !s.is_empty()).unwrap_or("Mentioned you"), 300),
    });
    if let Some(eid) = marker["event_id"].as_str().filter(|s| !s.is_empty() && s.len() <= 128) {
        v["source_id"] = json!(eid);
    }
    v
}

#[nolog]
fn doc_mention_notice(slug: &str, uid: &str, agent: &str, title: &str, blurb: &str) -> Value {
    json!({
        "id": format!("mention:doc:{uid}"), "source_id": uid, "kind": "mention", "attention": false,
        "org": slug, "agent": agent,
        "title": format!("{agent} mentioned you in {}", gist(title, 80)),
        "body": gist(if blurb.is_empty() { "Mentioned you" } else { blurb }, 300),
    })
}

#[nolog]
fn work_mention_notice(slug: &str, item: &str, title: &str, marker: &Value) -> Value {
    let agent = marker["agent"].as_str().filter(|s| !s.is_empty()).unwrap_or("agent");
    let rev = marker["rev"].as_i64().unwrap_or(1).max(0);
    let blurb = marker["blurb"].as_str().filter(|s| !s.is_empty()).unwrap_or(if title.is_empty() { "Mentioned you" } else { title });
    let mut v = json!({
        "id": format!("mention:work:{item}:{rev}"), "kind": "mention", "attention": false,
        "org": slug, "item": item, "agent": agent, "rev": rev,
        "title": format!("{agent} mentioned you on {item}"),
        "body": gist(blurb, 300),
    });
    if let Some(gen) = marker["generation"].as_i64().filter(|g| *g >= 0) {
        v["generation"] = json!(gen);
    }
    v
}

#[cfg(test)]
mod taskbar_notice_tests {
    use super::*;
    #[test]
    fn failure_mail_keeps_its_existing_urgent_or_mention_qualification() {
        for (urgent, body, expected) in [(false, "Failure", false), (true, "Failure", true), (false, "Help @user", true)] {
            let mail = json!({"urgent": urgent, "body": body});
            let attention = super::super::mail_attention::qualifies(&mail);
            let notice = mail_notice("org", "uid", "helper", urgent, attention, body,
                &Some(json!({"variant": "runtime.turn_failed_terminal"})));
            assert_eq!(notice["kind"], "terminal-failure");
            assert_eq!(notice["attention"], expected);
            assert_eq!(notice["source_id"], "uid");
        }
    }

    #[test]
    fn mention_identity_tracks_marker_not_streaming_prose() {
        let first = mention_notice("org", "agent", 3, &json!({"id":"um-1-2","blurb":"Hello @user"}));
        let refined = mention_notice("org", "agent", 3, &json!({"id":"um-1-2","blurb":"Hello @user again"}));
        assert_eq!(first["id"], refined["id"]);
        assert_ne!(first["body"], refined["body"]);
        assert_eq!(first["agent"], "agent");
        assert_eq!(first["generation"], 3);
        assert_eq!(first["kind"], "mention");
        assert_ne!(first["id"], mention_notice("org", "agent", 4, &json!({"id":"um-1-2"}))["id"]);
        assert_ne!(first["id"], mention_notice("org", "agent", 3, &json!({"id":"um-2-4"}))["id"]);
    }

    #[test]
    fn mention_mail_and_doc_and_docket_notices_use_mention_category() {
        let mail_mention = mail_notice("org", "m1", "helper", false, true, "Before `@user` and real @user here", &None);
        assert_eq!(mail_mention["kind"], "mention");
        assert_eq!(mail_mention["attention"], true);
        assert_eq!(mail_mention["title"], "Mention from helper");
        assert_eq!(mail_mention["source_id"], "m1");
        assert!(mail_mention["body"].as_str().unwrap().contains("real @user here"));

        let urgent_mention = mail_notice("org", "m2", "helper", true, true, "Urgent @user", &None);
        assert_eq!(urgent_mention["kind"], "urgent-mail");

        let transcript = mention_notice("org", "helper", 2, &json!({"id":"um-3-5","event_id":"e3","blurb":"Hi @user"}));
        assert_eq!(transcript["kind"], "mention");
        assert_eq!(transcript["source_id"], "e3");

        let doc = doc_mention_notice("org", "d1", "helper", "Spec Doc", "Section for @user");
        assert_eq!(doc["id"], "mention:doc:d1");
        assert_eq!(doc["source_id"], "d1");
        assert_eq!(doc["kind"], "mention");
        assert_eq!(doc["attention"], false);

        let work = work_mention_notice("org", "item-slug", "Item Title", &json!({"rev":4,"agent":"helper","generation":2,"blurb":"Updated for @user"}));
        assert_eq!(work["id"], "mention:work:item-slug:4");
        assert_eq!(work["item"], "item-slug");
        assert_eq!(work["kind"], "mention");
        assert_eq!(work["attention"], false);
        assert_eq!(work["agent"], "helper");
        assert_eq!(work["generation"], 2);
    }
}

/// How many things in this org need the user: open question cards on live
/// agents, unread urgent mail to the user, docket items with the attention
/// flag up, and unseen `@user` mentions on live agents.
#[logged]
pub async fn attention_count(client: &Client, org_id: i64) -> Result<i64> {
    let mail = super::mail_attention::pending_summary(client,org_id,false).await?;
    let r = client
        .query_one(
            &format!("SELECT (SELECT count(*) FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
                      WHERE k.org_id = $1 AND k.status = 'open' AND a.state = 'live')
                  + (SELECT count(*) FROM ot.work_items WHERE org_id = $1 AND manual_attention IS NOT NULL)
                  + (SELECT count(*) FROM ot.agents a WHERE a.org_id = $1 AND a.state = 'live'
                      AND a.extra->'user_mention' IS NOT NULL AND a.extra->>'user_mention' <> 'null'
                      AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE m.org_id=$1 AND m.recipient_kind='user' AND m.state='pending' AND {}))",super::mail_attention::DUPLICATE_MENTION_SQL),
            &[&org_id],
        )
        .await?;
    Ok(r.get::<_,i64>(0)+mail.attention)
}

/// Typed failures alert even when routine mail is disabled (3.x parity).
#[logged]
fn mail_kind(urgent: bool, attention: bool, event: &Option<Value>) -> &'static str {
    let terminal = event.as_ref().is_some_and(|ev| {
        matches!(
            ev["variant"].as_str(),
            Some(
                "runtime.turn_failed_terminal"
                    | "runtime.background_task_stopped"
                    | "runtime.subagent_died"
            )
        ) || (ev["variant"] == "runtime.report_stalled" && ev["cause"] == "terminal")
    });
    if terminal {
        "terminal-failure"
    } else if urgent {
        "urgent-mail"
    } else if attention {
        "mention"
    } else {
        "routine"
    }
}

/// Read the complete inventory in bounded keyset pages. The final column is
/// always its stable row id; a page boundary must never mean "no more notices".
#[logged]
async fn all_rows(client: &Client, sql: &str, org_id: i64, mut cursor: i64) -> Result<Vec<Row>> {
    let mut all = Vec::new();
    loop {
        let rows = client.query(sql, &[&org_id, &cursor]).await?;
        let count = rows.len();
        if let Some(last) = rows.last() {
            cursor = last.get(last.len() - 1);
        }
        all.extend(rows);
        if count < 200 {
            return Ok(all);
        }
    }
}
