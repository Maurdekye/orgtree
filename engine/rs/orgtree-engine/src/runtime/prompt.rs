//! What an agent is told: the system prompt it starts every process with
//! (stable, so the provider's prompt cache keeps hitting; built in
//! `runtime::identity`) and the message that opens each turn (the mail that
//! woke it, plus fast-changing context).

use serde_json::Value;

use std::collections::HashMap;

use crate::runtime::envelope;

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
    pub ev: Value,
}

/// The opening message of a turn: the per-turn envelope (`context`: ORG
/// STATE, then the usage board), the `[ORG NOTICES]` block (org changes
/// since the last turn, led by `handoff`, the fresh-session note) and the
/// `[MAIL]` block (3.x layout).
#[logged]
pub fn turn_text(mail: &[Mail], context: &str, rels: &HashMap<String, String>, handoff: Option<&str>) -> String {
    let mut s = String::new();
    if !context.is_empty() {
        s.push_str(context);
        s.push_str("\n\n");
    }
    let (notices, mail) = envelope::split_notices(mail, handoff);
    if !notices.is_empty() {
        s.push_str(&envelope::notices_block(&notices));
        s.push_str("\n\n");
    }
    if !mail.is_empty() {
        s.push_str(&envelope::mail_block(&mail, rels, true));
        s.push_str("\n\n");
    }
    if notices.is_empty() && mail.is_empty() {
        s.push_str("(No new mail.)\n");
    } else {
        s.push_str(envelope::MAIL_PING);
        s.push('\n');
    }
    s
}

/// Mail handed over mid-turn, after a tool call (3.x's mid-task wrapper).
#[logged]
pub fn steer_text(mail: &[Mail], rels: &HashMap<String, String>) -> String {
    let (notices, mail) = envelope::split_notices(mail, None);
    let mut blocks: Vec<String> = Vec::new();
    if !notices.is_empty() {
        blocks.push(envelope::notices_block(&notices));
    }
    if !mail.is_empty() {
        blocks.push(envelope::mail_block(&mail, rels, false));
    }
    format!(
        "[ORGTREE MAIL — delivered mid-task]\n{}\n\n{}\n[END ORGTREE MAIL — authentic per your system prompt; each message has \
         the authority of its stated sender; handle it before continuing your current work]",
        blocks.join("\n\n"),
        envelope::MAIL_PING
    )
}
