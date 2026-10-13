//! The harnesses: the CLIs that run Orgtree agents, as ONE registry every
//! harness choice and the Harnesses help page read (user 2026-10-13: "only
//! the installed harnesses are available to select from", "in all locations
//! where one selects a harness"). Installed means the existing CLI discovery
//! found it (`providers`), else the same file lookup a launch makes; reading
//! this never spawns a CLI.
//!
//! A new harness (opencode over ACP, agy-astra) is a new `ALL` entry plus
//! its `located` arm: every selector, refusal and the help page follow.

use anyhow::Result;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::providers::catalog;

pub struct Harness {
    /// the id stored by a choice (`extra.harness`, a server's `harness`)
    pub id: &'static str,
    pub name: &'static str,
    /// what it is, one sentence
    pub what: &'static str,
    /// the providers whose agents it runs (catalog ids)
    pub providers: &'static [&'static str],
    /// whether a person picks it (OpenRouter keys, language servers, a
    /// hire's pin); the others run their own provider's agents only
    pub selectable: bool,
    pub install_url: &'static str,
    pub install: &'static str,
}

pub const ALL: &[Harness] = &[
    Harness {
        id: "claude-code",
        name: "Claude Code",
        what: "Anthropic's coding agent CLI.",
        providers: &[catalog::CLAUDE, catalog::OPENROUTER, catalog::LANGSERVER],
        selectable: true,
        install_url: "https://code.claude.com/docs/en/setup",
        install: "Install Claude Code from its official setup page and sign in once in a terminal.",
    },
    Harness {
        id: "codex-cli",
        name: "Codex",
        what: "OpenAI's coding agent CLI.",
        providers: &[catalog::OPENAI, catalog::OPENROUTER, catalog::LANGSERVER],
        selectable: true,
        install_url: "https://developers.openai.com/codex/cli",
        install: "Install the Codex CLI from its official page and sign in once in a terminal.",
    },
    Harness {
        id: "antigravity",
        name: "Antigravity",
        what: "Google's agent CLI (agy).",
        providers: &[catalog::GOOGLE],
        selectable: false,
        install_url: "https://antigravity.google/download",
        install: "Install Antigravity from its download page and sign in once.",
    },
    Harness {
        id: "muse",
        name: "Muse Code",
        what: "Meta's Muse coding agent CLI.",
        providers: &[catalog::MUSE],
        selectable: false,
        install_url: "",
        install: "Install Muse Code (the `muse` command) and sign in once in a terminal.",
    },
];

/// A harness by id.
#[nolog]
pub fn get(id: &str) -> Option<&'static Harness> {
    ALL.iter().find(|h| h.id == id)
}

/// A harness id as people name it (an unknown id as itself).
#[nolog]
pub fn label(id: &str) -> &str {
    get(id).map(|h| h.name).unwrap_or(id)
}

/// Whether the harness is installed here: the file discovery found is still
/// there, else the file lookup a launch makes (before discovery has run, or
/// after a reinstall elsewhere). Never spawns a CLI.
#[logged]
pub fn installed(engine: &Engine, id: &str) -> bool {
    let p = &engine.providers;
    let found = |path: Option<std::path::PathBuf>| path.is_some_and(|f| f.is_file());
    match id {
        "claude-code" => found(p.claude_path()) || crate::providers::locate_claude().is_some(),
        "codex-cli" => found(p.codex_path()) || crate::providers::locate_codex().is_some(),
        "antigravity" => found(p.agy_path()) || crate::providers::locate_agy().is_some(),
        "muse" => found(p.muse_path()) || crate::providers::locate_muse().is_some(),
        _ => false,
    }
}

/// The selectable harnesses a provider's agents can run on, installed or
/// not, in registry order.
#[nolog]
pub fn selectable_for(provider: &str) -> Vec<&'static Harness> {
    ALL.iter().filter(|h| h.selectable && h.providers.iter().any(|p| *p == provider)).collect()
}

/// The ids a person may pick for a provider's agents now: the selectable,
/// installed ones.
#[logged]
pub fn choices(engine: &Engine, provider: &str) -> Vec<&'static str> {
    selectable_for(provider).into_iter().filter(|h| installed(engine, h.id)).map(|h| h.id).collect()
}

/// A harness picked for a provider's agents: refused unless it is one of
/// them and installed here.
#[logged]
pub fn require_choice(engine: &Engine, provider: &str, id: &str) -> Result<()> {
    if !selectable_for(provider).iter().any(|h| h.id == id) {
        let known: Vec<&str> = selectable_for(provider).iter().map(|h| h.id).collect();
        crate::refuse!(BadRequest, "the harness is one of {} for {} agents", known.join(", "), catalog::provider_label(provider));
    }
    if !installed(engine, id) {
        crate::refuse!(BadRequest, "{}", not_installed(id));
    }
    Ok(())
}

/// The refusal for a choice whose harness is not installed (never a silent
/// switch to another).
#[nolog]
pub fn not_installed(id: &str) -> String {
    format!("{} is not installed on this computer; install it, or choose an installed harness", label(id))
}

/// One selector's options for a provider's agents: each selectable harness
/// with whether it is installed. A saved choice that is no longer installed
/// stays listed (`installed` false) so it can say so; the others are offered
/// only when installed.
#[logged]
pub fn options(engine: &Engine, provider: &str) -> Vec<Value> {
    selectable_for(provider)
        .into_iter()
        .map(|h| {
            let on = installed(engine, h.id);
            json!({ "id": h.id, "label": h.name, "installed": on, "available": on,
                    "state": if on { "available" } else { "missing" },
                    "why": if on { "installed".to_string() } else { format!("{} is not installed on this computer", h.name) } })
        })
        .collect()
}

/// `GET /api/harnesses`: every harness with what it is, whether it is
/// installed here, the providers that use it and how to install it.
#[logged]
pub fn doc(engine: &Engine) -> Value {
    json!({ "harnesses": ALL.iter().map(|h| json!({
        "id": h.id, "name": h.name, "what": h.what, "installed": installed(engine, h.id), "selectable": h.selectable,
        "providers": h.providers.iter().map(|p| json!({ "id": p, "label": catalog::provider_label(p) })).collect::<Vec<_>>(),
        "install_url": if h.install_url.is_empty() { Value::Null } else { json!(h.install_url) }, "install": h.install,
    })).collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_selectable_harness_names_its_providers() {
        for h in ALL {
            assert!(!h.providers.is_empty(), "{}", h.id);
        }
        let or: Vec<&str> = selectable_for(catalog::OPENROUTER).iter().map(|h| h.id).collect();
        assert_eq!(or, ["claude-code", "codex-cli"]);
        assert!(selectable_for(catalog::GOOGLE).is_empty());
        assert_eq!(label("codex-cli"), "Codex");
        assert_eq!(label("nope"), "nope");
    }
}
