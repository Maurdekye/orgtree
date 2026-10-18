//! Pure, sanitized usage transitions; no I/O or provider documents.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

#[nolog]
pub(super) fn evaluate(state: &mut Value, rows: &[Value], config: &Value, now: DateTime<Utc>) -> Vec<Value> {
    let initialized=state["initialized"]==true;
    let mut accounts=json!({});let mut out=Vec::new();
    let threshold=config["threshold_percent"].as_f64();
    for incoming in rows {
        let mut current_row=incoming.clone();
        let id=incoming["account"].as_str().unwrap_or("");
        let old=&state["accounts"][id];
        let stamp=|v:&Value|v["observed_at"].as_str().and_then(crate::util::parse_ts);
        if matches!((stamp(old),stamp(incoming)),(Some(o),Some(n)) if o>n) && old["row"].is_object() {current_row=old["row"].clone();}
        if stamp(&current_row).is_some_and(|t|now-t>=chrono::Duration::seconds(900)) {
            current_row["freshness"]=json!("stale");current_row["available"]=json!(false);
        }
        let row=&current_row;
        let Some(id)=row["account"].as_str() else {continue};
        if !selected(config,"accounts",id){continue;}
        let old=&state["accounts"][id];
        let status=if row["freshness"]=="stale" {"stale"} else if row["available"]!=true {"unreadable"} else {"ok"};
        let mut next=if old.is_object(){old.clone()}else{json!({"windows":{}})};
        if initialized && old.is_null(){out.push(event("account_added",row,&Value::Null,None,None,threshold));}
        let windows=row["windows"].as_array().cloned().unwrap_or_default();
        let status_changed=old.is_object() && old["status"]!=status;
        let status_event=if status=="ok" {"recovered"}else{status};
        if status_changed && next["windows"].as_object().is_none_or(|w|w.is_empty()) && config.get("windows").is_none() {
            out.push(event(status_event,row,&Value::Null,None,None,threshold));
        }
        // Retain last known numbers through unavailable/stale/missing windows.
        // The reset clock is informational; it never creates a zero reading.
        if let Some(saved)=next["windows"].as_object_mut() {for (_,w) in saved {
            if status_changed {out.push(event(status_event,row,w,w["used_percent"].as_f64(),None,threshold));}
            if status=="ok" && !windows.iter().any(|v|["kind","group","model"].iter().all(|k|v[*k]==w[*k])) && w["unknown"]!=true {
                out.push(event("unreadable",row,w,w["baseline"].as_f64(),None,threshold));w["unknown"]=json!(true);
            }
            if w["expired"]!=true && w["resets_at"].as_str().and_then(crate::util::parse_ts).is_some_and(|t|t<=now) {
                out.push(event("reset",row,w,w["used_percent"].as_f64(),None,threshold));w["expired"]=json!(true);
                w["baseline"]=Value::Null;
            }
        }}
        if status=="ok" {for window in windows {
            if !window_selected(config,&window){continue;}
            let key=serde_json::to_string(&json!([window["kind"],window["group"],window["model"]])).unwrap_or_default();
            let previous=&next["windows"][&key];
            let current=window["used_percent"].as_f64().filter(|p|p.is_finite() && *p>=0.);
            let old_pct=previous["baseline"].as_f64();
            if status_changed && !previous.is_object() && current.is_some() {out.push(event("recovered",row,&window,None,current,threshold));}
            if current.is_none() {
                if previous.is_object() && previous["unknown"]!=true {out.push(event("unreadable",row,&window,old_pct,None,threshold));}
                let mut saved=if previous.is_object(){previous.clone()}else{window.clone()};saved["unknown"]=json!(true);
                next["windows"][&key]=saved;continue;
            }
            if previous["unknown"]==true {out.push(event("recovered",row,&window,old_pct,current,threshold));}
            let new_reset=window["resets_at"].as_str().and_then(crate::util::parse_ts);
            let old_reset=previous["resets_at"].as_str().and_then(crate::util::parse_ts);
            let expired=new_reset.is_some_and(|t|t<=now);
            let moved=matches!((old_reset,new_reset),(Some(o),Some(n)) if n>o+chrono::Duration::minutes(5));
            let dropped=matches!((old_pct,current),(Some(o),Some(n)) if n<o);
            let reset=previous.is_object() && !expired && (moved||dropped);
            if reset {out.push(event("reset",row,&window,old_pct,current,threshold));}
            if !expired {if let Some(n)=current {
                let rearmed=moved || previous["expired"]==true;
                if let Some(t)=threshold {
                    if (old_pct.is_some_and(|o|o<t)||rearmed) && n>=t {out.push(event("above",row,&window,old_pct,Some(n),Some(t)));}
                    if old_pct.is_some_and(|o|o>=t) && n<t {out.push(event("below",row,&window,old_pct,Some(n),Some(t)));}
                }
                if (old_pct.is_some_and(|o|o<100.)||rearmed) && n>=100. {out.push(event("limit",row,&window,old_pct,Some(n),Some(100.)));}
            }}
            let mut saved=window.clone();saved["expired"]=json!(expired);
            saved["baseline"]=if expired {Value::Null}else{json!(current)};
            next["windows"][&key]=saved;
        }}
        next["status"]=json!(status);next["observed_at"]=row["observed_at"].clone();next["row"]=row.clone();
        accounts[id]=next;
    }
    if initialized {if let Some(old)=state["accounts"].as_object(){for (id,prev) in old {
        if accounts.get(id).is_none() && selected(config,"accounts",id) {
            out.push(event("account_removed",&json!({"account":id,"observed_at":prev["observed_at"]}),&Value::Null,None,None,threshold));
        }
    }}}
    state["accounts"]=accounts;state["initialized"]=json!(true);
    out.retain(|e|selected(config,"usage_events",e["event"].as_str().unwrap_or("")));
    out
}

