//! Pushed, scoped engine events. No target polling and no cross-org payloads.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc::{channel, Receiver, Sender};

tokio::task_local! { pub(super) static ALERT_DELIVERY: bool; }

#[derive(Clone, Debug)]
pub enum Scope {
    Machine,
    Org(i64),
    Agent(i64, i64),
    NamedAgent(i64, String),
    Docket(i64, String),
    Account(Option<String>),
}

#[derive(Clone, Debug)]
pub struct Event { pub name: String, pub scope: Scope, pub payload: Value, members: Option<Arc<Vec<i64>>>, at: DateTime<Utc> }

#[derive(Clone)]
pub(super) struct Subscription {
    tx: Sender<Event>,
    target: Arc<arc_swap::ArcSwapOption<String>>,
    overflow: Arc<AtomicBool>,
}

#[logged]
pub fn event(name: &str, scope: Scope, payload: Value) -> Event {
    Event { name: name.to_owned(), scope, payload, members: None, at: Utc::now() }
}

/// Only engine producers call this: payloads are deliberately small allow-lists.
#[logged]
pub fn emit(engine: &Engine, mut e: Event) {
    e.at=Utc::now();
    if ALERT_DELIVERY.try_with(|v|*v).unwrap_or(false){return;}
    for (_, sub) in engine.dogs.events.pin().iter() {
        if sub.target.load_full().as_ref().map(|t| accepts(t, &e.name)).unwrap_or(true) {
            if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) = sub.tx.try_send(e.clone()) {
                sub.overflow.store(true, Ordering::Release);
            }
        }
    }
}

#[logged]
pub fn machine(engine: &Engine, name: &str, payload: Value) {
    emit(engine, event(name, Scope::Machine, payload));
}

#[logged]
pub(super) fn subscribe(engine: &Engine, uid: &str) -> (Subscription, Receiver<Event>) {
    let (tx, rx) = channel(256);
    let sub = Subscription { tx, target: Arc::new(arc_swap::ArcSwapOption::empty()), overflow: Arc::new(AtomicBool::new(false)) };
    engine.dogs.events.pin().insert(uid.to_owned(), sub.clone());
    (sub, rx)
}

#[logged]
pub(super) fn unsubscribe(engine: &Engine, uid: &str, sub: &Subscription) {
    let map = engine.dogs.events.pin();
    // Never remove a replacement runner's subscription.
    map.compute(uid.to_owned(), |entry| match entry {
        Some((_,s)) if s.tx.same_channel(&sub.tx)=>papaya::Operation::Remove,
        _=>papaya::Operation::Abort(()),
    });
}

#[logged]
fn accepts(target: &str, name: &str) -> bool {
    target == name || target.strip_suffix('*').map(|p| name.starts_with(p)).unwrap_or(false)

}

#[logged]
pub(super) fn validate(target: &str, args: &Value) -> Result<()> {
    let stem=target.strip_suffix(".*").unwrap_or(target);
    if stem.is_empty() || !stem.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')) {
        refuse!(BadRequest, "event target must be a dotted name or dotted prefix ending in .* ");
    }
    if args.get("threshold").is_some() {
        if !matches!(target, "agents.active" | "agents.live") { refuse!(BadRequest, "threshold requires agents.active or agents.live"); }
        threshold(&args["threshold"])?;
        if args["fire_mode"] == "silence" { refuse!(BadRequest, "a count threshold is an event crossing, not a silence timer"); }
    }
    if let Some(s)=args.get("event_scope") {
        if !matches!(s.as_str(), Some("org" | "subtree")) { refuse!(BadRequest, "event_scope must be org or subtree"); }
        if !matches!(target, "agents.active" | "agents.live") { refuse!(BadRequest, "event_scope applies to count targets only"); }
    }
    Ok(())
}

#[logged]
fn threshold(v: &Value) -> Result<(bool, i64)> {
    let s=v.as_str().unwrap_or("");
    let (below,n)=if let Some(n)=s.strip_prefix("below ") {(true,n)}
        else if let Some(n)=s.strip_prefix("at least ") {(false,n)}
        else { refuse!(BadRequest,"threshold is 'below N' or 'at least N', with nonnegative integer N"); };
    let n=n.parse::<i64>().ok().filter(|n| *n>=0);
    let Some(n)=n else { refuse!(BadRequest,"threshold needs a nonnegative integer"); };
    Ok((below,n))
}

