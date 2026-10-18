---
name: orgtree-build-slots
description: Share a build machine through a project's concurrency slots - one concurrency slot, claim with a slot watchdog before a heavy phase, your own memory watchdog, release right after.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# A build machine as a project concurrency slot

When several agents build on one machine, only one heavy build, test or packaging phase should run at a time. A project's **concurrency slots** give out that permit without lock files, queue files or handover messages: Orgtree keeps the line, wakes the next builder and takes the concurrency slot back from a holder that went away.

## Set it up once

1. Create a project for the machine, e.g. `build-machine`, where every builder reaches it: builders must be above or below the project (put them under it, or create it above them).
2. In its Project settings set **Concurrency slots** to `1` (0 means no concurrency slots). Raise it only if the machine can really run that many heavy phases at once.
3. Keep the 20-minute checkup ("check on working agents after 20 minutes", Runtime settings) and the project's **Ack timeout** on: they are what takes a concurrency slot back from a builder that went idle without releasing it.

## Tool setup and stale clients

An agent above the project can set its count without the desktop: `orgtree_project action=configure name=build-machine settings={"slots":1}`. Read it with action=settings. Any ancestor (not only the direct superior) can force-release a stuck lease with `action=release_slot lease=L force=true`, or remove a waiting claim with `action=unqueue_slot name=build-machine agent=A`. Ordinary members can release only their own lease.

`orgtree_project` slot release and status need **either team or watchdogs**. With watchdogs on and team off, its card exposes only `action=release_slot` (your own lease, optional note) and `action=slots` (your own holds, line entries and history, marked `own_only`; `held` counts your holds). Project reach and lease ownership still apply. All other project actions, full slot status and force release require team. With both groups off, the project tool is absent and calls are refused. Missing switches still default on; inherited denials still apply.

Before claiming, confirm your current CLI exposes both the slot watchdog kind and orgtree_project release_slot. A running CLI retains its startup tools across app updates. If either is missing, start a fresh CLI or use the coordinator-authorized fallback lock protocol; do not claim a lease you cannot release. If already stranded, ask an ancestor to force-release it.

## Each heavy phase

1. **Claim** before the phase starts: `orgtree_watchdog action=create kind=slot target=build-machine name=<what you build>`. The name is shown to everyone as the reason.
   - Free concurrency slot: the result says `claimed concurrency slot 1 of project build-machine (lease L)` and the dog fires at once. Start.
   - Taken: the result says `2nd in line behind …`. End your turn or do light work; the dog wakes you with `You now hold concurrency slot 1 … (lease L)` when it is yours. Do not poll.
2. **Check memory yourself.** Concurrency slots do not look at free RAM. If the machine is short (say under 3 GB free), wait on your own one-shot memory watchdog (a `command` dog that prints free memory, with a pattern for enough). The concurrency slot may be taken back from you while you wait; claim again once memory is free rather than holding the concurrency slot idle.
3. **Run the phase** in the foreground.
4. **Release right after the phase**, before writing reports or mail: `orgtree_project action=release_slot lease=L note="cargo build ok 82s"`. The next builder in line is granted the concurrency slot at once.

If you are halted or retired while holding the concurrency slot it is taken back at once; if you sit idle, the 20-minute checkup reminds you up to the configured Ack reminders count (1–10, default 3) and takes it back at the next checkup. Either way you are told why, and you claim again when you need it.

## Watching the machine

The project desk's **Concurrency slots** tab leads with "1 of 1 concurrency slot held" and the holder, then the line in order with how long each has waited, and the last holds with how each ended (released, idle, halted, forced). `orgtree_project action=slots name=build-machine` gives the same as JSON. The project's superior or the user can force-release a stuck concurrency slot or remove someone from the line there.

For what a project is and its other features, see `orgtree-projects` (orgtree-working › team); for the `slot` and `command` watchdogs, `orgtree-tool-watchdog` (orgtree-working › watchdogs); for release and status, `orgtree-tool-project` (orgtree-working › team).
