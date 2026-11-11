use super::viewer::*;
use axum::http::Method;

fn allows(method: &str, path: &str) -> bool { viewer_allows(&method.parse::<Method>().unwrap(), path, "galaxy") }

const ALLOWED_CASES: &[(&str, &str)] = &[
    ("GET", "/api/orgs/galaxy"),
    ("GET", "/api/orgs/galaxy/records"),
    ("GET", "/api/orgs/galaxy/records/selection"),
    ("GET", "/api/orgs/galaxy/changes"),
    ("GET", "/api/orgs/galaxy/foreground-tree"),
    ("GET", "/api/orgs/galaxy/foreground-tree/a/b"),
    ("GET", "/api/orgs/galaxy/nodes/12/detail"),
    ("GET", "/api/orgs/galaxy/nodes/12/states"),
    ("GET", "/api/orgs/galaxy/ws"),
    ("GET", "/api/orgs/galaxy/inbox"),
    ("GET", "/api/orgs/galaxy/mail/user/5"),
    ("POST", "/api/orgs/galaxy/inbox/read"),
    ("GET", "/api/orgs/galaxy/documents"),
    ("GET", "/api/orgs/galaxy/documents/7"),
    ("GET", "/api/orgs/galaxy/documents/7/mockup"),
    ("GET", "/api/orgs/galaxy/documents/7/download"),
    ("POST", "/api/orgs/galaxy/documents/viewed"),
    ("GET", "/api/orgs/galaxy/work-items"),
    ("GET", "/api/orgs/galaxy/work-items/9"),
    ("GET", "/api/orgs/galaxy/work-items-view"),
    ("GET", "/api/orgs/galaxy/work-items-page"),
    ("GET", "/api/orgs/galaxy/work-items-foreground"),
    ("GET", "/api/orgs/galaxy/work-items-archive-page"),
    ("GET", "/api/orgs/galaxy/work-item-references"),
    ("GET", "/api/orgs/galaxy/work-item-reference/9"),
];

#[test]
fn every_allowed_row_passes_for_its_own_org_only() {
    for (method, path) in ALLOWED_CASES {
        assert!(allows(method, path), "{method} {path} must be allowed for org galaxy");
        let other = path.replacen("/galaxy", "/other", 1);
        assert!(!allows(method, &other), "{method} {other} must be refused for org galaxy");
        let prefix = path.replacen("/galaxy", "/galaxy2", 1);
        assert!(!allows(method, &prefix), "{method} {prefix} must be refused for org galaxy");
    }
}

#[test]
fn everything_else_is_refused() {
    let refused: &[(&str, &str)] = &[
        ("DELETE", "/api/orgs/galaxy/documents/7"),
        ("POST", "/api/orgs/galaxy/documents/7"),
        ("POST", "/api/orgs/galaxy/inbox/clear"),
        ("DELETE", "/api/orgs/galaxy/inbox/5"),
        ("POST", "/api/orgs/galaxy/inbox/filter"),
        ("GET", "/api/orgs"),
        ("POST", "/api/orgs"),
        ("DELETE", "/api/orgs/galaxy"),
        ("POST", "/api/orgs/galaxy"),
        ("GET", "/api/standalone/clients"),
        ("POST", "/api/standalone/clients"),
        ("DELETE", "/api/standalone/clients/x"),
        ("GET", "/api/app/ws"),
        ("GET", "/api/app/records"),
        ("POST", "/api/mcp"),
        ("POST", "/api/orgs/galaxy/mcp"),
        ("GET", "/api/orgs/galaxy/mail/node/5"),
        ("GET", "/api/orgs/galaxy/mail/org/5"),
        ("GET", "/api/orgs/galaxy/nodes/1/chat"),
        ("GET", "/api/orgs/galaxy/nodes/1/inbox"),
        ("GET", "/api/orgs/galaxy/nodes/1/file"),
        ("GET", "/api/orgs/galaxy/nodes/1/history"),
        ("POST", "/api/orgs/galaxy/nodes/1/message"),
        ("GET", "/api/orgs/galaxy/nodes/1/scratch-folder"),
        ("GET", "/api/orgs/galaxy/nodes/1/toolinput/1/x"),
        ("GET", "/api/orgs/galaxy/history"),
        ("GET", "/api/orgs/galaxy/events"),
        ("GET", "/api/orgs/galaxy/agents/x/files"),
        ("GET", "/api/orgs/galaxy/org_inbox"),
        ("GET", "/api/orgs/galaxy/transfers"),
        ("GET", "/api/orgs/galaxy/watchdogs"),
        ("GET", "/api/orgs/galaxy/audiences"),
        ("GET", "/api/orgs/galaxy/orgmd"),
        ("GET", "/api/orgs/galaxy/undo-history"),
        ("GET", "/api/orgs/galaxy/work-items/9/attachments/1"),
        ("GET", "/api/orgs/galaxy/work-items/9/artifacts/1"),
        ("POST", "/api/orgs/galaxy/work-items/9/reply"),
        ("GET", "/api/orgs/galaxy/apps"),
        ("POST", "/api/orgs/galaxy/apps"),
        ("GET", "/api/orgs/galaxy/apps/media"),
        ("POST", "/api/orgs/galaxy/ops"),
        ("POST", "/api/orgs/galaxy/inbox/read/"),
        ("GET", "/api/orgs/galaxy/records/"),
        ("GET", "/api/orgs/galaxy/records/extra"),
        ("PUT", "/api/orgs/galaxy/records"),
        ("GET", "/api/desktop/status"),
        ("POST", "/api/desktop/credential-bridge"),
        ("POST", "/api/agent-credential"),
        ("GET", "/ls/anything"),
        ("GET", "/"),
        ("GET", "/index.html"),
        ("GET", "/api/accounts"),
        ("GET", "/api/orgs//records"),
        ("GET", "api/orgs/galaxy/records"),
    ];
    for (method, path) in refused {
        assert!(!allows(method, path), "{method} {path} must be refused");
    }
}

