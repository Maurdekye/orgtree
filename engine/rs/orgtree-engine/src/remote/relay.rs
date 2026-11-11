//! Carrying a request to a remote engine (docs/rust-engine/remote-org.md,
//! "Request routing and the relay").
//!
//! `decide` says where a request belongs; `http::guarded` asks it for every
//! request, after the desktop token check and before dispatch. `forward`
//! carries one: the body streams both ways, the remote's token is attached
//! here and nowhere else, and the remote never receives this desktop's token,
//! cookies, `Origin` or `X-Orgtree-Remote`.
//!
//! A remote engine is outside input. It cannot redirect a window (a 3xx is
//! refused), set cookies or site data on this origin, or add headers beyond
//! the ones the engine's own API uses.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::Stream;
use serde_json::json;
use tokio::sync::OwnedSemaphorePermit;

use super::routes::{self, Class};
use super::{text, Phase, Remote, HEADER};
use crate::engine::Engine;

/// Where a request belongs.
pub enum Decision {
    /// This engine, for one of its own windows.
    Local,
    /// This engine, for a window bound to an organization of this remote
    /// engine: the answer's instance stamp names both processes.
    LocalFor(Arc<Remote>),
    /// The remote engine, at this path.
    Relay(Arc<Remote>, String),
    /// Nowhere: answered here with this status and sentence.
    Refuse(StatusCode, String),
}

#[logged]
impl Decision {
    #[nolog]
    pub fn is_relay(&self) -> bool {
        matches!(self, Decision::Relay(..))
    }
}

/// The remote engine whose window made this request: the header names it.
/// Every answer to that window carries the pair of processes as its instance
/// stamp, carried or not, so the stamp never differs between two answers to
/// one window. A request without the header is stamped with this process
/// alone, also when its path is an alias and it is carried.
#[nolog]
pub fn window(engine: &Engine, headers: &HeaderMap) -> Option<Arc<Remote>> {
    if !engine.remotes.active(engine) {
        return None;
    }
    headers.get(HEADER).and_then(|value| value.to_str().ok()).and_then(|id| engine.remotes.get(id))
}

/// The rule (in order):
/// 1. A standalone engine relays nothing and ignores the header.
/// 2. `X-Orgtree-Remote` must name a saved connection, else 400.
/// 3. `/api/orgs/{x}/**`: without the header a local organization `x` is
///    served here, always. An alias is carried to its remote engine under the
///    organization's slug there (a window of another remote engine gets 404).
///    With the header, `x` may also be the organization's slug on that remote.
///    Anything else with the header is 404: a remote window is never served a
///    local organization.
/// 4. An engine route with the header is carried to that remote engine.
/// 5. Everything else is served here.
///
/// The caller acts on a `Relay` only for a request that passed its token check.
#[nolog]
pub fn decide(engine: &Engine, path: &str, headers: &HeaderMap) -> Decision {
    let _ = (engine, path, headers);
    Decision::Local
}

/// A refusal in the engine's error shape, naming the connection's state.
#[nolog]
fn refuse(status: StatusCode, detail: String, remote: &Remote) -> Response {
    (status, axum::Json(json!({ "detail": detail, "remote": { "id": remote.id, "state": remote.phase().as_str() } }))).into_response()
}

/// What a change gets while the link is not connected: answered at once,
/// nothing dialed, nothing sent.
#[nolog]
pub fn not_connected(remote: &Remote) -> Response {
    let name = remote.name();
    let detail = match remote.phase() {
        Phase::AuthFailed => text::e10(&name),
        Phase::Paused | Phase::Refused => text::e11(&name),
        _ => text::e9(&name),
    };
    refuse(StatusCode::SERVICE_UNAVAILABLE, detail, remote)
}

/// Request headers that stay here. Hop-by-hop headers, this desktop's
/// credentials and anything that says where the window lives.
const REQUEST_DROP: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding",
    "upgrade", "host", "origin", "referer", "cookie", "authorization", crate::http::TOKEN_HEADER, HEADER,
];

