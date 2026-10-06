//! Desktop notices: everything waiting on the user in one org, as the
//! inventory the desktop's notification layer diffs (questions, urgent and
//! routine mail, ticket attention, frozen agents, new documents).

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::util::gist;

pub async fn for_org(client: &Client, org_id: i64, slug: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let asks = client
        .query(
            "SELECT k.uid, a.name, a.generation, k.body FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id
              WHERE k.org_id = $1 AND k.status = 'open' ORDER BY k.id LIMIT 200",
            &[&org_id],
        )
        .await?;
    for r in &asks {
        let uid: String = r.get(0);
        let agent: String = r.get(1);
        let body: Value = r.get(3);
        let q = body
            .get("question")
            .and_then(Value::as_str)
            .or_else(|| body.pointer("/questions/0/question").and_then(Value::as_str))
            .unwrap_or("has a question for you");
        out.push(json!({
            "id": format!("ask:{uid}"), "source_id": uid, "kind": "question", "org": slug,
            "agent": agent, "generation": r.get::<_, i32>(2),
            "title": format!("{agent} asks"), "body": gist(q, 300),
        }));
    }
    let mail = client
        .query(
            "SELECT uid, sender, body, urgent, urgent_reason FROM ot.mail
              WHERE org_id = $1 AND recipient_kind = 'user' AND state = 'pending' ORDER BY id DESC LIMIT 200",
            &[&org_id],
        )
        .await?;
    for r in &mail {
        let uid: String = r.get(0);
        let sender: String = r.get(1);
        let urgent: bool = r.get(3);
        let reason: Option<String> = r.get(4);
        let body: String = r.get(2);
        out.push(json!({
            "id": format!("mail:{uid}"), "source_id": uid,
            "kind": if urgent { "urgent-mail" } else { "routine" }, "org": slug, "agent": sender,
            "title": if urgent { format!("Urgent from {sender}") } else { format!("Mail from {sender}") },
            "body": gist(&reason.unwrap_or(body), 300),
        }));
    }
    let work = client
        .query(
            "SELECT slug, title, manual_attention FROM ot.work_items
              WHERE org_id = $1 AND archived_at IS NULL AND manual_attention IS NOT NULL LIMIT 200",
            &[&org_id],
        )
        .await?;
    for r in &work {
        let item: String = r.get(0);
        let att: Value = r.get(2);
        let rev = att.get("set_rev").and_then(Value::as_i64).unwrap_or(1);
        out.push(json!({
            "id": format!("work:{item}:{rev}"), "kind": "work-attention", "org": slug, "item": item, "rev": rev,
            "title": format!("Ticket needs you: {}", gist(&r.get::<_, String>(1), 120)),
            "body": gist(att.get("reason").and_then(Value::as_str).unwrap_or(""), 300),
        }));
    }
    let frozen = client
        .query(
            "SELECT name, generation, frozen FROM ot.agents WHERE org_id = $1 AND state = 'live' AND frozen IS NOT NULL LIMIT 200",
            &[&org_id],
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
    let docs = client
        .query(
            "SELECT uid, node_name, title FROM ot.documents
              WHERE org_id = $1 AND NOT dismissed AND at > now() - interval '1 day' ORDER BY id DESC LIMIT 50",
            &[&org_id],
        )
        .await?;
    for r in &docs {
        let uid: String = r.get(0);
        out.push(json!({
            "id": format!("doc:{uid}"), "source_id": uid, "kind": "document", "org": slug,
            "agent": r.get::<_, String>(1), "title": format!("{} presented a document", r.get::<_, String>(1)),
            "body": gist(&r.get::<_, String>(2), 300),
        }));
    }
    Ok(out)
}
