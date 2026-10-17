# Idle age after a completed turn

The desk, canvas card and tray measure idle age from the most recent turn's
completion. Their shared `TurnStat.at` comes from the ledger's `ended_at`,
including killed turns. An open or legacy row without an end retains the
existing `started_at` fallback; a row without either timestamp stays unknown.
Accounting fields, duration and turn order are unchanged.

The shared projection previously always used `started_at`. A turn starting at
15:00 and finishing at 15:12:30 therefore showed 12m30s of idle time immediately
after completion. It now begins its idle clock at 15:12:30.

## Harness paths and evidence limits

Antigravity's `on_agy` result handler already calls `Actor::end_turn`, which
writes `ot.turns.ended_at = now()`. Claude, Codex, Muse and ACP results reach
the same writer. The bounded feed query fetches both timestamps, and
`domain::tree::turn_stat` produces the same renderer record for every harness.
No provider-specific idle reference or later last-activity override was found.

The coordinator approved correcting this shared projection on 2026-10-17
17:33Z after the Antigravity report. The reported Claude/Codex difference
cannot be established from source alone. Both legacy importers write the old
completion timestamp into both columns, so imported turns mask the defect;
short turns can also make the difference less visible. These are possible
explanations, not findings about the user's live agents. No live data was read
for this fix.

## Active time and mid-turn mail

Active clocks use `inflight_at`, set at turn admission, rather than
`TurnStat.at`. Ordinary Antigravity mail uses invocation-hook `injectSteps`
and optional `force_continue`; `commit_agy_steer` acknowledges it within the
existing turn. It does not change admission or restart the active clock.
An explicit interrupt followed by another turn is a separate operation.

## Focused verification

The normal product test binary exercises the actual shared projection with
completed ledger/accounting shapes for Antigravity, Claude, Codex, Muse and
ACP, plus killed-turn metadata and open/legacy/imported controls. Before the
fix, all six completion checks failed with the start timestamp while the two
fallback controls passed (Cargo 101, no signal). These are projection tests,
not real-provider or end-to-end harness runs. Exact green results and SHA are
recorded in docket `antigravity-agents-idle-timer-counts-from-turn-s`.
