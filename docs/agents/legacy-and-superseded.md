# Legacy and superseded records

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

3.x implementation/procedures, stopped work, historical states and earlier guidance.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

**Historical scope.** Do not run stopped Python/P03 procedures or revive dead work because an old record describes them. Product rulings still apply where the current Rust decisions preserve them.

<a id="e-de9dba5c10b37700"></a>

## Since 2026-10-06 the app runs Orgtree 4.0.0, a Rust engine, built on the local branch

Original section: AGENTS.md — working on Orgtree. Source lines 2729–2734.

<!-- preserved:e-de9dba5c10b37700 -->
> **Since 2026-10-06 the app runs Orgtree 4.0.0, a Rust engine, built on the local branch
> `rust-engine`.** Read [Orgtree 4.0.0: read this first](development-and-verification.md#e-f76fd81794788f25)
> below. Everything after it describes the 3.x Python engine and its procedures: it is
> **legacy**, kept for reference and for the 3.x line, and does not apply to 4.0.0 work unless
> the 4.0.0 section points to it. [decided: user 2026-10-06 18:53Z: the 3.2.0 Python track is
> stopped]
<!-- /preserved:e-de9dba5c10b37700 -->

<a id="e-93b42fabe2c24bc4"></a>

## Mail kinds reduced (2026-10-15). Agent-facing mail tools offer only

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3930–3945.

<!-- preserved:e-93b42fabe2c24bc4 -->
**Mail kinds reduced (2026-10-15).** Agent-facing mail tools offer only
`message` and `question`; `request`, `decision` and `status` are retired as
agent-chosen kinds (user ruling 2026-10-15, superseding the 2026-10-07
keep-all-typed-variants parity instruction for these three). Nothing ever
branched on them: wake is `notice`, ask answers link by `answer_mail`. A
send naming a retired kind is stored as `message`, never refused; unknown
kinds still refuse. Engine-generated mail (orgtree_status notices,
ask-answer mail, kickoff default, superior-routed scope requests) is stored
as `message` too. Stored rows are never rewritten: retired kinds display
as `message` (envelope header, inbox lists, renderer cards). Untouched on
purpose: the 2.x import mapping `kind: status|notice` -> passive notice
(`import2x.rs`) and the asks-tab `decision` vocabulary. [decided: user
2026-10-15; verified: `tools/defs.rs`, `tools/mailtools.rs`,
`domain/ops.rs`, `domain/asks.rs`, `domain/mail.rs::shown_kind`,
`runtime/envelope.rs`, renderer `events/project.ts`; docket
`reduce-orgtree-message-kinds-to-message-and-ques`]
<!-- /preserved:e-93b42fabe2c24bc4 -->

<a id="e-5bd036aebe5b2d70"></a>

## Verification during the prototype

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3995–3995.

<!-- preserved:e-5bd036aebe5b2d70 -->
**Verification during the prototype** [decided: user, DECISIONS 8, 33]
<!-- /preserved:e-5bd036aebe5b2d70 -->

<a id="e-d950a8c4cc76e04f"></a>

## No unit-test suites and no review rounds while the prototype is built; brief smoke tests

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3996–3997.

<!-- preserved:e-d950a8c4cc76e04f -->
- **No unit-test suites and no review rounds** while the prototype is built; brief smoke tests
  are allowed; the user tests it. Hardening with tests and review comes later.
<!-- /preserved:e-d950a8c4cc76e04f -->

<a id="e-62c8a770c86413f3"></a>

## Engine priority and agent build caches (2026-10-07). The boot task requests Normal

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4074–4083.

<!-- preserved:e-62c8a770c86413f3 -->
**Engine priority and agent build caches (2026-10-07).** The boot task requests Normal
CPU priority (Task Scheduler value 5), matching desktop launches. The app has no build-cache
setting or launcher override; a previously saved value is ignored. Rust builders in this org
set their own `CARGO_TARGET_DIR` on E: under the 2026-10-07 team instruction. Superseded
2026-10-15: new build artifacts go under the assigned `C:/orgtree-build/<agent>` scope;
the rig accepts that subtree, rejects other C: paths and continues to refuse E:.
[recorded-decision: user, 2026-10-07 07:56Z; superseded: coordinator 2026-10-15;
verified from source:
`tools/boot-engine-task.ps1`, Rust `settings.rs`, `http/settings.rs`, `runtime/{claude,codex,agy}.rs`,
`tools/rig/lib.mjs`]
<!-- /preserved:e-62c8a770c86413f3 -->

<a id="e-8ca06a30dfe8e866"></a>

## This first version was compiled on 2026-10-05 at 6e53697, before the development branch was renamed.

Original section: Keep this file current. Source lines 4171–4171.

<!-- preserved:e-8ca06a30dfe8e866 -->
This first version was compiled on 2026-10-05 at `6e53697`, before the development branch was renamed.
<!-- /preserved:e-8ca06a30dfe8e866 -->

<a id="e-3d5d469686fbccda"></a>

## Read this first

Original section: Read this first. Source lines 4173–4173.

<!-- preserved:e-3d5d469686fbccda -->
#### Read this first
<!-- /preserved:e-3d5d469686fbccda -->

<a id="e-8985bba70cb79107"></a>

## x Python engine — legacy. For 4.0.0 work use Orgtree 4.0.0: read this first; rules 2, 3, 8, 9 and 10 below still apply.

Original section: Read this first. Source lines 4181–4181.

<!-- preserved:e-8985bba70cb79107 -->
> **3.x Python engine — legacy.** For 4.0.0 work use [Orgtree 4.0.0: read this first](development-and-verification.md#e-f76fd81794788f25); rules 2, 3, 8, 9 and 10 below still apply. (2026-10-06)
<!-- /preserved:e-8985bba70cb79107 -->

<a id="e-142bfa8565134e1b"></a>

## These rules prevent the mistakes that have cost the most: lost work, a crashed machine,

Original section: Read this first. Source lines 4183–4184.

<!-- preserved:e-142bfa8565134e1b -->
These rules prevent the mistakes that have cost the most: lost work, a crashed machine,
wrong test verdicts and re-argued decisions.
<!-- /preserved:e-142bfa8565134e1b -->

<a id="e-be2958e3484916bd"></a>

## What we build. Orgtree 3 (3.x): an Electron desktop app, a Python engine and a

Original section: Read this first. Source lines 4186–4191.

<!-- preserved:e-be2958e3484916bd -->
1. **What we build.** Orgtree 3 (3.x): an Electron desktop app, a Python engine and a
   bundled PostgreSQL. All work lands on branch `dev`; `main` is moved to it
   at each release. The current project is **3.2.0, the data-model rewrite** (one
   PostgreSQL database per org), designed in
   [`docs/state-system/pg-data-model-design.md`](../../docs/state-system/pg-data-model-design.md);
   its owner and integrator is drag-opus. [decided: user 2026-10-02; team charter]
<!-- /preserved:e-be2958e3484916bd -->

<a id="e-25dc30e17769be58"></a>

## Never touch live Orgtree data, and never build an installer, tag, release, publish,

Original section: Read this first. Source lines 4192–4196.

<!-- preserved:e-25dc30e17769be58 -->
2. **Never touch live Orgtree data, and never build an installer, tag, release, publish,
   deploy, install or restart the app.** Those belong to the coordinator and the release
   owner it names. The installed app's data root is `%APPDATA%\Orgtree v2\data`; agents'
   scratch folders live inside it, so touch only your own. [decided: team charter;
   verified: `apps/desktop/main/policy.ts`]
<!-- /preserved:e-25dc30e17769be58 -->

<a id="e-1d2bea471a476f07"></a>

## Work in your own git worktree. git fetch origin, then

Original section: Read this first. Source lines 4197–4203.

<!-- preserved:e-1d2bea471a476f07 -->
3. **Work in your own git worktree.** `git fetch origin`, then
   `python tools/worktree.py add <name> --base origin/dev` (the tool's default
   base is `main`, and the local branch refs in the shared checkout are stale: always use
   `origin/...`). Never junction or symlink `node_modules` into a worktree (removing it
   deletes through the link: 783 MB was lost this way), and never copy it. Never work in
   another agent's worktree, and never use a bare `git stash` (the stash is shared).
   [verified: [`docs/worktree-operations.md`](../../docs/worktree-operations.md)]
<!-- /preserved:e-1d2bea471a476f07 -->

<a id="e-85d4ccab0710db03"></a>

## In agent shells a bare python imports the installed app, not your checkout. Run

Original section: Read this first. Source lines 4204–4208.

<!-- preserved:e-85d4ccab0710db03 -->
4. **In agent shells a bare `python` imports the installed app, not your checkout.** Run
   Python tests only through `python tools/run-python-verification.py tests/test_X.py` and
   read `import_provenance` in its output. Count `tests_ran_total`: a module that ran
   nothing is "not executed", not a pass. Scratch scripts start with the
   `tools/assert_repo_import.py` guard. [verified: `tests/import_provenance.py`]
<!-- /preserved:e-85d4ccab0710db03 -->

<a id="e-8fba03b9c0763f09"></a>

## Tests are slow and the machine is short on memory. Run only the test modules your

Original section: Read this first. Source lines 4209–4214.

<!-- preserved:e-8fba03b9c0763f09 -->
5. **Tests are slow and the machine is short on memory.** Run only the test modules your
   change touches, at the base and at your tip, and compare the failing test names. Never
   run the full baseline (`test-baseline.mjs compare`); only the coordinator or release
   owner runs it, once, before a release. Anything heavy takes the machine lock with
   `tools/p03-run.ps1 -Wait`. Start only with 15 GB of free commit memory; stop below
   10 GB. [decided: user 2026-09-26; team charter] → [Tests](legacy-and-superseded.md#e-c38f86e06d76d7c3)
<!-- /preserved:e-8fba03b9c0763f09 -->

<a id="e-111838bc4f10b080"></a>

## Landing: an independent reviewer approves your exact commit; you rebase, re-run your

Original section: Read this first. Source lines 4215–4217.

<!-- preserved:e-111838bc4f10b080 -->
6. **Landing:** an independent reviewer approves your exact commit; you rebase, re-run your
   targeted tests, run `python tools/source-audits.py`, fast-forward push and record the
   `git ls-remote` line. [decided: team charter] → [Reviews and landing](legacy-and-superseded.md#e-9a8992eb8974885d)
<!-- /preserved:e-111838bc4f10b080 -->

<a id="e-55dd205244b33716"></a>

## The storage rules are easy to break without noticing: no transaction spans two

Original section: Read this first. Source lines 4218–4221.

<!-- preserved:e-55dd205244b33716 -->
7. **The storage rules are easy to break without noticing:** no transaction spans two
   databases; every writer takes its locks in one order, with the org's revision row last;
   only the org-lifecycle module holds the admin connection; no read may grow with inactive
   history. → [Design rules and invariants](legacy-and-superseded.md#e-0507d142fa252ea1)
<!-- /preserved:e-55dd205244b33716 -->

<a id="e-9e52279facf85d0d"></a>

## Commit before you probe the base or mutate code for a test. git checkout --,

Original section: Read this first. Source lines 4222–4224.

<!-- preserved:e-9e52279facf85d0d -->
8. **Commit before you probe the base or mutate code for a test.** `git checkout --`,
   `git restore`, `git stash` and `git reset` have silently destroyed uncommitted fixes.
   [decided: team charter]
<!-- /preserved:e-9e52279facf85d0d -->

<a id="e-60aa58c79706228d"></a>

## Evidence: label every claim measured or inferred. Treat a surprising pass like a

Original section: Read this first. Source lines 4225–4227.

<!-- preserved:e-60aa58c79706228d -->
9. **Evidence:** label every claim measured or inferred. Treat a surprising pass like a
   surprising failure and check that your control really ran. After a timed-out call that
   may have applied, re-read the state before repeating a write. [decided: team charter]
<!-- /preserved:e-60aa58c79706228d -->

<a id="e-a579b9842efd5854"></a>

## This machine has traps (CRLF, heredocs, PowerShell encodings, MSYS path rewriting,

Original section: Read this first. Source lines 4228–4230.

<!-- preserved:e-a579b9842efd5854 -->
10. **This machine has traps** (CRLF, heredocs, PowerShell encodings, MSYS path rewriting,
    slow git on drive E:). Read [Machine traps](development-and-verification.md#e-802759bf35d36260) and
    [`docs/machine-traps.md`](../../docs/machine-traps.md) before your first command.
<!-- /preserved:e-a579b9842efd5854 -->

<a id="e-c2c15d8033bc95bc"></a>

## Before changing behaviour, grep for the ruling behind it. About 900 source comments

Original section: Read this first. Source lines 4231–4234.

<!-- preserved:e-c2c15d8033bc95bc -->
11. **Before changing behaviour, grep for the ruling behind it.** About 900 source comments
    cite user rulings ("user ruling", "user requirement", "user spec"), most with a date,
    mostly in `ledger.py`, `supervisor.py`, `api.py` and the renderer canvas. A cited ruling
    binds until the user changes it. [verified 2026-10-05]
<!-- /preserved:e-c2c15d8033bc95bc -->

<a id="e-529b1d4fb08f2bdc"></a>

## Do not revive dead ideas (kiosk mode, the per-org Docker sandbox, the frozen

Original section: Read this first. Source lines 4235–4236.

<!-- preserved:e-529b1d4fb08f2bdc -->
12. **Do not revive dead ideas** (kiosk mode, the per-org Docker sandbox, the frozen
    profile, v1 import, SQLite as primary storage). → [Removed and dead ideas](legacy-and-superseded.md#e-962161abcd765385)
<!-- /preserved:e-529b1d4fb08f2bdc -->

<a id="e-8af78421feca70c8"></a>

## Record catch-up builds each needed body once per snapshot and shares its tree context

Original section: Read this first. Source lines 4238–4243.

<!-- preserved:e-8af78421feca70c8 -->
Record catch-up builds each needed body once per snapshot and shares its tree context
only within that pass. The context covers rebuilt records plus predecessor/ancestor
dependencies; unchanged held runtime bodies are retained using their own cursor, not
the HTTP caller's cursor. Emitted bodies are independent copies. Membership, ordering,
scope expansion and frames stay unchanged. [decided: drag-opus 2026-10-05;
verified: `orgdb/record_pass.py`, `orgdb/record_host.py`, `orgdb/record_tree.py`]
<!-- /preserved:e-8af78421feca70c8 -->

<a id="e-f18cfe911c749baa"></a>

## Record HTTP timings use the existing slow-request threshold and numeric allowlist.

Original section: Read this first. Source lines 4245–4250.

<!-- preserved:e-f18cfe911c749baa -->
Record HTTP timings use the existing slow-request threshold and numeric allowlist.
`record_worker_ms` includes `record_assembly_ms` (including read-gate wait and
context build) plus forecast; only outer stages reduce unattributed time. Host-lock
and executor-queue waits are separate, and async waits have no thread-CPU reading.
No payload contents are logged. [verified 2026-10-06: `profiling.py`, `record_api.py`,
`orgdb/record_host.py`; decided: coordinator 2026-10-06]
<!-- /preserved:e-f18cfe911c749baa -->

<a id="e-208587af261f95e0"></a>

## What Orgtree is, and where it stands

Original section: What Orgtree is, and where it stands. Source lines 4252–4252.

<!-- preserved:e-208587af261f95e0 -->
#### What Orgtree is, and where it stands
<!-- /preserved:e-208587af261f95e0 -->

<a id="e-e469792c5ec321cb"></a>

## The product description still holds. The 3.2.0 status below is legacy: the user stopped the 3.2.0 Python track on 2026-1

Original section: What Orgtree is, and where it stands. Source lines 4254–4254.

<!-- preserved:e-e469792c5ec321cb -->
> The product description still holds. The 3.2.0 status below is **legacy**: the user stopped the 3.2.0 Python track on 2026-10-06 18:53Z; current work is 4.0.0 ([PLAN.md](../../docs/rust-engine/PLAN.md)).
<!-- /preserved:e-e469792c5ec321cb -->

<a id="e-7df6cf178edd3612"></a>

## Claude warm reuse rotates the Orgtree MCP child at a quiescent turn boundary:

Original section: What Orgtree is, and where it stands. Source lines 4256–4263.

<!-- preserved:e-7df6cf178edd3612 -->
Claude warm reuse rotates the Orgtree MCP child at a quiescent turn boundary:
one child keeps one immutable run claim; the parked CLI carries no turn token.
New-child authentication and an unchanged tool-list digest precede the prompt;
old callbacks retain their origin, and uncertainty falls back cold. Descendant
inventories must be rechecked after drain and across parked reuse/replacement;
new shells must never enter the successor baseline. [decided: review2-sol 2026-10-06] See
[`claude-warm-turns.md`](../../docs/claude-warm-turns.md). [decided: drag-opus and
coordinator 2026-10-06; verified: `claude_transport.py`, `supervisor.py`]
<!-- /preserved:e-7df6cf178edd3612 -->

<a id="e-54fabbc6d0b78c04"></a>

## The product. A Windows desktop app for running a persistent team of coding agents.

Original section: What Orgtree is, and where it stands. Source lines 4265–4272.

<!-- preserved:e-54fabbc6d0b78c04 -->
- **The product.** A Windows desktop app for running a persistent team of coding agents.
  The user sits at the top of an org chart (the canvas); agents work beneath, each with a
  desk (live conversation and tool activity), mail and notices, a shared docket of tickets,
  questions to the user, audiences (extra communication links), watchdogs, presentations
  and file delivery. Agents run through Claude Code, Codex and Antigravity, or OpenRouter,
  on one or more signed-in accounts per provider. **Credits** are a capacity budget, not
  money: each agent occupies a model-priced seat, its grant funds the agents beneath it,
  and retiring it frees the capacity. [verified: `README.md`]
<!-- /preserved:e-54fabbc6d0b78c04 -->

<a id="e-93fd1037ed013216"></a>

## Lineage. claude-orgtree (v1) → Orgtree 2 (Electron around the v1 Python engine, on

Original section: What Orgtree is, and where it stands. Source lines 4273–4275.

<!-- preserved:e-93fd1037ed013216 -->
- **Lineage.** claude-orgtree (v1) → Orgtree 2 (Electron around the v1 Python engine, on
  SQLite; last release 2.1.14) → Orgtree 3 (storage on PostgreSQL; 3.0.0 published
  2026-10-01, 3.1.0 on 2026-10-02). [verified: git tags `v3.0.0`, `v3.1.0`]
<!-- /preserved:e-93fd1037ed013216 -->

<a id="e-fd803721f4f6abad"></a>

## The mission of v3 is performance and memory, not UI: the app must stay responsive

Original section: What Orgtree is, and where it stands. Source lines 4276–4277.

<!-- preserved:e-fd803721f4f6abad -->
- **The mission of v3** is performance and memory, not UI: the app must stay responsive
  with hundreds or thousands of active agents. [decided: user 2026-09-26]
<!-- /preserved:e-fd803721f4f6abad -->

<a id="e-bccd9c99ba982c97"></a>

## Scale targets at 1,000 agents: UI reads p95 under 250 ms; tool calls p95 under

Original section: What Orgtree is, and where it stands. Source lines 4278–4283.

<!-- preserved:e-bccd9c99ba982c97 -->
- **Scale targets** at 1,000 agents: UI reads p95 under 250 ms; tool calls p95 under
  500 ms and never waiting on unrelated agents; clicks under 100 ms; engine memory flat
  over an hour; screen feed under 1 s with no drops; at 2,000 agents, usable with no stall
  over 2 s. They are best effort, not a release gate, while the engine stays Python, and the
  separate scale-qualification test was dropped. [decided: user 2026-09-26, 2026-09-28,
  2026-09-30]
<!-- /preserved:e-bccd9c99ba982c97 -->

<a id="e-ecc79eb53749808d"></a>

## rewrites the data model as if Orgtree were built for PostgreSQL from the ground

Original section: What Orgtree is, and where it stands. Source lines 4284–4288.

<!-- preserved:e-ecc79eb53749808d -->
- **3.2.0** rewrites the data model as if Orgtree were built for PostgreSQL from the ground
  up, and ships it all at once: one database per org, jobs in place of every polling loop,
  a change log that feeds the renderer records instead of refetches, a durable turn queue
  with leases, and a second engine process. [decided: user 2026-10-02, design decisions 7,
  10, 12]
<!-- /preserved:e-ecc79eb53749808d -->

<a id="e-f4d3208a2c64ba89"></a>

## status on 2026-10-05 (check git log origin/dev before relying on it):

Original section: What Orgtree is, and where it stands. Source lines 4290–4290.

<!-- preserved:e-f4d3208a2c64ba89 -->
**3.2.0 status on 2026-10-05** (check `git log origin/dev` before relying on it):
<!-- /preserved:e-f4d3208a2c64ba89 -->

<a id="e-66d8264631bd0ff3"></a>

## Landed: phase A (per-org databases, converter with unavailable and Retry,

Original section: What Orgtree is, and where it stands. Source lines 4292–4296.

<!-- preserved:e-66d8264631bd0ff3 -->
- **Landed:** phase A (per-org databases, converter with `unavailable` and Retry,
  compatibility view, native agent and docket readers, accounts in the app database; new
  storage on by default since `4f1ddf0`); durable turn requests and queue (B5, `305c472`);
  schema conformance G1–G11 (`c162ca0`); the O(1) agent move (O1, `3535fb4`); the alpha.1
  startup repairs (`d1c4e8c`); one shared registry connection cache (`ebb2af6`); B4a record-feed backend and tree subscriptions (migration 0018); B4b app feed (app migration 0005).
<!-- /preserved:e-66d8264631bd0ff3 -->

<a id="e-115e489dabd97c38"></a>

## Builds delivered (local, never published): 3.2.0-alpha.0 on 2026-10-04 and

Original section: What Orgtree is, and where it stands. Source lines 4297–4299.

<!-- preserved:e-115e489dabd97c38 -->
- **Builds delivered** (local, never published): 3.2.0-alpha.0 on 2026-10-04 and
  3.2.0-alpha.1 on 2026-10-05; the user runs them on live data. alpha.1's startup failures
  are fixed on `dev` by `d1c4e8c`.
<!-- /preserved:e-115e489dabd97c38 -->

<a id="e-48cdf74c2bc916d5"></a>

## In flight: the record feed panels: B4c1 (inbox, events, mail, history), B4c2 (gallery, docket, audiences) and B4d

Original section: What Orgtree is, and where it stands. Source lines 4300–4301.

<!-- preserved:e-48cdf74c2bc916d5 -->
- **In flight:** the record feed panels: B4c1 (inbox, events, mail, history), B4c2 (gallery, docket, audiences) and B4d
  (time and retention jobs) follow.
<!-- /preserved:e-48cdf74c2bc916d5 -->

<a id="e-a70a381f45e72701"></a>

## Remaining: B1 mail and watchdog modules with jobs; B2 questions, audiences,

Original section: What Orgtree is, and where it stands. Source lines 4302–4307.

<!-- preserved:e-a70a381f45e72701 -->
- **Remaining:** B1 mail and watchdog modules with jobs; B2 questions, audiences,
  documents, reservations, events and settings modules, with every remaining polling loop
  a job; B3 the host's job scheduler and sweep; B6 the worker process and deletion of the
  compatibility view; then final rehearsals and the release candidate, including installer
  upgrade rehearsals from 2.1.14, 3.0.9 and 3.1.0 with a rollback. [decided: umbrella
  ticket `v3-storage-keep-indexed-fields-in-real-postgresq`, decisions 23 and 34]
<!-- /preserved:e-a70a381f45e72701 -->

<a id="e-a7e56472b11bd3c8"></a>

## Architecture

Original section: Architecture. Source lines 4309–4309.

<!-- preserved:e-a7e56472b11bd3c8 -->
#### Architecture
<!-- /preserved:e-a7e56472b11bd3c8 -->

<a id="e-45a30d854fa73009"></a>

## x Python engine — legacy. 4.0.0's architecture is PLAN.md §1–§4. (2026-10-06)

Original section: Architecture. Source lines 4311–4311.

<!-- preserved:e-45a30d854fa73009 -->
> **3.x Python engine — legacy.** 4.0.0's architecture is [PLAN.md §1–§4](../../docs/rust-engine/PLAN.md). (2026-10-06)
<!-- /preserved:e-45a30d854fa73009 -->

<a id="e-9bfac29b98fa3f35"></a>

## As built on dev on 2026-10-05; where 3.2.0 will differ, the table at the

Original section: Architecture. Source lines 4322–4323.

<!-- preserved:e-9bfac29b98fa3f35 -->
As built on `dev` on 2026-10-05; where 3.2.0 will differ, the table at the
end of this section says so.
<!-- /preserved:e-9bfac29b98fa3f35 -->

<a id="e-c56984b7084f1ccc"></a>

## Processes and the desktop–engine boundary

Original section: Processes and the desktop–engine boundary. Source lines 4325–4325.

<!-- preserved:e-c56984b7084f1ccc -->
##### Processes and the desktop–engine boundary
<!-- /preserved:e-c56984b7084f1ccc -->

<a id="e-dbd0f31f9ab1a2d8"></a>

## App feed and native login (2026-10-05). App registry, org summaries/notices and

Original section: Processes and the desktop–engine boundary. Source lines 4327–4333.

<!-- preserved:e-dbd0f31f9ab1a2d8 -->
- **App feed and native login (2026-10-05).** App registry, org summaries/notices and
  engine-owned values use `/api/app/ws` and `/api/app/records`; app migration 0005
  gates activation. Native provider login remains in Electron under D231: subscribe
  before taking its initial IPC snapshot, ignore delayed responses after newer events,
  and unsubscribe on unmount. OAuth output/codes never go through the engine.
  [verified: `app_api.py`, `packages/contracts/provider-login-feed.ts`;
  decided: drag-opus 2026-10-05, B4b decision 7]
<!-- /preserved:e-dbd0f31f9ab1a2d8 -->

<a id="e-504a24f67b4783a8"></a>

## Native notices (2026-10-05). Electron's app socket uses the current desktop

Original section: Processes and the desktop–engine boundary. Source lines 4334–4343.

<!-- preserved:e-504a24f67b4783a8 -->
- **Native notices (2026-10-05).** Electron's app socket uses the current desktop
  token on the HTTP copy and WebSocket handshake. Renderer delivery keeps its
  existing category, visibility and persistent-history rules; a failed OS
  delivery retries cached notices, never a network read. An active org missing
  its first notice snapshot is unknown, so it cannot clear delivery history or
  establish the initial document baseline. Completing an empty inventory must wake
  baseline observation before the first new document. Antigravity terminal launch
  publishes done/ok:null through the native login subscription without claiming
  verified authentication. [verified: `main/appfeed.ts`,
  `renderer/src/notifications.ts`; see step-6 §5]
<!-- /preserved:e-504a24f67b4783a8 -->

<a id="e-8463df1bd7fe0ce0"></a>

## Desktop (apps/desktop): Electron 44. main/ owns windows (one main window per

Original section: Processes and the desktop–engine boundary. Source lines 4345–4350.

<!-- preserved:e-8463df1bd7fe0ce0 -->
- **Desktop** (`apps/desktop`): Electron 44. `main/` owns windows (one main window per
  org), tray, updater and the engine's lifecycle (`index.ts`, `engine.ts`, `policy.ts`).
  `preload/` exposes `window.orgtreeDesktop` only to the top frame at the exact engine
  origin. `renderer/` is React 18 + MUI 9 + TypeScript, built by Vite into `dist/renderer`
  and served by the engine as `resources/ui`; it has no state library (`App.tsx` state plus
  module-level stores). [verified: `package.json`, `apps/desktop/preload/index.ts`]
<!-- /preserved:e-8463df1bd7fe0ce0 -->

<a id="e-e291fe5e0000ccc9"></a>

## Engine (engine/): Python 3.13 (embedded runtime, engine/runtime, gitignored and

Original section: Processes and the desktop–engine boundary. Source lines 4351–4354.

<!-- preserved:e-e291fe5e0000ccc9 -->
- **Engine** (`engine/`): Python 3.13 (embedded runtime, `engine/runtime`, gitignored and
  provisioned by `npm run runtime:provision`). `engine/launch.py` validates the data root,
  sets Windows High priority, arms the guardian, starts PostgreSQL and serves the FastAPI
  app (`engine/backend/orgtree/api.py`) on `127.0.0.1`. [verified: `engine/launch.py`]
<!-- /preserved:e-e291fe5e0000ccc9 -->

<a id="e-b5f3af009ae6238d"></a>

## Guardian (engine/process_lifetime.py): holds the data-root lock

Original section: Processes and the desktop–engine boundary. Source lines 4355–4357.

<!-- preserved:e-b5f3af009ae6238d -->
- **Guardian** (`engine/process_lifetime.py`): holds the data-root lock
  (`.desktop-engine.lock`) and a Windows kill-on-close job containing the engine and every
  descendant (PostgreSQL, provider CLIs), so a dead engine never leaves orphans. [verified]
<!-- /preserved:e-b5f3af009ae6238d -->

<a id="e-7725d52964a5bdd4"></a>

## Boot host (engine/service_host.py): run at Windows boot by the "Orgtree Background

Original section: Processes and the desktop–engine boundary. Source lines 4358–4361.

<!-- preserved:e-7725d52964a5bdd4 -->
- **Boot host** (`engine/service_host.py`): run at Windows boot by the "Orgtree Background
  Engine" scheduled task (all-users installs only; S4U, LeastPrivilege). It starts the
  engine unelevated and writes `engine-attach.json` so the desktop can attach.
  [verified: `tools/boot-engine-task.ps1`, `build/installer.nsh`]
<!-- /preserved:e-7725d52964a5bdd4 -->

<a id="e-bd3cb4a943e3fe6b"></a>

## PostgreSQL 18.6, bundled, run by the Rust pg-custodian (engine/native/pg-custodian)

Original section: Processes and the desktop–engine boundary. Source lines 4362–4365.

<!-- preserved:e-bd3cb4a943e3fe6b -->
- **PostgreSQL 18.6**, bundled, run by the Rust `pg-custodian` (`engine/native/pg-custodian`)
  through `engine/pg_process.py`; the cluster lives in `<data>\pg\cluster`; roles
  `orgtree_admin` and `orgtree_runtime`; connection strings use a passfile and SCRAM, never
  a password. [verified]
<!-- /preserved:e-bd3cb4a943e3fe6b -->

<a id="e-608280dc136ece96"></a>

## Mail hub: the engine/mailhub submodule (orgtree-mailhub) runs as a child process;

Original section: Processes and the desktop–engine boundary. Source lines 4366–4368.

<!-- preserved:e-608280dc136ece96 -->
- **Mail hub**: the `engine/mailhub` submodule (orgtree-mailhub) runs as a child process;
  changes land in orgtree-mailhub first and Orgtree moves only the pin.
  [verified: [`docs/mailhub-sync.md`](../../docs/mailhub-sync.md)]
<!-- /preserved:e-608280dc136ece96 -->

<a id="e-d445ff365e730f9e"></a>

## Boundary. All domain traffic is HTTP and WebSocket from the engine origin; IPC

Original section: Processes and the desktop–engine boundary. Source lines 4369–4374.

<!-- preserved:e-d445ff365e730f9e -->
- **Boundary.** All domain traffic is HTTP and WebSocket from the engine origin; IPC
  (`desktop:*`) is only for native operations. The desktop sends a fresh per-boot token in
  `X-Orgtree-Desktop-Token`; the engine drops it from its environment before importing
  anything that spawns children. The port is preferred from 20000–49151 and kept in
  `engine-port.json`, because moving the origin strands the browser's local storage.
  [verified: `engine/launch.py`; [`docs/engine-contract.md`](../../docs/engine-contract.md)]
<!-- /preserved:e-d445ff365e730f9e -->

<a id="e-e638c1a855d2a9af"></a>

## Agents call back through the MCP server python -m orgtree.mcptool, which posts to

Original section: Processes and the desktop–engine boundary. Source lines 4375–4378.

<!-- preserved:e-e638c1a855d2a9af -->
- **Agents** call back through the MCP server `python -m orgtree.mcptool`, which posts to
  `/api/agent` with `X-Orgtree-Agent-Token` (an HMAC over org, node, generation and seat,
  keyed per engine process) and `X-Orgtree-Turn-Token` (binds the call to the running
  turn). [verified: `mcptool.py`, `agentauth.py`]
<!-- /preserved:e-e638c1a855d2a9af -->

<a id="e-569b3623b1f9d2fd"></a>

## Storage

Original section: Storage. Source lines 4380–4380.

<!-- preserved:e-569b3623b1f9d2fd -->
##### Storage
<!-- /preserved:e-569b3623b1f9d2fd -->

<a id="e-6a015bca0d18fb06"></a>

## Backend choice: ORGTREE_STORE, then &lt;data&gt;/store-backend.json, then SQLite.

Original section: Storage. Source lines 4382–4386.

<!-- preserved:e-6a015bca0d18fb06 -->
- **Backend choice:** `ORGTREE_STORE`, then `<data>/store-backend.json`, then SQLite.
  Packaged builds set `ORGTREE_PG_BOOTSTRAP=1`: a fresh data root binds to PostgreSQL, and
  an existing 2.x SQLite root is converted at first launch (old files moved to
  `pre-postgres/`). An unpackaged dev run stays on SQLite unless told otherwise.
  [verified: `engine/pg_process.py`, `apps/desktop/main/postgres-runtime.ts`]
<!-- /preserved:e-6a015bca0d18fb06 -->

<a id="e-b4fd2ac0a5a27772"></a>

## The layout switch ORGTREE_STORAGE: unset or empty means orgdb (one database per

Original section: Storage. Source lines 4387–4389.

<!-- preserved:e-b4fd2ac0a5a27772 -->
- **The layout switch `ORGTREE_STORAGE`:** unset or empty means `orgdb` (one database per
  org) whenever the engine runs on PostgreSQL; `legacy` is the developer escape hatch.
  Agent children never inherit it. [verified: `engine/pg_process.py`, `devguard.py`]
<!-- /preserved:e-b4fd2ac0a5a27772 -->

<a id="e-6ef10c9baab41cc5"></a>

## Legacy layout (3.0–3.1): one database orgtree with a schema org_&lt;n&gt; of key+JSON

Original section: Storage. Source lines 4390–4392.

<!-- preserved:e-6ef10c9baab41cc5 -->
- **Legacy layout** (3.0–3.1): one database `orgtree` with a schema `org_<n>` of key+JSON
  tables per org; migrations `pg_migrations/0001`–`0020`, frozen (published checksums are
  pinned by `tests/test_published_migrations.py`). 3.2.0 never migrates or writes it.
<!-- /preserved:e-6ef10c9baab41cc5 -->

<a id="e-d9e6214873b52c47"></a>

## Per-org layout (3.2.0): orgtree_app plus orgtree_org_&lt;n&gt;, all tables in schema

Original section: Storage. Source lines 4393–4397.

<!-- preserved:e-d9e6214873b52c47 -->
- **Per-org layout** (3.2.0): `orgtree_app` plus `orgtree_org_<n>`, all tables in schema
  `orgtree`. Migrations live in `pg_migrations/app/` and `pg_migrations/org/` and run per
  database, one transaction per file; editing an applied file raises `MigrationDrift`; an
  org database newer than the build is not served. Database names come only from
  `orgdb/names.py`. [verified: `orgdb/migrate.py`]
<!-- /preserved:e-d9e6214873b52c47 -->

<a id="e-e3324920c5d150e9"></a>

## Startup with orgdb: prepare the app database → the one-time converter pass (a child

Original section: Storage. Source lines 4398–4401.

<!-- preserved:e-e3324920c5d150e9 -->
- **Startup with `orgdb`:** prepare the app database → the one-time converter pass (a child
  process) → resume interrupted lifecycle claims → migrate each active org (a failure makes
  only that org `unavailable`) → retry unavailable orgs once per new build → start the turn
  host. [verified: `orgdb/startup.py`]
<!-- /preserved:e-e3324920c5d150e9 -->

<a id="e-7d7e91230770161f"></a>

## Compatibility view (orgdb/compat): store.py keeps issuing its own SQL against the

Original section: Storage. Source lines 4402–4404.

<!-- preserved:e-7d7e91230770161f -->
- **Compatibility view** (`orgdb/compat`): `store.py` keeps issuing its own SQL against the
  legacy tables, and an org-database connection answers each statement from the new
  tables; an unknown statement raises. It is deleted in B6. [verified]
<!-- /preserved:e-7d7e91230770161f -->

<a id="e-d9fe662ec671a943"></a>

## Connections: one idle cache per process for app and org sessions (at most 4 idle app,

Original section: Storage. Source lines 4405–4414.

<!-- preserved:e-d9fe662ec671a943 -->
- **Connections:** one idle cache per process for app and org sessions (at most 4 idle app,
  2 idle per org database, 16 in all; 10-minute expiry; keyed by the full runtime connection
  settings plus the database). Every org checkout re-checks `org_identity`, and a mismatch
  refuses. Only a failed pre-body checkout reconnects: transaction bodies and ambiguous
  commits are never repeated. Dirty or listening sessions are closed, never reused. The turn
  heartbeat has its own thread and connection (5 s connect and statement timeouts). There
  is deliberately no blanket idle-in-transaction timeout (org-exclusive file-move fences
  must survive). An active cap and a FIFO queue arrive with B6. [verified:
  `orgdb/registry.py`, `orgdb/turn_runtime.py`; decided: coordinator 2026-10-05, outage
  ticket decision 3]
<!-- /preserved:e-d9fe662ec671a943 -->

<a id="e-05456033c264f5ec"></a>

## Prompt-view capture: a complete JSONL row with invalid JSON or text encoding is skipped

Original section: Storage. Source lines 4416–4421.

<!-- preserved:e-05456033c264f5ec -->
- **Prompt-view capture:** a complete JSONL row with invalid JSON or text encoding is skipped
  with a warning containing only a source-identity hash and byte offset. The cursor advances
  in the same transaction as captured rows; valid following rows survive and an incomplete
  last line waits for completion. Catch `UnicodeDecodeError` as well as `JSONDecodeError`:
  otherwise the bad row rolls back cursor progress and retries forever. [verified 2026-10-05:
  `transcript_records.py::ingest_prompt_views`, `tests/test_transcript_records.py`]
<!-- /preserved:e-05456033c264f5ec -->

<a id="e-1eb7e758aa691fb2"></a>

## Turns, jobs and the feed: built today vs. 3.2.0

Original section: Turns, jobs and the feed: built today vs. 3.2.0. Source lines 4423–4423.

<!-- preserved:e-1eb7e758aa691fb2 -->
##### Turns, jobs and the feed: built today vs. 3.2.0
<!-- /preserved:e-1eb7e758aa691fb2 -->

<a id="e-fe6ca940df88a757"></a>

## Part On dev now 3.2.0 target

Original section: Turns, jobs and the feed: built today vs. 3.2.0. Source lines 4425–4430.

<!-- preserved:e-fe6ca940df88a757 -->
| Part | On dev now | 3.2.0 target |
| --- | --- | --- |
| Turn admission | With `orgdb`: a durable `turn_requests` row in the org database, a `start_turn` job, then a `turn_tickets` row in `orgtree_app` claimed by the turn host. Otherwise the in-memory `turnslots.FairSlots`. Limit: App settings `max_concurrent_turns`, default 16 | the same, shared with the worker |
| Jobs | `orgdb/jobs.py` exists, but only `start_turn` is enqueued. The polling loops (auto-resume, watchdogs, mail drain, keepers) still run as threads started by `api._recover_startup` | every loop that reads org tables becomes a job (B1–B3) |
| Screen feed | With orgdb and migration 0018, `record_changes_v1` enables record snapshots, catch-up and tree subscriptions; the deferred commit flush assigns the sole revision. App migration 0005 adds ordered app snapshots, runtime values and notices; legacy storage keeps changed/refetch | B4c panels reuse the core; B4d moves host time/retention work to jobs |
| Processes | one engine process per data root | an engine host plus one worker (B6) |
<!-- /preserved:e-fe6ca940df88a757 -->

<a id="e-99bfbdbace3575da"></a>

## Code map

Original section: Code map. Source lines 4432–4432.

<!-- preserved:e-99bfbdbace3575da -->
##### Code map
<!-- /preserved:e-99bfbdbace3575da -->

<a id="e-923a2eb470e7d64d"></a>

## engine/backend/orgtree/: supervisor.py (about 37,600 lines: turns, provider legs,

Original section: Code map. Source lines 4434–4440.

<!-- preserved:e-923a2eb470e7d64d -->
- `engine/backend/orgtree/`: `supervisor.py` (about 37,600 lines: turns, provider legs,
  polling loops, the managed agent instructions), `ledger.py` (about 20,000: the `Org`
  domain model, credits, hire/move/retire, scope clamps), `api.py` (about 15,400: every
  HTTP and WebSocket route), `store.py` (the storage seam), `orgtx.py` (`org_tx` and lock
  plans), `orgdb/` (per-org storage), `turnslots.py` and `turnqueue.py`, `mcptool.py`,
  `agentauth.py`, `halt.py`, `pgfeed.py`, `warmpool.py`, and the provider modules
  (`codexrun.py`, `antigravityrun.py`, `openrouter*.py`, `providers.py`).
<!-- /preserved:e-923a2eb470e7d64d -->

<a id="e-0586b1bb36f5c37e"></a>

## Name collisions: four "lifecycle" modules (lifecycle.py, lifecycle_tx.py,

Original section: Code map. Source lines 4441–4443.

<!-- preserved:e-0586b1bb36f5c37e -->
- **Name collisions:** four "lifecycle" modules (`lifecycle.py`, `lifecycle_tx.py`,
  `lifecycle_door.py`, `orgdb/lifecycle.py`); two "registry" modules (accounts
  `registry.py`, orgs `orgdb/registry.py`); Python `store.py` versus the Rust `store` crate.
<!-- /preserved:e-0586b1bb36f5c37e -->

<a id="e-557270fe75846468"></a>

## engine/native/: only pg-custodian (with its prototype-guard library) runs in the

Original section: Code map. Source lines 4444–4448.

<!-- preserved:e-557270fe75846468 -->
- **`engine/native/`:** only `pg-custodian` (with its `prototype-guard` library) runs in the
  product. The `store*` crates are a shelved Rust store prototype. `backend-codec`,
  `funding-core`, `op-receipt-codec`, `scope-clamp` and `work-name-codec` are parity models
  checked against vectors generated from the Python sources. `engine/winservice/` is not
  wired. [verified]
<!-- /preserved:e-557270fe75846468 -->

<a id="e-53288d2d34dc321f"></a>

## Generated files: apps/desktop/renderer/src/generated/events.ts says it comes from

Original section: Code map. Source lines 4449–4451.

<!-- preserved:e-53288d2d34dc321f -->
- **Generated files:** `apps/desktop/renderer/src/generated/events.ts` says it comes from
  `tools/gen_events.py`, which does not exist; regenerate it with
  `orgtree.events.emit_typescript()`. [verified]
<!-- /preserved:e-53288d2d34dc321f -->

<a id="e-0507d142fa252ea1"></a>

## Design rules and invariants

Original section: Design rules and invariants. Source lines 4453–4453.

<!-- preserved:e-0507d142fa252ea1 -->
#### Design rules and invariants
<!-- /preserved:e-0507d142fa252ea1 -->

<a id="e-aaee5785159ec887"></a>

## x Python engine — legacy (the 3.2.0 per-org data model, org_tx lock order, revision row, jobs). 4.0.0 has its own rules:

Original section: Design rules and invariants. Source lines 4455–4455.

<!-- preserved:e-aaee5785159ec887 -->
> **3.x Python engine — legacy** (the 3.2.0 per-org data model, `org_tx` lock order, revision row, jobs). 4.0.0 has its own rules: see the 4.0.0 section and [PLAN.md §2.2](../../docs/rust-engine/PLAN.md). The history-must-cost-nothing goal and the halt and privilege rules carry over. (2026-10-06)
<!-- /preserved:e-aaee5785159ec887 -->

<a id="e-e194a167983105ef"></a>

## Break one of these and the damage is usually silent until it reaches real data. "§" refers

Original section: Design rules and invariants. Source lines 4457–4458.

<!-- preserved:e-e194a167983105ef -->
Break one of these and the damage is usually silent until it reaches real data. "§" refers
to [`pg-data-model-design.md`](../../docs/state-system/pg-data-model-design.md).
<!-- /preserved:e-e194a167983105ef -->

<a id="e-76435f20db8b6fff"></a>

## Data model (3.2.0)

Original section: Data model (3.2.0). Source lines 4460–4460.

<!-- preserved:e-76435f20db8b6fff -->
##### Data model (3.2.0)
<!-- /preserved:e-76435f20db8b6fff -->

<a id="e-502840766f26713e"></a>

## PostgreSQL is the only source of truth. No engine process holds org state; a cache is

Original section: Data model (3.2.0). Source lines 4462–4464.

<!-- preserved:e-502840766f26713e -->
- **PostgreSQL is the only source of truth.** No engine process holds org state; a cache is
  allowed only when keyed by `(org, revision)` and dropped when that org's feed moves past
  it. [decided: user 2026-10-02, design decision 7; §2.9]
<!-- /preserved:e-502840766f26713e -->

<a id="e-7b9281047a34d23c"></a>

## One database per org, plus one small app database. An org's database holds everything

Original section: Data model (3.2.0). Source lines 4465–4471.

<!-- preserved:e-7b9281047a34d23c -->
- **One database per org, plus one small app database.** An org's database holds everything
  the org owns; `<n>` in `orgtree_org_<n>` is the registry's `org_id`, so a rename never
  renames a database. `orgtree_app` holds only the org registry, machine-wide accounts, the
  turn queue, engine instances and a one-row `app_settings` of cutover markers (the user's
  App settings stay in `app-settings.json`). Creating or importing an org is one database
  plus one registry row; deleting moves it to the trash; purging drops it. [decided: user
  2026-10-02, decisions 10 and 11; §2.10]
<!-- /preserved:e-7b9281047a34d23c -->

<a id="e-b3ac9df0e59fd00c"></a>

## Normalized design (about 3NF). A many-to-one link is a foreign-key column on the

Original section: Data model (3.2.0). Source lines 4472–4475.

<!-- preserved:e-b3ac9df0e59fd00c -->
- **Normalized design (about 3NF).** A many-to-one link is a foreign-key column on the
  "many" side; a many-to-many link is a link table with one row per link; no embedded
  lists. Every deliberate duplicate is justified in the design (Appendix A.7). [decided:
  user 2026-10-02, decisions 2–3]
<!-- /preserved:e-b3ac9df0e59fd00c -->

<a id="e-721fdb7b22d1ff51"></a>

## Keys and names. Every record has a surrogate id; visible names (agent name, ticket

Original section: Data model (3.2.0). Source lines 4476–4478.

<!-- preserved:e-721fdb7b22d1ff51 -->
- **Keys and names.** Every record has a surrogate `id`; visible names (agent name, ticket
  slug, mail id) stay unique natural keys, so a rename is one `UPDATE`. A deleted agent
  keeps a tombstone row. Ticket slugs are never reused. [decided: §2.2, §3.0]
<!-- /preserved:e-721fdb7b22d1ff51 -->

<a id="e-dfcefd709bfb4616"></a>

## Agent identity is the node, not the lineage. Each agent and each archived generation

Original section: Data model (3.2.0). Source lines 4479–4483.

<!-- preserved:e-dfcefd709bfb4616 -->
- **Agent identity is the node, not the lineage.** Each agent and each archived generation
  (`x`, `x@3`) is its own row, mailbox and principal; `lineage_born` is a shared lineage
  token, not an identity. "Current holder" references (ticket owner, mail recipient) point
  at the node's row; "historical" ones (creator, sender, event actor) keep the recorded name
  and generation with no foreign key. [decided: design rev 6, finding f17; §3.0]
<!-- /preserved:e-dfcefd709bfb4616 -->

<a id="e-7ff4cf85b47180dd"></a>

## Exact round trips. Timestamps are timestamptz at microsecond precision, with the

Original section: Data model (3.2.0). Source lines 4484–4488.

<!-- preserved:e-7ff4cf85b47180dd -->
- **Exact round trips.** Timestamps are `timestamptz` at microsecond precision, with the
  original text kept beside a non-canonical value; unknown keys go to an `extra` JSON column
  that is expected to be empty; a JSON column holds only a shapeless payload that nothing
  filters inside. PostgreSQL's JSON operators fail on a `\u0000` escape anywhere in a value,
  so such text stays in `extra`. [decided: design Q1, Q2; §3.0]
<!-- /preserved:e-7ff4cf85b47180dd -->

<a id="e-e488219ebc7ba51d"></a>

## Migration numbers are taken at landing: the next free number on dev when your migration

Original section: Data model (3.2.0). Source lines 4489–4490.

<!-- preserved:e-e488219ebc7ba51d -->
- **Migration numbers are taken at landing:** the next free number on `dev` when your migration
  lands, never reserved earlier. [decided: drag-opus 2026-10-04, decision 32]
<!-- /preserved:e-e488219ebc7ba51d -->

<a id="e-6b8ad861528d902e"></a>

## Transactions and locks

Original section: Transactions and locks. Source lines 4492–4492.

<!-- preserved:e-6b8ad861528d902e -->
##### Transactions and locks
<!-- /preserved:e-6b8ad861528d902e -->

<a id="e-bede9e03c4a0d94e"></a>

## One short transaction per action, on its own org's database, over only its rows, at

Original section: Transactions and locks. Source lines 4494–4497.

<!-- preserved:e-bede9e03c4a0d94e -->
- **One short transaction per action**, on its own org's database, over only its rows, at
  READ COMMITTED. A serialization failure or deadlock re-runs the whole function, so domain
  functions must have no side effects outside the database. Business rules stay in Python.
  [decided: §2.1]
<!-- /preserved:e-bede9e03c4a0d94e -->

<a id="e-012f61633c21eabf"></a>

## No transaction spans two databases. An action that touches two (cross-org mail,

Original section: Transactions and locks. Source lines 4498–4500.

<!-- preserved:e-012f61633c21eabf -->
- **No transaction spans two databases.** An action that touches two (cross-org mail,
  starting a turn) records its intent durably in the first, then finishes with an
  idempotent job keyed by a stable id. [decided: §2.1, §2.7]
<!-- /preserved:e-012f61633c21eabf -->

<a id="e-3584dc22a5bb61f5"></a>

## One lock order for every org-database writer

Original section: Transactions and locks. Source lines 4501–4515.

<!-- preserved:e-3584dc22a5bb61f5 -->
- **One lock order for every org-database writer** [decided: §2.4, revs 7.4–7.8; verified:
  `tests/test_orgdb_lock_order.py`]:
  1. the running turn's request row (`FOR SHARE` for tools and results; `FOR UPDATE` to
     finish, cancel or reclaim);
  2. advisory locks: the org lock, then the settings fence, then node, key and log-owner
     locks in sorted plan order, then the operation-receipt lock;
  3. rows by tier: agents by physical id, then `agent_subtree_stats`, then docket items,
     then mailboxes, then other planned rows. A structural writer takes every lock before
     its first structural statement; a plan that proves too narrow raises `Widen` (roll
     back, rerun wider). Never lock a row late;
  4. the revision row `orgtree.org_revision` **last**, taken by the deferred record flush
     when migration 0018 is present; retention also locks it last;
  5. after it, only aggregate counters, the current transaction's change/revision rows
     and record detail versions; final graph validation takes no earlier-tier lock.
     [verified-from-source 2026-10-05: `0018_records.sql`, `tests/test_orgdb_lock_order.py`]
<!-- /preserved:e-3584dc22a5bb61f5 -->

<a id="e-57b307e6045f55b9"></a>

## Triggers. A statement-time trigger writes only link rows of its own statement's rows

Original section: Transactions and locks. Source lines 4516–4526.

<!-- preserved:e-57b307e6045f55b9 -->
- **Triggers.** A statement-time trigger writes only link rows of its own statement's rows
  and takes no row lock; the one allowlisted exception is the `agents` subtree-stats
  triggers. Writers do not force deferred checks (`SET CONSTRAINTS … IMMEDIATE`); the single
  exception is the migration runner checking two named docket-pointer foreign keys for
  migration 0016 (2026-10-05). The source audit matches the entire SQL, module and lexical
  function path; other constraint sets, appended statements and locations remain rejected.
  [verified 2026-10-05: `tests/test_orgdb_lock_order.py`] A value derived from other rows is a generated column, kept
  at statement time under the writer's own locks, kept under the revision row (the two
  counter tables), or computed by the reader. Changing any of this means changing the
  lock-order test, whose negative controls must keep failing. [decided: design revs 7.5,
  7.8; verified: `orgdb/migrate.py`]
<!-- /preserved:e-57b307e6045f55b9 -->

<a id="e-62e92f1b5827761b"></a>

## Every foreign key to agents is immediate, never deferred: a commit-time check would

Original section: Transactions and locks. Source lines 4527–4528.

<!-- preserved:e-62e92f1b5827761b -->
- **Every foreign key to `agents` is immediate**, never deferred: a commit-time check would
  wait for an agent row after the revision row. [verified: `tests/test_orgdb_lock_order.py`]
<!-- /preserved:e-62e92f1b5827761b -->

<a id="e-2053402522e64f38"></a>

## Deferred foreign-key checks queued by a backfill block later DDL: an ALTER TABLE in

Original section: Transactions and locks. Source lines 4529–4531.

<!-- preserved:e-2053402522e64f38 -->
- **Deferred foreign-key checks queued by a backfill block later DDL:** an `ALTER TABLE` in
  the same transaction fails with "pending trigger events". This broke migration 0016 on the
  user's data in alpha.1. [verified: `orgdb/migrate.py`, `61c15ce`, 2026-10-05]
<!-- /preserved:e-2053402522e64f38 -->

<a id="e-9aa62b10d0b1d5e4"></a>

## The tree. agents.parent_id is the only placement authority (no closure table, no

Original section: Transactions and locks. Source lines 4532–4537.

<!-- preserved:e-9aa62b10d0b1d5e4 -->
- **The tree.** `agents.parent_id` is the only placement authority (no closure table, no
  stored depth). A move checks cycles and the depth cap under its sorted locks, and a final
  lock-free assertion after the revision row catches any writer, raw SQL and `COPY`
  included. An agent's effective scope is computed from its current ancestors, so moving it
  back restores its configured scope. [decided: design rev 7.8; user 2026-10-04;
  [`pg-o1-move.md`](../../docs/state-system/pg-o1-move.md)]
<!-- /preserved:e-9aa62b10d0b1d5e4 -->

<a id="e-be13c585119ca3fe"></a>

## The admin connection (create, rename, drop databases) belongs only to

Original section: Transactions and locks. Source lines 4538–4540.

<!-- preserved:e-be13c585119ca3fe -->
- **The admin connection** (create, rename, drop databases) belongs only to
  `orgdb/lifecycle.py` in the engine host; a source-scan test enforces it. [decided: design
  Q10; verified: `tests/test_orgdb_static.py`]
<!-- /preserved:e-be13c585119ca3fe -->

<a id="e-15606c8a09b30a5f"></a>

## History must cost nothing

Original section: History must cost nothing. Source lines 4542–4542.

<!-- preserved:e-15606c8a09b30a5f -->
##### History must cost nothing
<!-- /preserved:e-15606c8a09b30a5f -->

<a id="e-c356ca25553037e2"></a>

## Performance tracks active data only: retired agents, archived tickets and read mail

Original section: History must cost nothing. Source lines 4544–4545.

<!-- preserved:e-c356ca25553037e2 -->
- **Performance tracks active data only:** retired agents, archived tickets and read mail
  must not slow anything down. [decided: user 2026-09-27]
<!-- /preserved:e-c356ca25553037e2 -->

<a id="e-2d53f92a0b615905"></a>

## Acceptance: with at least 10× inactive history, p95 at most 5% slower and engine memory

Original section: History must cost nothing. Source lines 4546–4548.

<!-- preserved:e-2d53f92a0b615905 -->
- **Acceptance:** with at least 10× inactive history, p95 at most 5% slower and engine memory
  at most 5% higher; for a lookup that still grows with history, at most 100 ms added at a
  simulated 5,000 agent-hours of history. [decided: user 2026-09-27, 2026-10-03]
<!-- /preserved:e-2d53f92a0b615905 -->

<a id="e-6d2587ee713472a6"></a>

## How: partial indexes over active rows only (live agents, open tickets, undelivered

Original section: History must cost nothing. Source lines 4549–4553.

<!-- preserved:e-6d2587ee713472a6 -->
- **How:** partial indexes over active rows only (live agents, open tickets, undelivered
  mail, queued jobs, open questions); archived rows are reached only by key or a `LIMIT`ed
  range; tests seed 10× history and require the same statement counts and rows read; the
  hot-path guards fail on a JSON predicate in a hot query or a sequential scan of a large
  table. [decided: §2.3; verified: `tests/test_orgdb_hot_paths_static.py`]
<!-- /preserved:e-6d2587ee713472a6 -->

<a id="e-1389c6e1bed3364c"></a>

## An agent's docket list totals count non-archived items only; an archived total comes only

Original section: History must cost nothing. Source lines 4554–4556.

<!-- preserved:e-1389c6e1bed3364c -->
- An agent's docket list totals count non-archived items only; an archived total comes only
  with `include_archived`. The desktop keeps its archived and backlog totals. [decided: user
  2026-10-02, decision 21]
<!-- /preserved:e-1389c6e1bed3364c -->

<a id="e-060e49d7c8167ba6"></a>

## Background work, the feed and turns

Original section: Background work, the feed and turns. Source lines 4558–4558.

<!-- preserved:e-060e49d7c8167ba6 -->
##### Background work, the feed and turns
<!-- /preserved:e-060e49d7c8167ba6 -->

<a id="e-eee60aa44be75269"></a>

## Panel records (B4c1): migration 0019 appends shared inbox/events and subscribed

Original section: Background work, the feed and turns. Source lines 4560–4565.

<!-- preserved:e-eee60aa44be75269 -->
- **Panel records (B4c1):** migration 0019 appends shared inbox/events and subscribed
  mailbox/history windows. Later panel migrations compose all earlier extensions through
  `orgdb/record_panel_sql.py`; never rewrite shipped 0018. Mail recipient-first ties and
  pending-delivery exclusion resolve read-only after the revision lock. Recipient sender
  enumeration uses indexed seeks, not DISTINCT over inactive mail history. [verified
  2026-10-05: `orgdb/record_panels.py`, `record_mail_sql.py`]
<!-- /preserved:e-eee60aa44be75269 -->

<a id="e-b7279ece311be6b9"></a>

## Every polling loop that reads org tables becomes a job row in the org database, written

Original section: Background work, the feed and turns. Source lines 4583–4586.

<!-- preserved:e-b7279ece311be6b9 -->
- **Every polling loop that reads org tables becomes a job row** in the org database, written
  by the transaction that creates the condition and claimed with `FOR UPDATE SKIP LOCKED`.
  Timers that read outside state (provider usage, update checks, the mail hub) stay timers
  in the engine host. [decided: user 2026-10-02 (Q9); §2.7]
<!-- /preserved:e-b7279ece311be6b9 -->

<a id="e-447469b3cc1dbb63"></a>

## The change feed (B4a implemented, 2026-10-05): each org database records its changes in the committing

Original section: Background work, the feed and turns. Source lines 4587–4592.

<!-- preserved:e-447469b3cc1dbb63 -->
- **The change feed** (B4a implemented, 2026-10-05): each org database records its changes in the committing
  transaction; revisions are handed out in commit order with no gaps; a cursor is
  `(org_uuid, incarnation, rev)`; baselines and catch-ups are single-snapshot reads, and the
  state at the frame's end revision decides. The desktop is the only audience; agents never
  use the websocket. [decided: §2.5;
  [`pg-step6-record-feed.md`](../../docs/state-system/pg-step6-record-feed.md)]
<!-- /preserved:e-447469b3cc1dbb63 -->

<a id="e-bceaa8dee93f8417"></a>

## Record-feed activation and commit ownership: advertise record_changes_v1 only

Original section: Background work, the feed and turns. Source lines 4593–4599.

<!-- preserved:e-bceaa8dee93f8417 -->
- **Record-feed activation and commit ownership:** advertise `record_changes_v1` only
  with orgdb enabled and migration 0018 present in the actual org snapshot. Statement
  capture reads OLD/NEW only; deferred SQL flush owns the sole revision increment.
  `on_save_commit` still finishes docket sources but never increments the revision.
  Parent/configured-scope subtree scopes expand in snapshot readers, never during commit.
  [verified-from-source 2026-10-05: `record_api.py`, `orgdb/record_sql.py`,
  `orgdb/record_tree.py`; [`pg-step6-record-feed.md`](../../docs/state-system/pg-step6-record-feed.md)]
<!-- /preserved:e-bceaa8dee93f8417 -->

<a id="e-4b56b3cb109acdf1"></a>

## Record runtime cache forecasts: expensive cache/startup-manifest previews run in

Original section: Background work, the feed and turns. Source lines 4600–4607.

<!-- preserved:e-4b56b3cb109acdf1 -->
- **Record runtime cache forecasts:** expensive cache/startup-manifest previews run in
  snapshot or coalesced background workers, never in loop-owned transitions. Keep live
  fields and HostClock stamps on the loop; fence forecast results by overlay identity,
  held membership and per-agent generation. Turn edges and expiry mark forecasts;
  stream frames and broad hub notifications do not. A 60-second worker refresh detects
  startup-file changes without org revisions. [verified-from-source 2026-10-05:
  `orgdb/record_host.py`, `orgdb/record_runtime.py`; decided: drag-opus 2026-10-05]
  See [worker ordering and warm-process distinction](../../docs/state-system/cache-forecast-workers.md).
<!-- /preserved:e-4b56b3cb109acdf1 -->

<a id="e-f2df1e7b6b0a8a6f"></a>

## Turn admission is machine-wide: at most N turns at once (a setting, default 16), first

Original section: Background work, the feed and turns. Source lines 4608–4611.

<!-- preserved:e-f2df1e7b6b0a8a6f -->
- **Turn admission is machine-wide:** at most N turns at once (a setting, default 16), first
  come first served within an org, round-robin across orgs; lowering the limit never stops
  a running turn; a queued agent's desk explains the limit. [decided: user 2026-09-26;
  verified: `turnslots.py`]
<!-- /preserved:e-f2df1e7b6b0a8a6f -->

<a id="e-ca996a5a4a4362b3"></a>

## A turn has a durable identity (a request row, then a ticket keyed by its id), numbered

Original section: Background work, the feed and turns. Source lines 4612–4614.

<!-- preserved:e-ca996a5a4a4362b3 -->
- **A turn has a durable identity** (a request row, then a ticket keyed by its id), numbered
  claims and process leases. A stale process can change nothing, and a slot is reused only
  after the old run is verified dead. [decided: §2.4]
<!-- /preserved:e-ca996a5a4a4362b3 -->

<a id="e-ca09cd0e24385f11"></a>

## "A turn cannot run while its agent is halted." Halt is not interrupt: it ends the turn,

Original section: Background work, the feed and turns. Source lines 4615–4617.

<!-- preserved:e-ca09cd0e24385f11 -->
- **"A turn cannot run while its agent is halted."** Halt is not interrupt: it ends the turn,
  closes every admission and delivery path, and keeps queued mail unread until an explicit
  unhalt. [decided: user 2026-09-12; [`docs/agent-halt.md`](../../docs/agent-halt.md)]
<!-- /preserved:e-ca09cd0e24385f11 -->

<a id="e-d3524af0d427fb29"></a>

## Automatic compaction admission retries graph Widen only after rollback, at most

Original section: Background work, the feed and turns. Source lines 4618–4622.

<!-- preserved:e-d3524af0d427fb29 -->
- **Automatic compaction admission** retries graph `Widen` only after rollback, at most
  three widenings with the complete expanded plan. Successor identity files, transcript
  export and success reporting happen only after commit. A terminal compaction error retires the current mail demand and
  names the engine failure even when turn recording is disabled. [verified 2026-10-05:
  `supervisor.py` `_run_admission_compaction`, `_run_one_turn_recorded`]
<!-- /preserved:e-d3524af0d427fb29 -->

<a id="e-0c900a33a0b1c9d2"></a>

## Turn time limits: a total ceiling (default 24 h) and a silence limit (default 10 min),

Original section: Background work, the feed and turns. Source lines 4623–4625.

<!-- preserved:e-0c900a33a0b1c9d2 -->
- **Turn time limits:** a total ceiling (default 24 h) and a silence limit (default 10 min),
  both configurable and disableable in App settings > Runtime. [decided: user 2026-10-02;
  verified: `appsettings.py`]
<!-- /preserved:e-0c900a33a0b1c9d2 -->

<a id="e-f238eaa6f9df1847"></a>

## Processes, privileges and startup

Original section: Processes, privileges and startup. Source lines 4627–4627.

<!-- preserved:e-f238eaa6f9df1847 -->
##### Processes, privileges and startup
<!-- /preserved:e-f238eaa6f9df1847 -->

<a id="e-3e1a0ad6cddf94d2"></a>

## Unelevated by default. The engine, PostgreSQL and agents run as the normal user;

Original section: Processes, privileges and startup. Source lines 4629–4633.

<!-- preserved:e-3e1a0ad6cddf94d2 -->
- **Unelevated by default.** The engine, PostgreSQL and agents run as the normal user;
  PostgreSQL refuses an administrator token. The only opt-in is "Run Orgtree as
  administrator", stored in HKLM and written through UAC, never in the data folder (agents
  can write there). [decided: user 2026-09-09, 2026-09-30; verified:
  `apps/desktop/main/runasadmin.ts`, `engine/service_host.py`]
<!-- /preserved:e-3e1a0ad6cddf94d2 -->

<a id="e-c161e8869e9a26a3"></a>

## The engine runs at Windows High priority so busy apps cannot starve it.

Original section: Processes, privileges and startup. Source lines 4634–4635.

<!-- preserved:e-c161e8869e9a26a3 -->
- **The engine runs at Windows High priority** so busy apps cannot starve it. [decided: user
  2026-10-04; verified: `engine/launch.py`]
<!-- /preserved:e-c161e8869e9a26a3 -->

<a id="e-9d955a0c1f890a25"></a>

## Untrusted output never gains privileges. Agent Markdown, HTML and presentations get no

Original section: Processes, privileges and startup. Source lines 4636–4639.

<!-- preserved:e-9d955a0c1f890a25 -->
- **Untrusted output never gains privileges.** Agent Markdown, HTML and presentations get no
  desktop bridge; the desktop token never reaches provider or MCP children; each agent's
  credential is bound to its org, node and generation. [decided: user 2026-09-05; engine
  contract]
<!-- /preserved:e-9d955a0c1f890a25 -->

<a id="e-358528565e3bb1da"></a>

## Agent children never inherit the engine's storage variables. A script an agent runs

Original section: Processes, privileges and startup. Source lines 4640–4643.

<!-- preserved:e-358528565e3bb1da -->
- **Agent children never inherit the engine's storage variables.** A script an agent runs
  must set its own throwaway `ORGTREE_DATA` before importing `store`, or the import raises.
  Bind it before importing any `orgtree` module (`store.DATA_ROOT` binds at import).
  [verified: `engine/backend/orgtree/devguard.py`]
<!-- /preserved:e-358528565e3bb1da -->

<a id="e-22157c966cc3a684"></a>

## Startup deadlines measure silence: 60 s for the desktop and 120 s for the boot host

Original section: Processes, privileges and startup. Source lines 4644–4648.

<!-- preserved:e-22157c966cc3a684 -->
- **Startup deadlines measure silence:** 60 s for the desktop and 120 s for the boot host
  between structured progress checkpoints; every migration and conversion step runs under a
  `database-convert…` phase with a one-hour window. Long startup work must emit checkpoints:
  alpha.1 died on this. [decided: user 2026-10-05; verified: `apps/desktop/main/policy.ts`,
  [`docs/startup-budget.md`](../../docs/startup-budget.md)]
<!-- /preserved:e-22157c966cc3a684 -->

<a id="e-357f14d55c77f487"></a>

## One failing org never stops the others. It becomes unavailable with its reason and a

Original section: Processes, privileges and startup. Source lines 4649–4651.

<!-- preserved:e-357f14d55c77f487 -->
- **One failing org never stops the others.** It becomes `unavailable` with its reason and a
  Retry; only a failure of the app database or of the accounts refuses the whole start.
  [decided: user 2026-10-02 (Q12); §2.12, §2.13]
<!-- /preserved:e-357f14d55c77f487 -->

<a id="e-efef587deabb5245"></a>

## Desktop and renderer

Original section: Desktop and renderer. Source lines 4653–4653.

<!-- preserved:e-efef587deabb5245 -->
##### Desktop and renderer
<!-- /preserved:e-efef587deabb5245 -->

<a id="e-1fdf4b7f89581e89"></a>

## Move previews preserve sibling order: native moves retain ui_order, creation

Original section: Desktop and renderer. Source lines 4673–4678.

<!-- preserved:e-1fdf4b7f89581e89 -->
- **Move previews preserve sibling order:** native moves retain `ui_order`, creation
  time and ordinal. Record projection and pending moves share the comparator in
  `treeorder.ts` (then Python Unicode name order); keep the tie-break fields on the
  projected node so row and circular previews match confirmation. [verified-from-source
  2026-10-06: `orgdb/native_move.py`, `orgdb/agents.py`, renderer `recordprojection.ts`,
  `canvas/shared.ts`]
<!-- /preserved:e-1fdf4b7f89581e89 -->

<a id="e-dd74013de10da9cf"></a>

## Local move refresh: after a successful move response is parsed, flush its

Original section: Desktop and renderer. Source lines 4679–4683.

<!-- preserved:e-dd74013de10da9cf -->
- **Local move refresh:** after a successful move response is parsed, flush its
  pending livebus bump on the next task and cancel the delayed duplicate. Other mutations
  and later events retain 120 ms coalescing. Initial loading and record/runtime
  ordering are unchanged. [verified-from-source 2026-10-06: renderer `api.ts`,
  `livebus.ts`, `move-refresh.test.ts`; recorded-decision: move-latency item]
<!-- /preserved:e-dd74013de10da9cf -->

<a id="e-b17ce1feb69ca774"></a>

## Circular layout order: in the circular org chart, siblings (rings, the agents list and

Original section: Desktop and renderer. Source lines 4685–4691.

<!-- preserved:e-b17ce1feb69ca774 -->
- **Circular layout order:** in the circular org chart, siblings (rings, the agents list and
  the floating jump cards) follow tree order counterclockwise; never sort them by x/y
  position. Only the row layout orders siblings by position. Jump-card adjacency uses
  this order, but each card's side uses its neighbour's screen centre relative to the
  focused agent. Placement avoids the measured navigation HUD, including the card's
  expanded hover/focus width. [verified: `apps/desktop/renderer/src/canvas/OrgCanvas.tsx`,
  `canvas/shared.ts`, 2026-10-05]
<!-- /preserved:e-b17ce1feb69ca774 -->

<a id="e-fabb28e553218b52"></a>

## Window bounds at fractional DPI: Windows can add an invisible frame allowance to a

Original section: Desktop and renderer. Source lines 4705–4710.

<!-- preserved:e-fabb28e553218b52 -->
- **Window bounds at fractional DPI:** Windows can add an invisible frame allowance to a
  frameless window's size, even through `setBounds`, and Electron's `did-create-window` does
  not carry the original window features. Temporary desks pass their exact rectangle and
  `setExactPopoutBounds` measures and corrects the real bounds; pinning uses the modal's
  outer rectangle, and pop-out ends the modal only after the window adopts the desk.
  [verified: `apps/desktop/main/windows.ts`, `canvas/tempdesk.tsx`, `6e53697`, 2026-10-05]
<!-- /preserved:e-fabb28e553218b52 -->

<a id="e-4c8b5b4b573dd7f1"></a>

## CSS app-region is inherited, and only initial stops it (unset and none do not):

Original section: Desktop and renderer. Source lines 4711–4713.

<!-- preserved:e-4c8b5b4b573dd7f1 -->
- **CSS `app-region` is inherited,** and only `initial` stops it (`unset` and `none` do not):
  scrolled-out no-drag children once punched holes in the header's drag region. [verified:
  `apps/desktop/renderer/src/styles.css`]
<!-- /preserved:e-4c8b5b4b573dd7f1 -->

<a id="e-334be6d41c4e6d21"></a>

## jsdom does no layout. Geometry, drag regions and native window behaviour need the

Original section: Desktop and renderer. Source lines 4714–4716.

<!-- preserved:e-334be6d41c4e6d21 -->
- **jsdom does no layout.** Geometry, drag regions and native window behaviour need the
  Electron probes (`tools/test-*.mjs`), not renderer unit tests. [verified:
  [`docs/verification-recipes.md`](../../docs/verification-recipes.md)]
<!-- /preserved:e-334be6d41c4e6d21 -->

<a id="e-e10014dd52fcebe9"></a>

## Product rulings

Original section: Product rulings. Source lines 4725–4725.

<!-- preserved:e-e10014dd52fcebe9 -->
#### Product rulings
<!-- /preserved:e-e10014dd52fcebe9 -->

<a id="e-686453bbc559f38a"></a>

## The user's standing rulings about how Orgtree behaves. The older ones (up to 2026-09-15)

Original section: Product rulings. Source lines 4729–4731.

<!-- preserved:e-686453bbc559f38a -->
The user's standing rulings about how Orgtree behaves. The older ones (up to 2026-09-15)
are recorded in full in [`docs/v2-user-decisions.md`](../../docs/v2-user-decisions.md); new
rulings go here and on their ticket.
<!-- /preserved:e-686453bbc559f38a -->

<a id="e-3f4a1233215d38db"></a>

## Org, agents and topology

Original section: Org, agents and topology. Source lines 4733–4733.

<!-- preserved:e-3f4a1233215d38db -->
##### Org, agents and topology
<!-- /preserved:e-3f4a1233215d38db -->

<a id="e-cf8f05012f74aca6"></a>

## Scope containment: a child's folders, tools and visibility always lie within its

Original section: Org, agents and topology. Source lines 4735–4738.

<!-- preserved:e-cf8f05012f74aca6 -->
- **Scope containment:** a child's folders, tools and visibility always lie within its
  parent's. Moving an agent pauses audiences whose anchor is no longer an ancestor and
  restores them if it moves back; an explicit revoke is permanent; the move result is a
  short summary, and running turns finish. [decided: user 2026-09-12, 2026-10-04]
<!-- /preserved:e-cf8f05012f74aca6 -->

<a id="e-b51a68da1adb841d"></a>

## swap, subjugate and move_batch stay agent-only, with no operator door.

Original section: Org, agents and topology. Source lines 4739–4742.

<!-- preserved:e-b51a68da1adb841d -->
- `swap`, `subjugate` and `move_batch` stay agent-only, with no operator door.
  `self_subjugate` is a subtree promotion: the target rises with its own team, its team
  charter does not transfer, and grants are untouched. Inserting a superior has one
  implementation (`insert_parent`). [decided: user 2026-09-12, 2026-09-15]
<!-- /preserved:e-b51a68da1adb841d -->

<a id="e-9c9e4b0dee8fbe96"></a>

## Credits: grants are whole credits (rounded up when a raise saturates a superior);

Original section: Org, agents and topology. Source lines 4743–4745.

<!-- preserved:e-9c9e4b0dee8fbe96 -->
- **Credits:** grants are whole credits (rounded up when a raise saturates a superior);
  seats may be fractional with a 0.10 floor; "a promo never sets a seat"; the user is the
  root with unlimited credit. [decided: user 2026-09-03, 2026-09-04]
<!-- /preserved:e-9c9e4b0dee8fbe96 -->

<a id="e-12c262ac1e5a27f6"></a>

## Retiring keeps history, and rehire restores the agent. Retire, dissolve and compaction

Original section: Org, agents and topology. Source lines 4746–4747.

<!-- preserved:e-12c262ac1e5a27f6 -->
- Retiring keeps history, and rehire restores the agent. Retire, dissolve and compaction
  stop an agent's background tasks. [decided: user 2026-09-29]
<!-- /preserved:e-12c262ac1e5a27f6 -->

<a id="e-2e8c3efa8f0b52f7"></a>

## Turns, mail and notices

Original section: Turns, mail and notices. Source lines 4749–4749.

<!-- preserved:e-2e8c3efa8f0b52f7 -->
##### Turns, mail and notices
<!-- /preserved:e-2e8c3efa8f0b52f7 -->

<a id="e-d2db0cf073478e44"></a>

## Delivering a message never interrupts a turn; only an explicit interrupt does. Mid-turn

Original section: Turns, mail and notices. Source lines 4751–4755.

<!-- preserved:e-d2db0cf073478e44 -->
- Delivering a message never interrupts a turn; only an explicit interrupt does. Mid-turn
  mail arrives at the next safe tool boundary or at the turn's result boundary. An accepted
  message is injected once or queued, never neither; "delivered" is final only when the
  provider transcript shows it. [decided: user 2026-09-03, 2026-09-05;
  [`docs/mail-delivery-boundaries.md`](../../docs/mail-delivery-boundaries.md)]
<!-- /preserved:e-d2db0cf073478e44 -->

<a id="e-ab4d0a862afed035"></a>

## Notices never start a turn. Status reports (orgtree_status) arrive as passive notices;

Original section: Turns, mail and notices. Source lines 4756–4757.

<!-- preserved:e-ab4d0a862afed035 -->
- Notices never start a turn. Status reports (`orgtree_status`) arrive as passive notices;
  anything that needs action is a question. [decided: user 2026-10-03]
<!-- /preserved:e-ab4d0a862afed035 -->

<a id="e-23a54ad81a0a8312"></a>

## Unrecorded hook claims are released at startup after transcript reconciliation

Original section: Turns, mail and notices. Source lines 4758–4763.

<!-- preserved:e-23a54ad81a0a8312 -->
- Unrecorded hook claims are released at startup after transcript reconciliation
  and proof that their engines and children ended. Failed steer-fetch commits
  restore FIFO carriers; pump lock timeouts retry. Inbox fetch reads inflight
  content through a chunk handle without changing its delivery owner.
  [verified 2026-10-05: `mailruntime.py`, `supervisor.py`, `inbox.py`;
  details: `docs/mail-delivery-boundaries.md`]
<!-- /preserved:e-23a54ad81a0a8312 -->

<a id="e-ebef170cabe09157"></a>

## A mid-turn model switch is queued for the next turn (an interrupt applies it at once). A

Original section: Turns, mail and notices. Source lines 4764–4766.

<!-- preserved:e-ebef170cabe09157 -->
- A mid-turn model switch is queued for the next turn (an interrupt applies it at once). A
  switch to another provider is a lineage split and asks for confirmation. [decided: user
  2026-08-29, 2026-09-03]
<!-- /preserved:e-ebef170cabe09157 -->

<a id="e-f4ddc5b78b8ea114"></a>

## Warm processes: one parked CLI per live agent, started at boot and on hire; no idle reaper

Original section: Turns, mail and notices. Source lines 4767–4768.

<!-- preserved:e-f4ddc5b78b8ea114 -->
- Warm processes: one parked CLI per live agent, started at boot and on hire; no idle reaper
  or cap; warming is a user setting, on by default. [decided: user 2026-08-30, 2026-09-26]
<!-- /preserved:e-f4ddc5b78b8ea114 -->

<a id="e-57b22e79f6fd55a5"></a>

## After a crash or restart, agents that were mid-turn resume with session continuity, and

Original section: Turns, mail and notices. Source lines 4769–4770.

<!-- preserved:e-57b22e79f6fd55a5 -->
- After a crash or restart, agents that were mid-turn resume with session continuity, and
  uncertain tool results are reconciled, never repeated. [decided: user 2026-09-07]
<!-- /preserved:e-57b22e79f6fd55a5 -->

<a id="e-85049c25eb1366bf"></a>

## Docket, questions and attention

Original section: Docket, questions and attention. Source lines 4785–4785.

<!-- preserved:e-85049c25eb1366bf -->
##### Docket, questions and attention
<!-- /preserved:e-85049c25eb1366bf -->

<a id="e-b851648f02c40f26"></a>

## A ticket is identified only by its readable slug. Its description states the problem

Original section: Docket, questions and attention. Source lines 4787–4789.

<!-- preserved:e-b851648f02c40f26 -->
- A ticket is identified only by its readable slug. Its description states the problem
  first, then the solution, and is its authoritative scope; decisions are append-only.
  Assignment is ownership. [decided: user 2026-09-05, 2026-09-12]
<!-- /preserved:e-b851648f02c40f26 -->

<a id="e-fb5d8c5a61cfbd75"></a>

## review means review by agents. The user is reached through an attached question or the

Original section: Docket, questions and attention. Source lines 4790–4793.

<!-- preserved:e-fb5d8c5a61cfbd75 -->
- `review` means review by agents. The user is reached through an attached question or the
  attention flag, which stays up until the user replies or dismisses it or an agent takes
  it down explicitly; a dismissal moves the ticket to `blocked`. [decided: user 2026-09-05,
  2026-09-19]
<!-- /preserved:e-fb5d8c5a61cfbd75 -->

<a id="e-31677f6c1c895295"></a>

## Dropped tickets archive at once; done tickets an hour after their last update. There is

Original section: Docket, questions and attention. Source lines 4794–4797.

<!-- preserved:e-31677f6c1c895295 -->
- Dropped tickets archive at once; done tickets an hour after their last update. There is
  no `waiting` status; `blocked` states its reason. Over-long fields are refused, never cut.
  An item's earlier holders are readable only while you are listed on it. [decided: user
  2026-09-04 to 2026-09-16]
<!-- /preserved:e-31677f6c1c895295 -->

<a id="e-f4968e51da200f5e"></a>

## These rules are written into the managed agent instructions in supervisor.py. Editing

Original section: Docket, questions and attention. Source lines 4798–4799.

<!-- preserved:e-f4968e51da200f5e -->
- These rules are written into the managed agent instructions in `supervisor.py`. Editing
  those strings changes every agent's cached prompt, so batch such changes and say so.
<!-- /preserved:e-f4968e51da200f5e -->

<a id="e-9914c59ebc94e1f5"></a>

## Providers, accounts and usage

Original section: Providers, accounts and usage. Source lines 4801–4801.

<!-- preserved:e-9914c59ebc94e1f5 -->
##### Providers, accounts and usage
<!-- /preserved:e-9914c59ebc94e1f5 -->

<a id="e-089b72951ff77ea8"></a>

## Provider, model, harness, account and route are separate concepts, and provider

Original section: Providers, accounts and usage. Source lines 4803–4804.

<!-- preserved:e-089b72951ff77ea8 -->
- Provider, model, harness, account and route are separate concepts, and provider
  differences are shown honestly. [decided: user 2026-09-05]
<!-- /preserved:e-089b72951ff77ea8 -->

<a id="e-f35911d33eb20e25"></a>

## Accounts are machine-wide and symmetric (any org may use any account), except legacy

Original section: Providers, accounts and usage. Source lines 4805–4811.

<!-- preserved:e-f35911d33eb20e25 -->
- Accounts are machine-wide and symmetric (any org may use any account), except legacy
  org-key accounts, which keep their origin org. Account ids are immutable; the primary
  account shows as `default`. An account at its limit waits; fallback to another account is
  opt-in per agent (off by default) and keeps the new account; API-key accounts are an
  off-by-default last resort. Agents choose the account on hire, rehire, retool and staff;
  usage readings guide them but are never a server-side admission gate. [decided: user
  2026-09-07 to 2026-09-12; [`docs/v2-user-decisions.md`](../../docs/v2-user-decisions.md)]
<!-- /preserved:e-f35911d33eb20e25 -->

<a id="e-19adbaa90daa849b"></a>

## A provider that is not installed is absent from the UI; installed but signed out shows

Original section: Providers, accounts and usage. Source lines 4844–4847.

<!-- preserved:e-19adbaa90daa849b -->
- A provider that is not installed is absent from the UI; installed but signed out shows
  greyed hire tokens; a disabled provider refuses new hires while live agents keep running.
  Legacy models (Terra, Gemini Pro) appear only with "Show legacy models". [decided: user
  2026-08-30, 2026-09-30]
<!-- /preserved:e-19adbaa90daa849b -->

<a id="e-3898c44fbc17f6fb"></a>

## Desktop UI

Original section: Desktop UI. Source lines 4865–4865.

<!-- preserved:e-3898c44fbc17f6fb -->
##### Desktop UI
<!-- /preserved:e-3898c44fbc17f6fb -->

<a id="e-9c8b1fc1649dc4b1"></a>

## Performance comes before UI work; keep and improve the existing layout rather than

Original section: Desktop UI. Source lines 4867–4868.

<!-- preserved:e-9c8b1fc1649dc4b1 -->
- Performance comes before UI work; keep and improve the existing layout rather than
  redesigning it. [decided: user 2026-09-07, 2026-09-26]
<!-- /preserved:e-9c8b1fc1649dc4b1 -->

<a id="e-938dbdf0ad826b39"></a>

## Every app-generated time is shown in the user's local time zone; no visible UTC.

Original section: Desktop UI. Source lines 4869–4870.

<!-- preserved:e-938dbdf0ad826b39 -->
- Every app-generated time is shown in the user's local time zone; no visible UTC.
  [decided: user 2026-09-04]
<!-- /preserved:e-938dbdf0ad826b39 -->

<a id="e-0d45f90df4eca5a5"></a>

## One main window per org; opening an open org focuses it; startup restores the previous

Original section: Desktop UI. Source lines 4871–4873.

<!-- preserved:e-0d45f90df4eca5a5 -->
- One main window per org; opening an open org focuses it; startup restores the previous
  windows; a saved window whose org is gone opens as an error window. Pinned means pinned.
  [decided: user 2026-09-04, 2026-09-21]
<!-- /preserved:e-0d45f90df4eca5a5 -->

<a id="e-7ccf4b6a79900f27"></a>

## Installer, updates and data

Original section: Installer, updates and data. Source lines 4879–4879.

<!-- preserved:e-7ccf4b6a79900f27 -->
##### Installer, updates and data
<!-- /preserved:e-7ccf4b6a79900f27 -->

<a id="e-468e519ea39c01ec"></a>

## PostgreSQL ships inside the installer, with its data under &lt;data&gt;\pg. Uninstall keeps

Original section: Installer, updates and data. Source lines 4881–4883.

<!-- preserved:e-468e519ea39c01ec -->
- PostgreSQL ships inside the installer, with its data under `<data>\pg`. Uninstall keeps
  data and history; history, documents and work records are kept until the user removes
  them. [decided: user 2026-09-07, 2026-09-26]
<!-- /preserved:e-468e519ea39c01ec -->

<a id="e-a65c5774f2b97b9b"></a>

## Automatic updates (on by default) check in the background and install only at a safe idle

Original section: Installer, updates and data. Source lines 4884–4886.

<!-- preserved:e-a65c5774f2b97b9b -->
- Automatic updates (on by default) check in the background and install only at a safe idle
  point (engine idle plus 60 s of user inactivity), never interrupting a turn. [decided: user
  2026-09-07; verified: `README.md`]
<!-- /preserved:e-a65c5774f2b97b9b -->

<a id="e-f495232d8cb87e45"></a>

## An upgrade never modifies the old data: the legacy database and files are kept for one

Original section: Installer, updates and data. Source lines 4887–4890.

<!-- preserved:e-f495232d8cb87e45 -->
- An upgrade never modifies the old data: the legacy database and files are kept for one
  release, so rolling back means running the old build again (from 2.1.14, also move
  `pre-postgres/orgs` back). 3.2.0 never touches the old org markers in `orgs/`. [decided:
  design §3.9, §5.3]
<!-- /preserved:e-f495232d8cb87e45 -->

<a id="e-633ee0e230c60afb"></a>

## Development workflow

Original section: Development workflow. Source lines 4892–4892.

<!-- preserved:e-633ee0e230c60afb -->
#### Development workflow
<!-- /preserved:e-633ee0e230c60afb -->

<a id="e-e4e46229e3276147"></a>

## x Python engine — legacy (branch dev, P03 lock, test baseline, Python runner, source audits, push and ls-remote). For 4.

Original section: Development workflow. Source lines 4894–4894.

<!-- preserved:e-e4e46229e3276147 -->
> **3.x Python engine — legacy** (branch `dev`, P03 lock, test baseline, Python runner, source audits, push and ls-remote). For 4.0.0: local `rust-engine` branch, hand-in through the coordinator, no unit-test suites, never push — see the 4.0.0 section. (2026-10-06)
<!-- /preserved:e-e4e46229e3276147 -->

<a id="e-169809c0b4e4aaf5"></a>

## Branches and worktrees

Original section: Branches and worktrees. Source lines 4896–4896.

<!-- preserved:e-169809c0b4e4aaf5 -->
##### Branches and worktrees
<!-- /preserved:e-169809c0b4e4aaf5 -->

<a id="e-b7eceb4a810f7abf"></a>

## Development branch changed to dev on 2026-10-05, created from v3.

Original section: Branches and worktrees. Source lines 4898–4900.

<!-- preserved:e-b7eceb4a810f7abf -->
- **Development branch changed to `dev`** on 2026-10-05, created from v3.
  `v3/3.0.0-alpha.0` is frozen at `318fc45`; never push new work there.
  [decided: user 2026-10-05; verified: coordinator-confirmed remote refs]
<!-- /preserved:e-b7eceb4a810f7abf -->

<a id="e-701fedad4cbd4ea2"></a>

## All work lands on dev by fast-forward. main is moved to dev at each

Original section: Branches and worktrees. Source lines 4902–4905.

<!-- preserved:e-701fedad4cbd4ea2 -->
- All work lands on `dev` by fast-forward. `main` is moved to `dev` at each
  release, and releases are cut from it; the user's README-only commits go to `main` first
  and are cherry-picked to `dev`. 2.x maintenance lives on `release/2.x`. [decided: team
  charter; user 2026-09-30; verified: [`docs/windows-release.md`](../../docs/windows-release.md)]
<!-- /preserved:e-701fedad4cbd4ea2 -->

<a id="e-6191464dbd2c499c"></a>

## Worktrees: python tools/worktree.py addverifyremove; remove refuses when it finds a

Original section: Branches and worktrees. Source lines 4906–4909.

<!-- preserved:e-6191464dbd2c499c -->
- Worktrees: `python tools/worktree.py add|verify|remove`; `remove` refuses when it finds a
  link leading out of the worktree. Settle overlapping files with the agent whose ticket
  owns them; never edit another agent's files. [verified:
  [`docs/worktree-operations.md`](../../docs/worktree-operations.md); decided: team charter]
