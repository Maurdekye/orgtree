//! Desktop-owned HTML execution, separate from durable visibility and intent
//! (USER 2026-10-26). Native reports are observations, never an authority
//! grant. Leases do not survive an engine restart; saved intent survives, and
//! the desktop resumes it. Provisional bounds below are not user rulings.
use std::{collections::HashMap,sync::{Arc,Mutex,MutexGuard,atomic::{AtomicU64,Ordering}},time::{Duration,Instant}};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{json,Value};
use tokio_postgres::Transaction;
use crate::{engine::Engine,orgs::OrgHandle,runtime::Caller};
use super::wire;

/// A desktop window renews its leases every few seconds; a lapsed lease means
/// no window currently runs that panel.
pub const LEASE:Duration=Duration::from_secs(20);
/// Items per native heartbeat/report; the desktop splits larger sets.
const ITEMS_MAX:usize=4096;
/// An on-demand sampling request waits this long for fresh desktop reports.
const SAMPLE_WAIT:Duration=Duration::from_secs(3);
/// Per-panel attribution, or the explicitly shared owner-process fallback.
pub const CPU_METHODS:&[&str]=&["sampled CPU","shared process CPU"];

struct Host {app:String,owner:String,generation:i64,until:Instant,cpu:Option<f64>,method:Option<String>,measured_at:Option<String>,sampled:u64,error:Option<String>}

#[derive(Default)]
pub struct Registry {hosts:Mutex<HashMap<(i64,String),Host>>,epoch:AtomicU64,changed:tokio::sync::Notify}
impl Registry {
    #[nolog] fn lock(&self)->Result<MutexGuard<'_,HashMap<(i64,String),Host>>>{self.hosts.lock().map_err(|_|anyhow::anyhow!("panel runtime registry unavailable"))}
    /// Renews this window's leases and returns the panels it must stop: they
    /// were stopped or restarted, or another live window runs that generation.
    #[nolog] fn heartbeat(&self,org:i64,owner:&str,hosts:&[(String,i64,Option<String>)],current:&HashMap<String,(String,i64)>)->Result<Vec<String>>{
        let mut all=self.lock()?;let now=Instant::now();all.retain(|_,h|h.until>now);
        let mut stop=Vec::new();
        for (panel,generation,error) in hosts{
            let key=(org,panel.clone());
            let Some((app,_))=current.get(panel).filter(|(_,g)|g==generation) else{
                if all.get(&key).is_some_and(|h|h.owner==owner){all.remove(&key);}
                stop.push(panel.clone());continue;
            };
            match all.get_mut(&key){
                Some(h) if h.generation==*generation&&h.owner!=owner=>stop.push(panel.clone()),
                Some(h) if h.generation==*generation=>{h.until=now+LEASE;h.error=error.clone();},
                _=>{all.insert(key,Host{app:app.clone(),owner:owner.into(),generation:*generation,until:now+LEASE,cpu:None,method:None,measured_at:None,sampled:0,error:error.clone()});},
            }
        }
        drop(all);self.changed.notify_waiters();Ok(stop)
    }
    #[nolog] fn release(&self,org:i64,owner:&str,panels:&[String])->Result<()>{
        let mut all=self.lock()?;
        for panel in panels{let key=(org,panel.clone());if all.get(&key).is_some_and(|h|h.owner==owner){all.remove(&key);}}
        drop(all);self.changed.notify_waiters();Ok(())
    }
    #[nolog] fn report(&self,org:i64,owner:&str,epoch:u64,samples:&[Sample])->Result<usize>{
        let mut all=self.lock()?;let (now,at)=(Instant::now(),crate::util::now_iso());let mut n=0;
        for s in samples{
            if let Some(h)=all.get_mut(&(org,s.panel.clone())).filter(|h|h.owner==owner&&h.generation==s.generation&&h.until>now){
                h.cpu=s.cpu_percent;h.method=Some(s.method.clone());h.measured_at=Some(at.clone());h.sampled=h.sampled.max(epoch);n+=1;
            }
        }
        drop(all);self.changed.notify_waiters();Ok(n)
    }
    #[nolog] pub fn revoke(&self,org:i64,panel:Option<&str>)->Result<()>{
        self.lock()?.retain(|(o,p),_|!(*o==org&&panel.is_none_or(|id|id==p)));self.changed.notify_waiters();Ok(())
    }
    #[nolog] pub fn revoke_app(&self,org:i64,app:&str)->Result<()>{
        self.lock()?.retain(|(o,_),h|!(*o==org&&h.app==app));self.changed.notify_waiters();Ok(())
    }
    /// The actual state of one running panel, as its desktop window last said.
    #[nolog] fn view(&self,org:i64,panel:&str,generation:i64)->Result<Value>{
        let all=self.lock()?;let now=Instant::now();
        Ok(match all.get(&(org,panel.into())).filter(|h|h.generation==generation&&h.until>now){
            Some(h)=>json!({"status":if h.error.is_some(){"error"}else{"running"},"error":h.error,"cpu_percent":h.cpu,"cpu_method":h.method,"measured_at":h.measured_at}),
            None=>json!({"status":"not hosted","error":null,"cpu_percent":null,"cpu_method":null,"measured_at":null}),
        })
    }
    /// One on-demand sampling round; nothing samples continuously.
    #[nolog] fn request_sample(&self)->u64{self.epoch.fetch_add(1,Ordering::SeqCst)+1}
    #[nolog] pub fn sample_epoch(&self)->u64{self.epoch.load(Ordering::SeqCst)}
    #[nolog] async fn wait_sampled(&self,org:i64,panels:&[String],epoch:u64,deadline:Instant)->Result<bool>{
        loop{
            let notified=self.changed.notified();tokio::pin!(notified);notified.as_mut().enable();
            let done={let all=self.lock()?;let now=Instant::now();panels.iter().all(|p|all.get(&(org,p.clone())).is_none_or(|h|h.until<=now||h.sampled>=epoch))};
            if done{return Ok(true);}
            if tokio::time::timeout_at(tokio::time::Instant::from_std(deadline),notified).await.is_err(){return Ok(false);}
        }
    }
}

