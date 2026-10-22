//! `websocket` watchdogs (docs/rust-engine/websocket-watchdogs.md; user
//! 2026-10-19 21:00Z/21:01:59Z, design approved by the coordinator 21:14Z):
//! a dog dials a ws:// or wss:// server, sends its hello messages after
//! every connect (and a heartbeat while connected, when it has one), and
//! fires with the text messages that match its pattern, behind the EXTERNAL
//! tag: they are outside input agents report and never obey. Its owner, or
//! a manager, can write on the live connection (`orgtree_watchdog
//! action=send`). Every dog has its own connection (`crate::ws`): a
//! WebSocket session is stateful. Credentials are a file in the owner's
//! folders, re-read on every connect, or inline, sealed in
//! `ot.watchdog_secrets` with mqtt's key; neither ever reaches a list, a
//! card, mail or a log. The owner needs the web tool, as for mqtt.

use super::*;
use crate::ws::{creds, render, Conn, Spec, State};

pub(super) const NO_WEB: &str = "its owner no longer holds the web tool — a websocket watchdog reaches the network with its owner's hands";
/// The arguments only a websocket dog takes.
const FIELDS: &[&str] = &["hello", "protocols", "heartbeat", "notify_on_connect"];
/// An outage is reported once it has lasted this long; a blip is not.
const DOWN_ALERT_S: i64 = 60;
/// After an outage alert, connected this long before "recovered" is told.
const RECOVERED_AFTER_S: i64 = 60;
/// The owner's authority is checked again this often while the dog listens.
const RECHECK: Duration = Duration::from_secs(60);
/// How long create waits for the server (the connect timeout is 10 s).
const SMOKE: Duration = Duration::from_secs(10);
const PENDING_KEEP: usize = 200;
/// How long `send` waits for its frame to be written.
const SEND_WAIT: Duration = Duration::from_secs(15);
const PROTOCOL_MAX: usize = 64;
const HEARTBEAT_MAX_S: u64 = 86_400;

/// Refuse the websocket-only arguments on another kind, and a send's
/// `message` on create.
#[logged]
pub(super) fn foreign_fields(kind: &str, args: &Value) -> Result<()> {
    if kind != "websocket" && FIELDS.iter().filter(|k| **k != "notify_on_connect").any(|k| args.get(*k).is_some_and(|v| !v.is_null())) {
        refuse!(BadRequest, "hello, protocols, heartbeat and notify_on_connect are for kind websocket only");
    }
    if !matches!(kind,"websocket"|"mqtt") && args.get("notify_on_connect").is_some() {
        refuse!(BadRequest,"notify_on_connect is an alias for mqtt/websocket connection_messages only");
    }
    if args.get("message").is_some_and(|v| !v.is_null()) {
        refuse!(BadRequest, "message is for action=send (it writes on a websocket dog's live connection); messages sent after every connect go in hello");
    }
    Ok(())
}

/// A new websocket dog, validated at create.
pub(super) struct Created {
    /// The canonical URL.
    pub target: String,
    pub memo: Value,
    inline: Option<creds::Inline>,
    endpoint: crate::ws::Endpoint,
    source: creds::Source,
    hello: Vec<String>,
    protocols: Vec<String>,
    heartbeat: Option<(String, Duration)>,
    pattern: Option<Regex>,
    plaintext: bool,
}

