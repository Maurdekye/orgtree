# Cold-turn warning and idle CLI replacement

2026-10-07, verified from source and isolated smoke checks.

The coordinator log around 13:31-13:35 UTC showed a reconfiguration followed by
parking the old CLI, then a cold reset at 13:34:11 UTC with 532,189 tokens out of
1,000,000. Three omissions explained the report: actor forecasts never emitted
`will_compact`, the composer did not follow cache expiry, and reconfiguration
only replaced the CLI when another turn began.

## Forecast and reset

`tree::cold_turn_action` is shared by actor admission and the actor/stored
forecast. With automatic reset enabled, measured context at or above the
configured threshold on an eligible existing session yields `will_compact`.
Estimated, already-compacted, absent or below-threshold context does not.
With automatic reset disabled, measured context strictly above 25% yields
`miss_expected`; enabled below-threshold context never uses that red warning.
These gates match the 3.x supervisor's `_cache_precompact_decision` and
`_auto_cheap_context_ready` at 4ddbfb1 (removed 3.x features are excluded).

A compatible receipt carries `precompact_on_expiry`. The composer uses the same
shared age clock and authoritative expiry boundary as the badge, and applies
that verdict once the receipt expires, without a send or an engine event.
Unknown forecasts never become known-cold just because time passed. Existing
mid-turn steer warnings stay conditional on missing the steer window.

Reset clears the persisted receipt and actor receipt/fingerprint, marks context
unmeasured, publishes an unknown forecast and invalidates the agent record
before waiting for the replacement CLI. This prevents the old session's warning
from surviving a reset. A later positive provider receipt establishes a new
forecast normally.

## Idle process replacement

`Actor::replace_idle_process` runs after an idle reconfiguration, or after the
current turn ends if the change arrived mid-turn. It closes the stale CLI and
warms its replacement immediately under the existing keep-warm, safe-start,
memory, eligibility and provider/account guards. When warming is disabled or
cannot proceed, the stale process closes and no pending-restart icon remains.
A process deliberately stopped by the user is not started by reconfiguration.
This restores the idle dirty-process replacement in 3.x `warmpool.py` at 4ddbfb1.
Replacing a local process does not clear a provider receipt or imply a cache miss.

## Verification and limits

- `cargo check -j 2` and desktop `npm run typecheck` pass.
- Isolated Electron runs of the actual `CacheForecastWarning`: base stayed blank
  after expiry; tip warned without a message, then cleared on reset. Prefix-change,
  below-threshold and unfocused-mid-turn controls passed. No network requests.
- Nine controls on the production Rust threshold helper cover the reported
  ratio, inclusive threshold, below threshold, estimated/absent context, held
  agent, and the disabled-setting strict 25% boundary.
- The production idle-replacement helper ran with disposable Windows child
  processes and a small actor harness: idle PID replaced without mail; busy PID
  retained until the end boundary; disabled warming closed without restarting;
  absent process stayed absent; retained receipt unchanged. All children stopped.
- This is a helper/process smoke, not a provider CLI, database or full engine
  end-to-end run. Production call-site wiring and record invalidation are source
  inspected. No live data was changed or provider turn spent.

Local artifacts (gitignored): `artifacts/desk-cold-turn-smoke/`, including before/
after PNGs and JSON results, the Electron fixture and extracted Rust smoke.
