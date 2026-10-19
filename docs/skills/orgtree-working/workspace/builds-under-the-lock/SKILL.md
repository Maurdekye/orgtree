---
name: orgtree-builds-under-the-lock
description: "Coordinate authorized heavy work through concurrency-slot grants, RAM floors and durable waiting."
---

Up: [orgtree-workspace](../SKILL.md)

# Heavy work uses a concurrency-slot permit

This is a development-team practice, not an Orgtree runtime limit or build authorization. A documentation-only assignment may prohibit builds even when a permit is free.

The **current @build-slot project Summary and coordinator assignment are the source of truth** for concurrent capacity, Cargo jobs, RAM floors, containment and how long a low-RAM holder may wait. Read those before each batch; this page deliberately does not repeat their changing numbers. The standing project charter carries its Summary; an authorized `orgtree_project action=settings name=build-slot` with no `settings` argument reads it as `settings.description`, while `action=slots name=build-slot` reports the actual configured capacity and current line. If the policy is missing, inconsistent or unreadable, ask the coordinator before starting. Other holders may run concurrently when current capacity permits; use only your assigned output/target scope.

Read with `action=settings`, never `action=describe`: omitted-description `describe` clears the Summary in 4.4.0-alpha.12 and earlier. See the [project tool warning](../../team/tool-project/SKILL.md#read-the-summary-without-changing-it).

Use only the project's concurrency-slot permit. The filesystem `build.lock`/`build.queue.txt` protocol is retired: do not create, take, hand over or wait on those files. The historical skill path remains for existing links.

## Prepare, claim, batch and release

1. Do light preparation first: source checkout, storage audit, test/fix commits and command/fixture preparation. Confirm this CLI exposes both [slot watchdog creation](../../watchdogs/tool-watchdog/SKILL.md) and the [project release action](../../team/tool-project/SKILL.md). Missing tools require coordinator help or a fresh CLI; documentation seats may intentionally lack them. There is no filesystem fallback and no authority to call a live API around the tools.
2. Claim with `orgtree_watchdog action=create kind=slot target=build-slot name=<assigned work>`. A free permit returns a lease and fires immediately. Otherwise the one-shot dog holds your place; end the turn or do light work, and await its grant mail. Do not poll or treat queue position as a grant. Before running, verify the lease is still held.
3. Batch the assigned red, green, typecheck and capture work into the grant. Check fresh free RAM before each phase against the **current Summary's floor**. Slot allocation does not check RAM or authorize a build. Follow the Summary's current low-RAM wait/release deadline using a once RAM watchdog; read its smoke result. A reclaimed/released lease needs a new grant before work resumes.
4. Run the assigned batch in the foreground with the **current Summary's Cargo jobs and assigned kernel Job/resource limits**. Keep all generated artifacts under your exact assigned `C:/orgtree-build/<you>` scope; other holders use their own targets.
5. Release immediately when the batch ends, including on failure, before reports, mail or unrelated waits: `orgtree_project action=release_slot lease=<granted lease> note=<result and seconds>`. The next waiting claim is granted without a filesystem handover or handover message.

A coordinator-declared priority build is an external team agreement: follow the current priority instructions, including prompt release by other holders. The engine's slot line itself has no priority mode. With watchdogs and no team group, `action=slots` shows the full holders/line status within project reach, but hides other holders' lease IDs. An ancestor with team authority can recover a stuck lease or remove a waiting claim; details are in the project tool guide. A release/reclaim does not stop a holder's process, so confirm its protected work has stopped before a replacement uses the resource.

## Storage, isolation and waiting

Follow the current team storage cap. Cleanup needs authorization plus resolved-path/activity checks; protect source, live data, evidence and required deliverables. Source worktrees remain on D:, separate from generated output. A permit never widens build, storage or folder scope.

Use only the assigned synthetic rig with fake CLI, scratch database and isolated data root. A bare SAFE_START engine can still read live sign-ins and run usage probes; it is not an isolated test environment. Never touch live data to obtain a test result.

Use [waiting for events](../../watchdogs/waiting-for-events/SKILL.md) instead of polling turns. Keep long work in the foreground, stop idle daemons you own, and never end the turn with your own background children running. Record failures and measured counts honestly after releasing the grant.

For the generic build-machine application, open `orgtree-build-slots` (orgtree-workflows > collaboration-patterns). For the full mutex/semaphore, lease-recovery and other coordination recipes, open `orgtree-concurrency-primitives` in that same section. Those recipes supply mechanics; the live project Summary supplies this machine's policy.

## See also

- [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md)
- [orgtree-tool-project](../../team/tool-project/SKILL.md)
- [orgtree-machine-traps](../machine-traps/SKILL.md)
- [orgtree-waiting-for-events](../../watchdogs/waiting-for-events/SKILL.md)
- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
