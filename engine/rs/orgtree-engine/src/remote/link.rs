//! One remote engine's link (docs/rust-engine/remote-org.md, "The link"): a
//! task that connects (the handshake's checks, then the remote's app socket),
//! mirrors the remote's organizations into this engine's list while it is
//! connected, and says where the connection stands. It alone changes the
//! connection's state. It never holds anything up: a remote that does not
//! answer costs this engine one sleeping task.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message as Frame;

use super::address::Address;
use super::wsdial::{self, DialError, Upstream};
use super::{handshake, text, Conn, Kind, LinkState, Me, OrgSeen, Phase, Refusal, Remote, Row, Timing};
use crate::engine::Engine;
use crate::mqtt::backoff::{Backoff, Waits};

/// The largest app-feed frame the link reads (a snapshot of every org's
/// summary and notices).
const APP_FRAME_MAX: usize = 64 << 20;

/// The remote's app feed as it stands: its registry, each organization's
/// summary and working count, and its engine-wide values.
#[derive(Default)]
pub struct Mirror {
    /// remote org id -> its registry record
    registry: Vec<Value>,
    /// remote org id -> (org uuid, summary body)
    summaries: HashMap<i64, (String, Value)>,
    working: HashMap<i64, i64>,
    /// remote org id -> (org uuid, its notices)
    notices: HashMap<i64, (String, Vec<Value>)>,
    pub values: HashMap<String, Value>,
}

/// The longest notice title the desktop accepts (apps/desktop/main/notifications.ts).
const NOTICE_TITLE_MAX: usize = 200;

/// What a frame changed.
#[derive(Default, Debug, PartialEq)]
pub struct Changed {
    /// The set of organizations, or one's identity.
    pub registry: bool,
    /// A summary or a working count.
    pub rows: bool,
    /// One of the remote's engine-wide values.
    pub values: bool,
}

#[logged]
impl Mirror {
    /// Apply one frame of the remote's app feed (`packages/contracts/app-feed.ts`).
    /// Not logged: a frame carries the remote's pushed values and notices.
    #[nolog]
    pub fn apply(&mut self, frame: &Value) -> Changed {
        let mut changed = Changed::default();
        match frame["type"].as_str().unwrap_or_default() {
            "app_snapshot" => {
                changed.registry |= self.registry_frame(&frame["registry"]);
                self.summaries.clear();
                if let Some(summaries) = frame["summaries"].as_object() {
                    for summary in summaries.values() {
                        self.summary(summary);
                    }
                }
                self.notices.clear();
                if let Some(notices) = frame["notices"].as_object() {
                    for notices in notices.values() {
                        self.notice(notices);
                    }
                }
                self.working.clear();
                self.values.clear();
                self.runtime(&frame["runtime"]);
                changed.rows = true;
                changed.values = true;
            }
            "registry_snapshot" => changed.registry |= self.registry_frame(frame),
            "org_summary" => changed.rows |= self.summary(frame),
            "org_notices" => changed.rows |= self.notice(frame),
            "app_runtime" => {
                let (rows, values) = self.runtime(frame);
                changed.rows |= rows;
                changed.values |= values;
            }
            _ => {}
        }
        changed
    }

    #[nolog]
    fn registry_frame(&mut self, frame: &Value) -> bool {
        let next: Vec<Value> = frame["records"].as_array().map(|records| records.iter().map(|r| r["body"].clone()).collect()).unwrap_or_default();
        if next == self.registry {
            return false;
        }
        self.registry = next;
        true
    }

    #[nolog]
    fn summary(&mut self, frame: &Value) -> bool {
        let Some(id) = frame["org_id"].as_i64() else { return false };
        if frame["body"].is_null() {
            return self.summaries.remove(&id).is_some();
        }
        let next = (frame["org_uuid"].as_str().unwrap_or_default().to_string(), frame["body"].clone());
        if self.summaries.get(&id) == Some(&next) {
            return false;
        }
        self.summaries.insert(id, next);
        true
    }

    /// One organization's notices; `null` takes them back.
    #[nolog]
    fn notice(&mut self, frame: &Value) -> bool {
        let Some(id) = frame["org_id"].as_i64() else { return false };
        let Some(list) = frame["notices"].as_array() else { return self.notices.remove(&id).is_some() };
        let next = (frame["org_uuid"].as_str().unwrap_or_default().to_string(), list.clone());
        if self.notices.get(&id) == Some(&next) {
            return false;
        }
        self.notices.insert(id, next);
        true
    }

