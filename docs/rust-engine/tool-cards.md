# Compact Orgtree tool cards (4.4.0)

Agents receive a short call contract and an `orgtree-tool-<name>` glossary pointer
for each permitted Orgtree tool. The guide owns procedures and extended examples.
Cards retain the immediate constraints: mail metadata before body, recipient and
attachment authority, explicit hire fields, docket ownership/attention rules,
watchdog execution authority, and document/file delivery distinctions. Input
schemas, property order, required fields and tool handlers keep their existing
behavior. Both split and Antigravity flat mail shapes remain supported.

`tools::defs::deferred` explicitly selects 23 less frequent lifecycle, placement,
account-recovery, Logo, transfer and request tools. Their
`_meta["anthropic/alwaysLoad"]` hint is false; the other 22 cards remain eager.
The Claude SDK server definition no longer forces every card eager. Native tool
search may discover the rare tools when the receiving Claude client supports
this metadata and enables search. The tools remain callable and keep the same
permission checks. Scope-denied groups are still omitted altogether.

This is an advertisement policy, not an instruction to use another account or
harness. Other harnesses receive the compact cards; no native deferral capability
is claimed for Codex, Antigravity, Muse or OpenCode. Client thresholds, wrappers,
tool-name listings and native prompts can change actual provider input. A hint
does not prove the client deferred a schema or that the model can find it.

## Focused evidence

Before implementation, exact `d53ddd5` produced ten canonical JSON measurements
(five harnesses, all groups and all groups off). Split mail: 45 cards, 55,285
bytes, including 21,598 description bytes. Flat mail: 45 cards, 54,658 bytes,
including 21,417 description bytes. All groups off: four cards, 3,074 bytes.
The description/pointer and rare-card tests failed at their intended assertions;
the measurement test passed.

The compact candidate measured these canonical byte counts; final focused checks
and full per-harness receipts accompany the exact-SHA hand-in:

| Shape/profile | Before | Compact | Compact descriptions | Eligible eager cards/bytes |
| --- | ---: | ---: | ---: | ---: |
| Split, all groups (Claude/Codex/Muse/OpenCode) | 55,285 | 44,468 | 10,733 | 22 / 32,661 |
| Flat, all groups (Antigravity) | 54,658 | 43,841 | 10,552 | 22 / 32,034 |
| Either, all groups off | 3,074 | 2,218 | 1,058 | 4 / 2,218 |

Split-card bytes fall by 10,817 (19.6%); descriptions fall by 10,865 (50.3%).
The four always-available cards remain when every optional group is denied.
Eligible eager totals are conditional hint budgets, not measured native input.

The unit guard caps each description at 900 UTF-8 bytes and the combined set at
12,000, verifies every guide exists, and checks common/rare metadata plus denied
groups. Saved before/after card JSON permits exact comparison after removing
only top-level descriptions and metadata. This preserves schema descriptions,
required fields, names and ordering too. Token figures use inferred `ceil(bytes/2)`
for the requested comparison; they are not provider-token measurements. The
separate live startup audit showed that this estimate overstates that sample.

Node-placement descriptions retain agent-only runtime targets and project
restore/promotion semantics within that same 12,000-byte cap. Their approved
description changes are explicit snapshot deltas; schemas and field order remain
guarded. When a description changes, run both the snapshot and startup-budget
tests together. [verified: `tools/defs.rs`; 2026-10-20]

## Stack safety

The original monolithic `all()` constructor overflowed the default debug engine
worker stack when called during `Actor::plan` on the first synthetic Codex
admission. The constructor alone could still run on a default test thread, so
tool-card unit tests did not reproduce that nested admission failure. The
unchanged c89111b constructor's debug assembly allocates 202,864 bytes in its
logged inner function, excluding saved registers and called frames.

Each non-mail tool literal now has its own `#[inline(never)]` builder. These pure
helpers are `#[nolog]`; the existing outer logging boundary remains. `all()`
assembles their values in the original order, and the two mail cards retain their
existing builder. No global cache or stack-size override is introduced.

`testdata/tool-cards-c89111b.json` in the engine crate contains the original
44,780-byte serialized `all()` output, captured before extraction. Its SHA-256 is
`2d6cf764fe869d9906a0197317216bcf26b65bfe75757269e85d1dbb16b1caed`.
The regression compares exact bytes, including names, descriptions, schemas,
metadata, property order and tool order. Intentional contract changes update the
fixture alongside their source change. Stack verification separately runs a real
debug fake-Codex admission with `RUST_MIN_STACK` absent. Assembly frame allocations
are static measurements, not measured total stack use or remaining headroom.

### The actor's turn path

