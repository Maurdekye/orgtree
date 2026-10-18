//! Usage dogs consume sanitized readings and existing scoped refusal events.
//! The clock checks cache age/reset deadlines only; it never probes a provider.
use super::*;
use tokio::sync::mpsc::Receiver;

pub const EVENTS: &[&str]=&["above","below","reset","limit","stale","unreadable","recovered","account_added","account_removed","refused","frozen"];

#[logged]
pub(super) fn validate(args:&Value)->Result<Value> {
    if args["fire_mode"]=="silence" || args.get("quiet_period_s").is_some_and(|v|!v.is_null()) || args.get("pattern").is_some_and(|v|!v.is_null() && v!="") {
        refuse!(BadRequest,"usage watches edges; silence/quiet_period_s/pattern do not apply");
    }
    let mut config=json!({});
    for key in ["accounts","windows","usage_events"] {
        if let Some(v)=args.get(key) {
            let Some(a)=v.as_array().filter(|a|!a.is_empty() && a.len()<=32) else {refuse!(BadRequest,"{key} needs 1 through 32 exact identifiers");};
            if a.iter().any(|s|s.as_str().is_none_or(|s|s.is_empty() || s.len()>256)){refuse!(BadRequest,"{key} needs nonempty strings, at most 256 bytes");}
            if key=="usage_events" && a.iter().any(|s|!EVENTS.contains(&s.as_str().unwrap_or(""))){refuse!(BadRequest,"unknown usage event; see usage watchdog guide");}
            config[key]=v.clone();
        }
    }
    if let Some(v)=args.get("threshold_percent") {
        if v.as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=100.0).contains(&n)){refuse!(BadRequest,"threshold_percent must be a number from 0 through 100");}
        config["threshold_percent"]=v.clone();
    }
    if config["usage_events"].as_array().is_some_and(|a|a.iter().any(|s|s=="above" || s=="below")) && config.get("threshold_percent").is_none() {
        refuse!(BadRequest,"above/below usage events require threshold_percent");
    }
    Ok(config)
}

/// Called beside existing history storage. Raw provider documents are never
/// invocation-logged or copied into an event; only the quota allowlist leaves.
#[nolog]
pub fn reading(engine:&Engine,account:&str,provider:&str,observed:DateTime<Utc>,raw:&Value) {
    if !events::interested(engine,"usage.reading"){return;}
    let view=engine.accounts.view();
    let origin=if let Some(a)=view.get(account){a.origin_org.clone()}
        else if ["claude/primary","openai/primary","google/primary","muse/primary"].contains(&account){None}
        else{return;};
    let mut row=crate::usage::query::reading(Some(raw),Some(observed),Utc::now());
    row["account"]=json!(account);row["provider"]=json!(provider);
    events::emit(engine,events::event("usage.reading",events::Scope::Account(origin),json!({"account":account,"reading":row})));
}

#[nolog]
fn permitted(engine:&Engine,org:&str,id:&str)->bool {
    crate::org_accounts::allowed(Some(org),id) && engine.accounts.view().get(id).is_none_or(|a|a.available_origin(org))
}

