//! The user's inbox, one message by id, the org's event log, an agent's
//! history, and an archived seat's full detail.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::scope;
use crate::domain::tree::{agent_body, TreeCtx};
use crate::engine::Engine;
use crate::feed::compute;
use crate::changes::{self, Change};
use crate::http::error::{ApiError, ApiResult};
use crate::http::nodes::agent;
use crate::http::orgs::org;

#[logged]
pub async fn inbox(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q):Query<InboxQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    if q.tags_only.unwrap_or(false) {
        return Ok(Json(crate::domain::mail_tags::choices_page(&client,o.id,q.prefix.as_deref().unwrap_or(""),q.after.as_deref()).await?));
    }
    if let Some(tag)=q.tag.as_deref().filter(|t|!t.trim().is_empty()) {
        return Ok(Json(crate::domain::mail_tags::window(&client,o.id,tag,q.before).await?));
    }
    let (pending, read, sent) = compute::user_mail(&client, o.id).await?;
    let pick = |v: Vec<(i64, Value)>| -> Vec<Value> { v.into_iter().map(|(_, m)| m).collect() };
    Ok(Json(json!({ "pending": pick(pending), "delivered": pick(read), "sent": pick(sent) })))
}

#[derive(Deserialize, Debug)]
pub struct InboxQuery {
    tag:Option<String>, before:Option<i64>, tags_only:Option<bool>, prefix:Option<String>, after:Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct TagFilter {
    tags:Vec<String>, before:Option<i64>,
}

#[logged]
pub async fn filter_inbox(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Json(body):Json<TagFilter>)->ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let client=e.db.get().await?;
    Ok(Json(crate::domain::mail_tags::window_many(&client,o.id,&body.tags,body.before).await?))
}

#[derive(Deserialize, Debug)]
pub struct Ids {
    #[serde(default)]
    ids: Vec<String>,
}

#[logged]
pub async fn mark_read(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Ids>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let n = client
        .execute(
            "UPDATE ot.mail SET state = 'read', read_at = now()
              WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id = $1 AND recipient_kind = 'user' AND uid = ANY($2) AND state = 'pending'",
            &[&o.id, &b.ids],
        )
        .await?;
    drop(client);
    changes::notify(&e, &o, vec![Change::UserMail]);
    Ok(Json(json!({ "read": n })))
}

#[logged]
pub async fn clear(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    client
        .execute(
            "UPDATE ot.mail SET state = 'read', read_at = now() WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id = $1 AND recipient_kind = 'user' AND state = 'pending'",
            &[&o.id],
        )
        .await?;
    drop(client);
    changes::notify(&e, &o, vec![Change::UserMail]);
    Ok(Json(json!({ "ok": true })))
}

