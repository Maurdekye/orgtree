//! Listen-only filtering of a viewer-scoped token's org socket (docs/standalone-engine.md).
//!
//! A viewer may `ping`, and `subscribe`/`unsubscribe` to the archive windows. Every other
//! message is ignored and counted: `watch` (transcript rooms) and `attract` (it changes the
//! engine's refuse-questions behaviour) never reach the org. After `IGNORED_LIMIT` ignored
//! messages the connection closes with 1008.

use serde_json::Value;

pub const IGNORED_LIMIT: u32 = 20;
/// The only subscription windows a viewer may name; `agent_mail` and `agent_history`
/// would carry mailboxes and history.
const WINDOWS: [&str; 2] = ["archived_all", "archived_under"];

#[derive(Debug, PartialEq)]
pub enum Gate {
    /// A keep-alive; nothing to do.
    Ping,
    /// Hand this (possibly narrowed) message to the feed.
    Forward(Value),
    /// Dropped and counted.
    Ignored,
    /// The 20th ignored message: close with 1008 "this client token is read-only".
    Close,
}

#[derive(Default)]
pub struct ViewerGate { ignored: u32 }

#[nolog]
impl ViewerGate {
    pub fn admit(&mut self, text: &str) -> Gate {
        if text == "ping" { return Gate::Ping; }
        if let Ok(mut msg) = serde_json::from_str::<Value>(text) {
            match msg["type"].as_str() {
                Some("unsubscribe") => return Gate::Forward(msg),
                Some("subscribe") => {
                    if let Some(windows) = msg["windows"].as_array_mut() {
                        windows.retain(|w| w["kind"].as_str().is_some_and(|k| WINDOWS.contains(&k)));
                    }
                    return Gate::Forward(msg);
                }
                _ => {}
            }
        }
        self.ignored += 1;
        if self.ignored >= IGNORED_LIMIT { Gate::Close } else { Gate::Ignored }
    }
}