/// Starts check the org latch after locking their app row. Stop all locks
/// every app row first, so a racing start either sees the latch or is stopped.
#[nolog] pub(super) async fn can_start(tx:&Transaction<'_>,org:i64)->Result<()>{
    let latched:bool=tx.query_one("SELECT killswitch IS NOT NULL FROM ot.orgs WHERE id=$1",&[&org]).await?.get(0);
    if latched{crate::refuse!(Conflict,"Stop all is on for this org; release it before starting a panel");}Ok(())
}

/// The org killswitch powers off every saved panel, hidden copies included,
/// and clears their intent so no restart or reconnection resumes them.
#[nolog] pub async fn stop_all(engine:&Arc<Engine>,org:&Arc<OrgHandle>)->Result<u64>{
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    tx.query("SELECT id FROM ot.custom_apps WHERE org_id=$1 ORDER BY id FOR UPDATE",&[&org.id]).await?;
    let rows=tx.query("UPDATE ot.custom_panels SET is_running=false,is_open=false,run_generation=run_generation+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND (is_running OR is_open) RETURNING id",&[&org.id]).await?;
    for row in &rows{super::storage::event(&tx,org.id,row.get::<_,&str>(0),"panel.stopped",&json!({"reason":"stop all"}),"user").await?;}
    tx.commit().await?;drop(client);
    engine.custom_apps.revoke(org.id,None,None)?;engine.custom_apps.runtime.revoke(org.id,None)?;
    if !rows.is_empty(){org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    Ok(rows.len() as u64)
}

