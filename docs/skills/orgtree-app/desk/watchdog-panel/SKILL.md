---
name: orgtree-watchdog-panel
description: Explain watchdog detail, events, health, one-shot state and pause or removal controls.
---
Up: [orgtree-desk](../SKILL.md)

# Watchdog panel and chips

A watchdog chip on the canvas or owner's desk opens its detail panel. Desk cards list the owner's current non-spent dogs; a fired one-shot can briefly be a departing tombstone rather than an ordinary active watcher.

The panel shows owner, kind, target, match pattern when present, fire mode, cadence/quiet period, event count/last fire, health and retained sent-event gists. Long target/pattern text starts expanded and can be collapsed. An event watcher can show its last engine-event data; a stream can show exit status and the note that Resume re-spawns it. An MQTT topic listener shows its broker, topic filter, how it authenticates (a credentials file's path, "inline credentials (stored encrypted)" or none, never the credentials themselves), its payload filter, its connection (connected, connecting, or down/refused with the broker's error in amber; it retries on its own) and its last message.

State is separate from its name: armed, paused, exited/error or departing information must be read as shown. A one-shot note explains whether it has yet to fire or its spark is traveling before it disappears. A fire proves a configured condition/notification, not that the owner has acted.

The available controls pause, resume or remove. The panel is read-only over the definition: changing target/pattern means creating the appropriate new watcher rather than editing this card. Closing the panel only closes the view. A watchdog is not an agent seat.

Use `orgtree-tool-watchdog` (orgtree-working › watchdogs) for kinds, action parameters, fire semantics and creation constraints. This panel does not introduce a second watcher policy.

## See also

- See `orgtree-tool-watchdog` (orgtree-working › watchdogs).
