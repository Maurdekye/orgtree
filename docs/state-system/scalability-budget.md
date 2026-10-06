# Scalability budget: what stops 100 concurrent agents on one engine today

Owner: drag-opus. Docket item: `3-2-0-scalability-budget-what-stops-100-concurre`.
Written 2026-10-06 against `dev` a11fe54 (source) and the running alpha.4 build e1dcffb (data).
No code changes. Every claim is marked **[measured]** (read from a log, the live database or the
OS) or **[inferred]** (read from source, or extrapolated). Inferred numbers are estimates to be
replaced by the load harness in fix R0.

## 1. The situation

- Machine: 16 logical CPUs, 31 GB RAM.
- On 2026-10-06, alpha.4 became unusable with about 13 running agents across two orgs. The user's
  messages timed out with lock timeouts (55P03).
- **[measured]** Engine CPU from 11:10 to 11:49Z (lockup-monitor/samples.log, 409 samples, 5 s apart):
  - median 4.5 cores, p90 11 cores, max 21.8 cores, mean 5.2 cores;
  - engine memory between 0.8 and 1.8 GB.
- **[measured]** Data size, live cluster, read-only:

| org database | size | agent rows (not tombstoned) | live agents | docket items | change rows |
|---|---|---|---|---|---|
| orgtree (orgtree_org_2) | 911 MB | 1,364 (1,280) | about 16 | 1,162 | 1,073,543 |
| the other three orgs | 23-45 MB each | 11-150 | few | 0-30 | under 70,000 |

  The main org holds about **80 times more agent rows than live agents**. Any loop that touches
  "all agents" pays for history, not for the fleet.
- **[measured]** PostgreSQL settings:
  - max_connections = 40, with about 26 in use for 4 orgs: about 5 per org (2 engine, feed, jobs)
    plus 6 for the app database;
  - shared_buffers = 64 MB for a 911 MB database; buffer hit rate 99.2%, so the OS cache is
    covering;
  - fsync on, synchronous_commit on, jit on;
  - lock_timeout and idle_in_transaction_session_timeout are not set server-side.

## 2. Where the time went (alpha.4 only, engine pids 6264 and 32852, 08:26-11:03Z)

Source: jam-diag-20261006-1103/slow-transactions.jsonl and slow-requests.jsonl. These logs record
only SLOW events, so every number below is a lower bound. **[measured]**

### 2.1 Slow transactions

| label | count | total hold | median hold | max hold | total wait | lock width |
|---|---|---|---|---|---|---|
| turn:run | 231 | 651 s | 1.3 s | 71 s | 190 s | 1-2 nodes, shared |
| supervisor._pump_steer | 181 | 462 s | 0.3 s | 45 s | 658 s | 1 node |
| supervisor._auto_resume_org | 82 | 256 s | 1.7 s | 50 s | 10 s | 10 nodes |
| scope_actions.run | 53 | 157 s | 0.4 s | 94 s | 118 s | 2 nodes, shared |
| POST .../steer | 11 | 138 s | 1.7 s | 93 s | 13 s | 1 node |
| tool:orgtree_op_call | 29 | 85 s | 1.3 s | 45 s | 31 s | 1-2 nodes |
| supervisor.reconcile (startup) | 8 | 23 s | 1.1 s | 15 s | 1 s | whole document, 381 nodes |

The locks are narrow, but the holds are long. The time is spent **inside** the open transaction,
not waiting to get in. That is canvas-opus's item `3-2-0-engine-transactions-stay-open-for-10-17-s`.

Before alpha.4, the largest single cost was `_abandoned_docket_recovery_pass`. **[measured]** It
ran about 1,100-2,000 times a day, each run a transaction locking ALL ~1,350 agent rows for a
median of 3.1 s. That is about 3,400 s of hold on 2026-10-06 alone, plus 3,300 s of waiting in
reclaim_orphans behind it. It is fixed by 14ca754 (bounded batch, no all-node lock), which IS in
alpha.4: no alpha.4 pid logged it.

### 2.2 Slow HTTP requests

