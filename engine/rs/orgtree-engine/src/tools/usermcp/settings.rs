//! User settings over the existing desktop handlers; no generic API passthrough.
use super::*;
use axum::{extract::{Path, Query, State}, Json};

#[nolog]
pub(super) fn card() -> Value {
    user_card("orgtree_settings",
        "Read/configure settings as the user. scope org requires the org endpoint; defaults, runtime and provider are engine-wide on either endpoint. action get (default) reads, configure requires settings object and uses existing desktop value checks. Org get returns stored/effective settings; org configure accepts org_dirs for folders. Defaults use the desktop compact_at fraction convention; org configure uses percent 50-95. Provider get reads cached discovery without refresh; configure needs provider and exactly one boolean switch in settings: enabled, apikey_fallback or subscription_inference. Global defaults/runtime and provider changes affect all orgs. No generic HTTP/RPC passthrough.",
        json!({"scope":{"type":"string","enum":["org","defaults","runtime","provider"]},
            "action":{"type":"string","enum":["get","configure"]},
            "settings":{"type":"object"},"provider":{"type":"string"}}), &["scope"])
}

#[nolog]
pub(super) async fn run(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>, args: &Value) -> Result<Done> {
    let scope=need_str(args,"scope")?;
    let action=args["action"].as_str().unwrap_or("get");
    if !["get","configure"].contains(&action) { crate::refuse!(BadRequest,"action must be get or configure"); }
    if action=="get" { questions::only(args,&["scope","action"])?; }
    else if scope=="provider" { questions::only(args,&["scope","action","settings","provider"])?; }
    else { questions::only(args,&["scope","action","settings"])?; }
    let state=State(engine.clone());
    let value=match (scope,action) {
        ("org","get") => {
            let org=org.ok_or_else(||anyhow::anyhow!("scope org requires /api/orgs/<slug>/mcp"))?;
            let client=engine.db.get().await?;
            let stored:Value=client.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org.id]).await?.get(0);
            json!({"stored":stored,"effective":crate::feed::groups::effective_settings(&stored,&engine.settings.defaults())})
        }
        ("org","configure") => {
            let org=org.ok_or_else(||anyhow::anyhow!("scope org requires /api/orgs/<slug>/mcp"))?;
            crate::http::settings::save_org(state,Path(org.slug.clone()),Json(settings(args)?)).await.map_err(api)?.0
        }
        ("defaults","get") => crate::http::settings::get_defaults(state).await.map_err(api)?.0,
        ("defaults","configure") => crate::http::settings::save_defaults(state,Json(settings(args)?)).await.map_err(api)?.0,
        ("runtime","get") => crate::http::settings::get_runtime(state).await.map_err(api)?.0,
        ("runtime","configure") => crate::http::settings::put_runtime(state,Json(settings(args)?)).await.map_err(api)?.0,
        ("provider","get") => crate::http::settings::get_providers(state,Query(Default::default())).await.map_err(api)?.0,
        ("provider","configure") => {
            let provider=need_str(args,"provider")?.to_string();
            let settings=settings(args)?;
            let (key,enabled)=provider_switch(&settings)?;
            let body:crate::http::settings::Enabled=serde_json::from_value(json!({"enabled":enabled}))?;
            match key {
                "enabled" => crate::http::settings::provider_enabled(state,Path(provider),Json(body)).await.map_err(api)?.0,
                "apikey_fallback" => crate::http::settings::provider_apikey_fallback(state,Path(provider),Json(body)).await.map_err(api)?.0,
                _ => crate::http::settings::provider_subscription_inference(state,Path(provider),Json(body)).await.map_err(api)?.0,
            }
        }
        _ => crate::refuse!(BadRequest,"unsupported user settings scope"),
    };
    Ok(Done{text:serde_json::to_string(&value)?,card:None})
}

#[nolog]
fn settings(args:&Value)->Result<serde_json::Map<String,Value>> {
    args["settings"].as_object().cloned().ok_or_else(||anyhow::anyhow!("settings must be an object"))
}

#[nolog]
fn provider_switch(settings:&serde_json::Map<String,Value>)->Result<(&str,bool)> {
    if settings.len()!=1 { crate::refuse!(BadRequest,"configure one provider switch per call"); }
    let (key,value)=settings.iter().next().unwrap();
    if !["enabled","apikey_fallback","subscription_inference"].contains(&key.as_str()) {
        crate::refuse!(BadRequest,"unknown provider switch");
    }
    Ok((key,value.as_bool().ok_or_else(||anyhow::anyhow!("provider switches must be boolean"))?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_changes_are_one_typed_switch_not_a_generic_patch() {
        for bad in [json!({}),json!({"enabled":true,"apikey_fallback":true}),json!({"enabled":"true"}),json!({"url":"https://example.invalid"})] {
            assert!(provider_switch(bad.as_object().unwrap()).is_err());
        }
        assert_eq!(provider_switch(json!({"enabled":false}).as_object().unwrap()).unwrap(),("enabled",false));
    }
    #[tokio::test]
    async fn settings_scope_and_action_fields_refuse_before_io() {
        let engine=Engine::for_tests(std::env::temp_dir().join("orgtree-usermcp-settings-synthetic"));
        for args in [json!({"scope":"org"}),json!({"scope":"runtime","settings":{}}),json!({"scope":"runtime","action":"drop"}),json!({"scope":"provider","action":"configure","provider":"openai","settings":{"secret":"not-a-setting"}})] {
            assert!(run(&engine,None,&args).await.is_err());
        }
        let defaults=run(&engine,None,&json!({"scope":"defaults"})).await.unwrap();
        assert!(serde_json::from_str::<Value>(&defaults.text).unwrap()["default_tools"].is_object());
    }
}
