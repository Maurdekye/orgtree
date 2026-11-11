//! What a viewer-scoped client token may call (docs/standalone-engine.md, "Viewer tokens").
//!
//! The guard (`http::guard`) asks `viewer_allows` for every request a viewer token makes, before
//! any handler or the credential/language-server dispatch runs. The default is refuse. A route
//! added to `router` must be classified here, as allowed or in `DENIED_FOR_VIEWER`: the
//! `every_route_is_classified_for_viewers` test fails otherwise, so read-only cannot widen by
//! accident.

use axum::http::Method;

/// `(method, route literal as written in `router`)`. `{slug}` must equal the token's org; every
/// other `{name}` is one non-empty segment and `{*rest}` one or more. Every row is a read except
/// the two user-owned writes (marking mail read, marking presentations viewed).
pub const ALLOWED: &[(&str, &str)] = &[
    ("GET", "/api/orgs/{slug}"),
    ("GET", "/api/orgs/{slug}/records"),
    ("GET", "/api/orgs/{slug}/records/selection"),
    ("GET", "/api/orgs/{slug}/changes"),
    ("GET", "/api/orgs/{slug}/foreground-tree"),
    ("GET", "/api/orgs/{slug}/foreground-tree/{*rest}"),
    ("GET", "/api/orgs/{slug}/nodes/{nid}/detail"),
    ("GET", "/api/orgs/{slug}/nodes/{nid}/states"),
    ("GET", "/api/orgs/{slug}/ws"),
    ("GET", "/api/orgs/{slug}/inbox"),
    ("GET", "/api/orgs/{slug}/mail/{box}/{id}"),
    ("POST", "/api/orgs/{slug}/inbox/read"),
    ("GET", "/api/orgs/{slug}/documents"),
    ("GET", "/api/orgs/{slug}/documents/{did}"),
    ("GET", "/api/orgs/{slug}/documents/{did}/mockup"),
    ("GET", "/api/orgs/{slug}/documents/{did}/download"),
    ("POST", "/api/orgs/{slug}/documents/viewed"),
    ("GET", "/api/orgs/{slug}/work-items"),
    ("GET", "/api/orgs/{slug}/work-items/{wid}"),
    ("GET", "/api/orgs/{slug}/work-items-view"),
    ("GET", "/api/orgs/{slug}/work-items-page"),
    ("GET", "/api/orgs/{slug}/work-items-foreground"),
    ("GET", "/api/orgs/{slug}/work-items-archive-page"),
    ("GET", "/api/orgs/{slug}/work-item-references"),
    ("GET", "/api/orgs/{slug}/work-item-reference/{wid}"),
];

