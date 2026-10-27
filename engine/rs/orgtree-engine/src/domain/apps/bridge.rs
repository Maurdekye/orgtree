//! Parent-only sessions and explicit app capability decisions. App code never
//! receives a desktop credential, caller identity, endpoint or grant method.
use std::{collections::{HashMap,VecDeque},sync::{Arc,Mutex,Weak},time::{Duration,Instant}};
use anyhow::Result;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use crate::{engine::Engine,orgs::OrgHandle};
use super::wire;

#[derive(Clone,Deserialize,Serialize)]
#[serde(tag="action",deny_unknown_fields)]
pub enum Action {
    #[serde(rename="org.read")] OrgRead { after:Option<i64>, limit:Option<i64> },
    #[serde(rename="docket.create")] DocketCreate { title:String, objective:String, owner:String },
    #[serde(rename="events.fire")] EventsFire { name:String, payload:Value },
    /// Internet access (USER 2026-10-26 m95c57abc95fb): one HTTPS request the
    /// engine makes for the app. headers are [name,value] pairs; body is
    /// standard base64.
    #[serde(rename="net.fetch")] NetFetch { url:String, #[serde(default="default_method")] method:String, #[serde(default)] headers:Vec<(String,String)>, #[serde(default)] body:Option<String> },
}
#[nolog] fn default_method()->String{"GET".into()}
impl Action {
    #[nolog] pub fn capability(&self)->&'static str {match self{Self::OrgRead{..}=>"org.read",Self::DocketCreate{..}=>"docket.write",Self::EventsFire{..}=>"events.fire",Self::NetFetch{..}=>super::net::CAPABILITY}}
    #[nolog] pub fn validate(&self)->Result<()> {
        if let Self::NetFetch{..}=self{
            if serde_json::to_vec(self)?.len()>super::net::BRIDGE_INPUT_MAX{crate::refuse!(BadRequest,"app internet request exceeds 1 MiB of body");}
            self.to_fetch()?;return Ok(());
        }
        wire::bounded(&serde_json::to_value(self)?,wire::EVENT_MAX,false)?;
        match self {
            Self::OrgRead{after,limit}=>{if after.is_some_and(|v|v<0)||limit.is_some_and(|v|!(1..=200).contains(&v)){crate::refuse!(BadRequest,"invalid app chart page");}},
            Self::DocketCreate{title,objective,owner}=>{wire::text(title,200,"title",false)?;recipient(owner)?;if objective.trim().is_empty()||objective.contains('\0'){crate::refuse!(BadRequest,"app work needs a description");}},
            Self::EventsFire{name,payload}=>{wire::text(name,80,"app event name",false)?;wire::bounded(payload,wire::EVENT_MAX,false)?;},
            Self::NetFetch{..}=>{},
        }Ok(())
    }
    /// The checked request an internet action makes.
    #[nolog] pub(super) fn to_fetch(&self)->Result<super::net::Fetch> {
        use base64::Engine as _;
        let Self::NetFetch{url,method,headers,body}=self else{crate::refuse!(BadRequest,"not an app internet request");};
        let url=reqwest::Url::parse(url).map_err(|_|crate::domain::UserError::BadRequest("invalid app internet URL".into()))?;
        let body=body.as_deref().map(|b|base64::engine::general_purpose::STANDARD.decode(b)).transpose().map_err(|_|crate::domain::UserError::BadRequest("app internet body must be standard base64".into()))?;
        let fetch=super::net::Fetch{url,method:method.clone(),headers:headers.clone(),body};super::net::validate_fetch(&fetch)?;Ok(fetch)
    }
    /// The host and port an internet action asks for; None for other actions.
    #[nolog] fn net_target(&self)->Result<Option<(String,u16)>> {
        let Self::NetFetch{url,..}=self else{return Ok(None);};
        let url=reqwest::Url::parse(url).map_err(|_|crate::domain::UserError::BadRequest("invalid app internet URL".into()))?;Ok(Some(super::net::url_host_port(&url)?))
    }
}
#[nolog] fn recipient(name:&str)->Result<()> {
    wire::text(name,120,"agent name",false)?;
    if name.starts_with('@')||name.contains(':')||name.contains('/')||["user","system"].contains(&name){crate::refuse!(Forbidden,"apps target live local agents only; no user, project or outside recipient");}Ok(())
}