/// Response headers a remote engine may send into a window: the ones the
/// engine's own API uses. `x-orgtree-*` passes too; CORS headers only for the
/// app media route (a sandboxed frame reads it with a ticket, not the token).
const RESPONSE_KEEP: &[&str] = &[
    "content-type", "content-length", "content-encoding", "content-disposition", "content-range", "content-language", "accept-ranges",
    "etag", "last-modified", "cache-control", "expires", "vary", "x-content-type-options", "content-security-policy", "referrer-policy",
];
const RESPONSE_KEEP_TICKET: &[&str] = &["access-control-allow-origin", "access-control-allow-credentials"];

/// The headers that go to the remote. `with_token` is false only for the app
/// media route, which carries its own ticket and a sandboxed frame's `Origin: null`.
#[nolog]
fn request_headers(incoming: &HeaderMap, token: Option<&str>) -> HeaderMap {
    let _ = token;
    incoming.clone()
}

#[nolog]
fn response_headers(incoming: &HeaderMap, ticket_route: bool) -> HeaderMap {
    let _ = ticket_route;
    incoming.clone()
}

/// A relayed body: the remote's bytes as they arrive. It holds the request's
/// slot until the last byte, and a failure on the way counts against the link.
struct Relayed {
    inner: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    remote: Arc<Remote>,
    window: std::time::Duration,
    _slot: OwnedSemaphorePermit,
}

impl Stream for Relayed {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Err(error))) => {
                self.remote.relay_failed(self.window);
                Poll::Ready(Some(Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, error.without_url().to_string()))))
            }
            Poll::Ready(Some(Ok(bytes))) => Poll::Ready(Some(Ok(bytes))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Carry `req` to `remote` at `path` (the query goes along). `with_token` is
/// false only for the app media route.
#[nolog]
pub async fn forward(engine: &Arc<Engine>, remote: Arc<Remote>, path: String, req: Request, with_token: bool) -> Response {
    let Some(conn) = remote.conn() else {
        return not_connected(&remote);
    };
    let timing = engine.remotes.timing();
    let target = match req.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path.clone(),
    };
    if req.headers().contains_key(axum::http::header::UPGRADE) {
        return super::socket::upgrade(engine, remote, &path, target, req).await;
    }
    let slot = match tokio::time::timeout(timing.inflight_wait, remote.inflight.clone().acquire_owned()).await {
        Ok(Ok(slot)) => slot,
        _ => return refuse(StatusCode::SERVICE_UNAVAILABLE, text::e12(&remote.name()), &remote),
    };
    let started = Instant::now();
    let method = req.method().clone();
    let token = remote.token();
    let headers = request_headers(req.headers(), with_token.then(|| token.expose()));
    // a body is streamed, never held: an upload goes through as it arrives
    let has_body = !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS)
        && (req.headers().contains_key(axum::http::header::CONTENT_LENGTH) || req.headers().contains_key(axum::http::header::TRANSFER_ENCODING));
    let mut outgoing = conn.http.request(method.clone(), format!("{}{target}", conn.address.base())).headers(headers);
    if has_body {
        outgoing = outgoing.body(reqwest::Body::wrap_stream(req.into_body().into_data_stream()));
    }
    let answer = match outgoing.send().await {
        Ok(answer) => answer,
        Err(error) => {
            remote.relay_failed(timing.failure_window);
            let (status, detail) = if error.is_connect() {
                (StatusCode::SERVICE_UNAVAILABLE, text::e9(&remote.name()))
            } else {
                (StatusCode::BAD_GATEWAY, text::e13(&remote.name()))
            };
            tracing::info!(target: "wire", "RELAY {} {method} {path} failed after {} ms", remote.tag(), started.elapsed().as_millis());
            return refuse(status, detail, &remote);
        }
    };
    let status = answer.status();
    tracing::info!(target: "wire", "RELAY {} {method} {path} {} {} ms", remote.tag(), status.as_u16(), started.elapsed().as_millis());
    if let Some(boot) = answer.headers().get("x-orgtree-instance").and_then(|v| v.to_str().ok()) {
        remote.note_boot(boot);
    }
    // the engine's API never redirects; a redirect would send the window's
    // next request, token and all, wherever the remote says
    if status.is_redirection() && status != StatusCode::NOT_MODIFIED {
        return refuse(StatusCode::BAD_GATEWAY, format!("{} answered with a redirect, which is not followed.", remote.name()), &remote);
    }
    let headers = response_headers(answer.headers(), !with_token);
    let body = Body::from_stream(Relayed { inner: Box::pin(answer.bytes_stream()), remote: remote.clone(), window: timing.failure_window, _slot: slot });
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// The instance stamp of an answer to a remote organization's window: this
/// process and the remote's, so the window reloads when either was replaced
/// and not when the remote is merely unreachable.
#[nolog]
pub fn instance(local: &str, remote: &Remote) -> String {
    format!("{local}~{}", remote.boot())
}