<!-- /preserved:e-6191464dbd2c499c -->

<a id="e-c38f86e06d76d7c3"></a>

## Tests

Original section: Tests. Source lines 4911–4911.

<!-- preserved:e-c38f86e06d76d7c3 -->
##### Tests
<!-- /preserved:e-c38f86e06d76d7c3 -->

<a id="e-84f2133727d0852f"></a>

## Renderer app-feed fixtures: legacy HTTP mocks must explicitly return 501 for

Original section: Tests. Source lines 4913–4917.

<!-- preserved:e-84f2133727d0852f -->
- **Renderer app-feed fixtures:** legacy HTTP mocks must explicitly return 501 for
  /api/app/records via legacyAppBackend; a generic 200 is not an unsupported engine.
  Capable fixtures send an app socket baseline and runtime frames, including values
  arriving after an empty baseline. [verified 2026-10-06: appfeed-fixture.ts,
  appvalues.test.tsx, packages/contracts/app-feed-connection.ts]
<!-- /preserved:e-84f2133727d0852f -->

<a id="e-3faa34277ad919be"></a>

## Python: python tools/run-python-verification.py tests/test_X.py [...] gives each module

Original section: Tests. Source lines 4920–4927.

<!-- preserved:e-3faa34277ad919be -->
- **Python:** `python tools/run-python-verification.py tests/test_X.py [...]` gives each module
  a fresh interpreter in isolated mode and a fresh `ORGTREE_DATA`, with a 300 s default
  timeout per module (`--timeout`). Compare `failed_tests` names between base and tip. A
  worktree has no `engine/runtime`; the runner finds the main checkout's interpreter by
  walking up, and anything else should use that interpreter (or
  `npm run runtime:stage -- --from <checkout>`). PostgreSQL tests skip unless
  `ORGTREE_TEST_PG_ADMIN_URL` is set: a skip is not a pass. Spawn child processes with
  `tests/child_python.argv`. [verified]
