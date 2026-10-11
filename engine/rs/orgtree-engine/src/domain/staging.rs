//! Browser upload recovery and bounded cleanup, independent of HTTP handlers.
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use crate::{engine::Engine, util::uid};

#[logged]
pub async fn failure(tx: &Transaction<'_>, org: i64, id: &str) -> Result<()> {
    // One notice for a draft's failed local files, with no uninvolved agent copy.
    tx.execute("INSERT INTO ot.net_transfer_failures(id,org_id,message_key,detail) SELECT $3,org_id,'stage:'||org_id::text||':'||CASE WHEN draft='' THEN id ELSE draft END,jsonb_build_object('direction','local','transfer_id',id,'name',name,'error',left(error,300)) FROM ot.upload_stages WHERE org_id=$1 AND id=$2 AND state='failed' ON CONFLICT(message_key) WHERE NOT resolved DO NOTHING", &[&org,&id,&uid("transfer-failure")]).await?;
    Ok(())
}

/// No partial can become a published upload after the terminal transition.
/// File removal is retried by sweep until successful (including after restart).
#[logged]
pub async fn inspect(e: &Engine, org: i64, id: &str) -> Result<Option<Value>> {
    let mut c=e.db.get().await?;
    let tx=c.transaction().await?;
    let Some(_) = tx.query_opt("SELECT id FROM ot.upload_stages WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org,&id]).await? else { return Ok(None); };
    let active=e.net.transfer_stops.pin().contains_key(id);
    if !active {
        tx.execute("UPDATE ot.upload_stages SET state='failed',error=CASE WHEN state='queued' THEN 'Local upload expired after 24 hours idle; select the file again to restart from zero' ELSE 'Local upload interrupted; select the file again to restart from zero' END,updated_at=now() WHERE org_id=$1 AND id=$2 AND (state='uploading' OR (state='queued' AND updated_at<now()-interval '24 hours'))", &[&org,&id]).await?;
    }
    failure(&tx,org,id).await?;
    let r=tx.query_one("SELECT name,total,received,state,error,path,cleaned_at IS NULL FROM ot.upload_stages WHERE org_id=$1 AND id=$2", &[&org,&id]).await?;
    let state:String=r.get(3);
    let cleanup=!active && r.get::<_,bool>(6) && matches!(state.as_str(),"failed"|"cancelled");
    let value=json!({"id":id,"name":r.get::<_,String>(0),"bytes":r.get::<_,i64>(1),"received":r.get::<_,i64>(2),"state":state,"error":r.get::<_,Option<String>>(4)});
    tx.commit().await?;
    drop(c);
    if cleanup {
        match tokio::fs::remove_file(r.get::<_,String>(5)).await {
            Ok(())=>{},
            Err(err) if err.kind()==std::io::ErrorKind::NotFound=>{},
            Err(err)=>{ tracing::warn!(ticket=id,error=%err,"local partial cleanup deferred"); return Ok(Some(value)); },
        }
        e.db.get().await?.execute("UPDATE ot.upload_stages SET cleaned_at=now() WHERE org_id=$1 AND id=$2 AND state IN ('failed','cancelled')", &[&org,&id]).await?;
    }
    Ok(Some(value))
}

/// A keyset cursor prevents active writers or undeletable files from starving
/// later records. Each pass handles at most 32 tickets and no published files.
#[logged]
pub async fn sweep(e: &Engine, after: &mut String) -> Result<()> {
    let rows=e.db.get().await?.query("SELECT org_id,id FROM ot.upload_stages WHERE id>$1 AND (state IN ('queued','uploading') OR (state IN ('failed','cancelled') AND cleaned_at IS NULL)) ORDER BY id LIMIT 32", &[&after.as_str()]).await?;
    if rows.is_empty() { after.clear(); return Ok(()); }
    for row in rows {
        let org:i64=row.get(0); let id:String=row.get(1);
        if let Err(err)=inspect(e,org,&id).await { tracing::warn!(ticket=%id,error=%err,"local upload recovery deferred"); }
        *after=id;
    }
    Ok(())
}
