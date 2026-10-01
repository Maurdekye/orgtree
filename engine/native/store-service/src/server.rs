//! The authenticated loopback server. Generic over [`Handler`] so the channel
//! itself (auth, framing, limits) is tested without a database.

use std::future::Future;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};

use crate::proto::{read_frame, write_frame, Handshake, Request};

pub trait Handler: Send + Sync + 'static {
    fn handshake(&self) -> Handshake;
    fn handle(&self, req: Request) -> impl Future<Output = Value> + Send;
}

/// Constant-time comparison of the presented token with the service token.
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh per-boot token: 256 bits from two v4 UUIDs, as lowercase hex.
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub async fn bind_loopback() -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", 0)).await
}

/// Accept connections until the listener fails.
pub async fn serve<H: Handler>(listener: TcpListener, token: Arc<String>, handler: Arc<H>) -> std::io::Result<()> {
    loop {
        let (sock, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let (token, handler) = (token.clone(), handler.clone());
        tokio::spawn(async move {
            let _ = connection(sock, &token, &*handler).await;
        });
    }
}

async fn connection<H: Handler>(mut sock: TcpStream, token: &str, handler: &H) -> std::io::Result<()> {
    sock.set_nodelay(true)?;
    // 1. hello: anything but the right token closes the socket, saying nothing.
    let Some(hello) = read_frame(&mut sock).await? else { return Ok(()) };
    let presented = hello.get("hello").and_then(Value::as_str).unwrap_or("");
    if !token_eq(presented, token) {
        return Ok(());
    }
    write_frame(&mut sock, &json!({ "handshake": handler.handshake() })).await?;
    // 2. requests, one response each, in order.
    while let Some(frame) = read_frame(&mut sock).await? {
        let resp = match serde_json::from_value::<Request>(frame) {
            Ok(req) => handler.handle(req).await,
            Err(e) => json!({ "error": "bad_request", "detail": e.to_string() }),
        };
        write_frame(&mut sock, &resp).await?;
    }
    Ok(())
}
