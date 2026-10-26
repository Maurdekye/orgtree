//! Portable app definitions and independent panel state. Bounds/defaults are
//! provisional for the 4.5.0 morning review; no permission travels in this wire.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const HTML_MAX: usize = 4 * 1024 * 1024;
pub const STATE_MAX: usize = 2 * 1024 * 1024;
pub const EVENT_MAX: usize = 64 * 1024;
pub const BUNDLE_MAX: usize = 16 * 1024 * 1024;
pub const BUNDLE_PANELS: usize = 16;
/// Provisional bounded event catalog; declarations carry no execution grant.
pub const DECLARED_EVENTS_MAX: usize = 64;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventDeclaration {
    pub name: String,
    #[serde(default)] pub description: String,
}
pub const CAPABILITIES: &[&str] = &["org.read", "docket.write", "events.fire", "files.read", "files.write"];
/// Capabilities older definitions may still declare (user 2026-10-26: "Remove;
/// import, never grant"): accepted on input so the app imports and runs, then
/// dropped before storage and from app metadata. Never granted.
pub const RETIRED_CAPABILITIES: &[&str] = &["mail.send"];
/// Why an app's mail.send call fails: apps reach agents only through events.
pub const MAIL_SEND_REMOVED: &str = "mail.send was removed: apps notify agents only through events. Declare the event, fire it with orgtree.events.fire(name, payload), and agents subscribe with an app_listener watchdog.";
/// The declared capabilities that are stored; retired ones are dropped.
#[nolog] pub fn current_capabilities(caps:&[String])->Vec<String>{caps.iter().filter(|c|CAPABILITIES.contains(&c.as_str())).cloned().collect()}
/// Drops retired capabilities from a stored capability list or permission map.
#[nolog] pub fn drop_retired(value:&mut Value){
    match value{
        Value::Array(caps)=>caps.retain(|c|!c.as_str().is_some_and(|c|RETIRED_CAPABILITIES.contains(&c))),
        Value::Object(map)=>{for cap in RETIRED_CAPABILITIES{map.remove(*cap);}},
        _=>{}
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    #[serde(default)] pub description: String,
    pub html: String,
    #[serde(default = "empty")] pub initial_state: Value,
    #[serde(default)] pub capabilities: Vec<String>,
    #[serde(default)] pub events: Vec<EventDeclaration>,
    #[serde(default = "width")] pub width: i32,
    #[serde(default = "height")] pub height: i32,
}

