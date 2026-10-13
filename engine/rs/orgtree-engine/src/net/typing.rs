//! Typing in Hubchat (hub feature `typing`; user 2026-10-12/13, coordinator
//! 2026-10-13, docket show-agent-typing-in-hubchat-using-ordered-messa).
//!
//! The message tools take `metadata` first, then `body` (`tools::defs`). The
//! Claude API sends each top-level argument whole once it is complete, so
//! the actor's stream (`runtime::actor` `on_stream_event`) holds a call's
//! `metadata` while the model still writes the body. When it passes the
//! send's own checks (`tools::typing_peers`, `orginbox::may_send_extern`, a
//! peer a cached roster lists, the hub the send would use), the org tells
//! that hub it is writing to those peers: keyed by the call's tool-use id,
//! refreshed every `REFRESH` while the call lives (`CAP` at most), and
//! stopped when the call returns (`tools::call`), `ORPHAN` after a block that
//! never became a call, or when the agent's turn or process ends. The hub
//! ends a signal nobody refreshes (its TTL).
//!
//! Only addresses and the call id leave the engine, never content; no push
//! and no notification. Nothing here changes the org. A hub without the
//! feature answers 404 and is not asked again for `NO_FEATURE_RETRY`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{offline, pick_hub, request, HTTP};
use crate::engine::Engine;

/// how long the hub keeps a signal nobody refreshes
const TTL_SECS: u64 = 20;
const REFRESH: Duration = Duration::from_secs(8);
const CAP: Duration = Duration::from_secs(120);
const ORPHAN: Duration = Duration::from_secs(30);
const NO_FEATURE_RETRY: Duration = Duration::from_secs(600);
/// how long a stopped call is remembered, so a start that loses the race
/// against its own call's end never begins
const STOPPED_KEPT: Duration = Duration::from_secs(600);
/// the most a probe reads of a call's arguments
pub(crate) const PROBE_MAX: usize = 64 * 1024;

enum Entry {
    Live { agent_id: i64, stop: CancellationToken },
    Stopped(Instant),
}

/// The engine's typing signals, by tool-use id.
#[derive(Default)]
pub(crate) struct State {
    calls: Mutex<HashMap<String, Entry>>,
    /// hub address → not before: it answered 404 (no `typing`)
    no_feature: papaya::HashMap<String, Instant>,
}

/// What a probe made of a call's arguments so far.
#[derive(Debug, PartialEq)]
pub(crate) enum Scan {
    /// not enough written yet
    Pending,
    /// they start with something else: no indicator for this call (the
    /// send is unaffected)
    Abandon,
    /// `metadata`, whole, as the first argument
    Ready(Value),
}

/// The call's `metadata` once the arguments written so far hold it whole as
/// their first key.
#[nolog]
pub(crate) fn leading_metadata(buf: &str) -> Scan {
    let b = buf.as_bytes();
    let ws = |i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\r' | b'\n') {
            *i += 1;
        }
    };
    let mut i = 0;
    ws(&mut i);
    if i == b.len() {
        return Scan::Pending;
    }
    if b[i] != b'{' {
        return Scan::Abandon;
    }
    i += 1;
    ws(&mut i);
    if i == b.len() {
        return Scan::Pending;
    }
    if b[i] != b'"' {
        return Scan::Abandon;
    }
    let Some(key_end) = string_end(b, i) else { return Scan::Pending };
    match serde_json::from_str::<String>(&buf[i..key_end]) {
        Ok(k) if k == "metadata" => {}
        _ => return Scan::Abandon,
    }
    i = key_end;
    ws(&mut i);
    if i == b.len() {
        return Scan::Pending;
    }
    if b[i] != b':' {
        return Scan::Abandon;
    }
    i += 1;
    ws(&mut i);
    if i == b.len() {
        return Scan::Pending;
    }
    if b[i] != b'{' {
        return Scan::Abandon;
    }
    let Some(end) = value_end(b, i) else { return Scan::Pending };
    match serde_json::from_str::<Value>(&buf[i..end]) {
        Ok(v) => Scan::Ready(v),
        Err(_) => Scan::Abandon,
    }
}

