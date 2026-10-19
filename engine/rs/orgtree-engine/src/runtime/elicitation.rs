//! Human-only MCP requests. Ephemeral, independently correlated, and never
//! written as agent mail, saved permissions, or ordinary mutable ask parts.
use std::{sync::Arc, time::Duration};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore, OwnedSemaphorePermit};
use tokio_util::sync::CancellationToken;
use crate::{engine::Engine, tools::Caller, changes::{self,Change}};

pub const TIMEOUT: Duration = Duration::from_secs(300);
struct Pending {
    org: i64, agent: i64, card: Value, deadline: tokio::time::Instant,
    reply: mpsc::UnboundedSender<Value>, _capacity: OwnedSemaphorePermit,
}
pub struct Registry {
    requests: papaya::HashMap<String, Arc<Pending>>,
    capacity: Arc<Semaphore>,
}
impl Default for Registry {
    fn default() -> Self { Self {requests:Default::default(),capacity:Arc::new(Semaphore::new(128))} }
}
// No logged impl: schema defaults and submitted fields may be sensitive.
impl Registry {
    #[nolog]
    pub fn cards(&self, org: i64) -> Vec<Value> {
        let mut cards:Vec<_>=self.requests.pin().iter().filter(|(_,p)|p.org==org).map(|(_,p)|p.card.clone()).collect();
        cards.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str())); cards
    }
    #[nolog]
    pub fn agent_cards(&self, org:i64, agent:i64) -> Vec<Value> {
        self.requests.pin().iter().filter(|(_,p)|p.org==org && p.agent==agent).map(|(_,p)|p.card.clone()).collect()
    }
    #[nolog]
    fn start(&self, caller:&Caller, params:&Value, duration:Duration) -> Result<(String,mpsc::UnboundedReceiver<Value>)> {
        if params.to_string().len()>65536 {bail!("MCP permission request too large")}
        let server=params["serverName"].as_str().filter(|s|!s.is_empty()).ok_or_else(||anyhow::anyhow!("missing server name"))?;
        if !params["threadId"].is_string() || !params["message"].is_string() {bail!("invalid MCP request identity or message")}
        match params["mode"].as_str().unwrap_or("form") {
            "form"|"openai/form"|"openaiForm" => check_schema(&params["requestedSchema"])?,
            "url" => {if !params["elicitationId"].is_string() || !safe_url(&params["url"]) {bail!("invalid permission URL")}},
            _=>bail!("unsupported MCP elicitation mode"),
        }
        let permit=self.capacity.clone().try_acquire_owned()?;
        let id=format!("elicitation-{}",uuid::Uuid::new_v4());
        let (reply,rx)=mpsc::unbounded_channel();
        let card=json!({"id":id,"node":caller.name,"kind":"elicitation","status":"open",
            "at":crate::util::iso(chrono::Utc::now()),"header":format!("MCP permission · {server}"),
            "question":params["message"],"elicitation":{"server":server,"mode":params["mode"].as_str().unwrap_or("form"),
            "message":params["message"],"url":params.get("url"),"schema":params.get("requestedSchema"),
            "expires_at":crate::util::iso(chrono::Utc::now()+chrono::Duration::from_std(duration)?)}});
        self.requests.pin().insert(id.clone(),Arc::new(Pending {org:caller.org_id,agent:caller.agent_id,card,
            deadline:tokio::time::Instant::now()+duration,reply,_capacity:permit}));
        Ok((id,rx))
    }
    /// Called only by the authenticated desktop answer route. No field values
    /// are returned to the HTTP caller or saved in the request-card history.
    #[nolog]
    pub fn resolve(&self, org:i64, id:&str, answer:&Value) -> Result<Value> {
        let pending=self.requests.pin().get(id).filter(|p|p.org==org).cloned().ok_or_else(||anyhow::anyhow!("MCP request expired or already answered"))?;
        if tokio::time::Instant::now()>=pending.deadline {bail!("MCP request expired")}
        let action=answer["action"].as_str().unwrap_or("");
        if !["accept","decline","cancel"].contains(&action) {bail!("choose Accept, Decline or Cancel")}
        let mut result=json!({"action":action});
        if action=="accept" && pending.card["elicitation"]["mode"]!="url" {
            validate_content(&pending.card["elicitation"]["schema"],&answer["content"])?;
            result["content"]=answer["content"].clone();
        }
        let taken=self.requests.pin().remove(id).cloned().ok_or_else(||anyhow::anyhow!("MCP request expired or already answered"))?;
        taken.reply.send(result).map_err(|_|anyhow::anyhow!("MCP request is no longer connected"))?;
        Ok(json!({"answered":id,"node":pending.card["node"]}))
    }
}

