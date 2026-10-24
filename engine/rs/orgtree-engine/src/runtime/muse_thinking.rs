//! Muse's own reported reasoning boundaries; never a whole-turn estimate.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

/// Turn-owned metadata only; no reasoning text or global state.
#[derive(Default)]
pub struct Timing { blocks: BTreeMap<String, Block> }
struct Block { start: Option<Instant>, done: bool, secs: Option<f64> }
#[nolog]
impl Timing {
    pub fn observe(&mut self, params: &Value, started: bool, done: bool, session: &str, turn: &str, now: Instant) -> Option<f64> {
        let item=&params["item"];
        if session.is_empty() || turn.is_empty() || params["sessionId"].as_str()!=Some(session)
            || item["turnId"].as_str()!=Some(turn) || item["kind"]!="reasoning" || (!started&&!done) { return None; }
        let id=item["itemId"].as_str().filter(|id|!id.is_empty()&&id.len()<=512)?;
        if self.blocks.len()>=1024 && !self.blocks.contains_key(id) { return None; }
        let block=self.blocks.entry(id.into()).or_insert_with(||Block {start:(started&&!done).then_some(now),done:false,secs:None});
        if !done { return None; }
        if !block.done {block.done=true;block.secs=block.start.and_then(|at|now.checked_duration_since(at).map(|d|d.as_secs_f64()));}
        block.secs
    }
}

#[nolog]
pub fn row(id: &str, body: String, previous: Option<Value>, at: &str, secs: Option<f64>) -> Value {
    let mut row=previous.unwrap_or_else(||json!({"role":"assistant","text":"","tools":[],"ts":at,"assistant_id":id}));
    if !body.trim().is_empty() {row["thinking"]=json!(body);row["thinking_sealed"]=json!(false);}
    else if row["thinking"].as_str().is_none_or(|s|s.trim().is_empty()) {row["thinking"]=json!("");row["thinking_sealed"]=json!(true);}
    if let Some(secs)=secs.filter(|n|n.is_finite()&&*n>=0.0) {row["think_secs"]=json!(secs);}
    row
}

#[cfg(test)]
mod timing_tests {
    use super::*;
    use std::time::Duration;
    fn params(id: &str) -> Value {json!({"sessionId":"session","item":{"itemId":id,"kind":"reasoning","turnId":"turn","status":"inProgress","revision":1}})}
    fn observe(t: &mut Timing,p: &Value,start: bool,done: bool,now: Instant) -> Option<f64> {t.observe(p,start,done,"session","turn",now)}
    #[test]
    fn reported_reasoning_boundaries_retain_elapsed_time_and_reloaded_row() {
        let mut t=Timing::default();let now=Instant::now();let p=params("readable");
        observe(&mut t,&p,true,false,now);
        let secs=observe(&mut t,&p,false,true,now+Duration::from_millis(7250));
        assert_eq!(secs,Some(7.25));
        let mut previous=row("readable","Supplied Muse reasoning".into(),None,"original",None);
        previous["tools"]=json!([{"id":"read","name":"Read","result":"Kept Muse tool output"}]);
        let r=row("readable","Supplied Muse reasoning".into(),Some(previous),"later",secs);
        let loaded:Value=serde_json::from_str(&r.to_string()).unwrap();
        assert_eq!(loaded["think_secs"],7.25);assert_eq!(loaded["ts"],"original");assert_eq!(loaded["tools"][0]["result"],"Kept Muse tool output");
        assert!(loaded.get("content_blocks").is_none());
        if let Ok(path)=std::env::var("ORGTREE_MUSE_TIMING_FIXTURE") {
            std::fs::write(path,serde_json::to_string(&json!([loaded,row("unknown","".into(),None,"old",None),row("zero","Supplied zero-duration Muse thought".into(),None,"now",Some(0.0))])).unwrap()).unwrap();
        }
    }
    #[test]
    fn duplicate_starts_updates_and_completions_do_not_restart_or_extend_time() {
        let mut t=Timing::default();let now=Instant::now();let p=params("r");
        observe(&mut t,&p,true,false,now);observe(&mut t,&p,true,false,now+Duration::from_secs(2));
        observe(&mut t,&p,false,false,now+Duration::from_secs(5));
        let secs=observe(&mut t,&p,false,true,now+Duration::from_secs(10));assert_eq!(secs,Some(10.0));
        assert_eq!(observe(&mut t,&p,false,true,now+Duration::from_secs(200)),secs);
        let previous=row("r","Readable".into(),None,"at",secs);
        assert_eq!(row("r","".into(),Some(previous),"late",None)["think_secs"],10.0);
    }
    #[test]
    fn update_or_completion_without_a_start_stays_unknown_after_late_replay() {
        let mut t=Timing::default();let now=Instant::now();let mut p=params("r");
        p["durationMs"]=json!(900000);observe(&mut t,&p,false,false,now);
        assert_eq!(observe(&mut t,&p,false,true,now+Duration::from_secs(50)),None);
        observe(&mut t,&p,true,false,now+Duration::from_secs(60));
        assert_eq!(observe(&mut t,&p,false,true,now+Duration::from_secs(100)),None);
    }
    #[test]
    fn another_session_turn_or_item_kind_cannot_supply_a_start() {
        let mut t=Timing::default();let now=Instant::now();
        for field in ["session","turn","kind"] {
            let mut p=params(field);
            match field {"session"=>p["sessionId"]=json!("other"),"turn"=>p["item"]["turnId"]=json!("other"),_=>p["item"]["kind"]=json!("toolCall")};
            observe(&mut t,&p,true,false,now);
            assert_eq!(observe(&mut t,&params(field),false,true,now+Duration::from_secs(3)),None);
        }
    }
    #[test]
    fn native_item_identity_and_bounded_turn_state_prevent_cross_item_timing() {
        let mut t=Timing::default();let now=Instant::now();
        observe(&mut t,&params("a"),true,false,now);observe(&mut t,&params("b"),true,false,now+Duration::from_secs(1));
        assert_eq!(observe(&mut t,&params("b"),false,true,now+Duration::from_secs(4)),Some(3.0));
        assert_eq!(observe(&mut t,&params("a"),false,true,now+Duration::from_secs(10)),Some(10.0));
        let mut bounded=Timing::default();for i in 0..1024 {observe(&mut bounded,&params(&format!("r-{i}")),true,false,now);}
        observe(&mut bounded,&params("overflow"),true,false,now);
        assert_eq!(observe(&mut bounded,&params("overflow"),false,true,now+Duration::from_secs(1)),None);
        assert_eq!(observe(&mut bounded,&params("r-0"),false,true,now+Duration::from_secs(1)),Some(1.0));
        let mut next=Timing::default();assert_eq!(observe(&mut next,&params("r-0"),false,true,now),None);
    }
    #[test]
    fn real_zero_remains_a_duration_on_a_sealed_thought() {
        let mut t=Timing::default();let now=Instant::now();let p=params("zero");observe(&mut t,&p,true,false,now);
        let secs=observe(&mut t,&p,false,true,now);assert_eq!(secs,Some(0.0));
        let r=row("zero","".into(),None,"now",secs);assert_eq!(r["think_secs"],0.0);assert_eq!(r["thinking_sealed"],true);
    }
    #[test]
    fn historical_rows_and_invalid_values_have_no_invented_duration() {
        for secs in [None,Some(f64::NAN),Some(f64::INFINITY),Some(-1.0)] {
            let r=row("history","".into(),None,"1900-01-01",secs);
            assert!(r.get("think_secs").is_none());assert!(r.get("thinking_tokens").is_none());
        }
    }
}
