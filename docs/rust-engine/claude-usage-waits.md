# Claude usage waits

Claude usage cards could show `refresh failed: the usage service asked us to
wait 1 s` while still holding a recent reading. HTTP 429 and the cooldown branch
both attached an error to the last-good bars, selecting the renderer's red
available-with-error branch. Treat provider waits separately from real errors.

## Contract

Coordinator approval 2026-10-15 10:09Z: a last-good cache entry younger than
900 seconds and a remaining provider wait at most 60 seconds returns the original
reading without a refresh error. The original `observed_at`, cache instant and
authentication evidence do not move. At exactly 900 seconds it is stale.
Long waits, stale readings and missing readings return `available:false` with
`usage updates paused; next retry in N s`, selecting the existing dim unavailable
branch. No renderer state or error-string matching is introduced.

All Claude readers share a 60-second per-key attempt floor, including desktop
`force=true`, automatic reads and permitted tool reads. Failed attempts count.
A floor hit returns the preceding result; a cooldown hit projects the current
wait against last-good age. Both complete normally over HTTP. Real 401/403 and
other errors keep the existing result/auth processing. Provider waits record no
successful authentication or history reading.

The existing cooldown map remains authoritative. Retry-After normalization is
unchanged (integer seconds, default 60, clamped 1 second through 6 hours).
An expired provider deadline permits one new probe even within the ordinary
60-second floor. The existing scheduler checks pending native and registered
Claude deadlines on its passes. Its nominal tick is 10 seconds plus time spent
on the existing sequential provider work, so this is not a hard retry latency
guarantee. No per-request retry tasks are spawned. A registered retry updates
only that account without refreshing siblings or moving their periodic cadence.

One lock-free reservation still covers HTTP, background and tool readers.
The reservation now has a per-flight notification and a single immutable result.
Same-key Claude desktop callers await that result, including real auth/errors;
unrelated keys remain independent. A cancelled leader drops its reservation and
wakes waiters; they retry admission under the unchanged attempt floor. Cancelling
a waiter does not cancel the leader. Tool `orgtree_usage` retains its existing
explicit `in_progress`/`rate_limited` result instead of queuing a tool request.
All raw result/flight helpers and the scheduler map are excluded from invocation
serialization; no credentials or provider bodies are added to logs.

## Polling audit

The following is **source-derived**, checked at requested base `b77512f`:

| Caller | Baseline provider traffic |
|---|---|
| Native background Claude | Pressure cadence 120 s normally, 120 s from 80%, 45 s from 95%; any open app window caps it at 60 s. Scheduler ticks nominally every 10 s. |
| Registered account background | Every 60 s with an app window open, 300 s without. Ambient native aliases are excluded. |
| Reset catch-up | Native lane can become due after 10 s, at most four rechecks; ordinary cache TTL 30 s may suppress some. |
| Ordinary desktop HTTP | Reuses cache for 30 s; otherwise may probe under the account reservation. |
| Forced desktop HTTP | Bypasses the 30 s cache TTL. No desktop/manual attempt floor in this path. Repeated sequential force calls can each hit the provider. |
| Several concurrent callers | Shared reservation already prevents overlapping same-key I/O; rejected callers got `usage read already in progress` even with valid bars. |
| Several windows | Modern app feed shares engine pushes; windows do not each run a provider poll. Legacy unsupported-feed fallback asks every 60 s but shares engine cache/reservation. |
| Turn envelope board and cached tool reads | Cache-only, zero provider requests. Optional tool refresh separately has a 60 s manual floor. |

The confirmed cause of the red line is response classification. Forced refresh
and reset/pressure schedules are demonstrated sources of unnecessary request
opportunities; the new shared floor closes them. This audit does **not** establish
which caller triggered the screenshot's particular upstream 429 or Anthropic's
undocumented limiter. No live provider sampling or account/auth files were used.

## Verification

Baseline tests were written and committed **before** product edits as `7bd8ef4`
on `b77512f`. Rig-sol-b executed all five under Job containment, cargo-j2 and the
shared FIFO lock. Direct raw receipt inspection: two controls passed and three
expected assertions failed (recent wait had an error, stale and long waits
remained available). Zero ignored tests; exit 101 in 69 seconds. Earlier run
interrupted by an engine restart is excluded from evidence.

The candidate adds tests for first-429/cooldown projection, exact 60/900-second
boundaries, floor/cooldown/retry admission counts, sibling isolation, recovery,
concurrent result sharing, and cancellation. Expected synthetic counts are
12 mixed sequential admissions -> 3 probes at 0/60/120 s; 17 concurrent readers
-> 1 result-producing closure; 100 cache peek/snapshot pairs -> 0 extra probes.
These exercise production reservation/admission/projection functions without
network, credentials, provider CLIs or a database. Candidate execution is pending
rig verification; these expected counts are not yet measured green claims.

Recipe: from `engine/rs`, run `cargo test --offline --locked -j 2 -p
orgtree-engine --bin orgtree-engine usage:: -- --nocapture` under rig-sol-b's
normal Job/FIFO/RAM guards. This includes original red tests and nearby auth,
query-floor and other usage controls. No app build, install or push is authorized.