#[logged]
async fn identity(engine: &Engine, owner: i64) -> Result<crate::tools::Me> {
    let c=engine.db.get().await?;
    let r=c.query_one("SELECT id,org_id,name,parent_id,generation,coalesce(scope->>'org_visibility','subtree') FROM ot.agents WHERE id=$1 AND state='live'", &[&owner]).await?;
    Ok(crate::tools::Me{id:r.get(0),org_id:r.get(1),name:r.get(2),parent_id:r.get(3),generation:r.get(4),visibility:r.get(5)})
}

#[logged]
async fn visible(engine: &Engine, d: &Dog, e: &Event) -> Result<bool> {
    if matches!(e.scope, Scope::Machine) { return Ok(true); }
    let me=identity(engine,d.owner).await?;
    let c=engine.db.get().await?;
    let target=match &e.scope {
        Scope::Machine=>return Ok(true),
        Scope::Org(org)=>return Ok(*org==me.org_id),
        Scope::Account(origin)=>return Ok(origin.as_ref().map(|s| engine.orgs.by_id(me.org_id).map(|o| o.slug==*s).unwrap_or(false)).unwrap_or(true)),
        Scope::Agent(org,id)=> {if *org!=me.org_id{return Ok(false)};*id},
        Scope::NamedAgent(org,name)=> {
            if *org!=me.org_id{return Ok(false)};
            let Some(r)=c.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state<>'deleted'", &[org,name]).await? else{return Ok(false)};r.get(0)
        },
        Scope::Docket(org,slug)=> {
            if *org!=me.org_id{return Ok(false)};
            return crate::domain::docket::event_readable(&**c,me.id,&me.name,*org,slug).await;
        }
    };
    // Scope::Agent always verifies the org, even when visibility is full.
    let exists: bool=c.query_one("SELECT EXISTS(SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND state<>'deleted')", &[&target,&me.org_id]).await?.get(0);
    if !exists{return Ok(false)};
    Ok(crate::tools::visible(&c,&me).await?.map(|ids|ids.contains(&target)).unwrap_or(true))
}

#[logged]
async fn count(engine: &Engine, owner: i64, active: bool, scope: &str, members: Option<&Vec<i64>>) -> Result<i64> {
    let me=identity(engine,owner).await?;
    if scope=="org" && me.visibility!="full" {refuse!(Forbidden,"org count requires full organization visibility; use event_scope subtree");}
    let c=engine.db.get().await?;
    let visible=crate::tools::visible(&c,&me).await?;
    let rows=if scope=="org" {
        c.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state<>'deleted'", &[&me.org_id]).await?
    } else {
        c.query("WITH RECURSIVE down(id,depth) AS (SELECT $1::bigint,0 UNION ALL SELECT a.id,d.depth+1 FROM ot.agents a JOIN down d ON a.parent_id=d.id WHERE a.org_id=$2 AND a.state<>'deleted' AND d.depth<1024) SELECT id FROM down", &[&owner,&me.org_id]).await?
    };
    Ok(rows.iter().filter(|r| {let id:i64=r.get(0);visible.as_ref().map(|v|v.contains(&id)).unwrap_or(true)
        && members.map(|ids|ids.contains(&id)).unwrap_or_else(|| !active || engine.agents.get(id).map(|h|h.view.load()["busy"]==true).unwrap_or(false))}).count() as i64)
}

/// Current conditions are smoke evidence, not replayed historical transitions.
#[logged]
pub(super) async fn smoke(engine: &Engine, owner: i64, target: &str, args: &Value) -> Result<Value> {
    let current=match target {
        "agents.active"|"agents.live"=>{let me=identity(engine,owner).await?;let ids=live_ids(engine,me.org_id).await?;json!({"count":count(engine,owner,target=="agents.active",args["event_scope"].as_str().unwrap_or("subtree"),if target=="agents.live"{Some(&ids)}else{None}).await?})},
        "credentials.isolated"|"credentials.ready"=>json!({"current":if engine.credentials.state.load().warning.is_some(){"credentials.isolated"}else{"credentials.ready"}}),
        "credentials.bridge.available"|"credentials.bridge.unavailable"=>json!({"current":if engine.credential_bridge.ready(){"credentials.bridge.available"}else{"credentials.bridge.unavailable"}}),
        "engine.started"=>json!({"current":"engine.started","commit":option_env!("ORGTREE_BUILD_COMMIT").unwrap_or("rust-engine"),"pid":engine.boot.pid}),
        "credits.changed"|"credits.*"=>json!({"credits":credit_baseline(engine,owner).await?}),
        _=>engine.dogs.conditions.pin().get(target).cloned().unwrap_or(Value::Null),
    };
    let matched=if let Some(n)=current["count"].as_i64() {
        if !args["threshold"].is_null(){let (below,t)=threshold(&args["threshold"])?;if below {n<t}else{n>=t}}else{true}
    }else{current["current"].as_str().map(|name|accepts(target,name)).unwrap_or(false)};
    let matched=matched && args["pattern"].as_str().map(|p|compile(p).ok().and_then(|r|r.is_match(&current.to_string()).ok()).unwrap_or(false)).unwrap_or(true);
    Ok(json!({"push":true,"current":current,"matched":matched,"note":"Already-current conditions are reported here; only future events fire. Count thresholds fire on false-to-true crossings. No offline event replay; engine.started fires on recovery."}))
}

