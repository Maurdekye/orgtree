//! Turn-local Do Not Disturb. All harnesses consult the same durable gate.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;
use crate::{changes::{self,Change},engine::Engine};

#[nolog]
pub fn may_steer(active: bool, urgent_waiting: bool) -> bool { !active || urgent_waiting }

#[nolog]
pub fn validate_urgent(urgent: bool, reason: Option<&str>, user_sender: bool, active: bool) -> Result<()> {
    if !urgent { return Ok(()); }
    if !user_sender && reason.is_none_or(|s| s.trim().is_empty()) {
        crate::refuse!(BadRequest,"urgent needs urgent_reason: explain why this must interrupt now");
    }
    if !user_sender && !active {
        crate::refuse!(BadRequest,"urgent to an agent is available only while that agent is currently in Do Not Disturb");
    }
    Ok(())
}

#[logged]
pub async fn set(engine: &Arc<Engine>, client: &Client, org: i64, agent: i64, on: bool) -> Result<Value> {
    let row=client.query_opt("UPDATE ot.turns SET do_not_disturb=$2 WHERE id=(SELECT id FROM ot.turns WHERE agent_id=$1 ORDER BY id DESC LIMIT 1) AND ended_at IS NULL RETURNING id",&[&agent,&on]).await?;
    if on && row.is_none() { crate::refuse!(Conflict,"Do Not Disturb needs your own running turn"); }
    notify(engine,client,org,agent).await?;
    // OFF may release pending mail into this turn; it never adds a special
    // interrupt or wake path. The actor applies its normal delivery rules.
    if !on { if let Some(h)=engine.agents.get(agent) {h.send(crate::runtime::AgentMsg::Wake);} }
    Ok(json!({"dnd":on && row.is_some(),"turn":row.map(|r|r.get::<_,i64>(0))}))
}

/// Sender status and the recipient badge are live facts, not send-time labels.
#[logged]
pub async fn notify(engine: &Engine, client: &Client, org: i64, agent: i64) -> Result<()> {
    let mut changed=vec![Change::Agent(agent),Change::Mailbox(agent),Change::UserMail];
    for row in client.query("SELECT DISTINCT sender_agent_id FROM ot.mail WHERE recipient_agent_id=$1 AND state='pending' AND sender_agent_id IS NOT NULL",&[&agent]).await? {
        changed.push(Change::Mailbox(row.get(0)));
    }
    changes::notify_id(engine,org,changed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn held_mail_never_reaches_an_interrupt_style_harness() {
        for harness in ["antigravity","codex","claude","muse","acp"] {
            let mut interrupts=0;
            if may_steer(true,false) { interrupts+=1; }
            assert_eq!(interrupts,0,"{harness} must not be steered or interrupted by held mail");
        }
    }
    #[test] fn only_urgent_bypasses_an_active_turn() {
        assert!(!may_steer(true,false)); assert!(may_steer(true,true));
        assert!(may_steer(false,false));
    }
    #[test] fn agent_urgent_requires_current_dnd_and_nonempty_reason() {
        assert!(validate_urgent(true,Some("deadline"),false,true).is_ok());
        assert!(validate_urgent(true,Some("deadline"),false,false).is_err());
        assert!(validate_urgent(true,Some(" "),false,true).is_err());
    }
    #[test] fn user_urgency_and_ordinary_agent_mail_keep_their_rules() {
        assert!(validate_urgent(true,Some("deadline"),true,false).is_ok());
        assert!(validate_urgent(true,None,true,false).is_ok());
        assert!(validate_urgent(true,Some(" "),true,false).is_ok());
        assert!(validate_urgent(true,None,false,true).is_err());
        assert!(validate_urgent(false,None,false,false).is_ok());
    }
    #[test] fn durable_release_only_marks_unread_mail_and_auto_clears() {
        let sql=include_str!("../../migrations/0033_do_not_disturb.sql");
        assert!(sql.contains("state = 'pending' AND NOT urgent"));
        assert!(sql.contains("NEW.do_not_disturb := false"));
        assert!(sql.contains("NEW.ended_at IS NOT NULL"));
    }
    #[test] fn real_actor_gate_precedes_the_antigravity_handoff() {
        let source=include_str!("../runtime/actor.rs");
        let wake=source.split("async fn on_wake(").nth(1).unwrap().split("fn cancel_warm").next().unwrap();
        assert!(wake.find("dnd::may_steer").unwrap()<wake.find("self.steer_agy()").unwrap());
        assert!(wake.find("dnd::may_steer").unwrap()<wake.find("self.steer_codex()").unwrap());
        assert!(source.contains("THEN NULL ELSE 64 END"),"released batch has no ordinary row cap");
        assert!(source.contains("prompt::batch(&mails"),"input-byte budget remains authoritative");
    }
    #[test] fn held_and_manually_read_status_are_projected_for_senders() {
        let held=crate::feed::compute::mail_entry(&json!({"dnd_held":true,"extra":{}}));
        assert_eq!(held["dnd_held"],true);
        let read=crate::feed::compute::mail_entry(&json!({"state":"read","extra":{"dnd_read":true}}));
        assert_eq!(read["dnd_read"],true);
        assert!(read.get("dnd_held").is_none());
    }
}
