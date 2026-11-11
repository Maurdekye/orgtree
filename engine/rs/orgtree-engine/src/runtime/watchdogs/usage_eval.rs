//! Pure, sanitized usage transitions; no I/O or provider documents.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

/// Creation-only level snapshot. Existing runners continue to evaluate edges.
#[nolog]
pub(super) fn initial(state: &mut Value, rows: &[Value], config: &Value, now: DateTime<Utc>) -> Vec<Value> {
    evaluate(state, rows, config, now);
    let mut out=Vec::new();let threshold=config["threshold_percent"].as_f64();
    for saved in state["accounts"].as_object().into_iter().flat_map(|a|a.values()) {
        let row=&saved["row"];
        let windows:Vec<&Value>=row["windows"].as_array().into_iter().flatten().filter(|w|window_selected(config,w)).collect();
        let status=saved["status"].as_str().unwrap_or("unreadable");
        if status!="ok" {
            if windows.is_empty() && config.get("windows").is_none() {out.push(event(status,row,&Value::Null,None,None,threshold));}
            for w in windows {out.push(event(status,row,w,None,None,threshold));}
            continue;
        }
        if windows.is_empty() && config.get("windows").is_none() {out.push(event("unreadable",row,&Value::Null,None,None,threshold));}
        for w in windows {
            let pct=w["used_percent"].as_f64().filter(|p|p.is_finite() && *p>=0.);
            let expired=w["resets_at"].as_str().and_then(crate::util::parse_ts).is_some_and(|t|t<=now);
            if let Some(n)=pct.filter(|_|!expired) {
                if let Some(t)=threshold {out.push(event(if n>=t{"above"}else{"below"},row,w,None,Some(n),Some(t)));}
                if n>=100. {out.push(event("limit",row,w,None,Some(n),Some(100.)));}
            } else {out.push(event("unreadable",row,w,None,None,threshold));}
        }
    }
    // a pip dog's creation levels: met now is a `pip_reached` level, known and not met a `pip_cleared` one (the
    // retain below drops the one that was not selected); an unknown pip says nothing
    if let Some(offset)=pip_offset(config) {
        for saved in state["accounts"].as_object().into_iter().flat_map(|a|a.values()) {
            let row=&saved["row"];
            let Some(r)=crate::usage::fable_pip::pip_percent(row,now) else {continue};
            match saved["pip"]["met"].as_bool() {
                Some(true)=>out.push(pip_event("pip_reached",row,&r,offset,None)),
                Some(false)=>out.push(pip_event("pip_cleared",row,&r,offset,None)),
                None=>{}
            }
        }
    }
    out.retain(|e|selected(config,"usage_events",e["event"].as_str().unwrap_or("")));
    out.truncate(40);out
}

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
        // a pip dog reads Claude rows only: others neither add nor remove an account
        if pip_offset(config).is_some() && row["provider"]!="claude" {continue;}
        let old=&state["accounts"][id];
        let status=if row["freshness"]=="stale" {"stale"} else if row["available"]!=true {"unreadable"} else {"ok"};
        let mut next=if old.is_object(){old.clone()}else{json!({"windows":{}})};
        if initialized && old.is_null(){out.push(event("account_added",row,&Value::Null,None,None,threshold));}
        let windows=row["windows"].as_array().cloned().unwrap_or_default();
        let status_changed=old.is_object() && old["status"]!=status;
        let status_event=if status=="ok" {"recovered"}else{status};
        if status_changed && next["windows"].as_object().is_none_or(|w|w.is_empty()) && config.get("windows").is_none()
            && (status!="ok" || !windows.iter().any(|w|window_selected(config,w) && w["used_percent"].as_f64().is_some())) {
            out.push(event(status_event,row,&Value::Null,None,None,threshold));
        }
        // Retain last known numbers through unavailable/stale/missing windows.
        // The reset clock is informational; it never creates a zero reading.
        if let Some(saved)=next["windows"].as_object_mut() {for (_,w) in saved {
            let matching=windows.iter().find(|v|["kind","group","model"].iter().all(|k|v[*k]==w[*k]));
            let new_percent=matching.and_then(|w|w["used_percent"].as_f64());
            if status_changed && (status!="ok" || new_percent.is_some()) {out.push(event(status_event,row,matching.unwrap_or(w),w["used_percent"].as_f64(),if status=="ok"{new_percent}else{None},threshold));}
            if status=="ok" && matching.is_none() && w["unknown"]!=true {
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
            if previous["unknown"]==true && !status_changed {out.push(event("recovered",row,&window,old_pct,current,threshold));}
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
        if let Some(offset)=pip_offset(config) {pip_step(&mut next,row,offset,now,&mut out);}
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
    // a pip dog reads the weekly (all models) and the Fable weekly windows itself
    if pip_offset(config).is_some() && !(w["kind"]=="weekly_all" || crate::usage::fable_pip::is_fable_weekly("claude",w)) {return false;}
    config.get("windows").is_none_or(|v|v.as_array().is_some_and(|a|a.iter().any(|s|
        ["kind","group","label"].iter().any(|k|w[*k].as_str().is_some() && w[*k]==*s))))
}

/// The pip dog's offset in points, when the config is in pip mode.
#[nolog]
fn pip_offset(config:&Value)->Option<f64> {config["fable_pip_offset"].as_f64()}

/// A number as the summaries show it: at most one decimal, a trailing `.0` dropped.
#[nolog]
fn num(x:f64)->String {let s=format!("{x:.1}");s.strip_suffix(".0").map(str::to_string).unwrap_or(s)}

#[nolog]
fn round2(x:f64)->f64 {(x*100.0).round()/100.0}

/// One pip crossing for one account. Unknown readings change nothing (they neither fire nor re-arm); a known one
/// fires on not-met-or-unknown to met, and on met to not met, then stores both for the next reading.
#[nolog]
fn pip_step(next:&mut Value,row:&Value,offset:f64,now:DateTime<Utc>,out:&mut Vec<Value>) {
    let Some(r)=crate::usage::fable_pip::pip_percent(row,now) else {
        if !next["pip"].is_object() {next["pip"]=json!({"met":null,"weekly":null});}
        return;
    };
    let met=r.weekly>=r.pip+offset-1e-9;
    let was_met=next["pip"]["met"]==true;
    let old=next["pip"]["weekly"].as_f64();
    if met && !was_met {out.push(pip_event("pip_reached",row,&r,offset,old));}
    else if !met && was_met {out.push(pip_event("pip_cleared",row,&r,offset,old));}
    next["pip"]=json!({"met":met,"weekly":r.weekly});
}

#[nolog]
fn pip_event(name:&str,row:&Value,r:&crate::usage::fable_pip::PipReading,offset:f64,old:Option<f64>)->Value {
    let account=row["account"].as_str().unwrap_or("");
    let target=r.pip+offset;
    let weekly=row["windows"].as_array().into_iter().flatten().find(|w|w["kind"]=="weekly_all").cloned().unwrap_or(Value::Null);
    let d=r.weekly-r.pip;
    let summary=if name=="pip_cleared" {
        format!("{account} weekly {}% is back below {}% (Fable pip at {}%, Fable {}% used)",num(r.weekly),num(target),num(r.pip),num(r.fable))
    } else {
        let n=num(d.abs());
        let place=if d.abs()<=1e-9 {"at the Fable pip".to_string()}
            else {format!("{n} point{} {} the Fable pip",if n=="1"{""}else{"s"},if d<0.0{"before"}else{"past"})};
        let at=if offset==0.0 {"pip".to_string()} else {format!("pip {}{}",if offset>0.0{"+"}else{"-"},num(offset.abs()))};
        format!("{account} weekly {}% is {place} at {}% (Fable {}% used; fires at {at} = {}%)",num(r.weekly),num(r.pip),num(r.fable),num(target))
    };
    json!({"event":name,"account":row["account"],"window":"weekly_all","group":weekly["group"],"model":null,
        "old_percent":old,"new_percent":r.weekly,"weekly_percent":r.weekly,"fable_percent":r.fable,
        "pip_percent":round2(r.pip),"fable_pip_offset":offset,"target_percent":round2(target),"threshold_percent":null,
        "resets_at":weekly["resets_at"],"observed_at":row["observed_at"],"summary":summary})
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
    fn usage_initial_levels_seed_edges_without_repeating() {
        let mut s=json!({});let c=cfg();
        assert_eq!(names(&initial(&mut s,&[row(100.)],&c,now())),vec!["above","limit"]);
        assert!(evaluate(&mut s,&[row(100.)],&c,now()).is_empty());
        assert!(names(&evaluate(&mut s,&[row(97.)],&c,now())).contains(&"below"));
        assert_eq!(names(&initial(&mut json!({}),&[row(1.)],&c,now())),vec!["below"]);
    }
    #[test]
    fn usage_initial_unknown_stale_and_unreadable_are_never_thresholds() {
        let c=cfg();let mut r=row(0.);r["available"]=json!(false);
        assert_eq!(names(&initial(&mut json!({}),&[r.clone()],&c,now())),vec!["unreadable"]);
        r["freshness"]=json!("stale");
        assert_eq!(names(&initial(&mut json!({}),&[r],&c,now())),vec!["stale"]);
        let mut unknown=row(0.);unknown["windows"][0]["used_percent"]=Value::Null;
        assert_eq!(names(&initial(&mut json!({}),&[unknown],&c,now())),vec!["unreadable"]);
        assert_eq!(names(&initial(&mut json!({}),&[row(100.)],&c,now()+chrono::Duration::minutes(16))),vec!["stale"]);
    }
    #[test]
    fn usage_initial_filters_and_edge_only_events() {
        for c in [json!({"accounts":["other"]}),json!({"windows":["daily"]}),
            json!({"usage_events":["reset","recovered","refused","account_added","account_removed"]})] {
            assert!(initial(&mut json!({}),&[row(100.)],&c,now()).is_empty());
        }
        let c=json!({"windows":["weekly"],"usage_events":["limit"]});
        assert_eq!(names(&initial(&mut json!({}),&[row(100.)],&c,now())),vec!["limit"]);
    }
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

    // ---- the Fable pip dog (spec usage-watchdog-fable-pip.md section 8, tests 3-12). Pip 76 means Fable 52%.
    fn prow(weekly: f64, fable: f64) -> Value {
        let resets = crate::util::iso(now() + chrono::Duration::days(3));
        json!({"account":"claude-5","provider":"claude","available":true,"freshness":"fresh","observed_at":crate::util::iso(now()),
            "windows":[
                {"kind":"weekly_all","group":"all","model":null,"label":"weekly","used_percent":weekly,"resets_at":resets},
                {"kind":"weekly_scoped","group":"fable","model":"Claude Fable 5.2","label":"weekly","used_percent":fable,"resets_at":resets}]})
    }
    fn pcfg(offset: f64) -> Value { json!({"fable_pip_offset":offset,"usage_events":["pip_reached"]}) }
    fn pcfg_both(offset: f64) -> Value { json!({"fable_pip_offset":offset,"usage_events":["pip_reached","pip_cleared"]}) }
    fn ev(s: &mut Value, row: Value, c: &Value) -> Vec<String> { names(&evaluate(s, &[row], c, now())).into_iter().map(String::from).collect() }
    fn none() -> Vec<String> { vec![] }
    fn reached() -> Vec<String> { vec!["pip_reached".into()] }

    #[test]
    fn pip_offset_minus_two_fires_on_the_crossing_and_rearms_silently() {
        let (mut s, c) = (json!({}), pcfg(-2.0));
        assert_eq!(ev(&mut s, prow(73., 52.), &c), none());
        assert_eq!(ev(&mut s, prow(74., 52.), &c), reached());
        assert_eq!(ev(&mut s, prow(75., 52.), &c), none(), "staying met never repeats");
        assert_eq!(ev(&mut s, prow(73., 52.), &c), none(), "re-arming is silent by default");
        assert_eq!(ev(&mut s, prow(74., 52.), &c), reached());
    }
    #[test]
    fn pip_offset_zero_is_exact_equality() {
        let (mut s, c) = (json!({}), pcfg(0.0));
        assert_eq!(ev(&mut s, prow(75.9, 52.), &c), none());
        assert_eq!(ev(&mut s, prow(76., 52.), &c), reached());
    }
    #[test]
    fn pip_offset_plus_one_is_one_past() {
        let (mut s, c) = (json!({}), pcfg(1.0));
        assert_eq!(ev(&mut s, prow(76.9, 52.), &c), none());
        assert_eq!(ev(&mut s, prow(77., 52.), &c), reached());
    }
    #[test]
    fn pip_moving_with_fable_rearms_and_cleared_is_opt_in() {
        for (c, expect_cleared) in [(pcfg(-2.0), false), (pcfg_both(-2.0), true)] {
            let mut s = json!({});
            assert_eq!(ev(&mut s, prow(75., 52.), &c), reached());
            // Fable 56%: pip 78, target 76; weekly 75 is no longer met
            let got = ev(&mut s, prow(75., 56.), &c);
            assert_eq!(got, if expect_cleared { vec!["pip_cleared".to_string()] } else { none() });
            assert_eq!(ev(&mut s, prow(76., 56.), &c), reached());
        }
    }
    #[test]
    fn pip_week_reset_rearms() {
        let (mut s, c) = (json!({}), pcfg(-2.0));
        assert_eq!(ev(&mut s, prow(75., 52.), &c), reached());
        assert_eq!(ev(&mut s, prow(2., 0.), &c), none());
        assert_eq!(ev(&mut s, prow(47., 0.), &c), none(), "target is 48");
        assert_eq!(ev(&mut s, prow(48., 0.), &c), reached());
    }
    #[test]
    fn pip_unknown_is_never_zero_and_keeps_the_state() {
        let c = pcfg(-2.0);
        let breakers: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
            ("fable window missing", Box::new(|r| { r["windows"].as_array_mut().unwrap().remove(1); })),
            ("fable null", Box::new(|r| r["windows"][1]["used_percent"] = Value::Null)),
            ("row unavailable", Box::new(|r| r["available"] = json!(false))),
            ("row stale", Box::new(|r| { r["freshness"] = json!("stale"); r["available"] = json!(false); })),
            ("weekly expired", Box::new(|r| r["windows"][0]["resets_at"] = json!(crate::util::iso(now())))),
        ];
        for (what, brk) in &breakers {
            // not met, then unknown, then met: exactly one pip_reached
            let mut s = json!({});
            assert_eq!(ev(&mut s, prow(73., 52.), &c), none());
            let mut r = prow(75., 52.); brk(&mut r);
            assert_eq!(ev(&mut s, r, &c), none(), "{what}: unknown fires nothing");
            assert_eq!(ev(&mut s, prow(74., 52.), &c), reached(), "{what}: the next known met reading fires once");
            // met, then unknown, then still met: no refire
            let mut r = prow(75., 52.); brk(&mut r);
            assert_eq!(ev(&mut s, r, &c), none(), "{what}");
            assert_eq!(ev(&mut s, prow(75., 52.), &c), none(), "{what}: still met after an outage does not refire");
        }
    }
    #[test]
    fn pip_fable_at_one_hundred_has_no_pip_and_keeps_the_state() {
        let (mut s, c) = (json!({}), pcfg(-2.0));
        assert_eq!(ev(&mut s, prow(73., 52.), &c), none());
        assert_eq!(ev(&mut s, prow(100., 100.), &c), none());
        assert_eq!(ev(&mut s, prow(74., 52.), &c), reached(), "state kept: the earlier not-met still arms the crossing");
    }
    #[test]
    fn pip_initial_levels() {
        let c = pcfg(-2.0);
        assert_eq!(names(&initial(&mut json!({}), &[prow(75., 52.)], &c, now())), vec!["pip_reached"]);
        assert!(initial(&mut json!({}), &[prow(70., 52.)], &c, now()).is_empty());
        assert_eq!(names(&initial(&mut json!({}), &[prow(70., 52.)], &pcfg_both(-2.0), now())), vec!["pip_cleared"]);
        let mut unknown = prow(75., 52.); unknown["windows"].as_array_mut().unwrap().remove(1);
        let mut s = json!({});
        assert!(initial(&mut s, &[unknown], &c, now()).is_empty());
        assert_eq!(ev(&mut s, prow(75., 52.), &c), reached(), "the first known met reading fires");
    }
    #[test]
    fn pip_fire_payload_and_summary() {
        let c = pcfg(-2.0);
        let mut s = json!({});
        evaluate(&mut s, &[prow(73., 52.)], &c, now());
        let out = evaluate(&mut s, &[prow(75., 52.)], &c, now());
        assert_eq!(out.len(), 1);
        let e = &out[0];
        assert_eq!(e["event"], "pip_reached");
        assert_eq!((e["account"].as_str(), e["window"].as_str(), e["model"].is_null(), e["threshold_percent"].is_null()), (Some("claude-5"), Some("weekly_all"), true, true));
        for (k, v) in [("old_percent", 73.), ("new_percent", 75.), ("weekly_percent", 75.), ("fable_percent", 52.), ("pip_percent", 76.), ("fable_pip_offset", -2.), ("target_percent", 74.)] {
            assert_eq!(e[k].as_f64(), Some(v), "{k}");
        }
        assert!(e["resets_at"].is_string() && e["observed_at"].is_string());
        assert_eq!(e["summary"], "claude-5 weekly 75% is 1 point before the Fable pip at 76% (Fable 52% used; fires at pip -2 = 74%)");
        let sum = |offset: f64, weekly: f64| {
            let mut s = json!({});
            evaluate(&mut s, &[prow(1., 52.)], &pcfg(offset), now());
            evaluate(&mut s, &[prow(weekly, 52.)], &pcfg(offset), now())[0]["summary"].as_str().unwrap().to_string()
        };
        assert_eq!(sum(-2.0, 74.), "claude-5 weekly 74% is 2 points before the Fable pip at 76% (Fable 52% used; fires at pip -2 = 74%)");
        assert_eq!(sum(0.0, 76.), "claude-5 weekly 76% is at the Fable pip at 76% (Fable 52% used; fires at pip = 76%)");
        assert_eq!(sum(1.0, 77.5), "claude-5 weekly 77.5% is 1.5 points past the Fable pip at 76% (Fable 52% used; fires at pip +1 = 77%)");
        assert_eq!(sum(-1.5, 74.5), "claude-5 weekly 74.5% is 1.5 points before the Fable pip at 76% (Fable 52% used; fires at pip -1.5 = 74.5%)");
        // the pip_cleared text
        let mut s = json!({});
        evaluate(&mut s, &[prow(75., 52.)], &pcfg_both(-2.0), now());
        let out = evaluate(&mut s, &[prow(70., 52.)], &pcfg_both(-2.0), now());
        assert_eq!(out[0]["event"], "pip_cleared");
        assert_eq!(out[0]["summary"], "claude-5 weekly 70% is back below 74% (Fable pip at 76%, Fable 52% used)");
    }
    #[test]
    fn pip_mode_ignores_non_claude_rows() {
        let c = json!({"fable_pip_offset":-2.0,"usage_events":["pip_reached","account_added","account_removed"]});
        let mut s = json!({});
        evaluate(&mut s, &[], &c, now());
        let mut other = row(97.); other["account"] = json!("openai-1"); other["provider"] = json!("openai");
        assert!(evaluate(&mut s, &[other], &c, now()).is_empty(), "no account_added for a non-Claude row");
        assert!(evaluate(&mut s, &[], &c, now()).is_empty(), "and no account_removed");
        assert_eq!(names(&evaluate(&mut s, &[prow(75., 52.)], &c, now())), vec!["account_added", "pip_reached"]);
    }
}