<!-- /preserved:e-3faa34277ad919be -->

<a id="e-ed91b2bebcd52625"></a>

## Node and renderer: npm test (root tests/.test.mjs), npm run test:renderer

Original section: Tests. Source lines 4928–4933.

<!-- preserved:e-ed91b2bebcd52625 -->
- **Node and renderer:** `npm test` (root `tests/*.test.mjs`), `npm run test:renderer`
  (`apps/desktop/renderer/tests/run.mjs`, whose filters are substrings and OR together),
  `npm run typecheck`; keep `ORGTREE_TEST_CONCURRENCY=4`. Also run any renderer count or
  inventory test your change could affect. `run.mjs --output DIR` creates a `node_modules`
  junction inside DIR, so never point it into a worktree; `--prebuilt DIR` creates none.
  [verified: `package.json`, `apps/desktop/renderer/tests/run.mjs`]
<!-- /preserved:e-ed91b2bebcd52625 -->

<a id="e-3f0aac84fb01f899"></a>

## The PostgreSQL subtree renderer test runs only when its Python parent supplies

Original section: Tests. Source lines 4934–4936.

<!-- preserved:e-3f0aac84fb01f899 -->
- The PostgreSQL subtree renderer test runs only when its Python parent supplies
  `ORGTREE_RECORD_SUBTREE_FIXTURE`; plain renderer runs skip it. [verified 2026-10-05:
  `apps/desktop/renderer/tests/recordpgsubtree.test.ts`, `tests/test_orgdb_record_subtree_pg.py`]
