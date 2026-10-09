//! Retained runtime cards. These messages report a settled outcome; they do
//! not change retry, freeze or process ownership decisions.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json, Value};
use crate::engine::Engine;
use super::mail::{self, From, Outgoing};

/// `tell` false: a failure in a run already reported; its event still fires.
#[logged]
pub async fn end_turn(engine: &Arc<Engine>, org_id: i64, agent_id: i64, error: Option<&str>, freeze: Option<&Value>, tell: bool) -> Result<()> {
    if error.is_none() && freeze.is_none() { return Ok(()) }
    if freeze.is_none() {crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("turn.stalled",crate::runtime::watchdogs::events::Scope::Agent(org_id,agent_id),json!({"agent_id":agent_id})));}
    if !tell { return Ok(()) }
    let c=engine.db.get().await?;
    let r=c.query_one("SELECT a.name,a.generation,p.name,a.account,a.session_id,o.slug FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id LEFT JOIN ot.agents p ON p.id=a.parent_id AND p.state='live' WHERE a.id=$1 AND a.org_id=$2", &[&agent_id,&org_id]).await?;
    drop(c);
    let name:String=r.get(0);
    let parent:Option<String>=r.get(2);
    let org:String=r.get(5);
    let audience=if parent.is_some(){"superior"}else{"user"};
    let target=parent.as_deref().unwrap_or("user");
    let object=crate::events::node_ref(&org,&name,r.get::<_,i32>(1) as i64);
    let (variant,fields,body)=if let Some(f)=freeze {
        let lane=r.get::<_,Option<String>>(3).unwrap_or_else(||"primary".into());
        ("runtime.report_limited",json!({"report":name,"report_name":name,"audience":audience,"lane":lane,"reset_at":f["until"],"err":f["error"]}),format!("{name} reached its usage limit and is held until {}.",f["until"].as_str().unwrap_or("its reset")))
    } else {
        let err=error.unwrap_or("");
        ("runtime.report_stalled",json!({"report":name,"report_name":name,"audience":audience,"cause":"terminal","attempts":null,"classified":null,"door":null,"err":err}),format!("{name}'s turn ended with an error: {err}"))
    };
    let mut out=Outgoing::new(From::System,target,&body);
    out.kind="status".into();
    out.ev=Some(crate::events::typed(variant,"@system",object,fields));
    mail::send(engine,org_id,out).await?;
    Ok(())
}

/// A turn that failed before its provider ran (3.x `_turn_abandoned` from the
/// terminal belt). Nothing retries it: a launch that cannot start would fail
/// the same way again. So the agent gets its own copy, which waits for its
/// next turn without waking it, and its superior (the user at the top level)
/// is told and can act. `tell` false: a failure in a run already reported;
/// its event still fires.
#[logged]
pub async fn launch_failed(engine: &Arc<Engine>, org_id: i64, agent_id: i64, door: &str, err: &str, tell: bool) -> Result<()> {
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("turn.stalled",crate::runtime::watchdogs::events::Scope::Agent(org_id,agent_id),json!({"agent_id":agent_id})));
    if !tell { return Ok(()) }
    let c=engine.db.get().await?;
    let r=c.query_one("SELECT a.name,a.generation,p.name,o.slug,a.session_id FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id LEFT JOIN ot.agents p ON p.id=a.parent_id AND p.state='live' WHERE a.id=$1 AND a.org_id=$2", &[&agent_id,&org_id]).await?;
    drop(c);
    let name:String=r.get(0);
    let parent:Option<String>=r.get(2);
    let org:String=r.get(3);
    let session=json!({"kind":"session","org":org,"node":name,"session_id":r.get::<_,Option<String>>(4).unwrap_or_default()});
    // never a wake: the mail the failed turn held is back in the mailbox, so a
    // wake would retry the launch at once (3.x: the failing agent is never driven)
    let mut own=Outgoing::new(From::System,&name,&format!("Your turn could not start: {err}"));
    own.kind="system".into();
    own.notice=true;
    own.wake=false;
    own.ev=Some(crate::events::typed("runtime.turn_failed_terminal","@system",session,json!({"door":door,"err":err})));
    mail::send(engine,org_id,own).await?;
    let audience=if parent.is_some(){"superior"}else{"user"};
    let mut out=Outgoing::new(From::System,parent.as_deref().unwrap_or("user"),&format!("{name}'s turn could not start: {err}"));
    out.kind="status".into();
    out.ev=Some(crate::events::typed("runtime.report_stalled","@system",crate::events::node_ref(&org,&name,r.get::<_,i32>(1) as i64),
        json!({"report":name,"report_name":name,"audience":audience,"cause":"terminal","attempts":null,"classified":null,"door":door,"err":err})));
    mail::send(engine,org_id,out).await?;
    Ok(())
}

#[logged]
pub fn build_ref(engine: &Engine) -> Value {
    let commit=option_env!("ORGTREE_BUILD_COMMIT").unwrap_or("rust-engine");
    json!({"kind":"build","commit":commit,"short":commit.chars().take(7).collect::<String>(),
        "dirty":false,"pid":engine.boot.pid,"provenance":"unknown"})
}

