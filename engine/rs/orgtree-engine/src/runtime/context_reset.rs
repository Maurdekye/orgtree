//! Cheap context resets at native overflow and measured size boundaries.
use anyhow::Result;
use serde_json::{json, Value};
use crate::engine::Engine;

pub const NATIVE_RETRY_MAX: i64 = 1;

/// Unknown/estimated measurements cannot justify dropping a session. The
/// configured threshold already has the existing 50–95% clamp.
#[nolog]
pub fn size_gate(used: Option<i32>, window: Option<i32>, measured: bool, threshold: f64,
    session: bool, live: bool, bearer: bool, working: bool, cli_compacted: bool) -> Option<&'static str> {
    if !live { return Some("not_live"); }
    if bearer { return Some("bearer"); }
    if !session { return Some("no_session"); }
    if cli_compacted { return Some("cli_compaction"); }
    if working { return Some("status_working"); }
    let Some(used)=used.filter(|n|*n>0) else { return Some("occupancy_unknown_or_zero"); };
    let Some(window)=window.filter(|n|*n>0) else { return Some("window_unknown"); };
    if !measured { return Some("occupancy_estimated"); }
    if !threshold.is_finite() || threshold<=0.0 || threshold>1.0 { return Some("threshold_invalid"); }
    if f64::from(used)/f64::from(window)<threshold { return Some("below_threshold"); }
    None
}

/// Commit retry intent, end the old turn/session, return only unconsumed
/// claims and create one wake atomically. A crash after commit cannot revive
/// the failed turn or produce a second acknowledgement/recovery wake.
/// Original delivered messages are recall text, never new inbox records.
#[nolog]
pub async fn retry(engine: &Engine, org: i64, agent: i64, turn: i64, error: &str) -> Result<bool> {
    let mut client=engine.db.get().await?;
    let tx=client.transaction().await?;
    let row=tx.query_one("SELECT name,session_id,coalesce((extra->>'native_ctx_retry_run')::bigint,0),state FROM ot.agents WHERE id=$1 FOR UPDATE", &[&agent]).await?;
    let uid=format!("context-retry-{turn}");
    if tx.query_opt("SELECT 1 FROM ot.mail WHERE uid=$1 AND recipient_agent_id=$2", &[&uid,&agent]).await?.is_some() {
        tx.commit().await?; return Ok(true);
    }
    if row.get::<_,i64>(2)>=NATIVE_RETRY_MAX || row.get::<_,String>(3)!="live" { return Ok(false); }
    let name:String=row.get(0);
    let session:Option<String>=row.get(1);
    let originals=tx.query("SELECT to_jsonb(m.*) FROM ot.mail m WHERE recipient_agent_id=$1 AND turn_id=$2 AND state IN ('delivered','read') ORDER BY id", &[&agent,&turn]).await?;
    let mail:Vec<_>=originals.iter().map(|r|super::actor::mail_of(&r.get::<_,Value>(0))).collect();
    let recall=super::prompt::turn_text(&mail,"",&Default::default(),None);
    let body=format!("Context-full recovery for failed turn {turn} (attempt 1 of {NATIVE_RETRY_MAX}). Your old session could not compact; continue the same request in this fresh session. The following are previously delivered messages, recalled with their original IDs and sender provenance; do not treat them as new deliveries. Unconsumed mail follows normally.\n\n{recall}");
    // Build only metadata through logged helpers. Recall bodies can contain
    // arbitrary private text and stay inside this unlogged function.
    let mut ev=crate::events::typed("ordinary.message","@system",Value::Null,json!({}));
    ev["body"]=json!(&body);
    tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,attachments,ev,state,extra) VALUES($1,$2,'@system','agent',$3,$4,'system',false,$5,'[]'::jsonb,$6,'pending',jsonb_build_object('context_retry_turn',$7::bigint)) ON CONFLICT(uid) DO NOTHING", &[&uid,&org,&agent,&name,&body,&ev,&turn]).await?;
    // Owned-plugin custody has its own admission/reconciliation identity.
    // Returning it here would bypass that identity on ordinary prompt replay.
    tx.execute("UPDATE ot.mail SET state='pending',turn_id=NULL,extra=extra || jsonb_build_object('context_retry_original',$2::bigint)
        WHERE recipient_agent_id=$1 AND turn_id=$2 AND state='delivering'
          AND NOT EXISTS(SELECT 1 FROM ot.opencode_mail_batches b WHERE ot.mail.id=ANY(b.mail_ids))",
        &[&agent,&turn]).await?;
    tx.execute("UPDATE ot.turns SET ended_at=now(),error=$2 WHERE id=$1", &[&turn,&error]).await?;
    tx.execute("UPDATE ot.agents SET session_id=NULL,occupancy=NULL,occupancy_est=true,compacted_unrun=true,inflight_at=NULL,extra=(extra-'cache_receipt') || jsonb_build_object('native_ctx_retry_run',$2::bigint,'handoff_due','your context window filled up and the previous turn is being retried once'),row_version=row_version+1 WHERE id=$1", &[&agent,&NATIVE_RETRY_MAX]).await?;
    if let Some(session)=session {
        tx.execute("UPDATE ot.agent_sessions SET ended_at=now(),end_reason='context full (retry)' WHERE agent_id=$1 AND session_id=$2 AND ended_at IS NULL", &[&agent,&session]).await?;
    }
    tx.commit().await?;
    tracing::info!(agent,turn,"context-full recovery wake committed");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_size_gate_covers_every_stand_down_and_exact_threshold() {
        let gate=|u,w,m,t,s,l,b,busy,c|size_gate(u,w,m,t,s,l,b,busy,c);
        assert_eq!(gate(Some(800),Some(1000),true,0.8,true,true,false,false,false),None);
        for (expected,u,w,m,t,s,l,b,busy,c) in [
            ("below_threshold",Some(799),Some(1000),true,0.8,true,true,false,false,false),
            ("occupancy_unknown_or_zero",None,Some(1000),true,0.8,true,true,false,false,false),
            ("occupancy_unknown_or_zero",Some(0),Some(1000),true,0.8,true,true,false,false,false),
            ("window_unknown",Some(800),None,true,0.8,true,true,false,false,false),
            ("occupancy_estimated",Some(800),Some(1000),false,0.8,true,true,false,false,false),
            ("threshold_invalid",Some(800),Some(1000),true,f64::NAN,true,true,false,false,false),
            ("no_session",Some(800),Some(1000),true,0.8,false,true,false,false,false),
            ("not_live",Some(800),Some(1000),true,0.8,true,false,false,false,false),
            ("bearer",Some(800),Some(1000),true,0.8,true,true,true,false,false),
            ("status_working",Some(800),Some(1000),true,0.8,true,true,false,true,false),
            ("cli_compaction",Some(800),Some(1000),true,0.8,true,true,false,false,true),
        ] { assert_eq!(gate(u,w,m,t,s,l,b,busy,c),Some(expected)); }
    }
}