/// The `.route("...")` literals of the router (production part of mod.rs).
fn route_literals() -> Vec<String> {
    let src = include_str!("mod.rs");
    let src = src.split("pub fn router(").nth(1).unwrap().split("\n/// The renderer bundle").next().unwrap();
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(at) = rest.find(".route(") {
        rest = &rest[at + ".route(".len()..];
        let trimmed = rest.trim_start();
        if let Some(body) = trimmed.strip_prefix('"') {
            out.push(body[..body.find('"').unwrap()].to_string());
        }
    }
    out
}

#[test]
fn every_route_is_classified_for_viewers() {
    let routes = route_literals();
    assert!(routes.len() > 200, "the route table parse found only {} routes", routes.len());
    let unclassified: Vec<_> = routes.iter()
        .filter(|route| !is_allowed_route(route) && !DENIED_FOR_VIEWER.contains(&route.as_str())).collect();
    assert!(unclassified.is_empty(),
        "routes not classified in http/viewer.rs (add each to ALLOWED or DENIED_FOR_VIEWER): {unclassified:#?}");
}

#[test]
fn classification_has_no_overlap_and_no_stale_entries() {
    let routes = route_literals();
    for route in DENIED_FOR_VIEWER {
        assert!(routes.iter().any(|r| r == route), "DENIED_FOR_VIEWER lists {route}, which is not a route");
        assert!(!is_allowed_route(route), "{route} is both allowed and denied");
    }
    for (_, route) in ALLOWED {
        assert!(routes.iter().any(|r| r == route), "ALLOWED lists {route}, which is not a route");
        assert!(!DENIED_FOR_VIEWER.contains(route), "{route} is both allowed and denied");
    }
    assert!(!ALLOWED.is_empty());
}

#[test]
fn log_lines_carry_client_id_method_and_a_trimmed_route() {
    let get = Method::GET;
    let line = log_line("cid-1", &get, "/api/orgs/galaxy/documents/42/download", true);
    assert_eq!(line, "viewer client token cid-1 GET /api/orgs/galaxy/documents allowed");
    let line = log_line("cid-1", &Method::DELETE, "/api/standalone/clients/some-secret-id", false);
    assert_eq!(line, "viewer client token cid-1 DELETE /api/standalone/clients refused");
    let line = log_line("cid-2", &Method::POST, "/api/mcp", false);
    assert_eq!(line, "viewer client token cid-2 POST /api/mcp refused");
    let line = log_line("cid-2", &get, "/api/orgs/galaxy", true);
    assert_eq!(line, "viewer client token cid-2 GET /api/orgs/galaxy allowed");
    let line = log_line("cid-2", &get, "/api/accounts/x/usage/y", false);
    assert!(!line.contains("usage") && !line.contains("/y"), "{line}");
}
