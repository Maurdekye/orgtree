---
name: orgtree-build-slots
description: Share a build machine through concurrency-slot grants, memory watchdogs and immediate release.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# A build machine with concurrency-slot permits

When several agents build on one machine, the coordinator sets the permitted number of concurrent heavy phases. In this organization, @build-slot has **two slots** as of USER 2026-10-18 17:47Z; a slot 2 grant is valid while the RAM floor is met. This supersedes the one-heavy-phase rule and the retired build.lock/build.queue.txt protocol. A project's **concurrency slots** give out that permit without lock files, queue files or handover messages. The slot is a semaphore the builders agree to honour: Orgtree does not stop a build that runs without one, so the recipe works only if every builder claims before each heavy phase and releases right after: Orgtree keeps the line, wakes the next builder and takes the concurrency slot back from a holder that went away.

## Set it up once

1. Create a project for the machine, e.g. `build-machine`, where every builder reaches it: builders must be above or below the project (put them under it, or create it above them).
2. In its Project settings set **Concurrency slots** to the coordinator-authorized count (`2` for @build-slot under the current ruling; `0` means no concurrency slots). Change the count only with authorization and enough machine capacity.
3. Keep the 20-minute checkup ("check on working agents after 20 minutes", Runtime settings) and the project's **Ack timeout** on: they are what takes a concurrency slot back from a builder that went idle without releasing it.

## Tool setup and stale clients

An agent above the project can set its count without the desktop: `orgtree_project action=configure name=build-machine settings={"slots":2}`. Read it with action=settings. Any ancestor (not only the direct superior) can force-release a stuck lease with `action=release_slot lease=L force=true`, or remove a waiting claim with `action=unqueue_slot name=build-machine agent=A`. Ordinary members can release only their own lease.

`orgtree_project` slot release and status need **either team or watchdogs**. With watchdogs on and team off, its card exposes only `action=release_slot` (your own lease, optional note) and `action=slots` (all holders with reasons and ages, the full ordered line and recent holds; other agents' lease IDs are hidden). Project reach and lease ownership still apply. All other project actions and force release require team. Full slot coordination status is available without team, subject to project reach. With both groups off, the project tool is absent and calls are refused. Missing switches still default on; inherited denials still apply.

Before claiming, confirm your current CLI exposes both the slot watchdog kind and orgtree_project release_slot. A running CLI retains its startup tools across app updates; documentation seats may also intentionally lack watchdogs. If either tool is missing, tell the coordinator to enable or refresh it and start no heavy phase. Do not use a filesystem-lock fallback or claim a lease you cannot release. If already stranded, ask an ancestor to force-release it.

## Each heavy phase

Batch the assigned red, green and capture work into one grant. A coordinator-declared priority build overrides normal scheduling: non-priority holders release immediately and follow the coordinator's instructions.

1. **Claim** before the assigned batch starts: `orgtree_watchdog action=create kind=slot target=build-machine name=<what you build>`. The name is shown to everyone as the reason.
   - Free concurrency slot: the result says `claimed a concurrency slot of project build-machine (lease L)` and the dog fires at once. Check memory before starting.
   - Taken: the result says `2nd in line behind …`. End your turn or do light work; the dog wakes you with `You now hold a concurrency slot … (lease L)` when it is yours. Do not poll.
2. **Check memory immediately before each phase:** at least **6 GB free RAM for engine phases; 3 GB otherwise**, including renderer and packaging. Slots do not check memory. If RAM is low after a grant, **keep the slot**, arm one once RAM watchdog for that floor, read its smoke output, and end the turn. Run when it fires and the floor is met; do not release or requeue for low RAM. If the lease is actually reclaimed, obtain a new grant before running.
3. **Run the assigned batch** in the foreground, with its resource/Job limits. Keep Cargo at `-j 2` for Rust work.
4. **Release right after the batch**, before writing reports or mail: `orgtree_project action=release_slot lease=L note="cargo build ok 82s"`. The next builder in line is granted the concurrency slot at once.

If you are halted or retired while holding the concurrency slot it is taken back at once; if you sit idle, the 20-minute checkup reminds you up to the configured Ack reminders count (1–10, default 3) and takes it back at the next checkup. Either way you are told why, and you claim again when you need it.

## Watching the machine

The project desk's second header row contains the yellow held/total count card and the holder cards, without repeating the count as prose. The **slots** tab shows Holding, the line in order with how long each has waited, and recent holds with how each ended (released, idle, halted, forced). Agent entries use shared jump links with model icons. Slots have no displayed number; a lease identifies each hold, while queue ordinals still show waiting order. `orgtree_project action=slots name=build-machine` gives the same as JSON. The project's superior or the user can force-release a stuck concurrency slot or remove someone from the line there.

For what a project is and its other features, see `orgtree-projects` (orgtree-working › team); for the `slot` and `command` watchdogs, `orgtree-tool-watchdog` (orgtree-working › watchdogs); for release and status, `orgtree-tool-project` (orgtree-working › team).

For this organization's resource, storage and isolation rules, open orgtree-working › workspace › orgtree-builds-under-the-lock. The historical skill name does not authorize the retired lock protocol.
