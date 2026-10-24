//! Private Codex item-boundary timing; no reasoning text is retained in the clock.
use super::row;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

/// Turn-owned, bounded metadata; ids and clocks only, never reasoning content.
#[derive(Default)]
pub struct Timing { blocks: BTreeMap<String, Block> }
struct Block { start: Option<(Instant, Option<i64>)>, finished: bool, secs: Option<f64> }

#[nolog]
impl Timing {
    pub fn observe(&mut self, params: &Value, completed: bool, thread: &str, turn: &str, now: Instant) -> Option<f64> {
        if thread.is_empty() || turn.is_empty() || params["threadId"].as_str()!=Some(thread)
            || params["turnId"].as_str()!=Some(turn) || params["item"]["type"]!="reasoning" { return None; }
        let id=params["item"]["id"].as_str().filter(|id|!id.is_empty()&&id.len()<=512)?;
        if self.blocks.len()>=1024 && !self.blocks.contains_key(id) { return None; }
        let stamp=|key|params.get(key).and_then(Value::as_i64).filter(|ms|*ms>=0);
        let block=self.blocks.entry(id.into()).or_insert_with(||Block {
            start:(!completed).then(||(now,stamp("startedAtMs"))),finished:false,secs:None
        });
        if !completed { return None; }
        if !block.finished {
            block.finished=true;
            block.secs=block.start.and_then(|(at,start)| {
                start.zip(stamp("completedAtMs")).and_then(|(a,b)|b.checked_sub(a).filter(|ms|*ms>=0).map(|ms|ms as f64/1000.0))
                    .or_else(||now.checked_duration_since(at).map(|d|d.as_secs_f64()))
            });
        }
        block.secs
    }
}

#[nolog]
pub fn timed_row(item: &Value, previous: Option<Value>, at: &str, secs: Option<f64>) -> Value {
    let mut row=row(item, previous, at);
    if let Some(secs)=secs.filter(|s|s.is_finite()&&*s>=0.0) { row["think_secs"]=json!(secs); }
    row
}

#[cfg(test)]
mod timing_tests {
    use super::*;
    use std::time::Duration;

