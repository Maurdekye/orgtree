//! USER2026-10-26: every created/imported app has org-internal authority.
//! Policy is origin/capability-specific; explicit restrictive choices win.
use anyhow::Result;
use serde_json::{json,Value};
pub const ORG_CAPABILITIES:&[&str]=&["org.read","events.fire","docket.write","files.read","files.write"];
#[nolog]pub fn default_allowed(value:&Value,cap:&str)->bool{
    // Deliberately explicit origin table so a later origin/capability ruling
    // changes one policy, not scattered grants or stored user decisions.
    matches!(value["origin"].as_str(),Some("created"|"imported"|"template"|"legacy"))&&ORG_CAPABILITIES.contains(&cap)
}
/// A retired capability is never available, whatever an older definition declared.
#[nolog]pub fn available(value:&Value,cap:&str)->bool{!super::wire::RETIRED_CAPABILITIES.contains(&cap)&&(default_allowed(value,cap)||value["capabilities"].as_array().is_some_and(|a|a.iter().any(|v|v==cap)))}
#[nolog]pub fn org_allowed(value:&Value,cap:&str)->bool{
    available(value,cap)&&match value["permissions"][cap].as_str(){Some("allow")=>true,Some(_)=>false,None=>default_allowed(value,cap)}
}
#[nolog]pub fn decision(value:&Value,cap:&str)->Result<&'static str>{
    if !available(value,cap){crate::refuse!(Forbidden,"app does not declare capability {cap}");}
    match value["permissions"][cap].as_str(){Some("deny")=>crate::refuse!(Forbidden,"app capability {cap} is denied"),Some("ask")=>Ok("ask"),Some("allow")=>Ok("allow"),Some(_)=>crate::refuse!(Forbidden,"app capability {cap} is denied"),None=>Ok(if default_allowed(value,cap){"allow"}else{"ask"})}
}
#[nolog]fn strings(value:&Value)->Vec<&str>{value.as_array().into_iter().flatten().filter_map(Value::as_str).collect()}
/// Internet access (net.fetch) for one request host. USER 2026-10-26
/// m95c57abc95fb "build internet access as a permission for the apps"; design
/// accepted m232e1d1ccb57: off by default for every origin (net.fetch is not in
/// ORG_CAPABILITIES); the app declares its sites and anything else is refused
/// without a prompt; Deny wins, at the capability or on any row covering the
/// host; an Allow row covering the host allows; capability Allow ("Allow listed
/// sites") covers the declared sites but never any site (`*`), which needs its
/// own Allow. Everything else asks.
#[nolog]pub fn net_decision(value:&Value,host:&str,port:u16)->Result<&'static str>{
    use super::net::{site_key,site_matches,CAPABILITY};
    if !available(value,CAPABILITY){crate::refuse!(Forbidden,"app does not declare internet access (net.fetch)");}
    let covering:Vec<&str>=strings(&value["sites"]).into_iter().filter(|s|site_matches(s,host,port)).collect();
    if covering.is_empty(){crate::refuse!(Forbidden,"app does not declare the site {}; add it to the app's sites",site_key(host,port));}
    let capability=value["permissions"][CAPABILITY].as_str();
    if capability==Some("deny"){crate::refuse!(Forbidden,"internet access is denied for this app");}
    let rows:Vec<&str>=value["site_permissions"].as_object().into_iter().flatten().filter(|(site,_)|site_matches(site,host,port)).filter_map(|(_,v)|v.as_str()).collect();
    if rows.contains(&"deny"){crate::refuse!(Forbidden,"internet access to {} is denied for this app",site_key(host,port));}
    if rows.contains(&"allow"){return Ok("allow");}
    if rows.contains(&"ask"){return Ok("ask");}
    Ok(if capability==Some("allow")&&covering.iter().any(|s|*s!="*"){"allow"}else{"ask"})
}
/// The row a prompt answer is stored under: the exact declared site that covers
/// the host, as declared; otherwise the concrete host itself, a row of its own
/// under the `*.domain` or `*` declaration that covers it.
#[nolog]pub fn net_site(value:&Value,host:&str,port:u16)->String{
    strings(&value["sites"]).into_iter().find(|s|*s!="*"&&!s.starts_with("*.")&&super::net::site_matches(s,host,port)).map(str::to_owned).unwrap_or_else(||super::net::site_key(host,port))
}
/// A site row is a declared site, or a concrete host (no wildcard) that a
/// declared site covers.
#[nolog]pub fn net_row(value:&Value,site:&str)->Result<()>{
    super::net::valid_site(site)?;let sites=strings(&value["sites"]);
    if sites.contains(&site){return Ok(());}
    if site=="*"||site.starts_with("*."){crate::refuse!(BadRequest,"the app does not declare the site {site}");}
    let (host,port)=super::net::host_port(site)?;
    if !sites.iter().any(|s|super::net::site_matches(s,&host,port)){crate::refuse!(BadRequest,"the app does not declare a site that covers {site}");}Ok(())
}
#[nolog]pub fn metadata(mut value:Value)->Value{
    // A removed capability stays out of what agents and the desktop read, even
    // for apps stored before it was removed (user 2026-10-26).
    for key in ["capabilities","permissions"]{if let Some(v)=value.get_mut(key){super::wire::drop_retired(v);}}
    if let Some(v)=value.get_mut("definition").and_then(|d|d.get_mut("capabilities")){super::wire::drop_retired(v);}
    let mut defaults=serde_json::Map::new();for cap in ORG_CAPABILITIES{if default_allowed(&value,cap){defaults.insert((*cap).into(),json!("allow"));}}
    value["default_permissions"]=Value::Object(defaults);value
}
#[nolog]pub fn restrictive_overrides(value:&Value)->Value{
    Value::Object(value.as_object().into_iter().flatten().filter(|(_,v)|matches!(v.as_str(),Some("ask"|"deny"))).map(|(k,v)|(k.clone(),v.clone())).collect())
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn custom_apps_origin_policy_separates_defaults_from_user_choices(){
        for origin in ["created","imported","template","legacy"]{let mut v=json!({"origin":origin,"capabilities":[],"permissions":{}});for cap in ORG_CAPABILITIES{assert!(org_allowed(&v,cap));}v["permissions"]["docket.write"]=json!("deny");assert!(!org_allowed(&v,"docket.write"));assert!(decision(&v,"docket.write").is_err());v["permissions"]["files.write"]=json!("ask");assert!(!org_allowed(&v,"files.write"));assert_eq!(decision(&v,"files.write").unwrap(),"ask");}
        assert!(!org_allowed(&json!({"origin":"forged"}),"org.read"));assert!(!default_allowed(&json!({"origin":"created"}),"files.computer"));
        assert_eq!(restrictive_overrides(&json!({"mail.send":"deny","events.fire":"ask","files.read":"allow"})),json!({"mail.send":"deny","events.fire":"ask"}));
    }
    // USER 2026-10-26 "Remove; import, never grant": an old declaration or stored grant
    // never allows mail.send, and app metadata no longer shows it.
    // USER 2026-10-26 m95c57abc95fb; design m232e1d1ccb57 (Deny wins; any site
    // only by its own Allow; undeclared sites refused without a prompt).
    #[test]fn custom_apps_internet_access_is_off_by_default_per_site_and_deny_wins(){
        let base=|perms:Value,rows:Value|json!({"origin":"created","capabilities":["net.fetch"],"sites":["api.example.com","*.example.org","*"],"permissions":perms,"site_permissions":rows});
        let d=|v:&Value,h:&str|net_decision(v,h,443).map_err(|e|e.to_string());
        // Off for every origin, even with the declaration; never an org default.
        for origin in ["created","imported","template","legacy"]{let mut v=base(json!({}),json!({}));v["origin"]=json!(origin);assert_eq!(d(&v,"api.example.com").unwrap(),"ask","{origin}");assert!(!org_allowed(&v,"net.fetch"));}
        assert!(metadata(base(json!({}),json!({})))["default_permissions"].get("net.fetch").is_none());
        // Undeclared capability or site: refused, never asked.
        assert!(d(&json!({"origin":"created","capabilities":[],"sites":["api.example.com"]}),"api.example.com").unwrap_err().contains("does not declare internet access"));
        let only=json!({"origin":"created","capabilities":["net.fetch"],"sites":["api.example.com"],"permissions":{"net.fetch":"allow"}});
        assert!(d(&only,"other.example.com").unwrap_err().contains("does not declare the site other.example.com"));
        assert!(net_decision(&only,"api.example.com",8443).is_err(),"another port is another site");
        // Capability Allow covers listed sites, never any site.
        let listed=base(json!({"net.fetch":"allow"}),json!({}));
        assert_eq!(d(&listed,"api.example.com").unwrap(),"allow");assert_eq!(d(&listed,"a.example.org").unwrap(),"allow");assert_eq!(d(&listed,"elsewhere.net").unwrap(),"ask");
        // Any site needs its own Allow; a site Deny wins over it and over a wildcard Allow.
        assert_eq!(d(&base(json!({}),json!({"*":"allow"})),"elsewhere.net").unwrap(),"allow");
        assert!(d(&base(json!({}),json!({"*":"allow","evil.net":"deny"})),"evil.net").is_err());
        assert!(d(&base(json!({}),json!({"*.example.org":"allow","bad.example.org":"deny"})),"bad.example.org").unwrap_err().contains("denied"));
        assert!(d(&base(json!({}),json!({"*":"deny","api.example.com":"allow"})),"api.example.com").is_err(),"Deny wins over a narrower Allow too");
        // Capability Deny wins over every site Allow.
        assert!(d(&base(json!({"net.fetch":"deny"}),json!({"*":"allow","api.example.com":"allow"})),"api.example.com").unwrap_err().contains("denied for this app"));
        // An explicit Ask keeps asking under "Allow listed sites".
        assert_eq!(d(&base(json!({"net.fetch":"allow"}),json!({"api.example.com":"ask"})),"api.example.com").unwrap(),"ask");
        // Prompt answers: an exact declared site is its own row; a host under a
        // wildcard or any site gets a row of its own.
        let v=base(json!({}),json!({}));
        assert_eq!(net_site(&v,"api.example.com",443),"api.example.com");assert_eq!(net_site(&v,"a.example.org",443),"a.example.org");assert_eq!(net_site(&v,"x.net",8443),"x.net:8443");
        for ok in ["api.example.com","*.example.org","*","a.example.org","x.net:8443"]{assert!(net_row(&v,ok).is_ok(),"{ok}");}
        let narrow=json!({"sites":["api.example.com","*.example.org"]});
        for bad in ["other.com","*.other.com","*","example.org","Api.example.com"]{assert!(net_row(&narrow,bad).is_err(),"{bad}");}
    }
    #[test]fn custom_apps_never_grant_the_removed_mail_send(){
        assert!(!ORG_CAPABILITIES.contains(&"mail.send"));
        for origin in ["created","imported","template","legacy"]{let v=json!({"origin":origin,"capabilities":["mail.send"],"permissions":{"mail.send":"allow"}});assert!(!org_allowed(&v,"mail.send"),"{origin}");assert!(decision(&v,"mail.send").is_err(),"{origin}");}
        let out=metadata(json!({"origin":"created","capabilities":["mail.send","files.read"],"permissions":{"mail.send":"allow","files.read":"deny"},"definition":{"capabilities":["mail.send"]}}));
        assert_eq!(out["capabilities"],json!(["files.read"]));assert_eq!(out["permissions"],json!({"files.read":"deny"}));assert_eq!(out["definition"]["capabilities"],json!([]));assert!(out["default_permissions"].get("mail.send").is_none());
    }
}
