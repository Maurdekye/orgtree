//! Reconnect waits, shared by the mqtt and websocket watchdogs' connections
//! (docs/rust-engine/mqtt-watchdogs.md, websocket-watchdogs.md): never a
//! tight loop, whatever the server does.

use std::time::Duration;

use rand::Rng;
use tokio::time::Instant;

/// The waits a connection backs off by.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Waits<'a> {
    /// Network backoff: the first wait, doubled per failure up to `net_max`.
    pub net_first: Duration,
    pub net_max: Duration,
    /// Waits after refusals (auth, TLS, configuration), in order; the last repeats.
    pub refused: &'a [Duration],
    /// Up this long before the network backoff starts over.
    pub stable: Duration,
    /// Spread waits by ±20 % so many dogs do not retry in step.
    pub jitter: bool,
}

/// Network and refusal backoff: a network failure doubles the wait up to
/// `net_max` and starts over only after a connection stayed up `stable`;
/// a refusal walks `refused` and starts over on the next accepted connect.
#[derive(Default)]
pub(crate) struct Backoff {
    net: u32,
    refused: u32,
    connected_at: Option<Instant>,
}

#[logged]
impl Backoff {
    #[nolog]
    pub fn connected(&mut self) {
        self.connected_at = Some(Instant::now());
        self.refused = 0;
    }

    /// Did the last accepted connection fail within `stable`? (A server
    /// that accepts and then drops the client at once is one outage.)
    #[nolog]
    pub fn flapping(&self, stable: Duration) -> bool {
        self.connected_at.is_some_and(|at| at.elapsed() < stable)
    }

    #[nolog]
    pub fn failed(&mut self, refused: bool, t: &Waits<'_>) -> Duration {
        if let Some(at) = self.connected_at.take() {
            if at.elapsed() >= t.stable {
                self.net = 0;
            }
        }
        let base = if refused {
            let d = t.refused.get(self.refused as usize).or(t.refused.last()).copied().unwrap_or(Duration::from_secs(60));
            self.refused = self.refused.saturating_add(1);
            d
        } else {
            let d = t.net_first.saturating_mul(1u32 << self.net.min(16)).min(t.net_max);
            self.net = self.net.saturating_add(1);
            d
        };
        if t.jitter { base.mul_f64(rand::thread_rng().gen_range(0.8..1.2)) } else { base }
    }
}
