---
name: orgtree-build-slots
description: Share a build machine through concurrency-slot grants, memory watchdogs and immediate release.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# A build machine with concurrency-slot permits

Use a project semaphore when several agents share a build machine. Agents agree to claim before heavy work and release immediately after; Orgtree keeps permits, leases and the line, but does not stop a build run without a grant. The [concurrency recipes](../concurrency-primitives/SKILL.md) hold the exact mutex/semaphore calls, cancellation and ancestor recovery; this page applies them to builds.

## Establish the agreement

An authorized coordinator places all builders above or below a shared project, such as @build-machine, and configures its `slots` to the authorized capacity. Builders beside the project cannot claim it. Prefer insertion above an existing worker team when every builder needs reach; the general recipes show the exact call. Keep the idle-reclaim settings (Runtime working checkups, project ack timeout and reminder budget) consistent with the team's policy.

For this organization's machine, **read the current @build-slot project Summary and coordinator assignment** before claiming. They are authoritative for capacity, Cargo jobs, RAM floors, containment and low-RAM waiting deadlines. This page does not freeze those changing values. Read the standing project charter, or `orgtree_project action=settings name=build-slot` with no `settings` argument when authorized (Summary is `settings.description`); `action=slots name=build-slot` reports actual configured capacity and line status. If you cannot obtain the current policy, ask the coordinator. A grant does not reserve RAM, and another holder may build concurrently when authorized capacity permits.

Read with `action=settings`, never `action=describe`: omitted-description `describe` clears the Summary in 4.4.0-alpha.12 and earlier. The canonical warning and safe read call are in `orgtree-tool-project` (orgtree-working > team).

## Run one assigned batch

1. Prepare the checkout, storage audit, tests/fixes and commands before claiming. Verify this CLI has watchdog `kind=slot` and project `release_slot`; stale startup schemas need a fresh CLI or coordinator help. Never claim a permit you cannot release, invent a lock-file fallback or bypass the tool interface through live APIs.
2. Claim with `orgtree_watchdog action=create kind=slot target=build-slot name=<assigned batch>`. If queued, end the turn; the one-shot dog wakes you with the lease when granted. Do not poll. If granted immediately, retain the returned lease, not a guessed permit number.
3. Check fresh free RAM against the current project Summary immediately before every phase. Follow its current Cargo jobs, Job limit and low-RAM wait/release deadline, using a once RAM watchdog where instructed. If the lease is reclaimed, claim again before work. Capacity alone never authorizes extra work.
4. Run the assigned red/green/typecheck/capture batch in the foreground, in your own assigned build output/target. Release immediately even after failure, before mail or analysis: `orgtree_project action=release_slot lease=<lease> note=<result and seconds>`.

The filesystem build.lock/build.queue.txt protocol is retired. A priority-build announcement is an external team agreement; follow the coordinator's instructions, including release by other holders, rather than expecting an engine priority queue. Check `action=slots` for holders, the ordered line and recent holds. That status is available with watchdogs or team, subject to project reach; ordinary members cannot see other holders' lease IDs. Ancestor force release/line removal require team authority, as the general recipes explain. Recovery changes the agreement, not the old process: ensure protected work has stopped before replacing a holder.

Use `orgtree-builds-under-the-lock` (orgtree-working › workspace) for preparation, storage, synthetic-rig isolation and foreground waiting rules. Its historical name does not authorize the retired lock protocol. The current project Summary, not historical numeric examples in a guide, decides today's machine limits.

Contracts: `orgtree-projects` and `orgtree-tool-project` (orgtree-working › team); `orgtree-tool-watchdog` (orgtree-working › watchdogs).