<!-- /preserved:e-3f0aac84fb01f899 -->

<a id="e-1408999218a12d6a"></a>

## The baseline: node tools/test-baseline.mjs show (or npm run test:known-failures)

Original section: Tests. Source lines 4937–4940.

<!-- preserved:e-1408999218a12d6a -->
- **The baseline:** `node tools/test-baseline.mjs show` (or `npm run test:known-failures`)
  lists known failures and runs nothing. `compare` and `record`, `npm run test:compare`,
  `npm run test:baseline:record`, `npm run verify:release` and `npm run release:windows`
  all run the full suites: coordinator or release owner only. [decided: user 2026-09-26]
<!-- /preserved:e-1408999218a12d6a -->

<a id="e-1174a32d265dec62"></a>

## Per landing: run only the modules your change touches, at base and tip, each call under

Original section: Tests. Source lines 4941–4943.

<!-- preserved:e-1174a32d265dec62 -->
- **Per landing:** run only the modules your change touches, at base and tip, each call under
  20 minutes; land if no new test name fails. After a rebase that only moved the base,
  re-run only tests touching files that changed on `dev` in between. [decided: team charter]
<!-- /preserved:e-1174a32d265dec62 -->

<a id="e-6b335a716b0c22e9"></a>

## The machine lock: one heavy run at a time on the whole machine (scale runs,