/// Every other route of the router. Notable members: the org list, every `/api/standalone/*`,
/// `/api/app/ws`, every MCP endpoint, chat, node inboxes, files, scratch folders, tool input and
/// output, history, events, the org inbox and transfers, watchdogs, audiences, orgmd, undo history,
/// docket attachments and artifacts, the credential bridge, and every write.
pub const DENIED_FOR_VIEWER: &[&str] = &[
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
    "/api/host",
    "/api/diagnostics/engine-stats",
    "/api/app/records",
    "/api/app/ws",
    "/api/mcp",
    "/api/orgs/{slug}/mcp",
    "/api/standalone/clients",
    "/api/standalone/clients/{id}",
    "/api/orgs/{slug}/apps",
    "/api/orgs/{slug}/apps/bridge",
    "/api/orgs/{slug}/apps/runtime",
    "/api/orgs/{slug}/apps/files",
    "/api/orgs/{slug}/apps/media",
    "/api/orgs",
    "/api/orgs/{slug}/retry",
    "/api/orgs/{slug}/retired",
    "/api/orgs/{slug}/settings",
    "/api/orgs/{slug}/profile-picture",
    "/api/orgs/{slug}/profile-picture/preview",
    "/api/orgs/{slug}/net/profile-picture",
    "/api/orgs/{slug}/project-icon",
    "/api/orgs/{slug}/accounts-allowed",
    "/api/orgs/{slug}/asks/{aid}/answer",
    "/api/orgs/{slug}/credit-requests",
    "/api/orgs/{slug}/nodes/{nid}/batch",
    "/api/orgs/{slug}/watchdogs",
    "/api/orgs/{slug}/org_inbox",
    "/api/orgs/{slug}/transfers",
    "/api/orgs/{slug}/transfers/{id}",
    "/api/orgs/{slug}/net",
    "/api/orgs/{slug}/net/recent",
    "/api/orgs/{slug}/org_inbox/read",
    "/api/orgs/{slug}/audiences",
    "/api/orgs/{slug}/reply-source",
    "/api/orgs/{slug}/agents/{node}/files",
    "/api/orgs/{slug}/inbox/filter",
    "/api/orgs/{slug}/inbox/{id}",
    "/api/orgs/{slug}/inbox/clear",
    "/api/orgs/{slug}/events",
    "/api/orgs/{slug}/mention-navigation",
    "/api/orgs/{slug}/mention-candidates",
    "/api/orgs/{slug}/history",
    "/api/orgs/{slug}/history/{section}",
    "/api/orgs/{slug}/nodes/{nid}/history",
    "/api/orgs/{slug}/nodes/{nid}/reader-availability",
    "/api/orgs/{slug}/defaults",
    "/api/orgs/{slug}/orgmd",
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
    "/api/changelog",
    "/api/changelog/{version}",
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
    "/api/orgs/{slug}/template",
    "/api/fs",
    "/api/orgs/{slug}/ops",
    "/api/orgs/{slug}/gesture",
    "/api/orgs/{slug}/undo-history",
    "/api/orgs/{slug}/undo-history/undo",
    "/api/orgs/{slug}/undo-history/redo",
    "/api/orgs/{slug}/dissolve-all",
    "/api/orgs/{slug}/killswitch",
    "/api/orgs/{slug}/killswitch/release",
    "/api/orgs/{slug}/staffing-options",
    "/api/orgs/{slug}/staffing-options/refresh",
    "/api/orgs/{slug}/work-items/{wid}/reply",
    "/api/orgs/{slug}/work-items/{wid}/quick-staff",
    "/api/orgs/{slug}/work-items/{wid}/dismiss-attention",
    "/api/orgs/{slug}/work-items/{wid}/attachments",
    "/api/orgs/{slug}/work-items/{wid}/attachments/{aid}",
    "/api/orgs/{slug}/work-items/{wid}/artifacts/{aid}",
    "/api/orgs/{slug}/resume",
    "/api/orgs/{slug}/nodes/{nid}/chat",
    "/api/orgs/{slug}/nodes/{nid}/message",
    "/api/orgs/{slug}/nodes/{nid}/broadcast",
    "/api/orgs/{slug}/nodes/{nid}/mail/{mid}",
    "/api/orgs/{slug}/nodes/{nid}/inbox",
    "/api/orgs/{slug}/nodes/{nid}/interrupt",
    "/api/orgs/{slug}/nodes/{nid}/dnd",
    "/api/orgs/{slug}/nodes/{nid}/halt",
    "/api/orgs/{slug}/nodes/{nid}/unhalt",
    "/api/orgs/{slug}/nodes/{nid}/compact",
    "/api/orgs/{slug}/nodes/{nid}/harness",
    "/api/orgs/{slug}/hire-harness",
    "/api/orgs/{slug}/nodes/{nid}/process",
    "/api/orgs/{slug}/nodes/{nid}/unstick",
    "/api/orgs/{slug}/nodes/{nid}/continue-on",
    "/api/orgs/{slug}/nodes/{nid}/remote-control",
    "/api/orgs/{slug}/nodes/{nid}/mention-seen",
    "/api/orgs/{slug}/nodes/{nid}/scope",
    "/api/orgs/{slug}/nodes/{nid}/reorder",
    "/api/orgs/{slug}/nodes/{nid}/account",
    "/api/orgs/{slug}/nodes/{nid}/upload",
    "/api/orgs/{slug}/nodes/{nid}/file",
    "/api/markdown-image",
    "/api/orgs/{slug}/nodes/{nid}/toolimg/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/toolinput/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/helpertranscript/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/helpers",
    "/api/orgs/{slug}/nodes/{nid}/tooloutput/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/scratch-folder",
    "/api/rig/tool",
    "/api/rig/hub-mail",
];

#[nolog]
pub fn is_allowed_route(route: &str) -> bool { ALLOWED.iter().any(|(_, allowed)| *allowed == route) }

/// May a viewer token bound to `org` make this request? Matches by path segments. The only
/// mailbox a viewer reads is the user's own (`{box}` must be `user`).
#[nolog]
pub fn viewer_allows(method: &Method, path: &str, org: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    ALLOWED.iter().filter(|(m, _)| *m == method.as_str()).any(|(_, route)| matches(route, &segments, org))
}

#[nolog]
fn matches(route: &str, segments: &[&str], org: &str) -> bool {
    let pattern: Vec<&str> = route.split('/').collect();
    for (at, part) in pattern.iter().enumerate() {
        match *part {
            "{slug}" => if segments.get(at) != Some(&org) { return false; },
            "{*rest}" => {
                let rest = &segments[at.min(segments.len())..];
                return !rest.is_empty() && rest.iter().all(|s| !s.is_empty() && *s != "." && *s != "..");
            }
            "{box}" => if segments.get(at) != Some(&"user") { return false; },
            part if part.starts_with('{') => if segments.get(at).is_none_or(|s| s.is_empty()) { return false; },
            part => if segments.get(at) != Some(&part) { return false; },
        }
    }
    segments.len() == pattern.len()
}

/// The audit line for one viewer request: the client id, the method and the route cut at
/// `/api/<a>/<b>` (plus the fifth segment below `/api/orgs/{slug}`), never an id or a value.
#[nolog]
pub fn log_line(client_id: &str, method: &Method, path: &str, allowed: bool) -> String {
    let mut segments = path.split('/').take(5);
    let mut route = String::new();
    let mut orgs = false;
    for (at, segment) in segments.by_ref().enumerate() {
        match at {
            0 => {}
            1 | 3 => { route.push('/'); route.push_str(segment); }
            2 => { orgs = segment == "orgs"; route.push('/'); route.push_str(segment); }
            // the fifth segment (`documents`, `nodes`, `mail`...) only below /api/orgs/{slug}
            _ => if orgs { route.push('/'); route.push_str(segment); },
        }
    }
    format!("viewer client token {client_id} {method} {route} {}", if allowed { "allowed" } else { "refused" })
}
