//! What an export file holds: the names of its parts and the shape of its
//! records (docs/rust-engine/agent-export.md, "The file").
//!
//! Every record is read with defaults for what it lacks and without minding
//! what it does not know, so a file from another Orgtree version is read as
//! far as it is understood. USER 2026-11-23 10:43Z: the file is stamped with
//! the Orgtree version it came from, and the version is not checked for now.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `kind` of a manifest.
pub const KIND: &str = "orgtree-export";
/// The layout described here.
pub const FORMAT: u32 = 1;

pub const MANIFEST: &str = "manifest.json";
pub const NODES: &str = "nodes.json";
pub const LINKS: &str = "links.json";
pub const MAIL: &str = "mail.jsonl";
pub const EVENTS: &str = "events.jsonl";
pub const INDEX: &str = "index.jsonl";
pub const SECRETS_REPORT: &str = "report/secrets.json";
pub const NOT_INCLUDED: &str = "report/not-included.txt";

/// The parts of one node, under its folder `nodes/<nnnn>-<name>/`.
pub const CONVO: &str = "convo.jsonl";
pub const TOOL_IMAGES: &str = "tool-images.jsonl";
pub const TURNS: &str = "turns.jsonl";
pub const SESSIONS: &str = "sessions.jsonl";
pub const ASKS: &str = "asks.jsonl";
pub const DOCUMENTS: &str = "documents.jsonl";
pub const DELIVERIES: &str = "deliveries.jsonl";
pub const UPLOADS: &str = "uploads.jsonl";
pub const DOCKET: &str = "docket.jsonl";
pub const ICON: &str = "icon.json";
pub const SCRATCH: &str = "scratch";
pub const TEAM: &str = "team";
pub const UPLOAD_FILES: &str = "uploads";
pub const DOCKET_FILES: &str = "docket";
pub const NATIVE: &str = "native";

/// The most the small parts may hold, read whole into memory.
pub const MANIFEST_MAX: u64 = 1024 * 1024;
pub const NODES_MAX: u64 = 64 * 1024 * 1024;
pub const LINKS_MAX: u64 = 64 * 1024 * 1024;

/// Which parts an export takes. Everything by default but retired agents.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Include {
    pub scratch: bool,
    pub team: bool,
    pub transcript: bool,
    pub native_sessions: bool,
    pub retired: bool,
}