#[logged]
pub async fn restarted(engine: &Arc<Engine>, org_id:i64, agent_id:i64, interrupted:bool) -> Result<()> {
    let text="The engine restarted while you were working. Continue where you left off.";
    let (variant,fields,body)=if interrupted {
        ("context.drive_restart_interrupted",json!({"text":text,"summary":"The engine stopped during the preceding turn."}),text.to_string())
    } else {
        ("runtime.restart_notice",json!({"prev_pid":null,"started_at":crate::util::iso(engine.boot.started_at),"branch":option_env!("ORGTREE_BUILD_BRANCH"),"version":env!("CARGO_PKG_VERSION")}),format!("[ORGTREE RESTART NOTICE]\nOrgtree {} restarted. Commit: {}. PID: {}. Started at: {}.\nThis is an informational notice; it does not start a turn.",env!("CARGO_PKG_VERSION"),option_env!("ORGTREE_BUILD_COMMIT").unwrap_or("unknown"),engine.boot.pid,crate::util::iso(engine.boot.started_at)))
    };
    let ev=crate::events::typed(variant,"@system",build_ref(engine),fields);
    mail::system_event(engine,org_id,agent_id,&body,!interrupted,Some(ev)).await
}

/// A freeze was released. By hand: the agent's `unstick` notice. By its timer:
/// no notice, the wake mail says it (`limit_reset` is the org-wide
/// weekly-Fable halt's notice, as in 3.x).
#[logged]
pub async fn released(engine:&Arc<Engine>,org_id:i64,agent_id:i64,automatic:bool)->Result<()> {
    let mut ids=Vec::new();
    if !automatic {
        let mut c=engine.db.get().await?;
        let tx=c.transaction().await?;
        ids=super::lifecycle::record(&tx,org_id,"unstick","@system",Some(agent_id),&json!({})).await?;
        tx.commit().await?;
    }
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event("agent.unfrozen",crate::runtime::watchdogs::events::Scope::Agent(org_id,agent_id),json!({"agent_id":agent_id})));
    crate::changes::notify_id(engine,org_id,ids.into_iter().map(crate::changes::Change::Mailbox).collect());
    Ok(())
}

/// Outside mail nobody can read now: no live holder, or (`waiting_for`) only holders and top-level agents that are halted or frozen.
#[logged]
pub async fn external_unroutable(engine:&Arc<Engine>,org_id:i64,org:&str,peer:&str,body:&str,waiting_for:&[String])->Result<()> {
    let text=if waiting_for.is_empty() {
        format!("Mail from {peer} is in {org}'s org inbox, but no live agent holds it.")
    } else {
        format!("Mail from {peer} is in {org}'s org inbox, but no agent who could take it can run now (halted or frozen); it waits for {}.",waiting_for.join(", "))
    };
    let mut out=Outgoing::new(From::System,"user",&text);
    out.ev=Some(crate::events::typed("runtime.external_unroutable","@system",json!({"kind":"org","org":org}),json!({"peer":peer,"excerpt":crate::util::gist(body,300)})));
    mail::send(engine,org_id,out).await?;
    Ok(())
}

#[logged]
pub async fn compacted(engine:&Arc<Engine>,org_id:i64,agent_id:i64,automatic:bool)->Result<()> {
    let mut c=engine.db.get().await?;
    let tx=c.transaction().await?;
    let session:Option<String>=tx.query_one("SELECT session_id FROM ot.agents WHERE id=$1", &[&agent_id]).await?.get(0);
    let ids=super::lifecycle::record(&tx,org_id,"compacted","@system",Some(agent_id),&json!({"session":session.unwrap_or_default(),"auto":automatic})).await?;
    tx.commit().await?;
    drop(c);
    crate::changes::notify_id(engine,org_id,ids.into_iter().map(crate::changes::Change::Mailbox).collect());
    Ok(())
}

/// The user's direct contact is visible to the recipient's superior chain.
#[logged]
pub async fn deep_reach(engine:&Arc<Engine>,org_id:i64,agent_id:i64,text:&str,command:bool)->Result<()> {
    let c=engine.db.get().await?;
    let r=c.query_one("SELECT a.name,a.generation,o.slug FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id WHERE a.id=$1 AND a.org_id=$2", &[&agent_id,&org_id]).await?;
    let name:String=r.get(0);
    let org:String=r.get(2);
    let rows=c.query("WITH RECURSIVE up(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM ot.agents WHERE id=$1 UNION ALL SELECT a.id,a.parent_id,u.depth+1 FROM ot.agents a JOIN up u ON a.id=u.parent_id WHERE u.depth<1024) SELECT a.id,a.name FROM up JOIN ot.agents a ON a.id=up.id WHERE depth>0 AND a.state='live'", &[&agent_id]).await?;
    let mut changed=Vec::new();
    for row in rows {
        let id:i64=row.get(0);
        let target:String=row.get(1);
        let ev=crate::events::typed("context.deep_reach","@user",crate::events::node_ref(&org,&name,r.get::<_,i32>(1) as i64),
            json!({"node":name,"gist":crate::util::gist(text,300),"kind":if command{"command"}else{"message"}}));
        c.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,ev,state) VALUES($1,$2,'@system','agent',$3,$4,'notice',true,$5,$6,'pending')", &[&crate::util::uid("m"),&org_id,&id,&target,&format!("The user contacted {name} directly."),&crate::util::pg_json(&ev).as_ref()]).await?;
        changed.push(crate::changes::Change::Mailbox(id));
    }
    drop(c);
    crate::changes::notify_id(engine,org_id,changed);
    Ok(())
}
