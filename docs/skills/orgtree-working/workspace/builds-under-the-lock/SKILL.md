---
name: orgtree-builds-under-the-lock
description: "Coordinate authorized heavy work through the machine queue with bounded resources and durable waiting."
---

Up: [orgtree-workspace](../SKILL.md)

# Heavy work is a shared machine resource

This is a development-team practice, not an Orgtree runtime limit or build authorization. Follow the current coordinator assignment before any build, install or test phase. A documentation-only assignment may prohibit all builds even when the machine is free.

Only one heavy build/check/test/Gradle/Tauri/renderer phase runs machine-wide at a time, including work outside this repository. The team lock is `D:/orgtree-work/cargo-target/build.lock`; its adjacent `build.queue.txt` determines queue order. Hold the lock for the actual phase, then hand it to the next queued owner and notify them. Do not keep it across unrelated idle work or erase an active owner's lock.

The rig's build-lock implementation can take a free lock when the queue permits, recognize a handover, and hand it to the next queued name on exit, including a failed build. Its printed handover requires an org message: the script cannot send that message for you. A marker beginning `MOVED` is not a stale lock to remove. Age alone is not proof that an owner is inactive; check activity before an authorized stale-lock recovery.

## Resource and storage constraints

For current Rust work, use Cargo `-j 2`, at least 3 GB free RAM before starting, and the kernel Job containment/resource limits assigned to that phase. Aggregate generated build artifacts must remain within the team's 100 GB allowance. Cleanup is limited to authorized old inactive generated output after resolved-path and activity checks; protect source, live data, evidence and required deliverables.

The current team ruling puts **all new build artifacts in the exact assigned scope under `C:/orgtree-build`**. Source worktrees remain on D:. The rig's `cargoTarget()` accepts only paths under `C:/orgtree-build/<agent>` on C:, rejects other C: paths, and continues to refuse E:. The lock's D: location does not authorize D: build output.

Use only the assigned synthetic rig with fake CLI, scratch database and isolated data root. A bare SAFE_START engine can still read live sign-ins and run usage probes; it is not an isolated test environment. Never touch live data to obtain a check result.

## Wait and finish cleanly

Wait using one persistent once watchdog under [waiting for events](../../watchdogs/waiting-for-events/SKILL.md), rather than repeated polling turns. Keep long work in the foreground, stop idle daemons you own, and do not end the turn with your own background children still running. Record failures and measured counts honestly, then release or hand over the lock.

## See also

- [orgtree-waiting-for-events](../../watchdogs/waiting-for-events/SKILL.md)
- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
