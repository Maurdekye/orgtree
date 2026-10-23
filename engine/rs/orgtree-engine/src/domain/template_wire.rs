//! Nested v1 on disk, flat ownership in memory. No recursive tree values are
//! constructed, including on errors: Clone and Drop are independent of depth.
use serde::Deserialize;
use serde_json::{value::RawValue, Value};
use super::templates::{Slot, Template};

/// A physical layout root, independent of agent reporting through projects.
#[nolog]
pub(super) fn is_layout_root(slot: &Slot) -> bool { slot.parent.is_none() }

#[derive(Deserialize)]
pub(crate) struct Wire {
    id: String, name: String,
    #[serde(default)] description: String,
    #[serde(default = "one")] version: u64,
    #[serde(default)] agents: Option<Box<RawValue>>,
    #[serde(default)] org_md: Option<String>,
    #[serde(default)] shared_agents_md: Option<super::template_notes::Text>,
    #[serde(default)] quick_chat: Option<Value>,
    #[serde(default)] settings: Option<serde_json::Map<String, Value>>,
    #[serde(default)] watchdogs: Vec<super::template_links::Dog>,
    #[serde(default)] audiences: Vec<super::template_links::Grant>,
    #[serde(default)] warnings: Vec<String>,
}
#[nolog]
fn one() -> u64 { 1 }

/// RawValue's serde_json ignore_value validates JSON with a heap scratch stack.
/// Index that validated slice once, rather than reparsing each child subtree
/// (which would be quadratic for a chain). Tokens point past their subtree.
struct Token { start: usize, end: usize, next: usize }
#[nolog]
fn index(s: &str) -> Vec<Token> {
    let b = s.as_bytes(); let mut at = 0; let mut tokens: Vec<Token> = Vec::new(); let mut stack: Vec<usize> = Vec::new();
    while at < b.len() {
        match b[at] {
            b' ' | b'\t' | b'\r' | b'\n' | b',' | b':' => { at += 1; }
            b'}' | b']' => {
                at += 1; let parent = stack.pop().expect("validated JSON container");
                tokens[parent].end = at; tokens[parent].next = tokens.len();
            }
            b'{' | b'[' => {
                stack.push(tokens.len()); tokens.push(Token {start: at, end: 0, next: 0}); at += 1;
            }
            _ => {
                let start = at;
                if b[at] == b'"' {
                    at += 1;
                    while b[at] != b'"' { if b[at] == b'\\' { at += 1; } at += 1; }
                    at += 1;
                } else { while at < b.len() && !b" \t\r\n,]}".contains(&b[at]) { at += 1; } }
                tokens.push(Token {start, end: at, next: tokens.len() + 1});
            }
        }
    }
    tokens
}

impl TryFrom<Wire> for Template {
    type Error = String;
    #[nolog]
    fn try_from(w: Wire) -> Result<Self, String> {
        if w.version != 1 { return Err(format!("template format version {} is unsupported; this app reads nested format version 1", w.version)); }
        let raw = w.agents.as_deref().map(RawValue::get).unwrap_or("[]");
        let tape = index(raw);
        if !raw.starts_with('[') { return Err("template agents must be an array".into()); }
        let mut pending = Vec::new(); let mut child = 1;
        while child < tape[0].next { pending.push((child, None)); child = tape[child].next; }
        pending.reverse();
        let mut agents: Vec<Slot> = Vec::new();
        while let Some((node, parent)) = pending.pop() {
            if raw.as_bytes()[tape[node].start] != b'{' { return Err("a template node must be an object".into()); }
            let mut own = String::from("{"); let mut reports = None; let mut field = node + 1;
            while field < tape[node].next {
                let key: String = serde_json::from_str(&raw[tape[field].start..tape[field].end]).map_err(|e| e.to_string())?;
                let value = field + 1;
                if key == "reports" {
                    if reports.is_some() { return Err("duplicate reports field".into()); }
                    reports = Some(value);
                } else {
                    if own.len() > 1 { own.push(','); }
                    own.push_str(&raw[tape[field].start..tape[field].end]); own.push(':');
                    own.push_str(&raw[tape[value].start..tape[value].end]);
                }
                field = tape[value].next;
            }
            own.push('}');
            let mut slot: Slot = serde_json::from_str(&own).map_err(|e| format!("invalid template node: {e}"))?;
            slot.parent = parent; let at = agents.len(); agents.push(slot);
            if let Some(reports) = reports {
                if raw.as_bytes()[tape[reports].start] != b'[' { return Err("reports must be an array".into()); }
                let begin = pending.len(); let mut child = reports + 1;
                while child < tape[reports].next { pending.push((child, Some(at))); child = tape[child].next; }
                pending[begin..].reverse();
            }
        }
        Ok(Template { id:w.id, name:w.name, description:w.description, org_md:w.org_md, agents,
            shared_agents_md:w.shared_agents_md, quick_chat:w.quick_chat, settings:w.settings,
            watchdogs:w.watchdogs, audiences:w.audiences, warnings:w.warnings })
    }
}

/// Export metadata and individual node objects stay shallow. The only nested
/// representation is the resulting UTF-8 string, emitted with explicit tasks.
#[derive(Debug, Clone)]
pub struct Export { pub root: Value, pub nodes: Vec<Value>, pub children: Vec<Vec<usize>>, pub roots: Vec<usize> }
impl Export {
    #[nolog]
    pub fn body(&self) -> Result<String, String> {
        enum Task { Node(usize), Text(&'static str) }
        let mut out = serde_json::to_string(&self.root).map_err(|e| e.to_string())?;
        out.pop(); out.push_str(",\"agents\":[");
        let mut todo = vec![Task::Text("]}")];
        for (i, &node) in self.roots.iter().enumerate().rev() { todo.push(Task::Node(node)); if i > 0 { todo.push(Task::Text(",")); } }
        while let Some(task) = todo.pop() {
            match task {
                Task::Text(s) => out.push_str(s),
                Task::Node(at) => {
                    let mut own = serde_json::to_string(&self.nodes[at]).map_err(|e| e.to_string())?;
                    if self.children[at].is_empty() { out.push_str(&own); }
                    else {
                        own.pop(); out.push_str(&own); out.push_str(",\"reports\":["); todo.push(Task::Text("]}"));
                        for (i, &node) in self.children[at].iter().enumerate().rev() { todo.push(Task::Node(node)); if i > 0 { todo.push(Task::Text(",")); } }
                    }
                }
            }
            if out.len() as u64 > super::templates::FILE_MAX { return Err("template file exceeds 16 MiB".into()); }
        }
        Ok(out)
    }
}
