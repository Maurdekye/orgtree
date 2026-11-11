//! One WebSocket to a remote engine: TCP to the addresses the address rule
//! passed, TLS on the engine's own rustls for `https`, then the upgrade with
//! the token as `Authorization: Bearer` and no `Origin`. The link's app
//! socket and every relayed org socket are dialed here.
//!
//! `#[nolog]` throughout: the upgrade request carries the token.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::WebSocketStream;

use super::store::Token;
use super::Conn;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type Upstream = WebSocketStream<Box<dyn Io>>;

/// Why a dial did not give a socket.
#[derive(Debug)]
pub enum DialError {
    /// No connection, or it ended before the upgrade was answered.
    Unreachable(String),
    /// The remote answered the upgrade with this status and `detail`.
    Status(u16, String),
}

/// The socket at `path_and_query` (it starts with `/`), and the remote
/// process id its upgrade answer carried.
#[nolog]
pub async fn dial(conn: &Conn, token: &Token, path_and_query: &str, max_message: usize, connect: Duration) -> Result<(Upstream, String), DialError> {
    let address = &conn.address;
    let tcp = tokio::time::timeout(connect, TcpStream::connect(&conn.addrs[..]))
        .await
        .map_err(|_| DialError::Unreachable("no answer within the connect timeout".into()))?
        .map_err(|e| DialError::Unreachable(format!("{e}")))?;
    let _ = tcp.set_nodelay(true);
    let io: Box<dyn Io> = if address.tls {
        let config = crate::mqtt::creds::tls_config(None, None).map_err(DialError::Unreachable)?;
        let name = rustls::pki_types::ServerName::try_from(address.host.clone())
            .map_err(|_| DialError::Unreachable("the host name is not one TLS can check".into()))?;
        let tls = tokio::time::timeout(connect, tokio_rustls::TlsConnector::from(config).connect(name, tcp))
            .await
            .map_err(|_| DialError::Unreachable("TLS did not finish within the connect timeout".into()))?
            .map_err(|e| DialError::Unreachable(format!("TLS: {e}")))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };
    let uri: http::Uri = format!("{}{}", address.ws_base(), path_and_query).parse().map_err(|_| DialError::Unreachable("the address is not a valid URI".into()))?;
    let request = ClientRequestBuilder::new(uri).with_header("Authorization", format!("Bearer {}", token.expose()));
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(max_message);
    config.max_frame_size = Some(max_message);
    match tokio::time::timeout(connect, tokio_tungstenite::client_async_with_config(request, io, Some(config))).await {
        Err(_) => Err(DialError::Unreachable("the upgrade was not answered within the connect timeout".into())),
        Ok(Ok((socket, response))) => {
            let boot = response.headers().get("x-orgtree-instance").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
            Ok((socket, boot))
        }
        Ok(Err(tungstenite::Error::Http(response))) => {
            let detail = response.body().as_deref().and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
                .and_then(|v| v["detail"].as_str().map(str::to_string)).unwrap_or_default();
            Err(DialError::Status(response.status().as_u16(), detail))
        }
        Ok(Err(_)) => Err(DialError::Unreachable("the upgrade failed".into())),
    }
}