#[derive(Deserialize)]
#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]
pub enum Request {
    /// A host names the execution generation it runs; absent binds the current one.
    SessionOpen { panel:String, generation:Option<i64> },
    SessionClose { session:String },
    Call { session:String, request:Action },
    Decide { session:String, challenge:String, choice:Choice },
}
#[derive(Clone,Copy,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Choice { Once, Always, Deny }

#[derive(Default)]
pub struct AppGate { pub lock:tokio::sync::Mutex<()>, rate:Arc<ActionRate> }
#[derive(Default)]
struct ActionRate { recent:Mutex<VecDeque<Instant>> }
impl AppGate {
    #[nolog] pub(super) fn admit(&self)->Result<()> {
        let mut q=self.rate.recent.lock().map_err(|_|anyhow::anyhow!("Apps rate registry unavailable"))?;let now=Instant::now();
        while q.front().is_some_and(|at|now.duration_since(*at)>=Duration::from_secs(60)){q.pop_front();}
        if q.len()>=60{crate::refuse!(Conflict,"app engine actions are limited to60 per minute across its panels");}q.push_back(now);Ok(())
    }
}
#[derive(Clone)]
pub(super) struct Bound {pub org:i64,pub app:String,pub panel:String,pub rev:i64,pub generation:i64,pub gate:Arc<AppGate>}
struct Pending {id:String,action:Action,until:Instant}
struct Session {bound:Bound,until:Instant,pending:Option<Pending>}
#[derive(Default)]
pub struct Registry {
    pub(super) dispatch:super::events::Dispatcher,