#[logged]
pub fn condition(engine: &Engine, name: &str, opposite: &str, payload: Value) {
    let map=engine.dogs.conditions.pin();
    map.remove(opposite);
    map.insert(name.to_owned(),json!({"current":name,"payload":payload}));
    machine(engine,name,payload);
}

#[logged]
pub(super) async fn run(engine: &Arc<Engine>, mut d: Dog, sub: &Subscription, mut rx: Receiver<Event>, cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled(){return Ok(())}
    sub.target.store(Some(Arc::new(d.target.clone())));
    let re=d.regex();
    if re.is_err(){pause(engine,&d,"invalid event pattern; recreate with a valid regex").await?;return Ok(())}
    let mut pending: Vec<Event>=Vec::new();
    loop {
        if sub.overflow.swap(false,Ordering::AcqRel) {
            pause(engine,&d,"engine-event queue overflowed; events were missed. Narrow the target and resume.").await?;
            tracing::warn!(watchdog=%d.uid,"event watchdog paused after queue overflow");return Ok(());
        }
        let gap=chrono::Duration::seconds(d.interval_s.max(STREAM_FLOOR_S));
        let wait=if d.silence(){Duration::from_secs(d.due_in().unwrap_or(1).max(0) as u64)}
            else if !pending.is_empty(){d.last_fired.map(|t|(t+gap-Utc::now()).to_std().unwrap_or_default()).unwrap_or_default()}
            else {Duration::from_secs(86400*365)};
        let next=tokio::select!{m=rx.recv()=>{let Some(e)=m else{return Ok(())};Some(e)},_=tokio::time::sleep(wait)=>None,_=cancel.cancelled()=>return Ok(())};
        let Some(fresh)=load(engine,&d.uid).await? else{return Ok(())};d=fresh;
        if d.state!="armed" || !d.owner_live{return Ok(())}
        if let Some(mut e)=next {
            if e.at<d.created_at || !accepts(&d.target,&e.name) || !visible(engine,&d,&e).await? {continue;}
            if matches!(e.name.as_str(),"agents.active"|"agents.live") {
                let n=match count(engine,d.owner,e.name=="agents.active",d.memo["event_scope"].as_str().unwrap_or("subtree"),e.members.as_deref()).await {
                    Ok(n)=>n,
                    Err(_)=>{pause(engine,&d,"event count is unavailable or its scope is no longer permitted; review scope before resuming").await?;return Ok(())}
                };
                if !d.run["counts"].is_object(){d.run["counts"]=json!({});}
                let old=d.run["counts"][&e.name].as_i64().or_else(||if d.target==e.name{d.run["count"].as_i64()}else{None});d.run["counts"][&e.name]=json!(n);
                e.payload=json!({"count":n,"previous":old,"scope":d.memo["event_scope"].as_str().unwrap_or("subtree")});
                let crossing=if !d.memo["threshold"].is_null(){let (below,t)=threshold(&d.memo["threshold"])?;old.map(|o|if below{o>=t&&n<t}else{o<t&&n>=t}).unwrap_or(false)}else{old!=Some(n)};
                if !crossing{save_run(engine,&mut d,false).await?;continue;}
            }
            if e.name=="credits.changed" {
                let Scope::Agent(_,id)=e.scope else{continue};
                let c=engine.db.get().await?;
                let Some(r)=c.query_opt("SELECT a.grant_credits::float8, (a.grant_credits-coalesce((SELECT sum(seat+grant_credits) FROM ot.agents c WHERE c.parent_id=a.id AND c.state='live'),0))::float8 FROM ot.agents a WHERE a.id=$1", &[&id]).await? else{continue};
                e.payload=json!({"agent_id":id,"grant":r.get::<_,f64>(0),"free":r.get::<_,f64>(1)});
                let key=id.to_string();
                if d.run["credits"][&key]==e.payload{continue;}
                if !d.run["credits"].is_object(){d.run["credits"]=json!({});}
                d.run["credits"][&key]=e.payload.clone();
            }
            let line=format!("{} {}",e.name,e.payload);
            let hit=matches(&re,&e.payload.to_string());
            d.run["checks_run"]=json!(d.run_i64("checks_run")+1);
            d.run["last_output"]=json!(tail(&line,OUT_KEEP));note_life(&mut d.run,true);
            save_run(engine,&mut d,hit).await?;
            if hit && !d.silence(){pending.push(e);}
            if pending.len()>200 {pause(engine,&d,"too many pending engine events; narrow the target or lower interval_s").await?;return Ok(())}
        }
        if d.silence(){
            if d.due_in().map(|s|s<=0).unwrap_or(false){if fire(engine,&d,&[silence_line(&d)]," WENT QUIET —").await?{return Ok(())}d.silence_since=Some(Utc::now());}
        }else if !pending.is_empty() && d.last_fired.map(|t|Utc::now()>=t+gap).unwrap_or(true){
            // Recheck access after a cooldown: moved agents or revoked access must not leak.
            let mut lines=Vec::new();
            for e in std::mem::take(&mut pending){if visible(engine,&d,&e).await?{lines.push(format!("{} {}",e.name,e.payload));}}
            if !lines.is_empty(){if fire(engine,&d,&lines,"").await?{return Ok(())}d.last_fired=Some(Utc::now());}
        }
    }
}


