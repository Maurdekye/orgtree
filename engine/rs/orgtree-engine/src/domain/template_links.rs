//! Portable template watchdog definitions and explicit directional audiences.
//! Never export runtime memo, credentials, credential paths or sealed secret rows.
use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::templates::{Include, Planned, Row, Template};
use crate::engine::Engine;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Dog {
    pub owner: String,
    pub args: Value,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub needs_credentials: bool,
}

impl std::fmt::Debug for Dog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("[template watchdog definition]") }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub grantee: String,
    pub grantor: String,
}

#[derive(Default)]
pub struct Plan {
    pub dogs: Vec<Dog>,
    pub audiences: Vec<Grant>,
    pub warnings: Vec<String>,
}

const FIELDS: &[&str] = &["name", "kind", "target", "pattern", "shell", "interval_s", "fire_mode", "quiet_period_s", "once", "notice",
    "threshold", "event_scope", "batch", "slots", "count", "fire_actions", "accounts", "windows", "usage_events", "threshold_percent",
    "payload_pattern", "retained", "hello", "protocols", "heartbeat", "connection_messages"];

#[nolog]
pub fn machine(kind: &str) -> bool { matches!(kind, "file" | "command" | "process" | "stream" | "mqtt" | "websocket") }

#[nolog]
fn node_target(kind: &str) -> bool { matches!(kind, "activity" | "fair_queue" | "slot" | "project_listener" | "listener_watch") }

