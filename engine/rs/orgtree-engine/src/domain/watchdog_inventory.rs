//! Bounded desktop watchdog previews, owner pages and exact handle reads.
use anyhow::Result;
use serde_json::{json, Map, Value};
use tokio_postgres::Client;
use crate::engine::Engine;

pub const PREVIEW: i64 = 8;
pub const PAGE_MAX: i64 = 100;

/// The first free slug (base, base-2, base-3, ...), without transferring
/// every kept identity into Rust. The insert's unique constraint still
/// resolves concurrent creates, which retry this read as before.
#[logged]
pub async fn available_id(client:&Client,owner:i64,base:&str)->Result<String>{
    let row=client.query_one("WITH taken AS MATERIALIZED (
        SELECT uid FROM ot.watchdogs WHERE owner_agent_id=$1 AND state IN ('armed','paused','exited')
          AND (uid=$2 OR uid LIKE $2||'-%')),
      candidates AS (
        SELECT $2::text AS id,1::numeric AS n UNION ALL SELECT $2||'-2',2::numeric
        UNION ALL SELECT $2||'-'||(substring(uid from char_length($2)+2)::numeric+1)::text,
          substring(uid from char_length($2)+2)::numeric+1 FROM taken
          WHERE uid ~ ('^'||$2||'-[0-9]+$') AND char_length(uid)<char_length($2)+20)
      SELECT c.id FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM taken t WHERE t.uid=c.id)
      ORDER BY c.n LIMIT 1",&[&owner,&base]).await?;
    Ok(row.get(0))
}
// Only current identity holders and their short-lived departing tombstones.
const CURRENT: &str = "(w.state IN ('armed','paused','exited') OR
    (w.state='spent' AND w.spent_at > now()-interval '15 seconds'
     AND NOT EXISTS (SELECT 1 FROM ot.watchdogs n WHERE n.owner_agent_id=w.owner_agent_id
       AND n.uid=w.uid AND n.id>w.id AND n.state<>'removed')))";

#[nolog]
fn shown(engine: &Engine, row: &Value, owner: &str) -> Value {
    let mut value=super::watchdogs::view(row,owner);
    if let Some(health)=row["id"].as_i64().and_then(|id|crate::runtime::watchdogs::events::health(engine,id)) {
        value["health"]=json!(health);
    }
    value
}

