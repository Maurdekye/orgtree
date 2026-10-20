# Development and verification

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Worktrees, build/resource rules, tests, evidence, platform traps and maintenance.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-43f61695c2e13155"></a>

## Engine tests that require a synthetic PostgreSQL cluster are explicitly

Original section: Unsectioned integration notes. Source lines 125–131.

<!-- preserved:e-43f61695c2e13155 -->
- Engine tests that require a synthetic PostgreSQL cluster are explicitly
  ignored in ordinary `cargo test --bin orgtree-engine`. The docs-opening test
  requires `ORGTREE_OPENING_TEST_PG` and an explicit `--ignored --exact` run
  against a fresh disposable database; it never falls back to an ambient URL.
  Tool-description changes must pass both the pre-split snapshot and startup
  description-budget tests; the aggregate cap stays 12,000 UTF-8 bytes.
  [verified: `http/docs.rs`, `tools/defs.rs`; 2026-10-20]
<!-- /preserved:e-43f61695c2e13155 -->

<a id="e-a3b847c6b17a8585"></a>

## Log canary tests use crate::trace::LogCapture (start, then finish() for

Original section: Unsectioned integration notes. Source lines 185–194.

<!-- preserved:e-a3b847c6b17a8585 -->
- Log canary tests use `crate::trace::LogCapture` (start, then `finish()` for
  the text), never a hand-made `test_sink` + `set_default`. tracing-core trap:
  while exactly one dispatcher is registered, a callsite first hit on another
  thread (a parallel test with no subscriber) caches `never` for every thread,
  so a scoped capture loses lines in parallel runs. LogCapture keeps a no-op
  peer dispatcher registered, serializes captures (they share the verbose
  switch) and returns only once its own last line has been written
  (tracing-appender's WorkerGuard waits about a second). [verified: tracing-core
  0.1.36 `callsite.rs` `dispatchers::rebuilder`; 1 of 3 runs at 8 test threads
  failed before, 10 of 10 passed after; coordinator 2026-10-19 22:04Z]
<!-- /preserved:e-a3b847c6b17a8585 -->

<a id="e-5ae942752b1afc0d"></a>

## Large futures on deep paths are awaited through util::boxed( …), which

Original section: Unsectioned integration notes. Source lines 196–214.