Original section: Tests. Source lines 4944–4950.

<!-- preserved:e-6b335a716b0c22e9 -->
- **The machine lock:** one heavy run at a time on the whole machine (scale runs,
  rehearsals, database batches, and any test stream that creates or drops PostgreSQL
  databases: each `DROP DATABASE` waits for a checkpoint, and two such streams stalled the
  cluster on 2026-10-02; concurrent suite runs crashed the machine on 2026-09-18). Use
  `tools/p03-run.ps1 -Agent <you> -Wait -Run @('python', '<script>', ...)`; `-Status`
  prints JSON; `-Small` allows two small runs; `-Dequeue` drops all of your entries.
  [decided: team charter; verified: `tools/p03-run.ps1`]
<!-- /preserved:e-6b335a716b0c22e9 -->

<a id="e-94d90ce067585c9f"></a>

## Memory (this machine): start a run only with 15 GB of free commit memory and stop below

Original section: Tests. Source lines 4951–4953.

<!-- preserved:e-94d90ce067585c9f -->
- **Memory (this machine):** start a run only with 15 GB of free commit memory and stop below
  10 GB; a single static source-scan module may start at 10 GB (`-MinFreeCommitGB 10`). Wait
  with `-Wait` or a watchdog, not by polling. [decided: team charter]
