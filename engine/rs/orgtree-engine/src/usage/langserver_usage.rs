//! Usage windows of a language-model server connection (docket
//! `opencode-go-show-usage-limits-5h-weekly-monthly-i`; USER 2026-11-09
//! m6b2875a1cd9a and m479c1c4f5fcc).
//!
//! OpenCode Go keeps an undocumented route that reports a 5-hour, a weekly and
//! a monthly window: `GET <route>` with the key as a Bearer header answers
//! `{"usage":{"rolling"|"weekly"|"monthly":{"status":"ok"|"rate-limited",
//! "percent":0-100 USED,"resetsAt":ISO-8601 | epoch s | epoch ms}}}`. That shape
//! comes from a GitHub issue comment (outside input): it is used only as a
//! format hint, so everything here is defensive. EVERY connection is asked at
//! `<its base URL>/usage` (ruling: the same protocol is probed everywhere); the
//! OpenCode Go preset alone has a second route of its own (`Preset::usage_url`,
//! because its models and its usage sit under different prefixes).
//!
//! What a connection can say, and what shows:
//!  * a recognised response: its windows;
//!  * 404/405/501, a redirect, or a 200 that is not a usage response: the
//!    connection has no usage feature. Nothing shows, and it is not asked again
//!    until the engine restarts or its address or key changes;
//!  * anything else (no answer, 401/403/429/5xx): a failure. If the connection
//!    has answered properly before it reads UNKNOWN (never 0%); if it never
//!    has, nothing shows and it is asked again at the next cadence.
//! The key is only ever the Bearer header: it is never logged, returned or kept
//! (the change check holds a hash of it).
use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BODY: usize = 1 << 20;

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
    /// hash of the routes and the key this was learned for
    pub(super) fingerprint: String,
    pub(super) no_feature: bool,
    /// the route that last answered properly
    pub(super) worked: Option<String>,
}

fn epoch_iso(v: &Value) -> Option<String> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    // seconds until the year 5138; beyond that the number is milliseconds
    let secs = if n >= 1e11 { n / 1000.0 } else { n } as i64;
    chrono::DateTime::from_timestamp(secs, 0).map(crate::util::iso)
}

fn reset_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => crate::util::parse_ts(s.trim()).map(crate::util::iso),
        Value::Number(_) => epoch_iso(v),
        _ => None,
    }
}

/// The windows of a usage response, or None when it is not one.
pub(super) fn parse_windows(raw: &Value) -> Option<Vec<Value>> {
    let usage = raw.get("usage")?.as_object()?;
    let mut out = Vec::new();
    let mut recognised = false;
    for (field, label, kind) in [("rolling", "5 h", "session"), ("weekly", "weekly", "weekly_all"), ("monthly", "monthly", "monthly")] {
        let Some(w) = usage.get(field).and_then(Value::as_object) else { continue };
        recognised = true;
        // a percent outside 0-100 or not a number is unknown, never 0
        let percent = w.get("percent").and_then(Value::as_f64).filter(|p| p.is_finite() && (0.0..=100.0).contains(p));
        let active = w.get("status").and_then(Value::as_str) == Some("rate-limited");
        let sev = match percent { Some(p) if active || p >= 100.0 => "critical", Some(p) => super::severity(p), None => "normal" };
        out.push(json!({ "kind": kind, "group": kind, "percent": percent, "severity": sev,
                         "resets_at": w.get("resetsAt").and_then(reset_of), "is_active": active, "model": null, "label": label }));
    }
    recognised.then_some(out)
}

/// The routes to ask, in order: `<base URL>/usage` of the connection's own
/// harness, then the preset's own route if (and only if) its preset has one.
pub(super) fn candidate_urls(server: &Value) -> Vec<String> {
    let mut urls = vec![format!("{}/usage", crate::langserver::base_url(server).trim_end_matches('/'))];
    if let Some(extra) = server["preset"].as_str().and_then(crate::langserver::preset).map(|p| p.usage_url).filter(|u| !u.is_empty()) {
        urls.push(extra.to_string());
    }
    urls
}

