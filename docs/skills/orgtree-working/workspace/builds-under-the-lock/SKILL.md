---
name: orgtree-builds-under-the-lock
description: "Coordinate authorized heavy work through concurrency-slot grants, RAM floors and durable waiting."
---

Up: [orgtree-workspace](../SKILL.md)

# Heavy work uses a concurrency-slot permit

This is a development-team practice, not an Orgtree runtime limit or build authorization. Follow the current coordinator assignment before any build, install or test phase. A documentation-only assignment may prohibit all builds even when the machine is free.

The @build-slot project's concurrency slot is the only heavy-phase permit. As of USER 2026-10-18 17:47Z, it has **two slots**: two heavy phases may run at once while RAM allows, including work outside this repository. A grant on slot 2 is valid. This replaces the former one-heavy-phase machine-wide rule. The filesystem build.lock and build.queue.txt protocol is retired: do not create, take, hand over or wait on those files; remove your obsolete lock watchdogs.

## Claim, batch and release

1. Confirm your CLI exposes the [slot watchdog](../../watchdogs/tool-watchdog/SKILL.md) and [project release_slot action](../../team/tool-project/SKILL.md). If either is missing, do not start heavy work: tell the coordinator, who can enable the tool group or refresh the session. Documentation seats may intentionally have watchdogs disabled. There is no filesystem-lock fallback.
2. Claim with `orgtree_watchdog action=create kind=slot target=build-slot name=<assigned work>`. A free slot is granted immediately with its slot number and lease. Otherwise the one-shot claim holds your FIFO place and wakes you when granted. Do light work or end the turn while queued; do not poll or treat a queue entry as a grant. With watchdogs but no team group, project `action=slots` reports only your own holds and queue entries: `held=0` does not prove the project is free.
3. Batch the assigned red, green and capture work into one grant. Check free RAM immediately before starting each phase: **6 GB for engine phases; 3 GB otherwise**, including renderer and packaging. The slot does not check memory for you.
4. If RAM is too low after a grant, **keep the slot**. Arm one once RAM watchdog for your required floor, read its smoke result, and end the turn. Run when it fires and the floor is met. Do not release or requeue merely because RAM is low. If the engine actually reclaims the lease, obtain a new grant before running.
5. Run the assigned work in the foreground, then release immediately with `orgtree_project action=release_slot lease=<granted lease> note=<result and seconds>`, before reports, mail or unrelated work. Orgtree grants the next waiting claim; no filesystem handover or handover message is needed.

A coordinator-declared priority build overrides ordinary scheduling: non-priority holders release immediately and follow the coordinator's priority instructions. Slot possession alone grants no new build or test scope.

## Resource and storage constraints

For Rust work, use Cargo `-j 2` and the kernel Job containment/resource limits assigned to the phase, alongside the RAM floor above. Aggregate generated build artifacts must remain within the team's 100 GB allowance. Cleanup is limited to authorized old inactive generated output after resolved-path and activity checks; protect source, live data, evidence and required deliverables.

All new build artifacts go in the exact assigned scope under `C:/orgtree-build`. Source worktrees remain on D:. The rig's `cargoTarget()` accepts only paths under `C:/orgtree-build/<agent>` on C:, rejects other C: paths, and continues to refuse E:. A source or permit location does not authorize build output there.

Use only the assigned synthetic rig with fake CLI, scratch database and isolated data root. A bare SAFE_START engine can still read live sign-ins and run usage probes; it is not an isolated test environment. Never touch live data to obtain a check result.

## Wait and finish cleanly

Use [waiting for events](../../watchdogs/waiting-for-events/SKILL.md) for one-shot waits rather than polling turns. Keep long work in the foreground, stop idle daemons you own, and do not end the turn with your own background children still running. Record failures and measured counts honestly after releasing the grant.

The skill name and path retain “under the lock” for existing links; the procedure above uses only concurrency slots. For the general setup recipe, open orgtree-workflows › collaboration-patterns › orgtree-build-slots.

## See also

- [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md)
- [orgtree-tool-project](../../team/tool-project/SKILL.md)
- [orgtree-machine-traps](../machine-traps/SKILL.md)
- [orgtree-waiting-for-events](../../watchdogs/waiting-for-events/SKILL.md)
- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
