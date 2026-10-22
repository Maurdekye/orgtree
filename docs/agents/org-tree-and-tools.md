# Organization tree and tools

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Scope, authority, topology, credits, hiring, lifecycle and typed tool contracts.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Relationship terminology

The glossary's [relationship terms](../skills/orgtree-working/team/team-shape/SKILL.md#relationship-terms) are the canonical definitions for superior, report/subordinate, descendant and physical sibling/peer. Use those definitions when documenting authority; retain exact UI labels and API enum values while explaining their actual scope. This is terminology alignment, not a change to descendant-wide controls, including DnD for descendants. [decided: user 2026-10-22, m22010c4dd33e and m201e750b317d; verified: `engine/rs/orgtree-engine/migrations/{0025_project_nodes,0037_agent_reporting}.sql`, `domain/docket.rs`, `tools/orgview.rs`, `apps/desktop/renderer/src/canvas/agentmenu.tsx`]

<a id="e-760313f9ff3352c2"></a>

## A file link rendered from an agent tool row keeps the same reveal-only click,

Original section: AGENTS.md — working on Orgtree. Source lines 1466–1471.

<!-- preserved:e-760313f9ff3352c2 -->
- A file link rendered from an agent tool row keeps the same reveal-only click,
  but its explicit right-click menu may offer `Open`, `Show in folder`, and copy
  actions. The authenticated native routes reject relative/missing paths; no
  agent tool gains local-file authority. [decided: user 2026-10-19; verified:
  `main/index.ts`, `preload/index.ts`, `canvas/desk.tsx`,
  `tests/toolfilelinks.test.tsx`]
<!-- /preserved:e-760313f9ff3352c2 -->

<a id="e-c7bded2fa1f899ba"></a>

## Autonomous org Logo edits use orgtree_org_logo, gated only by inherited

Original section: AGENTS.md — working on Orgtree. Source lines 1938–1946.

<!-- preserved:e-c7bded2fa1f899ba -->
- Autonomous org Logo edits use `orgtree_org_logo`, gated only by inherited
  `tools.orgtree.logo` (on by default, including old scopes; user 2026-10-15
  22:10Z). Use the existing bounded native picture decoder/store/publisher.
  Only this agent tool joins user undo history: atomic picture+journal write,
  identity/permission/folder recheck after decode, new revision for undo/redo,
  stale edit refusal. Keep normalized image data out of traces/history feeds.
  Contract and verification limits: [Logo tool](../../docs/rust-engine/profile-pictures.md#autonomous-logo-tool-431).
  [decided: user 2026-10-15 22:07–22:10Z; verified from source:
  `tools/logo.rs`, `domain/undo.rs`, `profile_pictures/*`]
<!-- /preserved:e-c7bded2fa1f899ba -->

<a id="e-88ad49b77a7c3f85"></a>

## Retired pile pickers own lightweight 50-row cursor pages, with server-side

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2747–2758.

<!-- preserved:e-88ad49b77a7c3f85 -->
- Retired pile pickers own lightweight 50-row cursor pages, with server-side
  case-insensitive substring name search. Opening one never registers a
  children browse or hydrates a full tree. Migration 0047's retired-only
  directory indexes `(org,parent,last-turn time,sibling order,id)`; time
  triggers ignore unchanged timestamps and accounting writes. Live turns
  have no directory row to lock; triggers never lock agents or org revision
  rows. Search may scan that small directory, per coordinator approval.
  Delete all ignores the search and visits bounded pages only after explicit
  confirmation. See [piles](../../docs/skills/orgtree-app/canvas/piles/SKILL.md).
  [decided: user/coordinator 2026-10-20; verified: `http/retired.rs`,
  `migrations/0047_retired_picker.sql`, `canvas/retiredpages.ts`,
  `tests/retiredpages.test.tsx`, `tools/rig/proofs/retired-pages.mjs`]
<!-- /preserved:e-88ad49b77a7c3f85 -->

<a id="e-a0c44cb1ee4f6cf3"></a>

## User-approved folder additions/upgrades through HTTP scope and request

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2914–2925.

<!-- preserved:e-a0c44cb1ee4f6cf3 -->
- User-approved folder additions/upgrades through HTTP scope and request
  approval enter org defaults atomically with child/ancestor scope (3.x
  user 2026-08-08, P56). Only supplied whole-list edits infer additions;
  equivalent duplicate paths aggregate RO/RW intent without rewriting history.
  Requests carry only explicit approved items. Org-before-agent row locks
  cover settings/revocation, user retool/rehire and either actor's staffing
  with audiences. These non-key mutations use FOR NO KEY UPDATE so implicit
  org FK KEY SHARE on ordinary agent/event inserts stays compatible, without
  adding an org mutex to ordinary tree operations. Publish refresh only
  after commit; never replay old approvals or create directories. See
  [scope intent and proof limits](../../docs/rust-engine/approved-folder-grants.md).
  [verified: `domain/asks.rs`, `domain/scope.rs`, `domain/ops.rs`, `http/nodes.rs`, 2026-10-12]
<!-- /preserved:e-a0c44cb1ee4f6cf3 -->

<a id="e-165dfeb46f8f045e"></a>

## Agent orgtree_reorder accepts a live strict descendant and zero-based

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3051–3061.

<!-- preserved:e-165dfeb46f8f045e -->
- Agent `orgtree_reorder` accepts a live strict descendant and zero-based
  final live sibling `index`; `orgtree_hire`/staff's new-hire form require
  explicit `index` (0..existing live count). Superior insertion excludes its
  anchor from that count. Inspection exposes live sibling indices and child
  counts. Hire/reorder position decisions are serializable with bounded retry;
  exhausted midpoint gaps normalize only that live sibling set atomically.
  Promote/Demote aliases share Move's canonical dispatch and isolation policy;
  raw request/retry labels and existing move audit meaning are retained.
  [decided: user 2026-10-11 23:15Z; verified from source: `domain/ops.rs`,
  `domain/ops/ordering.rs`, `tools/defs.rs`, 2026-10-12;
  scope/proof: `docs/rust-engine/agent-ordering.md`]
<!-- /preserved:e-165dfeb46f8f045e -->

<a id="e-127fddd0e286e0b6"></a>

## Hiring a superior above self, including at the root, preserves the caller's

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3209–3230.

<!-- preserved:e-127fddd0e286e0b6 -->
- Hiring a superior above self, including at the root, preserves the caller's
  external seat-plus-grant allocation: the new seat and requested free grant
  come only from the caller's existing free credits. Root self-insertion is
  allowed; insertion above another root remains user-only. The new parent inherits
  the caller's **effective** scope, never broader configured defaults. Validate
  composite actions before promotion and commit both atomically; publish no
  intermediate topology or effects. Its explicit index is chosen in the final
  sibling set excluding the caller, and survives temporary-report promotion;
  returned placement describes that final set. Self-parent fallback inherits
  the caller's effective preference (org default when unset); explicit true
  is clamped to it, explicit false remains allowed. Hire/staff kickoff metadata
  reports the final parent grant after promotion in the same transaction.
  [verified from source: `domain/ops.rs`, 2026-10-14]
  The new parent's ordinary superior powers over its caller (org-allowed
  account/model/effort changes, rename, halt, retire) are inherent; its account
  is not pinned to the caller's. The transferred root grant C+G-P can exceed
  the user-hire top-level cap when C>P; stake C+G stays conserved and no cap
  check is added to promotion. [decided: coordinator 2026-10-14,
  parent-hire docket review rulings B/C]
  See [parent-hire accounting and authority](../../docs/rust-engine/parent-hire.md).
  [verified: isolated parent-hire rig 29/29 and neighboring credits20/scope12/
  ordering64/alias7, rig-opus batch 2026-10-13; A/D fix checks pending]
