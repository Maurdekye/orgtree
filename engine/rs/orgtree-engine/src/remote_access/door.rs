//! The remote door: the listener other computers come in through.
//!
//! NOT BUILT: nothing is accepted and no peer is taken.

use std::net::IpAddr;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;

/// Whose connections the door takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerRule;

#[nolog]
impl PeerRule {
    pub fn new(_lan: bool) -> PeerRule { PeerRule }
    #[cfg(any(test, debug_assertions))]
    pub fn with_loopback(_lan: bool) -> PeerRule { PeerRule }
    pub fn admits(&self, _ip: IpAddr) -> bool { false }
}

/// Serve the engine's API on `listener` as the remote door until `stop`. Not built: the
/// listener is held and nothing is accepted from it.
#[nolog]
pub fn serve(_engine: Arc<Engine>, listener: TcpListener, _rule: PeerRule, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        stop.cancelled().await;
        drop(listener);
    })
}