    pub(crate) file_access:super::file_access::Registry,
    pub runtime:super::runtime::Registry,
    pub net:super::net::Registry,
    gates:Mutex<HashMap<(i64,String),Weak<AppGate>>>,
    rates:Mutex<HashMap<(i64,String),Arc<ActionRate>>>,
    sessions:Mutex<HashMap<String,Session>>,
}
impl Registry {
    #[nolog] pub fn gate(&self,org:i64,app:&str)->Result<Arc<AppGate>> {
        let mut all=self.gates.lock().map_err(|_|anyhow::anyhow!("Apps gate registry unavailable"))?;
        all.retain(|_,gate|gate.strong_count()>0);
        let key=(org,app.to_owned());if let Some(gate)=all.get(&key).and_then(Weak::upgrade){return Ok(gate);}
        let mut rates=self.rates.lock().map_err(|_|anyhow::anyhow!("Apps rate registry unavailable"))?;
        let now=Instant::now();
        // A window survives the last host/gate. Prune only inactive, expired
        // histories; a retained active gate may still admit another dispatch.
        rates.retain(|_,rate|Arc::strong_count(rate)>1||rate.recent.lock().map(|q|q.back().is_some_and(|at|now.duration_since(*at)<Duration::from_secs(60))).unwrap_or(true));
        let rate=rates.entry(key.clone()).or_default().clone();
        let gate=Arc::new(AppGate{lock:tokio::sync::Mutex::new(()),rate});all.insert(key,Arc::downgrade(&gate));Ok(gate)
    }
    #[nolog] fn open(&self,bound:Bound)->Result<String> {
        let mut all=self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?;
        let now=Instant::now();let expired:Vec<_>=all.iter().filter(|(_,s)|s.until<=now).map(|(token,s)|(s.bound.org,token.clone())).collect();all.retain(|_,s|s.until>now);
        if all.len()>=4096{crate::refuse!(Conflict,"too many active app host sessions");}
        let token=secret();all.insert(token.clone(),Session{bound,until:now+Duration::from_secs(1800),pending:None});drop(all);
        // An expired host ends its questions; its copy's file and media links stay.
        for (org,expired) in expired{self.file_access.forget_prompts(org,None,None,Some(&expired))?;}Ok(token)
    }
    #[nolog] pub(super) fn bound(&self,org:i64,token:&str)->Result<Bound> {
        let all=self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?;
        let Some(s)=all.get(token).filter(|s|s.bound.org==org&&s.until>Instant::now()) else{crate::refuse!(Forbidden,"app host session expired or unavailable");};Ok(s.bound.clone())
    }
    #[nolog] fn ask(&self,org:i64,token:&str,action:Action)->Result<String> {
        let mut all=self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?;
        let Some(s)=all.get_mut(token).filter(|s|s.bound.org==org&&s.until>Instant::now()) else{crate::refuse!(Forbidden,"app host session expired");};
        if s.pending.as_ref().is_some_and(|p|p.until>Instant::now()){crate::refuse!(Conflict,"answer the pending app permission prompt first");}
        let id=secret();s.pending=Some(Pending{id:id.clone(),action,until:Instant::now()+Duration::from_secs(120)});Ok(id)
    }
    #[nolog] fn consume(&self,org:i64,token:&str,id:&str)->Result<Action> {
        let mut all=self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?;
        let Some(s)=all.get_mut(token).filter(|s|s.bound.org==org&&s.until>Instant::now()) else{crate::refuse!(Forbidden,"app host session expired");};
        if !s.pending.as_ref().is_some_and(|p|p.id==id&&p.until>Instant::now()){crate::refuse!(Forbidden,"app permission prompt expired or does not match");}
        Ok(s.pending.take().expect("checked pending action").action)
    }
    #[nolog] pub fn revoke(&self,org:i64,app:Option<&str>,panel:Option<&str>)->Result<()> {
        self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?.retain(|_,s|!(s.bound.org==org&&app.is_none_or(|a|s.bound.app==a)&&panel.is_none_or(|p|s.bound.panel==p)));
        // Power off, deletion, code change and Stop all end internet requests in
        // flight and Allow once answers too.
        self.net.revoke(org,app,panel);
        self.file_access.forget(org,app,panel)
    }
    #[nolog] fn close(&self,org:i64,token:&str)->Result<()> {
        let mut all=self.sessions.lock().map_err(|_|anyhow::anyhow!("Apps session registry unavailable"))?;
        if all.get(token).is_some_and(|s|s.bound.org==org){all.remove(token);}drop(all);
        // Renewal, pop-out and a closed window keep the copy's file and media links
        // (USER 2026-10-26 mf7add4fda093); only this host's open questions end.
        self.file_access.forget_prompts(org,None,None,Some(token))
    }
}
#[nolog] pub(super) fn secret()->String {format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple())}