/// Check a create call's websocket arguments: the URL, pattern, hello,
/// protocols, heartbeat and credentials, and the owner's web tool. The
/// credentials are checked as a connection would use them.
#[logged]
pub(super) async fn validate(engine: &Arc<Engine>, org_id: i64, owner: i64, scratch: &Path, target: &str, args: &Value) -> Result<Created> {
    let endpoint = match crate::ws::parse_target(target) {
        Ok(e) => e,
        Err(e) => refuse!(BadRequest, "{e}"),
    };
    if !holds_web(engine, owner).await? {
        refuse!(Forbidden, "a websocket watchdog reaches the network with YOUR hands — it needs the web tool you do not hold; ask for it (orgtree_request_scope)");
    }
    for k in crate::domain::watchdogs::CREDENTIAL_KEYS {
        if args.get(*k).is_some_and(|v| !v.is_null()) {
            refuse!(BadRequest, "{k} goes inside credentials: credentials={{\"{k}\": …}} (stored encrypted, never shown), or a credentials file path");
        }
    }
    let pattern = match args["pattern"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => match compile(p) {
            Ok(r) => Some(r),
            Err(e) => refuse!(BadRequest, "pattern does not compile: {e}"),
        },
    };
    let notify_on_connect = notify_setting(args.get("notify_on_connect"))?;
    let hello = match args.get("hello") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => match creds::messages(v, "hello") {
            Ok(h) => h,
            Err(e) => refuse!(BadRequest, "{e}"),
        },
    };
    let protocols: Vec<String> = match args.get("protocols") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => {
            let names: Vec<String> = a.iter().filter_map(|p| p.as_str().map(str::trim).map(str::to_string)).collect();
            let token = |p: &str| !p.is_empty() && p.len() <= PROTOCOL_MAX && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
            if names.len() != a.len() || names.len() > crate::ws::PROTOCOLS_MAX || !names.iter().all(|p| token(p)) {
                refuse!(BadRequest, "protocols is a list of at most {} subprotocol names (HTTP tokens such as vite-hmr or graphql-transport-ws)", crate::ws::PROTOCOLS_MAX);
            }
            names
        }
        Some(_) => refuse!(BadRequest, "protocols is a list of subprotocol names, e.g. [\"graphql-transport-ws\"]"),
    };
    let heartbeat = match args.get("heartbeat") {
        None | Some(Value::Null) => None,
        Some(Value::Object(o)) => {
            if o.keys().any(|k| k != "message" && k != "every_s") {
                refuse!(BadRequest, "heartbeat is {{message, every_s}}: the message sent every every_s seconds while connected");
            }
            let message = match o.get("message") {
                None | Some(Value::Null) => refuse!(BadRequest, "heartbeat needs message: the text (or JSON) sent every every_s seconds"),
                Some(m) => creds::message_text(m),
            };
            if message.is_empty() || message.len() > crate::ws::HELLO_BYTES {
                refuse!(BadRequest, "the heartbeat message must be 1 byte to {} KB", crate::ws::HELLO_BYTES / 1024);
            }
            let Some(every) = o.get("every_s").and_then(Value::as_u64).filter(|s| (crate::ws::HEARTBEAT_FLOOR_S..=HEARTBEAT_MAX_S).contains(s)) else {
                refuse!(BadRequest, "heartbeat.every_s is a whole number of seconds, {} to {HEARTBEAT_MAX_S}", crate::ws::HEARTBEAT_FLOOR_S);
            };
            Some((message, Duration::from_secs(every)))
        }
        Some(_) => refuse!(BadRequest, "heartbeat is an object {{message, every_s}}"),
    };
    let (source, shown, inline) = match args.get("credentials") {
        None | Some(Value::Null) => (creds::Source::None, Value::Null, None),
        Some(Value::String(p)) => {
            let full = file_target(scratch, p.trim());
            if !file_contained(engine, org_id, owner, scratch, &full).await? {
                refuse!(Forbidden, "cannot use {} as credentials — only files in your working folder, the workspace, or a folder you hold are usable (orgtree_request_scope can ask for more)",
                        full.display());
            }
            if let Err(e) = creds::check_file(&full, &endpoint) {
                refuse!(BadRequest, "{e}");
            }
            let shown = json!({ "kind": "file", "path": full.to_string_lossy() });
            (creds::Source::File(full), shown, None)
        }
        Some(v @ Value::Object(_)) => match creds::inline_from_args(v) {
            Ok(i) => (creds::Source::Inline(Arc::new(i.clone())), json!({ "kind": "inline" }), Some(i)),
            Err(e) => refuse!(BadRequest, "{e}"),
        },
        Some(_) => refuse!(BadRequest, "credentials is a credentials file path or an object {{headers, bearer, username, password, query, hello}}"),
    };
    let plaintext = !endpoint.tls && !endpoint.loopback() && !matches!(source, creds::Source::None);
    let memo = json!({
        "credentials": shown, "hello": hello, "protocols": protocols, "notify_on_connect": notify_on_connect,
        "heartbeat": heartbeat.as_ref().map(|(m, every)| json!({ "message": m, "every_s": every.as_secs() })),
    });
    Ok(Created { target: endpoint.url(), memo, inline, endpoint, source, hello, protocols, heartbeat, pattern, plaintext })
}