impl Default for Include {
    fn default() -> Self {
        Include { scratch: true, team: true, transcript: true, native_sessions: true, retired: false }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Origin {
    /// The exporting engine's own id (its seal key's fingerprint): the same on every export of one computer.
    pub engine: String,
    pub org_uuid: String,
    pub org_slug: String,
    pub org_name: String,
    /// `user`, or the name of the agent that exported.
    pub by: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Counts {
    pub agents: u64,
    pub projects: u64,
    pub retired: u64,
    pub files: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sizes {
    /// What the parts hold unpacked.
    pub unpacked: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretsNote {
    pub stripped: bool,
    pub detected: u64,
    /// Sealed watchdog credentials travel in this file (a manual export with stripping off).
    pub watchdog_credentials: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Manifest {
    pub kind: String,
    pub format: u32,
    /// Recorded, not checked (USER 2026-11-23 10:43Z).
    pub orgtree_version: String,
    pub exported_at: String,
    pub origin: Origin,
    /// The exported node's name.
    pub root: String,
    pub subtree: bool,
    pub duplicate: bool,
    pub counts: Counts,
    pub bytes: Sizes,
    pub include: Include,
    pub secrets: SecretsNote,
    /// SHA-256 of `index.jsonl`, which names every other part with its size and SHA-256.
    pub index_sha256: String,
    /// The exporting engine's seal over this manifest without the seal (`portable::seal`).
    pub seal: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AccountRef {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SessionRef {
    pub id: String,
    /// The harness its files are for: `claude-code`, `codex-cli`, `opencode`, ...
    pub harness: String,
    /// Its files are in the node's `native/` folder.
    pub files: bool,
}

/// One exported node. Numeric ids never travel: a node is its place in `nodes.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Node {
    pub name: String,
    /// Its parent's place in the list; `None` for the exported root.
    pub parent: Option<usize>,
    /// `agent` or `project`.
    pub kind: String,
    /// Archived where it was exported.
    pub retired: bool,
    pub title: String,
    /// An agent's charter; a project's description.
    pub charter: Option<String>,
    pub team_charter: Option<String>,
    pub tier: String,
    pub account: Option<AccountRef>,
    pub seat: f64,
    pub grant: f64,
    /// The part of the grant its exported reports do not hold.
    pub spare: f64,
    /// Its stored scope (`domain::scope`), project settings included.
    pub scope: Value,
    /// The harness an OpenRouter or language model server seat is pinned to.
    pub harness_pin: Option<String>,
    pub provider: Option<String>,
    pub session: Option<SessionRef>,
    pub born: String,
    pub generation: i32,
    pub created_at: Option<String>,
    pub cost_usd: f64,
    pub api_cost_usd: f64,
    pub cost_unknown: bool,
    pub context_window: Option<i32>,
    pub last_status: Option<Value>,
    /// A turn was running when it was exported.
    pub mid_turn: bool,
    /// Mail that waited for it, undelivered, when it was exported.
    pub waiting_mail: u64,
    /// An open question to the user when it was exported.
    pub open_ask: bool,
    /// Its folder in the file: `nodes/<nnnn>-<name>`.
    pub dir: String,
    /// Where its scratch folder was, for rewriting stored paths.
    pub scratch_dir: String,
    /// Where its uploads and team folder were.
    pub uploads_dir: String,
    pub team_dir: String,
}

#[nolog]
impl Node {
    pub fn project(&self) -> bool {
        self.kind == "project"
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Nodes {
    pub nodes: Vec<Node>,
}

/// One end of an audience: an exported node, the user, or outside mail.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum End {
    Node(usize),
    User,
    Extern,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Audience {
    pub grantee: End,
    pub grantor: End,
}

/// A watchdog definition, as templates carry them (`domain::template_links::Dog`), with its
/// owner as a place in `nodes.json` and, in a manual export that strips nothing, its
/// credentials.
#[derive(Clone, Serialize, Deserialize)]
pub struct Watchdog {
    pub owner: usize,
    pub args: Value,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub needs_credentials: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<Value>,
}

impl std::fmt::Debug for Watchdog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[exported watchdog definition]")
    }
}

/// A docket item an exported node takes part in without owning it: named, not copied.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DocketRef {
    pub node: usize,
    pub slug: String,
    pub title: String,
    /// `reviewer` or `participant`.
    pub role: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Links {
    pub audiences: Vec<Audience>,
    pub watchdogs: Vec<Watchdog>,
    pub docket_refs: Vec<DocketRef>,
    /// What was left behind, in sentences: a grant with a node outside the export, a watchdog on one.
    pub left_out: Vec<String>,
}

/// One line of `index.jsonl`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct IndexLine {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// How many records a part written line by line holds: an import numbers a transcript's
    /// rows from its last one backwards, so it must know their count before it reads them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
}

/// The folder of node `i` (zero-based) in the file.
#[nolog]
pub fn node_dir(i: usize, name: &str) -> String {
    format!("nodes/{:04}-{name}", i + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_reads_what_it_knows_and_ignores_the_rest() {
        let text = r#"{ "kind": "orgtree-export", "format": 7, "orgtree_version": "9.9.9", "root": "lead", "subtree": true,
            "origin": { "org_slug": "there", "by": "user", "later_field": [1, 2] },
            "include": { "scratch": false, "something_new": true },
            "secrets": { "detected": 4 }, "a_later_part": { "x": 1 } }"#;
        let m: Manifest = serde_json::from_str(text).unwrap();
        assert_eq!((m.kind.as_str(), m.format, m.orgtree_version.as_str(), m.root.as_str(), m.subtree), (KIND, 7, "9.9.9", "lead", true));
        assert_eq!((m.origin.org_slug.as_str(), m.origin.by.as_str(), m.origin.engine.as_str()), ("there", "user", ""));
        // what the file does not say takes its default
        assert_eq!(m.include, Include { scratch: false, ..Include::default() });
        assert_eq!((m.secrets.detected, m.secrets.stripped, m.seal.clone()), (4, false, None));
        assert!(!Include::default().retired && Include::default().native_sessions);
    }

    #[test]
    fn a_node_is_its_place_in_the_list() {
        let nodes: Nodes = serde_json::from_str(r#"{ "nodes": [
            { "name": "lead", "kind": "agent", "tier": "fable", "seat": 8, "grant": 20.5, "scope": { "tools": { "bash": true } } },
            { "name": "box", "parent": 0, "kind": "project", "tier": "project" },
            { "name": "old", "parent": 1, "retired": true } ] }"#).unwrap();
        assert_eq!(nodes.nodes.len(), 3);
        assert_eq!((nodes.nodes[0].parent, nodes.nodes[1].parent, nodes.nodes[2].parent), (None, Some(0), Some(1)));
        assert!(nodes.nodes[1].project() && !nodes.nodes[0].project());
        assert_eq!((nodes.nodes[0].grant, nodes.nodes[2].retired, nodes.nodes[2].kind.as_str()), (20.5, true, ""));
        assert_eq!(node_dir(0, "lead"), "nodes/0001-lead");
        assert_eq!(node_dir(11, "w.x"), "nodes/0012-w.x");
    }

    #[test]
    fn links_name_nodes_by_place_and_keep_credentials_out_of_debug_output() {
        let links = Links {
            audiences: vec![Audience { grantee: End::Node(1), grantor: End::User }, Audience { grantee: End::Node(0), grantor: End::Extern }],
            watchdogs: vec![Watchdog { owner: 1, args: serde_json::json!({ "kind": "mqtt" }), paused: false, needs_credentials: true,
                                       credentials: Some(serde_json::json!({ "password": "do-not-print" })) }],
            ..Links::default()
        };
        let text = serde_json::to_string(&links).unwrap();
        assert!(text.contains(r#"{"grantee":{"node":1},"grantor":"user"}"#), "{text}");
        assert!(text.contains(r#""grantor":"extern""#));
        let back: Links = serde_json::from_str(&text).unwrap();
        assert_eq!(back.audiences, links.audiences);
        assert_eq!(back.watchdogs[0].credentials, links.watchdogs[0].credentials);
        assert!(!format!("{:?}", links).contains("do-not-print"));
        // a definition without credentials writes no member for them
        let plain = serde_json::to_string(&Watchdog { owner: 0, args: serde_json::json!({}), paused: true, needs_credentials: false, credentials: None }).unwrap();
        assert!(!plain.contains("\"credentials\":"), "{plain}");
    }
}
