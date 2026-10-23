//! Small display facts for the two optional desk reader tabs. No list/history
//! payload and no user-viewed write: each result is an EXISTS under its scope.
use std::sync::Arc;
use axum::{extract::{Path, Query, State}, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{engine::Engine, http::{error::ApiResult, orgs::org}};

#[derive(Debug, Default, Deserialize)]
pub struct Options {
    #[serde(default)] archived: bool,
    #[serde(default)] backlogged: bool,
    #[serde(default)] retired: bool,
}

#[logged]
pub async fn get(State(e): State<Arc<Engine>>, Path((slug,nid)): Path<(String,String)>,
    Query(q): Query<Options>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let client=e.db.get().await?;
    let root:Option<i64>=client.query_opt("SELECT id FROM ot.agents
        WHERE org_id=$1 AND name=$2 AND state <> 'deleted'
        ORDER BY (state='live') DESC,id DESC LIMIT 1",&[&o.id,&nid]).await?.map(|r|r.get(0));
    let mut asked=Vec::<String>::new();
    // Match ctx's canonical tabs, including old duplicate work_items arrays.
    // Only current open requests are read; no closed docket history is loaded.
    for row in client.query("SELECT k.body FROM ot.asks k JOIN ot.agents a ON a.id=k.agent_id
        WHERE k.org_id=$1 AND k.status='open' AND cardinality(k.work_items)>0",&[&o.id]).await? {
        let body:Value=row.get(0);
        if let Some(tabs)=body["questions"].as_array() {
            asked.extend(crate::domain::asks::attached_tabs(tabs).into_iter().map(|(id,_)|id));
        }
    }
    let names:Vec<String>=if let Some(root)=root {
        client.query("WITH RECURSIVE below(id,name,state) AS (
            SELECT id,name,state FROM ot.agents WHERE id=$1 AND org_id=$2
            UNION SELECT a.id,a.name,a.state FROM ot.agents a JOIN below b ON a.parent_id=b.id
              WHERE a.org_id=$2 AND a.state <> 'deleted') SELECT name FROM below",&[&root,&o.id])
            .await?.iter().map(|r|r.get(0)).collect()
    } else {vec![nid.clone()]};
    let now=chrono::Utc::now();
    let group=crate::domain::docket::PAGE_GROUP_SQL;
    let sql=format!("WITH source AS NOT MATERIALIZED (
        SELECT w.*, (manual_attention IS NOT NULL OR slug=ANY($2)) AS attention
        FROM ot.work_items w WHERE org_id=$1 AND NOT coalesce((extra->>'deleted')::boolean,false)
      ), visible AS NOT MATERIALIZED (
        SELECT * FROM source WHERE ({group})='items'
          OR ($6::boolean AND ({group})='archived') OR ($7::boolean AND ({group})='backlogged')
      ) SELECT EXISTS(SELECT 1 FROM visible WHERE owner->>'node'=$4 OR reviewer->>'node'=$4),
        EXISTS(SELECT 1 FROM visible WHERE owner->>'node'=ANY($5))");
    let work=client.query_one(&sql,&[&o.id,&asked,&now,&nid,&names,&q.archived,&q.backlogged]).await?;
    // Document identity is its agent id, so renames keep own presentations.
    // The cycle-safe UNION matches the existing human team gallery.
    let docs=client.query_one("WITH RECURSIVE below(id) AS (
        SELECT id FROM ot.agents WHERE id=$3 AND org_id=$1
        UNION SELECT a.id FROM ot.agents a JOIN below b ON a.parent_id=b.id WHERE a.org_id=$1
      ), visible AS NOT MATERIALIZED (
        SELECT d.agent_id,d.node_name FROM ot.documents d LEFT JOIN ot.agents a ON a.id=d.agent_id
        WHERE d.org_id=$1 AND NOT d.dismissed AND ($4::boolean OR a.state='live')
      ) SELECT EXISTS(SELECT 1 FROM visible WHERE agent_id=$3 OR (agent_id IS NULL AND node_name=$2)),
        EXISTS(SELECT 1 FROM visible WHERE agent_id IN (SELECT id FROM below)
          OR (agent_id IS NULL AND node_name=$2))",&[&o.id,&nid,&root,&q.retired]).await?;
    Ok(Json(json!({"work":{"own":work.get::<_,bool>(0),"team":work.get::<_,bool>(1)},
        "presented":{"own":docs.get::<_,bool>(0),"team":docs.get::<_,bool>(1)}})))
}
