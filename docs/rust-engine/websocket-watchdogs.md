# WebSocket watchdogs

User request, 2026-10-19 21:00Z: agents should be able to wait on WebSocket feeds (Home
Assistant, OBS, bot gateways, browser debugging, dev servers, price feeds) without a
stream dog running a CLI client. At 21:01:59Z the user added "an auxiliary tool for
sending a message back manually to an active ws connection via a connected ws
watchdog". The design was approved by the coordinator at 21:14Z:

- one connection per dog;
- send is an action of `orgtree_watchdog`;
- the optional heartbeat is included;
- violet outlines for this kind;
- the send text is kept like any tool argument, and the send's own log line carries
  only the dog, the URL and the byte count;
- messages are capped at 1 MiB;
- there is no migration.

The kind is modelled on the [mqtt watchdog](mqtt-watchdogs.md) and reuses its
credential files, sealing, trust rules, backoff, alerts and fire rendering. Docket item:
native-websocket-watchdog-plus-a-tool-to-send-on.

## Create

```json
{"action":"create","name":"ha-doors","kind":"websocket","target":"wss://ha.lan/api/websocket",
 "pattern":"\"event_type\":\"state_changed\"","credentials":"ha/ws.json",
 "hello":[{"id":1,"type":"subscribe_events","event_type":"state_changed"}]}
```