/// O(owners) generic rows, plus existing unique owner/project/kind edges.
/// Sorting/counting stays in PostgreSQL; no complete generic row set is
/// materialized in the engine or renderer.
#[logged]
pub async fn snapshot(client: &Client, engine: &Engine, org: i64) -> Result<Value> {
    let sql=format!("WITH eligible AS (
       SELECT w.*, a.name AS owner_name,
         row_number() OVER (PARTITION BY w.owner_agent_id ORDER BY (w.state='spent'),w.id) AS preview_rank,
         row_number() OVER (PARTITION BY w.owner_agent_id,w.kind,coalesce(w.memo->>'target_id',w.target)
                            ORDER BY (w.state='spent'),w.id DESC) AS relation_rank,
         count(*) OVER (PARTITION BY w.owner_agent_id) AS owner_total,
         count(*) FILTER (WHERE w.state<>'spent') OVER (PARTITION BY w.owner_agent_id) AS owner_kept,
         count(*) FILTER (WHERE w.once) OVER (PARTITION BY w.owner_agent_id) AS owner_once
       FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id
       WHERE w.org_id=$1 AND {CURRENT})
       SELECT to_jsonb(e),owner_name,preview_rank,owner_total,owner_kept,owner_once FROM eligible e
       WHERE preview_rank <= $2 OR (kind IN ('slot','fair_queue','project_listener','listener_watch')
         AND state IN ('armed','paused','exited') AND relation_rank=1) ORDER BY id");
    let rows=client.query(&sql,&[&org,&PREVIEW]).await?;
    let mut dogs=Vec::new();let mut links=Vec::new();let mut counts=Map::new();
    for row in rows {
        let record:Value=row.get(0);let owner:String=row.get(1);
        counts.insert(owner.clone(),json!({"total":row.get::<_,i64>(3),"kept":row.get::<_,i64>(4),"one_shot":row.get::<_,i64>(5)}));
        let value=shown(engine,&record,&owner);
        if row.get::<_,i64>(2)<=PREVIEW {dogs.push(value.clone());}
        if matches!(record["kind"].as_str(),Some("slot"|"fair_queue"|"project_listener"|"listener_watch"))
            && record["state"]!="spent" && record["relation_rank"]==1 {
            let mut metadata=value;
            if let Some(fields)=metadata.as_object_mut(){
                for key in ["events","last_output","connection","health"]{fields.remove(key);}
                fields.insert("metadata_only".into(),json!(true));
            }
            links.push(metadata);
        }
    }
    // The user's own registrations (no owner agent: the join above does not see
    // them), named "user" and drawn "you" by the desk: every one of them, since
    // a project's desk tables show each (bounded; the user keeps one dog of a kind
    // per project and a few slot requests).
    for row in client.query("SELECT to_jsonb(w) FROM ot.watchdogs w
        WHERE w.org_id=$1 AND w.owner_kind='user' AND w.state IN ('armed','paused','exited') ORDER BY w.id LIMIT 200",&[&org]).await? {
        let record:Value=row.get(0);
        let mut metadata=shown(engine,&record,crate::domain::user_regs::USER);
        if let Some(fields)=metadata.as_object_mut(){
            for key in ["events","last_output","connection","health"]{fields.remove(key);}
            fields.insert("metadata_only".into(),json!(true));
        }
        links.push(metadata);
    }
    Ok(json!({"watchdogs":dogs,"watchdog_counts":counts,"watchdog_project_links":links}))
}

#[logged]
pub async fn page(client:&Client,engine:&Engine,org:i64,owner:&str,cursor:i64,limit:i64,kept:bool)->Result<Value>{
    let limit=limit.clamp(1,PAGE_MAX);
    let sql=format!("SELECT to_jsonb(w),a.name,w.id FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id
        WHERE w.org_id=$1 AND a.name=$2 AND w.id>$3 AND {CURRENT} AND (NOT $5 OR w.state<>'spent') ORDER BY w.id LIMIT $4");
    let mut rows=client.query(&sql,&[&org,&owner,&cursor,&(limit+1),&kept]).await?;
    let more=rows.len()>limit as usize;rows.truncate(limit as usize);
    let next=if more {rows.last().map(|r|r.get::<_,i64>(2).to_string())}else{None};
    let count_sql=format!("SELECT count(*) FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id
        WHERE w.org_id=$1 AND a.name=$2 AND {CURRENT} AND (NOT $3 OR w.state<>'spent')");
    let total:i64=client.query_one(&count_sql,&[&org,&owner,&kept]).await?.get(0);
    let dogs:Vec<_>=rows.iter().map(|r|shown(engine,&r.get::<_,Value>(0),&r.get::<_,String>(1))).collect();
    Ok(json!({"watchdogs":dogs,"total":total,"next_cursor":next}))
}

#[logged]
pub async fn exact(client:&Client,engine:&Engine,org:i64,handle:&str)->Result<Value>{
    let Some((owner,uid))=handle.split_once('/').filter(|(o,u)|!o.is_empty()&&!u.is_empty()) else {
        crate::refuse!(BadRequest,"watchdog detail needs an owner/id handle");
    };
    let rows=client.query("SELECT to_jsonb(w),a.name FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id
        WHERE w.org_id=$1 AND a.name=$2 AND w.uid=$3 AND w.state<>'removed'
        ORDER BY w.state='spent',w.id DESC LIMIT 1",&[&org,&owner,&uid]).await?;
    let dogs:Vec<_>=rows.iter().map(|r|shown(engine,&r.get::<_,Value>(0),&r.get::<_,String>(1))).collect();
    Ok(json!({"watchdogs":dogs,"next_cursor":null}))
}
