//! What a failed Claude usage probe says about itself in the diagnostics log
//! (docket `claude-usage-readings-back-off-too-long-30-min-i`, @coordinator-opus
//! m583b89007ec0): closed values only, never a body, header, token or email.
//! The fields ride the probe's result from `fetch_claude` to
//! `finish_claude_probe`, which takes them out before the result is cached or shown.
use serde_json::{json, Value};

/// The closed facts the log line carries about a failed probe.
#[derive(Debug, PartialEq, Default)]
pub(super) struct ProbeFailure {
    /// "none" | "http" | "timeout" | "connect" | "tls" | "decode" | "other"
    pub(super) kind: &'static str,
    /// the HTTP status when the failure was an answer, else 0
    pub(super) http: u16,
    /// the answer was Cloudflare's "error code: 1010"
    pub(super) cloudflare_1010: bool,
}

const KIND: &str = "failure_kind";
const HTTP: &str = "failure_http";
const C1010: &str = "failure_1010";

/// The fields a non-OK answer adds to the probe's result (taken out again by `take`).
/// The body is only searched, never kept.
pub(super) fn status_failure(status: u16, body: &str) -> Value {
    json!({ KIND: "http", HTTP: status, C1010: body.contains("error code: 1010") })
}

/// The closed kind of a transport error.
pub(super) fn error_failure(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        return "timeout";
    }
    let mut source: Option<&dyn std::error::Error> = Some(e);
    while let Some(s) = source {
        let text = s.to_string().to_lowercase();
        if text.contains("certificate") || text.contains("handshake") || text.contains("rustls") || text.contains("tls") {
            return "tls";
        }
        source = s.source();
    }
    if e.is_connect() {
        "connect"
    } else if e.is_decode() || e.is_body() {
        "decode"
    } else {
        "other"
    }
}

/// A failure that came from this side (an expired stored sign-in, a client
/// that would not build): no kind of the closed transport list fits.
pub(super) fn local_failure() -> Value {
    json!({ KIND: "other", HTTP: 0, C1010: false })
}

/// The same for a transport error.
pub(super) fn transport_failure(e: &reqwest::Error) -> Value {
    json!({ KIND: error_failure(e), HTTP: 0, C1010: false })
}

/// Remove the failure fields from a probe result and return them.
pub(super) fn take(raw: &mut Value) -> ProbeFailure {
    let Some(o) = raw.as_object_mut() else { return ProbeFailure { kind: "none", ..Default::default() } };
    let kind = match o.remove(KIND).as_ref().and_then(Value::as_str) {
        Some("http") => "http",
        Some("timeout") => "timeout",
        Some("connect") => "connect",
        Some("tls") => "tls",
        Some("decode") => "decode",
        Some(_) => "other",
        None => "none",
    };
    let http = o.remove(HTTP).and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()).unwrap_or(0);
    let cloudflare_1010 = o.remove(C1010).and_then(|v| v.as_bool()).unwrap_or(false);
    ProbeFailure { kind, http, cloudflare_1010 }
}