/// Running panels with their actual desktop state, in bounded ID pages.
#[nolog] pub async fn list(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,after:Option<String>,limit:Option<i64>,sample:bool)->Result<Value>{
    if let Some(caller)=caller{super::storage::file_authority(engine,org,caller).await?;}
    let n=limit.unwrap_or(100);if !(1..=200).contains(&n){crate::refuse!(BadRequest,"limit must be 1-200");}
    let after=after.unwrap_or_default();
    let client=engine.db.get().await?;
    let rows=client.query("SELECT p.id,p.app_id,a.name,p.label,p.is_open,p.run_generation FROM ot.custom_panels p JOIN ot.custom_apps a ON a.org_id=p.org_id AND a.id=p.app_id WHERE p.org_id=$1 AND p.is_running AND p.id>$2 ORDER BY p.id LIMIT $3",&[&org.id,&after,&(n+1)]).await?;drop(client);
    let more=rows.len()>n as usize;let rows:Vec<_>=rows.into_iter().take(n as usize).collect();
    let registry=&engine.custom_apps.runtime;let mut sampled=None;
    if sample{
        // Never hold a database client while the desktop samples.
        let epoch=registry.request_sample();org.emit(json!({"type":"custom_apps_sample","org":org.slug,"epoch":epoch}));
        let panels:Vec<String>=rows.iter().map(|r|r.get(0)).collect();
        sampled=Some(registry.wait_sampled(org.id,&panels,epoch,Instant::now()+SAMPLE_WAIT).await?);
    }
    let mut items=Vec::new();
    for r in &rows{
        let (panel,generation):(String,i64)=(r.get(0),r.get(5));
        let mut item=json!({"panel":panel,"app":r.get::<_,String>(1),"app_name":r.get::<_,String>(2),"label":r.get::<_,String>(3),"visible":r.get::<_,bool>(4),"run_generation":generation});
        if let (Some(target),Value::Object(view))=(item.as_object_mut(),registry.view(org.id,&panel,generation)?){target.extend(view);}
        items.push(item);
    }
    let next=if more{items.last().map(|v|v["panel"].clone())}else{None};
    Ok(json!({"items":items,"next_cursor":next,"sampled":sampled}))
}

#[derive(Deserialize)]
#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]
enum Native {
    Heartbeat { owner:String, hosts:Vec<HostReport> },
    Release { owner:String, panels:Vec<String> },
    Report { owner:String, #[serde(default)] epoch:u64, samples:Vec<Sample> },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostReport { panel:String, generation:i64, #[serde(default)] error:Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample { panel:String, generation:i64, cpu_percent:Option<f64>, method:String }

#[nolog] fn owner_id(owner:&str)->Result<()>{
    if !(8..=80).contains(&owner.len())||!owner.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){crate::refuse!(BadRequest,"invalid panel runtime owner");}Ok(())
}
#[nolog] fn bounded<T>(items:&[T],label:&str)->Result<()>{if items.len()>ITEMS_MAX{crate::refuse!(BadRequest,"at most4096 {label} per request");}Ok(())}