    /// What waits on the user in the organization the remote calls `slug`,
    /// as this computer's notices: under `alias`, each title saying where.
    /// `None` when the remote has not said.
    #[nolog]
    fn notices_for(&self, slug: &str, uuid: &str, alias: &str, place: &str) -> Option<Vec<Value>> {
        let id = self.registry.iter().find(|b| b["slug"].as_str() == Some(slug))?["org_id"].as_i64()?;
        let (_, list) = self.notices.get(&id).filter(|(u, _)| u == uuid)?;
        Some(
            list.iter()
                .filter(|notice| notice.is_object() && notice["id"].is_string())
                .map(|notice| {
                    let mut notice = notice.clone();
                    notice["org"] = json!(alias);
                    let title = format!("{place}: {}", notice["title"].as_str().unwrap_or_default());
                    notice["title"] = json!(title.chars().take(NOTICE_TITLE_MAX).collect::<String>());
                    notice
                })
                .collect(),
        )
    }

    #[nolog]
    fn runtime(&mut self, frame: &Value) -> (bool, bool) {
        let mut changed = false;
        let mut pushed = false;
        if let Some(values) = frame["values"].as_object() {
            for (key, entry) in values {
                let value = entry["value"].clone();
                if self.values.get(key) != Some(&value) {
                    self.values.insert(key.clone(), value);
                    pushed = true;
                }
            }
        }
        if let Some(orgs) = frame["orgs"].as_object() {
            for (id, entry) in orgs {
                let Ok(id) = id.parse::<i64>() else { continue };
                let n = entry["working"].as_i64().unwrap_or(0);
                if self.working.insert(id, n) != Some(n) {
                    changed = true;
                }
            }
        }
        (changed, pushed)
    }

    /// The organizations the remote lists, with what their summaries say.
    #[nolog]
    pub fn seen(&self) -> Vec<OrgSeen> {
        self.registry
            .iter()
            .filter_map(|body| {
                let slug = body["slug"].as_str()?;
                let uuid = body["org_uuid"].as_str().unwrap_or_default();
                let summary = body["org_id"].as_i64().and_then(|id| self.summaries.get(&id)).filter(|(u, _)| u == uuid).map(|(_, s)| s.clone());
                let name = summary.as_ref().and_then(|s| s["name"].as_str()).unwrap_or(slug).chars().take(200).collect();
                Some(OrgSeen { remote_slug: slug.to_string(), org_uuid: uuid.chars().take(64).collect(), name, summary })
            })
            .collect()
    }

    /// The remote's registry record and live numbers of the organization it calls `slug`.
    #[nolog]
    fn live(&self, slug: &str, uuid: &str) -> Option<(&Value, Option<&Value>, i64)> {
        let body = self.registry.iter().find(|b| b["slug"].as_str() == Some(slug))?;
        let id = body["org_id"].as_i64()?;
        let summary = self.summaries.get(&id).filter(|(u, _)| u == uuid).map(|(_, s)| s);
        Some((body, summary, self.working.get(&id).copied().unwrap_or(0)))
    }
}

