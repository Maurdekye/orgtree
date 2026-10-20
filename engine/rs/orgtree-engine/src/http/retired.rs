//! The retired pile's lightweight, parent-scoped cursor pages. No tree expansion.
use std::sync::Arc;
use axum::{extract::{Path, Query, State}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{engine::Engine, http::{error::{ApiError, ApiResult}, orgs::org}};

#[derive(Debug, Deserialize)]
pub struct Read { #[serde(default)] parent: String, #[serde(default)] q: String, cursor: Option<String> }
#[derive(Debug, Deserialize, Serialize)]
struct Cursor { org: i64, parent: i64, q: String, touched: i64, order: f64, id: i64 }

#[logged]
fn decode(raw: &str, org: i64, parent: i64, q: &str) -> ApiResult<Cursor> {
    let bad = || ApiError::bad_request("invalid retired cursor for this org, parent or search");
    if raw.len()>4096 { return Err(bad()); }
    let bytes=hex::decode(raw).map_err(|_|bad())?;
    let c:Cursor=serde_json::from_slice(&bytes).map_err(|_|bad())?;
    if c.org!=org || c.parent!=parent || c.q!=q || !c.order.is_finite() || c.id<=0 {return Err(bad());}
    Ok(c)
}

#[logged]
pub async fn page(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Query(read):Query<Read>)->ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let q=read.q.trim().to_string();
    if q.chars().count()>128 { return Err(ApiError::bad_request("retired search is at most 128 characters")); }
    let client=e.db.get().await?;
    let parent=if read.parent.is_empty() {0} else {
        client.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state<>'deleted'",&[&o.id,&read.parent]).await?
            .ok_or_else(||ApiError::not_found("retired pile parent not found"))?.get::<_,i64>(0)
    };
    let c=read.cursor.as_deref().map(|s|decode(s,o.id,parent,&q)).transpose()?;
    let mut sql=String::from("WITH page AS MATERIALIZED (SELECT * FROM ot.retired_picker WHERE org_id=$1 AND parent_key=$2");
    // Literal substring, including '%' and '_'; no SQL wildcard semantics.
    sql.push_str(" AND ($3='' OR strpos(lower(name),lower($3))>0)");
    if c.is_some(){sql.push_str(" AND (touched,sibling_order,agent_id)<($4,$5,$6)");}
    sql.push_str(" ORDER BY touched DESC,sibling_order DESC,agent_id DESC LIMIT 51) SELECT p.agent_id,p.touched,p.sibling_order,a.name,a.state,a.tier, t.ended_at,t.started_at,t.killed FROM page p JOIN ot.agents a ON a.id=p.agent_id LEFT JOIN ot.turns t ON t.id=p.turn_id ORDER BY p.touched DESC,p.sibling_order DESC,p.agent_id DESC");
    let mut params:Vec<&(dyn tokio_postgres::types::ToSql+Sync)>=vec![&o.id,&parent,&q];
    if let Some(c)=&c {params.push(&c.touched);params.push(&c.order);params.push(&c.id);}
    let rows=client.query(&sql,&params).await?;
    let next=if rows.len()>50 {let r=&rows[49];Some(hex::encode(serde_json::to_vec(&Cursor{org:o.id,parent,q:q.clone(),touched:r.get(1),order:r.get(2),id:r.get(0)}).map_err(anyhow::Error::from)?))}else{None};
    let agents:Vec<Value>=rows.iter().take(50).map(|r| {
        let end:Option<chrono::DateTime<chrono::Utc>>=r.get(6);
        let start:Option<chrono::DateTime<chrono::Utc>>=r.get(7);
        let turns=end.or(start).map(|at|vec![json!({"at":at.to_rfc3339(),"killed":r.get::<_,Option<bool>>(8).unwrap_or(false)})]).unwrap_or_default();
        json!({"id":r.get::<_,String>(3),"state":r.get::<_,String>(4),"tier":r.get::<_,String>(5),"turns":turns,"children":[]})
    }).collect();
    Ok(Json(json!({"agents":agents,"next_cursor":next})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn cursor_is_scoped_and_rejects_bad_keys(){
        let c=Cursor{org:2,parent:3,q:"needle".into(),touched:0,order:1.5,id:7};
        let raw=hex::encode(serde_json::to_vec(&c).unwrap());
        assert!(decode(&raw,2,3,"needle").is_ok());
        for (org,parent,q) in [(1,3,"needle"),(2,4,"needle"),(2,3,"")] {assert!(decode(&raw,org,parent,q).is_err());}
        for raw in ["-1","xyz",&"a".repeat(4097)] {assert!(decode(raw,2,3,"needle").is_err());}
    }
}