    fn params(id: &str, stamp: Option<i64>, completed: bool) -> Value {
        let mut p=json!({"threadId":"thread","turnId":"turn","item":{"type":"reasoning","id":id,"summary":["Supplied fixture reasoning"],"content":[]}});
        if let Some(ms)=stamp { p[if completed {"completedAtMs"} else {"startedAtMs"}]=json!(ms); }
        p
    }
    fn observe(t: &mut Timing, p: &Value, done: bool, now: Instant) -> Option<f64> {
        t.observe(p,done,"thread","turn",now)
    }
    #[test]
    fn native_reasoning_boundaries_win_over_delivery_delay_and_reload() {
        let mut t=Timing::default();let now=Instant::now();
        let start=params("readable",Some(1000),false);
        assert_eq!(observe(&mut t,&start,false,now),None);
        let end=params("readable",Some(126750),true);
        let secs=observe(&mut t,&end,true,now+Duration::from_secs(900));
        assert_eq!(secs,Some(125.75),"use the native lifecycle, not mailbox or database delay");
        let mut previous=row(&end["item"],None,"original");
        previous["tools"]=json!([{"id":"read","name":"Read","result":"Kept tool output"}]);
        let readable=timed_row(&end["item"],Some(previous),"later",secs);
        let loaded:Value=serde_json::from_str(&readable.to_string()).unwrap();
        assert_eq!(loaded["think_secs"],125.75);assert_eq!(loaded["ts"],"original");
        assert_eq!(loaded["tools"][0]["result"],"Kept tool output");assert!(loaded.get("content_blocks").is_none());
        let mut sealed=params("sealed",Some(200000),false);sealed["item"]["summary"]=json!([]);
        observe(&mut t,&sealed,false,now);
        sealed["completedAtMs"]=json!(262000);
        let secs=observe(&mut t,&sealed,true,now+Duration::from_secs(1));
        let sealed=timed_row(&sealed["item"],None,"now",secs);
        assert_eq!(sealed["think_secs"],62.0);assert_eq!(sealed["thinking_sealed"],true);
        let unknown=row(&json!({"id":"historical","summary":[]}),None,"old");
        let zero=timed_row(&json!({"id":"zero","summary":["Supplied zero-duration thought"]}),None,"now",Some(0.0));
        if let Ok(path)=std::env::var("ORGTREE_CODEX_TIMING_FIXTURE") {
            std::fs::write(path,serde_json::to_string(&json!([loaded,sealed,unknown,zero])).unwrap()).unwrap();
        }
    }
    #[test]
    fn observed_boundaries_freeze_across_duplicate_start_and_completion() {
        let mut t=Timing::default();let now=Instant::now();let p=params("r",None,false);
        observe(&mut t,&p,false,now);observe(&mut t,&p,false,now+Duration::from_secs(5));
        let end=params("r",None,true);
        assert_eq!(observe(&mut t,&end,true,now+Duration::from_millis(7250)),Some(7.25));
        assert_eq!(observe(&mut t,&end,true,now+Duration::from_secs(200)),Some(7.25));
    }
    #[test]
    fn measured_zero_is_retained_on_sealed_thoughts() {
        let mut t=Timing::default();let now=Instant::now();
        observe(&mut t,&params("zero",Some(0),false),false,now);
        let mut p=params("zero",Some(0),true);p["item"]["summary"]=json!([]);
        let secs=observe(&mut t,&p,true,now+Duration::from_secs(30));
        assert_eq!(secs,Some(0.0));
        assert_eq!(timed_row(&p["item"],None,"now",secs)["think_secs"],0.0);
    }
    #[test]
    fn different_items_and_invalid_native_stamps_use_only_matching_observed_pair() {
        let mut t=Timing::default();let now=Instant::now();
        observe(&mut t,&params("a",Some(1000),false),false,now);
        observe(&mut t,&params("b",Some(2000),false),false,now+Duration::from_secs(1));
        assert_eq!(observe(&mut t,&params("b",Some(3500),true),true,now+Duration::from_secs(20)),Some(1.5));
        assert_eq!(observe(&mut t,&params("a",Some(500),true),true,now+Duration::from_secs(25)),Some(25.0));
        let mut invalid=params("invalid",None,false);invalid["startedAtMs"]=json!(-1);
        observe(&mut t,&invalid,false,now);
        assert_eq!(observe(&mut t,&params("invalid",Some(6000),true),true,now+Duration::from_secs(3)),Some(3.0));
    }
    #[test]
    fn missing_starts_wrong_turns_and_history_never_create_a_duration() {
        let mut t=Timing::default();let now=Instant::now();let end=params("missing",Some(100000),true);
        assert_eq!(observe(&mut t,&end,true,now),None);
        observe(&mut t,&params("missing",Some(0),false),false,now);
        assert_eq!(observe(&mut t,&end,true,now+Duration::from_secs(20)),None,"late replay cannot invent a start");
        let mut wrong=params("r",Some(0),false);wrong["turnId"]=json!("another-turn");observe(&mut t,&wrong,false,now);
        assert_eq!(observe(&mut t,&params("r",Some(2000),true),true,now),None);
        wrong=params("thread-r",Some(0),false);wrong["threadId"]=json!("another-thread");observe(&mut t,&wrong,false,now);
        assert_eq!(observe(&mut t,&params("thread-r",Some(2000),true),true,now),None);
        let historical=timed_row(&json!({"id":"old","summary":[],"duration_ms":5000}),None,"very-old",None);
        assert!(historical.get("think_secs").is_none());
    }
    #[test]
    fn metadata_from_another_item_type_and_nonfinite_durations_are_ignored() {
        let mut t=Timing::default();let now=Instant::now();
        let mut p=params("tool",Some(0),false);p["item"]["type"]=json!("commandExecution");observe(&mut t,&p,false,now);
        p["completedAtMs"]=json!(2000);assert_eq!(observe(&mut t,&p,true,now),None);
        for invalid in [f64::NAN,f64::INFINITY,-1.0] {
            assert!(timed_row(&json!({"id":"invalid","summary":[]}),None,"now",Some(invalid)).get("think_secs").is_none());
        }
    }
    #[test]
    fn timing_state_is_bounded_and_new_turn_state_does_not_reuse_a_native_id() {
        let mut t=Timing::default();let now=Instant::now();
        for n in 0..1024 {observe(&mut t,&params(&format!("r-{n}"),Some(0),false),false,now);}
        observe(&mut t,&params("overflow",Some(0),false),false,now);
        assert_eq!(observe(&mut t,&params("overflow",Some(1000),true),true,now),None);
        assert_eq!(observe(&mut t,&params("r-0",Some(1000),true),true,now),Some(1.0));
        let mut next=Timing::default();assert_eq!(observe(&mut next,&params("r-0",Some(1000),true),true,now),None);
    }
}