/// The rows this engine's list shows for one remote engine: every
/// organization it still lists, under its alias and local id. While the link
/// is connected they carry the remote's live summary and working count;
/// otherwise the last summary it sent and no activity (a status this engine
/// cannot vouch for is not shown as current).
#[nolog]
pub fn rows(remote: &Remote, mirror: Option<&Mirror>) -> Vec<Row> {
    let saved = remote.saved();
    let phase = remote.phase();
    let mirror = mirror.filter(|_| phase == Phase::Connected);
    let mut out: Vec<Row> = saved
        .orgs
        .iter()
        .filter(|org| org.gone_at.is_none())
        .map(|org| {
            let live = mirror.and_then(|m| m.live(&org.remote_slug, &org.org_uuid));
            let mut summary = live.and_then(|(_, s, _)| s.cloned()).or_else(|| org.last_summary.clone()).unwrap_or_else(|| json!({}));
            if !summary.is_object() {
                summary = json!({});
            }
            // the list needs these members whatever the remote sent
            for (key, default) in [("name", json!(org.name)), ("created", Value::Null), ("net_slug", Value::Null), ("nodes", json!(0)),
                ("live", json!(0)), ("cost_usd_total", json!(0.0)), ("attention", json!(0))] {
                if summary.get(key).is_none() {
                    summary[key] = default;
                }
            }
            let theirs = live.map(|(body, _, _)| body);
            let registry = json!({
                "org_id": org.local_id, "slug": org.alias, "org_uuid": org.org_uuid,
                "state": theirs.and_then(|b| b["state"].as_str()).unwrap_or("active"),
                "unavailable_step": theirs.map(|b| b["unavailable_step"].clone()).unwrap_or(Value::Null),
                "state_reason": theirs.map(|b| b["state_reason"].clone()).unwrap_or(Value::Null),
                "attempts": 0, "report_path": null,
                "remote": { "id": saved.id, "name": saved.name, "tag": saved.tag, "slug": org.remote_slug, "state": phase.as_str() },
            });
            // "<organization> (middle dot) <remote engine>", so two organizations of one name are told apart
            let place = format!("{} \u{b7} {}", summary["name"].as_str().unwrap_or(&org.name), saved.name);
            let notices = mirror.and_then(|m| m.notices_for(&org.remote_slug, &org.org_uuid, &org.alias, &place));
            Row { local_id: org.local_id, org_uuid: org.org_uuid.clone(), registry, summary, working: live.map(|(_, _, n)| n).unwrap_or(0), notices }
        })
        .collect();
    out.sort_by(|a, b| a.registry["slug"].as_str().cmp(&b.registry["slug"].as_str()));
    out
}

/// Hand this remote's rows to the app feed (the org list, the tray).
#[nolog]
pub fn push_rows(engine: &Engine, remote: &Arc<Remote>, mirror: Option<&Mirror>) {
    // a removed connection's rows have left the list for good
    if remote.stop.is_cancelled() {
        return;
    }
    let rows = rows(remote, mirror);
    remote.rows.store(Arc::new(rows.clone()));
    engine.app.remote_rows(&remote.id, rows);
}

#[logged]
pub fn spawn(engine: Arc<Engine>, remote: Arc<Remote>) {
    let span = crate::trace::request(&format!("remote:{}", remote.tag()));
    tokio::spawn(tracing::Instrument::instrument(run(engine, remote), span));
}

/// How a connected session ended.
enum End {
    /// The connection was removed, or the engine is stopping.
    Stop,
    /// The saved connection changed (paused, another token or address).
    Changed,
    /// The remote went away.
    Lost(String),
}