A debug poll frame reserves its own slots for every future it awaits inline,
usually two or three copies each, and never shares them between await points.
`Box::pin(call)` still builds the future in the caller's frame before moving it.
At rust-engine 9edbc13 the first turn of a synthetic Codex agent overflowed the
2 MiB engine worker stack right after `Actor::start_turn` entered
`Actor::ensure_proc`. The static frame allocations (`dumpbin /unwindinfo` with the
PDB beside the exe) on that path were:

| Poll frame | 9edbc13 | Boxed |
| --- | ---: | ---: |
| `Actor::run` | 422,688 | 11,584 |
| `Actor::handle_msg` (inner + logged wrapper) | 736,880 | 46,512 |
| `Actor::on_slot` (inner) | 58,544 | 25,440 |
| `Actor::start_turn` (inner) | 256,136 | 101,104 |
| `Actor::ensure_proc` (inner) | 137,408 | 35,392 |
| `Actor::ensure_codex` (inner) | 64,728 | 40,440 |

The awaited futures were 3 to 37 KB each (`size_of` of each method's future in
a debug test build): `run` awaits nine of about 17 KB, `handle_msg` about forty.
`boxed(|| self.method(args))` builds the future inside the small helper's frame
and moves it to the heap, so the awaiting frame keeps a pointer. Every actor
future of about 3 KB or more awaited in `run`, `handle_msg`, `on_slot`,
`start_turn`, `ensure_proc` and `ensure_codex` goes through it.

`tools/rig/proofs/debug-stack-first-turn.mjs` runs a first Codex turn and a
first Claude turn on a debug engine with `RUST_MIN_STACK` unset: it fails at
9edbc13 and passes after. With the fix the whole proof also passes at a
1.5 MiB worker stack (engine start fails at 1.25 MiB, before any turn).
Release builds inline these poll functions: the largest actor frame in an
alpha.10 release engine is 43,640 bytes and its largest frame overall 89,112.
Those are static frame allocations, not measured stack use.

### Fire actions

A polled dog's fire action ran its tool call inline, below the dog's runner:
`arm_retry` → `poll_once` → `fire_with` → `run_fire_actions` → `call_tool` →
`tools::dispatch` → `create` → the websocket smoke's dial. At rust-engine 1cbaac2 a
file dog whose fire action created a websocket dog overflowed the debug engine (the
websocket rig proof's file-path fire action). `run_fire_actions` now builds the
`call_tool` future through `util::boxed` (moved there from the actor); a spawned task
would lose the task-local fire-action depth. Static frames on that path:

| Poll frame (logged wrapper + inner) | Inline | Boxed |
| --- | ---: | ---: |
| `watchdogs::arm_retry` | 334,632 | 230,536 |
| `watchdogs::poll_once` | 162,416 | 106,352 |
| `watchdogs::fire_with` | 112,928 | 61,552 |
| `watchdogs::fire` | 85,256 | 45,208 |
| `watchdogs::run_fire_actions` | 100,512 | 11,504 |

In an alpha.10 release engine the whole path is inlined into `arm_retry`, about
78 KB of static frames.

### The tool path

`tools::dispatch` awaited each of its 43 tool handlers inline, and
`ops::run_in_tx_without_audience_notices` each of its 35 ops, so a debug poll frame
reserved slots for all of them. A project create through the tool path (an agent
wrapping itself in `project-mail-boundaries.mjs`) and a multi-slot run
(`project-multi-slots.mjs`) overflowed the debug engine at 93b41c6 and before. Every
arm's future is now built through `util::boxed`. Static frames:

| Poll frame (logged wrapper + inner) | Inline | Boxed |
| --- | ---: | ---: |
| `tools::dispatch` | 636,288 | 24,848 |
| `ops::run_in_tx_without_audience_notices` | 463,760 | 110,560 |
| `tools::call_tool` | 74,880 | 18,160 |
| `tools::handle_mcp`, `call`, `call_inner` and `call_agent_tool` | 212,152 | 53,336 |
| `rig::routes::tool` | 103,432 | 35,368 |

The rig route's project create (`rig::routes::tool` → `call_tool` → `dispatch` →
`treetools::run` → `ops::run` → `run_once` → `run_in_tx` →
`run_in_tx_without_audience_notices` → `create_project`) held about 1.53 MiB of
static frames inline and 0.47 MiB boxed, before hyper, tokio and tokio-postgres
frames. `debug-stack-first-turn.mjs` now also creates a project through the tool
path, claims two slots, reads their status and releases them through it, and has a
Codex turn's MCP call create a project, with no overflow line in stderr; the project
create overflowed before the boxing.
