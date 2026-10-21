# Development and verification

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Worktrees, build/resource rules, tests, evidence, platform traps and maintenance.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Renderer, capture and rig traps

- Docket detail tests must account for first-shown-ticket opening on org,
  agent, team and project surfaces (USER 2026-10-21 16:50:46Z, PLAN §10).
  Use `selectDocketRow` for idempotent detail setup and deliberately clear the
  opening selection before testing navigation from an empty reader. Searches
  filter the list while retaining its selected reader. Work fixtures must
  include required detail fields such as `attention_sources`; auto-selection
  exposes incomplete mocks immediately. See `docketselection.fixture.ts`.
  [verified: renderer docket/keyboard/membership suites; 2026-10-21]

Relocated from team standing notes on 2026-10-21. The dates below identify the
original observations; relocation is not a fresh test run. Current assignment,
verification phase and build-project permits still govern what may be run.

- **DOM assertions must report scalars.** The [existing assertion warning](docket-and-presentations.md#e-73f802e8ab8d258b)
  also applies to focus and identity, not just absence. Use
  `assert.equal(document.activeElement === box, true)` and
  `assert.ok(!el.querySelector(selector))`; never hand React-managed elements
  to an assertion. A failing reporter can exhaust memory before later tests
  report anything. After a red run, verify every expected test name appeared;
  the outer summary alone is insufficient. [decided: coordinator 2026-10-21;
  measured: @rig-opus 2026-10-14 round 439; @desk-parity-opus 2026-10-19]
- **Measure the intended text.** `textContent` joins adjacent elements without
  separators, so word-boundary checks can miss a separate `to` span or match
  across elements. Find that span and its `nextElementSibling` instead.
  `range.selectNodeContents(el); range.getClientRects()` includes child
  element border boxes as well as text boxes; its first rect may be a model
  card, not a text line. Walk `NodeFilter.SHOW_TEXT` nodes and measure their
  ranges, excluding a tier-card letter when appropriate. [decided: coordinator
  2026-10-21; measured: @inbox-ui-opus 2026-10-18, projectrecipientcard §4 and
  projectdelivery-visual]
- **Capture after paint, and inspect the image.** Wait two
  `requestAnimationFrame`s plus a short delay before every `capturePage()`.
  Prefer that API to `invalidate()` plus the offscreen `paint` event; passing
  DOM probes can accompany a PNG one state behind. Session 0 was measured at
  1024×768: keep fixtures around 1000×700 unless the current session's actual
  display permits more. A signed-in session has different limits.
  [decided: coordinator 2026-10-21; measured: @rig-opus 2026-10-14 round 439]
- **Mount the whole canvas through its flex stage.** Use
  `.app > main.solo > .canvas-stage > OrgCanvas`, as in
  `apps/desktop/renderer/tests/faroverview-fixture.tsx`. Direct mounting into
  `#root` leaves `.viewport` zero-height and culls cards while overlays/pile
  badges can still satisfy JSON probes. View the PNG.
  [verified: `apps/desktop/renderer/tests/faroverview-fixture.tsx`,
  `retiredpiles.visual.tsx`; measured: @desk-parity-opus 2026-10-20]
- **Pins and surface requests identify the target too.** Per-target Mail,
  Docket, Team, Slots, Listeners, settings, Watchdog, project desks and scoped
  readers use `kind:target` in pins, open markers, window rows and surface
  requests/claims. Tests must use `instanceKind(kind, id)` from
  `apps/desktop/renderer/src/modalkinds.ts`; a bare kind no longer addresses
  that window. Legacy records migrate on first read. The global reader keeps
  its separate scope. [decided: user 2026-10-20, DECISIONS 92;
  verified: `apps/desktop/renderer/src/modalkinds.ts`; 2026-10-21]
- **Observe one engine's own log.** `rig.engineLog()` concatenates session
  files in name order. Once a second engine creates a newer log, the first
  engine's subsequent writes land in the middle: `.slice(offset)` can miss
  real events or vacuously pass a negative check. Select the session file
  whose header contains `engine starting pid=<pid> ` (including the trailing
  space) and track a byte offset in that file.
  [verified: `tools/rig/lib.mjs` engineLogFiles/engineLog;
  measured: @rig-opus 2026-10-15, engine-start-signin proof C]
- **Clear losing timers.** A bare `Promise.race([exited, sleep(ms)])` leaves
  the timeout alive after exit and can retain the process and build permit.
  Clear it in `finally`, following `within()` in
  `tools/rig/proofs/boot-host-stop.mjs` (12-second proof held its permit for
  72 seconds before this correction).
  [verified: `tools/rig/proofs/boot-host-stop.mjs`;
  measured: @rig-opus 2026-10-15]

### Renderer tests from a worktree without node_modules

The current `apps/desktop/renderer/tests/run.mjs` still imports esbuild as ESM;
`NODE_PATH` alone cannot satisfy that import. The team's
`renderer-tests-from-worktree/` adapters supply an explicit esbuild dependency
root and leave source worktrees free of dependency copies/junctions:

1. `node <adapters>/bundle-tests.mjs <worktree> <fresh-output-dir> <dependency-root> <filters...>`
   bundles selected filename substrings with explicit `nodePaths`, matching
   the runner's bundle options. Use an empty output directory in the assigned
   build scope. The helper creates a dependency junction there, never in source.
2. Set `NODE_PATH=<dependency-root>` for the runner's CommonJS `createRequire`
   resolution, then run
   `node --import <adapter-file-URL> <worktree>/apps/desktop/renderer/tests/run.mjs <filters...> --prebuilt <fresh-output-dir>`.
   The URL names `register-loader.mjs`, beside `node-loader.mjs`. Both the
   loader and NODE_PATH are required. On Windows an absolute `--import` needs
   a file URL, such as `file:///C:/build/adapters/register-loader.mjs`, or
   `pathToFileURL(path).href`; a bare drive path fails as protocol `c:`.

Run bundling and tests inside the current build permit and assigned kernel
Job. Preserve the output for evidence/authorized cleanup: never recursively
delete a directory containing that dependency junction yourself. This recipe
was source-checked, not rerun, during the documentation move.
[verified: `apps/desktop/renderer/tests/run.mjs` and team adapters
`bundle-tests.mjs`, `register-loader.mjs`, `node-loader.mjs`; 2026-10-21;
original findings: @project-nodes-opus, @image-embed-luna, @taskbar-orgs-sol
2026-10-16]

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
