# Usage watchdogs (2026-10-18)

Agents can watch measured allowance changes without periodic wake-up mail or
credential-bearing scripts. Create through `orgtree_watchdog`; the desktop
shows exact filters and the existing pause/resume/remove controls. There is
no desktop create form (coordinator correction, 2026-10-18 19:49Z).

```json
{"action":"create","kind":"usage","name":"weekly-budget",
 "accounts":["claude-5"],"windows":["weekly"],
 "usage_events":["above"],"threshold_percent":98,"once":true}
```

`target` defaults to `usage`. Account, window and event arrays are exact OR
filters within each dimension, AND across dimensions; omitted means any.
Each explicit array contains 1–32 nonempty strings, at most 256 bytes each.
Windows match kind, group or display label, allowing provider-named windows
such as `5 h`, `7 d`, `weekly scoped` or a provider group. Inspect cached
usage for actual identifiers; these names are not aliases for one another.

Events: `above`, `below`, `reset`, `limit`, `stale`, `unreadable`, `recovered`,
`account_added`, `account_removed`, `refused`, `frozen`. Above is a crossing
from below N to at least N; below is the reverse. Explicit above/below needs
`threshold_percent` (0–100). Without an event filter all detectable events
apply, but above/below exist only when a threshold is supplied. Limit means a
fresh reported percentage crosses 100%; it does not assert the account cannot
spend extra credits. OpenRouter spend caps use their reported percentage;
uncapped balances and metered API-key spend have no invented percentage.

Current values seed a dog without firing, including an already high value.
An above edge re-arms when the value drops below the threshold or a new reset
epoch starts. A used-value drop or reset timestamp moving later by over five
minutes reports reset; passing a known reset deadline reports it once, with
unknown new usage. Clock checks run within 15 seconds using cache only.
Freshness follows the existing 900-second cache rule. Missing/stale/invalid
numbers never become zero or threshold crossings; last-good comparisons are
retained. A stale or unreadable state emits once, then recovery emits once.
Account lifecycle applies independently of window filters. Revoked scope is
forgotten silently. A missing individual percentage is unreadable, not zero.

Mail carries account, window/group/model, old/new percentage (null when
unknown), threshold, reset and observation timestamps. `interval_s` is the
minimum fire gap (default 60, floor 5); matching edges during it are retained
up to 40 in a pending batch. Once and passive notice use the existing fire
path; pause/remove stop the listener. Explicit resume seeds current cache,
not paused history. Restart keeps the stored comparison and pending batch;
offline observations are not replayed.

No tool gains authority: org allowlists, registry origins and current scope
filter both cached observations and pending delivery. Refusal/freeze notices
also require visibility of the affected agent and use the account captured
at turn admission. They reflect usage limits the runtime detects on a turn;
unknown provider causes and non-usage connection/auth failures are not guessed
as usage. Local language servers have no reported provider allowance.

`kind=event` can match `usage.reading`, `usage.refused`, `usage.frozen` (or
`usage.*`). Those are safe source events; use `kind=usage` for durable per-dog
threshold/reset/freshness/lifecycle edges. No global threshold events are
published, because each dog chooses its own threshold. Observation publication
runs beside usage-history storage; no provider I/O or long transaction is added.

Focused author evidence will be recorded after the red/green batch. No live
account, usage or hierarchy mutation is part of verification.