<!-- /preserved:e-127fddd0e286e0b6 -->

<a id="e-d16a71914ecb3e0e"></a>

## Credit cascades plan before writing and stop at the acting agent's allocation.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3591–3594.

<!-- preserved:e-d16a71914ecb3e0e -->
- Credit cascades plan before writing and stop at the acting agent's allocation.
  Moves transfer the existing subtree stake below the common ancestor; batches
  validate final net grants in one transaction. [user ruling and source verified:
  2026-10-07; docs/rust-engine/credit-cascade-boundary.md]
<!-- /preserved:e-d16a71914ecb3e0e -->

<a id="e-5d6d121b8db7164c"></a>

## Agent-hire MCP schemas mirror the no-defaults rule: ordinary new hires require

Original section: Keep this file current. Source lines 4120–4124.

<!-- preserved:e-5d6d121b8db7164c -->
- Agent-hire MCP schemas mirror the no-defaults rule: ordinary new hires require
  explicit folders/visibility and all five tool keys including `mcp`; superior
  insertion omits inherited scope, rehire requires `node` and forbids `index`.
  Hire/staff refusals report missing fields together. [decided: user 2026-10-17;
  verified: `domain/hire_requirements.rs`, `tools/defs.rs`]
<!-- /preserved:e-5d6d121b8db7164c -->

<a id="e-ffe209ade318d2f8"></a>

## (verified-from-source): top-level rescind is supported by Rust domain/ops.rs and 3.x ledger.py: archive the subtree, wit

Original section: Where the detail lives. Source lines 5140–5140.

<!-- preserved:e-ffe209ade318d2f8 -->
- 2026-10-07 (verified-from-source): top-level rescind is supported by Rust `domain/ops.rs` and 3.x `ledger.py`: archive the subtree, with no superior grant to reduce. Agent settings shows it for every live agent and explains that case in its confirmation. See `docs/rust-engine/agent-settings-refresh.md`.
<!-- /preserved:e-ffe209ade318d2f8 -->