<!-- /preserved:e-94d90ce067585c9f -->

<a id="e-eb5b3096c9203b67"></a>

## Your own PostgreSQL cluster: drive E: syncs slowly (about 3 s per fsync, 2026-10-03), so

Original section: Tests. Source lines 4954–4958.

<!-- preserved:e-eb5b3096c9203b67 -->
- **Your own PostgreSQL cluster:** drive E: syncs slowly (about 3 s per fsync, 2026-10-03), so
  set `fsync`, `synchronous_commit` and `full_page_writes` to `off` on your own disposable
  cluster only, never the live one or anyone else's. The live-data copy
  (`artifacts/livecopy-20261002/`) loads only into such a cluster under the lock; drop the
  databases afterwards and never commit or copy it. [decided: team charter]
<!-- /preserved:e-eb5b3096c9203b67 -->

<a id="e-53fe61d0eff94eb0"></a>

## Risky code (locking, transactions, leases, queues, data import, halt, the killswitch):

Original section: Tests. Source lines 4959–4962.

<!-- preserved:e-53fe61d0eff94eb0 -->
- **Risky code** (locking, transactions, leases, queues, data import, halt, the killswitch):
  reviewers break the code on purpose and check that a test fails ("mutants"); race fixes
  come with two-session barrier tests; `org_tx` silently retries deadlock victims, so race
  tests run with retries off. [decided: team charter; design §9]