/// Provisional v1 portability: definition and optional DATA only. No IDs,
/// permissions, agent links, open state or machine geometry travel.
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub format:String,
    pub version:u32,
    pub definition:Definition,
    #[serde(default)] pub panels:Vec<PortablePanel>,
}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct PortablePanel {pub label:String,pub state:Value}
#[nolog]
pub fn bundle(value:&Bundle)->Result<()> {
    if value.format!="orgtree-app"||value.version!=1{crate::refuse!(BadRequest,"unsupported app bundle format/version; expected orgtree-app version1");}
    definition(&value.definition)?;
    if value.panels.len()>BUNDLE_PANELS{crate::refuse!(BadRequest,"at most16 saved panel states per app bundle");}
    for p in &value.panels{text(&p.label,120,"panel label",false)?;bounded(&p.state,STATE_MAX,true)?;}
    if serde_json::to_vec(value)?.len()>BUNDLE_MAX{crate::refuse!(BadRequest,"app bundle exceeds16MiB; export the definition without saved panels or reduce saved data");}
    Ok(())
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
    List { kind:Option<String>, app:Option<String>, after:Option<String>, limit:Option<i64>, open:Option<bool>, running:Option<bool> },
    /// Running copies with actual desktop state; sample asks for fresh CPU.
    Runtime { after:Option<String>, limit:Option<i64>, #[serde(default)] sample:bool },
    /// Starts a copy hidden; it never shows a window. Power changes carry no
    /// data, so expected_rev is optional: a running panel's saves bump it.
    PanelStart { panel:String, expected_rev:Option<i64> },
    /// Powers a copy off and hides it; expected_rev is optional as above.
    PanelStop { panel:String, expected_rev:Option<i64> },
    AppGet { app:String },
    MarkSeen { apps:Vec<String> },
    AppExport { app:String, expected_rev:i64, #[serde(default)] include_panels:bool },
    AppImport { bundle:Bundle },
    PermissionSet { app:String, expected_rev:i64, expected_permission_rev:i64, capability:String, permission:String },
    AppCreate { definition:Definition },
    AppUpdate { app:String, expected_rev:i64, definition:Definition },
    AppDelete { app:String, expected_rev:i64, #[serde(default)] delete_panels:bool },
    PanelOpen { app:Option<String>, panel:Option<String>, #[serde(default)] new:bool, label:Option<String> },
    PanelGet { panel:String },
    PanelUpdate { panel:String, expected_rev:i64, label:Option<String>, open:Option<bool>, placement:Option<Placement> },
    PanelDuplicate { panel:String, expected_rev:i64 },
    PanelDelete { panel:String, expected_rev:i64 },
    StateSet { panel:String, expected_rev:i64, state:Value },
    StatePatch { panel:String, expected_rev:i64, patch:Value },
    Event { panel:String, name:String, payload:Value },
    /// History by default; messages:true lists the event action's and orgtree.emit's messages.
    Events { panel:String, after:Option<i64>, limit:Option<i64>, #[serde(default)] messages:bool },
    FireEvent { panel:String, name:String, payload:Value },
    Listeners { app:String, panel:Option<String>, after:Option<i64>, limit:Option<i64> },
}

// These arguments can contain private app HTML/state. Do not trace their values.
#[nolog]
pub fn parse(input:&Value) -> Result<Request> {
    // Panel links were removed (user 2026-10-26); tell a stale caller where to go.
    if input.get("linked_agents").is_some(){crate::refuse!(BadRequest,"panel links were removed; agents follow a panel's declared events with an app_listener watchdog");}
    let request:Request=serde_json::from_value(input.clone()).map_err(|e|crate::domain::UserError::BadRequest(format!("invalid Apps request: {e}")))?;
    if let Request::AppImport{bundle:value}=&request{bundle(value)?;}
    if let Request::MarkSeen{apps}=&request{
        if apps.is_empty()||apps.len()>200{crate::refuse!(BadRequest,"mark_seen needs1-200 explicit app IDs");}
        let mut seen=std::collections::HashSet::new();
        for id in apps{text(id,120,"app ID",false)?;if !seen.insert(id){crate::refuse!(BadRequest,"mark_seen app IDs must be unique");}}
    }
    Ok(request)
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
    if value.events.len()>DECLARED_EVENTS_MAX {crate::refuse!(BadRequest,"at most64 declared app events");}
    let mut names=std::collections::HashSet::new();
    for event in &value.events {
        text(&event.name,80,"declared event name",false)?;text(&event.description,1000,"declared event description",true)?;
        if event.name.trim()!=event.name || !names.insert(&event.name) {crate::refuse!(BadRequest,"declared event names must be unique without surrounding whitespace");}
    }
    let mut seen=std::collections::HashSet::new();
    for cap in &value.capabilities {
        if !(CAPABILITIES.contains(&cap.as_str()) || RETIRED_CAPABILITIES.contains(&cap.as_str())) || !seen.insert(cap) { crate::refuse!(BadRequest,"unknown or duplicate app capability {cap}"); }
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
    // The pin pins to the window (user 2026-10-26: "i meant pin it to the window
    // like other pinned panels") and canvas pins were removed ("Remove canvas
    // pinning"); migration 0069 moved stored canvas pins to float. The anchor
    // field stays parseable as null for older clients but never attaches.
    if value.mode=="canvas" { crate::refuse!(BadRequest,"canvas pins were removed; use float (the centered window), window (pinned to the window) or popout"); }
    if value.mode=="screen" { crate::refuse!(BadRequest,"screen pins are now window pins; use window"); }
    if !["float","window","popout"].contains(&value.mode.as_str()) { crate::refuse!(BadRequest,"unknown panel placement"); }
    if !value.x.is_finite() || !value.y.is_finite() || value.x.abs()>10_000_000. || value.y.abs()>10_000_000. { crate::refuse!(BadRequest,"invalid panel coordinates"); }
    if value.anchor.is_some() { crate::refuse!(BadRequest,"panels no longer attach to nodes; canvas pins were removed"); }
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
    #[test] fn custom_apps_declared_publication_uses_explicit_scoped_requests() {
        assert!(parse(&json!({"action":"fire_event","panel":"copy","name":"submitted","payload":{"note":"data"}})).is_ok());
        assert!(parse(&json!({"action":"listeners","app":"app","panel":"copy","limit":200})).is_ok());
        for extra in [json!({"target":"chosen-recipient"}),json!({"as_user":true}),json!({"org":"other"})]{let mut bad=json!({"action":"fire_event","panel":"copy","name":"submitted","payload":{}});bad.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());assert!(parse(&bad).is_err());}
    }
    #[test] fn custom_apps_retired_links_and_canvas_pins_refuse_with_directions() {
        // User 2026-10-26: panel links are removed completely. The pin pins to
        // the window ("i meant pin it to the window") and canvas pins are gone
        // ("Remove canvas pinning"), so no panel attaches to a node either.
        let link=parse(&json!({"action":"panel_update","panel":"copy","expected_rev":1,"linked_agents":["worker"]})).err().unwrap().to_string();
        assert!(link.contains("app_listener"),"{link}");
        assert!(parse(&json!({"action":"panel_update","panel":"copy","expected_rev":1,"label":"Renamed"})).is_ok());
        let place=|mode:&str|placement(&Placement{mode:mode.into(),..Placement::default()});
        let canvas=place("canvas").err().unwrap().to_string();assert!(canvas.contains("canvas pins were removed")&&canvas.contains("window"),"{canvas}");
        let screen=place("screen").err().unwrap().to_string();assert!(screen.contains("use window"),"{screen}");
        for mode in ["float","window","popout"]{assert!(place(mode).is_ok(),"{mode}");}
        let anchored=placement(&Placement{mode:"window".into(),anchor:Some("lead".into()),..Placement::default()}).err().unwrap().to_string();
        assert!(anchored.contains("no longer attach"),"{anchored}");
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();let p=&card["inputSchema"]["properties"];
        assert!(p.get("linked_agents").is_none());assert_eq!(p["placement"]["properties"]["mode"]["enum"],json!(["float","window","popout"]));
        assert!(p["placement"]["properties"].get("anchor").is_none());
    }
    #[test] fn custom_apps_history_and_messages_are_read_apart() {
        // User 2026-10-26 md6edfebc1975: History holds only fired events agents can
        // listen to and the copy starting and stopping; mcbcd7b3cb6c0 "Keep, separate":
        // messages (the event action, orgtree.emit) keep their own listing.
        assert!(parse(&json!({"action":"events","panel":"p","messages":true})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","messages":"yes"})).is_err());
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();
        assert_eq!(card["inputSchema"]["properties"]["messages"]["type"],"boolean");
    }
    #[test] fn custom_apps_named_listener_has_explicit_tool_vocabulary() {
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_watchdog").unwrap();
        let p=&card["inputSchema"]["properties"];
        assert!(p["kind"]["enum"].as_array().unwrap().iter().any(|v|v=="app_listener"));
        for field in ["event_name","panel","all_panels"]{assert!(p.get(field).is_some(),"missing app_listener field {field}");}
    }
    #[test] fn custom_apps_event_declarations_are_portable_inert_manifest_data() {
        let raw=json!({"name":"Notes","html":"<p>notes</p>","events":[{"name":"submitted","description":"Notes ready for review"}]});
        let def:Definition=serde_json::from_value(raw.clone()).unwrap();definition(&def).unwrap();
        assert_eq!(serde_json::to_value(&def).unwrap()["events"],raw["events"]);
        let portable:Bundle=serde_json::from_value(json!({"format":"orgtree-app","version":1,"definition":raw})).unwrap();bundle(&portable).unwrap();
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();
        assert_eq!(card["inputSchema"]["properties"]["definition"]["properties"]["events"]["maxItems"],64);
    }
    #[test] fn custom_apps_event_declarations_reject_ambiguous_excess_or_authority_fields() {
        let clean=json!({"name":"Notes","html":"<p>notes</p>","events":[{"name":"submitted"}]});
        let check=|raw:Value|->bool{serde_json::from_value::<Definition>(raw).is_ok_and(|def|definition(&def).is_ok())};assert!(check(clean.clone()));
        for events in [json!([{"name":"submitted"},{"name":"submitted"}]),json!([{"name":" submitted"}]),json!([{"name":"submitted "}]),json!([{"name":"\n"}]),json!([{"name":"x".repeat(81)}]),json!([{"name":"x","description":"x".repeat(1001)}]),json!([{"name":"x","permission":"allow"}]),json!((0..65).map(|i|json!({"name":format!("event{i}")})).collect::<Vec<_>>())]{let mut bad=clean.clone();bad["events"]=events;assert!(!check(bad));}
        let mut legacy=clean;legacy.as_object_mut().unwrap().remove("events");assert!(check(legacy));
    }
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
        let mut p=Placement::default();p.mode="window".into();placement(&p).unwrap();
        p.x=f64::INFINITY;assert!(placement(&p).is_err());
    }
}

