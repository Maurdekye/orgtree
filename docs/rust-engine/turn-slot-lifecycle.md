# Turn slots and CLI replacement

Measured diagnosis, 2026-10-07. The concurrency limit is machine-wide across orgs.
`Scheduler` grants a `Slot` for an admitted turn; parked CLIs have no slot and use
the separate warm-process limit. Dropping the slot decrements the held count and
asks the scheduler to admit the next waiter.

## Incident measurements

The engine log's local timestamps were converted to UTC. At 23:59:31.973542Z the
coordinator requested a slot; `on_slot` began at 23:59:31.973691Z, 0.15 ms later.
Scheduler samples at 23:59:36.16–36.18Z reported limit 16, held 11, waiting 0.
The visible org was only part of that machine-wide count.

The actor closed its prior Claude process from 23:59:31.978356Z until
23:59:36.980899Z, then spawned and initialized its replacement. Initialization
completed at 23:59:46.710580Z and the prompt write succeeded. `on_slot` finished
at 23:59:46.713766Z; an untagged `ProcExited` was handled 43 microseconds later.
The actor discarded its current process and ended the turn with a process-exit
error. A second exit notification arrived about 395 ms later.

**Inference:** the first exit belonged to the old process, queued while the
actor initialized the replacement. The old implementation could not establish
which process sent it: it unconditionally dropped the current process. The
timing and source support this explanation; the old log contains no native exit
code or stderr explanation for this event, so that part cannot be measured.

The waiting banner was also stale: `on_wake` published a wait before admission,
but admission was not published until process startup finished, 14.7 seconds
later. There was no measured 16-slot saturation in this incident.

## Repair

- Assign each spawned CLI a unique incarnation and tag stream/exit notifications.
  The actor ignores notifications from a replaced process. This applies to Claude,
  Codex and Antigravity. It does not change tool authorization.
- Publish slot admission before process startup and report the capacity-wait
  banner only while the scheduler is at capacity.
- Release a finished turn's slot before database cleanup. Source inspection
  found an additional leak: cleanup could fail after removing the turn but before
  releasing its slot. This was not established as the incident's cause.
- Log slot grant/release counts and process start/exit identity, reason and OS
  status. Waiting for OS status is bounded; unavailable status is labeled as such.
  Explicit close and termination paths log their observations too.
- Stop selecting a closed control-waiter channel in Claude/Codex stdout readers,
  so a closed channel cannot spin while waiting for stdout EOF.

## Verification scope

A brief smoke probe extracts the actual actor `owns_process`, `on_exit` and
`take_turn` methods into a minimal executable. It checks that an old exit leaves
the replacement and its slot intact, a current exit reports status/reason, a
cleanup failure still releases the slot, and a duplicate exit does nothing.
This is a focused method-level smoke check, not a live provider rehearsal.
Compile verification uses `cargo check`; no live engine or database is changed.
