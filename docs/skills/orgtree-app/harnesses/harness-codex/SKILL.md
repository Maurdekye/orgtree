---
name: orgtree-harness-codex
description: Explain Codex app-server events, session continuity, sandbox posture and limits of reported timings.
---
Up: [orgtree-harnesses](../SKILL.md)

# Codex

Codex drives OpenAI seats and selectable [OpenRouter](../route-openrouter/SKILL.md) and [local-server](../route-local-server/SKILL.md) routes. The account's model catalog, permission posture and provider route are independent facts.

## How it runs

One `codex app-server` process speaks JSON-RPC over stdio. Orgtree initializes it and starts or resumes a thread with model, sandbox, developer instructions and dynamic Orgtree tools. `turn/start` supplies text/images and effort; the matching `turn/completed` ends the turn. A failed thread resume can start a fresh thread; Orgtree retains predecessor history/handoff rather than claiming the old context resumed. A matching rollout can be copied to the selected account home to make resume possible.

Mail uses native `turn/steer` with `expectedTurnId`. Failed steering leaves mail pending for a later turn; a successful acknowledgement establishes custody, not obedience. `turn/interrupt` requests cancellation of the named turn. Close first closes stdin and allows five seconds; the explicit termination path still allows three seconds before forced termination. Graceful/forced outcomes go to the durable kill record, including the hosted process path.

## Information and timing

Agent text and reasoning text/summary deltas stream independently. Completed message/reasoning items become durable transcript rows. Tool `item/started` and `item/completed` produce engine-observed start/end timestamps and completed output/error previews. This adapter does not expose Claude-style partial argument-writing telemetry, so tool writing time is unknown rather than zero. Native command timing fields are not automatically the chip's observed interval, and this handler does not promise a live command-output log.

`thread/tokenUsage/updated` carries thread totals and last-request figures. Orgtree differences cumulative totals for per-turn input/cached/output accounting and uses the last prompt for occupancy. `account/rateLimits/updated`, model reroutes and terminal errors are separate signals; a retryable error need not end the turn. Only the running turn's completion ends its record.

The account-window reader uses bounded metadata HTTP, with a separately paced app-server fallback; live rate-limit notifications are additional evidence. Cached turn boards do not launch a reader. Current window selection, freshness and refresh floors belong in `orgtree-usage-windows` (orgtree-working › accounts).

## Caching

OpenAI subscription guidance uses a thirty-minute estimate, not a guaranteed retention period. A positive cached-token receipt is required before describing an observed entry. Do not transfer that estimate to custom-provider routes. Account/auth, model, session or provider changes establish a new namespace; changed developer instructions, tools/MCP, folder/permission posture or startup files change the compared prefix.

Dynamic turn-envelope facts, appended messages and an effort-only change do not by themselves invalidate the unchanged earlier prefix. A new local app-server can resume the same thread and still reuse compatible provider state, but cannot guarantee it. See `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

Where the context window is known, Orgtree sends `model_auto_compact_token_limit = context_window × compact_at` at launch; the local route supplies its own known window. Native `thread/compacted` records a provider compaction event. The current command UI does not expose Codex `/compact` as the Claude slash-command operation; use the supported fresh-session controls when appropriate.

Cheap compact preserves durable files/Orgtree records and exports earlier conversation, then replaces the provider session with a short handoff. It does not guarantee every provider-summary detail survives. Actual native summarizer internals/retention are unknown here. Common policy and gates live in `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The checked native startup manifest reads the selected Codex home's `AGENTS.md` and the project chain from a `.git` root to cwd; without a root it uses cwd alone. In a project directory `AGENTS.override.md` wins over `AGENTS.md`. Codex does not natively read legacy `CLAUDE.md`; Orgtree supplies otherwise omitted scratch/granted notes. A general native instruction byte/token ceiling is unknown in this source review; do not substitute an Orgtree transcript-preview limit.

Orgtree identity enters `developerInstructions` at thread start/resume. At `7f5f27f`, personal global instructions from other harnesses and the user's ambient Codex home are supplied read-only where the actual account/profile does not already load them. Canonical native exclusion and text/digest capture use the same startup snapshot. Edits apply at the next permitted startup boundary, preserving the session; they can change the prefix and cache continuity. Source: `runtime/startup.rs:81`, `runtime/global_instructions.rs:143`, `runtime/actor.rs:1866`.

At `de6d356`, the app-server receives the immutable shared `skills` root through `skills/extraRoots/set` before thread start/resume. The checked API is Codex 0.160.0; support in every older binary is unknown, and a root-loading error is explicit. Skill and instruction digests are combined for launch, idle recheck and forecast. Refresh does not mutate an active turn's skills. Source: `runtime/codex.rs:329` native `skills/extraRoots/set` request; `runtime/actor.rs:620`/`:2653` at `de6d356`.

Common discovery and collision rules live in [skills and instructions](../../providers/skills-and-instructions/SKILL.md). Orgtree tools are dynamic `item/tool/call` tools; granted external MCP definitions are private config overrides, documented in [MCP servers](../../providers/mcp-servers/SKILL.md).

## Tools, permissions and sandbox

Native modes include read-only, workspace-write and danger-full-access with the scope's approval policy. On Windows Session 0, a sandboxed non-bypass seat can be hosted by the interactive user's helper when available. Bypass seats stay in Session 0. Without that helper, the fallback is unsandboxed; a read-only seat uses the restrictive `untrusted` approval posture to close command escape. A folder grant is not proof the OS sandbox started.

Approval requests are answered from current scope. Native request-user-input is refused in favor of Orgtree's question tool. Scope/catalog filtering also limits write/subagent tools; MCP approvals do not interpret every external tool argument as a filesystem path.

## Models and effort

Use the account/model discovery offer and `supportedReasoningEfforts`; no universal level list establishes entitlement for every model. Native level names can include `none` and `minimal`. Saved levels clamp to an offered level without rewriting the setting. Effort travels with `turn/start`; an in-flight change applies at the next turn, not through Claude's live-control method. A completed model reroute is recorded rather than assumed to preserve the requested model.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **Windows runner pipe-in timeout:** a recognized failure can occur before a shell process starts. The engine supplies one diagnostic; an eligible same-command retry can use the existing escalation approval path. Read-only/plan seats have no escape. Do not replay a command automatically or generalize every timeout to this failure. Source: `runtime/codex.rs:706`, `runtime/actor.rs:5150`; dated investigation `docs/rust-engine/codex-sandbox-runner.md` (2026-10-07).
- **Graceful shutdown matters:** forcing down Codex during Windows credential RPC was linked to a machine crash. Let the driver close stdin and record any forced termination; do not substitute direct process kills. Source: `runtime/mod.rs:152`, `runtime/codex.rs:435`.
- **No tool-writing measurement:** start/completion timestamps are useful observed intervals, but unknown argument-generation time stays unknown. Source: `runtime/actor.rs:5000`; `AGENTS.md` observed-tool-writing rule.
- **Native steer has a turn ID:** stale-turn steering must leave the message pending; do not resend a successfully acknowledged batch because the model has not replied yet. Source: `runtime/codex.rs:414`, `runtime/actor.rs:3076`.

## See also

- [orgtree-providers-tab](../../providers/providers-tab/SKILL.md)
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