/// Desktop-only runtime reports. The route requires the native desktop header.
#[nolog] pub async fn native(engine:&Arc<Engine>,org:&Arc<OrgHandle>,input:&Value)->Result<Value>{
    let request:Native=serde_json::from_value(input.clone()).map_err(|_|crate::domain::UserError::BadRequest("invalid native panel runtime request".into()))?;
    let registry=&engine.custom_apps.runtime;
    match request{
        Native::Heartbeat{owner,hosts}=>{
            owner_id(&owner)?;bounded(&hosts,"hosts")?;
            for h in &hosts{wire::text(&h.panel,120,"panel ID",false)?;if let Some(error)=&h.error{wire::text(error,500,"runtime error",false)?;}}
            let ids:Vec<String>=hosts.iter().map(|h|h.panel.clone()).collect();
            let client=engine.db.get().await?;
            let rows=client.query("SELECT id,app_id,run_generation FROM ot.custom_panels WHERE org_id=$1 AND id=ANY($2) AND is_running",&[&org.id,&ids]).await?;drop(client);
            let current:HashMap<String,(String,i64)>=rows.iter().map(|r|(r.get(0),(r.get(1),r.get(2)))).collect();
            let hosts:Vec<_>=hosts.into_iter().map(|h|(h.panel,h.generation,h.error)).collect();
            let stop=registry.heartbeat(org.id,&owner,&hosts,&current)?;
            Ok(json!({"lease_ms":LEASE.as_millis() as u64,"stop":stop,"sample_epoch":registry.sample_epoch()}))
        },
        Native::Release{owner,panels}=>{owner_id(&owner)?;bounded(&panels,"panels")?;registry.release(org.id,&owner,&panels)?;Ok(json!({"released":panels.len()}))},
        Native::Report{owner,epoch,samples}=>{
            owner_id(&owner)?;bounded(&samples,"samples")?;
            for s in &samples{
                if s.cpu_percent.is_some_and(|n|!n.is_finite()||!(0. ..=102_400.).contains(&n))||!CPU_METHODS.contains(&s.method.as_str()){crate::refuse!(BadRequest,"invalid panel CPU sample");}
            }
            Ok(json!({"reported":registry.report(org.id,&owner,epoch,&samples)?}))
        },
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn current(items:&[(&str,i64)])->HashMap<String,(String,i64)>{items.iter().map(|(p,g)|(p.to_string(),("app".to_string(),*g))).collect()}
    #[test] fn custom_apps_runtime_lease_is_owned_by_one_window_per_generation(){
        let r=Registry::default();let now=current(&[("clock",2)]);
        assert!(r.heartbeat(1,"window-one-0001",&[("clock".into(),2,None)],&now).unwrap().is_empty());
        assert_eq!(r.heartbeat(1,"window-two-0002",&[("clock".into(),2,None)],&now).unwrap(),vec!["clock"],"a second window must not run a duplicate copy");
        assert!(r.heartbeat(1,"window-one-0001",&[("clock".into(),2,None)],&now).unwrap().is_empty(),"the owner renews its own lease");
        assert_eq!(r.view(1,"clock",2).unwrap()["status"],"running");assert_eq!(r.view(2,"clock",2).unwrap()["status"],"not hosted","orgs never share runtime state");
    }
    #[test] fn custom_apps_runtime_stale_or_stopped_generations_are_told_to_stop(){
        let r=Registry::default();
        assert!(r.heartbeat(1,"window-one-0001",&[("clock".into(),2,None)],&current(&[("clock",2)])).unwrap().is_empty());
        assert_eq!(r.heartbeat(1,"window-one-0001",&[("clock".into(),2,None)],&current(&[("clock",3)])).unwrap(),vec!["clock"],"a restarted generation stops the old host");
        assert_eq!(r.view(1,"clock",2).unwrap()["status"],"not hosted");
        assert_eq!(r.heartbeat(1,"window-one-0001",&[("gone".into(),1,None)],&current(&[])).unwrap(),vec!["gone"],"a stopped or deleted panel stops its host");
        assert!(r.heartbeat(1,"window-two-0002",&[("clock".into(),3,None)],&current(&[("clock",3)])).unwrap().is_empty(),"a newer generation may move to another window");
    }
    #[test] fn custom_apps_runtime_reports_are_owner_generation_bound_and_revocable(){
        let r=Registry::default();r.heartbeat(1,"window-one-0001",&[("clock".into(),4,None)],&current(&[("clock",4)])).unwrap();
        let sample=|owner:&str,generation:i64|r.report(1,owner,1,&[Sample{panel:"clock".into(),generation,cpu_percent:Some(12.5),method:"sampled CPU".into()}]).unwrap();
        assert_eq!(sample("window-two-0002",4),0,"another window cannot report for this host");assert_eq!(sample("window-one-0001",3),0,"stale generations cannot report");
        assert_eq!(sample("window-one-0001",4),1);let v=r.view(1,"clock",4).unwrap();assert_eq!(v["cpu_percent"],12.5);assert_eq!(v["cpu_method"],"sampled CPU");
        r.revoke(1,Some("clock")).unwrap();assert_eq!(r.view(1,"clock",4).unwrap()["status"],"not hosted");
        r.heartbeat(1,"window-one-0001",&[("clock".into(),4,Some("The panel stopped responding.".into()))],&current(&[("clock",4)])).unwrap();assert_eq!(r.view(1,"clock",4).unwrap()["status"],"error");
        r.revoke_app(1,"app").unwrap();assert_eq!(r.view(1,"clock",4).unwrap()["status"],"not hosted");
    }
    #[test] fn custom_apps_runtime_native_vocabulary_is_explicit_and_bounded(){
        for bad in [json!({"action":"heartbeat","owner":"window-one-0001","hosts":[],"org":"other"}),json!({"action":"report","owner":"window-one-0001","samples":[{"panel":"p","generation":1,"cpu_percent":1.0,"method":"guess"}],"as_user":true}),json!({"action":"claim_grant","owner":"window-one-0001"})]{assert!(serde_json::from_value::<Native>(bad).is_err());}
        assert!(owner_id("short").is_err());assert!(owner_id("window one 0001").is_err());assert!(owner_id("window-one-0001").is_ok());
        assert!(bounded(&vec![0;ITEMS_MAX+1],"hosts").is_err());assert!(CPU_METHODS.contains(&"shared process CPU"));
    }
}
