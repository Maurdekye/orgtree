//! Durable browser staging tickets. A browser can lose its final response
//! without losing the completed upload id. Partial browser bodies need re-selection.
use std::sync::Arc;
use axum::{body::Body, extract::{Path, Query, State}, Json};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use crate::{engine::Engine, util::uid};
use super::{error::{ApiError, ApiResult}, orgs::org};

#[derive(Debug, Deserialize)]
pub struct Start { name: String, bytes: u64, #[serde(default)] to: String, #[serde(default)] draft: String }

#[logged]
pub async fn start(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Start>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    if b.draft.len()>100 { return Err(ApiError::bad_request("draft id is too long")); }
    let limit=super::orginbox::target_limit(&e,o.id,&b.to).await?;
    if b.bytes>limit.bytes { return Err(ApiError::new(axum::http::StatusCode::PAYLOAD_TOO_LARGE,limit.message())); }
    let name: String=b.name.chars().map(|c| if c.is_alphanumeric() || ".-_ ()+".contains(c) { c } else { '_' }).take(120).collect();
    let name=name.trim_matches([' ','.']);
    let name=if name.is_empty() { "file.bin" } else { name };
    let id=uid("u");
    let dir=e.cfg.path("uploads").join(&o.slug).join("@org-inbox");
    tokio::fs::create_dir_all(&dir).await.map_err(|err|ApiError::internal(err.to_string()))?;
    let path=dir.join(format!("{id}-{name}")).to_string_lossy().to_string();
    e.db.get().await?.execute("INSERT INTO ot.upload_stages(id,org_id,name,path,total,draft) VALUES($1,$2,$3,$4,$5,$6)",
        &[&id,&o.id,&name,&path,&(b.bytes as i64),&b.draft]).await?;
    Ok(Json(json!({"id":id,"name":name,"bytes":b.bytes,"received":0,"state":"queued"})))
}

#[logged]
pub async fn status(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let value=crate::domain::staging::inspect(&e,o.id,&id).await?
        .ok_or_else(||ApiError::not_found("staging ticket not found"))?;
    Ok(Json(value))
}

#[logged]
pub async fn cancel(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let r=e.db.get().await?.query_opt("UPDATE ot.upload_stages SET state='cancelled',error='Cancelled by user',updated_at=now() WHERE org_id=$1 AND id=$2 AND state IN ('queued','uploading','cancelled') RETURNING path",&[&o.id,&id]).await?;
    if let Some(r)=r {
        let token=e.net.transfer_stops.pin().get(&id).cloned();
        if let Some(token)=token { token.cancel(); }
        else { let _=tokio::fs::remove_file(r.get::<_,String>(0)).await; }
    }
    status(State(e),Path((slug,id))).await
}

#[logged]
pub async fn upload(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>, body: Body) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let stop=CancellationToken::new();
    if e.net.transfer_stops.pin().try_insert(id.clone(),stop.clone()).is_err() {
        return Err(ApiError::conflict("staging ticket already has a writer"));
    }
    let result=write(&e,o.id,&id,body,stop).await;
    e.net.transfer_stops.pin().remove(&id);
    // Recover/clean even a failed body, while preserving its HTTP error.
    let _=crate::domain::staging::inspect(&e,o.id,&id).await;
    result?;
    status(State(e),Path((slug,id))).await
}

