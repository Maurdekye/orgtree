//! Agents, teams and projects as one file: export, import and duplicate
//! (docs/rust-engine/agent-export.md; docket
//! `agent-team-project-export-import-and-duplication`).
//!
//! USER 2026-11-23 10:32Z mb05f4fda0d92: a chosen agent, alone or with its
//! whole subtree, is exported as a single zip holding all of its context, and
//! imported under a node; agents do the same within their own subtree; a
//! duplicate tool sits on top. Rulings 10:43Z m3c072bcdc19a and 20:30Z
//! m2106530cca00 are quoted where they decide something.

pub mod credits;
pub mod export;
pub mod format;
pub mod import;
pub mod jobs;
pub mod names;
pub mod paths;
pub mod plan;
pub mod reader;
pub mod seal;
pub mod secrets;
pub mod service;
pub mod sessions;

/// The most an export may hold, unpacked, and the most a file sent to another organization
/// of this computer may hold (USER 2026-11-23 20:30Z m2106530cca00: "256gb").
pub const SIZE_MAX: u64 = 256 * 1024 * 1024 * 1024;
