//! Cheap context resets at native overflow and measured size boundaries.
use anyhow::Result;
use serde_json::{json, Value};
use crate::engine::Engine;

pub const NATIVE_RETRY_MAX: i64 = 1;

/// Choose the turn-boundary size threshold without changing the context window or org setting.
#[nolog]
pub fn size_threshold(_provider: &str, _window: Option<i32>, org_threshold: f64) -> f64 {
    org_threshold // RED: only the org fraction applies before the AGY cap.
}

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

/// What a finished Claude turn writes to the agent's size columns.
#[derive(Debug, PartialEq)]
pub struct SizeWrite {
    pub occupancy: i32,
    /// stored as a measurement (occupancy_est=false, compacted_unrun=false)
    pub measured: bool,
    /// stored as an estimate that a cold wake must not cut on (occupancy_est=true, compacted_unrun=true)
    pub estimate: bool,
}

/// The size Claude Code reports after a compaction (`compact_boundary`'s `compact_metadata.post_tokens`), or None
/// when it reports none (an older CLI, a missing or non-positive field). Never a guess.
#[nolog]
pub fn post_compaction_size(boundary: &Value) -> Option<i32> {
    boundary.pointer("/compact_metadata/post_tokens").and_then(Value::as_i64)
        .filter(|n| *n > 0).and_then(|n| i32::try_from(n).ok())
}

/// A model call made after a CLI compaction in the same turn is a real measurement of the new size and replaces
/// the boundary's own figure; the last one wins.
#[nolog]
pub fn note_call_after_compaction(post: &mut Option<i32>, cli_compacted: bool, call_size: i32) {
    if cli_compacted && call_size > 0 {
        *post = Some(call_size);
    }
}

