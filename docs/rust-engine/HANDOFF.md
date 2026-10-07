# Orgtree 4: handoff from the rust-engine session to the orgtree org

Written 2026-10-07 by the rust-engine session, which the user has retired: "hand off your work to
the orgtree org, they'll take further development from here" (DECISIONS 45). Read
[PLAN.md](PLAN.md) section 10 and [DECISIONS.md](DECISIONS.md) first; this file only says where
things stand.

## Where things are

- **Branch:** `rust-engine` (local, never pushed). Its checkout is `.worktrees/rust-engine`; it is
  clean and now belongs to the orgtree coordinator, who reviews and merges hand-ins there. Its
  `engine/rs/target` holds a warm release build cache and `node_modules` is a real install (never
  link or copy it).
- **Last delivered build:** `4.0.0-alpha.5`, from commit `2e3f917` (engine stamped with it).
  Installers so far: alpha.0 through alpha.5, delivered as local files only.
- **Committed after alpha.5, not yet in a build:** `e12b3c0`, the PROVIDER USAGE board in every
  turn and Antigravity's sign-in email.

## Work in flight in the org

| Item | Owner | Notes |
| --- | --- | --- |
| System prompt matches 3.x minus removed features | drag-opus | `runtime/prompt.rs` `identity()`; keep the D-181 split |
| Per-turn envelope: ORG STATE and MAIL as in 3.x | canvas-opus | `runtime/actor.rs` `turn_context()` already ends with the PROVIDER USAGE block (`usage_block()`); ORG STATE goes before it and MAIL after |

Both change every agent's cached prompt prefix once; that is expected. Ship them together with
`e12b3c0` as the next alpha.

## Open bug (reported by maurdekye-works, not yet verified)

A frozen agent (session limit, imported 3.x freeze record with `schedule_kind: probe`) stayed
frozen ~7 h past its wake until a manual unstick. The rust-engine session's first look:

- `runtime::recover` has called `freeze::recover` since the first runtime commit, so "no
  recover call in the logs" of the alpha.0 and alpha.2 runs is most likely verbose logging being
  off (method traces are only written with verbose logging on), not a missing call. Check before
  assuming.
- `freeze::schedule` wakes an overdue freeze at once, but its timer only thaws when the org's
  `auto_resume` is on (`auto_resume_on`); with it off nothing happens and nothing is logged. 3.x's
  `probe` schedule kind looks like it checked the account rather than waiting for auto-resume:
  compare with 3.x before choosing.
- A `Wake` to a frozen agent returns without a turn and without saying why (`Actor::on_wake`);
  the reporters ask for at least a log line.
- `schedule` reads `frozen.until` as RFC 3339; confirm the importer converts 3.x's `until_ts`
  (epoch) for imported freezes.

## Decisions waiting on the user

1. Engine CPU priority for 4.0: High (3.x ruling 2026-10-04) or Normal (lowered on 2026-10-06
   because it starved the PC). The boot task asks for High; a desktop-started engine runs Normal.
2. Whether desks still show some transcript entries twice.
3. Agent build caches: on 2026-10-07 drive C: fell to 100 MB free because several agents keep their
   own multi-GB Rust `target` folders in their scratch folders (the caches were cleared once).
   Resolved by the user (2026-10-07 07:56Z): Rust builders in this org set a per-agent
   `CARGO_TARGET_DIR` on E: through team instructions. Remove the app setting and launcher
   override; already-saved values are ignored. See superseded DECISIONS 47.

## The user's sign-off of the 3.x to 4.0 changes

The user keeps a sign-off page (theirs; ask them for it). 35 of 39 items are signed off. The four
"change it" items were done in alpha.5 and need the user to look again: C2 (Antigravity mid-turn
mail through its invocation hooks), C5 (history for every provider from 3.x's transcript store),
I2 (a cheap compact saves the conversation as a file in the agent's folder), I5b (docket reminders
and working checkups restored).

## Building an alpha (how the rust-engine session did it)

Who builds from now on is the user's call (DECISIONS 37-38 gave it to the rust-engine session);
ask before building. The steps were:

1. Bump the version in `engine/rs/orgtree-engine/Cargo.toml` (and `Cargo.lock`), then in
   `package.json` and both top-level `version` fields of `package-lock.json`; commit the engine
   bump and the app bump separately (`Rust engine: version X`, `Orgtree X`).
2. Announce the build to the org before delivery, so agents commit and end their turns.
3. Build the engine with `ORGTREE_RELEASE_BUILD=1` and `ORGTREE_BUILD_COMMIT=<short sha>` set
   (`cargo build --release` in `engine/rs`); the packaging preflight rejects a dev engine and a
   dirty tree.
4. `npm run package:win` with `ELECTRON_RUN_AS_NODE` cleared; the installer lands in `release/`.
5. Copy `Orgtree Setup X.exe` to the user's Downloads folder and tell the user.

## Testing notes

- A scratch engine on a copy of live data runs with `ORGTREE_ENGINE_SAFE_START=1`: no auto-wake,
  no hub hosting, no reading another data folder's sign-ins, no CLI warming. A fresh root needs
  `ORGTREE_ENGINE_ALLOW_INITDB=1`. Copies of live data follow DECISIONS 40 (own scratch only,
  deleted when done).
- An engine started with an empty `ORGTREE_V2_TOKEN` serves the UI to a plain browser or an
  Electron probe; AGENTS.md has the Electron probe trap (pass URLs through the environment).
- Verbose logging is on by default in development builds and off in packaged ones.

## What changed in the engine on 2026-10-07 (for orientation)

- `accounts.rs`: per-account active switch and gate (DECISIONS 41), cached native-sign-in flag,
  the secondary-account card (`serving_card`), missing emails read from sign-in folders.
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