/// Execution, not visibility, admits a host: a hidden running panel keeps its
/// actions. Stop, restart, code replacement and Stop all fence older hosts.
#[nolog]
pub(super) async fn snapshot(engine:&Engine,bound:&Bound)->Result<Value> {
    let client=engine.db.get().await?;
    let row=client.query_opt("SELECT jsonb_build_object('name',a.name,'origin',a.origin,'rev',a.rev,'capabilities',a.capabilities,'events',a.declared_events,'permissions',a.permissions,'permission_rev',a.permission_rev,'sites',a.declared_sites,'site_permissions',a.site_permissions,'label',p.label,'open',p.is_open,'running',p.is_running,'run_generation',p.run_generation,'latched',o.killswitch IS NOT NULL) FROM ot.custom_apps a JOIN ot.custom_panels p ON p.org_id=a.org_id AND p.app_id=a.id JOIN ot.orgs o ON o.id=a.org_id WHERE a.org_id=$1 AND a.id=$2 AND p.id=$3",&[&bound.org,&bound.app,&bound.panel]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"app or saved panel was removed");};let value:Value=row.get(0);
    if value["latched"]==true{crate::refuse!(Forbidden,"Stop all is on for this org; app actions are paused");}
    if value["running"]!=true||value["run_generation"].as_i64()!=Some(bound.generation)||value["rev"].as_i64()!=Some(bound.rev){crate::refuse!(Forbidden,"app code changed or panel stopped; reopen its host session");}Ok(value)
}
/// Native consent needs a visible panel: a hidden one never opens a prompt.
#[nolog]
pub(super) fn interactive(value:&Value)->Result<()>{
    if value["open"]!=true{crate::refuse!(Conflict,"interaction_required: this panel is hidden; show it to answer its permission prompt");}Ok(())
}
#[nolog]
fn permission(value:&Value,action:&Action)->Result<&'static str> {
    let cap=action.capability();
    if let Action::EventsFire{name,..}=action{if !value["events"].as_array().is_some_and(|a|a.iter().any(|e|e["name"]==name.as_str())){crate::refuse!(Forbidden,"app does not declare this event name");}}
    if let Some((host,port))=action.net_target()?{return super::policy::net_decision(value,&host,port);}
    super::policy::decision(value,cap)
}
/// The decision for this running copy: a site it was allowed once counts as Allow.
#[nolog]
fn mode(engine:&Engine,bound:&Bound,value:&Value,action:&Action)->Result<&'static str> {
    let mode=permission(value,action)?;
    if mode=="ask"{if let Some((host,port))=action.net_target()?{
        if engine.custom_apps.net.once(bound.org,&bound.app,&bound.panel,bound.generation)?.contains(&super::policy::net_site(value,&host,port)){return Ok("allow");}
    }}
    Ok(mode)
}
/// What the native prompt shows. An internet request shows its method, URL and
/// the site row an answer is stored under, never its headers or body.
#[nolog]
fn prompt(bound:&Bound,value:&Value,action:&Action,challenge:&str)->Result<Value> {
    let mut out=json!({"challenge":challenge,"app":bound.app,"panel":bound.panel,"name":value["name"],"label":value["label"],"capability":action.capability(),"request":action});
    if let (Action::NetFetch{url,method,..},Some((host,port)))=(action,action.net_target()?){
        out["request"]=json!({"action":super::net::CAPABILITY,"method":method,"url":url});
        out["site"]=json!(super::policy::net_site(value,&host,port));out["host"]=json!(super::net::site_key(&host,port));
    }
    Ok(out)
}
/// A bridge body is bounded by its action: an internet request carries up to
/// 1 MiB of base64 body; everything else keeps the event bound.
#[nolog]
fn input_max(input:&Value)->usize {if input["request"]["action"]==super::net::CAPABILITY{super::net::BRIDGE_INPUT_MAX}else{wire::EVENT_MAX+8192}}
struct NetCall<'a> {fetch:super::net::Fetch,value:Value,once:std::collections::HashSet<String>,ticket:super::net::Ticket<'a>}
/// Under the app gate: the request, the grant snapshot its redirects are checked
/// against, and its admission (rate, concurrency, abort handle).
#[nolog]
fn admit_fetch<'a>(engine:&'a Engine,bound:&Bound,value:Value,action:&Action)->Result<NetCall<'a>> {
    let fetch=action.to_fetch()?;let once=engine.custom_apps.net.once(bound.org,&bound.app,&bound.panel,bound.generation)?;
    let ticket=engine.custom_apps.net.admit(bound.org,&bound.app,&bound.panel)?;Ok(NetCall{fetch,value,once,ticket})
}
/// Runs outside the app gate, so a revoke never waits behind a slow site; the
/// revoke aborts the request instead. URL, headers and bodies stay out of logs.
#[nolog]
async fn net_fetch(bound:&Bound,call:NetCall<'_>)->Result<Value> {
    use base64::Engine as _;
    tracing::info!(app=%bound.app,panel=%bound.panel,capability=super::net::CAPABILITY,"app action dispatch");
    let NetCall{fetch,value,once,ticket}=call;
    let allow=|host:&str,port:u16|match super::policy::net_decision(&value,host,port){Ok("allow")=>true,Ok(_)=>once.contains(&super::policy::net_site(&value,host,port)),Err(_)=>false};
    let done=crate::trace::private_app(async{tokio::select!{
        _=ticket.cancel.cancelled()=>Err(anyhow::Error::from(crate::domain::UserError::Forbidden("app internet request was stopped: its permission changed, or its copy was stopped or changed".into()))),
        out=super::net::fetch(fetch,&allow)=>out,
    }}).await;
    drop(ticket);let f=done?;
    Ok(json!({"status":f.status,"headers":f.headers,"body":base64::engine::general_purpose::STANDARD.encode(&f.body),"url":f.final_url,"redirected":f.redirected}))
}

