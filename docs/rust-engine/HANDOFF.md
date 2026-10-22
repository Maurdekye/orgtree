# Orgtree 4: handoff from the rust-engine session to the orgtree org

Written 2026-10-07 by the rust-engine session, which the user has retired: "hand off your work to
the orgtree org, they'll take further development from here" (DECISIONS 45). Read
[PLAN.md](PLAN.md) section 10 and [DECISIONS.md](DECISIONS.md) first; this file only says where
things stood at that handoff. This is dated history, not the current release plan.
For current work, read the assigned checkout's [startup guide](../../AGENTS.md),
[operating-rule homes](../agents/development-and-verification.md#current-operating-rule-homes),
and the current team notes/assignment.

## Where things were on 2026-10-07

- **Branch:** `rust-engine` (local, never pushed). Its checkout is `.worktrees/rust-engine`; it is
  clean and now belongs to the orgtree coordinator, who reviews and merges hand-ins there. Its
  `engine/rs/target` holds a warm release build cache and `node_modules` is a real install (never
  link or copy it).
- **Last delivered build:** `4.0.0-alpha.5`, from commit `2e3f917` (engine stamped with it).
  Installers so far: alpha.0 through alpha.5, delivered as local files only.
- **Committed after alpha.5, not yet in a build:** `e12b3c0`, the PROVIDER USAGE board in every
  turn and Antigravity's sign-in email.

## Work in flight at the handoff

| Item | Owner | Notes |
| --- | --- | --- |
| System prompt matches 3.x minus removed features | drag-opus | `runtime/prompt.rs` `identity()`; keep the D-181 split |
| Per-turn envelope: ORG STATE and MAIL as in 3.x | canvas-opus | `runtime/actor.rs` `turn_context()` already ends with the PROVIDER USAGE block (`usage_block()`); ORG STATE goes before it and MAIL after |

Both change every agent's cached prompt prefix once; that is expected. Ship them together with
`e12b3c0` as the next alpha.

## Imported freeze recovery (resolved in the org hand-in)

The historical report was an imported subscription-limit freeze that stayed frozen
about seven hours past its reset. The original repair landed as `8cc8a77` and
`da10249` on 2026-10-07, before alpha.11. This handoff previously left the report
marked open after that merge.

The original logs showed a display string in `frozen.until`, with the real epoch
deadline in `until_ts`. The old Rust parser returned before scheduling anything.
The shared deadline reader now accepts existing imported records, and both the
3.x and 2.x importers normalize future imports. Recovery schedules overdue and
future freezes; nonverbose logs explain scheduling, blocked wakes and disabled
auto-resume. A stale timer compares the complete freeze record before clearing.

For subscription limits, 3.x's `probe` did not bypass the org's auto-resume
setting. Rust keeps that consent gate and the 60-second reset grace. Pure
connection retries can resume with auto-resume off. A disabled timer rechecks
every 30 seconds, so enabling the setting does not require a restart.

Current verification and its limits: [freeze recovery](freeze-recovery.md).

## Decisions recorded at the handoff

1. Engine CPU priority for 4.0: High (3.x ruling 2026-10-04) or Normal (lowered on 2026-10-06
   because it starved the PC). The boot task asks for High; a desktop-started engine runs Normal.
2. Whether desks still show some transcript entries twice.
3. Agent build caches: on 2026-10-07 drive C: fell to 100 MB free because several agents keep their
   own multi-GB Rust `target` folders in their scratch folders (the caches were cleared once).
   Resolved by the user (2026-10-07 07:56Z): Rust builders in this org set a per-agent
   `CARGO_TARGET_DIR` on E: through team instructions. This E: target rule was superseded
   2026-10-15 by the current team rule: new build artifacts go under the assigned
   `C:/orgtree-build/<agent>` scope; the rig accepts only that C: subtree and continues to
   refuse other C: paths and E:. Remove the app setting and launcher override; already-saved
   values are ignored. See superseded DECISIONS 47.

## The user's sign-off of the 3.x to 4.0 changes

The user keeps a sign-off page (theirs; ask them for it). 35 of 39 items are signed off. The four
"change it" items were done in alpha.5 and need the user to look again: C2 (Antigravity mid-turn
mail through its invocation hooks), C5 (history for every provider from 3.x's transcript store),
I2 (a cheap compact saves the conversation as a file in the agent's folder), I5b (docket reminders
and working checkups restored).

## Build and testing guidance

The original session's [build/testing recipes are retained as history](handoff-build-history.md).
They must not be run as a current procedure. Use the [build workflow](../skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md),
the current project Summary and explicit coordinator assignment. Installer placement
comes from current org policy; the old Downloads instruction grants no exception.

For authorized synthetic tests, use [test-rig isolation and build preparation](test-rig.md#what-keeps-it-safe).
A bare SAFE_START engine is not isolated from real provider credentials. The
current team phase determines whether a rig proof may run at all.

## What changed in the engine on 2026-10-07 (for orientation)

- `accounts.rs`: per-account active switch and gate (DECISIONS 41), cached native-sign-in flag,
  the secondary-account badge (`serving_card`), missing emails read from sign-in folders.
- `runtime/mod.rs`: CLI warming at start and on hire, with the 64-CLI cap and a free-commit-memory
  floor (DECISIONS 42).
- `runtime/convo.rs` and `runtime/actor.rs`: handoff notes and saved history for fresh sessions
  (DECISIONS 43); the cheap compact before a cold turn; the compaction threshold handed to the CLIs;
  cache receipts kept across restarts; the PROVIDER USAGE board.
- `runtime/history.rs`: history import v2 (every provider, 3.x transcript store).
- `runtime/agy.rs` and `bridge.rs`: Antigravity steering hooks (`agy-steer`).
- `openrouter.rs` and `usage.rs`: the 3.x key and favorites carried over; `/api/v1/credits` and the
  3.x credits row; Antigravity's email from its probe log.
- Merged hand-ins: reminders and checkups (canvas-opus), stale limit marks (outage-astra), pop-out
  geometry and sibling order (desk-astra).