/// Just past the JSON string that starts (with its quote) at `start`, once
/// it is complete.
#[nolog]
fn string_end(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Just past the object or array that starts at `start`, once it is complete.
#[nolog]
fn value_end(b: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = start;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i = string_end(b, i)?;
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// A message tool call's `metadata` is whole: show the org as typing to its
/// `@net:` peers, once the send's own checks pass. Runs off the stream.
#[logged]
pub(crate) fn begin(engine: &Arc<Engine>, org_id: i64, agent_id: i64, agent: &str, call: &str, metadata: &Value) {
    let Some(peers) = crate::tools::typing_peers(metadata) else { return };
    if offline() {
        return;
    }
    let (engine, agent, call) = (engine.clone(), agent.to_string(), call.to_string());
    tokio::spawn(async move {
        if let Err(e) = run(&engine, org_id, agent_id, &agent, &call, peers).await {
            tracing::debug!(agent = %agent, error = %format!("{e:#}"), "typing not shown");
        }
    });
}

/// One call's signal: checked, told to each hub, refreshed, stopped.
#[logged]
async fn run(engine: &Arc<Engine>, org_id: i64, agent_id: i64, agent: &str, call: &str, peers: Vec<String>) -> anyhow::Result<()> {
    if !crate::domain::orginbox::may_send_extern(engine, org_id, agent_id, agent).await? {
        return Ok(());
    }
    let by_hub = hubs_for(engine, org_id, &peers);
    if by_hub.is_empty() {
        return Ok(());
    }
    let stop = CancellationToken::new();
    if !engine.net.typing.register(call, agent_id, &stop) {
        return Ok(()); // the call already ended
    }
    let until = Instant::now() + CAP;
    loop {
        for (addr, peers) in &by_hub {
            send(engine, org_id, addr, Some(peers), call).await;
        }
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = engine.shutdown.cancelled() => break,
            _ = tokio::time::sleep(REFRESH) => {}
        }
        if Instant::now() >= until {
            break;
        }
    }
    engine.net.typing.stop_call(call);
    for addr in by_hub.keys() {
        send(engine, org_id, addr, None, call).await;
    }
    Ok(())
}

/// The hubs this org's send to each peer would use (`pick_hub`), with their
/// peers: registered hubs only, peers a cached roster lists (never a fetch
/// here), hubs not known to lack the feature.
#[logged]
fn hubs_for(engine: &Engine, org_id: i64, peers: &[String]) -> BTreeMap<String, Vec<String>> {
    let parts = engine.net.parts.load_full();
    let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { return BTreeMap::new() };
    let rosters = engine.net.rosters.pin();
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for peer in peers {
        if !rosters.iter().any(|(_, r)| r.iter().any(|x| x["slug"].as_str() == Some(peer.as_str()))) {
            continue;
        }
        let Some((hid, addr)) = pick_hub(engine, p, peer) else { continue };
        if !p.registered.contains(&hid) || engine.net.typing.lacks_feature(&addr) {
            continue;
        }
        let v = out.entry(addr).or_default();
        if !v.contains(peer) {
            v.push(peer.clone());
        }
    }
    out
}

/// One typing call to one hub: `peers` written to (Some), or the call
/// stopped (None). Best effort: a failure leaves it to the hub's TTL.
#[logged]
async fn send(engine: &Arc<Engine>, org_id: i64, addr: &str, peers: Option<&Vec<String>>, call: &str) {
    let parts = engine.net.parts.load_full();
    let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { return };
    let body = match peers {
        Some(peers) => json!({ "to": peers, "id": call, "state": "typing", "ttl": TTL_SECS }),
        None => json!({ "id": call, "state": "stop" }),
    };
    let req = HTTP
        .post(format!("{addr}/api/typing"))
        .timeout(Duration::from_secs(5))
        .header("X-Org-Auth", p.auth())
        .json(&body);
    if let Ok(r) = request(engine, &[org_id], req).await {
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            engine.net.typing.no_feature.pin().insert(addr.to_string(), Instant::now() + NO_FEATURE_RETRY);
        }
    }
}

/// The call `call` ended (its tool returned, sent or refused): stop its
/// signal, or keep it from starting.
#[logged]
pub(crate) fn stop(engine: &Engine, call: &str) {
    engine.net.typing.stop_call(call);
}

/// A probed call's block ended: unless a tool call ends it first, stop its
/// signal after `ORPHAN` (a refused permission, a cancelled turn).
#[logged]
pub(crate) fn orphan(engine: &Arc<Engine>, call: &str) {
    let (engine, call) = (engine.clone(), call.to_string());
    tokio::spawn(async move {
        tokio::time::sleep(ORPHAN).await;
        engine.net.typing.stop_call(&call);
    });
}

/// An agent's turn or process ended: stop the signals of all its calls.
#[logged]
pub(crate) fn stop_agent(engine: &Engine, agent_id: i64) {
    engine.net.typing.stop_agent(agent_id);
}

