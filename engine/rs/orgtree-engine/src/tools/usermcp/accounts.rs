//! Engine-wide user account administration. No secret-bearing function logs.
use super::*;
use axum::{extract::{Path, Query, State}, Json};
use crate::http::accounts as http;

#[nolog]
pub(super) fn card() -> Value {
    user_card("orgtree_accounts",
        "Manage engine-wide accounts as the user, on either MCP endpoint. list (default) optionally filters by org. add needs provider claude|openai|google|muse and kind managed|imported|apikey, with path for import/key for API key; Muse import is refused. remove, enable (enabled boolean), identity, marks and clear_marks need id. clear_marks requires the exact expected mark, source registry, pool/reason and optional companion_expected; no capacity is added. claude_key_add accepts token and optional mint_config_dir from native setup-token. order accepts keys (account IDs). OpenRouter uses openrouter_key_add/update/remove; add needs key, update/remove need id; add/update accept label/harness and update may replace key. Existing user handlers validate and reconcile bindings; identity/key changes may perform provider checks. Secrets are never returned. Native CLI/browser login is separate.",
        json!({"action":{"type":"string","enum":["list","add","remove","enable","identity","marks","clear_marks","claude_key_add","order","openrouter_key_add","openrouter_key_update","openrouter_key_remove"]},
            "org":{"type":"string"},"id":{"type":"string"},"provider":{"type":"string","enum":["claude","openai","google","muse"]},
            "kind":{"type":"string","enum":["managed","imported","apikey"]},"path":{"type":"string"},
            "key":{"type":"string"},"token":{"type":"string"},"mint_config_dir":{"type":"string"},
            "enabled":{"type":"boolean"},"keys":{"type":"array","items":{"type":"string"}},
            "label":{"type":"string"},"harness":{"type":"string"},
            "source":{"type":"string","enum":["registry"]},"pool":{"type":"string"},
            "expected":{"type":"object"},"companion_expected":{"type":"object"},"reason":{"type":"string"}}), &[])
}

#[nolog]
fn input<T:serde::de::DeserializeOwned>(args:&Value, fields:&[&str])->Result<T> {
    questions::only(args,fields)?;
    // Deserializer diagnostics must never format a private submitted value.
    serde_json::from_value(args.clone()).map_err(|_|anyhow::anyhow!("invalid fields for this account action"))
}

#[nolog]
pub(super) async fn run(engine:&Arc<Engine>,args:&Value)->Result<Done> {
    let state=State(engine.clone());
    let id=||need_str(args,"id").map(str::to_string);
    let value=match args["action"].as_str().unwrap_or("list") {
        "list" => http::list(state,Query(input::<http::OrgQuery>(args,&["action","org"])?)).await.map_err(api)?.0,
        "add" => {
            let kind=need_str(args,"kind")?;
            let fields:&[&str]=match kind {
                "managed"=>&["action","provider","kind"],
                "imported"=>&["action","provider","kind","path"],
                "apikey"=>&["action","provider","kind","key"],
                _=>crate::refuse!(BadRequest,"kind must be managed, imported or apikey"),
            };
            http::add(state,Json(input::<http::AddAccount>(args,fields)?)).await.map_err(api)?.0
        }
        "remove" => {
            questions::only(args,&["action","id"])?;
            http::remove(state,Path(id()?)).await.map_err(api)?.0
        }
        "enable" => http::set_enabled(state,Path(id()?),Json(input::<http::EnabledBody>(args,&["action","id","enabled"])?)).await.map_err(api)?.0,
        "identity" => {
            questions::only(args,&["action","id"])?;
            http::identity(state,Path(id()?)).await.map_err(api)?.0
        }
        "marks" => {
            questions::only(args,&["action","id"])?;
            http::marks(state,Path(id()?)).await.map_err(api)?.0
        }
        "clear_marks" => http::clear_marks(state,Path(id()?),Some(Json(input::<http::ClearMarks>(args,&["action","id","source","pool","expected","companion_expected","reason"])?))).await.map_err(api)?.0,
        "claude_key_add" => http::add_key(state,Json(input::<http::AddKey>(args,&["action","token","mint_config_dir"])?)).await.map_err(api)?.0,
        "order" => http::order(state,Json(input::<http::KeyOrder>(args,&["action","keys"])?)).await.map_err(api)?.0,
        "openrouter_key_add" => http::openrouter_key_add(state,Json(input::<http::AddKeyBody>(args,&["action","key","label","harness"])?)).await.map_err(api)?.0,
        "openrouter_key_update" => http::openrouter_key_update(state,Path(id()?),Json(input::<http::UpdateKeyBody>(args,&["action","id","key","label","harness"])?)).await.map_err(api)?.0,
        "openrouter_key_remove" => {
            questions::only(args,&["action","id"])?;
            http::openrouter_key_remove(state,Path(id()?)).await.map_err(api)?.0
        }
        _ => crate::refuse!(BadRequest,"unsupported user account action"),
    };
    Ok(Done{text:serde_json::to_string(&value)?,card:None})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn account_secret_refusals_do_not_echo_or_log_arguments() {
        let capture=crate::trace::LogCapture::start().await;
        tracing::info!("user MCP account positive log control");
        let engine=Engine::for_tests(std::env::temp_dir().join("orgtree-usermcp-account-synthetic"));
        let secret="SYNTHETIC_ACCOUNT_SECRET_CANARY_192e";
        for args in [json!({"action":"enable","id":"synthetic","enabled":secret}),
            json!({"action":"add","provider":"openai","kind":"managed","key":secret}),
            json!({"action":"list","key":secret}),json!({"action":"claude_key_add","token":{secret:secret}})] {
            let response=super::super::handle(&engine,None,&json!({"id":1,"method":"tools/call","params":{"name":"orgtree_accounts","arguments":args}})).await;
            assert_eq!(response["result"]["isError"],true);
            assert!(!response.to_string().contains(secret));
        }
        let log=capture.finish().await;
        assert!(log.contains("user MCP account positive log control"));
        assert!(!log.contains(secret),"account secret leaked to verbose log");
    }
}
