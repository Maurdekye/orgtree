---
name: orgtree-harness-muse
description: Explain Muse MSP lifecycle, token and background events, native compaction and Session 0 gotchas.
---
Up: [orgtree-harnesses](../SKILL.md)

# Muse Code

Muse runs one `muse serve` MSP v1 host per agent, with contributor mode off on every launch. Subscription seats do not silently receive an API key. The login's authenticated catalog determines model entitlement.

## How it runs

JSON-RPC over stdio initializes the host, then starts or resumes a session. Resume reapplies the seat's model/approval/profile; failure starts a fresh session rather than running a wider stored posture. `turn/start` includes text/images, effort and current writable roots; the matching `turn/completed` ends it. Roots are replaced on every turn because resume does not update them.

Native `turn/steer` names the exact running turn; an error leaves mail for the next turn. `turn/interrupt` stops an admitted turn; Orgtree cancels host-created turns it did not admit. Both ordinary close and the explicit stop first close stdin, with five/three-second grace respectively, before recorded forced termination if needed.

Shell commands can move into the background. Orgtree follows their items beyond the turn, preserves held hosts while they owe results and admits a wake when appropriate. A new process/session cannot restore a command killed with its predecessor. Native receipt of a background result and permission for a new agent turn are different.

## Information and timing

MSP text and reasoning deltas stream; completed message/reasoning items become durable rows. Tool items start/update/complete, carrying inputs, output/status and background transitions. The chip's start/end timestamps are observed by the engine. No partial argument-writing phase is exposed here, so writing time is unknown. A native turn `durationMs` is not every tool's execution duration.

`session/tokenUsage` reports each model completion. Orgtree separates cached input from counted-once prompt tokens, accumulates output/cache writes, and keeps the last prompt as occupancy; a final turn aggregate can replace those totals. Child-run usage is retained separately, not added twice. `session/contextUsage`, `usage/changed`, retry notices and typed quota/auth errors carry different evidence. Quota can name `resetsAtMs`; a generic error is not a quota deadline.

Muse's own dated five-hour and weekly observations come from metadata reads and live sessions; missing windows remain missing and older observations do not replace newer ones. Another model's windows cannot prove this model has room unless the observation is account-wide. Exact cadence/freshness rules live in `orgtree-usage-windows` (orgtree-working › accounts).

Muse has **no on-demand fresh usage query**: `usage/read` returns an observation the host already has, and a forced Orgtree metadata read cannot force a new provider measurement. The current UI keeps Refresh visible but disabled, explaining that Muse reports usage after a turn. Its real observation time must remain attached even when a metadata getter succeeds.

## Caching

Muse can report cache reads/writes but publishes neither prices nor a cache lifetime in the checked evidence. Cost and expiry remain unknown; do not display a made-up countdown or interpret recorded zero as free provider inference. The fingerprint still detects incompatible identity, tools/MCP, scope, model, account or startup changes.

Provider/account/model/session changes create a new namespace; rewriting already-sent content changes the prefix. Dynamic envelope facts, appended turns and effort-only controls do not by themselves rewrite earlier text. Keeping the same MSP host proves neither a provider hit nor a receipt. See `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

The native `/compact` path uses `session/compact`: its reply admits the operation, and the completed compaction item must report outcome `compacted` before Orgtree records success. The exact native automatic trigger/summary-retention policy is unknown here; the org's Claude/Codex launch threshold is not passed as a universal Muse threshold.

Cheap compact instead creates a new provider session with Orgtree's handoff while files/records survive and earlier conversation is exported. The old full prompt is not preserved as new context. Common automatic cold-reset gates and recovery practice live in `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The checked native workspace rule selection takes the first existing `AGENTS.md`, `CLAUDE.md`, `.agents/AGENTS.md`, `.claude/CLAUDE.md` in the primary root. Orgtree adds otherwise omitted granted-folder notes. The launch trusts its workspace and supplies `run.developer_prompt`. If identity exceeds the 26,000-character command-argument budget, it writes a file and supplies a short prompt asking Muse to read it at session start and after compaction. That is an argument-length workaround, not proof every identity byte reached a model or a native instruction-size cap.