#[nolog]
async fn run(engine: Arc<Engine>, remote: Arc<Remote>) {
    let mut backoff = Backoff::default();
    loop {
        if remote.stop.is_cancelled() || engine.shutdown.is_cancelled() {
            break;
        }
        if !remote.saved().enabled {
            show(&engine, &remote, state(Phase::Paused, None, None, &remote), None);
            tokio::select! {
                _ = remote.wake.notified() => continue,
                _ = remote.stop.cancelled() => break,
                _ = engine.shutdown.cancelled() => break,
            }
        }
        let timing = engine.remotes.timing();
        // an outage stays "offline" (or "sign-in needed") while it is retried;
        // only a first dial, or one after a pause or a fixed refusal, is "connecting"
        if matches!(remote.phase(), Phase::Paused | Phase::Refused) {
            remote.set_state(state(Phase::Connecting, None, None, &remote));
        }
        // the saved organizations are in the list from the first moment
        push_rows(&engine, &remote, None);
        engine.remotes.publish(&engine);
        let failure = match connect(&engine, &remote, &timing).await {
            Ok((mut socket, mut mirror)) => {
                backoff.connected();
                let end = session(&engine, &remote, &timing, &mut socket, &mut mirror).await;
                remote.conn.store(None);
                // what the remote last said is kept for the offline rows
                engine.remotes.seen_orgs(&engine, &remote, &mirror.seen(), true).await;
                match end {
                    End::Stop => break,
                    End::Changed => {
                        show(&engine, &remote, state(Phase::Connecting, None, None, &remote), None);
                        continue;
                    }
                    End::Lost(why) => {
                        tracing::info!(remote = %remote.tag(), why = %why, "remote engine link lost");
                        Refusal::new(Kind::Offline, "E9", text::e9(&remote.name()))
                    }
                }
            }
            Err(refusal) => refusal,
        };
        if remote.stop.is_cancelled() || engine.shutdown.is_cancelled() {
            break;
        }
        let waits = Waits { net_first: timing.net_first, net_max: timing.net_max, refused: &[timing.auth_retry], stable: timing.stable, jitter: timing.jitter };
        let (phase, wait) = match failure.kind {
            Kind::Auth => (Phase::AuthFailed, Some(backoff.failed(true, &waits))),
            Kind::Offline => (Phase::Offline, Some(backoff.failed(false, &waits))),
            // nothing changes by itself: the user fixes it and presses Retry
            _ => (Phase::Refused, None),
        };
        let next_attempt_at = wait.and_then(|w| chrono::Duration::from_std(w).ok()).map(|w| Utc::now() + w);
        tracing::info!(remote = %remote.tag(), phase = phase.as_str(), code = failure.code, retry_s = wait.map(|w| w.as_secs()), "remote engine not connected");
        let mut next = state(phase, Some(failure), next_attempt_at, &remote);
        next.version = remote.state().version;
        show(&engine, &remote, next, None);
        let sleep = async {
            match wait {
                Some(wait) => tokio::time::sleep(wait).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = sleep => {}
            _ = remote.wake.notified() => {}
            _ = remote.stop.cancelled() => break,
            _ = engine.shutdown.cancelled() => break,
        }
    }
    remote.conn.store(None);
}

#[nolog]
fn state(phase: Phase, failure: Option<Refusal>, next_attempt_at: Option<chrono::DateTime<Utc>>, remote: &Remote) -> LinkState {
    let before = remote.state();
    LinkState { phase, since: Utc::now(), next_attempt_at, code: failure.as_ref().map(|f| f.code).filter(|c| !c.is_empty()),
        error: failure.map(|f| f.text), version: before.version, transport: if phase == Phase::Connected { before.transport } else { None } }
}

/// Set the state and tell the windows: the connection list and this
/// remote's rows (their `remote.state` is part of the registry record).
#[nolog]
fn show(engine: &Engine, remote: &Arc<Remote>, next: LinkState, mirror: Option<&Mirror>) {
    remote.set_state(next);
    push_rows(engine, remote, mirror);
    engine.remotes.publish(engine);
}

/// The checks, then the remote's app socket and its first copy.
#[nolog]
async fn connect(engine: &Arc<Engine>, remote: &Arc<Remote>, timing: &Timing) -> Result<(Upstream, Mirror), Refusal> {
    let saved = remote.saved();
    let name = saved.name.clone();
    let offline = || Refusal::new(Kind::Offline, "E9", text::e9(&name));
    let address = Address::parse(&saved.url).map_err(|e| Refusal::new(Kind::Refused, "E1", e))?;
    let token = remote.token();
    if token.is_empty() {
        return Err(Refusal::new(Kind::Refused, "E10", text::e10(&name)));
    }
    let probe = handshake::probe(&address, &token, timing, &name, false).await.map_err(|refusal| match refusal.kind {
        // not reachable is this connection's offline, in its own words
        Kind::Offline => offline(),
        Kind::Auth => Refusal::new(Kind::Auth, "E10", text::e10(&name)),
        _ => refusal,
    })?;
    if probe.data_root_id != saved.data_root_id {
        return Err(Refusal::new(Kind::Refused, "E8", text::e8(&address.base())));
    }
    let (version, transport) = (probe.version.clone(), probe.transport);
    remote.note_boot(&probe.boot_id);
    let conn = Arc::new(Conn { address, addrs: probe.addrs, http: probe.http });
    let (mut socket, boot) = wsdial::dial(&conn, &token, "/api/app/ws", APP_FRAME_MAX, timing.connect).await.map_err(|e| match e {
        DialError::Status(403, _) => Refusal::new(Kind::Auth, "E10", text::e10(&name)),
        _ => offline(),
    })?;
    remote.note_boot(&boot);
    // the first frame is the whole copy
    let mut mirror = Mirror::default();
    let first = tokio::time::timeout(timing.request, async {
        loop {
            match socket.next().await {
                Some(Ok(Frame::Text(text))) => return serde_json::from_str::<Value>(text.as_str()).ok(),
                Some(Ok(Frame::Ping(_))) | Some(Ok(Frame::Pong(_))) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
    .filter(|frame| frame["type"] == "app_snapshot")
    .ok_or_else(offline)?;
    mirror.apply(&first);
    engine.app.remote_values(&remote.id, mirror.values.clone());
    engine.remotes.connected(remote, &version).await;
    engine.remotes.seen_orgs(engine, remote, &mirror.seen(), true).await;
    if remote.stop.is_cancelled() {
        return Err(offline());
    }
    identify(engine, remote, &conn, timing).await;
    remote.conn.store(Some(conn));
    let next = LinkState { phase: Phase::Connected, since: Utc::now(), next_attempt_at: None, error: None, code: None,
        version: Some(version), transport: Some(transport) };
    tracing::info!(remote = %remote.tag(), transport = transport.as_str(), "remote engine connected");
    show(engine, remote, next, Some(&mirror));
    Ok((socket, mirror))
}

/// Who this connection is on the remote engine, and the name it shows there.
/// The remote's client list says whose token asked (`you`); this desktop's
/// own client is given the name its user chose when the remote does not have
/// it yet. An engine that says nothing (older than 4.6.0) leaves it unknown,
/// and nothing here can fail a connection.
#[nolog]
async fn identify(engine: &Arc<Engine>, remote: &Arc<Remote>, conn: &Conn, timing: &Timing) {
    let (token, base) = (remote.token(), conn.address.base());
    let Some(listed) = handshake::clients(&conn.http, &base, &token, timing.request).await else { return };
    let text = |value: &Value| value.as_str().filter(|t| !t.is_empty()).map(|t| t.chars().take(100).collect::<String>());
    let Some(mut me) = text(&listed["you"]["id"]).zip(text(&listed["you"]["name"])).map(|(id, name)| Me { id, name }) else {
        remote.set_me(None);
        return;
    };
    let saved = remote.saved();
    let chosen = engine.remotes.chosen_name();
    // a token this desktop only borrowed (it could make none of its own) keeps the name it has there
    if saved.client_id.as_deref() == Some(me.id.as_str()) && saved.label_sent != chosen {
        if let Some(name) = handshake::set_label(&conn.http, &base, &token, &me.id, chosen.as_deref(), timing.request).await {
            me.name = name;
            engine.remotes.label_sent(remote, chosen).await;
        }
    }
    remote.set_me(Some(me));
}

/// The connected life of a link: the remote's frames keep the mirror and the
/// list current; a ping keeps a quiet line honest.
#[nolog]
async fn session(engine: &Arc<Engine>, remote: &Arc<Remote>, timing: &Timing, socket: &mut Upstream, mirror: &mut Mirror) -> End {
    let before = remote.saved();
    let token_before = remote.token();
    let mut heard = Instant::now();
    let mut ping = tokio::time::interval_at(Instant::now() + timing.ping, timing.ping);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = remote.stop.cancelled() => { goodbye(socket).await; return End::Stop; }
            _ = engine.shutdown.cancelled() => { goodbye(socket).await; return End::Stop; }
            _ = remote.wake.notified() => {
                let now = remote.saved();
                if !now.enabled || now.url != before.url || !Arc::ptr_eq(&token_before, &remote.token()) {
                    goodbye(socket).await;
                    return End::Changed;
                }
                // a new name shows in the rows; "retry now" while connected has nothing to do
                push_rows(engine, remote, Some(mirror));
                // the name this desktop shows to others may be what changed
                if let Some(conn) = remote.conn() {
                    let before = remote.me();
                    identify(engine, remote, &conn, timing).await;
                    if before != remote.me() {
                        engine.remotes.publish(engine);
                    }
                }
            }
            _ = remote.lost.notified() => return End::Lost("relayed requests failed".into()),
            frame = socket.next() => {
                heard = Instant::now();
                match frame {
                    Some(Ok(Frame::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        let changed = mirror.apply(&frame);
                        if changed.registry {
                            engine.remotes.seen_orgs(engine, remote, &mirror.seen(), false).await;
                        }
                        if changed.registry || changed.rows {
                            push_rows(engine, remote, Some(mirror));
                        }
                        if changed.values {
                            engine.app.remote_values(&remote.id, mirror.values.clone());
                        }
                        if changed.registry {
                            engine.remotes.publish(engine);
                        }
                    }
                    Some(Ok(Frame::Close(_))) | None => return End::Lost("the remote closed the app socket".into()),
                    Some(Err(error)) => return End::Lost(format!("the app socket failed: {error}")),
                    // a ping (answered by the socket itself), a pong, a binary frame
                    Some(Ok(_)) => {}
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() >= timing.dead {
                    return End::Lost(format!("nothing heard for {} s", timing.dead.as_secs()));
                }
                let sent = tokio::time::timeout(timing.request, socket.send(Frame::Ping(Default::default()))).await;
                if !matches!(sent, Ok(Ok(()))) {
                    return End::Lost("the app socket could not be written".into());
                }
            }
        }
    }
}

/// A clean goodbye, within a second.
#[nolog]
async fn goodbye(socket: &mut Upstream) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), socket.close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({
            "type": "app_snapshot", "epoch": "r1", "seq": 9,
            "registry": { "type": "registry_snapshot", "epoch": "r1", "cursor": { "app_uuid": "a", "incarnation": "r1", "rev": 1 },
                "records": [
                    { "entity": "registry_org", "id": "1", "body": { "org_id": 1, "slug": "acme", "org_uuid": "u-acme", "state": "active" } },
                    { "entity": "registry_org", "id": "2", "body": { "org_id": 2, "slug": "beta", "org_uuid": "u-beta", "state": "active" } },
                ] },
            "summaries": { "1": { "type": "org_summary", "org_id": 1, "org_uuid": "u-acme", "body": { "name": "Acme", "nodes": 4, "live": 3, "attention": 2 } } },
            "notices": {},
            "runtime": { "values": { "accounts": { "epoch": "r1", "seq": 3, "value": [{ "id": "remote-account" }] } },
                         "orgs": { "1": { "epoch": "r1", "seq": 4, "working": 2 } } },
        })
    }

    #[test]
    fn the_mirror_follows_the_remote_app_feed() {
        let mut mirror = Mirror::default();
        let changed = mirror.apply(&snapshot());
        assert!(changed.registry && changed.rows && changed.values);
        let seen = mirror.seen();
        assert_eq!(seen.iter().map(|o| (o.remote_slug.as_str(), o.name.as_str())).collect::<Vec<_>>(), [("acme", "Acme"), ("beta", "beta")],
            "an organization with no summary yet goes by its slug");
        assert_eq!(mirror.values["accounts"][0]["id"], "remote-account");
        assert_eq!(mirror.live("acme", "u-acme").map(|(_, s, n)| (s.unwrap()["nodes"].as_i64(), n)), Some((Some(4), 2)));
        // the same registry again is no change; a summary and a working count are row changes
        assert_eq!(mirror.apply(&snapshot()["registry"]), Changed::default());
        let summary = json!({ "type": "org_summary", "org_id": 2, "org_uuid": "u-beta", "body": { "name": "Beta", "nodes": 1 } });
        assert_eq!(mirror.apply(&summary), Changed { rows: true, ..Changed::default() });
        assert_eq!(mirror.apply(&summary), Changed::default());
        let working = json!({ "type": "app_runtime", "orgs": { "2": { "working": 1 } } });
        assert_eq!(mirror.apply(&working), Changed { rows: true, ..Changed::default() });
        let value = json!({ "type": "app_runtime", "values": { "accounts": { "value": [] } } });
        assert_eq!(mirror.apply(&value), Changed { values: true, ..Changed::default() });
        assert_eq!(mirror.apply(&value), Changed::default());
        assert_eq!(mirror.apply(&working), Changed::default());
        // an organization deleted on the remote leaves the registry
        let gone = json!({ "type": "registry_snapshot", "records": [{ "entity": "registry_org", "id": "2", "body": { "org_id": 2, "slug": "beta", "org_uuid": "u-beta", "state": "active" } }] });
        assert_eq!(mirror.apply(&gone), Changed { registry: true, ..Changed::default() });
        assert_eq!(mirror.seen().len(), 1);
        // a summary stamped for another incarnation of the slug is not this organization's
        assert!(mirror.live("beta", "another-uuid").unwrap().1.is_none());
    }
}