#[nolog]
pub(super) fn notify_setting(value: Option<&Value>) -> Result<bool> {
    match value {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(enabled)) => Ok(*enabled),
        _ => refuse!(BadRequest, "notify_on_connect must be true or false"),
    }
}

/// The sealed form of a new dog's inline credentials, for its row: mqtt's
/// key and table.
#[nolog]
pub(super) fn sealed(engine: &Engine, c: &Created, row: i64) -> Result<Option<Vec<u8>>> {
    let Some(inline) = &c.inline else { return Ok(None) };
    let sealed = engine.dogs.mqtt.key(&mqtt::secrets_dir(engine))
        .and_then(|k| crate::mqtt::seal::seal(&k, row, &creds::inline_to_bytes(inline)))
        .map_err(|e| crate::domain::user_err(crate::domain::UserError::Unprocessable, format!("the inline credentials cannot be stored: {e}")))?;
    Ok(Some(sealed))
}

enum Smoke {
    Connected,
    Refused(String),
    Down(String),
    Slow,
}

/// Create's smoke check: dial and report what the server says within 10 s.
/// The connection goes to the dog's runner ([`crate::ws::Hub::park`]), so
/// its hellos are not sent twice and messages that arrive meanwhile wait.
#[logged]
pub(super) async fn smoke(engine: &Arc<Engine>, c: &Created) -> (Value, Option<Conn>) {
    let spec = Spec { endpoint: c.endpoint.clone(), protocols: c.protocols.clone(), hello: c.hello.clone(), heartbeat: c.heartbeat.clone(),
                      pattern: c.pattern.clone(), source: c.source.clone() };
    let mut conn = engine.dogs.ws.open(spec, &engine.shutdown);
    let url = c.endpoint.url();
    let deadline = Instant::now() + SMOKE;
    let outcome = loop {
        match conn.state.borrow_and_update().state.clone() {
            State::Connected { .. } => break Smoke::Connected,
            State::Refused { error, .. } => break Smoke::Refused(error),
            State::Down { error, .. } => break Smoke::Down(error),
            State::Connecting { .. } => {}
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break Smoke::Slow,
            changed = conn.state.changed() => if changed.is_err() { break Smoke::Down("the connection closed".into()) },
        }
    };
    let what = match &c.pattern {
        Some(_) => "text messages matching its pattern fire this dog",
        None => "every message fires this dog (binary ones as their size)",
    };
    let mut res = match &outcome {
        Smoke::Connected => {
            let protocol = conn.stats.protocol.lock().ok().and_then(|p| p.clone()).map(|p| format!(" (subprotocol {p})")).unwrap_or_default();
            let hellos = if c.hello.is_empty() { String::new() } else { format!("; sent its {} hello message(s)", c.hello.len()) };
            json!({ "ran": format!("connected to {url}{protocol}{hellos}"), "note": format!("{what} from now on; send writes on this connection") })
        }
        Smoke::Refused(e) => json!({ "ran": format!("⚠ the server refused this client: {e}"), "broken": true,
                                     "note": "the dog stays armed and retries after 1 min, then every 5 min. Fix the credentials (a credentials file is read again on every attempt) or the URL; it picks the fix up by itself, or resume the dog to retry at once" }),
        Smoke::Down(e) => json!({ "ran": format!("⚠ {url} cannot be reached now: {e}"), "broken": true,
                                  "note": "the dog stays armed and keeps retrying (2 s, doubling to 5 min); you are told if it stays down for a minute, and when it is back" }),
        Smoke::Slow => json!({ "ran": format!("still connecting to {url} after {} s", SMOKE.as_secs()),
                               "note": "the dog keeps trying; you are told if it stays down" }),
    };
    if c.plaintext {
        res["plaintext"] = json!("⚠ these credentials travel UNENCRYPTED over ws:// to a host that is not this machine; prefer wss://");
    }
    (res, Some(conn))
}

/// What `list` shows an agent of the dog's last message: it is the server's
/// text, outside input, so it carries the fire mail's tag.
#[nolog]
pub(super) fn last_output_shown(d: &Dog) -> Value {
    match d.run["last_output"].as_str() {
        Some(g) if !g.is_empty() => json!(format!("{} {g}", crate::mqtt::render::TAG)),
        _ => Value::Null,
    }
}

