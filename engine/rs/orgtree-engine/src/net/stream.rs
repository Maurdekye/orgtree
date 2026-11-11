//! The hub stream (Mail hub 2.5.0, `GET /api/stream`; docket
//! mail-hub-websocket-for-new-mail-clients-prefer-i, spec-hub-websocket.md
//! sections 9 and 14).
//!
//! STUB for the red commit: no stream is ever used.

use serde_json::Value;

/// What the poller does with one poll.
#[derive(Debug)]
pub(super) enum Polled {
    /// carry this poll over HTTP, as before
    Http,
    /// the hub's answer: its status and JSON body
    Answer(u16, Value),
}

#[derive(Default)]
pub(super) struct Carrier;

impl Carrier {
    pub(super) fn new() -> Self {
        Carrier
    }

    #[cfg(test)]
    pub(super) fn with_time_div(_div: u32) -> Self {
        Carrier
    }

    #[nolog]
    pub(super) async fn poll(&mut self, _addr: &str, _auth: &str, _wait: u64) -> Polled {
        Polled::Http
    }
}
