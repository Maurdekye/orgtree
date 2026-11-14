//! The remote door: the listener other computers come in through
//! (docs/rust-engine/remote-org.md, "A desktop as host").
//!
//! It is a second listener beside the one on loopback that the app itself
//! uses, and the two share nothing but the router. A connection accepted here
//! is marked (`Connection::door`), and the request guard treats a marked
//! connection by the door's rules alone (`remote_access::admit`): its own
//! tokens, its own route table, the API and nothing else.
//!
//! A peer whose address is public is dropped as it is accepted, before a byte
//! of it is read. (What a tunnel or a proxy on this computer hands on arrives
//! from 127.0.0.1, at the listener the owner chose for that.)

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::client_tokens::transport::{ClientInfo, ClientIo, Connection};
use crate::engine::Engine;
use crate::remote::address::{classify, Net};

/// Whose connections the door takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerRule {
    tailscale: bool,
    lan: bool,
    loopback: bool,
}

#[nolog]
impl PeerRule {
    /// Tailscale's addresses always; this private network's too when `lan`
    /// (what the one app-wide choice was before each place was chosen by itself; tests).
    pub fn new(lan: bool) -> PeerRule {
        PeerRule { tailscale: true, lan, loopback: false }
    }

    /// The rule of one listener: the peers of the place it stands at, and no other. The
    /// Tailscale listener takes Tailscale's addresses, the private network's takes private
    /// ones, and the one on this computer itself takes 127.0.0.1, which is where an SSH
    /// tunnel or a local https proxy connects from. A rule made from the owner's choices as a
    /// whole would go stale on a listener that stays up while another choice changes.
    pub fn only(kind: super::lifecycle::Kind) -> PeerRule {
        use super::lifecycle::Kind;
        PeerRule { tailscale: kind == Kind::Tailscale, lan: kind == Kind::Lan, loopback: matches!(kind, Kind::Local | Kind::Rig) }
    }

    /// As `new`, and this computer itself: for the test rig and unit tests,
    /// which run both ends on one machine. Not compiled into a release build.
    #[cfg(any(test, debug_assertions))]
    pub fn with_loopback(lan: bool) -> PeerRule {
        PeerRule { tailscale: true, lan, loopback: true }
    }

    /// May a peer at this address come in? Never one at a public address.
    pub fn admits(&self, ip: IpAddr) -> bool {
        match classify(ip) {
            Net::Tailscale => self.tailscale,
            Net::Private => self.lan,
            Net::Loopback => self.loopback,
            Net::Public => false,
        }
    }
}

pub struct DoorListener {
    listener: TcpListener,
    rule: PeerRule,
}

impl Listener for DoorListener {
    type Io = ClientIo;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.listener.accept().await {
                Ok((stream, peer)) => {
                    if !self.rule.admits(peer.ip()) {
                        // dropped unread: nothing of a request from there is parsed
                        drop(stream);
                        tracing::warn!(peer = %peer.ip(), "remote access: a connection from an address the door does not take was dropped");
                        continue;
                    }
                    match Connection::accept(stream, peer, true) {
                        Ok(io) => return (io, peer),
                        Err(error) => tracing::warn!(error = %error, "remote access: a connection could not be taken"),
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "remote access: accept failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

impl Connected<IncomingStream<'_, DoorListener>> for ClientInfo {
    fn connect_info(stream: IncomingStream<'_, DoorListener>) -> Self {
        Self(stream.io().connection().clone())
    }
}

/// Serve the engine's API on `listener` as the remote door until `stop`.
#[nolog]
pub fn serve(engine: Arc<Engine>, listener: TcpListener, rule: PeerRule, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
    let at = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
    let app = crate::http::router(engine);
    tokio::spawn(async move {
        tracing::info!(address = %at, "remote access: the door is open");
        let served = axum::serve(DoorListener { listener, rule }, app.into_make_service_with_connect_info::<ClientInfo>())
            .with_graceful_shutdown(async move { stop.cancelled().await })
            .await;
        match served {
            Ok(()) => tracing::info!(address = %at, "remote access: the door is closed"),
            Err(error) => tracing::warn!(address = %at, error = %error, "remote access: the door stopped"),
        }
    })
}