/// A plain-words warning about a websocket dog's connection, or None.
#[nolog]
pub(super) fn health(d: &Dog) -> Option<String> {
    let c = &d.run["websocket"];
    let s = |k: &str| c[k].as_str().unwrap_or("").to_string();
    match c["state"].as_str() {
        Some("down") => Some(format!("⚠ the server is unreachable since {}: {}. It retries on its own (next try {}); messages sent meanwhile are missed.",
                                     s("since"), s("error"), s("retry_at"))),
        Some("refused") => Some(format!("⚠ REFUSED by the server since {}: {}. It retries every 5 min (next try {}) and picks up a fix by itself: fix the credentials or the URL; resume it to retry at once.",
                                        s("since"), s("error"), s("retry_at"))),
        _ => d.run["dropped"].as_u64().filter(|n| *n > 0)
            .map(|n| format!("⚠ {n} messages were dropped: they arrived faster than this dog could take them")),
    }
}

/// `orgtree_watchdog action=send`: write `message` on the live connection
/// of `dog`, already resolved for `actor` (its owner or a manager).
#[logged]
pub(super) async fn send(engine: &Arc<Engine>, dog: &Dog, actor: Option<i64>, message: &Value) -> Result<Value> {
    if dog.kind != "websocket" {
        refuse!(BadRequest, "send writes on a websocket watchdog's live connection; {} is a {} watchdog", dog.uid, dog.kind);
    }
    if let Some(a) = actor {
        if !holds_web(engine, a).await? {
            refuse!(Forbidden, "send writes to the network with YOUR hands — it needs the web tool you do not hold; ask for it (orgtree_request_scope)");
        }
    }
    let text = match message {
        Value::Null => refuse!(BadRequest, "send needs message: the text to write (a JSON object or array is sent as compact JSON)"),
        v => creds::message_text(v),
    };
    if text.is_empty() {
        refuse!(BadRequest, "message is empty: nothing to send");
    }
    if text.len() > crate::ws::SEND_MAX {
        refuse!(BadRequest, "message is {} bytes; send writes at most {} KB in one message", text.len(), crate::ws::SEND_MAX / 1024);
    }
    match dog.state.as_str() {
        "armed" => {}
        "paused" => {
            let why = dog.memo["paused_why"].as_str().map(|w| format!(" ({w})")).unwrap_or_default();
            refuse!(Conflict, "watchdog {} is paused{why}; resume it first — nothing was sent", dog.uid);
        }
        other => refuse!(Conflict, "watchdog {} is {other}; nothing was sent", dog.uid),
    }
    let base = crate::ws::parse_target(&dog.target).map(|e| e.base()).unwrap_or_else(|_| dog.target.clone());
    let Some(link) = engine.dogs.ws.link(dog.row) else {
        refuse!(Conflict, "watchdog {} has no live connection right now (its listener is starting); nothing was sent — try again in a few seconds", dog.uid);
    };
    let state = link.state.borrow().state.clone();
    if !matches!(state, State::Connected { .. }) {
        refuse!(Conflict, "watchdog {} is not connected to {base}: {}; nothing was sent", dog.uid, mqtt::connection_line(&state));
    }
    match link.send(text, SEND_WAIT).await {
        Ok(sent) => {
            tracing::info!(watchdog = %dog.uid, owner = %dog.owner_name, url = %base, bytes = sent.bytes, "websocket message sent");
            let replies = if dog.pattern.is_some() { "when they match its pattern" } else { "(every message fires it)" };
            Ok(json!({ "id": dog.uid, "name": dog.name, "sent": true, "bytes": sent.bytes, "at": iso(sent.at),
                       "note": format!("written on {base}; the server's replies arrive as this dog's fires {replies}") }))
        }
        Err(e) => {
            tracing::info!(watchdog = %dog.uid, owner = %dog.owner_name, url = %base, "websocket send refused");
            refuse!(Conflict, "nothing was sent on {base}: {e}")
        }
    }
}