#[logged]
pub(super) async fn run(engine:&Arc<Engine>,dog:Dog,sub:&events::Subscription,mut rx:Receiver<events::Event>,cancel:&CancellationToken)->Result<()> {
    // Scope filters run before evaluation. Account lifecycle/clock transitions
    // use the cache-only 15s sweep, not a subscription to every runtime update.
    sub.target.store(Some(Arc::new("usage.*".into())));
    let mut batch=Vec::new();let mut first=true;
    loop {
        if !first {tokio::select! {
            e=rx.recv()=>{let Some(e)=e else{return Ok(())};batch.push(e);},
            _=tokio::time::sleep(Duration::from_secs(15))=>{},
            _=cancel.cancelled()=>return Ok(()),
        }}
        first=false;
        while batch.len()<256 {match rx.try_recv(){Ok(e)=>batch.push(e),Err(_)=>break}}
        if let Some(e)=sub.overflow.swap(None){batch.push((*e).clone());}
        let Some(mut d)=load(engine,dog.row).await? else{return Ok(())};
        if d.state!="armed" || !d.owner_live{return Ok(())}
        let org=engine.orgs.by_id(d.org_id).map(|o|o.slug.clone()).unwrap_or_default();
        let config=d.memo["usage"].clone();
        let mut state=d.run["usage"].clone();if !state.is_object(){state=json!({});}
        let mut pending=d.run["usage_pending"].as_array().cloned().unwrap_or_default();
        if d.run["usage_pending_fired"].as_i64().is_some_and(|n|d.fired>n){pending.clear();}
        let mut rows=crate::tools::usage::watchdog_rows(engine,&org);
        let needs_access=batch.iter().any(|e|matches!(e.scope,events::Scope::Agent(..))) || pending.iter().any(|e|e["agent_id"].is_i64());
        let access=if needs_access{Some(events::Access::read(engine,&d,&batch).await?)}else{None};
        for e in &batch {
            let visible=match &e.scope {
                events::Scope::Account(origin)=>origin.as_ref().is_none_or(|s|s==&org),
                _=>access.as_ref().is_some_and(|a|a.sees(e)),
            };
            if !visible{continue;}
            if e.name=="usage.reading" {
                let row=&e.payload["reading"];
                if let Some(index)=rows.iter().position(|r|r["account"]==row["account"]) {
                    // Process every observation, preserving intermediate crossings
                    // rather than reducing a burst to its last value.
                    rows[index]=row.clone();
                    pending.extend(usage_eval::evaluate(&mut state,&rows,&config,Utc::now()));
                }
            }else if matches!(e.name.as_str(),"usage.refused"|"usage.frozen") {
                let id=e.payload["account"].as_str().unwrap_or("");
                let kind=e.name.strip_prefix("usage.").unwrap_or("");
                if rows.iter().any(|r|r["account"]==id) && usage_eval::selected(&config,"accounts",id)
                    && usage_eval::selected(&config,"usage_events",kind)
                    && (config.get("windows").is_none() || config["windows"].as_array().is_some_and(|a|a.contains(&e.payload["window"]))) {
                    let mut line=e.payload.clone();line["event"]=json!(kind);pending.push(line);
                }
            }
        }
        pending.extend(usage_eval::evaluate(&mut state,&rows,&config,Utc::now()));
        // Revalidate scope on every wake and before delivery. Revoked lanes are
        // silently forgotten, not reported as removed. Real removals stay visible.
        pending.retain(|e|e["account"].as_str().is_some_and(|id|permitted(engine,&org,id))
            && e["agent_id"].as_i64().is_none_or(|id|access.as_ref().is_some_and(|a|a.sees(&events::event("usage.refused",events::Scope::Agent(d.org_id,id),e.clone())))));
        pending.truncate(40);
        d.run["usage"]=state;d.run["usage_pending"]=json!(pending);d.run["usage_pending_fired"]=json!(d.fired);
        if let Some(last)=pending.last(){d.run["last_output"]=json!(tail(&last.to_string(),OUT_KEEP));}
        save_run(engine,&mut d,false).await?;
        if !pending.is_empty() && d.last_fired.is_none_or(|t|Utc::now()>=t+chrono::Duration::seconds(d.interval_s.max(5))) {
            let lines=pending.iter().map(Value::to_string).collect::<Vec<_>>();
            if fire(engine,&mut d,&lines," USAGE —").await?{return Ok(())}
            d.run["usage_pending"]=json!([]);save_run(engine,&mut d,false).await?;
        }
        batch.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_config_rejects_ambiguous_filters_and_supports_exact_ids() {
        assert!(validate(&json!({"accounts":[]})).is_err());
        assert!(validate(&json!({"usage_events":["above"]})).is_err());
        assert!(validate(&json!({"threshold_percent":101})).is_err());
        assert!(validate(&json!({"fire_mode":"silence"})).is_err());
        assert!(validate(&json!({"usage_events":["tick"]})).is_err());
        let v=json!({"accounts":["claude-5"],"windows":["weekly"],"usage_events":["above"],"threshold_percent":98});
        assert_eq!(validate(&v).unwrap(),v);
    }
}