| Field | Meaning |
| --- | --- |
| `target` | `ws://host[:port][/path][?query]` (default port 80) or `wss://…` (TLS, default 443); bracketed IPv6. Refused: user info (`ws://u:p@host`), a fragment, and query parameters named like secrets (`token`, `access_token`, `key`, `api_key`, `apikey`, `auth`, `sig`, `jwt`, `session`, … and anything ending in `token`, `secret`, `password`, `_key`, `-key` or `signature`); those go under `credentials.query`. The path and query must be printable ASCII. Stored canonical: lower-case scheme and host, the port only when it is not the default. |
| `pattern` | Optional regex on text messages; omitted, every message fires (binary ones as their size). It runs on the whole message, before anything is cut. |
| `hello` | Optional: up to 16 messages, 64 KiB in all, sent in order right after every (re)connect. A string goes as it is; any other JSON value goes as compact JSON. Shown in lists and on the card. |
| `protocols` | Optional: up to 8 subprotocol names offered as `Sec-WebSocket-Protocol` (`vite-hmr`, `graphql-transport-ws`). A server that answers with none of them, or with one it was not offered, is a refusal. |
| `heartbeat` | Optional `{message, every_s}` (5 s to 1 day): a fixed message sent every `every_s` seconds while connected, for servers that need an application-level heartbeat (Discord's `{"op":1,"d":null}`). Protocol-level pings are separate (see below). |
| `credentials` | Optional: a path to a credentials file in the owner's folders, or an inline object (below). |
| `once`, `notice`, `interval_s`, `fire_mode`/`quiet_period_s`, `fire_actions` | As for mqtt. `interval_s` is the minimum gap between fires (default 60, floor 5); messages that arrive inside the gap go into the next fire. |

- **The id** comes from the name, or from the kind and target without one.
- **Refused at the top level:** `headers`, `bearer`, `token`, `authorization`,
  `cookie`, `query`, `username`, `password`, `user`, `pass` and `passwd` ("goes inside
  credentials"). `hello`, `protocols` and `heartbeat` are refused on other kinds, and
  a send's `message` on any create.
- **What create checks:** the `web` tool, the URL, the regex, the hellos, the heartbeat
  and the credentials, exactly as a connection would use them (a file is read and its
  PEMs parsed).
- **The smoke check:** create dials and waits up to 10 s for the server's answer. It
  reports one of:
  - connected (with the chosen subprotocol, and that the dog's hellos were sent);
  - refused;
  - unreachable;
  - still connecting.

  The dog stays armed and keeps retrying in every broken case, and the status says so.
  It warns when credentials go over `ws://` to a host that is not this machine.
- **Parking:** the smoke check's connection is parked for the runner (`Hub::park`), so
  the hellos are not sent twice and messages that arrive meanwhile wait for the runner.

## Credentials

- **The two forms:**
  - **A file:** JSON in the owner's folders, checked with the same `file_contained`
    rule as file dogs, re-read on every connect, at most 64 KB.
  - **Inline:** an object in the create call, sealed with AES-256-GCM in
    `ot.watchdog_secrets`, with the same key and table as mqtt's inline credentials
    ([mqtt watchdogs](mqtt-watchdogs.md#credentials)). The row is dropped when the dog
    is removed or spent.
- **Fields:**

  | Field | Meaning |
  | --- | --- |
  | `headers` | `{name: value}`, at most 32, values up to 8 KB without line breaks. Any header (`Authorization`, `Cookie`, `Origin`, `X-Api-Key`…) except the ones the client writes itself: `Host`, `Upgrade`, `Connection`, `Content-Length`, `Transfer-Encoding` and `Sec-WebSocket-*` (subprotocols go in `protocols`). |
  | `bearer` | A token: `Authorization: Bearer <token>`. |
  | `username`, `password` | HTTP Basic: `Authorization: Basic …`. One Authorization only: `bearer`, a Basic login and an `Authorization` header exclude each other. |
  | `query` | `{name: value}`, at most 16: appended to the URL when the dog dials, percent-encoded, never shown. |
  | `hello` | Secret hello messages (a login: Home Assistant's `{"type":"auth","access_token":…}`, Discord's Identify), sent before the dog's own `hello`. |
  | `ca_file`/`ca_pem`, `cert_file`/`cert_pem`, `key_file`/`key_pem` | File only, `wss://` only, as for mqtt: a CA pins trust to it, replacing the Mozilla roots; a client certificate goes with its key. `*_file` paths are relative to the credentials file and stay in its folder. |

- **No error quotes a value:** JSON errors give a line and column, and a header or
  field name is quoted only when it looks like one.
- **The stated limit, as for mqtt:** inline credentials reach the model provider and
  the CLI's own session files, which Orgtree does not rewrite. The file form keeps them
  away from the agent entirely.

### Where secrets never appear

- **Lists, the desktop view and mail:** they say `file: <path>` or `inline credentials
  (stored encrypted)`.
- **The memo:** it keeps `{credentials: {kind: "file", path} | {kind: "inline"}}`
  only.
- **The engine log:**
  - The URL a connection dials (with its credential query) and its upgrade request
    live only in `#[nolog]` code in `src/ws/conn.rs`. The connection logs the URL
    without its query (`Endpoint::base`).
  - tungstenite traces the whole upgrade request, headers included, at trace level. So
    `tungstenite` and `tokio_tungstenite` (and `rumqttc`) lines are dropped by the
    engine's log layer under any `ORGTREE_LOG` (`trace.rs` `silenced`), and turned off
    in the default filter.
  - Key masking covers `credentials`, `authorization`, `cookie`, `token`, `bearer` and
    `x-api-key` at any depth, and a `query` or `headers` object whole (credentials passed
    outside `credentials` by mistake: the refused call is logged on entry). A string under
    those names (a search or GraphQL query) is logged as usual (`trace.rs` `hidden`).
  - Logged strings and transcripts mask the values of secret-named query parameters in
    `ws://`/`wss://` URLs (`util::mask_url_secrets`), as they mask `user:password@`.
- **Transcripts:** `redact_tool_input` replaces every `credentials` value that is no
  file path, at any depth (a fire action's own create included). It blanks `headers`,
  `bearer`, `authorization`, `cookie`, `token`, `query`, `username`, `password`, `user`,
  `pass` and `passwd` (`domain::watchdogs::CREDENTIAL_KEYS`, any case), whatever their
  value, in the call's arguments and in every fire action's, however nested. What a
  send writes or a hello says keeps its own keys (a GraphQL `query`). URL secrets are
  masked in every string of the arguments.
- **Fire actions:** a dog keeps its fire actions' arguments as written, and `list` and
  the desktop show them, so a fire action takes credentials only as a credentials file
  path. Create refuses a fire action that carries inline credentials (a `credentials`
  value that is no file path, anywhere in its arguments), a key that belongs inside
  credentials (in its arguments or a nested fire action's) or a websocket or mqtt target
  with credentials in its URL. The refusal names what it found, never the value
  (`watchdogs::fire_action_secret`; coordinator 2026-10-20).

## Send

```json
{"action":"send","id":"ha-doors","message":{"id":2,"type":"call_service","domain":"light","service":"turn_on"}}
```

- **What it writes:** `message` as one text frame (a string as it is, any other JSON
  value as compact JSON), at most 64 KB. It goes on the dog's live connection after its
  hellos, never interleaved with them.
- **Who:** the dog's owner, or a superior that manages it (`owner/id`, resolved as for
  pause, resume and remove). The caller must hold the `web` tool.
- **When it is refused, with nothing sent:**
  - the dog is not a websocket dog;
  - it is paused (with its reason) or spent;
  - its listener is just starting;
  - its connection is not up (the refusal names the outage);
  - the message is empty or too large.
- **The result:** it returns once the frame is flushed to the socket, with its size and
  time. The server's replies arrive as the dog's fires when they match its pattern.
  Lists show `sent` and `last_sent_at`.
- **What is logged:** the engine logs a send as the dog, its owner, the URL without its
  query and the byte count. The text itself is the agent's own content: the transcript
  keeps it, so the user sees what was sent, and the call log keeps it like any tool
  argument. Secrets belong in `credentials.hello`, which never appears.
- **In `fire_actions`:** a send works there too, as a fixed auto-reply on a fire,
  bounded by `interval_s`.

## Connections (`src/ws`)

- **One connection per dog, never shared:** a WebSocket session is stateful (hello and
  subscribe ids, the messages an agent sends), unlike MQTT's topic multiplexing. A
  paused dog holds no connection; the dog limit caps it at 8 per agent.
- **The task (`conn.rs`)** owns the socket, with commands on a channel (actor style). It:
  - dials TCP, then TLS for `wss://` (tokio-rustls over the engine's rustls + ring, the
    `ClientConfig` mqtt builds, no ALPN), then the HTTP upgrade (tungstenite's client
    handshake), all within 10 s;
  - sends the credentials' hellos, then the dog's, and only then counts as connected;
  - reads frames and runs the dog's regex itself, passing on only matches, each cut to
    the 4 KB a fire shows (with its true size), through a buffer of 256. Past that,
    messages are counted as dropped, so memory stays bounded;
  - writes what `send` and the heartbeat hand it, each within 10 s;
  - lets tungstenite answer the server's pings, sends its own ping after 30 s without a
    frame, and ends the connection as dead after 75 s without one;
  - on exit, sends Close 1001 within a second (the dog paused, removed or spent, or the
    engine stopping).
- **Limits:** a frame or message over 1 MiB resets the connection, like mqtt's packet
  cap, and the error says so.
- **Backoff, shared with mqtt (`mqtt/backoff.rs`), never a tight loop, never giving up
  (user 2026-10-20 09:13Z):**
  - Network errors, a server's Close, a dead connection, HTTP 5xx, and a server that
    ends the stream before it answers the upgrade (a restarting server, or a port
    forwarder whose backend is not up; tungstenite calls it `HandshakeIncomplete`):
    2 s, doubling to 5 min, ±20 % that never passes 5 min. It starts over only after
    the connection has been up 60 s.
  - HTTP 429/503: `Retry-After` (in seconds) is honoured, up to 5 min.
  - Refusals (HTTP 401/403 and other 4xx, a redirect, an unaccepted subprotocol, TLS, a
    bad credentials file): 1 min, then every 5 min (coordinator 2026-10-20 09:24Z; it
    was 1 min growing to 1 h).
  - No dial is the last: the dog dials until it is paused or removed or the engine
    stops, and every connect sends its hellos again.
  - Resuming a dog opens a fresh connection at once.
- **One outage, not many:** a server that accepts the client and drops it within 60 s
  (a login rejected by a Close frame) does not end the outage: its `since` stays.
- **What each failure says:**
  - an HTTP status names itself (`HTTP 404 Not Found: check the URL's path and query`);
  - a Close frame gives its code and the server's reason, escaped, cut to 123 bytes and
    quoted as "the server said";
  - TLS failures name the rustls error.
- **State:** `memo.run.websocket` holds `{state: connecting|connected|down|refused,
  since, error?, retry_at?}`, written on transitions. It feeds the list's `connection`
  and `health` and the desktop card.
- **Alerts** (mail, not fires):
  - a refusal at once;
  - an outage once it has lasted 60 s;
  - "recovered" only after an outage alert, once the connection has stayed up for
    60 s, saying that messages sent meanwhile were missed.

## Fires

- **Mail:** a fire's mail and the rendering the owner's turn reads (`r_wd_fired`, with
  `source: "websocket"`) end their header line with mqtt's tag `(untrusted · see
  EXTERNAL)`, which names the agents' standing EXTERNAL MAIL AUTHORITY passage, where
  the rule lives (user 2026-10-20 09:20Z-09:21Z; it was a long "⚠ UNTRUSTED: …" line).
- **Each message:** a header line `<time>  <N bytes>[ · binary]`, then the text behind
  mqtt's gutter (`    │ `), so no line of it starts at column 0 and none can pose as
  mail framing. Control characters and direction overrides are escaped.
- **Caps:** 4 KB per message and 16 KB or 20 messages per fire, with the true count; a
  cut message says how many bytes it had.
- **Lists:** `last_output` carries the same tag.
- **Desktop:** the transcript draws a fire as the watchdog fire card: the tag as a small
  muted chip in its header, then each message, its text drawn with the tool-call JSON viewer when all of
  it is a JSON object or array (`renderer/src/events/firelines.ts`).
- **Counters:** `checks_run` counts every message received (matching or not), `binary`
  the binary ones, `dropped` what the buffer lost.

## Authority and lifecycle

- **Checks:** the owner's `web` tool, and the containment of a credentials file, are
  checked at create, on every runner start and every 60 s. Losing either pauses the dog
  with the reason.
- **Archive and rehire:** archiving an owner pauses its dogs; rehire re-arms them
  through the generic paths.
- **Engine start:** every start re-arms every armed dog of a live agent
  (`watchdogs::start`, which logs a failed read and tries again, 1 s doubling to 30 s,
  until it works), and each dials at once.
- **Safe start:** SAFE_START never connects (only event dogs re-arm in safe start).
- **Shutdown:** each connection says goodbye with Close 1001.
- **Desktop:** the desktop can pause, resume and remove a dog; only agents create dogs
  and send.

## Limits

- **No proxy.**
- **No client-initiated compression** (permessage-deflate).
- **No dynamic logins:** OBS with a password needs a computed challenge response that a
  fixed hello cannot give, and Slack's socket mode needs an HTTP call for its URL.
- **Messages missed while disconnected are lost:** the dog keeps no session.
- **Redirects are not followed:** the refusal names the status, and the agent re-creates
  the dog with the new URL.

## Crate

- **Nothing new:** `tokio-tungstenite`/`tungstenite` 0.29.0 were already built for
  axum's `ws` feature. The engine depends on `tokio-tungstenite` with default features
  off and `handshake` on (client and server handshakes, no TLS), and on `tokio-rustls`
  0.26 with default features off (no aws-lc).
- **Measured:** `Cargo.lock` gained two lines, both in the engine's own dependency list,
  and no package.

## Tests

- **Rust, against `src/ws/testserver.rs`,** an in-process server on 127.0.0.1 that can
  refuse with a status, require headers, pick or mis-pick a subprotocol, echo, close
  with a code, go silent, and serve TLS with rcgen certificates. The tests cover:
  - hellos in order after every reconnect;
  - headers, bearer, query and subprotocols as the server sees them;
  - send after the hellos, and refused while down;
  - the refusal and network backoffs counted over a window;
  - `Retry-After`;
  - 404 and redirects;
  - a silent server;
  - one outage across instant drops;
  - a server that ends the stream during the upgrade: an outage, not a refusal;
  - 40 failed dials, then the connection and its hellos;
  - binary, 100 KB and over-cap messages, and the buffer overflow;
  - the heartbeat;
  - Close 1001 on drop and unpark;
  - the hub's registration;
  - wss with a pinned CA and a client certificate (and without one, with the public
    roots, and with the wrong name);
  - a kick after a refusal;
  - URL rules;
  - query masking;
  - a verbose log canary covering every credential kind and a refused secret target.
- **Unit tests:** `ws/creds.rs`, `ws/render.rs`, `ws/conn.rs` (dial URL, close text),
  `runtime/watchdogs.rs` (health, fire mail, fields), `runtime/convo.rs` (transcript
  redaction), `runtime/event_text.rs` (the tag) and `tools/defs.rs` (the card).
- **Renderer:** `watchdog-description.test.tsx`, and captures of the card
  (`watchdog-card-visual.tsx`); `watchdogfirecard.test.tsx` and captures of fire cards
  (`watchdogfire-visual.tsx`, `watchdogfire-capture.cjs`).
- **Rig proof:** `tools/rig/proofs/websocket-watchdogs.mjs`, against the debug engine
  with a loopback Node WebSocket server.
