//! Pure, sanitized usage transitions; no I/O or provider documents.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

#[nolog]
pub(super) fn evaluate(_state: &mut Value, _rows: &[Value], _config: &Value, _now: DateTime<Utc>) -> Vec<Value> {
    Vec::new()
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
}