At `7f5f27f`, the native manifest also tracks the actual account's `config/muse/AGENTS.md`, falling back to `CLAUDE.md`. Orgtree supplies other personal globals read-only, deduplicated against that native manifest in the same text/digest snapshot. The launch sets `context.foreign_personal_rules=false` so Muse does not independently duplicate foreign rules; Muse's own rules and its separate foreign-skills setting remain native. Saved Muse settings are unchanged. Edits apply at the next permitted startup boundary and can change prefix/cache continuity. Source: `runtime/startup.rs:81`/`:119`, `runtime/muse.rs:262`.

At `de6d356`, shared bundles are delivered as owned native `.agents/skills` workspace copies before launch. Imported bundles use deterministic aliases; source bundles and unowned user destinations are not overwritten. Workspace copies change after the old process closes, and their digest remains combined with instruction startup state. Muse's separate foreign-skills setting is not disabled. Source: `providers/skills.rs:103`, `runtime/actor.rs:3078` at `de6d356`.

A general native instruction/token ceiling is unknown here. Session-loaded skills/read_skill are native concepts; common discovery and collision rules are owned by [skills and instructions](../../providers/skills-and-instructions/SKILL.md). MCP servers use session configuration with a private Orgtree bridge and granted external definitions.

## Tools, permissions and sandbox

Read-only seats use `:read-only`/deny-unmatched with shell/write disabled. Normal write seats use `:ask-me`/on-request; bypass uses `:unrestricted`/allow-all. In Windows Session 0, normal write seats disable Muse's OS sandbox. Some shell and file operations can then exceed folder grants without an approval callback; no engine callback can enforce a request Muse never sends. Outside Session 0 the sandbox stays on for normal seats.

Read-only granted folders are not writable workspace roots. For approvals that arrive, Orgtree answers every open stage once from current scope, never a persistent allow rule. Disallowed subagents are stopped; contributor mode, workflow triggers and observer capabilities are disabled per process without editing saved settings.

## Models and effort

Wonder, Wonder Full and Spark require the selected login's catalog row, version and supported variants. Bundled fallback rows do not establish entitlement; Wonder Full is not assumed to share Wonder's quota pool. Effort uses that model's native names, clamping unsupported saved names without rewriting them. The union includes minimal/low/medium/high/xhigh/max; `ultra` is not offered because it includes proactive workflows.

Effort goes with each turn, so a changed effort applies on the next turn without replacing a compatible host. A reported unexpected session model change makes the host ineligible for reuse. Login moves may fail native resume because sessions are stored under each login's data root; a fresh-session handoff is then required.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **Session 0 is not folder containment:** explain the actual sandbox posture before proposing work that relies on isolation; restrictive approval labels alone do not prove containment. Source: `runtime/muse.rs:95`, `runtime/actor.rs:2992`; Muse 1.4.6 observations dated 2026-10-13 in `docs/rust-engine/muse-code.md`.
- **Staged approval updates:** answer all open stages once; treating a repeated stage as a new whole-call approval can stall or abort it. The driver handles this; agents should inspect the settled item rather than retrying blindly. Source: `runtime/muse.rs:1002`, `runtime/muse.rs:407`; Muse 1.4.6 staged-approval observation dated 2026-10-14 in that document.
- **Silent foreground tools:** Muse uniquely has an implemented per-tool workaround at the configured silence limit: Orgtree steers a failure note, calls `task/stop` for the tool and lets the turn continue. Other harnesses do not inherit this behavior. Source: `runtime/actor.rs:1065`, `runtime/muse.rs:735`.
- **Background results:** the host owns their delivery; automatic result turns are cancelled and Orgtree admits the wake. Preserve the host until owed results are consumed, subject to explicit halt/limit/shutdown policy. Source: `runtime/actor.rs:3978`, `runtime/actor.rs:4389`, `runtime/actor.rs:4530`; DECISIONS 77.
- **No fresh usage on demand:** keep and display the latest genuinely dated observation rather than retrying Refresh to manufacture freshness. Landed source `4447424` preserves per-account last-good readings across engine restarts, restoring their original age without new authentication evidence. Passed-reset windows become unknown with the label `reset; awaiting reading`, retaining observation/reset times; no zero or fresh capacity is invented. Account removal clears its retained entry. Source at `4447424`: `usage/muse_cache.rs:36`/`:77`, `usage.rs:627`/`:638`, `domain/account_removal.rs:405`, `apps/desktop/renderer/src/canvas/accounts.tsx:257`; fresh-query limitation: `docs/rust-engine/muse-usage-refresh.md`.

## See also

- See `orgtree-usage-windows` (orgtree-working › accounts).
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
