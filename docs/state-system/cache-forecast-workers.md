# Cache forecast workers

The record overlay retains `cache_forecast` alongside revisioned body inputs.
Snapshot workers compute changed bodies' forecasts after releasing their database
snapshot. Adoption, cheap supervisor sampling and sequence stamps stay on the
host event loop without an intervening await. A baseline therefore contains the
forecast without computing a process manifest on the loop.

Named transitions compare a cheap turn signature (busy, captured attempt time,
attempt session). Unchanged stream frames and unnamed hub transitions only sample
cheap fields. Body adoption, turn edges, model changes and receipt expiry invalidate
forecasts. A 60-second worker refresh also covers startup-file changes that have no
org revision. Archived agents never compute a forecast.
The file-refresh timer stops when no live agents are retained and resumes on live adoption.

Each host runs one background forecast task. Marks coalesce into a pending set;
marks during a run produce one follow-up batch. Results must match the overlay
object, retained membership and per-key generation. Adoption and removal advance
generations too. Snapshot reads capture generations before leaving the loop;
an intervening mark prevents an older snapshot forecast replacing a newer value
and schedules another computation. Existing cursor, gap and retired-identity
checks also cover the worker's forecasts. Close cancels publication and timers
without waiting for the thread to finish.

## Why a warm process does not answer the current forecast

Source investigation, 2026-10-05: `warmpool.identity_snapshot` and
`supervisor._codex_startup_manifest` share prepared launch inputs within a spawn.
That manifest describes the process at launch. A later move, retool, account change
or startup-file edit can change current inputs. Reusing an old prepared spec without
checking those inputs would hide precisely the prefix changes the forecast reports.
The record worker computes the current projection; local process warmth and provider
cache compatibility remain separate facts.

`warmpool._prewarm_node` checks the agent under an `org_tx` before spawning and again
before parking. `orgdb.graph.install_plan` rejects a scope path that changed while
locks were acquired. `orgtx._attempts` retries pre-body serialization failures up to
five times, rebuilding the plan with backoff. A transaction diagnostic for one such
failure alone does **not** prove retries were exhausted. If exhaustion escapes before
spawn, no process starts; if it escapes at the parking check, the unparked process is
reaped in `finally`. The exception escapes `_keeper_pass`, aborting the remaining
seats in that pass; the keeper catches it and can try again on a later poke/full pass.
Moves can also invalidate and replace an already parked process legitimately.
These are source-verified ways moves can delay readiness, not a measurement that
every reported live warming failure had the same cause. This change does not alter
warm-pool retry or process ownership rules.

Account resolution from the worker uses `registry.get_account` →
`orgdb.accounts.find`, whose connection path uses the org registry pool or app pool.
Existing tree/detail handlers run synchronously in FastAPI workers; foreground
tree handlers use `_run_ui_read`. Record transitions now perform no forecast or
account lookup on the event loop.