#[nolog]
pub(super) fn selected(config:&Value,key:&str,value:&str)->bool {
    config.get(key).is_none_or(|v|v.as_array().is_some_and(|a|a.iter().any(|s|s.as_str()==Some(value))))
}

#[nolog]
fn window_selected(config:&Value,w:&Value)->bool {
    config.get("windows").is_none_or(|v|v.as_array().is_some_and(|a|a.iter().any(|s|
        ["kind","group","label"].iter().any(|k|w[*k].as_str().is_some() && w[*k]==*s))))
}

#[nolog]
fn event(name:&str,row:&Value,w:&Value,old:Option<f64>,new:Option<f64>,threshold:Option<f64>)->Value {
    json!({"event":name,"account":row["account"],"window":w["kind"],"group":w["group"],"model":w["model"],
        "old_percent":old,"new_percent":new,"threshold_percent":threshold,"resets_at":w["resets_at"],"observed_at":row["observed_at"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn now() -> DateTime<Utc> { DateTime::from_timestamp(1_900_000_000, 0).unwrap() }
    fn row(p: f64) -> Value { json!({"account":"claude-5","provider":"claude","available":true,"freshness":"fresh",
        "observed_at":crate::util::iso(now()),"windows":[{"kind":"weekly","group":"all","used_percent":p,
        "resets_at":crate::util::iso(now()+chrono::Duration::hours(1))}]}) }
    fn cfg() -> Value { json!({"threshold_percent":98}) }
    fn names(v: &[Value]) -> Vec<&str> { v.iter().filter_map(|v|v["event"].as_str()).collect() }
    #[test]
    fn usage_crossings_are_edges_and_rearm_below() {
        let mut s=json!({}); let c=cfg();
        assert!(evaluate(&mut s,&[row(97.)],&c,now()).is_empty());
        assert!(names(&evaluate(&mut s,&[row(98.)],&c,now())).contains(&"above"));
        assert!(evaluate(&mut s,&[row(99.)],&c,now()).is_empty());
        assert!(names(&evaluate(&mut s,&[row(97.)],&c,now())).contains(&"below"));
        assert!(names(&evaluate(&mut s,&[row(99.)],&c,now())).contains(&"above"));
    }
    #[test]
    fn usage_unknown_is_not_zero_and_recovery_preserves_baseline() {
        let mut s=json!({}); let c=cfg(); evaluate(&mut s,&[row(99.)],&c,now());
        let mut bad=row(0.); bad["available"]=json!(false);bad["freshness"]=json!("stale");
        assert_eq!(names(&evaluate(&mut s,&[bad.clone()],&c,now())),vec!["stale"]);
        assert!(evaluate(&mut s,&[bad],&c,now()).is_empty());
        let events=evaluate(&mut s,&[row(99.)],&c,now());
        assert_eq!(names(&events),vec!["recovered"]);
        assert_eq!(events[0]["old_percent"],json!(99.));
    }
    #[test]
    fn usage_reset_rearms_without_manufacturing_a_zero() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(99.)],&c,now());
        assert!(names(&evaluate(&mut s,&[row(1.)],&c,now())).contains(&"reset"));
        assert!(names(&evaluate(&mut s,&[row(99.)],&c,now())).contains(&"above"));
        let later=now()+chrono::Duration::hours(1);
        assert_eq!(names(&evaluate(&mut s,&[row(99.)],&c,later)).iter().filter(|n|**n=="reset").count(),1);
        assert!(evaluate(&mut s,&[row(99.)],&c,later).is_empty());
    }
    #[test]
    fn usage_filters_and_spend_cap_share_percent_semantics() {
        let mut s=json!({});let c=json!({"accounts":["claude-5"],"windows":["all"],"usage_events":["limit"],"threshold_percent":98});
        evaluate(&mut s,&[row(97.)],&c,now());
        let out=evaluate(&mut s,&[row(100.)],&c,now());assert_eq!(names(&out),vec!["limit"]);
        assert_eq!(out[0]["account"],"claude-5");assert_eq!(out[0]["old_percent"],97.);
        assert_eq!(out[0]["new_percent"],100.);assert!(out[0]["observed_at"].is_string());
        let mut r=row(100.);r["account"]=json!("hidden");assert!(!evaluate(&mut s,&[r],&c,now()).iter().any(|e|e["account"]=="hidden"));
    }
    #[test]
    fn usage_account_lifecycle_is_once_per_change() {
        let mut s=json!({});let c=json!({});evaluate(&mut s,&[],&c,now());
        assert_eq!(names(&evaluate(&mut s,&[row(1.)],&c,now())),vec!["account_added"]);
        assert_eq!(names(&evaluate(&mut s,&[],&c,now())),vec!["account_removed"]);
        assert!(evaluate(&mut s,&[],&c,now()).is_empty());
    }
    #[test]
    fn usage_unreadable_recovered_and_persisted_edges() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(97.)],&c,now());
        let mut bad=row(1.);bad["available"]=json!(false);bad["reason"]=json!("failed");
        assert_eq!(names(&evaluate(&mut s,&[bad],&c,now())),vec!["unreadable"]);
        assert!(names(&evaluate(&mut s,&[row(99.)],&c,now())).contains(&"above"));
        let mut restored:Value=serde_json::from_str(&s.to_string()).unwrap();
        assert!(evaluate(&mut restored,&[row(99.)],&c,now()).is_empty());
    }
    #[test]
    fn usage_missing_window_percent_retains_the_comparison_baseline() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(97.)],&c,now());
        let mut bad=row(0.);bad["windows"][0]["used_percent"]=Value::Null;
        assert_eq!(names(&evaluate(&mut s,&[bad.clone()],&c,now())),vec!["unreadable"]);
        assert!(evaluate(&mut s,&[bad],&c,now()).is_empty());
        assert_eq!(names(&evaluate(&mut s,&[row(99.)],&c,now())),vec!["recovered","above"]);
    }
    #[test]
    fn usage_new_window_epoch_rearms_a_high_value() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(99.)],&c,now());
        let mut next=row(99.);next["windows"][0]["resets_at"]=json!(crate::util::iso(now()+chrono::Duration::hours(2)));
        assert_eq!(names(&evaluate(&mut s,&[next.clone()],&c,now())),vec!["reset","above"]);
        assert!(evaluate(&mut s,&[next],&c,now()).is_empty());
    }
    #[test]
    fn usage_old_observation_does_not_rewind_a_crossing() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(97.)],&c,now());
        let mut new=row(99.);new["observed_at"]=json!(crate::util::iso(now()+chrono::Duration::seconds(1)));
        assert!(names(&evaluate(&mut s,&[new],&c,now()+chrono::Duration::seconds(1))).contains(&"above"));
        assert!(evaluate(&mut s,&[row(97.)],&c,now()+chrono::Duration::seconds(2)).is_empty());
    }
    #[test]
    fn usage_spend_cap_uses_reported_percent_and_never_an_unreported_balance() {
        let mut s=json!({});let c=json!({"usage_events":["above","limit"],"threshold_percent":98});
        let spend=|p|{let mut r=row(p);r["account"]=json!("openrouter-2");r["provider"]=json!("openrouter");r["windows"][0]["kind"]=json!("spend");r};
        evaluate(&mut s,&[spend(97.)],&c,now());
        assert_eq!(names(&evaluate(&mut s,&[spend(100.)],&c,now())),vec!["above","limit"]);
    }
    #[test]
    fn usage_recovery_after_no_cache_respects_a_window_filter() {
        let mut s=json!({});let c=json!({"windows":["weekly"],"usage_events":["recovered"]});
        let mut no=row(0.);no["available"]=json!(false);no["windows"]=json!([]);
        evaluate(&mut s,&[no],&c,now());
        let out=evaluate(&mut s,&[row(97.)],&c,now());assert_eq!(names(&out),vec!["recovered"]);assert_eq!(out[0]["window"],"weekly");
    }
    #[test]
    fn usage_missing_window_is_unreadable_once_then_recovers() {
        let mut s=json!({});let c=cfg();evaluate(&mut s,&[row(97.)],&c,now());
        let mut no=row(0.);no["windows"]=json!([]);
        assert_eq!(names(&evaluate(&mut s,&[no.clone()],&c,now())),vec!["unreadable"]);
        assert!(evaluate(&mut s,&[no],&c,now()).is_empty());
        assert_eq!(names(&evaluate(&mut s,&[row(99.)],&c,now())),vec!["recovered","above"]);
    }
}