| route | count | total | median | max | notes |
|---|---|---|---|---|---|
| GET /api/desktop/status | 304 | 1,456 s | 1.95 s | 135 s | polled by every window |
| GET /api/antigravity/usage | 108 | 1,237 s | 5.2 s | 234 s | provider status call |
| POST /api/agent (every MCP tool call) | 263 | 988 s | 1.2 s | 290 s | |
| GET /api/orgs/{slug}/records | 225 | 771 s | 1.95 s | 54 s | |
| GET /api/providers | 157 | 507 s | 1.4 s | 136 s | |
| POST .../steer | 88 | 500 s | 1.3 s | 93 s | |
| GET .../chat | 417 | 484 s | 0.8 s | 14 s | |
| GET /api/accounts/{id}/usage | 174 | 312 s | 1.0 s | 48 s | |

Average in-flight requests: 4-9 when slow. **[inferred]** Slow polled status and usage routes hold
request threads and the GIL while agent work queues behind them.

## 3. Inventory: work that grows with fleet, history or archive size

Source: `dev` a11fe54, read-only. N = live agents, A = all agent rows including archived (about
1,300 in the main org), O = orgs, W = open UI windows, K = signed-in accounts. Costs are per
minute unless noted.

| # | work | trigger | grows with | cost evidence | blocks 100? |
|---|---|---|---|---|---|
| P1 | turn:run, steer pump, scope_actions, tool calls doing work inside open transactions | every turn, steer and tool call | N, multiplied by turn rate | **[measured]** ~0.3 s turn:run hold and ~0.2 s steer hold per running agent per minute (lower bound) | **YES**: lock queues grow faster than linear |
| P2 | per-org keeper `supervisor` loop, 30 s (30615): `policy_context.read(slug)` of the org, `_auto_resume_org` when any node is frozen, `_invariant_sweep_org` | timer, per org | A per org | **[measured]** auto_resume 82 slow runs, median 1.7 s, 10-node locks. **[inferred]** each tick reads the whole agent set | **YES** at history scale, even at N=0 |
| P3 | auto-wake keeper (abandoned docket recovery, idle docket reminder, working lifecycle) | `WORKING_CACHE_POLL_S` timer | archive, A | **[measured]** the all-node version cost about 1 core-equivalent of lock time; fixed (14ca754, 9c7ea1b, 9d51904) | no, once 9d51904 ships |
| P4 | warm-pool keeper, 20 s plus pokes: eligibility, identity snapshot, transcript inventory | timer and every turn end | N times transcript files | **[measured by outage-astra]** repeated native inventory fleet walks; fixed by 411afa6 (not in alpha.4) | partly; ship 411afa6 |
| P5 | per-stream-frame work: record runtime transition, hub send, journal write, tree-cache drop | every output frame of every running agent | N times frame rate | **[inferred]** pure Python under one GIL; forecast compute moved off the loop (918b8e0) | **likely** at 100 streaming agents |
| P6 | polled status and usage routes: desktop/status, providers, antigravity/usage, accounts/{id}/usage, codex/usage | renderer timers | W times K; provider calls and subprocesses | **[measured]** largest slow-request totals, median 1-5 s | **YES** as a co-tenant: they starve the request pool |
| P7 | watchdog engine, 5 s; steer-late sweep, 5 s; MCP health probe, 30 s; transcript capture, 1 s (50 ms when pending); net sender/poller, 1-2 s; usage-warm, 45 s-5 min per account | timers | dogs, N, K | **[inferred]** small each; not costed | unknown; measure in R0 |
| P8 | threads per agent: 2 stdout/stderr pumps per live or parked process, plus 1 steer pump per running turn (20108) | per agent | N | **[inferred]** about 300 threads at N=100; GIL handoff overhead | contributes |
| P9 | PostgreSQL connections: about 5 per org + 6 app, max_connections 40 | per org; per concurrent transaction | O, concurrent transactions | **[measured]** 26 of 40 in use with 4 orgs | **YES** if each concurrent turn transaction needs its own connection (inferred) |
| P10 | startup reconcile (whole document, 381 nodes, up to 15 s) and the restart CPU storm (~6 cores for ~6 min, coordinator 10:55Z) | each restart | A, archive | **[measured]** | not steady state, but every alpha install pays it |