<!-- /preserved:e-53fe61d0eff94eb0 -->

<a id="e-9a8992eb8974885d"></a>

## Reviews and landing

Original section: Reviews and landing. Source lines 4964–4964.

<!-- preserved:e-9a8992eb8974885d -->
##### Reviews and landing
<!-- /preserved:e-9a8992eb8974885d -->

<a id="e-3dd68e9b5d33c15a"></a>

## An independent reviewer records approve_stage on your exact commit; the coordinator

Original section: Reviews and landing. Source lines 4966–4967.

<!-- preserved:e-3dd68e9b5d33c15a -->
1. An independent reviewer records `approve_stage` on your exact commit; the coordinator
   grants the landing (often pre-granted in the ticket). The reviewer never lands.
<!-- /preserved:e-3dd68e9b5d33c15a -->

<a id="e-180003e8c7ca96e3"></a>

## Rebase onto the current dev and check git range-diff (all =, or explain each !).

Original section: Reviews and landing. Source lines 4968–4968.

<!-- preserved:e-180003e8c7ca96e3 -->
2. Rebase onto the current `dev` and check `git range-diff` (all `=`, or explain each `!`).
<!-- /preserved:e-180003e8c7ca96e3 -->

<a id="e-be2798b46eea91d7"></a>

## Re-run your targeted tests, then python tools/source-audits.py (about a minute, no

Original section: Reviews and landing. Source lines 4969–4976.

<!-- preserved:e-be2798b46eea91d7 -->
3. Re-run your targeted tests, then `python tools/source-audits.py` (about a minute, no
   database): the one import-guard line in every test module, hub isolation, the
   child-spawn allowlist, duplicate definitions and BOMs, and the native vector anchors. If
   you changed `ledger.py`, `api.py`, `agentauth.py`, `openrouter.py` or `opreceipts.py`, run
   the affected crate's vector test; regenerate with the main checkout's
   `engine\runtime\python.exe engine/native/<crate>/oracle/generate_vectors.py --write`
   only if it fails on the anchors alone. Any other difference means an encoded rule
   changed: stop and find out why. [verified: `tools/source-audits.py`]
<!-- /preserved:e-be2798b46eea91d7 -->

<a id="e-e391799dacd73fcb"></a>

## Fast-forward push (git push origin HEAD:refs/heads/dev), then put the

Original section: Reviews and landing. Source lines 4977–4980.

<!-- preserved:e-e391799dacd73fcb -->
4. Fast-forward push (`git push origin HEAD:refs/heads/dev`), then put the
   `git ls-remote origin refs/heads/dev` output in your claim note. The
   docket's `pushed` claim checks the installed app, not this repo, so it refuses; record
   the ls-remote line as evidence instead. [decided: coordinator 2026-10-03]
<!-- /preserved:e-e391799dacd73fcb -->

<a id="e-ce97f1fdd6f64f72"></a>

## Update this file if you found a gotcha, an invariant or a ruling.

Original section: Reviews and landing. Source lines 4981–4981.

<!-- preserved:e-ce97f1fdd6f64f72 -->
5. Update this file if you found a gotcha, an invariant or a ruling.
<!-- /preserved:e-ce97f1fdd6f64f72 -->

<a id="e-bce4b476bff50a3d"></a>

## Never rewrite pushed history or force-push.

Original section: Reviews and landing. Source lines 4983–4983.

<!-- preserved:e-bce4b476bff50a3d -->
Never rewrite pushed history or force-push. [decided: team charter; user 2026-10-03]
<!-- /preserved:e-bce4b476bff50a3d -->

<a id="e-4fdd08ec9b1019e1"></a>

## Evidence and reporting

Original section: Evidence and reporting. Source lines 4985–4985.

<!-- preserved:e-4fdd08ec9b1019e1 -->
##### Evidence and reporting
<!-- /preserved:e-4fdd08ec9b1019e1 -->

<a id="e-131427ac7ed45ab4"></a>

## Label every claim measured (you ran it and saw it) or inferred. Quote the module's own

Original section: Evidence and reporting. Source lines 4987–4988.

<!-- preserved:e-131427ac7ed45ab4 -->
- Label every claim measured (you ran it and saw it) or inferred. Quote the module's own
  `Ran N tests … OK` line; treat zero executed tests as "did not run".
<!-- /preserved:e-131427ac7ed45ab4 -->

<a id="e-d6420b69da372727"></a>

## Check that a control can fail: plant the fault, see red, restore. A guard that passes with

Original section: Evidence and reporting. Source lines 4989–4990.

<!-- preserved:e-d6420b69da372727 -->
- Check that a control can fail: plant the fault, see red, restore. A guard that passes with
  the guard removed is worthless.
<!-- /preserved:e-d6420b69da372727 -->

<a id="e-e57287c1ef0c4d54"></a>

## Keep breadcrumbs.md in your scratch folder current; it is what a successor reads.

Original section: Evidence and reporting. Source lines 4991–4991.

<!-- preserved:e-e57287c1ef0c4d54 -->
- Keep `breadcrumbs.md` in your scratch folder current; it is what a successor reads.
<!-- /preserved:e-e57287c1ef0c4d54 -->

<a id="e-6ccb779c85bc3c53"></a>

## Crash forensics: the engine logs to &lt;data&gt;\diagnostics\engine.log (with

Original section: Evidence and reporting. Source lines 4992–4996.