struct Cleanup {engine:Arc<Engine>,org:i64,agent:i64,id:String}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.engine.elicitations.requests.pin().remove(&self.id);
        changes::notify_id(&self.engine,self.org,vec![Change::Asks,Change::Agent(self.agent)]);
    }
}
#[nolog]
pub async fn request(engine:&Arc<Engine>,caller:&Caller,params:&Value,stop:&CancellationToken) -> Value {
    wait(engine,caller,params,stop,TIMEOUT).await
}
#[nolog]
async fn wait(engine:&Arc<Engine>,caller:&Caller,params:&Value,stop:&CancellationToken,duration:Duration)->Value {
    if stop.is_cancelled() || engine.shutdown.is_cancelled() {return json!({"action":"cancel"})}
    let Ok((id,mut rx))=engine.elicitations.start(caller,params,duration) else {
        // Fail closed without exposing the request (or answers) in diagnostics.
        tracing::warn!(agent=caller.agent_id,"unsupported or over-capacity MCP elicitation");
        return json!({"action":"decline"})
    };
    let _cleanup=Cleanup {engine:engine.clone(),org:caller.org_id,agent:caller.agent_id,id};
    changes::notify_id(engine,caller.org_id,vec![Change::Asks,Change::Agent(caller.agent_id)]);
    tokio::select! {
        biased;
        _=stop.cancelled()=>json!({"action":"cancel"}),
        _=engine.shutdown.cancelled()=>json!({"action":"cancel"}),
        _=tokio::time::sleep(duration)=>json!({"action":"decline"}),
        value=rx.recv()=>value.unwrap_or_else(||json!({"action":"cancel"})),
    }
}

