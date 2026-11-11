# Hub stream in the engine's poller

Docket: `mail-hub-websocket-for-new-mail-clients-prefer-i`. Spec:
`spec-hub-websocket.md` sections 9 and 14 (Mail hub project). Code:
`engine/rs/orgtree-engine/src/net/stream.rs` (the `Carrier`) and the poller
loop in `net.rs`. Proof: `net/stream_tests.rs` (E1 to E5, a scripted fake hub
speaking `/healthz` and the WebSocket on one port).

## What changes

Each poller (one per hub address) owns one `Carrier`. For every poll it asks
the carrier first: when the hub's `/healthz` lists `stream` (Mail hub 2.5.0),
the poll goes over one WebSocket (`GET /api/stream`, subprotocol
`orgtree-hub-stream.1`) and the carrier returns the hub's status and JSON
body; otherwise it answers "HTTP" and the poller runs the unchanged
`POST /api/poll?wait=` long poll. The answer then goes through the same code:
the same 401 handling (mark unregistered, register again), the same delivery,
the same ack. Delivery and ack semantics are unchanged: mail stays queued
until `/api/ack`, and a repeat after a reconnect is stored once. Only the
poll moves to the stream; register, send, ack, receipts and the rest stay
HTTP. Dropping the poller (its members changed) closes the stream.

## Choosing and falling back

- Probe `GET /healthz` at poller start (5 s timeout). No `stream` feature:
  long poll, re-probed when an answer's version differs and every 30 min.
- Handshake or welcome failure (non-101, TLS/connect failure, nothing within
  10 s, a close before the welcome): long poll, next stream attempt after 1,
  5, 15, then every 60 minutes; reset after any open stream. 503: retry after
  30 s. A 403 with an empty body (a downgraded hub) re-probes at once.
- 4429 after the hello: 15 min. 1009 or 4400: long poll until the engine
  restarts (logged as a bug).
- A stream that drops after opening reconnects after 0.5 to 1.5 s, then 2, 4,
  8, 16, 30 s (cap), jittered. Three sessions in a row ending within 30 s of
  their welcome without an answer count as unusable.
- 401 at the handshake or a 4401 close is treated as an HTTP 401 (the poller
  marks the org unregistered and re-registers); a second in a row falls back
  to the long poll.
- Switching happens only between requests; the unanswered request is asked
  again with the same queue.

## Secrecy and scope

- Native client: no `Origin` header; credentials go in the `X-Org-Auth`
  upgrade header and the hello carries no `auth`. The stream uses a direct
  connection with the default TLS roots, no proxy retry (the long poll keeps
  its own) and no redirects. The secret is never logged.
- `Carrier::poll` is `#[nolog]` so its arguments (the auth header) are never
  logged by the engine's `#[logged]` machinery.

## Verification limits

The tests use a scripted fake hub only. They do not run a real Mail hub
2.5.0, a proxy, a TLS stream against a real certificate, or a packaged app.
The test binary needs `CARGO_INCREMENTAL=0` to compile inside the 8 GiB Job.
