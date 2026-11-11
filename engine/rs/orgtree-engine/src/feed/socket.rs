//! `GET /api/orgs/{slug}/ws` — the org socket: record frames from the org's
//! feed, the runtime overlay, org-wide pulses, and the transcript rooms this
//! window joined.

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::engine::Engine;
use crate::feed::rooms::{next_socket_id, Member};
use crate::feed::viewer_gate::Gate;
use crate::http::error::ApiError;
use crate::orgs::OrgHandle;

#[logged]
pub async fn org_ws(
    State(engine): State<Arc<Engine>>,
    Path(slug): Path<String>,
    scope: Option<axum::Extension<crate::client_tokens::Scope>>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(org) = engine.orgs.get(&slug) else {
        return ApiError::not_found(format!("no organization {slug}")).into_response();
    };
    let viewer = matches!(scope, Some(axum::Extension(crate::client_tokens::Scope::Viewer { .. })));
    ws.on_upgrade(move |socket| run(engine, org, socket, viewer))
}

#[logged]
async fn run(engine: Arc<Engine>, org: Arc<OrgHandle>, socket: WebSocket, viewer: bool) {
    let mut gate = viewer.then(super::viewer_gate::ViewerGate::default);
    let id = next_socket_id();
    let (out_tx, mut out_rx) = mpsc::channel::<Arc<str>>(8192);
    let member = Member { id, out: out_tx.clone() };
    org.rooms.join_org(member.clone());
    org.feed.socket_open(id, out_tx.clone());
    let (mut sink, mut stream) = socket.split();
    let shutdown = engine.shutdown.clone();
    loop {
        tokio::select! {
            out = out_rx.recv() => {
                let Some(text) = out else { break };
                if crate::rig::active() && std::env::var("ORGTREE_RIG_STREAM_PROBE").as_deref() == Ok("1") {
                    if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                        crate::rig::stream_probe("socket", frame["node"].as_str().unwrap_or(""), &frame);
                    }
                }
                if sink.send(Message::Text(text.to_string().into())).await.is_err() {
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let t = t.to_string();
                        // A viewer's messages pass through the listen-only gate first.
                        let gated = match gate.as_mut().map(|gate| gate.admit(&t)) {
                            None => None,
                            Some(Gate::Ping | Gate::Ignored) => continue,
                            Some(Gate::Close) => {
                                let close = CloseFrame { code: 1008, reason: "this client token is read-only".into() };
                                let _ = sink.send(Message::Close(Some(close))).await;
                                break;
                            }
                            Some(Gate::Forward(v)) => Some(v),
                        };
                        if gated.is_none() && t == "ping" {
                            continue;
                        }
                        let Some(v) = gated.or_else(|| serde_json::from_str::<Value>(&t).ok()) else { continue };
                        if v["type"] == "watch" {
                            let names: Vec<String> = v["agents"].as_array()
                                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                                .unwrap_or_default();
                            let live = org.feed.live_agents().await;
                            let ids: Vec<i64> = live.iter()
                                .filter(|(_, name, _)| names.contains(name))
                                .map(|(id, _, _)| *id)
                                .collect();
                            org.rooms.watch(&member, ids);
                        } else if v["type"] == "attract" {
                            // this window's attract mode started or stopped; `refuse` is the app-wide
                            // "refuse questions to the user" setting (absent = on)
                            let running = v["running"].as_bool().unwrap_or(false);
                            org.rooms.set_attract(id, running.then(|| v["refuse"].as_bool().unwrap_or(true)));
                        } else {
                            org.feed.socket_msg(id, v);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            _ = shutdown.cancelled() => break,
        }
    }
    org.rooms.leave(id);
    org.feed.socket_close(id);
}