/// What the turn's end stores. `last_call` is the last call's input plus cache total. After a CLI compaction that
/// left a real size (`post`), that size is stored as measured, so the usual cold-wake rule decides; with none, the
/// pre-compaction figure stays an estimate and a cold wake never cuts on it. Our own compaction and a native retry
/// are never measurements.
#[nolog]
pub fn size_write(last_call: i32, compact: bool, cli_compacted: bool, post: Option<i32>, native_retry: bool) -> SizeWrite {
    let post = post.filter(|n| *n > 0 && cli_compacted && !compact);
    let occupancy = post.unwrap_or(last_call);
    SizeWrite {
        occupancy,
        measured: occupancy > 0 && !compact && (!cli_compacted || post.is_some()) && !native_retry,
        estimate: compact || (cli_compacted && post.is_none()),
    }
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
    fn agy_size_threshold_caps_large_windows_but_preserves_smaller_org_thresholds() {
        use crate::providers::catalog::{GOOGLE, CLAUDE};
        assert_eq!(size_threshold(GOOGLE, Some(1_048_576), 0.8), 230_000.0 / 1_048_576.0);
        assert_eq!(size_threshold(GOOGLE, Some(200_000), 0.8), 0.8);
        assert_eq!(size_threshold(CLAUDE, Some(1_000_000), 0.8), 0.8);
        for window in [None, Some(0), Some(-1)] {
            assert_eq!(size_threshold(GOOGLE, window, 0.8), 0.8);
        }
    }

    #[test]
    fn agy_size_gate_resets_at_230k_and_preserves_all_stand_downs() {
        use crate::providers::catalog::{GOOGLE, CLAUDE};
        let threshold = size_threshold(GOOGLE, Some(1_048_576), 0.8);
        assert_eq!(size_gate(Some(231_000), Some(1_048_576), true, threshold, true, true, false, false, false), None);
        assert_eq!(size_gate(Some(230_000), Some(1_048_576), true, threshold, true, true, false, false, false), None);
        assert_eq!(size_gate(Some(229_000), Some(1_048_576), true, threshold, true, true, false, false, false), Some("below_threshold"));
        assert_eq!(size_gate(Some(231_000), Some(1_048_576), true,
            size_threshold(CLAUDE, Some(1_048_576), 0.8), true, true, false, false, false), Some("below_threshold"));
        for (measured, session, live, bearer, working, compacted, reason) in [
            (false, true, true, false, false, false, "occupancy_estimated"),
            (true, false, true, false, false, false, "no_session"),
            (true, true, false, false, false, false, "not_live"),
            (true, true, true, true, false, false, "bearer"),
            (true, true, true, false, true, false, "status_working"),
            (true, true, true, false, false, true, "cli_compaction"),
        ] {
            assert_eq!(size_gate(Some(231_000), Some(1_048_576), measured, threshold,
                session, live, bearer, working, compacted), Some(reason));
        }
        assert_eq!(size_gate(Some(231_000), None, true, size_threshold(GOOGLE, None, 0.8), true, true, false, false, false), Some("window_unknown"));
    }
    /// What a cold wake decides from what the turn left (threshold 25% of a 1M window).
    fn cold_wake(w: &SizeWrite) -> &'static str {
        crate::domain::tree::cold_turn_action(Some(0.25), Some(i64::from(w.occupancy)), Some(1_000_000), w.measured && !w.estimate, true, true)
    }
    fn boundary(post: Option<i64>) -> Value {
        let mut b = json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto", "pre_tokens": 658_699}});
        if let Some(p) = post { b["compact_metadata"]["post_tokens"] = json!(p); }
        b
    }

    /// (a) a reported post size above the threshold is measured, so the cold wake cheap-compacts.
    #[test]
    fn a_post_compaction_size_above_the_threshold_compacts_at_the_cold_wake() {
        let post = post_compaction_size(&boundary(Some(300_000)));
        assert_eq!(post, Some(300_000));
        let w = size_write(658_699, false, true, post, false);
        assert_eq!(w, SizeWrite { occupancy: 300_000, measured: true, estimate: false });
        assert_eq!(cold_wake(&w), "will_compact");
    }
    /// (b) a reported post size below the threshold is measured and does not compact.
    #[test]
    fn a_post_compaction_size_below_the_threshold_does_not_compact() {
        let w = size_write(658_699, false, true, post_compaction_size(&boundary(Some(100_000))), false);
        assert_eq!(w, SizeWrite { occupancy: 100_000, measured: true, estimate: false });
        assert_eq!(cold_wake(&w), "not_applicable");
    }
    /// (c) no post size (older CLI, missing, zero, wrong type) keeps today's estimate and the skip. Never a guess.
    #[test]
    fn a_boundary_without_a_post_size_keeps_the_estimate_and_the_skip() {
        for b in [boundary(None), boundary(Some(0)), boundary(Some(-5)), json!({"subtype": "compact_boundary", "compact_metadata": {"post_tokens": "x"}})] {
            let post = post_compaction_size(&b);
            assert_eq!(post, None);
            let w = size_write(658_699, false, true, post, false);
            assert_eq!(w, SizeWrite { occupancy: 658_699, measured: false, estimate: true });
            assert_eq!(cold_wake(&w), "not_applicable");
        }
    }
    /// (d) a measured call after the boundary overrides post_tokens; the last one wins; nothing changes without a boundary.
    #[test]
    fn a_call_after_the_boundary_overrides_the_reported_post_size() {
        let mut post = post_compaction_size(&boundary(Some(300_000)));
        note_call_after_compaction(&mut post, true, 90_000);
        assert_eq!(cold_wake(&size_write(90_000, false, true, post, false)), "not_applicable");
        note_call_after_compaction(&mut post, true, 420_000);
        let w = size_write(420_000, false, true, post, false);
        assert_eq!(w, SizeWrite { occupancy: 420_000, measured: true, estimate: false });
        assert_eq!(cold_wake(&w), "will_compact");
        // a boundary with no post size, then a later call: that call is the real figure
        let mut none = None;
        note_call_after_compaction(&mut none, true, 350_000);
        assert_eq!(cold_wake(&size_write(350_000, false, true, none, false)), "will_compact");
        // calls before any compaction do not set it
        let mut before = None;
        note_call_after_compaction(&mut before, false, 350_000);
        assert_eq!(before, None);
    }
    /// Our own compaction and a native retry are never measurements, post size or not.
    #[test]
    fn our_own_compaction_and_a_native_retry_stay_unmeasured() {
        assert!(!size_write(500_000, true, false, Some(300_000), false).measured);
        assert!(!size_write(500_000, false, true, Some(300_000), true).measured);
        assert_eq!(size_write(500_000, false, false, None, false), SizeWrite { occupancy: 500_000, measured: true, estimate: false });
    }

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
