//! Bounded optional picture work dispatched by the existing network pass. It
//! cannot hold up mail, and every external IO shares the org isolation gate.
use super::*;
use std::sync::atomic::{AtomicBool,Ordering};
use crate::profile_pictures::{self as p,wire::PictureRecord};
use futures::StreamExt;

type Key=(i64,String);
pub struct State {
    jobs:papaya::HashMap<Key,Arc<AtomicBool>>,
    ack:papaya::HashMap<Key,String>,
    tried:papaya::HashMap<Key,Instant>,
    supported:papaya::HashMap<String,(bool,Instant)>,
    slots:Arc<tokio::sync::Semaphore>,
}
impl Default for State {
    #[nolog]
    fn default()->Self {Self{jobs:Default::default(),ack:Default::default(),tried:Default::default(),supported:Default::default(),slots:Arc::new(tokio::sync::Semaphore::new(4))}}
}

#[nolog]
pub fn dispatch(engine:&Arc<Engine>,parts:&[Part]) {
    let state=&engine.net.pictures;
    let active:HashSet<Key>=parts.iter().flat_map(|p|p.hubs.iter().map(move|(_,addr)|(p.org_id,addr.clone()))).collect();
    for key in state.ack.pin().iter().map(|(k,_)|k).filter(|k|!active.contains(*k)).cloned().collect::<Vec<_>>() {state.ack.pin().remove(&key);}
    for key in state.tried.pin().iter().map(|(k,_)|k).filter(|k|!active.contains(*k)).cloned().collect::<Vec<_>>() {state.tried.pin().remove(&key);}
    let addresses:HashSet<&str>=active.iter().map(|(_,addr)|addr.as_str()).collect();
    for addr in state.supported.pin().iter().map(|(addr,_)|addr).filter(|addr|!addresses.contains(addr.as_str())).cloned().collect::<Vec<_>>() {state.supported.pin().remove(&addr);}
    for part in parts {
        for (hid,addr) in &part.hubs {
            if !part.registered.contains(hid) {continue;}
            let key=(part.org_id,addr.clone());
            if state.tried.pin().get(&key).is_some_and(|at|at.elapsed()<Duration::from_secs(10)) {continue;}
            let Ok(permit)=state.slots.clone().try_acquire_owned() else {return};
            let busy=state.jobs.pin().get_or_insert_with(key.clone(),||Arc::new(AtomicBool::new(false))).clone();
            if busy.swap(true,Ordering::AcqRel) {continue;}
            state.tried.pin().insert(key.clone(),Instant::now());
            let e=engine.clone();let part=part.clone();let hid=hid.clone();let addr=addr.clone();
            tokio::spawn(async move {
                tokio::select! {_=e.shutdown.cancelled()=>{},_=sync(&e,&part,&hid,&addr)=>{}}
                e.net.pictures.jobs.pin().remove(&key);
                drop(permit);
            });
        }
    }
}

#[nolog]
async fn member(engine:&Engine,part:&Part,hid:&str,addr:&str)->Result<()> {
    let c=engine.db.get().await?;
    let row=c.query_opt("SELECT net FROM ot.orgs WHERE id=$1 AND state='active'",&[&part.org_id]).await?;
    let Some(row)=row else {anyhow::bail!("organization departed")};
    let net:Value=row.get(0);
    anyhow::ensure!(net.pointer("/identity/slug").and_then(Value::as_str)==Some(part.net_slug.as_str()),"network identity changed");
    anyhow::ensure!(net["hubs"].as_array().is_some_and(|hs|hs.iter().any(|h|h["id"].as_str()==Some(hid)&&h["enabled"].as_bool().unwrap_or(true)&&discovery::known_address(h["address"].as_str().unwrap_or(""),net["state"][hid]["address"].as_str())==addr)),"hub disabled or changed");
    Ok(())
}