#[nolog]
async fn ask(client: &reqwest::Client, url: &str, key: Option<&str>) -> Answer {
    let mut req = client.get(url).header("accept", "application/json");
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return Answer::Failed("no answer in time".into()),
        Err(_) => return Answer::Failed("could not connect".into()),
    };
    let status = res.status();
    if matches!(status.as_u16(), 404 | 405 | 501) || status.is_redirection() {
        return Answer::NoFeature;
    }
    if !status.is_success() {
        return Answer::Failed(format!("HTTP {}", status.as_u16()));
    }
    let body = match res.bytes().await {
        Ok(b) if b.len() <= MAX_BODY => b,
        Ok(_) => return Answer::NoFeature,
        Err(_) => return Answer::Failed("the answer was cut off".into()),
    };
    match serde_json::from_slice::<Value>(&body).ok().as_ref().and_then(parse_windows) {
        Some(rows) => Answer::Windows(url.to_string(), rows),
        None => Answer::NoFeature,
    }
}

/// Ask the routes in order: the first recognised answer wins. No feature only
/// if EVERY route said so; otherwise the first failure.
#[nolog]
pub(super) async fn probe(urls: &[String], key: Option<&str>) -> Answer {
    let client = match reqwest::Client::builder().timeout(TIMEOUT).redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("orgtree-engine/", env!("CARGO_PKG_VERSION"))).build() {
        Ok(c) => c,
        Err(_) => return Answer::Failed("could not start a request".into()),
    };
    let mut failed: Option<String> = None;
    for url in urls {
        match ask(&client, url, key).await {
            w @ Answer::Windows(..) => return w,
            Answer::NoFeature => {}
            Answer::Failed(why) => { failed.get_or_insert(why); }
        }
    }
    match failed { Some(why) => Answer::Failed(why), None => Answer::NoFeature }
}

fn fingerprint(urls: &[String], key: Option<&str>) -> String {
    let mut h = Sha256::new();
    for u in urls { h.update(u.as_bytes()); h.update([0]); }
    h.update(key.unwrap_or("").as_bytes());
    hex::encode(h.finalize())
}

/// One connection's reading, or None when there is nothing to show (no usage
/// feature, or a failure before any success). Updates what the probe knows.
#[nolog]
pub(super) async fn read_server(usage: &super::Usage, server: &Value, key: Option<&str>) -> Option<Value> {
    let id = server["id"].as_str().unwrap_or("");
    let mut urls = candidate_urls(server);
    let fp = fingerprint(&urls, key);
    let mut state = usage.langserver.pin().get(id).cloned().filter(|s| s.fingerprint == fp)
        .unwrap_or_else(|| State { fingerprint: fp, ..State::default() });
    if state.no_feature {
        return None;
    }
    // the route that answered last time first
    if let Some(i) = state.worked.as_ref().and_then(|w| urls.iter().position(|u| u == w)) {
        let w = urls.remove(i);
        urls.insert(0, w);
    }
    let label = server["label"].as_str().unwrap_or("");
    let out = match probe(&urls, key).await {
        Answer::Windows(url, limits) => {
            state.worked = Some(url);
            Some(json!({ "available": true, "provider": "LM server", "label": label, "limits": limits,
                         "observed_at": crate::util::iso(Utc::now()) }))
        }
        Answer::NoFeature if state.worked.is_none() => {
            state.no_feature = true;
            None
        }
        // it answered properly before: a route that has gone, or answers something
        // else, is a failure now, and reads unknown
        Answer::NoFeature => Some(unknown(label, "the usage route no longer answers as a usage route")),
        Answer::Failed(why) => state.worked.is_some().then(|| unknown(label, &format!("usage check failed ({why})"))),
    };
    tracing::info!(server = id, shown = out.is_some(), available = out.as_ref().is_some_and(|o| o["available"] == json!(true)),
                   no_feature = state.no_feature, "LM server usage read");
    usage.langserver.pin().insert(id.to_string(), state);
    out
}

fn unknown(label: &str, error: &str) -> Value {
    json!({ "available": false, "provider": "LM server", "label": label, "error": error })
}