/// Adapter for explicit post-commit operation records. Never forward raw detail.
#[logged]
pub fn operation(org: i64, op: &str, subject: Option<i64>, detail: &Value) -> Vec<Event> {
    let scope=subject.map(|id|Scope::Agent(org,id)).unwrap_or(Scope::Org(org));
    let name=match op {
        "hire"=>"agent.hired", "rehire"=>"agent.rehired", "retire"|"rescind"|"dissolve"=>"agent.retired",
        "halt"=>"agent.halted", "unhalt"=>"agent.unhalted", "unstick"=>"agent.unfrozen",
        "move"|"swap"|"self_subjugate"=>"agent.moved", "rename"=>"agent.renamed",
        "retool"|"scope"|"account"|"switch_model"=>"agent.settings.changed",
        "reallocate"=>"credits.changed",
        _=>return Vec::new(),
    };
    let mut payload=json!({"agent_id":subject,"operation":op});
    if name=="agent.settings.changed" {
        let fields:Vec<&str>=if matches!(op,"account"|"switch_model"){vec![if op=="account"{"account"}else{"tier"}]}
            else {detail["change"].as_object().map(|o|o.keys().map(String::as_str)
                .filter(|k|["charter","team_charter","tools","add_dirs","effort","account","account_fallback","org_visibility","permission_mode","tier"].contains(k)).collect()).unwrap_or_default()};
        payload["fields"]=json!(fields);
    }
    vec![event(name,scope,payload)]
}

/// Feed adapters expose changes without serializing the feed's private contents.
#[logged]
pub fn change(engine: &Engine, org: i64, c: &Change) {
    let e=match c {
        Change::Agent(id)=>{

            Some(event("agent.changed",Scope::Agent(org,*id),json!({"agent_id":id})))
        },
        Change::Mailbox(id)=>Some(event("mail.changed",Scope::Agent(org,*id),json!({"agent_id":id}))),
        Change::Documents(id)=>Some(event("documents.changed",Scope::Agent(org,*id),json!({"agent_id":id}))),
        Change::Org=>Some(event("org.settings.changed",Scope::Org(org),json!({}))),
        Change::Net=>Some(event("hub.changed",Scope::Org(org),json!({}))),
        Change::Pulse{node,event:kind,..}=>match *kind {
            "frozen"=>Some(event("agent.frozen",Scope::NamedAgent(org,node.clone()),json!({"agent":node}))),
            _=>None,
        },
        // A watchdog fire itself changes mail/watchdog rows: it must not feed a
        // catch-all machine event channel or leak message contents.
        _=>None,
    };
    if let Some(e)=e{emit(engine,e);}
}

