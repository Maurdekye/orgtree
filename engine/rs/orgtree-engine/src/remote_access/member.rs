//! What a computer a hosting desktop let in may call
//! (docs/rust-engine/remote-org.md, "What a member may do").
//!
//! The door's guard (`remote_access::admit`) asks `verdict` for every request
//! a member token makes, before any handler or dispatch runs. The default is
//! refuse. Every route of `http::router` is in exactly one list here, and
//! `every_route_is_classified_for_members` fails for a route that is in none:
//! a new route cannot become reachable from another computer by accident.
//!
//! The rule the lists follow: a member has the whole of an organization it
//! was given, as its owner has, and nothing that belongs to the app or to the
//! hosting computer. So the organization's routes are `ORG`; the few of them
//! that reach beyond the organization are in `REFUSED` with everything
//! app-wide.

use axum::http::Method;

use crate::remote::routes::org_of;

/// Routes of an organization: every method the router has for them.
pub const ORG: &[&str] = &[
    "/api/orgs/{slug}/apps",
    "/api/orgs/{slug}/apps/bridge",
    "/api/orgs/{slug}/apps/runtime",
    "/api/orgs/{slug}/apps/files",
    "/api/orgs/{slug}/apps/media",
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
    "/api/orgs/{slug}/documents",
    "/api/orgs/{slug}/agents/{node}/files",
    "/api/orgs/{slug}/documents/viewed",
    "/api/orgs/{slug}/documents/{did}",
    "/api/orgs/{slug}/documents/{did}/mockup",
    "/api/orgs/{slug}/documents/{did}/download",
    "/api/orgs/{slug}/inbox",
    "/api/orgs/{slug}/inbox/filter",
    "/api/orgs/{slug}/inbox/{id}",
    "/api/orgs/{slug}/inbox/read",
    "/api/orgs/{slug}/inbox/clear",
    "/api/orgs/{slug}/mail/{box}/{id}",
    "/api/orgs/{slug}/events",
    "/api/orgs/{slug}/mention-navigation",
    "/api/orgs/{slug}/mention-candidates",
    "/api/orgs/{slug}/history",
    "/api/orgs/{slug}/history/{section}",
    "/api/orgs/{slug}/nodes/{nid}/history",
    "/api/orgs/{slug}/nodes/{nid}/states",
    "/api/orgs/{slug}/nodes/{nid}/detail",
    "/api/orgs/{slug}/nodes/{nid}/reader-availability",
    "/api/orgs/{slug}/defaults",
    "/api/orgs/{slug}/orgmd",
    "/api/orgs/{slug}/ops",
    "/api/orgs/{slug}/gesture",
    "/api/orgs/{slug}/undo-history",
    "/api/orgs/{slug}/undo-history/undo",
    "/api/orgs/{slug}/undo-history/redo",
    "/api/orgs/{slug}/dissolve-all",
    "/api/orgs/{slug}/killswitch",
    "/api/orgs/{slug}/killswitch/release",
    "/api/orgs/{slug}/ws",
    "/api/orgs/{slug}/records",
    "/api/orgs/{slug}/changes",
    "/api/orgs/{slug}/records/selection",
    "/api/orgs/{slug}/foreground-tree",
    "/api/orgs/{slug}/foreground-tree/{*rest}",
    "/api/orgs/{slug}/work-items-foreground",
    "/api/orgs/{slug}/work-items-archive-page",
    "/api/orgs/{slug}/work-item-references",
    "/api/orgs/{slug}/work-item-reference/{wid}",
    "/api/orgs/{slug}/work-items-page",
    "/api/orgs/{slug}/work-items-view",
    "/api/orgs/{slug}/staffing-options",
    "/api/orgs/{slug}/staffing-options/refresh",
    "/api/orgs/{slug}/work-items",
    "/api/orgs/{slug}/work-items/{wid}",
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
    "/api/orgs/{slug}/nodes/{nid}/toolimg/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/toolinput/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/helpertranscript/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/helpers",
    "/api/orgs/{slug}/nodes/{nid}/tooloutput/{seq}/{tool}",
    "/api/orgs/{slug}/nodes/{nid}/scratch-folder",
];

/// Read only: `GET` (and `HEAD`), no other method. The organization itself is
/// here because deleting it is its owner's alone. The app feed is the one made
/// for a member (`appfeed::Audience::Member`). The app-wide reads are what a
/// window of an organization needs to offer tiers, accounts, skills, charters,
/// templates and folders; each answer passes `shown::answer`, which takes the
/// owner's e-mail addresses and every mention of another organization out.
pub const READ: &[&str] = &[
    "/api/orgs/{slug}",
    "/api/desktop/alive",
    "/api/host",
    "/api/app/records",
    "/api/app/ws",
    "/api/providers",
    "/api/accounts",
    "/api/harnesses",
    "/api/skills",
    "/api/charters",
    "/api/templates",
    "/api/defaults",
    "/api/mcp-servers",
    "/api/fs",
    "/api/markdown-image",
];

/// The member's own client record: read it, set its label, delete it. `{id}`
/// must be the member's own id.
pub const OWN: &[(&str, &str)] = &[
    ("GET", "/api/standalone/clients"),
    ("PATCH", "/api/standalone/clients/{id}"),
    ("DELETE", "/api/standalone/clients/{id}"),
];

/// All a one-time code may do: see that an engine answers, read what it is,
/// and make the one computer it is for.
pub const INVITATION: &[(&str, &str)] = &[
    ("GET", "/api/desktop/alive"),
    ("GET", "/api/host"),
    ("POST", "/api/standalone/clients"),
];