#[cfg(test)] mod portability_control {
    use super::*;
    #[test] fn custom_apps_portable_import_and_export_are_explicit_requests(){
        let bundle=json!({"format":"orgtree-app","version":1,"definition":{"name":"Notes","html":"<p>notes</p>","initial_state":{"note":"start"}},"panels":[{"label":"Saved notes","state":{"note":"saved"}}]});
        assert!(parse(&json!({"action":"app_import","bundle":bundle})).is_ok(),"agents and users need whole-app import");
        assert!(parse(&json!({"action":"app_export","app":"a","expected_rev":3,"include_panels":true})).is_ok(),"exports need an explicit optional saved-state choice");
    }
    #[test] fn custom_apps_portable_wire_never_accepts_execution_grants_or_machine_identity(){
        let clean=json!({"format":"orgtree-app","version":1,"definition":{"name":"Notes","html":"<p>notes</p>"}});
        assert!(parse(&json!({"action":"app_import","bundle":clean})).is_ok(),"positive import control");
        for (key,value) in [("permissions",json!({"mail.send":"allow"})),("session",json!("stolen")),("org",json!("other"))]{let mut bad=clean.clone();bad[key]=value;assert!(parse(&json!({"action":"app_import","bundle":bad})).is_err());}
        let mut bad=clean;bad["panels"]=json!([{"label":"Saved","state":{},"open":true,"linked_agents":["admin"],"placement":{"mode":"popout"}}]);assert!(parse(&json!({"action":"app_import","bundle":bad})).is_err());
    }
    #[test] fn custom_apps_portable_versions_counts_and_state_shapes_are_validated_before_storage(){
        let clean=json!({"format":"orgtree-app","version":1,"definition":{"name":"Notes","html":"<p>notes</p>"}});
        for value in [json!({"version":2}),json!({"format":"foreign-app"}),json!({"panels":vec![json!({"label":"copy","state":{}});17]}),json!({"panels":[{"label":"copy","state":[]} ]})]{let mut bad=clean.clone();bad.as_object_mut().unwrap().extend(value.as_object().unwrap().clone());assert!(parse(&json!({"action":"app_import","bundle":bad})).is_err());}
        let mut copy=clean;copy["panels"]=json!([{"label":"copy","state":{"permissions":{"mail.send":"allow"}}}]);assert!(parse(&json!({"action":"app_import","bundle":copy})).is_ok(),"a state key is data, never an execution grant");
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();
        for action in ["app_import","app_export"]{assert!(card["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().iter().any(|a|a==action));}
        for key in ["bundle","path","as_file","include_panels"]{assert!(card["inputSchema"]["properties"].get(key).is_some());}
    }
}

#[cfg(test)] mod runtime_control {
    use serde_json::json;
    // Power changes carry no data: a running panel's own state saves bump its
    // revision, so expected_rev is optional and checked only when given.
    #[test] fn custom_apps_power_controls_are_explicit_requests_with_optional_revision(){
        for ok in [json!({"action":"panel_start","panel":"p","expected_rev":3}),json!({"action":"panel_start","panel":"p"}),json!({"action":"panel_stop","panel":"p"}),json!({"action":"panel_stop","panel":"p","expected_rev":3}),json!({"action":"runtime","limit":50,"sample":true}),json!({"action":"list","kind":"panels","running":true})]{assert!(super::parse(&ok).is_ok(),"{ok}");}
        for bad in [json!({"action":"panel_start","panel":"p","expected_rev":3,"open":true}),json!({"action":"panel_stop","panel":"p","expected_rev":3,"as_user":true}),json!({"action":"runtime","org":"other"}),json!({"action":"panel_start","panel":"p","expected_rev":3,"generation":9})]{assert!(super::parse(&bad).is_err(),"{bad}");}
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();let actions=card["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        for action in ["panel_start","panel_stop","runtime"]{assert!(actions.iter().any(|a|a==action),"tool parity needs {action}");}
        for key in ["running","sample"]{assert!(card["inputSchema"]["properties"].get(key).is_some(),"tool parity needs {key}");}
    }
}

