use super::*;
use crate::runtime::interrupt::Boundary;

pub(super) struct Request { pub restart: bool, pub by: String, pub boundary: Boundary }

#[nolog]
impl Actor {
    pub(super) fn interrupt_boundary_kind(&self) -> Boundary {
        match self.proc { Some(Proc::Claude(_))=>Boundary::Claude, Some(Proc::Agy(_))=>Boundary::Agy, _=>Boundary::Async }
    }

    pub(super) async fn interrupt_from_agent(&mut self, caller: &Caller, restart: bool, queued: bool) -> Result<Value> {
        crate::tools::control::authorize_interrupt(&self.engine,caller,self.id).await?;
        let boundary=self.interrupt_boundary_kind();
        let Some(t)=self.turn.as_ref() else {return Ok(json!({"interrupted":false,"reason":"no turn is running"}))};
        if t.interrupted || t.queued_interrupt.is_some() {
            return Ok(json!({"interrupted":t.interrupted,"queued":t.queued_interrupt.is_some(),
                "already_requested":true,"restart":t.restart || t.queued_interrupt.as_ref().is_some_and(|q|q.restart),
                "turn_id":t.id,"boundary":boundary.description()}));
        }
        if (queued || restart || caller.agent_id==self.id) && self.bg_pending() {
            return Ok(json!({"interrupted":false,"reason":"the CLI still runs background work: finish or stop it, then call orgtree_interrupt again"}));
        }
        if queued {
            self.turn.as_mut().unwrap().queued_interrupt=Some(Request{restart,by:caller.name.clone(),boundary});
            self.record_interrupt("queued",restart,&caller.name,boundary,None);
            Ok(json!({"interrupted":false,"queued":true,"restart":restart,"turn_id":self.turn.as_ref().unwrap().id,
                "boundary":boundary.description()}))
        } else {
            Ok(self.interrupt_now(restart,&caller.name,caller.agent_id!=self.id && !restart))
        }
    }

    pub(super) fn record_interrupt(&mut self, status:&str,restart:bool,by:&str,boundary:Boundary,reason:Option<&str>) {
        self.last_interrupt=json!({"status":status,"restart":restart,"by":by,"at":now_iso(),
            "turn_id":self.turn.as_ref().map(|t|t.id),"boundary":boundary.description(),"reason":reason});
        crate::runtime::watchdogs::events::emit(&self.engine,crate::runtime::watchdogs::events::event(
            "agent.interrupt",crate::runtime::watchdogs::events::Scope::Agent(self.org_id,self.id),self.last_interrupt.clone()));
        self.publish();
    }

    pub(super) fn interrupt_now(&mut self,restart:bool,by:&str,allow_background:bool)->Value {
        let Some(t)=self.turn.as_ref() else {return json!({"interrupted":false,"reason":"no turn is running"})};
        if !allow_background && self.bg_pending() {
            return json!({"interrupted":false,"reason":"the CLI still runs background work: finish or stop it, then call orgtree_interrupt again"});
        }
        if !self.proc.as_ref().is_some_and(|p|p.interrupt(t.codex_turn.as_deref())) {
            return json!({"interrupted":false,"reason":"the process could not be reached"});
        }
        let t=self.turn.as_mut().unwrap();
        t.interrupted=true;
        t.shell_output.clear();
        t.restart=restart;
        t.restart_by=Some(by.into());
        t.queued_interrupt=None;
        if by==self.name {tracing::info!(agent=%self.name,restart,"the agent ended its own turn");}
        else {tracing::info!(agent=%self.name,restart,"a superior requested a turn interrupt");}
        self.record_interrupt("applied",restart,by,self.interrupt_boundary_kind(),None);
        json!({"interrupted":true,"restart":restart})
    }

    /// Called only at a real hook or after a fresh, attributed completion.
    pub(super) fn apply_queued_interrupt(&mut self)->bool {
        let Some(q)=self.turn.as_mut().and_then(|t|t.queued_interrupt.take()) else {return false};
        let result=self.interrupt_now(q.restart,&q.by,false);
        if let Some(reason)=result["reason"].as_str() {
            self.record_interrupt("refused",false,&q.by,q.boundary,Some(reason));
        }
        result["interrupted"]==true
    }

    pub(super) fn track_interrupt(&mut self,event:Option<(&str,bool)>)->bool {
        let Some(t)=self.turn.as_mut() else {return false};
        let Some((id,done))=event else {return false};
        if done {t.interrupt_progress.finish(id)} else {t.interrupt_progress.start(id);false}
    }

    pub(super) fn track_claude_interrupt(&mut self,v:&Value) {
        if !v["parent_tool_use_id"].is_null() {return;}
        if v["type"]=="assistant" {
            for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if b["type"]=="tool_use" {self.track_interrupt(b["id"].as_str().map(|id|(id,false)));}
            }
        }
    }

    pub(super) fn track_agy_interrupt(&mut self,v:&Value) {
        let step=&v["step_update"];
        if v["event"]!="step_update" || step["step_type"]!="tool" {return;}
        let Some(id)=step["step_index"].as_i64() else {return};
        let id=id.to_string();
        self.track_interrupt(Some((&id,matches!(step["state"].as_str(),Some("DONE"|"ERROR"|"CANCELLED")))));
    }

    pub(super) fn held_interrupt(&mut self)->bool {
        if !self.turn.as_ref().is_some_and(|t|t.interrupt_progress.quiet()) {return false;}
        self.apply_queued_interrupt()
    }

    pub(super) fn finish_queued_interrupt(&mut self) {
        let Some(q)=self.turn.as_mut().and_then(|t|t.queued_interrupt.take()) else {return};
        if q.restart && self.bg_pending() {
            self.record_interrupt("refused",false,&q.by,q.boundary,Some("background work prevents the requested restart"));
            return;
        }
        if let Some(t)=self.turn.as_mut() {t.restart=q.restart;t.restart_by=Some(q.by.clone());}
        self.record_interrupt("noop",q.restart,&q.by,q.boundary,Some("the current turn ended before the interrupt applied"));
    }
}