/// `x-orgtree-remote` as a header name, for callers that build requests.
#[nolog]
pub fn header_name() -> HeaderName {
    HeaderName::from_static(HEADER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_static(k), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn the_remote_gets_its_token_and_none_of_this_desktops_credentials() {
        let incoming = headers(&[("x-orgtree-desktop-token", "LOCAL-DESKTOP-TOKEN"), ("authorization", "Bearer local"), ("cookie", "a=b"),
            ("origin", "http://127.0.0.1:47800"), ("referer", "http://127.0.0.1:47800/o/acme"), ("x-orgtree-remote", "r1"), ("host", "127.0.0.1:47800"),
            ("connection", "keep-alive"), ("if-none-match", "\"e1\""), ("content-type", "application/json"), ("content-length", "12"),
            ("range", "bytes=0-9"), ("accept", "*/*")]);
        let out = request_headers(&incoming, Some("REMOTE-TOKEN"));
        assert_eq!(out.get("authorization").unwrap(), "Bearer REMOTE-TOKEN");
        assert!(out.get("authorization").unwrap().is_sensitive());
        for gone in ["x-orgtree-desktop-token", "cookie", "origin", "referer", "x-orgtree-remote", "host", "connection"] {
            assert!(out.get(gone).is_none(), "{gone} must not reach the remote");
        }
        for kept in ["if-none-match", "content-type", "content-length", "range", "accept"] {
            assert!(out.get(kept).is_some(), "{kept} must reach the remote");
        }
        assert!(!format!("{out:?}").contains("LOCAL-DESKTOP-TOKEN"));
        // the app media route: no token at all, and only a sandboxed frame's opaque origin
        let media = request_headers(&headers(&[("origin", "null"), ("authorization", "Bearer local"), ("range", "bytes=0-9")]), None);
        assert!(media.get("authorization").is_none());
        assert_eq!(media.get("origin").unwrap(), "null");
        assert!(request_headers(&headers(&[("origin", "http://evil.example")]), None).get("origin").is_none());
    }

    #[test]
    fn a_remote_cannot_set_cookies_site_data_or_headers_the_api_does_not_use() {
        let incoming = headers(&[("content-type", "application/json"), ("etag", "\"e1\""), ("x-orgtree-sync-rev", "7"), ("content-range", "bytes 0-9/10"),
            ("set-cookie", "s=1"), ("clear-site-data", "\"*\""), ("location", "http://127.0.0.1:1/api/orgs/local/ops"), ("refresh", "0;url=/"),
            ("www-authenticate", "Basic"), ("access-control-allow-origin", "*"), ("connection", "close"), ("transfer-encoding", "chunked"),
            ("strict-transport-security", "max-age=1"), ("link", "</x>; rel=preload")]);
        let out = response_headers(&incoming, false);
        for kept in ["content-type", "etag", "x-orgtree-sync-rev", "content-range"] {
            assert!(out.get(kept).is_some(), "{kept}");
        }
        for gone in ["set-cookie", "clear-site-data", "location", "refresh", "www-authenticate", "access-control-allow-origin", "connection",
            "transfer-encoding", "strict-transport-security", "link"] {
            assert!(out.get(gone).is_none(), "{gone} must not reach the window");
        }
        assert!(response_headers(&incoming, true).get("access-control-allow-origin").is_some(), "the app media route keeps its CORS answer");
    }
}
