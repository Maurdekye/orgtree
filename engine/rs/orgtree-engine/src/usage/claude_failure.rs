//! What a failed Claude usage probe says about itself in the diagnostics log
//! (docket `claude-usage-readings-back-off-too-long-30-min-i`, @coordinator-opus
//! m583b89007ec0): closed values only, never a body, header, token or email.
//! STUB: the red tests pin the behaviour.
use serde_json::Value;

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

/// The fields a non-OK answer adds to the probe's result (taken out again by `take`).
pub(super) fn status_failure(_status: u16, _body: &str) -> Value { Value::Null }

/// The closed kind of a transport error.
pub(super) fn error_failure(_e: &reqwest::Error) -> &'static str { "other" }

/// Remove the failure fields from a probe result and return them.
pub(super) fn take(_raw: &mut Value) -> ProbeFailure { ProbeFailure::default() }