#[logged]
async fn write(e: &Engine, org: i64, id: &str, body: Body, stop: CancellationToken) -> ApiResult<()> {
    let r=e.db.get().await?.query_opt("UPDATE ot.upload_stages SET state='uploading',updated_at=now() WHERE org_id=$1 AND id=$2 AND state='queued' AND updated_at>=now()-interval '24 hours' RETURNING name,path,total",&[&org,&id]).await?
        .ok_or_else(||ApiError::conflict("staging ticket is no longer queued; inspect it before retrying"))?;
    let name:String=r.get(0); let path:String=r.get(1); let total:i64=r.get(2);
    let outcome:ApiResult<()>=async {
        let mut f=tokio::fs::File::create(&path).await.map_err(|err|ApiError::internal(err.to_string()))?;
        let mut chunks=body.into_data_stream(); let mut received=0i64; let mut last=std::time::Instant::now();
        loop {
            let chunk=tokio::select! {
                biased;
                _=e.shutdown.cancelled()=>return Err(ApiError::unavailable("Local upload interrupted by engine shutdown; select the file again")),
                _=stop.cancelled()=>return Err(ApiError::bad_request("local upload cancelled")),
                chunk=chunks.next()=>chunk,
            };
            let Some(chunk)=chunk else { break; };
            let chunk=chunk.map_err(|err|ApiError::bad_request(format!("Local upload interrupted: {err}; select the file again")))?;
            received+=chunk.len() as i64;
            if received>total { return Err(ApiError::bad_request("local upload exceeds its declared size")); }
            f.write_all(&chunk).await.map_err(|err|ApiError::internal(err.to_string()))?;
            if last.elapsed().as_millis()>=250 {
                e.db.get().await?.execute("UPDATE ot.upload_stages SET received=$2,updated_at=now() WHERE id=$1 AND state='uploading'",&[&id,&received]).await?;
                last=std::time::Instant::now();
            }
        }
        if received!=total { return Err(ApiError::bad_request("Local upload incomplete; select the file again")); }
        f.flush().await.map_err(|err|ApiError::internal(err.to_string()))?;
        f.sync_data().await.map_err(|err|ApiError::internal(err.to_string()))?;
        drop(f);
        let mut c=e.db.get().await?; let tx=c.transaction().await?;
        if tx.execute("UPDATE ot.upload_stages SET state='complete',received=total,updated_at=now() WHERE id=$1 AND state='uploading'",&[&id]).await?==0 {
            return Err(ApiError::bad_request("local upload cancelled before completion"));
        }
        tx.execute("INSERT INTO ot.uploads(id,org_id,agent_id,name,path,bytes) VALUES($1,$2,NULL,$3,$4,$5)",&[&id,&org,&name,&path,&total]).await?;
        tx.commit().await?;
        Ok(())
    }.await;
    if let Err(err)=&outcome {
        // A commit error may have lost only the acknowledgement. Never delete
        // bytes if completion actually committed, and preserve user cancellation.
        let mut c=e.db.get().await?; let tx=c.transaction().await?;
        tx.execute("UPDATE ot.upload_stages SET state=CASE WHEN state='cancelled' THEN state ELSE 'failed' END,error=CASE WHEN state='cancelled' THEN error ELSE $2 END,updated_at=now() WHERE id=$1 AND state IN ('uploading','cancelled')",&[&id,&err.detail]).await?;
        crate::domain::staging::failure(&tx,org,id).await?;
        tx.commit().await?;
    }
    outcome
}

#[derive(Debug,Deserialize)]
pub struct ListQuery { #[serde(default)] after: String }

/// Saved files are recovered explicitly, never attached to an unrelated draft
/// automatically. Pagination keeps older unsent files discoverable.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let rows=e.db.get().await?.query("SELECT id FROM ot.upload_stages WHERE org_id=$1 AND NOT hidden AND id>$2 ORDER BY id LIMIT 33", &[&o.id,&q.after]).await?;
    let more=rows.len()>32;
    let mut entries=Vec::new();
    let mut next=String::new();
    for row in rows.iter().take(32) {
        let id:String=row.get(0);
        if let Some(value)=crate::domain::staging::inspect(&e,o.id,&id).await? { entries.push(value); }
        next=id;
    }
    Ok(Json(json!({"files":entries,"next":if more {Some(next)} else {None}})))
}

/// Dismissal only hides the recovery entry; it never removes bytes which an
/// already queued message might own. Active writers must be cancelled first.
#[logged]
pub async fn dismiss(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let changed=e.db.get().await?.execute("UPDATE ot.upload_stages SET hidden=true WHERE org_id=$1 AND id=$2 AND state IN ('complete','failed','cancelled')", &[&o.id,&id]).await?;
    if changed==0 { return Err(ApiError::conflict("local file is still uploading; cancel it first")); }
    Ok(Json(json!({"ok":true})))
}