#[logged]
impl State {
    /// Start tracking `call`; false when it already ended (or is tracked).
    #[nolog]
    fn register(&self, call: &str, agent_id: i64, stop: &CancellationToken) -> bool {
        let mut calls = self.calls.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        calls.retain(|_, e| !matches!(e, Entry::Stopped(at) if now.duration_since(*at) > STOPPED_KEPT));
        if calls.contains_key(call) {
            return false;
        }
        calls.insert(call.to_string(), Entry::Live { agent_id, stop: stop.clone() });
        true
    }

    #[nolog]
    fn stop_call(&self, call: &str) {
        let mut calls = self.calls.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Entry::Live { stop, .. }) = calls.get(call) {
            stop.cancel();
        }
        calls.insert(call.to_string(), Entry::Stopped(Instant::now()));
    }

    #[nolog]
    fn stop_agent(&self, agent_id: i64) {
        let mut calls = self.calls.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        for e in calls.values_mut() {
            if matches!(e, Entry::Live { agent_id: a, .. } if *a == agent_id) {
                if let Entry::Live { stop, .. } = e {
                    stop.cancel();
                }
                *e = Entry::Stopped(now);
            }
        }
    }

    #[nolog]
    fn lacks_feature(&self, addr: &str) -> bool {
        self.no_feature.pin().get(addr).is_some_and(|u| Instant::now() < *u)
    }

    /// Whether `call` is being shown now (tests).
    #[nolog]
    #[cfg(test)]
    fn live(&self, call: &str) -> bool {
        matches!(self.calls.lock().unwrap().get(call), Some(Entry::Live { .. }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_ready_once_whole_as_the_first_argument() {
        let full = r#"{"metadata": {"to": ["@net:alice.k3x9"], "kind": "message"}, "body": "Hello"}"#;
        let meta_end = full.find(", \"body\"").unwrap();
        // every prefix before the metadata closes is pending, never ready early
        for n in 0..meta_end {
            assert_eq!(leading_metadata(&full[..n]), Scan::Pending, "prefix {n}: {:?}", &full[..n]);
        }
        let want = Scan::Ready(json!({"to": ["@net:alice.k3x9"], "kind": "message"}));
        assert_eq!(leading_metadata(&full[..meta_end]), want);
        assert_eq!(leading_metadata(full), want);
    }

    #[test]
    fn other_shapes_are_abandoned() {
        // the body first (an inversion), the flat legacy shape, junk
        assert_eq!(leading_metadata(r#"{"body": "x", "metadata": {"to": "@net:a"}}"#), Scan::Abandon);
        assert_eq!(leading_metadata(r#"{"to": "@net:a", "body": "x"}"#), Scan::Abandon);
        assert_eq!(leading_metadata(r#"{"metadata": "@net:a"}"#), Scan::Abandon);
        assert_eq!(leading_metadata(r#"["metadata"]"#), Scan::Abandon);
        assert_eq!(leading_metadata("{}"), Scan::Abandon);
        // a key that merely starts like it is a different key
        assert_eq!(leading_metadata(r#"{"metadatax": {}"#), Scan::Abandon);
    }

    #[test]
    fn strings_inside_metadata_cannot_close_it_early() {
        let s = r#"{"metadata": {"to": "@net:a", "options": ["a } b", "c \" { d"], "kind": "question"}, "body": "q"}"#;
        assert_eq!(
            leading_metadata(s),
            Scan::Ready(json!({"to": "@net:a", "options": ["a } b", "c \" { d"], "kind": "question"}))
        );
        let open = r#"{"metadata": {"to": "@net:a", "options": ["a } b"#;
        assert_eq!(leading_metadata(open), Scan::Pending);
        // whitespace anywhere the JSON allows it
        assert_eq!(leading_metadata(" {\n  \"metadata\" :\n {\"to\":\"@net:a\"} "), Scan::Ready(json!({"to": "@net:a"})));
    }

    #[test]
    fn a_stop_before_the_start_keeps_it_from_starting() {
        let s = State::default();
        let t = CancellationToken::new();
        s.stop_call("toolu_1");
        assert!(!s.register("toolu_1", 7, &t), "a call that already ended never starts");
        assert!(s.register("toolu_2", 7, &t));
        assert!(s.live("toolu_2"));
        assert!(!s.register("toolu_2", 7, &t), "and none starts twice");
        s.stop_call("toolu_2");
        assert!(t.is_cancelled());
        assert!(!s.live("toolu_2"));
    }

    #[test]
    fn an_agents_end_stops_only_its_calls() {
        let s = State::default();
        let (a, b) = (CancellationToken::new(), CancellationToken::new());
        assert!(s.register("x", 1, &a));
        assert!(s.register("y", 2, &b));
        s.stop_agent(1);
        assert!(a.is_cancelled() && !b.is_cancelled());
        assert!(!s.live("x") && s.live("y"));
    }
}
