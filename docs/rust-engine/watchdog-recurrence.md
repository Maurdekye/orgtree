# Watchdog schedules across engine restarts

Periodic watchdog clocks retain their original recurrence across a restart
(user 2026-10-17 14:46Z/14:48Z). Last check/fire timestamps remain actual
observations; persisted next deadlines carry the recurrence separately.

## Recurrence and recovery

Migration 0027 adds `next_check_at` and `next_silence_at` to each watchdog.
It does not rewrite last-check/fire evidence. Existing polling dogs derive
initial next slots from their actual last check; a never-run dog is due from
creation. Silence deadlines derive from their saved quiet reference.

File, command and process runners wait for the saved deadline before their
first recovered check. A passed deadline runs one check immediately, skips
all missed slots in constant time, and saves the first original slot strictly
in the future. Work duration and an early check for silence do not shift the
poll recurrence. A six-hour dog last checked at h0, stopped at h5 and restored
at h7 runs once at h7 and next at h12, not h13. Restoring it again at h8 still
leaves h12 as the next deadline.

A poll records its actual completion and its next slot together. The desktop
record group is refreshed when that deadline changes. Countdown rows consume
the saved deadline and show `checking...` when overdue until real progress
arrives; they do not invent a later successful check. Old snapshots without
the new fields retain their previous fallback display.

## Silence and event semantics

An overdue polling-silence dog checks its target **before** deciding that it
went quiet. A current match resets the reference and next quiet deadline and
suppresses the overdue alarm (coordinator 14:50Z). This preserves the existing
protection against false quiet mail. Without a match, one quiet fire advances
to the next original quiet slot; many missed periods never create a backlog.
The actual `last_fired` and `silence_since` evidence is still the time the fire
happened; `next_silence_at` independently keeps the recurrence phase.

Matching stream/activity/engine events still reset the quiet clock. Quiet
fires advance its fixed deadline, including after a stream has exited.
Buffered stream matches cannot overwrite a newer committed quiet fire.
Ordinary event-mode stream and activity min-gaps are unchanged. A process
runner still fires only on an observed UP-to-definitively-DOWN edge: a missed
poll slot is an opportunity to observe, not an invented process-down event.

An in-process runner storage error retains its existing backoff and retry
probe even when the previous progress write already saved a future slot.
This retry is distinct from ordinary engine restart and does not move the
saved future recurrence.

Creation keeps its smoke and immediate initial poll. Explicit resume (including
rehire of archive-paused dogs) begins a **new** recurrence and resets the quiet
reference; an ordinary engine restart does neither. The watchdog tool has no
interval-edit action: remove/recreate starts a new dog with the new interval.
Pause/remove and one-shot spending retain their behavior.

## Verification and limits

Red checkpoint 94f1cc8 executed six deterministic engine timing cases (five
intended failures plus an exact-boundary control) and four countdown cases
(three intended failures plus an event-kind control). The user h7/h12 example
exposed the old h13 result. Save the raw red/green receipts with each hand-in.

`tools/rig/proofs/watchdog-recurrence.mjs` runs real scratch-engine restarts
with backdated timestamp fixtures rather than waiting six hours. It exercises
legacy-shaped migration data, future deadlines, one catch-up, missed periods,
quiet match suppression, one-shots, process edges, both projections, a second
restart and explicit resume. It uses fake providers and a disposable D: data
root. A prepared proof is not a measured pass; the docket records its results.