#[nolog]
async fn json_request(engine:&Engine,part:&Part,hid:&str,addr:&str,method:reqwest::Method,path:&str,body:Option<Value>)->Result<Value> {
    isolation::run(engine,&[part.org_id],async {
        member(engine,part,hid,addr).await?;
        let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(transport::DIRECT_CONNECT_TIMEOUT).no_proxy().build()?;
        let proxy=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(5)).build()?;
        let mut request=client.request(method,format!("{addr}{path}")).timeout(Duration::from_secs(10)).header("X-Org-Auth",part.auth());
        if path=="/api/profile-picture" && body.is_none() {request=request.query(&[("slug",part.net_slug.as_str())]);}
        if let Some(body)=body {request=request.json(&body);}
        let response=transport::send_with_proxy(request,&proxy).await?;
        anyhow::ensure!(response.status().is_success(),"picture HTTP request failed");
        anyhow::ensure!(response.content_length().is_none_or(|n|n<=p::wire::MAX_WIRE_BYTES as u64),"picture response exceeds limit");
        let mut bytes=Vec::new();let mut stream=response.bytes_stream();
        while let Some(chunk)=stream.next().await {let chunk=chunk?;anyhow::ensure!(bytes.len()+chunk.len()<=p::wire::MAX_WIRE_BYTES,"picture response exceeds limit");bytes.extend_from_slice(&chunk);}
        serde_json::from_slice(&bytes).map_err(Into::into)
    }).await
}

#[nolog]
async fn merge(engine:&Engine,part:&Part,hid:&str,addr:&str,value:&Value)->Result<()> {
    if value["picture"].is_null() {return Ok(());}
    let record:PictureRecord=serde_json::from_value(value["picture"].clone())?;
    record.decoded()?;
    let _guard=isolation::local(engine,part.org_id).await?;
    member(engine,part,hid,addr).await?;
    p::save(engine,part.org_id,record,false).await?;
    Ok(())
}

#[nolog]
async fn sync(engine:&Engine,part:&Part,hid:&str,addr:&str)->Result<()> {
    let state=&engine.net.pictures;let key=(part.org_id,addr.to_owned());
    let local=p::load(engine,part.org_id).await?;
    let ack=state.ack.pin().get(&key).cloned();
    let remote=engine.net.rosters.pin().get(addr).and_then(|rows|rows.iter().find(|r|r["slug"].as_str()==Some(&part.net_slug)).and_then(|r|r["picture"]["revision"].as_str()).map(str::to_owned));
    if local.is_none() && ack.as_deref()==Some("") && remote.is_none() {return Ok(());}
    if let Some(local)=&local {if ack.as_deref()==Some(local.meta.revision.as_str())&&remote.as_deref().is_none_or(|r|r<=local.meta.revision.as_str()) {return Ok(());}}
    let cached=state.supported.pin().get(addr).cloned().filter(|(_,at)|at.elapsed()<Duration::from_secs(300));
    let supported=if let Some((yes,_))=cached {yes} else {
        let health=json_request(engine,part,hid,addr,reqwest::Method::GET,"/healthz",None).await?;
        let yes=health["features"].as_array().is_some_and(|fs|fs.iter().any(|f|f=="profile_pictures"));
        state.supported.pin().insert(addr.to_owned(),(yes,Instant::now()));yes
    };
    if !supported {return Ok(());}
    let remote=json_request(engine,part,hid,addr,reqwest::Method::GET,"/api/profile-picture",None).await?;
    merge(engine,part,hid,addr,&remote).await?;
    let Some(local)=p::load(engine,part.org_id).await? else {state.ack.pin().insert(key,String::new());return Ok(());};
    let answer=json_request(engine,part,hid,addr,reqwest::Method::POST,"/api/profile-picture",Some(json!({"slug":part.net_slug,"picture":local}))).await?;
    merge(engine,part,hid,addr,&answer).await?;
    if let Some(revision)=answer["picture"]["revision"].as_str() {state.ack.pin().insert(key,revision.to_owned());}
    Ok(())
}
