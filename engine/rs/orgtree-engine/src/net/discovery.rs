//! Direct hub discovery shared by Test and registration. Explicit addresses
//! stay explicit; a bare host follows Hubchat's known ports and HTTPS.
use super::*;

#[nolog]
pub(super) fn candidates(input:&str)->Vec<String> {
    let typed=input.trim().trim_end_matches('/');
    if typed.is_empty(){return vec![DEFAULT_HUB_ADDRESS.to_owned()];}
    let single=normalize_address(typed);
    if typed.contains("://")||has_port(typed)||typed.contains(['/', '?', '#']) {return vec![single];}
    let Ok(base)=reqwest::Url::parse(&format!("http://{typed}")) else{return vec![single]};
    if base.host_str().is_none()||!base.username().is_empty()||base.password().is_some(){return vec![single];}
    let mut out=Vec::new();
    for port in [DEFAULT_HUB_PORT,7378,7371] {
        let mut url=base.clone();let _=url.set_port(Some(port));
        out.push(url.to_string().trim_end_matches('/').to_owned());
    }
    let mut tls=base;let _=tls.set_scheme("https");let _=tls.set_port(None);
    out.push(tls.to_string().trim_end_matches('/').to_owned());out
}

#[nolog]
pub(super) fn has_port(input:&str)->bool {
    let rest=input.split_once("://").map_or(input,|(_,rest)|rest);
    let authority=rest.split(['/', '?', '#']).next().unwrap_or("");
    authority.rsplit_once(':').is_some_and(|(host,port)|!port.is_empty()
        &&port.bytes().all(|b|b.is_ascii_digit())&&!host.ends_with(':'))
}

/// A registration is reusable only within the current configured candidates.
#[nolog]
pub(super) fn known_address(input:&str,registered:Option<&str>)->String {
    let addresses=candidates(input);
    registered.filter(|known|addresses.iter().any(|a|a==*known))
        .map(str::to_owned).unwrap_or_else(||addresses[0].clone())
}

#[nolog]
pub(super) async fn for_connection(engine:&Engine,org:i64,id:&str,input:&str,registered:Option<&str>)->String {
    let mut addresses=candidates(input);
    let fallback=known_address(input,registered);
    // As elsewhere in net, synthetic rigs may reach only their hosted hub.
    if crate::rig::active() {
        let hosted=engine.hub.address.load_full();
        addresses.retain(|a|crate::rig::hub()&&hosted.as_deref()==Some(a));
        return addresses.into_iter().next().unwrap_or(fallback);
    }
    let connected=engine.net.status.pin().get(&(org,id.to_owned())).is_some_and(|s|s.connected);
    let registered_here=registered.is_some_and(|known|addresses.iter().any(|a|a==known));
    if addresses.len()==1||(connected&&registered_here)||offline()||backed_off(engine,&fallback){return fallback;}
    // Discovery is read-only, but still belongs to this org's cancellation
    // gate. Turning its inbox off must stop these requests as well.
    isolation::run(engine,&[org],async {Ok(probe_many(addresses,Duration::from_secs(2)).await)}).await
        .ok().flatten().map(|(address,_)|address).unwrap_or(fallback)
}

#[nolog]
pub(super) async fn probe_many(addresses:Vec<String>,limit:Duration)->Option<(String,Value)> {
    let mut pending=tokio::task::JoinSet::new();
    for (index,address) in addresses.into_iter().enumerate() {
        pending.spawn(async move {
            crate::mailhub::healthz(&address,limit).await
                .filter(|h|h["ok"]==true).map(|health|(index,address,health))
        });
    }
    let mut best:Option<(usize,String,Value)>=None;
    let mut deadline=None;
    loop {
        let next=match deadline {
            Some(at)=>match tokio::time::timeout_at(at,pending.join_next()).await {Ok(next)=>next,Err(_)=>break},
            None=>pending.join_next().await,
        };
        let Some(next)=next else {break};
        if let Ok(Some(found))=next {
            if best.as_ref().is_none_or(|current|found.0<current.0){best=Some(found);}
            if best.as_ref().is_some_and(|current|current.0==0){break;}
            deadline.get_or_insert_with(||tokio::time::Instant::now()+Duration::from_millis(750));
        }
    }
    // Dropping the JoinSet cancels all losing requests; a dropped port cannot
    // hold up a working result for the full timeout.
    best.map(|(_,address,health)|(address,health))
}
