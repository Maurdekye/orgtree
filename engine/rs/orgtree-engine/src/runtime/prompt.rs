//! What an agent is told: the system prompt it starts every process with
//! (stable, so the provider's prompt cache keeps hitting; built in
//! `runtime::identity`) and the message that opens each turn (the mail that
//! woke it, plus fast-changing context).

use serde_json::Value;

use crate::util::{gist, iso};

pub use super::identity::{identity, Identity, Lane};

/// One waiting message, as the agent reads it.
#[derive(Debug, serde::Serialize)]
pub struct Mail {
    pub uid: String,
    pub sender: String,
    pub kind: String,
    pub body: String,
    pub at: chrono::DateTime<chrono::Utc>,
    pub attachments: Value,
    pub notice: bool,
    pub urgent: bool,
    pub reply_to: Value,
}

#[logged]
fn envelope(m: &Mail) -> String {
    let from = if m.sender == "@user" { "the user".to_string() } else { m.sender.clone() };
    let mut s = format!("--- Mail from {from}");
    if m.kind != "message" {
        s.push_str(&format!(" ({})", m.kind));
    }
    if m.notice {
        s.push_str(" [notice — no reply expected]");
    }
    if m.urgent {
        s.push_str(" [urgent]");
    }
    s.push_str(&format!(" · {} · id {} ---\n", iso(m.at), m.uid));
    if let Some(q) = m.reply_to.get("gist").or_else(|| m.reply_to.get("quoted_context")).and_then(Value::as_str) {
        let who = m.reply_to.get("from").and_then(Value::as_str).unwrap_or("someone");
        s.push_str(&format!("> In reply to {who}: {}\n", gist(q, 200)));
    }
    s.push_str(m.body.trim_end());
    s.push('\n');
    if let Some(a) = m.attachments.as_array().filter(|a| !a.is_empty()) {
        s.push_str("Attachments:\n");
        for f in a {
            let path = f.get("path").and_then(Value::as_str).unwrap_or("");
            let name = f.get("name").and_then(Value::as_str).unwrap_or(path);
            s.push_str(&format!("- {name}: {path}\n"));
        }
    }
    s
}

/// The opening message of a turn.
#[logged]
pub fn turn_text(mail: &[Mail], context: &str) -> String {
    let mut s = String::new();
    if !context.is_empty() {
        s.push_str(context);
        s.push_str("\n\n");
    }
    if mail.is_empty() {
        s.push_str("(No new mail.)\n");
    }
    for m in mail {
        s.push_str(&envelope(m));
        s.push('\n');
    }
    s
}

/// Mail handed over mid-turn, after a tool call.
#[logged]
pub fn steer_text(mail: &[Mail]) -> String {
    let mut s = String::from("[Orgtree] New mail arrived while you were working:\n\n");
    for m in mail {
        s.push_str(&envelope(m));
        s.push('\n');
    }
    s
}
