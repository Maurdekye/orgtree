//! Failure-only mail. Intent commits with the failing job; all recipient mail
//! and its delivery marker commit together, so retries cannot lose or double it.
use super::*;
use tokio_postgres::Transaction;

#[logged]
pub(super) async fn record(tx: &Transaction<'_>, org: i64, id: &str, upload: bool, error: &str) -> Result<()> {
    let row = if upload {
        tx.query_one("SELECT 'out:'||i.id::text,jsonb_build_object('message_id',i.uid,'peer',i.peer,'by',i.by_name,'at',i.at,'direction','upload','transfer_id',t.id) FROM ot.net_transfers t JOIN ot.org_inbox i ON i.id=t.inbox_id WHERE t.id=$1 AND t.org_id=$2", &[&id,&org]).await?
    } else {
        tx.query_one("SELECT id,jsonb_build_object('message_id',net_id,'peer',envelope->>'from','direction','download','transfer_id',id) FROM ot.net_incoming WHERE id=$1 AND org_id=$2", &[&id,&org]).await?
    };
    let key: String = row.get(0);
    let mut detail: Value = row.get(1);
    detail["error"] = json!(crate::util::gist(error,300));
    tx.execute("INSERT INTO ot.net_transfer_failures(id,org_id,message_key,detail) VALUES($1,$2,$3,$4) ON CONFLICT(message_key) WHERE NOT resolved DO NOTHING", &[&crate::util::uid("transfer-failure"),&org,&key,&detail]).await?;
    Ok(())
}

/// Opening another failure episode requires resolving every held file in the
/// message. This prevents separate retries of its files from spamming notices.
#[logged]
pub(super) async fn resolve(tx: &Transaction<'_>, id: &str, upload: bool) -> Result<()> {
    if upload {
        tx.execute("UPDATE ot.net_transfer_failures f SET resolved=true FROM ot.net_transfers t WHERE t.id=$1 AND f.message_key='out:'||t.inbox_id::text AND NOT f.resolved AND NOT EXISTS(SELECT 1 FROM ot.net_transfers other WHERE other.inbox_id=t.inbox_id AND other.state IN ('failed','cancelled','paused'))", &[&id]).await?;
    } else {
        tx.execute("UPDATE ot.net_transfer_failures SET resolved=true WHERE message_key=$1 AND NOT resolved", &[&id]).await?;
    }
    Ok(())
}

#[logged]
async fn recipients(e: &Engine, tx: &Transaction<'_>, org: i64, detail: &Value) -> Result<Vec<i64>> {
    if detail["direction"] == "upload" {
        // Match the sender's generation lifetime; never send private failure
        // context to a later hire which happens to reuse the same name.
        let rows = tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live' AND created_at <= $3::text::timestamptz", &[&org,&detail["by"].as_str().unwrap_or(""),&detail["at"].as_str().unwrap_or("")]).await?;
        if !rows.is_empty() { return Ok(rows.iter().map(|r|r.get(0)).collect()); }
        if detail["by"] == "user" { return Ok(vec![]); }
    }
    let raw: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&org]).await?.get(0);
    let settings = crate::feed::groups::effective_settings(&raw,&e.settings.defaults());
    let names = crate::domain::orginbox::live_holders(tx,org,settings["org_inbox_multi_holder"].as_bool().unwrap_or(false)).await?;
    let rows = tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state='live' AND name=ANY($2) ORDER BY id LIMIT 10000", &[&org,&names]).await?;
    Ok(rows.iter().map(|r|r.get(0)).collect())
}

/// Small bounded batches, no network/file I/O in the transaction. The normal
/// mailbox startup recovery also wakes committed mail if the process stops
/// immediately after commit and before the wake below.
#[logged]
pub(super) async fn dispatch(e: &Arc<Engine>) -> Result<()> {
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    let rows = tx.query("SELECT id,org_id,detail FROM ot.net_transfer_failures WHERE notified_at IS NULL ORDER BY created_at,id LIMIT 16 FOR UPDATE SKIP LOCKED", &[]).await?;
    let mut notices = Vec::new();
    for r in rows {
        let id: String = r.get(0);
        let org: i64 = r.get(1);
        let detail: Value = r.get(2);
        let body = format!("Attachment {} for message {} ({}) failed: {}. Messages wait for every file. Inspect the current status of transfer {} and retry after correcting the cause{}.",
            detail["direction"].as_str().unwrap_or("transfer"),detail["message_id"].as_str().unwrap_or(""),
            detail["peer"].as_str().unwrap_or(""),detail["error"].as_str().unwrap_or("unknown failure"),
            detail["transfer_id"].as_str().unwrap_or(""),if detail["direction"]=="upload" {", or explicitly remove the failed file"} else {""});
        let extra = json!({"transfer_failure":id,"transfer_id":detail["transfer_id"],"message_id":detail["message_id"]});
        tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,notice,body,extra,state) VALUES($1,$2,'@system','user','@user','status',true,$3,$4,'pending')", &[&crate::util::uid("m"),&org,&body,&extra]).await?;
        let agents = recipients(e,&tx,org,&detail).await?;
        for agent in &agents {
            tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,extra,state) SELECT $1,$2,'@system','agent',id,name,'status',false,$4,$5,'pending' FROM ot.agents WHERE id=$3 AND org_id=$2", &[&crate::util::uid("m"),&org,agent,&body,&extra]).await?;
        }
        tx.execute("UPDATE ot.net_transfer_failures SET notified_at=now() WHERE id=$1", &[&id]).await?;
        notices.push((org,agents));
    }
    tx.commit().await?;
    drop(c);
    for (org,agents) in notices {
        let mut changes = vec![Change::UserMail];
        for id in agents { changes.push(Change::Mailbox(id)); crate::runtime::wake(e,org,id); }
        changes::notify_id(e,org,changes);
    }
    Ok(())
}
