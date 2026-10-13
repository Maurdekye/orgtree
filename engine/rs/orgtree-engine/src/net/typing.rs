//! Typing in Hubchat (hub feature `typing`; user 2026-10-12/13, coordinator
//! 2026-10-13, docket show-agent-typing-in-hubchat-using-ordered-messa).
//!
//! The message tools take `metadata` first, then `body` (`tools::defs`). The
//! Claude API sends each top-level argument whole once it is complete, so
//! the actor's stream (`runtime::actor` `on_stream_event`) holds a call's
//! `metadata` while the model still writes the body. When it passes the
//! send's own checks (`tools::typing_peers`, `orginbox::may_send_extern`, a
//! peer a cached roster lists, the hub the send would use), the org sends
//! that hub a heartbeat for those peers every `BEAT` while the model writes
//! the call (user 2026-10-13 22:34Z): until the call's block ends, its tool
//! call returns, the agent's turn or process ends, or `CAP`. There is no
//! start and no stop on the wire: the heartbeats simply stop, and the
//! recipient's Hubchat drops the indicator a second after the last one, so
//! nothing here can leave it standing. Stopping when the block ends also
//! means no heartbeat follows the message itself.
//!
//! Only addresses leave the engine, never content; no push and no
//! notification. Nothing here changes the org. A hub without the feature
//! answers 404 and is not asked again for `NO_FEATURE_RETRY`. Hubchat users'
//! own heartbeats reach the org's address too; the engine's polls never ask
//! for them, so it ignores them (user 2026-10-13 22:33Z).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{offline, pick_hub, request, HTTP};
use crate::engine::Engine;

/// how often a heartbeat goes while an agent writes a message call
const BEAT: Duration = Duration::from_millis(500);
/// the longest one call heartbeats, whatever happens (a safety)
const CAP: Duration = Duration::from_secs(120);
/// recipients per heartbeat (the hub's limit)
const MAX_RECIPIENTS: usize = 10;
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

/// The engine's typing heartbeats, by tool-use id.
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

/// A message tool call's `metadata` is whole: the org heartbeats to its
/// `@net:` peers while the call is written, once the send's own checks
/// pass. Runs off the stream.
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

/// One call's heartbeats: checked, then one to each hub every `BEAT` until
/// the call stops or `CAP`.
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
    let mut tick = tokio::time::interval(BEAT);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut beats = 0u32;
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = engine.shutdown.cancelled() => break,
            _ = tick.tick() => {}
        }
        if Instant::now() >= until {
            break;
        }
        for (addr, peers) in &by_hub {
            beat(engine, org_id, addr, peers).await;
        }
        beats += 1;
    }
    engine.net.typing.stop_call(call);
    tracing::debug!(agent = %agent, beats, "typing heartbeats ended");
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

/// One heartbeat to one hub: `{"to": peers}` and nothing else. Best effort:
/// one that fails is simply missing. Hot (every `BEAT`), so not logged.
#[nolog]
async fn beat(engine: &Arc<Engine>, org_id: i64, addr: &str, peers: &[String]) {
    let parts = engine.net.parts.load_full();
    let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { return };
    for to in peers.chunks(MAX_RECIPIENTS) {
        let req = HTTP.post(format!("{addr}/api/typing")).timeout(Duration::from_secs(2)).header("X-Org-Auth", p.auth()).json(&body(to));
        if let Ok(r) = request(engine, &[org_id], req).await {
            if r.status() == reqwest::StatusCode::NOT_FOUND {
                engine.net.typing.no_feature.pin().insert(addr.to_string(), Instant::now() + NO_FEATURE_RETRY);
                return;
            }
        }
    }
}

/// A heartbeat's body: the addresses, never a word of the message.
#[nolog]
fn body(to: &[String]) -> Value {
    json!({ "to": to })
}

/// The call `call` is no longer being written: its block ended, or its tool
/// returned (sent or refused). Its heartbeats stop, or never start.
#[logged]
pub(crate) fn stop(engine: &Engine, call: &str) {
    engine.net.typing.stop_call(call);
}

/// An agent's turn or process ended: stop the heartbeats of all its calls.
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

    /// Whether `call` is heartbeating now (tests).
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

    #[test]
    fn a_heartbeat_carries_the_addresses_and_nothing_else() {
        let to = ["alice.k3x9".to_string(), "bob.p2q7".to_string()];
        assert_eq!(body(&to), json!({ "to": ["alice.k3x9", "bob.p2q7"] }));
    }
}