/// Permanently remove one message copy addressed to the user. Sender history,
/// other recipients' copies and attachment files are independent records.
#[logged]
pub async fn delete_user_mail(
    State(e): State<Arc<Engine>>,
    Path((slug, uid)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let mut client = e.db.get().await?;
    let tx = client.transaction().await?;
    let deleted = tx.query_opt(
        "DELETE FROM ot.mail WHERE org_id = $1 AND uid = $2 AND recipient_kind = 'user' RETURNING id",
        &[&o.id, &uid],
    ).await?;
    if deleted.is_none() {
        return Err(ApiError::not_found("user inbox message not found"));
    }
    tx.execute(
        "DELETE FROM ot.mail_tags t WHERE t.org_id = $1
           AND NOT EXISTS (SELECT 1 FROM ot.mail_tag_links l WHERE l.org_id = t.org_id AND l.tag_key = t.key)",
        &[&o.id],
    ).await?;
    tx.commit().await?;
    drop(client);
    changes::notify(&e, &o, vec![Change::UserMail]);
    Ok(Json(json!({ "deleted": true })))
}

#[derive(Deserialize, Debug)]
pub struct NodeQuery {
    node: Option<String>,
}

/// One message from the box that holds it (a reference outside the loaded window).
#[logged]
pub async fn mail_by_id(
    State(e): State<Arc<Engine>>,
    Path((slug, boxname, id)): Path<(String, String, String)>,
    Query(q): Query<NodeQuery>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    if boxname == "org" { crate::domain::orginbox::require_enabled(&e, o.id).await?; }
    let found = match boxname.as_str() {
        "org" => client
            .query_opt("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id = $1 AND uid = $2", &[&o.id, &id])
            .await?
            .map(|r| crate::domain::orginbox::entry(&r.get::<_, Value>(0))),
        "user" => client
            .query_opt(
                "SELECT to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id)) FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id = $1 AND uid = $2 AND (recipient_kind = 'user' OR sender = '@user')",
                &[&o.id, &id],
            )
            .await?
            .map(|r| compute::mail_entry(&r.get::<_, Value>(0))),
        "node" => {
            let name = q.node.unwrap_or_default();
            client
                .query_opt(
                    "SELECT to_jsonb(m) FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id = $1 AND uid = $2
                        AND (recipient_name = $3 OR sender = $3)",
                    &[&o.id, &id, &name],
                )
                .await?
                .map(|r| {
                    let m: Value = r.get(0);
                    let mut entry = compute::mail_entry(&m);
                    entry["to"] = m["recipient_name"].clone();
                    entry
                })
        }
        other => return Err(ApiError::bad_request(format!("no mailbox {other}"))),
    };
    Ok(Json(json!({ "found": found.is_some(), "mail": found })))
}

#[derive(Deserialize, Debug)]
pub struct LastQuery {
    last: Option<i64>,
}

/// The event log, oldest first; `last` bounds it (none = the whole record).
#[logged]
pub async fn events(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<LastQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let last = q.last.unwrap_or(100_000).clamp(1, 100_000);
    let rows = client
        .query("SELECT to_jsonb(e) FROM ot.events e WHERE org_id = $1 ORDER BY id DESC LIMIT $2", &[&o.id, &last])
        .await?;
    let total: i64 = client.query_one("SELECT count(*) FROM ot.events WHERE org_id = $1", &[&o.id]).await?.get(0);
    let mut events: Vec<Value> = rows.iter().map(|r| compute::event_entry(&r.get::<_, Value>(0))).collect();
    events.reverse();
    Ok(Json(json!({ "total": total, "events": events })))
}

#[logged]
pub async fn history(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let a = agent(&e, &o, &nid).await?;
    let client = e.db.get().await?;
    let items: Vec<Value> = compute::agent_history(&client, a.id).await?.into_iter().map(|(_, v)| v).collect();
    Ok(Json(json!({ "items": items })))
}

/// The full record of one seat (archived seats arrive summarized).
#[logged]
pub async fn detail(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let a = agent(&e, &o, &nid).await?;
    let client = e.db.get().await?;
    let raws = compute::agents(&client, o.id, &[a.id]).await?;
    let Some(raw) = raws.get(&a.id) else { return Err(ApiError::not_found("that agent is gone")) };
    let org_row = compute::org_row(&client, o.id).await?;
    let held = compute::audiences_held(&client, o.id).await?;
    let chain: Vec<Value> = client
        .query(
            "WITH RECURSIVE chain(id, parent_id, scope, depth) AS (
               SELECT id, parent_id, scope, 0 FROM ot.agents WHERE id = $1
               UNION ALL SELECT x.id, x.parent_id, x.scope, c.depth + 1 FROM ot.agents x JOIN chain c ON x.id = c.parent_id
                WHERE c.depth < 1024)
             SELECT scope FROM chain ORDER BY depth DESC",
            &[&a.id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    drop(client);
    let settings = crate::feed::groups::effective_settings(&org_row["settings"], &e.settings.defaults());
    let mut eff = scope::org_ceiling(&settings["dirs"]);
    for s in &chain {
        eff = scope::clamp(s, &eff);
    }
    let accounts = e.accounts.view();
    let continue_primaries = crate::runtime::freeze::primary_tiers(&e, &o.slug);
    let muse = crate::providers::muse_catalogs(&e);
    let ctx = TreeCtx { org_settings: &settings, now: chrono::Utc::now(), accounts: &accounts, continue_primaries: &continue_primaries, muse: &muse, audiences_held: &held, org_slug: &o.slug };
    let mut body = agent_body(raw, &eff, a.parent_id, &ctx);
    if let Some(h) = e.agents.get(a.id) {
        let rt = h.view.load();
        if let (Some(b), Some(r)) = (body.as_object_mut(), rt.as_object()) {
            for (k, v) in r {
                b.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(Json(body))
}
