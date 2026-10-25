//! Authenticated user entry point. HTML never receives this route's credential.
use std::sync::Arc;
use axum::{Json, extract::{Path, State}};
use serde_json::Value;
use crate::engine::Engine;
use super::{error::ApiResult, orgs::org};
#[nolog]
pub async fn request(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Value>)->ApiResult<Json<Value>> {
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
    if !matches!(crate::domain::apps::wire::parse(&input)?,Request::List{..}|Request::AppGet{..}|Request::PanelGet{..}|Request::Events{..}){
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
    }
}
