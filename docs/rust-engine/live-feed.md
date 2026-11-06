# The live engine feed

A local WebSocket on which the engine publishes its watchdog event catalogue to programs on the same computer (a stream overlay, a dashboard, a bridge). Decision 96 in [DECISIONS](DECISIONS.md); the invariants I1-I4 are in AGENTS.md. Code: `engine/rs/orgtree-engine/src/live_feed/` (`mod.rs` lifecycle, `server.rs` listener and protocol, `tokens.rs` access tokens); the shared authorizer is `events::authorize` in `runtime/watchdogs/events.rs`.

## Endpoint

`ws://127.0.0.1:47830/v1/events`. The port is the setting `live_feed_port` (1024 to 65535, default 47830); the feed is on unless `live_feed_enabled` is turned off (App settings > Runtime > Live feed). It binds the IPv4 literal 127.0.0.1 only, on its own listener (the engine's HTTP port is random and token-gated for the desktop).

Checks before the upgrade, in order: `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (403, DNS-rebinding guard); an `Origin`, when present, must be `null`, `file://...` or an http(s) loopback origin (403); not a WebSocket upgrade 426; at most 32 open connections machine-wide (503); authentication (401, or 404 for an unknown `?org=`). Any other path is 404. Inbound frames are text JSON of at most 4 KiB.

## The three subjects

| Subject | How a connection becomes it | What it sees |
| --- | --- | --- |
| public | no credentials (optionally `?org=<slug>`) | `agents.active` and `agents.live` only, counting every agent (dog owners included, projects never), as `{"count","previous","scope"}`. No names, ids or slugs. |
| agent (token) | `Authorization: Bearer otf_...` or `?token=otf_...`, made in Settings | Exactly what that live agent's own `event` watchdog would see: same events, same payloads, same visibility, alert-turn and own-`cli.*` suppression. Counts exclude the agent itself. |
| agent (dog) | a `websocket` watchdog owned by a live agent whose target is exactly `ws://127.0.0.1:<port>/v1/events` (or `localhost`) | The same as a token, with no credentials: the runner adds an `X-Orgtree-Feed-Agent` header (`<agent_id>.<HMAC-SHA256(boot secret, "<org_id>:<agent_id>:<generation>")>`). The value never enters the dog row, card, mail or log. A project-owned dog gets no header and is public. |

Tokens are SHA-256 hashes in `<data root>/live-feed-tokens.json` (max 128). A token whose agent is not live is refused (401), and a connection closes with 4401 when its token is revoked, its agent retires or halts, or the periodic 60 s check finds the agent gone. Routes (desktop-token authenticated): `GET`/`POST /api/app-settings/live-feed/tokens` and `DELETE .../tokens/{id}`. No orgtree tool creates or reads a token.

## Messages

Every server message is JSON with `v: 1`, `seq` (starts at 1, strictly increases per connection), `ts` (ms, UTC) and `boot` (the engine boot id).

- `{"type":"hello","subject":"public"|"agent","kinds":[...],"event_scope":"all"|"org"|"subtree"}` first on connect and as the ack of every subscribe.
- `{"type":"state","name":"agents.active","payload":{"count","scope"},"reason":"connect"|"subscribe"|"heartbeat"|"resync"}` the current value of a stateful kind (`agents.active`, `agents.live`).
- `{"type":"event","name","payload"}` one authorized event, `name` and `payload` exactly as an event watchdog's fire. An `agents.*` event is sent only when the count differs from the last one sent.
- `{"type":"gap","reason":"overflow"}` the 256-event queue overflowed and events were lost; the newest lost event follows if it is authorized, then a `state` (`resync`) for each subscribed stateful kind.
- `{"type":"heartbeat"}` every 30 s when no stateful kind is subscribed; otherwise the heartbeat is a `state` (`heartbeat`) per stateful kind.
- `{"type":"error","code":"bad_kind"|"needs_token"|"needs_full_visibility"|"bad_message","message"}` the connection stays open.

Client: `{"op":"subscribe","kinds":["turn.*","agents.active"],"event_scope":"subtree"}`. `kinds` replaces the set (exact dotted names, `prefix.*`, or `*`; at most 64); the default is `["agents.active"]`. The public tier serves only `agents.active` and `agents.live`; `agents.*` and `*` expand to those two, anything else is `needs_token`. `event_scope: "org"` needs full organization visibility.

Counts are computed when an event is authorized, from the live busy map, never from a publication-time snapshot, so the last count received is always current. There is no debounce and no replay: events while disconnected are not re-sent, and a reconnect starts with a fresh `hello` and the current state.

## Close codes

1001 feed disabled, engine stopping or server stopped; 1003 binary frame; 1009 frame too big; 1012 port changed; 1011 storage error; 1013 slow consumer (a write took over 10 s); 4401 token revoked, agent not live, retired or halted; 4404 the `?org=` organization is gone.

## Consumer guide

Reconnect with backoff 1 s doubling to 30 s. After a reconnect trust the first `state`. Within a connection `seq` order is delivery order; across connections only the newest socket counts. A consumer that hears nothing for 75 s reconnects.

```python
import asyncio, json, websockets
async def main():
    async for ws in websockets.connect("ws://127.0.0.1:47830/v1/events"):
        try:
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] in ("state", "event") and m["name"] == "agents.active":
                    print(m["payload"]["count"])
        except websockets.ConnectionClosed:
            continue
asyncio.run(main())
```

```js
const WebSocket = require('ws')
const open = () => {
  const ws = new WebSocket('ws://127.0.0.1:47830/v1/events')
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.name === 'agents.active') console.log(m.payload.count) })
  ws.on('close', () => setTimeout(open, 1000))
}
open()
```

An agent watches the feed with a websocket watchdog: `kind: websocket`, `target: ws://127.0.0.1:47830/v1/events`, `hello: [{"op":"subscribe","kinds":["turn.*"]}]`. Its messages still arrive as external (untrusted) input, as for any websocket dog.

## Out of scope for v1

Replacing the stream bridge's watchdog relay, remote or phone access, state-on-connect for kinds other than the two counts, and replay.