<!-- preserved:e-6ccb779c85bc3c53 -->
- Crash forensics: the engine logs to `<data>\diagnostics\engine.log` (with
  `engine-stall-stacks.txt` and `engine-liveness.jsonl` beside it); for a silent death,
  check the Windows event log, `update-log.json` (updater and installer) and
  `Crashpad\reports\` (Electron). The hardware has a history of memory faults: consider that
  only after the ordinary causes. [verified: `engine/enginelog.py`, `engine/stall_watch.py`]
<!-- /preserved:e-6ccb779c85bc3c53 -->

<a id="e-09f5223553b01ead"></a>

## Releases, builds and updates

Original section: Releases, builds and updates. Source lines 4998–4998.

<!-- preserved:e-09f5223553b01ead -->
#### Releases, builds and updates
<!-- /preserved:e-09f5223553b01ead -->

<a id="e-d73be7b363cb7b63"></a>

## x — legacy. 4.0.0 prototype builds (4.0.0-alpha.N) are built and installed by the user only (DECISIONS 37–38). (2026-10-

Original section: Releases, builds and updates. Source lines 5000–5000.

<!-- preserved:e-d73be7b363cb7b63 -->
> **3.x — legacy.** 4.0.0 prototype builds (`4.0.0-alpha.N`) are built and installed by the user only ([DECISIONS 37–38](../../docs/rust-engine/DECISIONS.md)). (2026-10-06)
<!-- /preserved:e-d73be7b363cb7b63 -->

<a id="e-0c3036a38ac7d2b8"></a>

## Only the coordinator and the release owner it names build, tag, publish or install.

Original section: Releases, builds and updates. Source lines 5002–5003.

<!-- preserved:e-0c3036a38ac7d2b8 -->
- Only the coordinator and the release owner it names build, tag, publish or install.
  [decided: team charter]
<!-- /preserved:e-0c3036a38ac7d2b8 -->

<a id="e-1589781cb2e60267"></a>

## No build or publish until the whole 3.2.0 rewrite has landed, apart from local alpha

Original section: Releases, builds and updates. Source lines 5004–5005.

<!-- preserved:e-1589781cb2e60267 -->
- **No build or publish until the whole 3.2.0 rewrite has landed**, apart from local alpha
  builds for the user. [decided: user 2026-10-02]
<!-- /preserved:e-1589781cb2e60267 -->

<a id="e-6dbff5c4b979ba41"></a>

## Alphas are local and never published: no tag, no GitHub release, no updater feed. They

Original section: Releases, builds and updates. Source lines 5006–5009.

<!-- preserved:e-6dbff5c4b979ba41 -->
- **Alphas are local and never published:** no tag, no GitHub release, no updater feed. They
  are built from a side branch and delivered as a file. Release notes never name
  unpublished builds. The alpha number counts delivered builds. [decided: user 2026-09-30,
  2026-10-02]
<!-- /preserved:e-6dbff5c4b979ba41 -->

<a id="e-a49486cb0256eac8"></a>

## Public releases are cut from main with npm run release:windows -- &lt;version&gt;

Original section: Releases, builds and updates. Source lines 5010–5015.

<!-- preserved:e-a49486cb0256eac8 -->
- **Public releases** are cut from `main` with `npm run release:windows -- <version>
  --publish`, which verifies one exact candidate before any tag or GitHub change, then
  publishes a normal (not prerelease) release with six canonical assets. Without
  `--publish` it is local only. The version lives in `package.json` and both
  `package-lock.json` fields, and needs `docs/release-notes-<version>.md`; `-RCn` labels are
  refused. [verified: [`docs/windows-release.md`](../../docs/windows-release.md)]
<!-- /preserved:e-a49486cb0256eac8 -->

<a id="e-f542b3bf8b8860b2"></a>

## Every upgrade path is tested: 3.2.0 must upgrade from 2.1.14, 3.0.9 and 3.1.0, with

Original section: Releases, builds and updates. Source lines 5016–5018.

<!-- preserved:e-f542b3bf8b8860b2 -->
- **Every upgrade path is tested:** 3.2.0 must upgrade from 2.1.14, 3.0.9 and 3.1.0, with
  converter rehearsals on real-data copies before an alpha and installer upgrade rehearsals
  plus a rollback before the publish. [decided: user 2026-10-02, decision 14]
<!-- /preserved:e-f542b3bf8b8860b2 -->

<a id="e-10dac646654eef2b"></a>

## Dev builds (npm run package:dev) install beside the published app under their own

Original section: Releases, builds and updates. Source lines 5019–5020.

<!-- preserved:e-10dac646654eef2b -->
- **Dev builds** (`npm run package:dev`) install beside the published app under their own
  identity and data folder. [verified: [`docs/dev-builds.md`](../../docs/dev-builds.md)]
<!-- /preserved:e-10dac646654eef2b -->

<a id="e-02a966787cf8cf65"></a>

## Gotchas in Orgtree's own agent tools

Original section: Gotchas in Orgtree's own agent tools. Source lines 5032–5032.

<!-- preserved:e-02a966787cf8cf65 -->
#### Gotchas in Orgtree's own agent tools
<!-- /preserved:e-02a966787cf8cf65 -->

<a id="e-149550dbaaa72b93"></a>

## Agents that build Orgtree also run on it; these bite repeatedly.

Original section: Gotchas in Orgtree's own agent tools. Source lines 5036–5037.

<!-- preserved:e-149550dbaaa72b93 -->
Agents that build Orgtree also run on it; these bite repeatedly. [verified: agents' notes
2026-08 to 2026-10]
<!-- /preserved:e-149550dbaaa72b93 -->

<a id="e-56d1a28d2228b6db"></a>

## Mail that arrives while a subagent (the Agent tool) runs is injected into the

Original section: Gotchas in Orgtree's own agent tools. Source lines 5039–5042.

<!-- preserved:e-56d1a28d2228b6db -->
- **Mail that arrives while a subagent (the Agent tool) runs is injected into the
  subagent's tool result.** The parent never sees it, and `orgtree_inbox fetch` returns
  `already_moved` until the next turn. Check your inbox after subagents finish. [verified
  2026-10-05]
<!-- /preserved:e-56d1a28d2228b6db -->

<a id="e-257a0e876810659a"></a>

## orgtree_send_notice never starts a turn; an idle agent reads it only when something else

Original section: Gotchas in Orgtree's own agent tools. Source lines 5043–5044.

<!-- preserved:e-257a0e876810659a -->
- `orgtree_send_notice` never starts a turn; an idle agent reads it only when something else
  wakes it.
<!-- /preserved:e-257a0e876810659a -->

<a id="e-243ecf1ec6617bda"></a>

## A timed-out mutating call may have applied ("UNKNOWN"): re-read before repeating, and use

Original section: Gotchas in Orgtree's own agent tools. Source lines 5045–5046.

<!-- preserved:e-243ecf1ec6617bda -->
- A timed-out mutating call may have applied ("UNKNOWN"): re-read before repeating, and use
  `expected_rev` on docket writes.
<!-- /preserved:e-243ecf1ec6617bda -->

<a id="e-ddc2174ab06dc896"></a>

## Docket: field names differ per action; caps of 40 artifacts and 50 evidence rows per item;

Original section: Gotchas in Orgtree's own agent tools. Source lines 5047–5049.

<!-- preserved:e-ddc2174ab06dc896 -->
- Docket: field names differ per action; caps of 40 artifacts and 50 evidence rows per item;
  `artifact_read` and `orgtree_read_scratch` stop near 20,000 characters; use `fields=[...]`
  or a projection on large items.
<!-- /preserved:e-ddc2174ab06dc896 -->

<a id="e-1e1957300ae8ac7a"></a>

## Watchdog command targets run in cmd.exe unless shell: "bash"; read the create-time

Original section: Gotchas in Orgtree's own agent tools. Source lines 5050–5051.

<!-- preserved:e-1e1957300ae8ac7a -->
- Watchdog command targets run in `cmd.exe` unless `shell: "bash"`; read the create-time
  smoke output; a dog aimed at a retired agent never fires.
<!-- /preserved:e-1e1957300ae8ac7a -->

<a id="e-8144ed9e3cadfbc9"></a>

## Never put a headless agent in plan mode: it blocks every orgtree tool.

Original section: Gotchas in Orgtree's own agent tools. Source lines 5052–5052.

<!-- preserved:e-8144ed9e3cadfbc9 -->
- Never put a headless agent in plan mode: it blocks every orgtree tool.
<!-- /preserved:e-8144ed9e3cadfbc9 -->

<a id="e-dd980c189c0ad177"></a>

## Claude agents see tools as mcp__orgtree__&lt;tool&gt;; Codex and Gemini register bare names.

Original section: Gotchas in Orgtree's own agent tools. Source lines 5053–5053.

<!-- preserved:e-dd980c189c0ad177 -->
- Claude agents see tools as `mcp__orgtree__<tool>`; Codex and Gemini register bare names.
<!-- /preserved:e-dd980c189c0ad177 -->

<a id="e-962161abcd765385"></a>

## Removed and dead ideas

Original section: Removed and dead ideas. Source lines 5055–5055.

<!-- preserved:e-962161abcd765385 -->
#### Removed and dead ideas
<!-- /preserved:e-962161abcd765385 -->

<a id="e-c77e8683f70b9d23"></a>

## Do not rebuild, re-propose or "restore" these without a new ruling from the user.

Original section: Removed and dead ideas. Source lines 5057–5057.

<!-- preserved:e-c77e8683f70b9d23 -->
Do not rebuild, re-propose or "restore" these without a new ruling from the user.
<!-- /preserved:e-c77e8683f70b9d23 -->

<a id="e-355f20a16348a36c"></a>

## Idea Status Source

Original section: Removed and dead ideas. Source lines 5059–5074.

<!-- preserved:e-355f20a16348a36c -->
| Idea | Status | Source |
| --- | --- | --- |
| Kiosk mode (public renderer and visitors) | Removed on v3 for 3.2.0 (published 3.0.x and 3.1.0 still contain it); no feed path, tables or columns | [decided: user 2026-10-02, design decision 17] `dba5f5c` |
| Per-org Docker sandbox, org disk, bridge, frozen profile | Removed on v3 for 3.2.0. The converter keeps the org-level `sandbox` key for the credential catch-up. Codex's and Antigravity's own CLI sandboxes are different and stay | [decided: user 2026-10-02] `3f379f4`, `ab95345` |
| Orgtree v1 import | Deprecated: the App settings Import tab is gone; the engine's import routes are still present, pending removal. The 2.x first-launch conversion stays | [decided: user 2026-09-29] `e2a112f` |
| SQLite as primary storage | Replaced by PostgreSQL in 3.0. SQLite remains for side stores (transcript records, chat-window index, the mail hub) and for converting 2.x data | [decided: user 2026-09-25] |
| A Rust port of the engine | **Superseded 2026-10-06:** Orgtree 4.0.0 is a ground-up Rust engine (`engine/rs/`), designed from the renderer's contract, not a port of the Python code or of the shelved `engine/native/store*` prototype | [decided: user 2026-10-06, DECISIONS 1–2; earlier deferral 2026-09-27 to 2026-10-01] |
| The 3.2.0 Python data-model rewrite (per-org databases, `org_tx` lock order, record feed in Python) | Stopped; 4.0.0 replaces it. The 3.x sections of this file describe it as legacy | [decided: user 2026-10-06 18:53Z] |
| Windows service mode | Dropped; boot start stays the scheduled-task host | [decided: user 2026-09-29] |
| A bounded pool of warm processes | Not built; warming is a user setting | [decided: user 2026-09-26] |
| A separate "Orgtree Private Alpha" app identity | Dropped: v3 installs as normal Orgtree over 2.x | [decided: user 2026-09-28] |
| Design rev 5's `org_topology` lock row | Withdrawn in rev 7.8 (it broke the lock order) | [decided: design rev 7.8] |
| A seat table / one "head" per lineage | Withdrawn in rev 6: one `agents` row per node | [decided: design rev 6] |
| A stored "Sent tail" key on mail rows | Withdrawn in rev 7.5: the reader computes it | [decided: design rev 7.5] |
| Archived docket totals in agents' list calls | Removed: only with `include_archived` | [decided: user 2026-10-02, decision 21] |
| A 2.1.13 hotfix for the 2.1.9–2.1.12 lost-save bug | Not made: the fix is v3 only | [decided: user 2026-09-27] |
<!-- /preserved:e-355f20a16348a36c -->

<a id="e-8d3b3b0a9bb77e9d"></a>

## Where the detail lives

Original section: Where the detail lives. Source lines 5076–5076.

<!-- preserved:e-8d3b3b0a9bb77e9d -->
#### Where the detail lives
<!-- /preserved:e-8d3b3b0a9bb77e9d -->

<a id="e-de5c5b2452589996"></a>

## Start here: pg-data-model-design.md (the

Original section: Where the detail lives. Source lines 5078–5084.

<!-- preserved:e-de5c5b2452589996 -->
- **Start here:** [`pg-data-model-design.md`](../../docs/state-system/pg-data-model-design.md) (the
  3.2.0 design, every finding and decision), [`machine-traps.md`](../../docs/machine-traps.md),
  [`worktree-operations.md`](../../docs/worktree-operations.md),
  [`known-failures.md`](../../docs/known-failures.md) (the baseline and the import-provenance
  trap), [`engine-contract.md`](../../docs/engine-contract.md) (desktop–engine transport, tokens,
  attach), [`v2-user-decisions.md`](../../docs/v2-user-decisions.md) (user decisions up to
  2026-09-15; newest entry wins).
<!-- /preserved:e-de5c5b2452589996 -->

<a id="e-187e8fa7719d846a"></a>

## data model (docs/state-system/): pg-o1-move.md (the O(1) move),

Original section: Where the detail lives. Source lines 5085–5089.

<!-- preserved:e-187e8fa7719d846a -->
- **3.2.0 data model** (`docs/state-system/`): `pg-o1-move.md` (the O(1) move),
  `pg-step6-record-feed.md` (the record feed), `pg-columns-audit.md` (measured costs on the
  live copy), `docket-bounded-readers.md`, `org-enum-inventory.md`,
  `pg-o1-scope-consumers.md`; conversion and runtime in `pypg-cutover-runbook.md`,
  `pypg-cutover-verification.md` and `pypg-packaged-runtime.md`.
<!-- /preserved:e-187e8fa7719d846a -->

<a id="e-622cd8fd2a56c3c6"></a>

## Engine behaviour: agent-halt.md, mail-delivery-boundaries.md,

Original section: Where the detail lives. Source lines 5090–5094.

<!-- preserved:e-622cd8fd2a56c3c6 -->
- **Engine behaviour:** `agent-halt.md`, `mail-delivery-boundaries.md`,
  `frozen-turn-lifecycle.md`, `mcp-connection-recovery.md`, `assistant-message-identity.md`,
  `foreground-tree-api.md`, `startup-budget.md`, `scope-diagnostics.md`,
  `provider-capability-evidence.md`, `antigravity-provider-parity.md`,
  `copy-title-surfaces.md` (all in `docs/`).
<!-- /preserved:e-622cd8fd2a56c3c6 -->

<a id="e-db2349941c6a3748"></a>

## Process and release: verification-recipes.md, windows-release.md, dev-builds.md,

Original section: Where the detail lives. Source lines 5095–5097.

<!-- preserved:e-db2349941c6a3748 -->
- **Process and release:** `verification-recipes.md`, `windows-release.md`, `dev-builds.md`,
  `update-rehearsal.md`, `mailhub-sync.md`, and the release notes (latest
  `release-notes-3.1.0.md`).
<!-- /preserved:e-db2349941c6a3748 -->

<a id="e-e43f7a8bb06cd5f6"></a>

## History (v1/v2 era; do not use for current behaviour): v1-parity-inventory.md,

Original section: Where the detail lives. Source lines 5098–5101.

<!-- preserved:e-e43f7a8bb06cd5f6 -->
- **History** (v1/v2 era; do not use for current behaviour): `v1-parity-inventory.md`,
  `v2-acceptance.md`, `v2-import*.md`, `v2-original-design-brief.md`,
  `supplied-design-decisions.md`, `alpha-6-handoff.md`, `performance-2026-09-09.md`,
  `private-alpha-packaging.md`, `engine/docs/state-access-rearchitecture.md`.
<!-- /preserved:e-e43f7a8bb06cd5f6 -->

<a id="e-865845b012a1bc13"></a>

## Stale statements to ignore (each superseded as shown):

Original section: Where the detail lives. Source lines 5103–5103.

<!-- preserved:e-865845b012a1bc13 -->
**Stale statements to ignore** (each superseded as shown):
<!-- /preserved:e-865845b012a1bc13 -->

<a id="e-1ed3fd48701251ff"></a>

## docs/known-failures.md tells every agent to run compare: only the coordinator or

Original section: Where the detail lives. Source lines 5105–5106.

<!-- preserved:e-1ed3fd48701251ff -->
- `docs/known-failures.md` tells every agent to run `compare`: only the coordinator or
  release owner does (user 2026-09-26).
<!-- /preserved:e-1ed3fd48701251ff -->

<a id="e-46e149c151fc7105"></a>

## docs/verification-recipes.md shows a bare python -m unittest for backend tests: use

Original section: Where the detail lives. Source lines 5107–5108.

<!-- preserved:e-46e149c151fc7105 -->
- `docs/verification-recipes.md` shows a bare `python -m unittest` for backend tests: use
  `tools/run-python-verification.py`.
<!-- /preserved:e-46e149c151fc7105 -->

<a id="e-8d6c4adf214bbc82"></a>

## docs/worktree-operations.md: --base defaults to main; pass

Original section: Where the detail lives. Source lines 5109–5110.

<!-- preserved:e-8d6c4adf214bbc82 -->
- `docs/worktree-operations.md`: `--base` defaults to `main`; pass
  `--base origin/dev`.
<!-- /preserved:e-8d6c4adf214bbc82 -->

<a id="e-93099de9f4ac4527"></a>

## docs/engine-contract.md predates PostgreSQL and the account system. It is still right

Original section: Where the detail lives. Source lines 5111–5113.

<!-- preserved:e-93099de9f4ac4527 -->
- `docs/engine-contract.md` predates PostgreSQL and the account system. It is still right
  for transport, tokens and attach, but the app does elevate (through UAC) when the user
  changes the Run-as-administrator setting, and an explicit Quit stops an attached engine.
<!-- /preserved:e-93099de9f4ac4527 -->

<a id="e-fbf008fa8815d332"></a>

## engine/README.md describes an ORGTREE_V1_ROOT launch input that the desktop no longer

Original section: Where the detail lives. Source lines 5114–5115.

<!-- preserved:e-fbf008fa8815d332 -->
- `engine/README.md` describes an `ORGTREE_V1_ROOT` launch input that the desktop no longer
  provides.
<!-- /preserved:e-fbf008fa8815d332 -->

<a id="e-c0288d7629dc8e37"></a>

## docs/state-system/pypg-packaged-runtime.md speaks of an "external cutover", and

Original section: Where the detail lives. Source lines 5116–5118.

<!-- preserved:e-c0288d7629dc8e37 -->
- `docs/state-system/pypg-packaged-runtime.md` speaks of an "external cutover", and
  `postgresql-qualification.md` of PostgreSQL "not adopted": both are superseded by the
  automatic first-launch conversion.
<!-- /preserved:e-c0288d7629dc8e37 -->

<a id="e-f5bd27c31080a2f1"></a>

## docs/v2-user-decisions.md and engine-contract.md name a GitHub prerelease channel:

Original section: Where the detail lives. Source lines 5119–5120.

<!-- preserved:e-f5bd27c31080a2f1 -->
- `docs/v2-user-decisions.md` and `engine-contract.md` name a GitHub prerelease channel:
  public releases are normal releases.
<!-- /preserved:e-f5bd27c31080a2f1 -->

<a id="e-d5bd76d1e0c8fe2c"></a>

## docs/v3-qualification.md and synthetic-migration-harness.md exercise the SQLite-era

Original section: Where the detail lives. Source lines 5121–5122.

<!-- preserved:e-d5bd76d1e0c8fe2c -->
- `docs/v3-qualification.md` and `synthetic-migration-harness.md` exercise the SQLite-era
  layout, not the per-org databases.
<!-- /preserved:e-d5bd76d1e0c8fe2c -->

<a id="e-3498b9d054560946"></a>

## Abandoned-docket recovery processes at most eight predicted items per org per tick,

Original section: Where the detail lives. Source lines 5124–5129.

<!-- preserved:e-3498b9d054560946 -->
Abandoned-docket recovery processes at most eight predicted items per org per tick,
uses the standard docket lock and bounded recipient locks, and rechecks ownership and the
destination under those locks. Mail uses the standard send declaration; missed writes
widen only after rollback. Failures back off from 60 seconds to 15 minutes per org;
successful passes clear the backoff. No all-node recovery lock is taken.
[verified 2026-10-05: `supervisor._abandoned_docket_recovery_pass`, `worktx.py`]
<!-- /preserved:e-3498b9d054560946 -->

<a id="e-b4812fa45d04c477"></a>

## Recovery prediction uses the archive projection, including owner and both freshness

Original section: Where the detail lives. Source lines 5131–5134.

<!-- preserved:e-b4812fa45d04c477 -->
- Recovery prediction uses the archive projection, including owner and both freshness
  timestamps; reassignment retains full records and rejects prediction mappings.
  Never pass a projected row to a write. [verified: `ledger.py`, `supervisor.py`;
  decided: drag-opus 2026-10-06; `tests/test_orgdb_abandoned_recovery_pg.py`]
<!-- /preserved:e-b4812fa45d04c477 -->

<a id="e-225978c48bb53dca"></a>

## Warm-pool eligibility shares one lazy NativeInventory per keeper pass through transcript lookup. It is never retained ac

Original section: Where the detail lives. Source lines 5136–5136.

<!-- preserved:e-225978c48bb53dca -->
Warm-pool eligibility shares one lazy NativeInventory per keeper pass through transcript lookup. It is never retained across passes; per-session path validation and ad-hoc lookup freshness remain unchanged. [decided: drag-opus 2026-10-06; verified: `warmpool._keeper_pass`, `desktop_native.native_path_for_session`]
<!-- /preserved:e-225978c48bb53dca -->

<a id="e-3e5f717aeccea6b1"></a>

## Cold archived docket projections covered by the existing policy spec use its typed decoder and policy extra, not full it

Original section: Where the detail lives. Source lines 5138–5138.

<!-- preserved:e-3e5f717aeccea6b1 -->
Cold archived docket projections covered by the existing policy spec use its typed decoder and policy extra, not full item/event reconstruction. The same snapshot retains pending moves/deletions and archive sequence order; uncovered fields use the full compatibility reader. [decided: drag-opus 2026-10-06; verified: `orgdb/compat/sql.py` `_project`]
<!-- /preserved:e-3e5f717aeccea6b1 -->

<a id="e-8c6d69a4de7da02b"></a>

## (recorded-decision): model choices in settings/hire/rehire share modelChoiceLabel and modelChoiceTitle. Enabled options

Original section: Where the detail lives. Source lines 5144–5144.

<!-- preserved:e-8c6d69a4de7da02b -->
- 2026-10-07 (recorded-decision): model choices in settings/hire/rehire share modelChoiceLabel and modelChoiceTitle. Enabled options show only model and seat; known OpenRouter capabilities move to tooltips, unknowns are omitted. Disabled choices retain a visible refusal-reason suffix and tooltip (coordinator clarification18:56Z), without changing provider/login/favorite gates. Shared settings selects cap intrinsic width.
<!-- /preserved:e-8c6d69a4de7da02b -->

<a id="e-68ad2d4511525f46"></a>

## (verified-from-source and mounted renderer): direct children of agent settings (.settings.cfg) must not flex-shrink. Dif

Original section: Where the detail lives. Source lines 5146–5146.

<!-- preserved:e-68ad2d4511525f46 -->
- 2026-10-07 (verified-from-source and mounted renderer): direct children of agent settings (.settings.cfg) must not flex-shrink. Different tab heights otherwise compress the shared Name/Agent actions rows and shift the tab strip; let the panel scroll instead.
<!-- /preserved:e-68ad2d4511525f46 -->

## Renderer adapter recipe, 2026-10-21

Superseded 2026-10-22: the adapter creates a dependency junction. The org no-junction rule wins; this retained source report is not permission to run it. See [current dependency guidance](development-and-verification.md#renderer-tests-from-a-worktree-without-node_modules).

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

## Superseded early Rust operating procedures

Relocated 2026-10-22 without changing attributed bodies. Current homes are in [development and verification](development-and-verification.md#current-operating-rule-homes). These early records do not set current worktree placement, review phase or test selection. In particular, broad rig proofs require an assignment; the stopped Python suite does not forbid the current release owner from using the Node/renderer baseline tool.

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

<a id="e-837c7011305e3f2e"></a>

## So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4008–4010.

<!-- preserved:e-837c7011305e3f2e -->
- So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock,
  `test-baseline.mjs`, Python import provenance, `run-python-verification.py`,
  `source-audits.py`.
<!-- /preserved:e-837c7011305e3f2e -->
