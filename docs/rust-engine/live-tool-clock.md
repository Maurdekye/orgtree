# Live tool clocks and Codex generation observation

User 2026-10-14 16:40:49UTC requires floor(elapsed) whole seconds while writing,
with ticks on the true elapsed-second boundaries. Completed duration precision
stays unchanged. Docket `in-progress-writing-timers-should-tick-in-whole-s`.

The previous clock formatted elapsed milliseconds with the completed formatter
and ran a 1-second interval from arbitrary component mount time. A component
mounted 200ms into a call consequently showed 1.2s, 2.2s, and so on. The shared
live hook now schedules its next timeout from the observed start timestamp,
recomputes actual elapsed time after delayed callbacks, and shows 0s/1s/2s.
Both writing and executing tool timers share this fix for every harness. Final
observed 1.2s and 200ms clocks still use the unchanged precise formatter.
Changing the start cancels the old timer; inactive execution stops ticking;
missing/invalid observations add no clock. No persisted duration is changed.

Five focused fake-timer cases and before/after dark/light synthetic captures are
prepared for rig-opus's batch, not executed yet. The red uses actual alpha.3
`ae0b5fd` toolclock code: four target failures, one completed-precision control.
Green expects 5/5, then the existing writing/menu/shell regression 16/16 and
root typecheck. Capture fixture fixes the observed elapsed value at 1.2s:
before live clocks show 1.2s, after live clocks show 1s, completed clocks remain
1.2s / 200ms. Captures must be inspected by eye before final acceptance.

## Codex tool-call writing timing investigation

The report initially described assistant text timing. Coordinator corrected
the scope on 2026-10-14 16:42:46UTC: the user means Claude's tool-call generation
timing; do not add a new assistant reply timer. Docket
`codex-agent-transcripts-show-no-writing-timing`.

Current alpha.3 Claude-compatible streams expose tool block starts, input JSON
deltas and stops. `runtime::toolwriting` measures this phase separately from
execution and projects ephemeral live previews. Codex's adapter receives tool
items with already-complete arguments. Its `item/started` → `item/completed`
span is execution, so it cannot stand in for generation. Previous item/turn
elapsed time also includes unrelated work/waits. Historical missing observations
must not receive a fabricated value or backfill.

Installed CLI metadata is Codex 0.160.0. The retained generated protocol schema
lists agent/reasoning text deltas, execution output deltas and MCP progress,
but no generic argument-generation delta notification. This is preliminary
schema/source evidence, not a measured claim that the installed process emits
no generation signal. The upstream source similarly maps dynamic-tool starts
with arguments already present; version-specific evidence still governs:
[OpenAI app-server event handling](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs).

Coordinator explicitly authorized an isolated installed-app-server probe on
2026-10-14 16:47:37UTC, only inside rig-opus's contained batch. The prepared
`tools/rig/proofs/codex-generation-signal.mjs` uses a fake HOME/CODEX_HOME under
the rig's D data root, an environment whitelist, no account/auth variables,
and a synthetic loopback Responses server. A preceding text item finishes,
then a 700ms unrelated gap precedes a deliberately 2.5s streamed function-call
argument span. UTC and monotonic timestamps capture each SSE event and actual
app-server notification. The inert dynamic tool returns a synthetic result;
no real tool, model or live profile is used. Shutdown closes stdin gracefully
first; any required forced tree kill records the owned PID/reason durably
before termination. The process must stop before the proof returns.

The probe is **not run yet**. If it records no per-call generation notification
before the completed arguments arrive, report "not truthfully available" to
the coordinator, with actual names/order/timestamps, and add no product timer.
If it exposes a reliable signal, inspect it and implement only that observed
span. Update this document and the docket description with the actual outcome.
