---
name: orgtree-watchdog-panel
description: Explain watchdog detail, events, health, one-shot state and pause or removal controls.
---
Up: [orgtree-desk](../SKILL.md)

# Watchdog panel and chips

A watchdog chip on the canvas or owner's desk opens its detail panel. Desk cards list the owner's current non-spent dogs; a fired one-shot can briefly be a departing tombstone rather than an ordinary active watcher.

Periodic watchers show a ticking timer wherever their chip includes a countdown,
such as `4:08`, `3h 3m` or `1d 3h`, without a "next check in" label. The native
identity tooltip keeps that descriptive wording. Its text stays fixed while
hovered or focused, even as the visible timer ticks; after both pointer and
focus leave, the next hover shows fresh facts. Moving within a chip does not
restart its tooltip. The detail panel's descriptive countdown keeps its wording.

With more than eight watchdogs, the owner has one **X watchdogs** card on the canvas and desk. Click it to open the full list; previous/next controls reach every page without loading the whole inventory. Each individual link retains its kind outline, state, tooltip, detail action and context menu. Monitor event cards for a watcher outside the eight-row preview also stay live links; "(no longer exists)" shows only when the watcher has confirmed spent or removed evidence. Eight or fewer keep their individual cards. This grouping is independent of the desk's jump-card folding preference. Watchdog creation has no per-agent or per-org number cap.

The panel shows owner, kind, target, match pattern when present, fire mode, cadence/quiet period, event count/last fire, health and retained sent-event gists. Long target/pattern text starts expanded and can be collapsed. An event watcher can show its last engine-event data; a stream can show exit status and the note that Resume re-spawns it. An MQTT topic listener shows its broker, topic filter, how it authenticates (a credentials file's path, "inline credentials (stored encrypted)" or none, never the credentials themselves), its payload filter, its connection (connected, connecting, or down/refused with the broker's error in amber; it retries on its own) and its last message. A WebSocket listener shows its server URL, pattern, how it authenticates (as for MQTT), the hello messages it sends after every connect (as the text frames it sends), its subprotocols and heartbeat when it has them, its connection ("refused by the server" with the server's error in amber), how many messages its owner has sent on it and when the last one was, and its last message. Its chip has a violet outline everywhere it appears (canvas, desk, links, mobile), and an armed one shows ⇄ instead of ◉.

State is separate from its name: armed, paused, exited/error or departing information must be read as shown. A one-shot note explains whether it has yet to fire or its spark is traveling before it disappears. A fire proves a configured condition/notification, not that the owner has acted.

The available controls pause, resume or remove. MQTT and WebSocket watchers also have **Connection messages**: **Notice (no wake)** (default, including existing watchers), **Wake**, or **Off**. Saving uses `orgtree_watchdog action=configure connection_messages` and does not reconnect or replay hello. It controls refusal, outage/recovery and WebSocket connect/reconnect mail. Connection mail is administrative: no fire count, one-shot consumption or fire actions. Server data keeps its pattern and original notice/wake delivery. Other definition changes, such as target/pattern, require a new watcher. Closing the panel only closes the view. A watchdog is not an agent seat.

Use `orgtree-tool-watchdog` (orgtree-working › watchdogs) for kinds, action parameters, fire semantics and creation constraints. This panel does not introduce a second watcher policy.

## See also

MQTT detail also shows the owner's sent-message count/time and its publishing
contract: `orgtree_watchdog action=send` with topic and message on the existing
connection, at most64 KB, optional QoS0/1/2 and retain. The panel exposes the same
owner-driven tool path as WebSocket send; it does not dial a second client.

- See `orgtree-tool-watchdog` (orgtree-working › watchdogs).