/// The runner of an armed websocket dog (dispatched from `arm_retry`).
#[logged]
pub(super) async fn run(engine: &Arc<Engine>, dog: Dog, cancel: &CancellationToken) -> Result<()> {
    let parked = engine.dogs.ws.unpark(dog.row);
    if dog.state != "armed" {
        return Ok(());
    }
    if !dog.owner_live {
        pause(engine, &dog, ARCHIVE_PAUSE).await?;
        return Ok(());
    }
    if let Some(why) = authority_lost(engine, &dog).await? {
        pause(engine, &dog, why).await?;
        return Ok(());
    }
    let cfg = match Config::of(&dog) {
        Ok(c) => c,
        Err(why) => {
            pause(engine, &dog, &why).await?;
            return Ok(());
        }
    };
    let conn = match parked {
        Some(c) => c,
        None => {
            let source = match source(engine, &dog, &cfg).await? {
                Ok(s) => s,
                Err(why) => {
                    pause(engine, &dog, &why).await?;
                    return Ok(());
                }
            };
            engine.dogs.ws.open(cfg.spec(source), &engine.shutdown)
        }
    };
    let _registered = engine.dogs.ws.register(dog.row, &conn);
    Listener::new(engine, dog, cfg, conn).listen(cancel).await
}

/// How a credentials kind is kept in the memo.
enum Kind {
    None,
    File(PathBuf),
    Inline,
}

/// A dog's stored configuration, read back for its runner.
struct Config {
    endpoint: crate::ws::Endpoint,
    pattern: Option<Regex>,
    hello: Vec<String>,
    protocols: Vec<String>,
    heartbeat: Option<(String, Duration)>,
    creds: Kind,
}

#[logged]
impl Config {
    /// Why the stored configuration is unusable, or the configuration.
    #[nolog]
    fn of(d: &Dog) -> std::result::Result<Config, String> {
        let endpoint = crate::ws::parse_target(&d.target).map_err(|e| format!("its target is not a WebSocket URL ({e})"))?;
        let pattern = match d.pattern.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => Some(compile(p).map_err(|e| format!("its pattern does not compile here ({e})"))?),
            None => None,
        };
        let m = &d.memo["websocket"];
        let strings = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
        let heartbeat = match (m["heartbeat"]["message"].as_str(), m["heartbeat"]["every_s"].as_u64()) {
            (Some(msg), Some(s)) => Some((msg.to_string(), Duration::from_secs(s.max(crate::ws::HEARTBEAT_FLOOR_S)))),
            _ => None,
        };
        let creds = match m["credentials"]["kind"].as_str() {
            Some("file") => Kind::File(PathBuf::from(m["credentials"]["path"].as_str().unwrap_or_default())),
            Some("inline") => Kind::Inline,
            _ => Kind::None,
        };
        Ok(Config { endpoint, pattern, hello: strings(&m["hello"]), protocols: strings(&m["protocols"]), heartbeat, creds })
    }

    #[nolog]
    fn spec(&self, source: creds::Source) -> Spec {
        Spec { endpoint: self.endpoint.clone(), protocols: self.protocols.clone(), hello: self.hello.clone(), heartbeat: self.heartbeat.clone(),
               pattern: self.pattern.clone(), source }
    }
}

/// The credentials a runner connects with; inline ones are unsealed here.
#[nolog]
async fn source(engine: &Engine, d: &Dog, cfg: &Config) -> Result<std::result::Result<creds::Source, String>> {
    Ok(match &cfg.creds {
        Kind::None => Ok(creds::Source::None),
        Kind::File(p) => Ok(creds::Source::File(p.clone())),
        Kind::Inline => {
            let client = engine.db.get().await?;
            let sealed: Option<Vec<u8>> = client
                .query_opt("SELECT sealed FROM ot.watchdog_secrets WHERE watchdog_id = $1", &[&d.row])
                .await?
                .map(|r| r.get(0));
            drop(client);
            match sealed {
                None => Err("its inline credentials are gone; re-create the dog with them".into()),
                Some(s) => engine.dogs.mqtt.key(&mqtt::secrets_dir(engine))
                    .and_then(|k| crate::mqtt::seal::unseal(&k, d.row, &s))
                    .and_then(|b| creds::inline_from_bytes(&b))
                    .map(|i| creds::Source::Inline(Arc::new(i))),
            }
        }
    })
}