#[nolog]
fn safe_url(value:&Value)->bool {
    value.as_str().and_then(|s|reqwest::Url::parse(s).ok()).is_some_and(|u|
        ["http","https"].contains(&u.scheme()) && u.host_str().is_some() && u.username().is_empty() && u.password().is_none())
}
#[nolog]
fn choices(schema:&Value)->Option<Vec<&Value>> {
    schema["enum"].as_array().map(|a|a.iter().collect()).or_else(||
        schema["oneOf"].as_array().or(schema["anyOf"].as_array()).map(|a|a.iter().map(|x|&x["const"]).collect()))
}
#[nolog]
fn check_schema(schema:&Value)->Result<()> {
    let fields=schema["properties"].as_object().filter(|p|p.len()<=32).ok_or_else(||anyhow::anyhow!("expected bounded form properties"))?;
    if schema["type"]!="object" {bail!("expected object form")}
    if schema.get("required").is_some_and(|r|!r.is_null() && !r.as_array().is_some_and(|a|a.iter().all(|n|n.as_str().is_some_and(|n|fields.contains_key(n))))) {bail!("invalid required fields")}
    for field in fields.values() {
        match field["type"].as_str() {
            Some("string"|"boolean"|"number"|"integer")=>{},
            Some("array") if choices(&field["items"]).is_some()=>{},
            _=>bail!("unsupported MCP form field"),
        }
        if let Some(options)=choices(if field["type"]=="array" {&field["items"]} else {field}) {
            if options.is_empty() || options.len()>128 || options.iter().any(|v|!v.is_string()) {bail!("invalid form choices")}
        }
    }
    Ok(())
}
#[nolog]
fn validate_content(schema:&Value,content:&Value)->Result<()> {
    if content.to_string().len()>65536 {bail!("form answer too large")}
    let values=content.as_object().ok_or_else(||anyhow::anyhow!("form content must be an object"))?;
    let fields=schema["properties"].as_object().ok_or_else(||anyhow::anyhow!("missing form fields"))?;
    if values.keys().any(|k|!fields.contains_key(k)) {bail!("unexpected form field")}
    if schema["required"].as_array().is_some_and(|a|a.iter().any(|k|!values.contains_key(k.as_str().unwrap_or("")))) {bail!("complete all required fields")}
    for (key,value) in values {
        let field=&fields[key];
        let valid=match field["type"].as_str() {
            Some("string")=>value.as_str().is_some_and(|s|{
                let n=s.chars().count() as u64;
                !field["minLength"].as_u64().is_some_and(|m|n<m) && !field["maxLength"].as_u64().is_some_and(|m|n>m)
                && match field["format"].as_str() {
                    Some("uri")=>reqwest::Url::parse(s).is_ok(),
                    Some("email")=>s.split_once('@').is_some_and(|(a,b)|!a.is_empty() && b.contains('.') && !s.chars().any(char::is_whitespace)),
                    Some("date")=>chrono::NaiveDate::parse_from_str(s,"%Y-%m-%d").is_ok(),
                    Some("date-time")=>chrono::DateTime::parse_from_rfc3339(s).is_ok(),
                    _=>true,
                }
            }),
            Some("boolean")=>value.is_boolean(),
            Some("number"|"integer")=>value.as_f64().is_some_and(|n|n.is_finite()
                && (field["type"]!="integer" || n.fract()==0.0)
                && !field["minimum"].as_f64().is_some_and(|m|n<m) && !field["maximum"].as_f64().is_some_and(|m|n>m)),
            Some("array")=>value.as_array().is_some_and(|a|{
                let n=a.len() as u64;
                let options=choices(&field["items"]).unwrap_or_default();
                !field["minItems"].as_u64().is_some_and(|m|n<m) && !field["maxItems"].as_u64().is_some_and(|m|n>m)
                    && a.iter().enumerate().all(|(i,v)|options.contains(&v) && !a[..i].contains(v))
            }),
            _=>false,
        };
        if !valid || choices(field).is_some_and(|a|!a.contains(&value)) {bail!("invalid value for form field {key}")}
    }
    Ok(())
}