/// A removed app action fails with directions, not a parse error (user 2026-10-26:
/// agents hear apps only through events; "Remove; import, never grant").
#[nolog] fn retired(input:&Value)->Result<()>{if input["request"]["action"]=="mail.send"{crate::refuse!(BadRequest,"{}",wire::MAIL_SEND_REMOVED);}Ok(())}

#[nolog]
pub async fn run(engine:&Arc<Engine>,org:&Arc<OrgHandle>,input:&Value)->Result<Value> {
    wire::bounded(input,input_max(input),false)?;retired(input)?;
    let request:Request=serde_json::from_value(input.clone()).map_err(|e|crate::domain::UserError::BadRequest(format!("invalid app bridge request: {e}")))?;
    match request {
        Request::SessionOpen{panel,generation}=>{
            let client=engine.db.get().await?;
            let row=client.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,&panel]).await?;
            let Some(row)=row else{crate::refuse!(NotFound,"saved panel not found");};let app:String=row.get(0);drop(client);
            let gate=engine.custom_apps.gate(org.id,&app)?;let _guard=gate.lock.lock().await;
            let client=engine.db.get().await?;let row=client.query_opt("SELECT a.rev,p.run_generation,o.killswitch IS NOT NULL FROM ot.custom_apps a JOIN ot.custom_panels p ON p.org_id=a.org_id AND p.app_id=a.id JOIN ot.orgs o ON o.id=p.org_id WHERE p.org_id=$1 AND p.id=$2 AND p.is_running",&[&org.id,&panel]).await?;
            let Some(row)=row else{crate::refuse!(Conflict,"panel is stopped or removed");};let (rev,current,latched):(i64,i64,bool)=(row.get(0),row.get(1),row.get(2));
            if latched{crate::refuse!(Forbidden,"Stop all is on for this org; app actions are paused");}
            if generation.is_some_and(|g|g!=current){crate::refuse!(Conflict,"panel was stopped or restarted; reload its host");}
            let token=engine.custom_apps.open(Bound{org:org.id,app:app.clone(),panel,rev,generation:current,gate:gate.clone()})?;
            Ok(json!({"session":token,"app":app,"app_rev":rev,"run_generation":current,"expires_in":1800}))
        },
        Request::SessionClose{session}=>{let bound=engine.custom_apps.bound(org.id,&session)?;let _guard=bound.gate.lock.lock().await;engine.custom_apps.close(org.id,&session)?;Ok(json!({"closed":true}))},
        Request::Call{session,request:action}=>{
            action.validate()?;let bound=engine.custom_apps.bound(org.id,&session)?;
            let call={
                let _guard=bound.gate.lock.lock().await;
                engine.custom_apps.bound(org.id,&session)?;let value=snapshot(engine,&bound).await?;let mode=mode(engine,&bound,&value,&action)?;
                if mode=="ask"{interactive(&value)?;let id=engine.custom_apps.ask(org.id,&session,action.clone())?;return Ok(json!({"permission_required":prompt(&bound,&value,&action,&id)?}));}
                if !matches!(action,Action::NetFetch{..}){return execute(engine,org,&bound,&action).await;}
                admit_fetch(engine,&bound,value,&action)?
            };
            net_fetch(&bound,call).await
        },
        Request::Decide{session,challenge,choice}=>{
            let bound=engine.custom_apps.bound(org.id,&session)?;
            let call={
                let _guard=bound.gate.lock.lock().await;
                engine.custom_apps.bound(org.id,&session)?;let value=snapshot(engine,&bound).await?;
                let action=engine.custom_apps.consume(org.id,&session,&challenge)?;permission(&value,&action)?;
                // Every answer goes to the app's Permission history; Always allow
                // and Deny store the choice, on the site row for internet access.
                let site=action.net_target()?.map(|(host,port)|super::policy::net_site(&value,&host,port));
                let answer=match choice{Choice::Once=>"once",Choice::Always=>"allow",Choice::Deny=>"deny"};
                super::storage::prompt_answer(engine,org,&bound.app,(bound.rev,value["permission_rev"].as_i64().unwrap_or(0)),action.capability(),site.as_deref(),answer,&bound.panel).await?;
                if matches!(choice,Choice::Deny){
                    // Deny wins over temporary grants: this app's requests in flight end.
                    if site.is_some(){engine.custom_apps.net.revoke(org.id,Some(&bound.app),None);}
                    crate::refuse!(Forbidden,"app action denied");
                }
                if let (Choice::Once,Some(site))=(choice,&site){engine.custom_apps.net.allow_once(org.id,&bound.app,&bound.panel,bound.generation,site)?;}
                if !matches!(action,Action::NetFetch{..}){return execute(engine,org,&bound,&action).await;}
                // Redirects are checked against the answer just stored.
                let value=snapshot(engine,&bound).await?;admit_fetch(engine,&bound,value,&action)?
            };
            net_fetch(&bound,call).await
        },
    }
}

