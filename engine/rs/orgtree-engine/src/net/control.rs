//! Bounded transfer inspection and explicit control. No credentials or paths
//! are exposed; agents see only their sends or their current outside inbox.
use super::*;

#[logged]
async fn audience(e: &Engine, org: i64, actor: Option<i64>) -> Result<bool> {
    let Some(actor) = actor else { return Ok(true); };
    let c = e.db.get().await?;
    let Some(r) = c.query_opt("SELECT a.name,o.settings FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id WHERE a.id=$1 AND a.org_id=$2 AND a.state='live'", &[&actor,&org]).await? else {
        crate::refuse!(Forbidden,"agent is not live in this organization");
    };
    let settings = crate::feed::groups::effective_settings(&r.get::<_,Value>(1), &e.settings.defaults());
    let holders = crate::domain::orginbox::live_holders(&**c, org, settings["org_inbox_multi_holder"].as_bool().unwrap_or(false)).await?;
    Ok(holders.contains(&r.get::<_,String>(0)))
}

/// At most 100 jobs per page. A specific id is checked by the same authority
/// predicate, so guessing an id never reveals another sender's transfer.
#[logged]
pub async fn inspect(e: &Engine, org: i64, actor: Option<i64>, id: Option<&str>) -> Result<Value> {
    let incoming = audience(e,org,actor).await?;
    let rows = e.db.get().await?.query(
        "SELECT value FROM (
          SELECT t.created_at,t.id,jsonb_build_object('id',t.id,'direction','upload','message_id',i.uid,
            'peer',i.peer,'state',t.state,'name',t.source->>'name','total',t.total,'processed',t.processed,
            'confirmed',t.confirmed,'attempt',t.attempt,'error',t.error,'updated_at',t.updated_at) AS value
          FROM ot.net_transfers t JOIN ot.org_inbox i ON i.id=t.inbox_id
          WHERE t.org_id=$1 AND ($3::text IS NULL OR t.id=$3)
            AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM ot.agents a WHERE a.id=$2 AND a.org_id=$1
                AND a.state='live' AND i.by_name=a.name AND i.at>=a.created_at))
          UNION ALL
          SELECT n.created_at,n.id,jsonb_build_object('id',n.id,'direction','download','message_id',n.net_id,
            'peer',n.envelope->>'from','state',n.state,'attempt',n.attempt,'error',n.error,'updated_at',n.updated_at,
            'files',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'total',d.total,
              'processed',d.processed,'confirmed',d.confirmed,'complete',d.complete,'restart_reason',d.restart_reason)
              ORDER BY d.file_no) FROM ot.net_downloads d WHERE d.incoming_id=n.id),'[]'::jsonb)) AS value
          FROM ot.net_incoming n WHERE n.org_id=$1 AND $4 AND ($3::text IS NULL OR n.id=$3)
        ) jobs ORDER BY created_at DESC,id DESC LIMIT 100", &[&org,&actor,&id,&incoming]).await?;
    let values: Vec<Value> = rows.iter().map(|r| r.get(0)).collect();
    if id.is_some() && values.is_empty() { crate::refuse!(NotFound,"transfer not found in your accessible mail"); }
    Ok(json!({"transfers":values}))
}

#[logged]
pub(super) async fn running(e: &Engine, id: &str) -> Result<bool> {
    Ok(e.db.get().await?.query_one("SELECT EXISTS(SELECT 1 FROM ot.net_transfers WHERE id=$1 AND state IN ('preparing','uploading','confirming') UNION ALL SELECT 1 FROM ot.net_incoming WHERE id=$1 AND state='downloading')", &[&id]).await?.get(0))
}

#[logged]
pub async fn change(e: &Engine, org: i64, actor: Option<i64>, id: &str, action: &str) -> Result<Value> {
    if !matches!(action,"retry"|"cancel"|"remove") { crate::refuse!(BadRequest,"action must be retry, cancel or remove"); }
    let visible = inspect(e,org,actor,Some(id)).await?;
    let upload = visible["transfers"][0]["direction"] == "upload";
    // Retrying waits until the previous request has actually dropped its file
    // handles. A cancelled request cannot race the next writer on Windows.
    if action != "cancel" && e.net.transfer_stops.pin().contains_key(id) {
        crate::refuse!(BadRequest,"transfer is still stopping; retry in a moment");
    }
    if action == "remove" {
        if !upload { crate::refuse!(BadRequest,"only a failed or cancelled outgoing file can be removed; incoming messages keep every file"); }
        let mut c = e.db.get().await?;
        let tx = c.transaction().await?;
        let Some(row) = tx.query_opt("UPDATE ot.net_transfers t SET state='removed',error=NULL,updated_at=now() FROM ot.org_inbox i WHERE t.id=$1 AND t.org_id=$2 AND t.state IN ('failed','cancelled') AND i.id=t.inbox_id AND i.state='queued' RETURNING t.inbox_id,t.file_no", &[&id,&org]).await? else {
            crate::refuse!(BadRequest,"only a failed or cancelled outgoing file can be removed");
        };
        // Keep the manifest indices stable for all remaining jobs. The marked
        // entry is retained privately for auditing, excluded from presentation.
        let path = vec![row.get::<_,i32>(1).to_string(), "transfer_removed".into()];
        tx.execute("UPDATE ot.org_inbox SET attachments=jsonb_set(attachments,$2,'true'::jsonb),last_err=NULL WHERE id=$1", &[&row.get::<_,i64>(0),&path]).await?;
        tx.commit().await?;
        changes::notify_id(e,org,vec![Change::OrgInbox]);
        kick(e);
        return inspect(e,org,actor,Some(id)).await;
    }
    let sql = match (upload,action) {
        (true,"cancel") => "UPDATE ot.net_transfers SET state='cancelled',error='cancelled intentionally; retry or remove this file to send',updated_at=now() WHERE id=$1 AND org_id=$2 AND state IN ('queued','retry_wait','preparing','uploading','confirming','failed','paused')",
        (false,"cancel") => "UPDATE ot.net_incoming SET state='cancelled',error='cancelled intentionally; retry to receive this message',updated_at=now() WHERE id=$1 AND org_id=$2 AND state IN ('queued','retry_wait','downloading','failed')",
        (true,_) => "UPDATE ot.net_transfers SET state='queued',error=NULL,next_at=now(),updated_at=now() WHERE id=$1 AND org_id=$2 AND state IN ('failed','cancelled','retry_wait','paused')",
        (false,_) => "UPDATE ot.net_incoming SET state='queued',error=NULL,next_at=now(),updated_at=now() WHERE id=$1 AND org_id=$2 AND state IN ('failed','cancelled','retry_wait')",
    };
    let n = e.db.get().await?.execute(sql,&[&id,&org]).await?;
    if n == 0 { crate::refuse!(BadRequest,"transfer is already complete, delivering, or not available for this action"); }
    if action == "cancel" {
        if let Some(stop) = e.net.transfer_stops.pin().get(id) { stop.cancel(); }
    }
    changes::notify_id(e,org,vec![Change::OrgInbox]);
    kick(e);
    inspect(e,org,actor,Some(id)).await
}