**[inferred]** The engine used several cores at once. A single Python process can only do that
in code that releases the GIL: the psycopg C driver, file-system calls (stat and directory walks,
which show up as kernel time), subprocess I/O. That fits P4 (fleet file walks) and the database
work in P1-P3. The remaining "unexplained native CPU" is most likely there. A native profiler
(py-spy --native, or ETW) in R0 should confirm it.

## 4. Extrapolation to 100 agents

**[inferred, linear and optimistic]**:
- 5.2 cores mean at ~13 agents is about 0.4 core per running agent, so 100 agents would need about
  40 cores. The machine has 16. Even if the shipped fixes (P3, P4) halve it, 100 agents need about
  20 cores.
- Lock hold from P1 alone, at ~0.5 s per agent per minute, is about 50 s of hold per minute at
  N=100, spread over shared rows. Queueing theory says waits grow without bound well before that.
- So with today's build, the limit on this machine is roughly **25-35 concurrent agents** for CPU,
  and lower for lock latency. The P1 and P5 per-agent costs must fall by about 5x to reach 100.

## 5. Ranked fixes (benefit per effort)

| rank | fix | addresses | benefit | effort | lane |
|---|---|---|---|---|---|
| R0 | **Load harness**: N fake agents with a fake provider streaming at a realistic frame rate, on a disposable cluster with the 2026-10-02 livecopy. Measure CPU, GIL, lock waits and p95 request latency at N = 13, 50, 100, with a native profiler. Replaces every [inferred] above. | all | enables everything; finds the real top 3 | medium | new item |
| R1 | **Ship the landed CPU fixes** (9c7ea1b, 9d51904, 411afa6) in the next alpha | P3, P4 | high, already built | low | release owner |
| R2 | **No work inside open transactions**: read and compute before, write after, in turn:run, steer pump, scope_actions, reservation and op_call. Hold target: under 50 ms. | P1 | very high: removes the user-visible timeouts | medium | canvas-opus item |
| R3 | **Single-flight plus a short cache (5-15 s) for polled status and usage routes**. Provider status calls in one background refresher per account, never per request. | P6 | high: frees the request pool and CPU | low | new item |
| R4 | **Make the 30 s per-org keeper incremental**: an indexed query for frozen live nodes instead of reading the whole org; invariant sweep driven by change events or over live rows only | P2 | high at history scale | low-medium | new item |
| R5 | **PostgreSQL settings for the app's cluster**: shared_buffers 512 MB-1 GB, jit off, max_connections sized from pool caps (for example 100), explicit per-process pool caps and a queue | P9 | medium; removes a hard ceiling | low (config); needs the release owner | release owner |
| R6 | **Coalesce per-frame work**: at most one runtime transition and one hub send per agent per 100-250 ms; batch journal writes | P5 | high at N=100 streaming | medium | new item |
| R7 | **Fewer threads per agent**: one reader thread per process with non-blocking I/O, or an asyncio subprocess reader; steer pump driven by events, not a per-turn poll thread | P8 | medium | medium-high | later |
| R8 | **Make history cheap**: archive tombstoned and archived agent rows out of the hot tables (or partial indexes on live rows), so every remaining O(A) path becomes O(N) | P2, P10 | medium-high long term (and needed for 1,000 agents) | high | design item (drag-opus) |

Recommended order: R1 and R3 now (cheap, certain); R0 in parallel; R2 (already staffed); then R4
and R6; R5 at the next release; R7 and R8 for the 1,000-agent target. Even after R1-R6, more than
about 100 agents on one machine probably needs several engine processes, for example one per org
or sharded orgs, because of the single GIL. R0 should test that.

## 6. Open measurements (for R0)

- The cost per tick of P2 (`policy_context.read` and the invariant sweep) on the 1,300-row org.
- Per-frame cost of P5 at a realistic stream rate.
- Whether a running turn holds a PostgreSQL connection for its whole duration (P9).
- Native CPU attribution (kernel file-system time vs psycopg) with a native profiler.
- The intervals of the polled routes per window (renderer timers) and their per-call cost after R3.
