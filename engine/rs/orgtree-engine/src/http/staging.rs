//! Durable browser staging tickets. A browser can lose its final response
//! without losing the completed upload id. Partial browser bodies need re-selection.
use std::sync::Arc;
use axum::{body::Body, extract::{Path, State}, Json};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use crate::{engine::Engine, util::uid};
use super::{error::{ApiError, ApiResult}, orgs::org};

#[derive(Debug, Deserialize)]
pub struct Start { name: String, bytes: u64, #[serde(default)] to: String }

#[logged]
pub async fn start(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Start>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let limit=super::orginbox::target_limit(&e,o.id,&b.to).await?;
    if b.bytes>limit.bytes { return Err(ApiError::new(axum::http::StatusCode::PAYLOAD_TOO_LARGE,limit.message())); }
    let name: String=b.name.chars().map(|c| if c.is_alphanumeric() || ".-_ ()+".contains(c) { c } else { '_' }).take(120).collect();
    let name=name.trim_matches([' ','.']);
    let name=if name.is_empty() { "file.bin" } else { name };
    let id=uid("u");
    let dir=e.cfg.path("uploads").join(&o.slug).join("@org-inbox");
    tokio::fs::create_dir_all(&dir).await.map_err(|err|ApiError::internal(err.to_string()))?;
    let path=dir.join(format!("{id}-{name}")).to_string_lossy().to_string();
    e.db.get().await?.execute("INSERT INTO ot.upload_stages(id,org_id,name,path,total) VALUES($1,$2,$3,$4,$5)",
        &[&id,&o.id,&name,&path,&(b.bytes as i64)]).await?;
    Ok(Json(json!({"id":id,"name":name,"bytes":b.bytes,"received":0,"state":"queued"})))
}

#[logged]
pub async fn status(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let mut c=e.db.get().await?;
    let tx=c.transaction().await?;
    tx.query_opt("SELECT id FROM ot.upload_stages WHERE org_id=$1 AND id=$2 FOR UPDATE",&[&o.id,&id]).await?
        .ok_or_else(||ApiError::not_found("staging ticket not found"))?;
    let mut abandoned=None;
    if !e.net.transfer_stops.pin().contains_key(&id) {
        // Register a writer before claiming the row, so a status read never
        // mistakes the brief start of a request for a dead writer.
        if let Some(r)=tx.query_opt("UPDATE ot.upload_stages SET state='failed',error='Local upload interrupted; select the file again to restart',updated_at=now() WHERE org_id=$1 AND id=$2 AND (state='uploading' OR (state='queued' AND updated_at<now()-interval '24 hours')) RETURNING path",&[&o.id,&id]).await? {
            abandoned=Some(r.get::<_,String>(0));
        }
    }
    let r=tx.query_opt("SELECT name,total,received,state,error FROM ot.upload_stages WHERE org_id=$1 AND id=$2",&[&o.id,&id]).await?
        .ok_or_else(||ApiError::not_found("staging ticket not found"))?;
    tx.commit().await?;
    drop(c);
    if let Some(path)=abandoned { let _=tokio::fs::remove_file(path).await; }
    Ok(Json(json!({"id":id,"name":r.get::<_,String>(0),"bytes":r.get::<_,i64>(1),"received":r.get::<_,i64>(2),"state":r.get::<_,String>(3),"error":r.get::<_,Option<String>>(4)})))
}

#[logged]
pub async fn cancel(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let r=e.db.get().await?.query_opt("UPDATE ot.upload_stages SET state='cancelled',error='Cancelled by user',updated_at=now() WHERE org_id=$1 AND id=$2 AND state IN ('queued','uploading','failed','cancelled') RETURNING path",&[&o.id,&id]).await?;
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
            let chunk=tokio::select! { biased; _=stop.cancelled()=>return Err(ApiError::bad_request("local upload cancelled")), chunk=chunks.next()=>chunk };
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
        let remove=e.db.get().await?.execute("UPDATE ot.upload_stages SET state=CASE WHEN state='cancelled' THEN state ELSE 'failed' END,error=CASE WHEN state='cancelled' THEN error ELSE $2 END,updated_at=now() WHERE id=$1 AND state IN ('uploading','cancelled')",&[&id,&err.detail]).await?>0;
        if remove { let _=tokio::fs::remove_file(&path).await; }
    }
    outcome
}
