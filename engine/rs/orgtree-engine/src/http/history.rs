//! The org Settings › History browser: retained records, newest first, a
//! page at a time. Each section is one table read by index, mapped onto the
//! fields the browser renders (title, actor, time, body, detail).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;

/// (id, label, needs an agent)
const SECTIONS: &[(&str, &str, bool)] = &[
    ("chat", "Chat transcript", true),
    ("node-mail", "Agent mail", true),
    ("user-mail", "Read user mail", false),
    ("user-sent", "User sent mail", false),
    ("org-mail", "Organization mail", false),
    ("notices", "Notices", false),
    ("documents", "Presented documents", false),
    ("events", "Organization events", false),
    ("errors", "Turn errors", true),
    ("watchdogs", "Watchdogs", false),
    ("turns", "Turn usage history", true),
];

/// `GET /api/orgs/{slug}/history`: the sections and the agents to pick from.
#[logged]
pub async fn sources(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let nodes: Vec<Value> = client
        .query(
            "SELECT name, state, generation FROM ot.agents WHERE org_id = $1 AND state <> 'deleted'
              ORDER BY (state = 'live') DESC, name LIMIT 2000",
            &[&o.id],
        )
        .await?
        .iter()
        .map(|r| json!({ "id": r.get::<_, String>(0), "state": r.get::<_, String>(1), "generation": r.get::<_, i32>(2) }))
        .collect();
    let collections: Vec<Value> =
        SECTIONS.iter().map(|(id, label, needs)| json!({ "id": id, "label": label, "needs_node": needs })).collect();
    Ok(Json(json!({ "collections": collections, "nodes": nodes })))
}

#[derive(Deserialize, Debug, Default)]
pub struct PageQuery {
    #[serde(default)]
    node: String,
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    limit: Option<i64>,
}

/// `GET /api/orgs/{slug}/history/{section}`: one page, newest first.
#[logged]
pub async fn page(
    State(e): State<Arc<Engine>>,
    Path((slug, section)): Path<(String, String)>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let Some((_, _, needs_node)) = SECTIONS.iter().find(|(id, _, _)| *id == section) else {
        return Err(ApiError::not_found(format!("no history section {section}")));
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let cursor: i64 = q.cursor.parse().unwrap_or(i64::MAX);
    let client = e.db.get().await?;
    let agent: i64 = if *needs_node {
        client
            .query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&o.id, &q.node])
            .await?
            .map(|r| r.get(0))
            .ok_or_else(|| ApiError::not_found(format!("no agent {}", q.node)))?
    } else {
        0
    };
    // each section: the scope (an org or an agent), its rows as (key, item)
    // newest first below the cursor, and its total
    let (rows_sql, total_sql, scope): (&str, &str, i64) = match section.as_str() {
        "chat" => (
            "SELECT seq, jsonb_build_object('role', body->>'role', 'text', body->>'text', 'at', body->>'ts')
               FROM ot.convo WHERE agent_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3",
            "SELECT count(*) FROM ot.convo WHERE agent_id = $1",
            agent,
        ),
        "node-mail" => (
            "SELECT id, jsonb_build_object('kind', kind, 'from', sender, 'node', recipient_name, 'body', body, 'at', created_at, 'state', state)
               FROM ot.mail WHERE (recipient_agent_id = $1 OR sender_agent_id = $1) AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.mail WHERE recipient_agent_id = $1 OR sender_agent_id = $1",
            agent,
        ),
        "user-mail" => (
            "SELECT id, jsonb_build_object('kind', kind, 'from', sender, 'body', body, 'at', created_at, 'state', state)
               FROM ot.mail WHERE org_id = $1 AND recipient_kind = 'user' AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.mail WHERE org_id = $1 AND recipient_kind = 'user'",
            o.id,
        ),
        "user-sent" => (
            "SELECT id, jsonb_build_object('kind', kind, 'node', recipient_name, 'body', body, 'at', created_at, 'state', state)
               FROM ot.mail WHERE org_id = $1 AND sender = '@user' AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.mail WHERE org_id = $1 AND sender = '@user'",
            o.id,
        ),
        "org-mail" => (
            "SELECT id, jsonb_build_object('kind', dir, 'peer', peer, 'body', body, 'at', at, 'state', state, 'by', by_name)
               FROM ot.org_inbox WHERE org_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.org_inbox WHERE org_id = $1",
            o.id,
        ),
        "notices" => (
            "SELECT id, jsonb_build_object('kind', 'notice', 'from', sender, 'node', recipient_name, 'body', body, 'at', created_at)
               FROM ot.mail WHERE org_id = $1 AND notice AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.mail WHERE org_id = $1 AND notice",
            o.id,
        ),
        "documents" => (
            "SELECT id, jsonb_build_object('id', uid, 'title', title, 'format', format, 'node', node_name, 'at', at,
                                           'dismissed', dismissed, 'bytes', bytes)
               FROM ot.documents WHERE org_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.documents WHERE org_id = $1",
            o.id,
        ),
        "events" => (
            "SELECT id, jsonb_build_object('op', op, 'actor', actor, 'at', at, 'detail', detail)
               FROM ot.events WHERE org_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.events WHERE org_id = $1",
            o.id,
        ),
        "errors" => (
            "SELECT id, jsonb_build_object('kind', 'turn error', 'body', error, 'at', started_at, 'model', model, 'account', account)
               FROM ot.turns WHERE agent_id = $1 AND error IS NOT NULL AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.turns WHERE agent_id = $1 AND error IS NOT NULL",
            agent,
        ),
        "watchdogs" => (
            "SELECT w.id, jsonb_build_object('title', w.name, 'kind', w.state, 'node', a.name, 'body', w.target, 'at', w.created_at,
                                             'detail', jsonb_build_object('kind', w.kind, 'fired', w.fired, 'last_fired', w.last_fired,
                                                                          'events', w.events, 'exit', w.exit))
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.id < $2 ORDER BY w.id DESC LIMIT $3",
            "SELECT count(*) FROM ot.watchdogs WHERE org_id = $1",
            o.id,
        ),
        "turns" => (
            "SELECT id, jsonb_build_object('kind', 'turn', 'at', started_at,
                                           'body', concat_ws(' · ', coalesce(model, '?'),
                                                             round(coalesce(cost_usd, 0), 4)::text || ' USD',
                                                             coalesce(toks, 0)::text || ' output tokens',
                                                             round(coalesce(ms, 0) / 1000.0, 1)::text || ' s',
                                                             CASE WHEN error IS NOT NULL THEN 'error: ' || error END),
                                           'detail', jsonb_build_object('input_tokens', input_tokens, 'cache_read', cache_read,
                                                                        'cache_write', cache_write, 'account', account,
                                                                        'cost_source', cost_source, 'killed', killed, 'denials', denials))
               FROM ot.turns WHERE agent_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
            "SELECT count(*) FROM ot.turns WHERE agent_id = $1",
            agent,
        ),
        _ => return Err(ApiError::not_found(format!("no history section {section}"))),
    };
    let rows = client.query(rows_sql, &[&scope, &cursor, &(limit + 1)]).await?;
    let total: i64 = client.query_one(total_sql, &[&scope]).await?.get(0);
    let more = rows.len() as i64 > limit;
    let rows: Vec<(i64, Value)> = rows.iter().take(limit as usize).map(|r| (r.get(0), r.get(1))).collect();
    let next_cursor = if more { rows.last().map(|(k, _)| k.to_string()) } else { None };
    let items: Vec<Value> = rows.into_iter().map(|(_, v)| v).collect();
    Ok(Json(json!({ "items": items, "total": total, "next_cursor": next_cursor })))
}
