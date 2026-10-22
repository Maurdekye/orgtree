---
name: orgtree-builds-under-the-lock
description: "Coordinate authorized heavy work through concurrency-slot grants, RAM floors and durable waiting."
---

Up: [orgtree-workspace](../SKILL.md)

# Heavy work uses a concurrency-slot permit

This is a development-team practice, not an Orgtree runtime limit or build authorization. A documentation-only assignment may prohibit builds even when a permit is free.

The **current @build-slot project Summary and coordinator assignment are the source of truth** for concurrent capacity, Cargo jobs, RAM floors, containment and how long a low-RAM holder may wait. Read those before each batch; this page deliberately does not repeat their changing numbers. The standing project charter carries its Summary; an authorized `orgtree_project action=settings name=build-slot` with no `settings` argument reads it as `settings.description`, while `action=slots name=build-slot` reports the actual configured capacity and current line. If the policy is missing, inconsistent or unreadable, ask the coordinator for its current text before starting. Full org visibility or a mail audience does not supply project ancestry reach; a sibling audit seat may need a timestamped Summary export. Other holders may run concurrently when current capacity permits; use only your assigned output/target scope.

Read with `action=settings`, never `action=describe`: omitted-description `describe` clears the Summary in 4.4.0-alpha.12 and earlier. See the [project tool warning](../../team/tool-project/SKILL.md#read-the-summary-without-changing-it).

Use only the project's concurrency-slot permit. The filesystem `build.lock`/`build.queue.txt` protocol is retired: do not create, take, hand over or wait on those files. The historical skill path remains for existing links.

The rig's legacy `withBuildLock` export is now only a compatibility callback
wrapper: it returns `{ result, lock }` with informational caller-managed permit
text and propagates callback errors. It performs no file-lock operations,
lease validation, RAM check or process containment. `rig build` relies on the
agent's real lease and external resource checks; invoking the script or setting
an environment variable does not grant a permit. Its retired filesystem-lock
proof refuses with a pointer to focused mock-build controls. Code recipes live
in the repository's docs/rust-engine/test-rig.md and
docs/agents/development-and-verification.md.

## Prepare, claim, batch and release

1. Do light preparation first: source checkout, storage audit, test/fix commits and command/fixture preparation. Confirm this CLI exposes both [slot watchdog creation](../../watchdogs/tool-watchdog/SKILL.md) and the [project release action](../../team/tool-project/SKILL.md). Missing tools require coordinator help or a fresh CLI; documentation seats may intentionally lack them. There is no filesystem fallback and no authority to call a live API around the tools.
2. Claim with `orgtree_watchdog action=create kind=slot target=build-slot name=<assigned work>`. A free permit returns its durable lease inline (`resolved:true`, `registered:false`), with no dog, grant mail or wake; use that result without yielding. Otherwise the one-shot dog holds your place; end the turn or do light work, and await its grant mail. Do not poll or treat queue position as a grant. Before running, verify the lease is still held.
3. Batch the assigned red, green, typecheck and capture work into the grant. Check fresh free RAM before each phase against the **current Summary's floor**. Slot allocation does not check RAM or authorize a build. Follow the Summary's current low-RAM wait/release deadline using a once RAM watchdog; read its smoke result. A reclaimed/released lease needs a new grant before work resumes.
4. Run the assigned batch in the foreground with the **current Summary's Cargo jobs and assigned kernel Job/resource limits**. Keep generated artifacts and cargo targets in the exact per-agent output scope assigned by current org storage policy.
5. Release immediately when the batch ends, including on failure, before reports, mail or unrelated waits: `orgtree_project action=release_slot lease=<granted lease> note=<result and seconds>`. The next waiting claim is granted without a filesystem handover or handover message.

A coordinator-declared priority build is an external team agreement: follow the current priority instructions, including prompt release by other holders. The engine's slot line itself has no priority mode. With watchdogs and no team group, `action=slots` shows the full holders/line status within project reach, but hides other holders' lease IDs. An ancestor with team authority can recover a stuck lease or remove a waiting claim; details are in the project tool guide. A release/reclaim does not stop a holder's process, so confirm its protected work has stopped before a replacement uses the resource.

## Storage, isolation and waiting

The org's current shared storage policy owns output roots, aggregate capacity,
warm-cache protection, authorized cleanup and installer delivery. A permit never
widens that policy or your folder/build scope. Prepare the storage audit before
claiming; do not copy changing capacity numbers into this page or lower notes.

Code-specific test output variables and dependency resolution have one home in
the repository's docs/agents/development-and-verification.md (Portable root test
output and Renderer tests from a worktree without node_modules). Synthetic
fixture/live-root guards and packaged-smoke isolation belong to
docs/rust-engine/test-rig.md. Read the relevant recipe before the assigned check;
those source contracts do not authorize a rig or build phase.

Use [waiting for events](../../watchdogs/waiting-for-events/SKILL.md) instead of polling turns. Keep long work in the foreground, stop idle daemons you own, and never end the turn with your own background children running. Record failures and measured counts honestly after releasing the grant.

For the generic build-machine application, open `orgtree-build-slots` (orgtree-workflows > collaboration-patterns). For the full mutex/semaphore, lease-recovery and other coordination recipes, open `orgtree-concurrency-primitives` in that same section. Those recipes supply mechanics; the live project Summary supplies this machine's policy.

## See also

- [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md)
- [orgtree-tool-project](../../team/tool-project/SKILL.md)
- [orgtree-machine-traps](../machine-traps/SKILL.md)
- [orgtree-waiting-for-events](../../watchdogs/waiting-for-events/SKILL.md)
- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