#[cfg(test)]
mod elicitation_tests {
    use super::*;
    fn caller(org:i64)->Caller {Caller {org_id:org,org_slug:"fixture".into(),agent_id:7,name:"fixture".into()}}
    fn form()->Value {json!({"serverName":"synthetic-browser","threadId":"thread-1","turnId":null,"mode":"form",
        "message":"Allow synthetic page?","requestedSchema":{"type":"object","properties":{
        "allow":{"type":"boolean"},"count":{"type":"integer","minimum":1,"maximum":3},
        "choice":{"type":"string","oneOf":[{"const":"once","title":"This time"},{"const":"never","title":"No"}]},
        "many":{"type":"array","items":{"type":"string","enum":["a","b"]},"minItems":1,"maxItems":2},
        "note":{"type":"string","minLength":2,"maxLength":5}},"required":["allow"]}})}
    #[tokio::test]
    async fn elicitation_accept_is_typed_correlated_once_and_cross_org_is_refused() {
        let r=Registry::default();let (id,mut rx)=r.start(&caller(1),&form(),TIMEOUT).unwrap();
        assert_eq!(r.cards(1).len(),1);assert!(r.cards(2).is_empty());
        assert!(r.resolve(2,&id,&json!({"action":"accept","content":{"allow":true}})).is_err());
        assert!(r.resolve(1,&id,&json!({"action":"accept","content":{"allow":"true"}})).is_err());
        assert_eq!(r.cards(1).len(),1,"invalid submission keeps the request answerable");
        let content=json!({"allow":false,"count":2,"choice":"once","many":["a","b"],"note":"yes"});
        r.resolve(1,&id,&json!({"action":"accept","content":content})).unwrap();
        assert_eq!(rx.recv().await.unwrap(),json!({"action":"accept","content":content}));
        assert!(r.resolve(1,&id,&json!({"action":"accept","content":content})).is_err());
        assert!(r.cards(1).is_empty());
    }
    #[tokio::test]
    async fn elicitation_decline_cancel_do_not_forward_content_or_metadata() {
        let r=Registry::default();
        for action in ["decline","cancel"] {
            let (id,mut rx)=r.start(&caller(1),&form(),TIMEOUT).unwrap();
            r.resolve(1,&id,&json!({"action":action,"content":{"secret":"synthetic"},"_meta":{"private":"not forwarded"}})).unwrap();
            assert_eq!(rx.recv().await.unwrap(),json!({"action":action}));
        }
    }
    #[test]
    fn elicitation_validates_all_typed_fields_and_constraints_without_consuming_bad_answers() {
        let schema=form()["requestedSchema"].clone();
        for bad in [json!({}),json!({"allow":true,"extra":1}),json!({"allow":true,"count":0}),
            json!({"allow":true,"count":1.5}),json!({"allow":true,"choice":"other"}),
            json!({"allow":true,"many":["a","a"]}),json!({"allow":true,"many":[]}),
            json!({"allow":true,"note":"x"})] {assert!(validate_content(&schema,&bad).is_err());}
    }
    #[tokio::test]
    async fn elicitation_url_is_user_open_only_and_never_forwards_content() {
        let r=Registry::default();let mut p=form();p["mode"]=json!("url");p["url"]=json!("https://example.invalid/consent");p["elicitationId"]=json!("url-request");
        let (id,mut rx)=r.start(&caller(1),&p,TIMEOUT).unwrap();
        assert_eq!(r.cards(1)[0]["elicitation"]["url"],p["url"]);
        r.resolve(1,&id,&json!({"action":"accept","content":{"ignored":true}})).unwrap();
        assert_eq!(rx.recv().await.unwrap(),json!({"action":"accept"}));
        for url in ["javascript:alert(1)","file:///tmp/secret","https://user:pass@example.invalid/"] {
            p["url"]=json!(url);assert!(r.start(&caller(1),&p,TIMEOUT).is_err());
        }
    }
    #[tokio::test]
    async fn elicitation_timeout_shutdown_and_aborted_waiter_cleanup_are_bounded() {
        let engine=Engine::for_tests("C:/orgtree-build/compaction-cmds-sol/elicit-test".into());
        let stop=CancellationToken::new();
        assert_eq!(wait(&engine,&caller(1),&form(),&stop,Duration::from_millis(5)).await,json!({"action":"decline"}));
        assert!(engine.elicitations.cards(1).is_empty());
        stop.cancel();assert_eq!(wait(&engine,&caller(1),&form(),&stop,TIMEOUT).await,json!({"action":"cancel"}));
        let e=engine.clone();let task=tokio::spawn(async move {wait(&e,&caller(1),&form(),&CancellationToken::new(),TIMEOUT).await});
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(engine.elicitations.cards(1).len(),1);task.abort();let _=task.await;
        assert!(engine.elicitations.cards(1).is_empty());
        engine.shutdown.cancel();assert_eq!(wait(&engine,&caller(1),&form(),&CancellationToken::new(),TIMEOUT).await,json!({"action":"cancel"}));
    }
    #[tokio::test]
    async fn elicitation_simultaneous_requests_remain_independent_and_stale_answers_fail() {
        let r=Registry::default();let (a,mut ar)=r.start(&caller(1),&form(),TIMEOUT).unwrap();
        let (b,mut br)=r.start(&caller(1),&form(),TIMEOUT).unwrap();assert_ne!(a,b);
        r.resolve(1,&b,&json!({"action":"decline"})).unwrap();
        assert_eq!(br.recv().await.unwrap(),json!({"action":"decline"}));assert!(ar.try_recv().is_err());
        r.resolve(1,&a,&json!({"action":"cancel"})).unwrap();assert_eq!(ar.recv().await.unwrap(),json!({"action":"cancel"}));
        let (id,_)=r.start(&caller(1),&form(),Duration::ZERO).unwrap();
        assert!(r.resolve(1,&id,&json!({"action":"accept","content":{"allow":true}})).is_err());
    }
}