#[cfg(test)] mod permission_control {
    #[test] fn custom_apps_permission_changes_have_explicit_revision_checked_vocabulary() {
        assert!(super::parse(&serde_json::json!({"action":"permission_set","app":"a","expected_rev":1,"expected_permission_rev":1,"capability":"org.read","permission":"ask"})).is_ok());
        assert!(super::parse(&serde_json::json!({"action":"permission_set","app":"a","expected_rev":1,"capability":"org.read","permission":"allow","as_user":true})).is_err());
    }
}

#[cfg(test)] mod retired_capabilities {
    use serde_json::json;
    // USER 2026-10-26 "Remove; import, never grant": an old mail.send declaration still
    // validates, so the app imports and runs, but it is no capability any more.
    #[test] fn custom_apps_old_mail_send_declarations_still_import(){
        let def:super::Definition=serde_json::from_value(json!({"name":"Old","html":"<p>old</p>","capabilities":["mail.send","files.read"]})).unwrap();
        assert!(super::definition(&def).is_ok(),"an old declaration still imports");
        assert!(!super::CAPABILITIES.contains(&"mail.send"),"mail.send is no capability any more");
        assert_eq!(super::current_capabilities(&def.capabilities),vec!["files.read".to_string()],"the declaration is not stored");
        let (mut caps,mut grants)=(json!(["mail.send","events.fire"]),json!({"mail.send":"allow","events.fire":"deny"}));super::drop_retired(&mut caps);super::drop_retired(&mut grants);
        assert_eq!(caps,json!(["events.fire"]));assert_eq!(grants,json!({"events.fire":"deny"}));
    }
}
