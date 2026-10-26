//! Native file decisions and independently authorized, read-only media tickets.
//! Neither the iframe nor its URL receives a desktop/session credential or path.
use std::sync::Arc;
use axum::{extract::{Path,Query,State},http::{HeaderMap,Method,header,StatusCode},response::Response,Json};
use serde_json::Value;
use crate::engine::Engine;
use super::{error::{ApiError,ApiResult},orgs::org};

#[nolog]
pub async fn native(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,headers:HeaderMap,Json(input):Json<Value>)->ApiResult<Json<Value>>{
    super::apps::native_user(&engine,&headers)?;let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::file_access::native(&engine,&org,&input).await?))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaQuery {ticket:String}

/// Only this exact GET path uses an asset ticket instead of the general native
/// credential. The handler validates its private bound host and grant on EVERY
/// range request. No path, caller or arbitrary URL is accepted from the client.
#[nolog]
pub fn ticket_route(path:&str,method:&Method)->bool{
    if *method!=Method::GET{return false;}
    let parts:Vec<_>=path.split('/').collect();parts.len()==6&&parts[0].is_empty()&&parts[1]=="api"&&parts[2]=="orgs"&&!parts[3].is_empty()&&parts[4]=="apps"&&parts[5]=="media"
}
#[nolog]
pub async fn media(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,Query(query):Query<MediaQuery>,headers:HeaderMap)->ApiResult<Response>{
    let org=org(&engine,&slug)?;
    let (file,path,lease)=crate::domain::apps::file_access::media(&engine,&org,&query.ticket).await?;
    let mime=super::media_file::media_type(&path).ok_or_else(||ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE,"unsupported app media format"))?;
    let mut ranges=headers.get_all(header::RANGE).iter();let range=ranges.next().map(|v|v.to_str().unwrap_or(""));let range=if ranges.next().is_some(){Some("")}else{range};
    super::media_file::serve_opened(tokio::fs::File::from_std(file),mime,range,Some((lease.cancel,lease.until))).await.map_err(|status|ApiError::new(status,"app media could not be streamed"))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn app_file_ticket_exception_is_one_exact_get_path(){
        assert!(ticket_route("/api/orgs/demo/apps/media",&Method::GET));
        for path in ["/api/orgs/demo/apps/media/","/api/orgs/demo/apps/media/other","/api/orgs/demo/apps/bridge","/api/orgs/demo/nodes/a/file","/api/orgs/demo/apps/media/../bridge","/api/orgs/demo/apps/media-other"]{assert!(!ticket_route(path,&Method::GET),"{path}");}
        assert!(!ticket_route("/api/orgs/demo/apps/media",&Method::POST));
        assert!(serde_json::from_str::<MediaQuery>(r#"{"ticket":"x","path":"elsewhere"}"#).is_err());
    }
}