#[nolog]
async fn live_agent(engine:&Engine,org:i64,name:&str)->Result<i64> {
    let client=engine.db.get().await?;let row=client.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND kind='agent' AND state='live'",&[&org,&name]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"app target must be a live agent in this organization");};Ok(row.get(0))
}
#[nolog]
async fn execute(engine:&Arc<Engine>,org:&Arc<OrgHandle>,bound:&Bound,action:&Action)->Result<Value> {
    // Both direct Allow and successful Once/Always decisions reach this exact
    // admission point. Ask, Cancel and Deny do not execute an action.
    bound.gate.admit()?;
    tracing::info!(app=%bound.app,panel=%bound.panel,capability=action.capability(),"app action dispatch");
    crate::trace::private_app(execute_private(engine,org,bound,action)).await
}
#[nolog]
async fn execute_private(engine:&Arc<Engine>,org:&Arc<OrgHandle>,bound:&Bound,action:&Action)->Result<Value> {
    match action {
        Action::OrgRead{after,limit}=>{
            let client=engine.db.get().await?;let n=limit.unwrap_or(100);let after=after.unwrap_or(0);
            let rows=client.query("SELECT id,jsonb_build_object('id',id,'name',name,'kind',kind,'parent',parent_id,'state',state,'tier',tier) FROM ot.agents WHERE org_id=$1 AND state='live' AND id>$2 ORDER BY id LIMIT $3",&[&org.id,&after,&(n+1)]).await?;
            let more=rows.len()>n as usize;let rows:Vec<_>=rows.into_iter().take(n as usize).collect();let next=if more{rows.last().map(|r|r.get::<_,i64>(0))}else{None};
            Ok(json!({"items":rows.iter().map(|r|r.get::<_,Value>(1)).collect::<Vec<_>>(),"next_cursor":next}))
        },
        Action::DocketCreate{title,objective,owner}=>{
            live_agent(engine,org.id,owner).await?;
            let who=crate::domain::docket::Who::App{app:bound.app.clone(),panel:bound.panel.clone()};
            crate::domain::docket::create(engine,org,&who,&json!({"title":title,"objective":objective,"owner":owner,"kind":"non-code","status":"open"})).await
        },
        Action::EventsFire{name,payload}=>{
            let mut c=engine.db.get().await?;let tx=c.transaction().await?;
            let out=super::events::publish(&tx,org.id,&bound.panel,name,payload,json!({"kind":"app","app":bound.app,"panel":bound.panel,"app_rev":bound.rev})).await?;
            tx.commit().await?;drop(c);super::events::notify(engine);Ok(out)
        },
        // Internet requests run in net_fetch, outside the app gate.
        Action::NetFetch{..}=>crate::refuse!(BadRequest,"app internet requests do not run here"),
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn custom_apps_org_defaults_allow_internal_actions_without_native_prompt(){
        for origin in ["created","imported","template","legacy"]{
            let value=json!({"origin":origin,"capabilities":["org.read","events.fire","docket.write"],"permissions":{},"events":[{"name":"submitted"}]});
            for action in [Action::OrgRead{after:None,limit:None},Action::EventsFire{name:"submitted".into(),payload:json!({})},Action::DocketCreate{title:"Review".into(),objective:"Notes".into(),owner:"worker".into()}]{
                assert_eq!(permission(&value,&action).unwrap(),"allow","origin {origin} should have implicit org access");
            }
        }
    }
    #[test] fn custom_apps_bridge_never_accepts_general_ops_or_selected_identity(){
        for input in [json!({"action":"publish"}),json!({"action":"mail.send","to":"bob","body":"x","as_user":true}),json!({"action":"org.read","org":"other"})]{assert!(serde_json::from_value::<Action>(input).is_err());}
        for name in ["user","system","@bob","net:remote","org:elsewhere"]{assert!(recipient(name).is_err());}
    }
    // USER 2026-10-26: agents hear apps only through events ("Remove; import, never grant").
    #[test] fn custom_apps_mail_send_is_no_longer_an_app_action(){
        assert!(serde_json::from_value::<Action>(json!({"action":"mail.send","to":"worker","body":"notes"})).is_err(),"mail.send is no app action");
        let refused=retired(&json!({"action":"call","session":"s","request":{"action":"mail.send","to":"worker","body":"notes"}})).unwrap_err().to_string();
        assert!(refused.contains("orgtree.events.fire")&&refused.contains("app_listener"),"the refusal points to events: {refused}");
        assert!(retired(&json!({"action":"call","session":"s","request":{"action":"events.fire","name":"submitted","payload":{}}})).is_ok());
    }
    // USER 2026-10-26 m95c57abc95fb; design m232e1d1ccb57: an explicit, bounded
    // engine request; declaring it grants nothing; the prompt never shows secrets.
    #[test] fn custom_apps_internet_requests_are_explicit_bounded_and_need_their_own_grant(){
        use base64::Engine as _;let b64=|s:&str|base64::engine::general_purpose::STANDARD.encode(s);
        let ok=json!({"action":"net.fetch","url":"https://api.example.com/v1?q=1","method":"POST","headers":[["Content-Type","application/json"]],"body":b64("{}")});
        let action:Action=serde_json::from_value(ok).unwrap();action.validate().unwrap();assert_eq!(action.capability(),"net.fetch");
        let get:Action=serde_json::from_value(json!({"action":"net.fetch","url":"https://api.example.com/x"})).unwrap();get.validate().unwrap();
        for bad in [json!({"action":"net.fetch","url":"http://api.example.com"}),json!({"action":"net.fetch","url":"https://api.example.com","headers":[["Cookie","a=b"]]}),json!({"action":"net.fetch","url":"https://api.example.com","method":"POST","body":"not base64!"}),json!({"action":"net.fetch","url":"file:///C:/x"}),json!({"action":"net.fetch","url":"https://127.0.0.1:1"})]{
            let parsed:Action=serde_json::from_value(bad.clone()).unwrap();
            if bad["url"]=="https://127.0.0.1:1"{assert!(parsed.validate().is_ok(),"addresses are refused at connect time, after the grant check");continue;}
            assert!(parsed.validate().is_err(),"{bad}");
        }
        assert!(serde_json::from_value::<Action>(json!({"action":"net.fetch","url":"https://api.example.com","credentials":"include"})).is_err(),"no ambient credentials option");
        // Declaring the capability and the site grants nothing: the decision asks.
        let value=json!({"origin":"created","capabilities":["net.fetch"],"sites":["api.example.com"],"permissions":{},"site_permissions":{}});
        assert_eq!(permission(&value,&get).unwrap(),"ask");
        let other:Action=serde_json::from_value(json!({"action":"net.fetch","url":"https://other.example.com/x"})).unwrap();assert!(permission(&value,&other).is_err());
        // The prompt shows method, URL and the site row, never headers or body.
        let secret=Action::NetFetch{url:"https://api.example.com/x".into(),method:"POST".into(),headers:vec![("Authorization".into(),"Bearer s3cret".into())],body:Some(b64("private payload"))};
        let registry=Registry::default();let gate=registry.gate(1,"app").unwrap();let bound=Bound{org:1,app:"app".into(),panel:"copy".into(),rev:1,generation:1,gate};
        let shown=prompt(&bound,&json!({"name":"Feed","label":"Panel 1","sites":["api.example.com"]}),&secret,"c").unwrap();
        assert_eq!(shown["site"],"api.example.com");assert_eq!(shown["request"],json!({"action":"net.fetch","method":"POST","url":"https://api.example.com/x"}));
        assert!(!shown.to_string().contains("s3cret")&&!shown.to_string().contains(&b64("private payload")));
        // Only an internet request may use the larger bridge body.
        assert_eq!(input_max(&json!({"action":"call","request":{"action":"net.fetch"}})),super::super::net::BRIDGE_INPUT_MAX);
        assert_eq!(input_max(&json!({"action":"call","request":{"action":"events.fire"}})),wire::EVENT_MAX+8192);
    }
    #[test] fn custom_apps_bridge_declarations_and_denials_are_not_grants(){
        let action=Action::DocketCreate{title:"Review".into(),objective:"Notes".into(),owner:"agent".into()};
        assert!(permission(&json!({"capabilities":[],"permissions":{"docket.write":"allow"}}),&action).is_err());
        assert_eq!(permission(&json!({"capabilities":["docket.write"],"permissions":{}}),&action).unwrap(),"ask");
        assert!(permission(&json!({"capabilities":["docket.write"],"permissions":{"docket.write":"deny"}}),&action).is_err());
    }
    #[test] fn custom_apps_bridge_challenge_is_bound_one_shot_and_revocable(){
        let registry=Registry::default();let gate=registry.gate(1,"app").unwrap();let token=registry.open(Bound{org:1,app:"app".into(),panel:"copy".into(),rev:7,generation:1,gate}).unwrap();assert_eq!(token.len(),64);
        assert!(registry.bound(2,&token).is_err());
        let action=Action::OrgRead{after:None,limit:Some(10)};let id=registry.ask(1,&token,action.clone()).unwrap();
        assert!(registry.consume(1,&token,"wrong").is_err());assert!(registry.ask(1,&token,action).is_err());
        assert!(registry.consume(1,&token,&id).is_ok());assert!(registry.consume(1,&token,&id).is_err());
        registry.revoke(1,None,Some("copy")).unwrap();assert!(registry.bound(1,&token).is_err());
    }
    #[test] fn custom_apps_bridge_gates_share_limits_without_retaining_history(){
        let r=Registry::default();let a=r.gate(1,"a").unwrap();assert!(Arc::ptr_eq(&a,&r.gate(1,"a").unwrap()));
        for _ in 0..60{a.admit().unwrap();}assert!(a.admit().is_err());drop(a);r.gate(1,"b").unwrap();assert_eq!(r.gates.lock().unwrap().len(),1);
    }
    #[test] fn custom_apps_execution_budget_survives_last_host_close_and_reopen(){
        let r=Registry::default();let gate=r.gate(1,"app").unwrap();
        let token=r.open(Bound{org:1,app:"app".into(),panel:"copy".into(),rev:1,generation:1,gate:gate.clone()}).unwrap();
        for _ in 0..60{gate.admit().unwrap();}
        r.close(1,&token).unwrap();drop(gate);
        assert!(r.gate(1,"app").unwrap().admit().is_err(),"closing the last host reset the execution budget");
        assert!(r.gate(2,"app").unwrap().admit().is_ok(),"different organizations share no budget");
    }
    #[test] fn custom_apps_inactive_rate_history_prunes_only_after_the_whole_window(){
        let r=Registry::default();let gate=r.gate(1,"old").unwrap();gate.admit().unwrap();drop(gate);
        let other=r.gate(1,"other").unwrap();assert_eq!(r.rates.lock().unwrap().len(),2);
        {let rates=r.rates.lock().unwrap();let mut q=rates[&(1,"old".to_owned())].recent.lock().unwrap();q.clear();q.push_back(Instant::now()-Duration::from_secs(61));}
        r.gate(1,"next").unwrap();let rates=r.rates.lock().unwrap();assert_eq!(rates.len(),2);assert!(!rates.contains_key(&(1,"old".to_owned())));drop(other);
    }
}
