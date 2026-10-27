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
/// IDs one refs read resolves for mention chips (apps and panels together).
pub const REFS_MAX: usize = 64;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventDeclaration {
    pub name: String,
    #[serde(default)] pub description: String,
}
pub const CAPABILITIES: &[&str] = &["org.read", "docket.write", "events.fire", "files.read", "files.write", "net.fetch"];
/// Capabilities older definitions may still declare (user 2026-10-26: "Remove;
/// import, never grant"): accepted on input so the app imports and runs, then
/// dropped before storage and from app metadata. Never granted.
pub const RETIRED_CAPABILITIES: &[&str] = &["mail.send"];
/// A log page reads one way: after (newer rows) or before (older rows).
pub const BOTH_CURSORS: &str = "pass after (newer rows) or before (older rows), not both";
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
    /// Hosts the app's net.fetch may reach, inert until the user grants them.
    /// Each is a host, host:port, or `*` (any site); `*.` leads a subdomain
    /// wildcard. Portable like events; grants nothing. Omitted when empty, so
    /// an export without sites still imports into an older Orgtree.
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub sites: Vec<String>,
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
    /// Mention chips (@app:, @panel:): the current names of these exact IDs,
    /// and only what an Apps menu row shows. IDs not in this org are left out.
    Refs { #[serde(default)] apps:Vec<String>, #[serde(default)] panels:Vec<String> },
    MarkSeen { apps:Vec<String> },
    AppExport { app:String, expected_rev:i64, #[serde(default)] include_panels:bool },
    AppImport { bundle:Bundle },
    /// site: one internet (net.fetch) row: a declared site, or a host a declared
    /// wildcard covers; "default" removes that row.
    PermissionSet { app:String, expected_rev:i64, expected_permission_rev:i64, capability:String, permission:String, #[serde(default)] site:Option<String> },
    /// The app-level Permission history (latest 128 retained), paged like Events:
    /// newest first, before walking back; after reads newer entries oldest first.
    PermissionHistory { app:String, after:Option<i64>, before:Option<i64>, limit:Option<i64> },
    /// slug: the id asked for (migration 0075), cleaned and suffixed like a
    /// name; without one the name makes it.
    AppCreate { definition:Definition, #[serde(default)] slug:Option<String> },
    AppUpdate { app:String, expected_rev:i64, definition:Definition },
    AppDelete { app:String, expected_rev:i64, #[serde(default)] delete_panels:bool },
    /// slug: the id asked for a NEW copy; without one its app and label make it.
    /// closed creates a fresh powered-off copy, also for the desktop. Omitted
    /// preserves the desktop's show/start default; agents always create closed.
    PanelOpen { app:Option<String>, panel:Option<String>, #[serde(default)] new:bool, #[serde(default)] closed:bool, label:Option<String>, #[serde(default)] slug:Option<String> },
    PanelGet { panel:String },
    PanelUpdate { panel:String, expected_rev:i64, label:Option<String>, open:Option<bool>, placement:Option<Placement> },
    PanelDuplicate { panel:String, expected_rev:i64 },
    PanelDelete { panel:String, expected_rev:i64 },
    StateSet { panel:String, expected_rev:i64, state:Value },
    StatePatch { panel:String, expected_rev:i64, patch:Value },
    Event { panel:String, name:String, payload:Value },
    /// History by default; messages:true lists the event action's and orgtree.emit's messages.
    /// Newest first, before walking back; after reads newer rows oldest first. name keeps
    /// one event's rows: its fires in History, or the messages with that name.
    Events { panel:String, after:Option<i64>, before:Option<i64>, limit:Option<i64>, #[serde(default)] messages:bool, #[serde(default)] name:Option<String> },
    FireEvent { panel:String, name:String, payload:Value },
    Listeners { app:String, panel:Option<String>, after:Option<i64>, limit:Option<i64> },
    /// One listener's (owner/id, as listeners shows it) finished deliveries, paged like Events.
    ListenerFires { app:String, listener:String, after:Option<i64>, before:Option<i64>, limit:Option<i64> },
}

// These arguments can contain private app HTML/state. Do not trace their values.
#[nolog]
pub fn parse(input:&Value) -> Result<Request> {
    // Panel links were removed (user 2026-10-26); tell a stale caller where to go.
    if input.get("linked_agents").is_some(){crate::refuse!(BadRequest,"panel links were removed; agents follow a panel's declared events with an app_listener watchdog");}
    // An app or panel is named once, when it is made (migration 0075): a slug
    // anywhere else is refused, and a blank one is no slug at all. Read as
    // orgtree_present reads its own (docs::requested_slug); the database cleans
    // and suffixes it.
    let slug=crate::domain::docs::requested_slug(input)?.map(str::to_owned);
    let mut input=input.clone();
    if let Some(map)=input.as_object_mut(){
        if slug.is_some()&&!matches!(map.get("action").and_then(Value::as_str),Some("app_create"|"panel_open")){
            crate::refuse!(BadRequest,"slug names a new app (app_create) or a new panel (panel_open) only: an app or panel keeps its slug once made");
        }
        if slug.is_some()&&map.get("panel").is_some_and(|p|!p.is_null()){
            crate::refuse!(BadRequest,"slug names a new panel only: an existing panel keeps its slug, so leave slug out when you pass panel");
        }
        map.remove("slug");
    }
    let mut request:Request=serde_json::from_value(input).map_err(|e|crate::domain::UserError::BadRequest(format!("invalid Apps request: {e}")))?;
    match &mut request{Request::AppCreate{slug:s,..}|Request::PanelOpen{slug:s,..}=>*s=slug,_=>{}}
    if let Request::AppImport{bundle:value}=&request{bundle(value)?;}
    if matches!(&request,Request::Events{after:Some(_),before:Some(_),..}|Request::PermissionHistory{after:Some(_),before:Some(_),..}|Request::ListenerFires{after:Some(_),before:Some(_),..}){crate::refuse!(BadRequest,"{BOTH_CURSORS}");}
    if let Request::ListenerFires{listener,..}=&request{text(listener,200,"listener",false)?;}
    if let Request::Events{name:Some(name),..}=&request{text(name,80,"event name",false)?;}
    if let Request::MarkSeen{apps}=&request{
        if apps.is_empty()||apps.len()>200{crate::refuse!(BadRequest,"mark_seen needs1-200 explicit app IDs");}
        let mut seen=std::collections::HashSet::new();
        for id in apps{text(id,120,"app ID",false)?;if !seen.insert(id){crate::refuse!(BadRequest,"mark_seen app IDs must be unique");}}
    }
    if let Request::Refs{apps,panels}=&request{
        let n=apps.len()+panels.len();
        if n==0||n>REFS_MAX{crate::refuse!(BadRequest,"refs needs 1-{REFS_MAX} app or panel IDs");}
        for id in apps.iter().chain(panels){text(id,120,"app or panel ID",false)?;}
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
    if value.sites.len()>super::net::SITES_MAX {crate::refuse!(BadRequest,"at most {} declared sites",super::net::SITES_MAX);}
    let mut hosts=std::collections::HashSet::new();
    for site in &value.sites {
        super::net::valid_site(site)?;
        if !hosts.insert(site) {crate::refuse!(BadRequest,"declared sites must be unique");}
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
    #[test] fn custom_apps_history_pages_newest_first_and_follows_new_rows() {
        // User 2026-10-27 md2006b10cf40 ("reload in realtime", "lazily load as you
        // scroll down"): History reads newest first, before walks back to older rows
        // and after follows newer ones; a page reads one way.
        assert!(parse(&json!({"action":"events","panel":"p","before":9,"limit":50})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","after":9,"limit":50})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","after":3,"before":9})).is_err());
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();
        assert_eq!(card["inputSchema"]["properties"]["before"]["type"],"integer");
    }
    #[test] fn custom_apps_history_reads_one_event_by_name() {
        // User 2026-10-27 m46d1f8a8e39e: "selecting an event shows that per-event fire
        // history as a lazily-loading, scrollable list". events takes the event name
        // the event and fire_event actions take, paged and checked the same way.
        assert!(parse(&json!({"action":"events","panel":"p","name":"submitted","before":9,"limit":50})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","name":"submitted","after":9})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","name":"submitted","messages":true})).is_ok());
        assert!(parse(&json!({"action":"events","panel":"p","name":null})).is_ok(),"null is no filter");
        for name in [json!(" "),json!("x".repeat(81)),json!("a
b"),json!(7)]{
            assert!(parse(&json!({"action":"events","panel":"p","name":name})).is_err(),"{name} is no event name");
        }
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();
        assert!(card["inputSchema"]["properties"]["name"]["description"].as_str().unwrap().contains("events:"),"the card says events reads one event by name");
    }
    #[test] fn custom_apps_listener_fires_page_like_history_and_name_one_listener() {
        // User 2026-10-27 m8ced6e920f63: a Connections row expands to its recent
        // fires, lazily paged; md11c3c790acf: the rows follow changes live.
        assert!(parse(&json!({"action":"listener_fires","app":"notes","listener":"worker/notes","before":9,"limit":50})).is_ok());
        assert!(parse(&json!({"action":"listener_fires","app":"notes","listener":"worker/notes","after":9})).is_ok());
        let both=parse(&json!({"action":"listener_fires","app":"notes","listener":"worker/notes","after":3,"before":9})).err().unwrap().to_string();
        assert!(both.contains("not both"),"{both}");
        assert!(parse(&json!({"action":"listener_fires","app":"notes","listener":" "})).is_err(),"a blank listener names nothing");
        assert!(parse(&json!({"action":"listener_fires","app":"notes"})).is_err(),"the listener is required");
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();let p=&card["inputSchema"]["properties"];
        assert!(p["action"]["enum"].as_array().unwrap().iter().any(|v|v=="listener_fires"),"agents read the same fires (tool parity)");
        assert_eq!(p["listener"]["type"],"string");
        assert!(p["before"]["description"].as_str().unwrap().contains("listener_fires"));
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

#[cfg(test)] mod internet_access {
    use serde_json::json;
    // USER 2026-10-26 m95c57abc95fb; design m232e1d1ccb57: sites are portable,
    // inert declarations (max 32); grants stay local and never travel.
    #[test] fn custom_apps_declared_sites_are_bounded_portable_and_grant_nothing(){
        let raw=json!({"name":"Feed","html":"<p>feed</p>","capabilities":["net.fetch"],"sites":["api.example.com","*.example.org","*"]});
        let def:super::Definition=serde_json::from_value(raw.clone()).unwrap();super::definition(&def).unwrap();
        assert_eq!(serde_json::to_value(&def).unwrap()["sites"],raw["sites"],"sites travel in exports");
        let check=|sites:serde_json::Value|{let mut v=raw.clone();v["sites"]=sites;serde_json::from_value::<super::Definition>(v).is_ok_and(|d|super::definition(&d).is_ok())};
        assert!(!check(json!(["api.example.com","api.example.com"])),"duplicates");
        assert!(!check(json!(["https://api.example.com"])),"a scheme");
        assert!(!check(json!((0..33).map(|i|format!("s{i}.example.com")).collect::<Vec<_>>())),"more than 32");
        assert!(check(json!((0..32).map(|i|format!("s{i}.example.com")).collect::<Vec<_>>())));
        let legacy:super::Definition=serde_json::from_value(json!({"name":"Old","html":"<p>old</p>"})).unwrap();assert!(legacy.sites.is_empty());
        for (key,value) in [("site_permissions",json!({"api.example.com":"allow"})),("permissions",json!({"net.fetch":"allow"}))]{
            let mut bad=json!({"format":"orgtree-app","version":1,"definition":raw.clone()});bad["definition"][key]=value;assert!(super::parse(&json!({"action":"app_import","bundle":bad})).is_err(),"{key} never imports");
        }
    }
    #[test] fn custom_apps_permission_history_pages_like_history(){
        // User 2026-10-27 m838e66af753b "ssme for permission history": the same
        // newest-first pages with before, and after for newer entries.
        assert!(super::parse(&json!({"action":"permission_history","app":"a","before":9,"limit":50})).is_ok());
        assert!(super::parse(&json!({"action":"permission_history","app":"a","after":3,"limit":200})).is_ok());
        assert!(super::parse(&json!({"action":"permission_history","app":"a","after":3,"before":9})).is_err());
    }
    #[test] fn custom_apps_site_permissions_and_history_have_explicit_vocabulary(){
        assert!(super::parse(&json!({"action":"permission_set","app":"a","expected_rev":1,"expected_permission_rev":1,"capability":"net.fetch","permission":"deny","site":"api.example.com"})).is_ok());
        assert!(super::parse(&json!({"action":"permission_set","app":"a","expected_rev":1,"expected_permission_rev":1,"capability":"net.fetch","permission":"ask"})).is_ok());
        assert!(super::parse(&json!({"action":"permission_history","app":"a","limit":128})).is_ok());
        let card=crate::tools::defs::list().into_iter().find(|c|c["name"]=="orgtree_apps").unwrap();let p=&card["inputSchema"]["properties"];
        assert!(p["action"]["enum"].as_array().unwrap().iter().any(|a|a=="permission_history"),"tool parity needs permission_history");
        assert!(p["capability"]["enum"].as_array().unwrap().iter().any(|a|a=="net.fetch"));
        assert!(p["definition"]["properties"]["capabilities"]["items"]["enum"].as_array().unwrap().iter().any(|a|a=="net.fetch"));
        assert_eq!(p["definition"]["properties"]["sites"]["maxItems"],32);
        assert!(p.get("site").is_some()&&p["permission"]["enum"].as_array().unwrap().iter().any(|a|a=="default"));
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
