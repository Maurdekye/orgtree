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

/// Self control remains available with every group disabled. Controlling a
/// different agent also needs the caller's current descendant authority.
#[logged]
pub fn runtime_rule(is_self: bool, runtime_group: bool) -> Result<()> {
    if !is_self && !runtime_group {
        crate::refuse!(Forbidden,"controlling another agent's Do Not Disturb needs the runtime tool group");
    }
    Ok(())
}

#[logged]
pub async fn set(engine: &Arc<Engine>, org: i64, agent: i64, on: bool, allow_arm: bool) -> Result<Value> {
    let mut client=engine.db.get().await?;
    let tx=client.transaction().await?;
    // Same row lock as start_turn: setting/clearing cannot race the atomic
    // transfer of an idle flag into the newly admitted turn.
    let target=tx.query_one("SELECT kind,state,dnd_next_turn FROM ot.agents WHERE id=$1 AND org_id=$2 FOR UPDATE",&[&agent,&org]).await?;
    crate::domain::node_kind::require_turn_runtime(target.get(0),"target")?;
    if target.get::<_,&str>(1)!="live" { crate::refuse!(Conflict,"Do Not Disturb needs a live agent"); }
    let was_armed:bool=target.get(2);
    let row=tx.query_opt("UPDATE ot.turns SET do_not_disturb=$2 WHERE id=(SELECT id FROM ot.turns WHERE agent_id=$1 ORDER BY id DESC LIMIT 1) AND ended_at IS NULL RETURNING id",&[&agent,&on]).await?;
    if on && row.is_none() && !allow_arm { crate::refuse!(Conflict,"Do Not Disturb needs your own running turn"); }
    let armed=on && row.is_none();
    tx.execute("UPDATE ot.agents SET dnd_next_turn=$2,row_version=row_version+1 WHERE id=$1",&[&agent,&armed]).await?;
    if !on && was_armed {
        tx.execute("UPDATE ot.mail SET extra=extra || '{\"dnd_released\":true}'::jsonb WHERE recipient_agent_id=$1 AND state='pending' AND NOT urgent",&[&agent]).await?;
    }
    tx.commit().await?;
    // OFF may release pending mail into this turn; it never adds a special
    // interrupt or wake path. The actor applies its normal delivery rules.
    if !on { crate::runtime::actor(engine,org,agent).send(crate::runtime::AgentMsg::Wake); }
    notify(engine,&client,org,agent).await?;
    Ok(json!({"dnd":on && row.is_some(),"dnd_next_turn":armed,"turn":row.map(|r|r.get::<_,i64>(0))}))
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
    #[test] fn dnd_self_remains_unrestricted_and_descendants_need_runtime() {
        assert!(runtime_rule(true,false).is_ok());
        assert!(runtime_rule(true,true).is_ok());
        assert!(runtime_rule(false,true).is_ok());
        assert!(runtime_rule(false,false).is_err());
    }
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
        // All mail now shares ordered byte-budget admission (af86189), not
        // a special uncapped DND release followed by a capped ordinary batch.
        for name in ["start_turn","steer_codex","steer_agy","on_hook"] {
            let body=source.split(&format!("async fn {name}(")).nth(1).unwrap();
            let claim=body.split("RETURNING id, to_jsonb(ot.mail.*)").next().unwrap();
            let pending=claim.rsplit("SELECT id FROM ot.mail WHERE").next().unwrap();
            assert!(pending.contains("ORDER BY id FOR UPDATE SKIP LOCKED"),"{name} must admit pending mail in order");
            assert!(!pending.contains("LIMIT"),"{name} must leave admission to the input-byte budget");
        }
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
