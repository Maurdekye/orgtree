//! Authenticated user entry point. HTML never receives this route's credential.
use std::sync::Arc;
use axum::{Json, extract::{Path, State}};
use serde_json::Value;
use crate::engine::Engine;
use super::{error::ApiResult, orgs::org};
#[nolog]
pub async fn request(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,headers:axum::http::HeaderMap,Json(input):Json<Value>)->ApiResult<Json<Value>> {
    if input["action"]=="permission_set"{native_user(&engine,&headers)?;}
    let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::run(&engine,&org,None,&input).await?))
}


#[derive(serde::Deserialize)]
pub struct ReadQuery { request:String }
#[nolog]
pub fn read_input(raw:&str)->Result<Value,super::error::ApiError>{
    if raw.len()>8192{return Err(super::error::ApiError::bad_request("Apps read request is too large"));}
    let input:Value=serde_json::from_str(raw).map_err(|_|super::error::ApiError::bad_request("invalid Apps read request"))?;
    use crate::domain::apps::wire::Request;
    if !matches!(crate::domain::apps::wire::parse(&input).map_err(|_|super::error::ApiError::bad_request("invalid Apps read request"))?,Request::List{..}|Request::AppGet{..}|Request::PanelGet{..}|Request::Refs{..}|Request::Events{..}|Request::Listeners{..}|Request::ListenerFires{..}|Request::PermissionHistory{..}){
        return Err(super::error::ApiError::bad_request("GET only supports Apps reads"));
    }
    Ok(input)
}
#[nolog]
pub async fn read(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,axum::extract::Query(query):axum::extract::Query<ReadQuery>)->ApiResult<Json<Value>>{
    let input=read_input(&query.request)?;let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::run(&engine,&org,None,&input).await?))
}
#[cfg(test)] mod tests{
    use super::*;
    #[test] fn custom_apps_get_cannot_mutate_or_choose_identity(){
        for input in [serde_json::json!({"action":"panel_delete","panel":"p","expected_rev":1}),serde_json::json!({"action":"list","org":"other"})]{assert!(read_input(&input.to_string()).is_err());}
        assert!(read_input(r#"{"action":"list","kind":"panels","open":true}"#).is_ok());
        assert!(read_input(r#"{"action":"permission_history","app":"a"}"#).is_ok(),"Permission history is a read");
        assert!(read_input(r#"{"action":"listener_fires","app":"a","listener":"worker/notes"}"#).is_ok(),"a listener's fires are a read");
    }
}

/// Scoped standalone client/agent tokens never decide native app grants.
#[nolog]
pub(super) fn native_user(engine:&Engine,headers:&axum::http::HeaderMap)->Result<(),super::error::ApiError>{
    if !super::token_ok_headers(&engine.cfg.desktop_token,false,headers){return Err(super::error::ApiError::forbidden("app host and permission operations require the desktop user credential"));}Ok(())
}
#[nolog]
pub async fn bridge(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,headers:axum::http::HeaderMap,Json(input):Json<Value>)->ApiResult<Json<Value>>{
    native_user(&engine,&headers)?;let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::bridge::run(&engine,&org,&input).await?))
}
/// Desktop windows report which panels they actually run, never authority.
#[nolog]
pub async fn runtime(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,headers:axum::http::HeaderMap,Json(input):Json<Value>)->ApiResult<Json<Value>>{
    native_user(&engine,&headers)?;let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::runtime::native(&engine,&org,&input).await?))
}

#[cfg(test)] mod native_control {
    #[test] fn custom_apps_native_guard_rejects_scoped_and_bearer_credentials(){
        let mut engine=crate::engine::Engine::for_tests(std::path::PathBuf::new());
        std::sync::Arc::get_mut(&mut engine).unwrap().cfg.desktop_token="root-test-secret".into();
        let mut headers=axum::http::HeaderMap::new();
        headers.insert("x-orgtree-desktop-token","scoped-client-secret".parse().unwrap());assert!(super::native_user(&engine,&headers).is_err());
        headers.clear();headers.insert("authorization","Bearer root-test-secret".parse().unwrap());assert!(super::native_user(&engine,&headers).is_err());
        headers.insert("x-orgtree-desktop-token","root-test-secret".parse().unwrap());assert!(super::native_user(&engine,&headers).is_ok());
    }
}
