//! Ephemeral shell previews; never part of transcript persistence.
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub const TOOL_BYTES: usize = 32 * 1024;
pub const ACTOR_BYTES: usize = 256 * 1024;
pub const CADENCE: Duration = Duration::from_millis(250);
pub struct Update<'a> { pub id: &'a str, pub text: &'a str, pub append: bool }
#[nolog]
pub fn codex<'a>(event: &'a Value, turn: &str) -> Option<Update<'a>> {
    let p=&event["params"];
    (event["method"]=="item/commandExecution/outputDelta" && p["turnId"].as_str()==Some(turn)).then_some(())?;
    Some(Update{id:p["itemId"].as_str()?,text:p["delta"].as_str()?,append:true})
}
#[nolog]
pub fn muse<'a>(event: &'a Value, turn: &str) -> Option<Update<'a>> {
    let p=&event["params"];
    match event["method"].as_str()? {
        "item/delta" if matches!(p["field"].as_str(),Some("output"|"visibleOutput")) => {
            if p.get("turnId").is_some_and(|t|t.as_str()!=Some(turn)) {return None;}
            Some(Update{id:p["itemId"].as_str()?,text:p["delta"].as_str()?,append:true})
        },
        "item/started"|"item/updated" => {
            let i=&p["item"];
            if i["turnId"].as_str()!=Some(turn)||i["status"]!="inProgress"||!matches!(i["kind"].as_str(),Some("toolCall"|"userShell")) {return None;}
            Some(Update{id:i["itemId"].as_str()?,text:i["visibleOutput"].as_str()?,append:false})
        },
        _=>None,
    }
}
#[nolog]
pub fn is_shell(name:&str)->bool {matches!(name.rsplit("__").next().unwrap_or("").to_ascii_lowercase().as_str(),"bash"|"powershell"|"exec_command"|"run_command"|"run_shell_command"|"shell")}
#[derive(Default)]
struct Tail {text:String,truncated:bool}
#[derive(Default)]
pub struct State { pub due: Option<Instant>, tails:BTreeMap<String,Tail>, revision:u64, last:Option<Instant> }
impl State {
    #[nolog]
    pub fn observe(&mut self, id: &str, text: &str, append: bool, now: Instant) {
        if id.len()>512 || (!self.tails.contains_key(id) && (text.is_empty() || self.tails.len()>=ACTOR_BYTES/TOOL_BYTES)) {return;}
        let tail=self.tails.entry(id.into()).or_default();
        if !append {tail.text.clear();tail.truncated=false;}
        // Never concatenate a provider-sized frame: select its bounded suffix first.
        let mut start=text.len().saturating_sub(TOOL_BYTES);
        while !text.is_char_boundary(start) {start+=1;}
        if start>0 {tail.text.clear();tail.truncated=true;}
        tail.text.push_str(&text[start..]);
        let mut drop=tail.text.len().saturating_sub(TOOL_BYTES);
        while !tail.text.is_char_boundary(drop) {drop+=1;}
        if drop>0 {tail.text.drain(..drop);tail.truncated=true;}
        self.changed(now);
    }
    #[nolog]
    fn changed(&mut self,now:Instant) {
        self.revision=self.revision.saturating_add(1);
        self.due.get_or_insert(self.last.map(|t|t+CADENCE).unwrap_or(now+CADENCE).max(now));
    }
    #[nolog]
    pub fn remove(&mut self, id: &str, now: Instant) {if self.tails.remove(id).is_some(){self.changed(now);}}
    #[nolog]
    pub fn clear(&mut self) {self.tails.clear();self.revision=self.revision.saturating_add(1);self.due=None;self.last=None;}
    #[nolog]
    pub fn flush(&mut self, now: Instant) -> bool {
        if !self.due.is_some_and(|at|at<=now){return false;}
        self.due=None;self.last=Some(now);true
    }
    #[nolog]
    pub fn frame(&self, turn: &str) -> Value { json!({"turn_started_at":turn,"revision":self.revision,
        "tools":self.tails.iter().map(|(id,t)|json!({"id":id,"text":t.text,"truncated":t.truncated,"kind":"execute"})).collect::<Vec<_>>()}) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_output_codex_recorded_delta_is_turn_scoped() {
        let v=json!({"method":"item/commandExecution/outputDelta","params":{"threadId":"thread","turnId":"turn","itemId":"cmd","delta":"line1\n"}});
        let u=codex(&v,"turn").expect("recorded app-server command delta");
        assert_eq!((u.id,u.text,u.append),("cmd","line1\n",true));
        assert!(codex(&v,"other").is_none());
    }
    #[test]
    fn shell_output_muse_recorded_deltas_and_snapshots_are_distinct() {
        let delta=json!({"method":"item/delta","params":{"sessionId":"s","viewCursor":"c1","itemId":"ps","field":"output","delta":"ONE\n"}});
        assert!(muse(&delta,"turn").expect("MSP output delta").append);
        let snap=json!({"method":"item/updated","params":{"item":{"turnId":"turn","itemId":"ps","kind":"toolCall","status":"inProgress","visibleOutput":"ONE\nTWO\n"}}});
        let u=muse(&snap,"turn").expect("MSP visible output snapshot");
        assert_eq!((u.id,u.text,u.append),("ps","ONE\nTWO\n",false));
        assert!(muse(&snap,"old").is_none());
    }
    #[test]
    fn shell_output_tail_is_utf8_bounded_and_snapshots_do_not_duplicate() {
        let now=Instant::now(); let mut s=State::default();
        s.observe("cmd",&"é".repeat(40000),true,now);
        let f=s.frame("stamp");let text=f["tools"][0]["text"].as_str().expect("tail");
        assert!(text.len()<=TOOL_BYTES);assert!(text.len()>0);assert_eq!(f["tools"][0]["truncated"],true);
        s.observe("cmd","same\n",false,now);s.observe("cmd","same\n",false,now);
        assert_eq!(s.frame("stamp")["tools"][0]["text"],"same\n");
    }
    #[test]
    fn shell_output_aggregate_budget_is_bounded() {
        let mut s=State::default();let now=Instant::now();
        for n in 0..100 {s.observe(&n.to_string(),&"x".repeat(TOOL_BYTES),true,now);}
        let f=s.frame("stamp");let tools=f["tools"].as_array().unwrap();
        let bytes:usize=tools.iter().map(|v|v["text"].as_str().unwrap().len()).sum();
        assert_eq!(bytes,ACTOR_BYTES);assert_eq!(tools.len(),8);
    }
    #[test]
    fn shell_output_coalesces_at_four_frames_per_second() {
        let mut s=State::default();let now=Instant::now();s.observe("cmd","a",true,now);
        assert!(!s.flush(now));assert!(!s.flush(now+CADENCE-Duration::from_millis(1)));
        assert!(s.flush(now+CADENCE));
        s.observe("cmd","b",true,now+CADENCE);
        assert!(!s.flush(now+CADENCE));assert!(s.flush(now+CADENCE*2));
    }
    #[test]
    fn shell_output_final_and_turn_clear_retire_bytes() {
        let mut s=State::default();let now=Instant::now();s.observe("cmd","live",true,now);
        assert_eq!(s.frame("stamp")["tools"].as_array().unwrap().len(),1);
        s.remove("cmd",now);assert_eq!(s.frame("stamp")["tools"],json!([]));
        s.observe("other","next",true,now);s.clear();assert_eq!(s.frame("stamp")["tools"],json!([]));assert!(s.due.is_none());
    }
    #[test]
    fn shell_output_model_text_and_terminal_snapshots_are_not_output_deltas() {
        assert!(codex(&json!({"method":"item/agentMessage/delta","params":{"delta":"prose"}}),"t").is_none());
        assert!(muse(&json!({"method":"item/completed","params":{"item":{"turnId":"t","visibleOutput":"final"}}}),"t").is_none());
    }
    #[test]
    fn shell_output_empty_state_is_empty() {assert_eq!(State::default().frame("stamp")["tools"],json!([]));}
}