<!-- preserved:e-5ae942752b1afc0d -->
- Large futures on deep paths are awaited through `util::boxed(|| …)`, which
  builds each one in a frame of its own: a debug poll frame keeps two or three
  copies of every future awaited inline, and `Box::pin(call)` still builds the
  future there first. The 2 MiB engine worker stack overflowed in debug builds
  on three such paths: a first Codex turn (`run` → `handle_msg` → `on_slot` →
  `start_turn` → `ensure_proc`: about 1.6 MiB of static frames inline at
  9edbc13, 360 KB boxed), a polled dog's fire action that created a websocket
  dog (`run_fire_actions` boxes its `call_tool`), and a project create through
  the tool path (every arm of `tools::dispatch` and
  `ops::run_in_tx_without_audience_notices` is boxed: 636 KB and 464 KB of
  poll frame inline, 25 KB and 111 KB boxed). Await new large futures on these
  paths (a few KB or more) the same way, never raise stack limits, measure
  frames with `dumpbin /unwindinfo` beside the PDB and run
  `tools/rig/proofs/debug-stack-first-turn.mjs` on the default stack. See
  [stack safety](../../docs/rust-engine/tool-cards.md#stack-safety).
  [verified: `util.rs`, `runtime/{actor,watchdogs}.rs`, `tools/mod.rs`,
  `domain/ops.rs`; debug-stack-first-turn proof red at 9edbc13 and, for the
  tool path, at 1cbaac2, green after; websocket proof's fire action likewise;
  2026-10-19/20]
<!-- /preserved:e-5ae942752b1afc0d -->

<a id="e-280cb9c0e06f1123"></a>

## Exact tracing-event-count tests must isolate process-global callsite caches

Original section: AGENTS.md — working on Orgtree. Source lines 1387–1392.

<!-- preserved:e-280cb9c0e06f1123 -->
- Exact tracing-event-count tests must isolate process-global callsite caches
  from parallel tests. The session-blip regression runs its assertion in one
  exact child test, primes the no-subscriber-first case, then rebuilds interest
  after installing the collector; thread-local subscribers alone do not isolate
  cached interest. Production placement/logging code is unchanged.
  [verified: `runtime/session_watch.rs` tests, tracing-core 0.1.36; 2026-10-18]
<!-- /preserved:e-280cb9c0e06f1123 -->

<a id="e-069864513234d854"></a>

## New hub settings receive stable per-hub IDs on save; the network pass repairs

Original section: AGENTS.md — working on Orgtree. Source lines 1605–1609.

<!-- preserved:e-069864513234d854 -->
- New hub settings receive stable per-hub IDs on save; the network pass repairs
  older missing/empty/duplicate IDs once. Existing valid IDs remain stable;
  the repair compares the old hub array to avoid overwriting concurrent edits.
  Without an ID the registration worker skips the hub even when Test succeeds.
  [verified: `http/settings.rs`, `net.rs`; 2026-10-19]
<!-- /preserved:e-069864513234d854 -->

<a id="e-a12504529fb2c73c"></a>

## This is the one file every agent working in this repository reads first. It collects the

Original section: AGENTS.md — working on Orgtree. Source lines 2722–2727.

<!-- preserved:e-a12504529fb2c73c -->
This is the one file every agent working in this repository reads first. It collects the
design facts, user rulings, architecture and working practices that are otherwise spread
across `docs/`, past agents' notes, tickets and conversations, and it links to the detailed
docs instead of copying them. Codex reads `AGENTS.md`, and Claude Code reads it when the
repository has no `CLAUDE.md`, so **do not add a root `CLAUDE.md`**. [decided: user
2026-10-05]
<!-- /preserved:e-a12504529fb2c73c -->

<a id="e-f76fd81794788f25"></a>

## Orgtree 4.0.0 (Rust engine): read this first

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2736–2736.

<!-- preserved:e-f76fd81794788f25 -->
#### Orgtree 4.0.0 (Rust engine): read this first
<!-- /preserved:e-f76fd81794788f25 -->

<a id="e-4ab1b5bc2121915b"></a>

## The plan is docs/rust-engine/PLAN.md (§10 lists every user-facing

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3699–3702.

<!-- preserved:e-4ab1b5bc2121915b -->
The plan is [`docs/rust-engine/PLAN.md`](../../docs/rust-engine/PLAN.md) (§10 lists every user-facing
difference from 3.x); the user's standing rulings are
[`docs/rust-engine/DECISIONS.md`](../../docs/rust-engine/DECISIONS.md), numbered, and they override the
plan and this file. Read both before you change anything. All entries below: 2026-10-06.
<!-- /preserved:e-4ab1b5bc2121915b -->

<a id="e-29d2ba53942932f8"></a>

## Where and how to work

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3827–3828.

<!-- preserved:e-29d2ba53942932f8 -->
**Where and how to work** [decided: coordinator 2026-10-06, from the rust-engine session's terms;
user, DECISIONS 39]
<!-- /preserved:e-29d2ba53942932f8 -->

<a id="e-9522900dfe5708ae"></a>

## rust-engine is a local branch: it is not on origin. Never push it or anything

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3829–3833.

<!-- preserved:e-9522900dfe5708ae -->
- `rust-engine` is a **local** branch: it is not on `origin`. **Never push** it or anything
  based on it. Make your own worktree from it, e.g.
  `git worktree add -b <you>/<topic> .worktrees/<you>-<topic> rust-engine`.
  `.worktrees/rust-engine` is the branch's own checkout; since the rust-engine session was retired
  (2026-10-07) it belongs to the coordinator, who merges there. [decided: user, DECISIONS 45]
<!-- /preserved:e-9522900dfe5708ae -->

<a id="e-53dd75a0fc1e48e5"></a>

## Hand-in: rebase on the current rust-engine, then send the coordinator your branch name and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3834–3838.

<!-- preserved:e-53dd75a0fc1e48e5 -->
- **Hand-in:** rebase on the current `rust-engine`, then send the coordinator your branch name and
  commit list; the coordinator reviews and merges it. Where 4.0 stands (open bugs, open user
  decisions, how alphas were built): [`docs/rust-engine/HANDOFF.md`](../../docs/rust-engine/HANDOFF.md).
  Bugs in 4.0.0 go the same way (agent, action, expected, actual, UTC time); check PLAN §10
  first, since many differences are deliberate.
<!-- /preserved:e-53dd75a0fc1e48e5 -->

<a id="e-ca02d79ca0ee8a7d"></a>

## Smoke changes through the real path with the test rig, so a hand-in can say measured rather

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3998–4004.

<!-- preserved:e-ca02d79ca0ee8a7d -->
- **Smoke changes through the real path with the test rig**, so a hand-in can say measured rather
  than inferred: `node tools/rig/rig.mjs up` runs your debug engine on a throwaway data root (rig
  mode: fake home, fake CLI, no provider probes), with scripted CLI turns, any `orgtree_*` tool as
  any agent, SQL on the scratch cluster and an offscreen desktop smoke. Prefer it to a bare
  SAFE_START scratch engine, which still reads the real sign-ins and runs the real usage probes.
  How-to: [`docs/rust-engine/test-rig.md`](../../docs/rust-engine/test-rig.md). [verified: 2026-10-07,
  proofs under `tools/rig/proofs/`]
<!-- /preserved:e-ca02d79ca0ee8a7d -->

<a id="e-cd70dd295fff4d67"></a>

## Electron probes: pass URLs and options through the environment, not the command line: with

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4005–4007.

<!-- preserved:e-cd70dd295fff4d67 -->
- **Electron probes:** pass URLs and options through the environment, not the command line: with
  an `http://` argument `electron.exe` exits −1 before the script runs (measured 2026-10-07).
  Clear `ELECTRON_RUN_AS_NODE` first; tool shells inherit it from VS Code.
<!-- /preserved:e-cd70dd295fff4d67 -->

<a id="e-837c7011305e3f2e"></a>

## So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4008–4010.

<!-- preserved:e-837c7011305e3f2e -->
- So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock,
  `test-baseline.mjs`, Python import provenance, `run-python-verification.py`,
  `source-audits.py`.
<!-- /preserved:e-837c7011305e3f2e -->

<a id="e-df30bae43ef1d6bb"></a>

## Still valid from the 3.x sections: Machine traps (shell, CRLF, slow git on

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4027–4030.

<!-- preserved:e-df30bae43ef1d6bb -->
**Still valid from the 3.x sections:** [Machine traps](development-and-verification.md#e-802759bf35d36260) (shell, CRLF, slow git on
E:), the worktree rules (own worktree, no `node_modules` links, no bare `git stash`), "commit
before you mutate", the evidence rules, and the product rulings except where PLAN §10 or
DECISIONS changes them.
<!-- /preserved:e-df30bae43ef1d6bb -->

<a id="e-997232eb4582e84a"></a>

## Keep this file current

Original section: Keep this file current. Source lines 4118–4118.

<!-- preserved:e-997232eb4582e84a -->
#### Keep this file current
<!-- /preserved:e-997232eb4582e84a -->

<a id="e-2f58d475705f7a24"></a>

## Keep entries short. Date each one (UTC) and tag it

Original section: Keep this file current. Source lines 4153–4156.

<!-- preserved:e-2f58d475705f7a24 -->
- Keep entries short. Date each one (UTC) and tag it **[verified: `<file>`]** (you checked
  the source) or **[decided: `<who>` `<date>`]** (a recorded ruling: "user" is the product
  owner, "design" is [`pg-data-model-design.md`](../../docs/state-system/pg-data-model-design.md),
  "coordinator" is the team coordinator). Link the detailed doc.
<!-- /preserved:e-2f58d475705f7a24 -->

<a id="e-6be65c0ba1936e55"></a>

## Describe only what has landed: on rust-engine for 4.0.0, on dev for the 3.x line. Work

Original section: Keep this file current. Source lines 4157–4161.

<!-- preserved:e-6be65c0ba1936e55 -->
- Describe only what has landed: on `rust-engine` for 4.0.0, on `dev` for the 3.x line. Work
  still in review or on a private branch is not current behaviour: its entry goes in the commit
  that ships it. For 4.0.0, a new user decision goes in
  [`docs/rust-engine/DECISIONS.md`](../../docs/rust-engine/DECISIONS.md) first; add a one-line pointer
  here only if agents would otherwise get it wrong. (2026-10-06)
<!-- /preserved:e-6be65c0ba1936e55 -->

<a id="e-7cc5529b5c6b06bf"></a>

## When a rule changes, edit its entry in place and say what it replaced. Dead rules live

Original section: Keep this file current. Source lines 4162–4163.

<!-- preserved:e-7cc5529b5c6b06bf -->
- When a rule changes, edit its entry in place and say what it replaced. Dead rules live
  only in [Removed and dead ideas](legacy-and-superseded.md#e-962161abcd765385).
<!-- /preserved:e-7cc5529b5c6b06bf -->

<a id="e-998c7e96381cb84e"></a>

## Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without

Original section: Keep this file current. Source lines 4164–4165.

<!-- preserved:e-998c7e96381cb84e -->
- Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without
  updating this file is not finished.
<!-- /preserved:e-998c7e96381cb84e -->

<a id="e-2b6fb1f21c689754"></a>

## Agent sessions load this whole file, so keep it dense; long explanations belong in

Original section: Keep this file current. Source lines 4166–4167.

<!-- preserved:e-2b6fb1f21c689754 -->
- Agent sessions load this whole file, so keep it dense; long explanations belong in
  `docs/` with a one-line pointer here.
<!-- /preserved:e-2b6fb1f21c689754 -->

<a id="e-802759bf35d36260"></a>

## Machine traps

Original section: Machine traps. Source lines 5022–5022.

<!-- preserved:e-802759bf35d36260 -->
#### Machine traps
<!-- /preserved:e-802759bf35d36260 -->

<a id="e-e446fc17ae10e2a6"></a>

## Read the authoritative built-in machine traps page

Original section: Machine traps. Source lines 5024–5030.

<!-- preserved:e-e446fc17ae10e2a6 -->
Read the authoritative built-in [machine traps page](../../docs/skills/orgtree-working/workspace/machine-traps/SKILL.md)
before shell or file-edit work on this Windows machine (orgtree-working > workspace
> machine-traps). It owns escaping, CRLF, Git Bash/WSL paths, encodings, Edit-tool
quirks and rerere/mojibake; `docs/machine-traps.md` is a compatibility pointer.
Current build/worktree workflows are linked there; the old Python/P03 recipes
are explicitly historical. [decided: user/coordinator 2026-10-16; verified:
`.gitattributes`, `docs/skills/orgtree-working/workspace/machine-traps/SKILL.md`]
<!-- /preserved:e-e446fc17ae10e2a6 -->