/// Every other route of the router: everything app-wide and everything of the
/// hosting computer. Two routes below an organization are here because they
/// reach beyond it: the user MCP endpoint, and saving the organization as a
/// template into the app's templates folder.
pub const REFUSED: &[&str] = &[
    "/api/desktop/identity",
    "/api/desktop/credential-bridge",
    "/api/agent-credential",
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
    "/api/diagnostics/engine-stats",
    "/api/mcp",
    "/api/orgs/{slug}/mcp",
    "/api/remotes",
    "/api/remotes/shown-as",
    "/api/remotes/{id}",
    "/api/remotes/{id}/retry",
    "/api/remotes/{id}/people",
    "/api/remote-access",
    "/api/remote-access/stop",
    "/api/remote-access/orgs/{slug}",
    "/api/remote-access/orgs/{slug}/invitations",
    "/api/remote-access/orgs/{slug}/invitations/{id}",
    "/api/remote-access/orgs/{slug}/computers/{id}",
    "/api/remote-access/computers/{id}",
    "/api/orgs",
    "/api/app-settings/runtime",
    "/api/app-settings/live-feed/agents",
    "/api/app-settings/live-feed/tokens",
    "/api/app-settings/live-feed/tokens/{id}",
    "/api/app-settings/instructions",
    "/api/app-settings/charter-template-dirs",
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
    "/api/mcp-servers/refresh",
    "/api/global-instructions/refresh",
    "/api/skills/refresh",
    "/api/charters/populate",
    "/api/charters/open",
    "/api/charters/{name}",
    "/api/templates/populate",
    "/api/templates/open",
    "/api/templates/resolve",
    "/api/orgs/{slug}/template",
    "/api/rig/tool",
    "/api/rig/hub-mail",
];

/// Which list a route of the router is in, by the route as `router` writes it.
#[nolog]
pub fn listed(route: &str) -> usize {
    [ORG.contains(&route), READ.contains(&route), OWN.iter().any(|(_, own)| *own == route), REFUSED.contains(&route)]
        .into_iter().filter(|found| *found).count()
}

/// How the organization a path names stands to the member that asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// One it was given, and its owner lets other computers open it now.
    Open,
    /// One it was given whose switch is off.
    Shut,
    /// Not its own; or there is none of that name. The two are answered alike,
    /// so a member cannot learn what else the hosting desktop has.
    Foreign,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// 403 with E17: this is not the member's.
    Refuse,
    /// 403 with E16: an organization it was given, switched off.
    Shut,
}

/// May the member `client_id` make this request? `standing` says how the
/// organization of an organization path stands to it; it is asked for no
/// other path.
#[nolog]
pub fn verdict(method: &Method, path: &str, client_id: &str, standing: impl FnOnce(&str) -> Standing) -> Verdict {
    let segments: Vec<&str> = path.split('/').collect();
    let read = method == Method::GET || method == Method::HEAD;
    if let Some((slug, _)) = org_of(path) {
        return match standing(slug) {
            Standing::Foreign => Verdict::Refuse,
            Standing::Shut => Verdict::Shut,
            Standing::Open => {
                let known = ORG.iter().any(|route| matches(route, &segments, slug))
                    || (read && READ.iter().any(|route| matches(route, &segments, slug)));
                if known { Verdict::Allow } else { Verdict::Refuse }
            }
        };
    }
    let allowed = (read && READ.iter().any(|route| matches(route, &segments, "")))
        || OWN.iter().any(|(m, route)| *m == method.as_str() && own(route, &segments, client_id));
    if allowed { Verdict::Allow } else { Verdict::Refuse }
}

/// May a one-time code make this request?
#[nolog]
pub fn invitation_allows(method: &Method, path: &str) -> bool {
    INVITATION.iter().any(|(m, route)| *m == method.as_str() && *route == path)
}

/// Does the path (split at `/`) match the route literal? `{slug}` must be
/// `slug`; `{*rest}` is one or more plain segments; any other `{name}` is one
/// non-empty segment that is not `.` or `..`.
#[nolog]
fn matches(route: &str, segments: &[&str], slug: &str) -> bool {
    let pattern: Vec<&str> = route.split('/').collect();
    let plain = |segment: &&str| !segment.is_empty() && *segment != "." && *segment != "..";
    for (at, part) in pattern.iter().enumerate() {
        match *part {
            "{slug}" => if slug.is_empty() || segments.get(at) != Some(&slug) { return false; },
            "{*rest}" => {
                let rest = &segments[at.min(segments.len())..];
                return !rest.is_empty() && rest.iter().all(plain);
            }
            part if part.starts_with('{') => if !segments.get(at).is_some_and(plain) { return false; },
            part => if segments.get(at) != Some(&part) { return false; },
        }
    }
    segments.len() == pattern.len()
}

/// The member's own record: the list route itself, or the record route with
/// the member's own id.
#[nolog]
fn own(route: &str, segments: &[&str], client_id: &str) -> bool {
    let pattern: Vec<&str> = route.split('/').collect();
    segments.len() == pattern.len() && !client_id.is_empty()
        && pattern.iter().zip(segments).all(|(part, segment)| if *part == "{id}" { *segment == client_id } else { part == segment })
}

/// The audit line for one request at the door: who asked (a computer's id, or
/// `code` for a one-time code), the method and the route cut short
/// (`http::viewer::trimmed`), never an id or a value.
#[nolog]
pub fn log_line(who: &str, method: &Method, path: &str, outcome: &str) -> String {
    format!("remote access {who} {method} {} {outcome}", crate::http::viewer::trimmed(path))
}
