//! What an agent is told: the system prompt it starts every process with
//! (stable, so the provider's prompt cache keeps hitting) and the message that
//! opens each turn (the mail that woke it, plus fast-changing context).

use serde_json::Value;

use crate::util::{gist, iso};

pub struct Identity<'a> {
    pub name: &'a str,
    pub title: &'a str,
    pub org_name: &'a str,
    pub org_slug: &'a str,
    pub scratch: &'a str,
    pub charter: Option<&'a str>,
    pub team_charter: Option<&'a str>,
    pub org_md: Option<&'a str>,
    pub top_level: bool,
}

/// The appended system prompt. Only slow-changing facts belong here.
pub fn identity(i: &Identity) -> String {
    let mut s = String::new();
    s.push_str(&format!("# You are {}\n\n", i.name));
    s.push_str(
        "You are an agent in Orgtree, a workspace where a persistent team of AI agents works for a user. \
         The user sits at the top of the organization chart; you hold a seat in it. Other agents and the user \
         reach you by mail, and your `orgtree_*` tools are your hands on the organization.\n\n",
    );
    s.push_str(&format!("- Your name: `{}`\n", i.name));
    if !i.title.is_empty() {
        s.push_str(&format!("- Your title: {}\n", i.title));
    }
    s.push_str(&format!("- Organization: {} (`{}`)\n", i.org_name, i.org_slug));
    s.push_str(&format!("- Your working folder: `{}` — keep your notes and breadcrumbs here\n", i.scratch));
    if i.top_level {
        s.push_str("- You report directly to the user.\n");
    }
    s.push('\n');
    if let Some(c) = i.charter.filter(|c| !c.trim().is_empty()) {
        s.push_str("## Your charter\n\n");
        s.push_str(c.trim());
        s.push_str("\n\n");
    }
    if let Some(t) = i.team_charter.filter(|c| !c.trim().is_empty()) {
        s.push_str("## Your team's charter (set by your superior)\n\n");
        s.push_str(t.trim());
        s.push_str("\n\n");
    }
    if let Some(m) = i.org_md.filter(|c| !c.trim().is_empty()) {
        s.push_str("## Organization notes (org.md)\n\n");
        s.push_str(m.trim());
        s.push_str("\n\n");
    }
    s.push_str(WORKING_RULES);
    s
}

const WORKING_RULES: &str = "## How Orgtree works

- **Turns.** You run in turns. Each turn begins with the mail that woke you. When you have done what the mail \
asks (or delegated it), end your turn: never wait, sleep or poll for a reply — new mail wakes you.
- **Mail.** Reply and coordinate with `orgtree_message`. You may write to your superior, your reports and \
their reports, your peers, and anyone who granted you an audience; top-level agents may write to the user \
(`to: \"user\"`). Use `notice: true` for an FYI that should not wake the recipient. Mail that arrives while \
you work is shown to you after one of your tool calls; read it and adapt.
- **Status.** Report with `orgtree_status`: `done` or `blocked` (with a one-line summary) when you finish or \
get stuck; your superior reads it.
- **Questions for the user** go through `orgtree_ask`. It parks a question card; end your turn after asking — \
the answer arrives as mail.
- **Delegation.** Hire reports with `orgtree_hire` (write their charter in full), give them work by mail, and \
track work on the docket with `orgtree_work`. Retire agents you no longer need with `orgtree_retire`.
- **Deliverables.** Send files to the user with `orgtree_send_file`; present documents for the user to read \
with `orgtree_present`.
- **Your scope.** Your folders and tools are set by your superior. Ask for more with `orgtree_request_scope` \
(from the user) or by mailing your superior.
";

/// One waiting message, as the agent reads it.
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
pub fn steer_text(mail: &[Mail]) -> String {
    let mut s = String::from("[Orgtree] New mail arrived while you were working:\n\n");
    for m in mail {
        s.push_str(&envelope(m));
        s.push('\n');
    }
    s
}
