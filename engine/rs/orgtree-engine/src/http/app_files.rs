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
    let response=super::media_file::serve_opened(tokio::fs::File::from_std(file),mime,range,Some(lease.cancel)).await.map_err(|status|ApiError::new(status,"app media could not be streamed"))?;
    Ok(with_media_cors(response,&headers))
}

/// A panel is a `sandbox="allow-scripts"` iframe with no same-origin, so its origin is opaque and a
/// `crossOrigin` media load sends `Origin: null`. Echo exactly that, so the panel can draw the video
/// to a canvas and read its pixels; any other origin (or none) gets no allow-origin header. The
/// ticket in the URL stays the only credential: nothing else about the route changes, no credentials
/// header is sent and there is no preflight (a media element's GET needs none).
#[nolog]
pub(crate) fn with_media_cors(mut response:Response,request:&HeaderMap)->Response{
    let headers=response.headers_mut();
    headers.append(header::VARY,header::HeaderValue::from_static("Origin"));
    if request.get_all(header::ORIGIN).iter().count()==1&&request.get(header::ORIGIN).is_some_and(|v|v.as_bytes()==b"null"){
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,header::HeaderValue::from_static("null"));
    }
    response
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

    /// A real response from the media streamer: 200, 206 or 416 for `range`.
    async fn streamed(range:Option<&str>)->Response{
        use std::io::Write;
        static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
        let p=std::env::temp_dir().join(format!("app-media-cors-{}-{}.mp4",std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));
        std::fs::File::create(&p).unwrap().write_all(b"0123456789").unwrap();
        let f=tokio::fs::File::open(&p).await.unwrap();
        let r=super::super::media_file::serve_opened(f,"video/mp4",range,None).await.unwrap();
        let _=std::fs::remove_file(&p);
        r
    }
    fn origin(value:Option<&str>)->HeaderMap{
        let mut h=HeaderMap::new();
        if let Some(v)=value{h.insert(header::ORIGIN,v.parse().unwrap());}
        h
    }
    fn acao(r:&Response)->Option<String>{r.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).map(|v|v.to_str().unwrap().to_string())}
    fn varies_on_origin(r:&Response)->bool{r.headers().get_all(header::VARY).iter().any(|v|v.to_str().unwrap().split(',').any(|t|t.trim().eq_ignore_ascii_case("origin")))}

    #[tokio::test]
    async fn the_sandboxed_panel_s_null_origin_may_read_ok_partial_and_unsatisfiable_responses(){
        for (range,status) in [(None,StatusCode::OK),(Some("bytes=2-5"),StatusCode::PARTIAL_CONTENT),(Some("bytes=90-99"),StatusCode::RANGE_NOT_SATISFIABLE)]{
            let r=with_media_cors(streamed(range).await,&origin(Some("null")));
            assert_eq!(r.status(),status);
            assert_eq!(acao(&r).as_deref(),Some("null"),"{status}");
            assert!(varies_on_origin(&r),"{status}");
            assert!(r.headers().get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none(),"no credentials header");
        }
    }

    #[tokio::test]
    async fn any_other_origin_or_none_gets_no_allow_origin_but_the_response_still_varies(){
        for o in [Some("http://127.0.0.1:5173"),Some("https://evil.example"),Some("NULL"),Some(""),None]{
            let r=with_media_cors(streamed(Some("bytes=0-3")).await,&origin(o));
            assert_eq!(r.status(),StatusCode::PARTIAL_CONTENT);
            assert_eq!(acao(&r),None,"{o:?}");
            assert!(varies_on_origin(&r),"{o:?}");
        }
    }

    #[tokio::test]
    async fn the_streamer_s_own_headers_are_kept(){
        let r=with_media_cors(streamed(Some("bytes=2-5")).await,&origin(Some("null")));
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap(),"bytes 2-5/10");
        assert_eq!(r.headers().get(header::CACHE_CONTROL).unwrap(),"no-store");
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(),"video/mp4");
    }
}
