# Transient session-placement losses

The user authorized this bug fix for both 4.3.2 and 4.4.0 on 2026-10-17
(13:42Z, me25f31f2c086). Previously a short hosting-lease loss produced a
sign-out notice followed by a sign-in notice although Windows still reported
the user and helper alive.

## Debounce

The watcher checks every two seconds. `MISSING_CHECKS = 3` is the single loss
threshold. During the first two misses it retains the last signed-in placement;
it neither writes session-placement.json nor announces/notifies a change. A
first good check recovers immediately and clears the miss sequence. A recovered
short loss logs exactly one `suppressed transient session-placement blip` event
with its missed-check count, under the logged observer path.

Overdue timer ticks are skipped. A monotonic spacing guard rejects a burst of
replayed checks, with tolerance for ordinary timer jitter. A confirmed Windows
absence counts as a miss even while an old host lease remains; an unavailable
Windows reading is not treated as proof of sign-out.

The per-engine bridge retains only a placement hint during the debounce.
Queries and turn placement use it, but credentials, pipe operations, host PID
proofs and launches still require their original live authenticated lease. If a
retained host is temporarily unreachable, the unsent turn is deferred rather
than silently launched in Session 0. The launcher returns typed
`session_host::PlacementPending`; the actor returns claimed unsent mail,
retains any on-demand session choice, and schedules its existing bounded
admission-retry timer. This hold does not enter the terminal launch-failure
path. The refusal backoff resets only after process initialization succeeds.
Once the loss is confirmed, normal Session
0 fallback resumes. No authentication or credential lease is extended.

## Read-only evidence

The observed helper's event log shows host registration unavailable at
13:40:14Z, engine-response failure and reattach at 13:40:20Z, then reconnection
to the same engine at 13:40:25Z. The same helper PID regains its hosting lease
at 13:40:25.952Z. Core observations report signed-in, desktop Alive and helper
Alive throughout the transition. Registration requests have a six-second HTTP
timeout; host leases expire after twenty seconds. This supports a delayed
renewal/lease-expiry explanation, with no evidence of a real Windows sign-out.

The watcher drains sixteen overdue observations within about eleven
milliseconds at 13:40:22Z. A state-inspection request finishes in 15,515 ms at
that time. These timings establish overlap and missed-tick replay, but alone
do not prove which work delayed the runtime. Only fixed, secret-free timing and
state markers were retained in derived evidence; no live state was changed.

## Scope-inspection follow-up

Coordinator follow-up at 13:51Z and approval at 13:52Z require debounce first,
then a synthetic measurement, then a contained optimization if warranted.
Inspection currently re-evaluates each node's entire ancestor chain and
normalizes both folder paths for every child-by-ceiling pair, synchronously
on the async worker after the read-only transaction commits. `norm_path` itself
uses only string operations. Verbose logging amplifies each repeated call.

The focused product fixture has 35 agents, a three-node shared ancestor chain,
32 reports and 24 folders per scope. A test-only thread-local counter measures
actual normalization calls independently of a tracing-span counter, so removal
of hot-helper logging cannot masquerade as reduced computation. Timing uses a
span counter without a file logger and must not be presented as reproduction
of the live 15.5-second delay. The follow-up must preserve scope containment,
mode precedence, visibility and cycle/depth/missing-ancestor refusals; no global
cache or lock is authorized.

## Verification

The normal product test binary measured three expected failures before the
fix: premature sign-out, delayed recovery and overdue-tick confirmation.
One transient-miss control passed. Cargo exited 101 without a signal. Author
green verification and normalization counts are recorded with the exact SHA
in the docket; no app build, installation, restart or live fault injection is
part of this verification.