/// Runtime fields are compared at their existing publication seam; token output
/// and identical snapshots create no event or SQL work.
#[logged]
pub fn runtime(engine: &Engine, org: i64, agent: i64, old: &Value, next: &Value) {
    let scope=Scope::Agent(org,agent);
    if old["busy"].as_bool().unwrap_or(false)!=next["busy"].as_bool().unwrap_or(false) {
        emit(engine,event(if next["busy"]==true{"turn.started"}else{"turn.finished"},scope.clone(),json!({"agent_id":agent})));
        if interested(engine,"agents.active") {
            let mut e=event("agents.active",Scope::Org(org),json!({}));
            e.members=Some(Arc::new(engine.agents.map.pin().iter().filter(|(_,h)|h.org_id==org && h.view.load()["busy"]==true).map(|(id,_)|*id).collect()));
            emit(engine,e);
        }
    }
    if old["proc_live"].as_bool().unwrap_or(false)!=next["proc_live"].as_bool().unwrap_or(false) {
        emit(engine,event(if next["proc_live"]==true{"cli.started"}else{"cli.cold"},scope.clone(),json!({"agent_id":agent})));
    }
    if next["proc_warm"]==true && old["proc_warm"]!=true {
        emit(engine,event("cli.ready",scope,json!({"agent_id":agent})));
    }
}

#[logged]
pub fn accounts(engine: &Engine, old: &crate::accounts::Inner, next: &crate::accounts::Inner) {
    for (id,a) in &next.by_id {
        let prev=old.by_id.get(id);
        let scope=Scope::Account(a.origin_org.clone());
        if prev.map(|p|p.auth!=a.auth).unwrap_or(true) {
            let name=if a.auth=="authenticated"{"account.signed_in"}else{"account.signed_out"};
            emit(engine,event(name,scope.clone(),json!({"account":id,"state":a.auth})));
        }
        for (pool,(until,_)) in &a.marks {
            if *until>Utc::now() && prev.and_then(|p|p.marks.get(pool)).map(|m|m.0!=*until).unwrap_or(true) {
                emit(engine,event("account.limit.reached",scope.clone(),json!({"account":id,"pool":pool,"until":iso(*until)})));
            }
        }
        if let Some(prev)=prev {for pool in prev.marks.keys(){if !a.marks.contains_key(pool){
            emit(engine,event("account.limit.reset",scope.clone(),json!({"account":id,"pool":pool})));
        }}}
    }
    for (id,a) in &old.by_id {if !next.by_id.contains_key(id){
        emit(engine,event("account.signed_out",Scope::Account(a.origin_org.clone()),json!({"account":id})));
    }}
}


#[logged]
pub fn interested(engine: &Engine, name: &str) -> bool {
    engine.dogs.events.pin().iter().any(|(_,s)|s.target.load_full().as_ref().map(|t|accepts(t,name)).unwrap_or(true))
}

#[logged]
async fn live_ids(engine: &Engine, org: i64) -> Result<Vec<i64>> {
    let c=engine.db.get().await?;
    Ok(c.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state='live'", &[&org]).await?.iter().map(|r|r.get(0)).collect())
}

/// Capture live membership in the mutating transaction; emit only after commit.
#[logged]
pub fn live_count(org: i64, ids: Vec<i64>) -> Event {
    let mut e=event("agents.live",Scope::Org(org),json!({}));e.members=Some(Arc::new(ids));e
}


#[logged]
async fn credit_baseline(engine: &Engine, owner: i64) -> Result<Value> {
    let me=identity(engine,owner).await?;
    let c=engine.db.get().await?;
    let visible=crate::tools::visible(&c,&me).await?;
    let ids=visible.map(|v|v.into_iter().collect::<Vec<_>>());
    let rows=c.query("SELECT a.id,a.grant_credits::float8,(a.grant_credits-coalesce((SELECT sum(seat+grant_credits) FROM ot.agents c WHERE c.parent_id=a.id AND c.state='live'),0))::float8 FROM ot.agents a WHERE a.org_id=$1 AND a.state='live' AND ($2::bigint[] IS NULL OR a.id=ANY($2))", &[&me.org_id,&ids]).await?;
    let mut out=json!({});
    for r in rows {let id:i64=r.get(0);out[id.to_string()]=json!({"agent_id":id,"grant":r.get::<_,f64>(1),"free":r.get::<_,f64>(2)});}
    Ok(out)
}
