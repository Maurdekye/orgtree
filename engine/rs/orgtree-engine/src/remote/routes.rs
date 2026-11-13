//! Which engine a route belongs to (docs/rust-engine/remote-org.md, "Route
//! classes"). Every route of `http::router` has exactly one class:
//!
//! - `Org`: it belongs to one organization (`/api/orgs/{slug}` and below).
//! - `Engine`: it belongs to an engine. A request from a window bound to a
//!   remote organization (it carries `X-Orgtree-Remote`) is served by that
//!   remote engine; any other request by this one.
//! - `Local`: always this computer.
//!
//! A route added to `router` must be listed here unless it is an `Org` route:
//! `every_route_has_a_class` fails otherwise, so a new engine-wide route can
//! never act on the wrong machine by accident. An unknown path is `Local`:
//! nothing unlisted is ever sent to a remote engine.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Org,
    Engine,
    Local,
}

/// Routes of an engine: its accounts, providers, usage, model servers,
/// defaults, instructions, skills, templates, folders and its own facts.
pub const ENGINE: &[&str] = &[
    "/api/host",
    "/api/diagnostics/engine-stats",
    "/api/standalone/clients",
    "/api/standalone/clients/{id}",
    "/api/defaults",
    "/api/app-settings/runtime",
    "/api/app-settings/live-feed/agents",
    "/api/app-settings/live-feed/tokens",
    "/api/app-settings/live-feed/tokens/{id}",
    "/api/app-settings/instructions",
    "/api/app-settings/charter-template-dirs",
    "/api/providers",
    "/api/accounts",
    "/api/accounts/readout",
    "/api/accounts/keys",
    "/api/accounts/keys/{id}",
    "/api/accounts/order",
    "/api/accounts/usage",
    "/api/accounts/usage/{account}",
    "/api/accounts/{id}",
    "/api/accounts/{id}/identity",
    "/api/accounts/{id}/enabled",
    "/api/accounts/{id}/usage",
    "/api/accounts/{id}/marks",
    "/api/accounts/{id}/marks/clear",
    "/api/usage",
    "/api/usage/peek",
    "/api/usage/history",
    "/api/codex/usage",
    "/api/codex/usage/peek",
    "/api/antigravity/usage",
    "/api/antigravity/usage/peek",
    "/api/muse/usage",
    "/api/muse/usage/peek",
    "/api/openrouter/usage",
    "/api/openrouter/usage/peek",
    "/api/openrouter",
    "/api/openrouter/key",
    "/api/openrouter/keys",
    "/api/openrouter/keys/usage",
    "/api/openrouter/keys/{id}",
    "/api/openrouter/models",
    "/api/openrouter/favorites",
    "/api/harnesses",
    "/api/langservers",
    "/api/langservers/usage",
    "/api/langservers/probe",
    "/api/langservers/ollama-variant",
    "/api/langservers/{id}",
    "/api/langservers/{id}/key",
    "/api/providers/agy-models/refresh",
    "/api/providers/{provider}/enabled",
    "/api/providers/{provider}/apikey-fallback",
    "/api/providers/{provider}/subscription-inference",
    "/api/mcp-servers",
    "/api/mcp-servers/refresh",
    "/api/global-instructions/refresh",
    "/api/skills",
    "/api/skills/refresh",
    "/api/charters",
    "/api/charters/populate",
    "/api/charters/open",
    "/api/charters/{name}",
    "/api/templates",
    "/api/templates/populate",
    "/api/templates/open",
    "/api/templates/resolve",
    "/api/fs",
    "/api/markdown-image",
];

/// Routes of this computer: the desktop's own routes, the connections
/// themselves, the org list and the app feed (which this engine composes),
/// the changelog of this app, diagnostics, the user MCP endpoint and the
/// test rig.
pub const LOCAL: &[&str] = &[
    "/api/desktop/identity",
    "/api/desktop/credential-bridge",
    "/api/agent-credential",
    "/api/desktop/alive",
    "/api/desktop/status",
    "/api/desktop/shutdown",
    "/api/desktop/hub",
    "/api/desktop/hub/connections",
    "/api/desktop/hub/translation-key",
    "/api/desktop/phone",
    "/api/desktop/phone/card",
    "/api/desktop/phone/access",
    "/api/desktop/phone/code",
    "/api/desktop/phone/link",
    "/api/desktop/phone/unlink",
    "/api/desktop/phone/dismiss",
    "/api/desktop/phone/tailscale-login",
    "/api/desktop/maintenance/ack",
    "/api/desktop/maintenance/failure",
    "/api/net/probe",
    "/api/desktop/notifications",
    "/api/crash-report",
    "/api/diagnostics/ui-open",
    "/api/crash-reports",
    "/api/app/records",
    "/api/app/ws",
    "/api/mcp",
    "/api/remotes",
    "/api/remotes/{id}",
    "/api/remotes/{id}/retry",
    "/api/remotes/shown-as",
    "/api/remotes/{id}/people",
    "/api/remote-access",
    "/api/remote-access/stop",
    "/api/remote-access/orgs/{slug}",
    "/api/remote-access/orgs/{slug}/invitations",
    "/api/remote-access/orgs/{slug}/invitations/{id}",
    "/api/remote-access/orgs/{slug}/computers/{id}",
    "/api/remote-access/computers/{id}",
    "/api/orgs",
    "/api/changelog",
    "/api/changelog/{version}",
    "/api/rig/tool",
    "/api/rig/hub-mail",
];