/// An armed websocket dog listening on its connection.
struct Listener<'a> {
    engine: &'a Arc<Engine>,
    d: Dog,
    cfg: Config,
    conn: Conn,
    gap: Duration,
    /// Matching messages waiting for the next fire, and how many there were.
    pending: Vec<crate::ws::Message>,
    total: usize,
    last_fire: Option<Instant>,
    /// The dog's counters before this runner (its connection counts afresh).
    base_seen: i64,
    base_sent: i64,
    base_dropped: u64,
    base_binary: u64,
    dirty: bool,
    /// A match since the last save restarts a silence dog's clock.
    matched: bool,
    last_save: Instant,
    last_auth: Instant,
    down_alerted: Option<DateTime<Utc>>,
    refused_alerted: Option<String>,
    /// Connected after an outage alert: "recovered" is told once it has
    /// lasted RECOVERED_AFTER_S (a server that drops the client again at
    /// once has not recovered).
    recovered_due: Option<DateTime<Utc>>,
    state_saved: Option<Value>,
    connections_seen: u64,
    ever_connected: bool,
}

#[logged]
impl<'a> Listener<'a> {
    #[nolog]
    fn new(engine: &'a Arc<Engine>, d: Dog, cfg: Config, conn: Conn) -> Listener<'a> {
        let ever_connected = d.run["has_connected"].as_bool().unwrap_or(false)
            || d.run["websocket"]["state"] == "connected";
        Listener {
            engine,
            gap: Duration::from_secs(d.interval_s.max(STREAM_FLOOR_S) as u64),
            base_seen: d.run_i64("checks_run"),
            base_sent: d.run_i64("sent"),
            base_dropped: d.run["dropped"].as_u64().unwrap_or(0),
            base_binary: d.run["binary"].as_u64().unwrap_or(0),
            d,
            cfg,
            conn,
            pending: Vec::new(),
            total: 0,
            last_fire: None,
            dirty: false,
            matched: false,
            last_save: Instant::now(),
            last_auth: Instant::now(),
            down_alerted: None,
            refused_alerted: None,
            recovered_due: None,
            state_saved: None,
            connections_seen: 0,
            ever_connected,
        }
    }

    async fn listen(mut self, cancel: &CancellationToken) -> Result<()> {
        if self.state_changed().await? {
            return Ok(());
        }
        loop {
            let wait = self.wait();
            tokio::select! {
                _ = cancel.cancelled() => {
                    if self.dirty || self.counters_moved() {
                        let _ = self.save().await;
                    }
                    return Ok(());
                }
                m = self.conn.rx.recv() => {
                    if self.conn.stats.get(&self.conn.stats.connections) > self.connections_seen && self.state_changed().await? {
                        return Ok(());
                    }
                    // the connection went away: the runner ends and is re-armed
                    let Some(m) = m else { return Ok(()) };
                    self.message(m);
                    while let Ok(m) = self.conn.rx.try_recv() {
                        self.message(m);
                    }
                }
                changed = self.conn.state.changed() => {
                    if changed.is_err() || self.state_changed().await? {
                        return Ok(());
                    }
                }
                _ = tokio::time::sleep(wait) => {}
            }
            if self.tick().await? {
                return Ok(());
            }
        }
    }

    /// Until the next thing due: a fire past its gap, a silence deadline,
    /// a down or recovered alert, the authority recheck, a save.
    #[nolog]
    fn wait(&self) -> Duration {
        let mut w = RECHECK.saturating_sub(self.last_auth.elapsed());
        if !self.pending.is_empty() {
            w = w.min(self.last_fire.map_or(Duration::ZERO, |t| self.gap.saturating_sub(t.elapsed())));
        }
        if let Some(s) = self.d.due_in() {
            w = w.min(Duration::from_secs(s.max(0) as u64));
        }
        // counters move without a message for the dog (a non-matching one)
        let save_every = Duration::from_secs(if self.matched { 2 } else { 10 });
        if self.dirty || self.counters_moved() {
            w = w.min(save_every.saturating_sub(self.last_save.elapsed()));
        }
        let now = Utc::now();
        if let State::Down { since, .. } = &self.conn.state.borrow().state {
            if self.down_alerted != Some(*since) {
                w = w.min((*since + chrono::Duration::seconds(DOWN_ALERT_S) - now).to_std().unwrap_or(Duration::ZERO));
            }
        }
        if let Some(due) = self.recovered_due {
            w = w.min((due - now).to_std().unwrap_or(Duration::ZERO));
        }
        w.max(Duration::from_millis(50))
    }

    /// Have the connection's counters moved since the last save?
    #[nolog]
    fn counters_moved(&self) -> bool {
        let s = &self.conn.stats;
        self.base_seen + s.get(&s.received) as i64 != self.d.run_i64("checks_run")
            || self.base_sent + s.get(&s.sent) as i64 != self.d.run_i64("sent")
    }

    /// Take one matching message.
    #[nolog]
    fn message(&mut self, m: crate::ws::Message) {
        self.dirty = true;
        if self.d.silence() {
            let now = Utc::now();
            self.matched = true;
            self.d.silence_since = Some(now);
            self.d.next_silence_at = Some(now + chrono::Duration::seconds(self.d.quiet_s.unwrap_or(600).max(1)));
        } else {
            self.total += 1;
            if self.pending.len() < PENDING_KEEP {
                self.pending.push(m);
            }
        }
    }

    /// The timed work; true when the dog is done.
    async fn tick(&mut self) -> Result<bool> {
        if !self.pending.is_empty() && self.last_fire.is_none_or(|t| t.elapsed() >= self.gap) {
            let msgs = std::mem::take(&mut self.pending);
            let total = std::mem::take(&mut self.total);
            self.last_fire = Some(Instant::now());
            self.save().await?;
            let lines = render::fire_lines(&msgs);
            if fire_with(self.engine, &mut self.d, &lines, " WEBSOCKET —", Some(json!({ "source": "websocket", "count": total }))).await? {
                return Ok(true);
            }
        }
        if self.d.due_in().is_some_and(|s| s <= 0) {
            if self.dirty {
                self.save().await?;
            }
            if fire_quiet(self.engine, &mut self.d).await? {
                return Ok(true);
            }
        }
        self.down_alert().await?;
        self.recovered_alert().await?;
        if self.last_auth.elapsed() >= RECHECK {
            self.last_auth = Instant::now();
            if let Some(why) = authority_lost(self.engine, &self.d).await? {
                pause(self.engine, &self.d, why).await?;
                return Ok(true);
            }
        }
        let since_save = self.last_save.elapsed();
        if (self.dirty || self.counters_moved()) && (since_save >= Duration::from_secs(10) || (self.matched && since_save >= Duration::from_secs(2))) {
            self.save().await?;
            match load(self.engine, self.d.row).await? {
                Some(fresh) if fresh.state == "armed" => self.d = fresh,
                _ => return Ok(true),
            }
        }
        Ok(false)
    }

    /// Persist the dog's progress (and restart a silence clock on a match).
    async fn save(&mut self) -> Result<()> {
        let s = self.conn.stats.clone();
        self.d.run["checks_run"] = json!(self.base_seen + s.get(&s.received) as i64);
        self.d.run["sent"] = json!(self.base_sent + s.get(&s.sent) as i64);
        let last = s.last.lock().ok().and_then(|l| l.clone());
        if let Some(m) = last {
            self.d.run["last_output"] = json!(render::gist(&m, 300));
        }
        if let Some(at) = s.last_sent.lock().ok().and_then(|l| *l) {
            self.d.run["last_sent_at"] = json!(iso(at));
        }
        let binary = self.base_binary + s.get(&s.binary);
        if binary > 0 {
            self.d.run["binary"] = json!(binary);
        }
        let dropped = self.base_dropped + s.get(&s.dropped);
        if dropped > 0 {
            self.d.run["dropped"] = json!(dropped);
        }
        let matched = std::mem::take(&mut self.matched);
        save_run(self.engine, &mut self.d, matched).await?;
        self.dirty = false;
        self.last_save = Instant::now();
        Ok(())
    }

    /// The connection changed: keep its state in the row, tell the owner
    /// about a refusal at once, and arm the recovered alert after an outage.
    async fn state_changed(&mut self) -> Result<bool> {
        let snap = self.conn.state.borrow_and_update().clone();
        let view = json!(snap.state);
        let connections = self.conn.stats.get(&self.conn.stats.connections);
        let new_connection = connections > self.connections_seen;
        if new_connection { self.d.run["has_connected"] = json!(true); }
        if self.state_saved.as_ref() != Some(&view) || new_connection {
            self.d.run["websocket"] = view.clone();
            self.state_saved = Some(view);
            self.save().await?;
            changes::notify_id(self.engine, self.d.org_id, vec![Change::Watchdogs]);
        }
        if new_connection {
            while self.connections_seen < connections {
                self.connections_seen += 1;
                let event = if self.ever_connected { "reconnected" } else { "connected" };
                self.ever_connected = true;
                self.alert(format!("Orgtree connection event: WebSocket {event} to {} (not a server message)", self.cfg.endpoint.base()),
                    "Connection messages are administrative; server data still follows the watchdog's pattern and delivery settings.").await?;
            }
        }
        let url = self.cfg.endpoint.base();
        match &snap.state {
            State::Connected { since } => {
                self.refused_alerted = None;
                if self.down_alerted.is_some() {
                    self.recovered_due = Some(*since + chrono::Duration::seconds(RECOVERED_AFTER_S));
                }
            }
            State::Refused { since, error, .. } => {
                self.recovered_due = None;
                let what = format!("refused@{}/{error}", iso(*since));
                if self.refused_alerted.as_deref() != Some(what.as_str()) {
                    self.refused_alerted = Some(what);
                    self.down_alerted = Some(*since);
                    self.alert(format!("the server {url} REFUSED this client: {error}"),
                               "Fix the credentials (a credentials file is read again on every attempt; inline credentials need a new dog) or the URL: it retries after 1 min, then every 5 min, and picks the fix up by itself; resume this dog to retry at once.").await?;
                }
            }
            State::Connecting { .. } | State::Down { .. } => self.recovered_due = None,
        }
        Ok(false)
    }

    /// Report an outage once it has lasted DOWN_ALERT_S.
    async fn down_alert(&mut self) -> Result<()> {
        let State::Down { since, error, .. } = self.conn.state.borrow().state.clone() else { return Ok(()) };
        let lasted = (Utc::now() - since).num_seconds();
        if self.down_alerted == Some(since) || lasted < DOWN_ALERT_S {
            return Ok(());
        }
        self.down_alerted = Some(since);
        let url = self.cfg.endpoint.base();
        self.alert(format!("its WebSocket server {url} has been unreachable for {} ({error})", hours(lasted)),
                   "This is the server or the network, not Orgtree. The dog stays ARMED and reconnects on its own (waits grow to 5 min), sending its hello messages again; messages sent while it is disconnected are missed. You will be told when it is back.").await
    }

    /// After an outage alert, tell the owner once the connection has stayed
    /// up RECOVERED_AFTER_S.
    async fn recovered_alert(&mut self) -> Result<()> {
        let (Some(due), Some(down)) = (self.recovered_due, self.down_alerted) else { return Ok(()) };
        if Utc::now() < due || !matches!(self.conn.state.borrow().state, State::Connected { .. }) {
            return Ok(());
        }
        self.recovered_due = None;
        self.down_alerted = None;
        // from the outage's start to the connection that has now held
        let lasted = hours((due - chrono::Duration::seconds(RECOVERED_AFTER_S) - down).num_seconds());
        let url = self.cfg.endpoint.base();
        self.alert(format!("its WebSocket server {url} is reachable again after {lasted}"),
                   "It has stayed connected for a minute and sent its hello messages again. Messages sent while it was disconnected were missed.").await
    }

    /// Tell the owner about the connection: not a fire (`fired` stays).
    async fn alert(&mut self, headline: String, advice: &str) -> Result<()> {
        let connection = mqtt::connection_line(&self.conn.state.borrow().state);
        let stats = &self.conn.stats;
        let facts = vec![
            format!("server     : {}", self.cfg.endpoint.url()),
            format!("pattern    : {}", self.d.pattern.as_deref().unwrap_or("(every message)")),
            format!("connection : {connection}"),
            format!("messages   : {} received", self.base_seen + stats.get(&stats.received) as i64),
        ];
        let mut body = format!("Watchdog \"{}\" — WebSocket connection: {headline}.\n", self.d.name);
        for f in &facts {
            body.push_str("  ");
            body.push_str(f);
            body.push('\n');
        }
        body.push_str(advice);
        body.push('\n');
        let ev = org_slug(self.engine, &self.d)
            .map(|o| crate::events::watchdog_quiet(&o, &self.d.uid, &self.d.name, &self.d.owner_name, &headline, &facts, advice));
        deliver_connection(self.engine, &self.d, body, ev).await
    }
}
