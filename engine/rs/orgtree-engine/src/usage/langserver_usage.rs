//! Usage windows of a language-model server connection (docket
//! `opencode-go-show-usage-limits-5h-weekly-monthly-i`; USER 2026-11-09
//! m6b2875a1cd9a and m479c1c4f5fcc). STUB: the red tests pin the behaviour.
use serde_json::Value;

/// What one request to a usage route came to.
#[derive(Debug, PartialEq)]
pub(super) enum Answer {
    /// a recognised usage response: the url that gave it and its rows
    Windows(String, Vec<Value>),
    /// the route does not exist or is not a usage route
    NoFeature,
    /// it may exist but did not answer now (a short reason, never a secret)
    Failed(String),
}

/// What the probe has learned about one connection.
#[derive(Clone, Default)]
pub(super) struct State {
    pub(super) fingerprint: String,
    pub(super) no_feature: bool,
    pub(super) worked: Option<String>,
}

pub(super) fn parse_windows(_raw: &Value) -> Option<Vec<Value>> { None }

pub(super) fn candidate_urls(_server: &Value) -> Vec<String> { Vec::new() }

pub(super) async fn probe(_urls: &[String], _key: Option<&str>) -> Answer { Answer::Failed("stub".into()) }

pub(super) async fn read_server(_usage: &super::Usage, _server: &Value, _key: Option<&str>) -> Option<Value> { None }