/// The class of a route as `router` writes it.
#[nolog]
pub fn class_of_route(route: &str) -> Option<Class> {
    if route == "/api/orgs/{slug}" || route.starts_with("/api/orgs/{slug}/") {
        Some(Class::Org)
    } else if ENGINE.contains(&route) {
        Some(Class::Engine)
    } else if LOCAL.contains(&route) {
        Some(Class::Local)
    } else {
        None
    }
}

/// The class of a request path. `/api/orgs/<slug>` and below is `Org`; a
/// path that matches a listed engine route is `Engine`; everything else,
/// known or not, is `Local`.
#[nolog]
pub fn class(path: &str) -> Class {
    if org_of(path).is_some() {
        return Class::Org;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if ENGINE.iter().any(|route| crate::http::viewer::matches(route, &segments, "")) {
        Class::Engine
    } else {
        Class::Local
    }
}

/// The organization slug of an `Org` path and what follows it (empty, or
/// starting with `/`): `/api/orgs/acme/nodes/1/chat` is `("acme", "/nodes/1/chat")`.
#[nolog]
pub fn org_of(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/api/orgs/")?;
    let (slug, tail) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    (!slug.is_empty()).then_some((slug, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_has_a_class() {
        let routes = crate::http::viewer_tests::route_literals();
        assert!(routes.len() > 200, "the route table parse found only {} routes", routes.len());
        let unclassified: Vec<_> = routes.iter().filter(|route| class_of_route(route).is_none()).collect();
        assert!(unclassified.is_empty(),
            "routes with no class in remote/routes.rs (an organization's route goes below /api/orgs/{{slug}}; list any other in ENGINE or LOCAL): {unclassified:#?}");
    }

    #[test]
    fn the_lists_have_no_overlap_and_no_stale_entry() {
        let routes = crate::http::viewer_tests::route_literals();
        for route in ENGINE.iter().chain(LOCAL) {
            assert!(routes.iter().any(|r| r == route), "{route} is listed but is not a route");
            assert!(!route.starts_with("/api/orgs/"), "{route}: an organization's route needs no entry");
        }
        for route in ENGINE {
            assert!(!LOCAL.contains(route), "{route} is both an engine's and this computer's");
        }
    }

    #[test]
    fn request_paths_take_the_class_of_their_route() {
        for path in ["/api/orgs/acme", "/api/orgs/acme/ws", "/api/orgs/acme/nodes/12/chat", "/api/orgs/acme/unknown-child"] {
            assert_eq!(class(path), Class::Org, "{path}");
        }
        for path in ["/api/accounts", "/api/accounts/claude-5/usage", "/api/providers/claude/enabled", "/api/openrouter/keys/k1",
            "/api/app-settings/instructions", "/api/standalone/clients/abc", "/api/fs", "/api/host", "/api/langservers/3/key"] {
            assert_eq!(class(path), Class::Engine, "{path}");
        }
        // this computer's, and anything unknown: never sent to a remote engine
        for path in ["/api/orgs", "/api/orgs/", "/api/app/ws", "/api/app/records", "/api/desktop/alive", "/api/desktop/phone/link", "/api/remotes",
            "/api/remotes/x/retry", "/api/changelog/4.5.11", "/api/mcp", "/api/accounts/a/b/c/d", "/api/unknown", "/", "/index.html",
            "/assets/app.js", "/ls/1/v1/models", "/api/accounts/", "/api/providers//enabled"] {
            assert_eq!(class(path), Class::Local, "{path}");
        }
        assert_eq!(org_of("/api/orgs/acme/nodes/1/chat"), Some(("acme", "/nodes/1/chat")));
        assert_eq!(org_of("/api/orgs/acme"), Some(("acme", "")));
        assert_eq!(org_of("/api/orgs/"), None);
        assert_eq!(org_of("/api/orgs"), None);
    }
}
