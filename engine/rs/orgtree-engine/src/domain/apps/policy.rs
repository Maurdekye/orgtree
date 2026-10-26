//! USER2026-10-26: every created/imported app has org-internal authority.
//! Policy is origin/capability-specific; explicit restrictive choices win.
use anyhow::Result;
use serde_json::{json,Value};
pub const ORG_CAPABILITIES:&[&str]=&["org.read","mail.send","events.fire","docket.write","files.read","files.write"];
#[nolog]pub fn default_allowed(value:&Value,cap:&str)->bool{
    // Deliberately explicit origin table so a later origin/capability ruling
    // changes one policy, not scattered grants or stored user decisions.
    matches!(value["origin"].as_str(),Some("created"|"imported"|"template"|"legacy"))&&ORG_CAPABILITIES.contains(&cap)
}
#[nolog]pub fn available(value:&Value,cap:&str)->bool{default_allowed(value,cap)||value["capabilities"].as_array().is_some_and(|a|a.iter().any(|v|v==cap))}
#[nolog]pub fn org_allowed(value:&Value,cap:&str)->bool{
    available(value,cap)&&match value["permissions"][cap].as_str(){Some("allow")=>true,Some(_)=>false,None=>default_allowed(value,cap)}
}
#[nolog]pub fn decision(value:&Value,cap:&str)->Result<&'static str>{
    if !available(value,cap){crate::refuse!(Forbidden,"app does not declare capability {cap}");}
    match value["permissions"][cap].as_str(){Some("deny")=>crate::refuse!(Forbidden,"app capability {cap} is denied"),Some("ask")=>Ok("ask"),Some("allow")=>Ok("allow"),Some(_)=>crate::refuse!(Forbidden,"app capability {cap} is denied"),None=>Ok(if default_allowed(value,cap){"allow"}else{"ask"})}
}
#[nolog]pub fn metadata(mut value:Value)->Value{
    let mut defaults=serde_json::Map::new();for cap in ORG_CAPABILITIES{if default_allowed(&value,cap){defaults.insert((*cap).into(),json!("allow"));}}
    value["default_permissions"]=Value::Object(defaults);value
}
#[nolog]pub fn restrictive_overrides(value:&Value)->Value{
    Value::Object(value.as_object().into_iter().flatten().filter(|(_,v)|matches!(v.as_str(),Some("ask"|"deny"))).map(|(k,v)|(k.clone(),v.clone())).collect())
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn custom_apps_origin_policy_separates_defaults_from_user_choices(){
        for origin in ["created","imported","template","legacy"]{let mut v=json!({"origin":origin,"capabilities":[],"permissions":{}});for cap in ORG_CAPABILITIES{assert!(org_allowed(&v,cap));}v["permissions"]["mail.send"]=json!("deny");assert!(!org_allowed(&v,"mail.send"));assert!(decision(&v,"mail.send").is_err());v["permissions"]["files.write"]=json!("ask");assert!(!org_allowed(&v,"files.write"));assert_eq!(decision(&v,"files.write").unwrap(),"ask");}
        assert!(!org_allowed(&json!({"origin":"forged"}),"org.read"));assert!(!default_allowed(&json!({"origin":"created"}),"files.computer"));
        assert_eq!(restrictive_overrides(&json!({"mail.send":"deny","events.fire":"ask","files.read":"allow"})),json!({"mail.send":"deny","events.fire":"ask"}));
    }
    // USER 2026-10-26 "Remove; import, never grant": an old declaration or stored grant
    // never allows mail.send, and app metadata no longer shows it.
    #[test]fn custom_apps_never_grant_the_removed_mail_send(){
        assert!(!ORG_CAPABILITIES.contains(&"mail.send"));
        for origin in ["created","imported","template","legacy"]{let v=json!({"origin":origin,"capabilities":["mail.send"],"permissions":{"mail.send":"allow"}});assert!(!org_allowed(&v,"mail.send"),"{origin}");assert!(decision(&v,"mail.send").is_err(),"{origin}");}
        let out=metadata(json!({"origin":"created","capabilities":["mail.send","files.read"],"permissions":{"mail.send":"allow","files.read":"deny"},"definition":{"capabilities":["mail.send"]}}));
        assert_eq!(out["capabilities"],json!(["files.read"]));assert_eq!(out["permissions"],json!({"files.read":"deny"}));assert_eq!(out["definition"]["capabilities"],json!([]));assert!(out["default_permissions"].get("mail.send").is_none());
    }
}
