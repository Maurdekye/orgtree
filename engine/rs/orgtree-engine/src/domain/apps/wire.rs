//! Portable app definitions and independent panel state. Bounds/defaults are
//! provisional for the 4.5.0 morning review; no permission travels in this wire.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const HTML_MAX: usize = 4 * 1024 * 1024;
pub const STATE_MAX: usize = 2 * 1024 * 1024;
pub const EVENT_MAX: usize = 64 * 1024;
pub const CAPABILITIES: &[&str] = &["org.read", "mail.send", "docket.write", "events.fire"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    #[serde(default)] pub description: String,
    pub html: String,
    #[serde(default = "empty")] pub initial_state: Value,
    #[serde(default)] pub capabilities: Vec<String>,
    #[serde(default = "width")] pub width: i32,
    #[serde(default = "height")] pub height: i32,
}

#[nolog] fn empty() -> Value { json!({}) }
#[nolog] fn width() -> i32 { 520 }
#[nolog] fn height() -> i32 { 420 }

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    #[serde(default = "floating")] pub mode: String,
    #[serde(default)] pub x: f64,
    #[serde(default)] pub y: f64,
    #[serde(default = "width")] pub width: i32,
    #[serde(default = "height")] pub height: i32,
    #[serde(default)] pub anchor: Option<String>,
}
#[nolog] fn floating() -> String { "float".into() }
impl Default for Placement {
    fn default() -> Self { Self { mode:floating(), x:40., y:40., width:width(), height:height(), anchor:None } }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    List { kind:Option<String>, app:Option<String>, after:Option<String>, limit:Option<i64> },
    AppGet { app:String },
    AppCreate { definition:Definition },
    AppUpdate { app:String, expected_rev:i64, definition:Definition },
    AppDelete { app:String, expected_rev:i64, #[serde(default)] delete_panels:bool },
    PanelOpen { app:Option<String>, panel:Option<String>, #[serde(default)] new:bool, label:Option<String> },
    PanelGet { panel:String },
    PanelUpdate { panel:String, expected_rev:i64, label:Option<String>, open:Option<bool>, placement:Option<Placement>, linked_agents:Option<Vec<String>> },
    PanelDuplicate { panel:String, expected_rev:i64 },
    PanelDelete { panel:String, expected_rev:i64 },
    StateSet { panel:String, expected_rev:i64, state:Value },
    StatePatch { panel:String, expected_rev:i64, patch:Value },
    Event { panel:String, name:String, payload:Value },
    Events { panel:String, after:Option<i64>, limit:Option<i64> },
}

// These arguments can contain private app HTML/state. Do not trace their values.
#[nolog]
pub fn parse(input:&Value) -> Result<Request> {
    serde_json::from_value(input.clone()).map_err(|e|crate::domain::UserError::BadRequest(format!("invalid Apps request: {e}")).into())
}
#[nolog]
pub fn text(value:&str, maximum:usize, label:&str, blank:bool) -> Result<()> {
    if (!blank && value.trim().is_empty()) || value.chars().count()>maximum || value.chars().any(char::is_control) {
        crate::refuse!(BadRequest,"{label} needs {}-{maximum} characters without control characters",if blank{0}else{1});
    }
    Ok(())
}
#[nolog]
pub fn bounded(value:&Value, maximum:usize, object:bool) -> Result<()> {
    if object && !value.is_object() { crate::refuse!(BadRequest,"panel state must be a JSON object"); }
    let mut stack=vec![(value,0usize)];
    while let Some((v,depth))=stack.pop() {
        if depth>64 { crate::refuse!(BadRequest,"JSON nesting exceeds 64 levels"); }
        match v { Value::Array(a)=>stack.extend(a.iter().map(|x|(x,depth+1))),
            Value::Object(o)=>stack.extend(o.values().map(|x|(x,depth+1))), _=>{} }
    }
    if serde_json::to_vec(value)?.len()>maximum { crate::refuse!(BadRequest,"JSON exceeds the {maximum}-byte limit"); }
    Ok(())
}
#[nolog]
pub fn definition(value:&Definition) -> Result<()> {
    text(&value.name,120,"app name",false)?; text(&value.description,1000,"description",true)?;
    if value.html.trim().is_empty() || value.html.len()>HTML_MAX { crate::refuse!(BadRequest,"HTML needs content up to 4 MiB"); }
    bounded(&value.initial_state,STATE_MAX,true)?;
    dimensions(value.width,value.height)?;
    let mut seen=std::collections::HashSet::new();
    for cap in &value.capabilities {
        if !CAPABILITIES.contains(&cap.as_str()) || !seen.insert(cap) { crate::refuse!(BadRequest,"unknown or duplicate app capability {cap}"); }
    }
    Ok(())
}
#[nolog]
pub fn dimensions(width:i32,height:i32) -> Result<()> {
    if !(160..=4096).contains(&width) || !(120..=4096).contains(&height) { crate::refuse!(BadRequest,"panel dimensions must be 160-4096 by 120-4096"); }
    Ok(())
}
#[nolog]
pub fn placement(value:&Placement) -> Result<()> {
    if !["float","screen","popout","canvas"].contains(&value.mode.as_str()) { crate::refuse!(BadRequest,"unknown panel placement"); }
    if !value.x.is_finite() || !value.y.is_finite() || value.x.abs()>10_000_000. || value.y.abs()>10_000_000. { crate::refuse!(BadRequest,"invalid panel coordinates"); }
    if value.anchor.is_some() && value.mode!="canvas" { crate::refuse!(BadRequest,"only canvas panels may attach to a node"); }
    dimensions(value.width,value.height)
}
/// RFC7396 merge patch, restricted to object state; validate before recursion.
#[nolog]
pub fn merge(state:&mut Value,patch:&Value) -> Result<()> {
    bounded(patch,STATE_MAX,true)?;
    #[nolog]
    fn apply(target:&mut Value,patch:&Value) {
        if let Value::Object(patch)=patch {
            if !target.is_object() {*target=json!({});}
            let target=target.as_object_mut().expect("object established");
            for (key,value) in patch {
                if value.is_null() {target.remove(key);} else {apply(target.entry(key.clone()).or_insert(Value::Null),value);}
            }
        } else {*target=patch.clone();}
    }
    apply(state,patch); bounded(state,STATE_MAX,true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn custom_apps_state_merge_preserves_independent_json_and_removes_keys() {
        let original=json!({"notes":{"a":1,"b":2},"keep":[1,2]});let mut copy=original.clone();
        merge(&mut copy,&json!({"notes":{"a":null,"c":3}})).unwrap();
        assert_eq!(copy,json!({"notes":{"b":2,"c":3},"keep":[1,2]}));assert_eq!(original["notes"]["a"],1);
        assert!(merge(&mut copy,&json!([])).is_err());
    }
    #[test] fn custom_apps_reject_oversize_state_and_unknown_authority_fields() {
        assert!(bounded(&json!({"x":"x".repeat(STATE_MAX)}),STATE_MAX,true).is_err());
        assert!(parse(&json!({"action":"panel_get","panel":"p","org":"foreign"})).is_err());
        assert!(parse(&json!({"action":"panel_get","panel":"p","as_user":true})).is_err());
        assert!(parse(&json!({"action":"state_set","panel":"p","state":{}})).is_err());
    }
    #[test] fn custom_apps_declarations_cannot_request_general_user_authority() {
        let mut def:Definition=serde_json::from_value(json!({"name":"Editor","html":"<p>hello</p>"})).unwrap();
        definition(&def).unwrap();
        for cap in ["ops","publish","questions.answer","http.fetch"] {def.capabilities=vec![cap.into()];assert!(definition(&def).is_err());}
        def.capabilities=vec!["mail.send".into(),"mail.send".into()];assert!(definition(&def).is_err());
        let mut p=Placement::default();p.mode="canvas".into();p.anchor=Some("lead".into());placement(&p).unwrap();
        p.x=f64::INFINITY;assert!(placement(&p).is_err());
    }
}
