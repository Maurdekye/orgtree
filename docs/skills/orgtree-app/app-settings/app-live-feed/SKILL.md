---
name: orgtree-app-live-feed
description: Explain the local live engine feed, its port, its two tiers, access tokens and the websocket-dog recipe.
---

Up: [orgtree-app-settings](../SKILL.md)

# Live feed

Runtime > Live feed publishes the engine's event catalogue on a local WebSocket for programs on this computer (a stream overlay, a dashboard, a bridge). Agents explain and suggest these controls; the user operates them. Both values are stored through `/api/app-settings/runtime`.

| Control | Storage | Built-in default | Effect |
| --- | --- | --- | --- |
| Publish engine events to programs on this computer | `rt:live_feed_enabled` | On | Off closes every open connection (code 1001) and the port. |
| Port | `rt:live_feed_port` | 47830 (1024 to 65535) | A change closes open connections (1012) and rebinds. A port already in use shows as an error status; the engine retries every 30 seconds. |

The feed is `ws://127.0.0.1:<port>/v1/events`. It listens on 127.0.0.1 only and is never reachable from other computers. Without a token a program sees only two name-free counts: how many agents are in a turn (`agents.active`) and how many are live (`agents.live`), counting every agent. With an access token it is bound to one live agent and sees exactly what that agent could watch with an event watchdog: the same event names and payloads, through the same visibility rules. Tokens are made, copied once and revoked in Settings (Access tokens); no agent tool creates or reads one.

## An agent watching the feed

An agent needs no token. A `websocket` watchdog whose target is exactly `ws://127.0.0.1:47830/v1/events` (or `localhost`, your port) is bound to its owner automatically: `{kind: websocket, target: ws://127.0.0.1:47830/v1/events, hello: [{"op":"subscribe","kinds":["turn.*"]}]}`. A project-owned dog gets the counts only. Its messages arrive as external (untrusted) input, like any websocket dog's.

See `orgtree-tool-watchdog` (orgtree-working › watchdogs) for the websocket and event kinds. The consumer guide (messages, close codes, reconnect rule, examples) is `docs/rust-engine/live-feed.md` in the repository.

## See also

- `orgtree-tool-watchdog` (orgtree-working › watchdogs).