/// Conservative guard for credential-bearing JSON, including nested fire actions.
/// Keys are checked before filtering so a credentials-file reference is never copied.
#[nolog]
fn secret(v: &Value) -> bool {
    match v {
        Value::Object(o) => o.iter().any(|(k, v)| (!v.is_null() && (k.eq_ignore_ascii_case("credentials")
            || super::watchdogs::CREDENTIAL_KEYS.iter().any(|key| k.eq_ignore_ascii_case(key))
            || ["api_key", "secret", "client_secret", "private_key", "client_key", "certificate", "ca", "cert"].iter().any(|key| k.eq_ignore_ascii_case(key)))) || secret(v)),
        Value::Array(a) => a.iter().any(secret),
        Value::String(s) => {
            // Unlike standing notes there is no per-string size limit here.
            static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            RE.get_or_init(|| regex::Regex::new(r#"(?im)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|bearer|authorization|cookie)\b[\s:=\"']+\S+|--(?:token|password|secret|api-key)(?:=|\s+)\S+|[a-z]+://[^/\s]+@|[?&](?:token|key|password|secret|auth|api_key)="#).unwrap()).is_match(s)
        }
        _ => false,
    }
}

/// Reject hand-edited documents that try to carry secret fields or runtime state.
#[nolog]
pub fn validate(d: &Dog) -> Result<(), String> {
    let args = d.args.as_object().ok_or("template watchdog args must be an object")?;
    if args.keys().any(|k| !FIELDS.contains(&k.as_str())) || secret(&d.args) {
        return Err("template watchdogs cannot carry credentials, credential-file paths, runtime state or unknown fields".into());
    }
    if !matches!(d.args["kind"].as_str(), Some("file" | "command" | "process" | "stream" | "mqtt" | "websocket" | "activity" | "fair_queue" | "slot" | "project_listener" | "listener_watch" | "event" | "usage")) {
        return Err("template watchdog kind is unknown".into());
    }
    if d.args["target"].as_str().is_none_or(str::is_empty) { return Err("template watchdog target is required".into()); }
    Ok(())
}

/// Convert just definition fields, never the watchdog inventory's display labels.
#[nolog]
pub fn saved_dog(raw: &Value, names: &HashMap<String, bool>, inc: &Include, warnings: &mut Vec<String>) -> Option<Dog> {
    let owner = raw["owner"].as_str().unwrap_or_default();
    let kind = raw["kind"].as_str().unwrap_or_default();
    if names.get(owner) != Some(&false) {
        warnings.push(format!("Dropped watchdog: owner {owner} is outside the saved agent layout.")); return None;
    }
    if machine(kind) && !inc.machine_watchdogs { return None; }
    let target = raw["target"].as_str().unwrap_or_default();
    if node_target(kind) && !names.contains_key(target.trim_start_matches('@')) {
        warnings.push(format!("Dropped watchdog owned by {owner}: its node target is outside the saved layout.")); return None;
    }
    let memo = &raw["memo"];
    let mut args = json!({});
    for key in ["name", "kind", "target", "pattern", "shell", "interval_s", "fire_mode", "quiet_period_s", "once"] {
        if let Some(v) = raw.get(key).filter(|v| !v.is_null()) { args[key] = v.clone(); }
    }
    for key in ["notice", "threshold", "event_scope", "batch", "slots", "count"] {
        if key == "event_scope" && !matches!(target, "agents.active" | "agents.live") { continue; }
        if let Some(v) = memo.get(key).filter(|v| !v.is_null()) { args[key] = v.clone(); }
    }
    if kind == "usage" {
        for key in ["accounts", "windows", "usage_events", "threshold_percent"] {
            if let Some(v) = memo["usage"].get(key).filter(|v| !v.is_null()) { args[key] = v.clone(); }
        }
    }
    let network = if kind == "websocket" { &memo["websocket"] } else { &memo["mqtt"] };
    let mut needs_credentials = memo["template_needs_credentials"] == true || network.get("credentials").is_some_and(|c| !c.is_null() && c["kind"].as_str().is_some_and(|k| k != "none"));
    if matches!(kind, "mqtt" | "websocket") {
        args["connection_messages"] = json!(super::watchdogs::connection_messages(memo));
        for key in if kind == "mqtt" { &["payload_pattern", "retained"][..] } else { &["hello", "protocols", "heartbeat"][..] } {
            if let Some(v) = network.get(*key).filter(|v| !v.is_null()) {
                if secret(v) { needs_credentials = true; } else { args[*key] = v.clone(); }
            }
        }
    }
    if let Some(actions) = memo["fire_actions"].as_array() {
        let kept: Vec<_> = actions.iter().filter(|a| !secret(a)).cloned().collect();
        if kept.len() != actions.len() {
            needs_credentials = true;
            warnings.push(format!("Watchdog owned by {owner}: removed credential-bearing fire actions; needs credentials and remains paused."));
        }
        if !kept.is_empty() { args["fire_actions"] = json!(kept); }
    }
    let d = Dog { owner: owner.into(), args, paused: raw["state"] == "paused", needs_credentials };
    if validate(&d).is_err() {
        warnings.push(format!("Dropped watchdog owned by {owner}: its definition contains credentials or unsupported fields.")); return None;
    }
    Some(d)
}

#[nolog]
pub fn remap_grant(g: &Grant, names: &HashMap<String, String>) -> Option<Grant> {
    let grantee = names.get(&g.grantee)?.clone();
    let grantor = match g.grantor.as_str() {
        "user" | "@user" => "@user".into(), "extern" | "@extern" => "@extern".into(),
        n => names.get(n)?.clone(),
    };
    Some(Grant { grantee, grantor })
}

#[nolog]
pub fn plan(t: &Template, planned: &[Planned]) -> Plan {
    let names: HashMap<_, _> = planned.iter().map(|p| (p.slot.name.clone(), p.name.clone())).collect();
    let mut out = Plan { warnings: t.warnings.clone(), ..Plan::default() };
    for d in &t.watchdogs {
        let Some(owner) = names.get(&d.owner) else { out.warnings.push(format!("Dropped watchdog: owner {} was left out.", d.owner)); continue; };
        let mut dog = d.clone(); dog.owner = owner.clone();
        if node_target(d.args["kind"].as_str().unwrap_or_default()) {
            let target = d.args["target"].as_str().unwrap_or_default().trim_start_matches('@');
            let Some(target) = names.get(target) else { out.warnings.push(format!("Dropped watchdog owned by {owner}: target was left out.")); continue; };
            dog.args["target"] = json!(target);
        }
        if dog.needs_credentials || machine(dog.args["kind"].as_str().unwrap_or_default()) || dog.paused {
            out.warnings.push(format!("Watchdog owned by {owner} remains paused: {}.", if dog.needs_credentials { "needs credentials; recreate with credentials before use" } else if dog.paused { "paused in the saved layout" } else { "machine-specific target needs checking before resume" }));
        }
        out.dogs.push(dog);
    }
    for g in &t.audiences {
        match remap_grant(g, &names) { Some(g) => out.audiences.push(g), None => out.warnings.push(format!("Dropped audience grant for {}: an endpoint is outside the layout.", g.grantee)) }
    }
    out
}

/// Active-only keyset reads. Size is checked as pages are attached, never truncated.
#[nolog]
pub async fn capture(engine: &Engine, org: i64, rows: &[Row], inc: &Include, t: &mut Value) -> anyhow::Result<()> {
    let names: HashMap<_, _> = rows.iter().map(|r| (r.name.clone(), r.tier == super::projects::TIER)).collect();
    let identity = names.keys().map(|n| (n.clone(), n.clone())).collect();
    let mut warnings = Vec::new();
    let client = engine.db.get().await?;
    if inc.watchdogs {
        let mut dogs = Vec::new(); let mut after = 0_i64;
        loop {
            let page = client.query("SELECT w.id, to_jsonb(w) || jsonb_build_object('owner', a.name) FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id=w.owner_agent_id WHERE w.org_id=$1 AND w.id>$2 AND w.state IN ('armed','paused') ORDER BY w.id LIMIT 200", &[&org, &after]).await?;
            if page.is_empty() { break; }
            for r in page { after = r.get(0); if let Some(d) = saved_dog(&r.get::<_, Value>(1), &names, inc, &mut warnings) { dogs.push(d); } }
            t["watchdogs"] = json!(dogs);
            size(t)?;
        }
    }
    if inc.audiences {
        let mut grants = Vec::new(); let mut after = 0_i64;
        loop {
            let page = client.query("SELECT id, grantee, grantor FROM ot.audiences WHERE org_id=$1 AND id>$2 AND revoked_at IS NULL AND NOT paused ORDER BY id LIMIT 200", &[&org, &after]).await?;
            if page.is_empty() { break; }
            for r in page {
                after = r.get(0);
                let g = Grant { grantee: r.get(1), grantor: r.get(2) };
                match remap_grant(&g, &identity) { Some(g) => grants.push(g), None => warnings.push("Dropped audience grant: an endpoint is outside the saved layout.".into()) }
            }
            t["audiences"] = json!(grants); size(t)?;
        }
    }
    if !warnings.is_empty() { t["warnings"] = json!(warnings); }
    size(t)
}

#[nolog]
fn size(t: &Value) -> anyhow::Result<()> {
    if serde_json::to_vec(t)?.len() as u64 > super::templates::FILE_MAX { crate::refuse!(Unprocessable, "template file exceeds the template size limit; include fewer groups"); }
    Ok(())
}

/// All rows exist, paused, before any eligible portable runner can start.
#[nolog]
pub async fn restore(engine: &Arc<Engine>, org: i64, plan: &Plan) -> Value {
    let mut warnings = plan.warnings.clone(); let mut staged = Vec::new(); let mut created = 0;
    for d in &plan.dogs {
        let result = async {
            validate(d).map_err(anyhow::Error::msg)?;
            let client = engine.db.get().await?;
            let owner: i64 = client.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND kind='agent' AND state='live'", &[&org, &d.owner]).await?.get(0);
            drop(client);
            crate::runtime::watchdogs::create_from_template(engine, org, owner, &d.args, d.needs_credentials).await
        }.await;
        match result {
            Ok(v) => {
                created += 1;
                if !d.paused && !d.needs_credentials && !machine(d.args["kind"].as_str().unwrap_or_default()) {
                    if let Some(id) = v["id"].as_str() { staged.push(super::watchdogs::handle(&d.owner, id)); }
                }
            }
            Err(e) => warnings.push(format!("Watchdog owned by {} could not be restored: {e}", d.owner)),
        }
    }
    for id in staged {
        if let Err(e) = crate::util::boxed(|| crate::runtime::watchdogs::act(engine, org, None, &id, "resume", Some("restored from template"))).await {
            warnings.push(format!("Watchdog {id} remains paused: {e}"));
        }
    }
    json!({ "created": created, "warnings": warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::templates::{self, Avail, Choices, Offer, SlotChoice};

    fn names() -> HashMap<String, bool> { HashMap::from([("lead".into(), false), ("worker".into(), false), ("work".into(), true)]) }

    fn raw(kind: &str, target: &str) -> Value {
        json!({"owner":"worker","name":"standing-watch","kind":kind,"target":target,"state":"armed","interval_s":30,"fire_mode":"event","once":true,"memo":{"notice":true,"run":{"offset":500,"last_output":"PRIVATE RUNTIME"},"target_id":999,"lease":"PRIVATE LEASE"},"events":["PRIVATE EVENT"]})
    }

    fn template() -> Template {
        serde_json::from_value(json!({"id":"fixture","name":"Fixture","agents":[{"name":"lead","tier":"sol","reports":[{"name":"work","tier":"project","reports":[{"name":"worker","tier":"sol"}]}]}]})).unwrap()
    }

    fn planned(t: &Template, ch: &Choices) -> Vec<Planned> {
        let mut av = Avail::default();
        av.tiers.insert("sol".into(), Offer { seat:2.0, provider:"openai".into(), accounts:vec![], default_ok:true, readings:HashMap::new() });
        templates::plan(t, ch, &av, &[]).unwrap().0
    }

    #[test]
    fn definitions_keep_modes_filters_and_drop_all_runtime_state() {
        let mut r = raw("activity", "lead");
        r["fire_mode"] = json!("silence"); r["quiet_period_s"] = json!(300);
        let mut warnings = vec![];
        let d = saved_dog(&r, &names(), &Include::default(), &mut warnings).unwrap();
        assert_eq!(d.args["once"], true); assert_eq!(d.args["notice"], true);
        assert_eq!(d.args["quiet_period_s"], 300); assert_eq!(d.args["fire_mode"], "silence");
        let encoded = serde_json::to_string(&d).unwrap();
        for absent in ["PRIVATE", "target_id", "offset", "lease", "events"] { assert!(!encoded.contains(absent), "{absent}"); }
        assert!(warnings.is_empty());
    }

    #[test]
    fn targets_and_audiences_follow_renames_and_missing_endpoints_are_listed() {
        let mut t = template(); let mut warnings = vec![];
        for kind in ["activity", "fair_queue", "slot", "project_listener", "listener_watch"] {
            t.watchdogs.push(saved_dog(&raw(kind, if kind == "activity" {"worker"} else {"work"}), &names(), &Include::default(), &mut warnings).unwrap());
        }
        t.watchdogs.push(saved_dog(&raw("event", "project.event"), &names(), &Include::default(), &mut warnings).unwrap());
        let mut usage = raw("usage", "usage"); usage["memo"]["usage"] = json!({"accounts":["openai-1"],"windows":["7 d"],"usage_events":["limit"]});
        t.watchdogs.push(saved_dog(&usage, &names(), &Include::default(), &mut warnings).unwrap());
        t.audiences = vec![Grant { grantee:"worker".into(), grantor:"lead".into() }, Grant { grantee:"work".into(), grantor:"worker".into() },
            Grant { grantee:"worker".into(), grantor:"@user".into() }, Grant { grantee:"worker".into(), grantor:"@extern".into() }, Grant { grantee:"worker".into(), grantor:"outside".into() }];
        let mut ch = Choices::default();
        ch.overrides.insert("worker".into(), SlotChoice { name:Some("builder".into()), tier:None, ..Default::default() });
        ch.overrides.insert("work".into(), SlotChoice { name:Some("jobs".into()), tier:None, ..Default::default() });
        let p = plan(&t, &planned(&t, &ch));
        assert_eq!(p.dogs.len(), 7); assert!(p.dogs.iter().all(|d| d.owner == "builder"));
        assert_eq!(p.dogs[0].args["target"], "builder");
        for d in &p.dogs[1..5] { assert_eq!(d.args["target"], "jobs"); }
        assert_eq!(p.dogs[5].args["target"], "project.event"); assert_eq!(p.dogs[6].args["target"], "usage");
        assert_eq!(p.dogs[6].args["accounts"], json!(["openai-1"]));
        assert_eq!(p.audiences.len(), 4); assert_eq!(p.audiences[1], Grant {grantee:"jobs".into(),grantor:"builder".into()});
        assert_eq!(p.audiences[2].grantor,"@user"); assert_eq!(p.audiences[3].grantor,"@extern"); assert_eq!(p.warnings.len(),1);
        ch.removed.push("worker".into());
        let removed = plan(&t, &planned(&t, &ch));
        assert!(removed.dogs.is_empty()); assert!(removed.audiences.is_empty()); assert_eq!(removed.warnings.len(),12);
        assert!(saved_dog(&raw("activity", "outside"), &names(), &Include::default(), &mut warnings).is_none());
        let mut outside = raw("event", "project.event"); outside["owner"] = json!("outside");
        assert!(saved_dog(&outside, &names(), &Include::default(), &mut warnings).is_none());
    }

    #[test]
    fn credentials_and_nested_credential_file_actions_are_never_serialized() {
        let mut r = raw("websocket", "wss://example.invalid/events");
        r["memo"]["websocket"] = json!({"credentials":{"kind":"file","path":"C:/PRIVATE-CREDENTIALS.json"},"hello":["hello"],"protocols":["json"],"heartbeat":{"message":"ping","every_s":10}});
        r["memo"]["fire_actions"] = json!([
            {"tool":"orgtree_status","args":{"status":"working","summary":"ready"}},
            {"tool":"orgtree_watchdog","args":{"fire_actions":[{"tool":"orgtree_watchdog","args":{"credentials":"C:/NESTED-CREDENTIALS.json"}}]}},
            {"tool":"orgtree_watchdog","args":{"credentials":{"bearer":"PRIVATE-BEARER"}}}
        ]);
        let inc = Include { machine_watchdogs:true, ..Include::default() }; let mut warnings = vec![];
        let d = saved_dog(&r, &names(), &inc, &mut warnings).unwrap();
        assert!(d.needs_credentials); assert_eq!(d.args["fire_actions"].as_array().unwrap().len(),1);
        let saved = serde_json::to_string(&d).unwrap();
        for forbidden in ["PRIVATE", "NESTED", "C:/", "bearer"] { assert!(!saved.contains(forbidden)); }
        assert_eq!(d.args["hello"], json!(["hello"])); assert_eq!(warnings.len(),1);
        r["memo"]["websocket"]["credentials"] = json!({"kind":"inline"});
        assert!(saved_dog(&r, &names(), &inc, &mut warnings).unwrap().needs_credentials);
        let mut injected = d.clone(); injected.args["credentials"] = json!("hidden.json");
        assert!(validate(&injected).is_err()); assert!(!format!("{injected:?}").contains("hidden.json"));
    }

    #[test]
    fn machine_dogs_require_opt_in_and_the_plan_keeps_them_paused() {
        let mut t = template(); let mut warnings = vec![];
        for kind in ["file", "command", "process", "stream", "mqtt", "websocket"] {
            let r = raw(kind, "machine-target");
            assert!(saved_dog(&r, &names(), &Include::default(), &mut warnings).is_none());
            t.watchdogs.push(saved_dog(&r, &names(), &Include { machine_watchdogs:true, ..Include::default() }, &mut warnings).unwrap());
        }
        let p = plan(&t, &planned(&t, &Choices::default()));
        assert_eq!(p.dogs.len(),6); assert_eq!(p.warnings.len(),6);
        assert!(p.warnings.iter().all(|w| w.contains("remains paused")));
        assert!(Include::default().watchdogs && Include::default().audiences);
    }

    #[test]
    fn preview_counts_dogs_and_discloses_user_and_extern_by_node() {
        let mut t = template(); let mut warnings = vec![];
        t.watchdogs.push(saved_dog(&raw("event","agents.active"), &names(), &Include::default(), &mut warnings).unwrap());
        t.audiences = vec![Grant{grantee:"worker".into(),grantor:"@user".into()}, Grant{grantee:"worker".into(),grantor:"@extern".into()}];
        let view = templates::plan_json(&t, &planned(&t, &Choices::default()), &[]);
        assert_eq!(view["agents"][2]["watchdogs"],1);
        assert_eq!(view["agents"][2]["audiences"],json!(["@user","@extern"]));
    }
}
