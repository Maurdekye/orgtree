//! `GET /api/orgs/{slug}/ws` — the org socket: record frames from the org's
//! feed, the runtime overlay, org-wide pulses, and the transcript rooms this
//! window joined.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::engine::Engine;
use crate::feed::rooms::{next_socket_id, Member};
use crate::http::error::ApiError;
use crate::orgs::OrgHandle;

#[logged]
pub async fn org_ws(
    State(engine): State<Arc<Engine>>,
    Path(slug): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(org) = engine.orgs.get(&slug) else {
        return ApiError::not_found(format!("no organization {slug}")).into_response();
    };
    ws.on_upgrade(move |socket| run(engine, org, socket))
}

#[logged]
async fn run(engine: Arc<Engine>, org: Arc<OrgHandle>, socket: WebSocket) {
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
                if sink.send(Message::Text(text.to_string().into())).await.is_err() {
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let t = t.to_string();
                        if t == "ping" {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
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
