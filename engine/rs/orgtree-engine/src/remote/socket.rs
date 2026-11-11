//! The org socket of a remote organization (docs/rust-engine/remote-org.md,
//! "WebSocket relay"): the window's upgrade is accepted here, the same
//! socket is dialed on the remote engine with its token, and frames are
//! copied both ways unchanged (`ping`, `watch`, `attract`, feed
//! subscriptions; record frames and transcript rooms).
//!
//! When the remote side closes or fails, when the queue toward the window
//! overflows, or when the link leaves `connected`, the window's socket is
//! closed with code 1013 (try again later). The renderer's own socket loop
//! then reconnects and reads its base again, as after an engine hiccup.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as Frame;

use super::wsdial::{self, DialError, Upstream};
use super::{relay, routes, text, Phase, Remote};
use crate::engine::Engine;

/// The largest message read from the remote's org socket. A base copy of a
/// large organization is the big one.
pub const MESSAGE_MAX: usize = 64 << 20;
/// "Try again later": the close code a window's socket loop reconnects on.
pub const TRY_AGAIN: u16 = 1013;

/// Accept the window's upgrade for the org socket at `path` and pump it to
/// the remote's. Only the org socket is relayed.
#[nolog]
pub async fn upgrade(engine: &Arc<Engine>, remote: Arc<Remote>, path: &str, target: String, req: Request) -> Response {
    if !matches!(routes::org_of(path), Some((_, "/ws"))) {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "detail": "this socket is not available for an organization on a remote engine" })))
            .into_response();
    }
    let Some(conn) = remote.conn() else {
        return relay::not_connected(&remote);
    };
    let (mut parts, _body) = req.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    // dial first: a remote that does not take the socket refuses the upgrade
    let timing = engine.remotes.timing();
    let upstream = match wsdial::dial(&conn, &remote.token(), &target, MESSAGE_MAX, timing.connect).await {
        Ok((upstream, boot)) => {
            remote.note_boot(&boot);
            upstream
        }
        Err(DialError::Status(status, detail)) if status == 404 || status == 403 => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            return (status, axum::Json(serde_json::json!({ "detail": detail }))).into_response();
        }
        Err(_) => {
            remote.relay_failed(timing.failure_window);
            return (StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({ "detail": text::e9(&remote.name()),
                "remote": { "id": remote.id, "state": remote.phase().as_str() } }))).into_response();
        }
    };
    let engine = engine.clone();
    ws.max_message_size(MESSAGE_MAX).max_frame_size(MESSAGE_MAX).on_upgrade(move |socket| pump(engine, remote, socket, upstream))
}

/// Copy frames both ways until either side ends.
#[nolog]
async fn pump(engine: Arc<Engine>, remote: Arc<Remote>, window: WebSocket, upstream: Upstream) {
    let (mut to_window, mut from_window) = window.split();
    let (mut to_remote, mut from_remote) = upstream.split();
    let (queue, mut queued) = mpsc::channel::<Message>(engine.remotes.timing().socket_queue.max(1));
    // one writer owns the window's sink: frames in order, then the close.
    // `cut` ends it early: an overflowing queue is not drained first
    let cut = Arc::new(AtomicBool::new(false));
    let writer = tokio::spawn({
        let cut = cut.clone();
        async move {
            let mut closed = false;
            while let Some(message) = queued.recv().await {
                if cut.load(Ordering::Acquire) {
                    break;
                }
                let last = matches!(message, Message::Close(_));
                if to_window.send(message).await.is_err() || last {
                    closed = true;
                    break;
                }
            }
            if !closed && cut.load(Ordering::Acquire) {
                let _ = to_window.send(Message::Close(Some(CloseFrame { code: TRY_AGAIN, reason: "".into() }))).await;
            }
            let _ = to_window.close().await;
        }
    });
    let mut state = remote.watch();
    // true: the remote side ended, so the window is told to try again
    let try_again = loop {
        tokio::select! {
            frame = from_remote.next() => match frame {
                Some(Ok(Frame::Text(text))) => {
                    if queue.try_send(Message::Text(text.as_str().into())).is_err() {
                        break true;
                    }
                }
                Some(Ok(Frame::Binary(bytes))) => {
                    if queue.try_send(Message::Binary(bytes)).is_err() {
                        break true;
                    }
                }
                // a ping (answered by the socket itself) or a pong
                Some(Ok(Frame::Ping(_))) | Some(Ok(Frame::Pong(_))) | Some(Ok(Frame::Frame(_))) => {}
                Some(Ok(Frame::Close(_))) | Some(Err(_)) | None => break true,
            },
            message = from_window.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if to_remote.send(Frame::Text(text.as_str().into())).await.is_err() {
                        break true;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if to_remote.send(Frame::Binary(bytes)).await.is_err() {
                        break true;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
                Some(Ok(_)) => {}
            },
            changed = state.changed() => {
                if changed.is_err() || state.borrow().phase != Phase::Connected {
                    break true;
                }
            }
            _ = remote.stop.cancelled() => break true,
            _ = engine.shutdown.cancelled() => break false,
        }
    };
    if try_again {
        let close = Message::Close(Some(CloseFrame { code: TRY_AGAIN, reason: "".into() }));
        // a full queue cannot take the close: the writer is told to stop and close at once
        if queue.try_send(close).is_err() {
            cut.store(true, Ordering::Release);
        }
    }
    drop(queue);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), to_remote.close()).await;
}
