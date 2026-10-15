---
name: orgtree-harness-comparison
description: Compare harness lifecycle, reported evidence, caching, compaction, instruction loading and gotchas.
---
Up: [orgtree-harnesses](../SKILL.md)

# Harness comparison

The runtime registry has five harnesses. OpenRouter and local language servers are routes through Claude Code, Codex or OpenCode, not extra agent protocols. The tables summarize source `72ea305`; each cell links to its detailed fact home. Native rule evidence and pending changes have their own dated/source status in those pages. Unknown means no verified contract here, not zero or unsupported everywhere.

Account-window observation is separate from turn-token reporting. Model/window applicability, metadata-reader cadence and freshness are defined in `orgtree-usage-windows` (orgtree-working › accounts); an active stream does not imply a freshly polled account allowance.

## Claude, Codex and Antigravity

| Topic | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| How it runs | [Persistent stream-JSON; user/result turns; hook mail; control interrupt.](../harness-claude-code/SKILL.md#how-it-runs) | [JSON-RPC app-server/thread; native exact-turn steer/interrupt.](../harness-codex/SKILL.md#how-it-runs) | [Stream-JSON/conversation; invocation-hook mail; interrupt ends process tree.](../harness-antigravity/SKILL.md#how-it-runs) |
| Information and timing | [Text/thinking/argument deltas; observed writing and tool execution intervals; result usage.](../harness-claude-code/SKILL.md#information-and-timing) | [Text/reasoning deltas, item starts/completions; writing time unknown; thread-token differences.](../harness-codex/SKILL.md#information-and-timing) | [Text/trajectory tools and step usage; no separate thought-text stream; writing time unknown.](../harness-antigravity/SKILL.md#information-and-timing) |
| Caching | [Subscription hour/key five-minute guidance with receipts; no hit guarantee.](../harness-claude-code/SKILL.md#caching) | [Native subscription thirty-minute estimate; custom routes differ.](../harness-codex/SKILL.md#caching) | [Engine 300-second value; published provider TTL unknown.](../harness-antigravity/SKILL.md#caching) |
| Compaction | [Launch percent; native boundary event; /compact; separate fresh handoff.](../harness-claude-code/SKILL.md#compaction) | [Known-window token threshold/event; UI slash compact unsupported.](../harness-codex/SKILL.md#compaction) | [Native threshold/event contract unknown; fresh-handoff workflow separate.](../harness-antigravity/SKILL.md#compaction) |
| Instructions and skills | [Claude notes/fallback/imports; generated append prompt; common sharing home.](../harness-claude-code/SKILL.md#instructions-and-skills) | [AGENTS project chain/overrides; developerInstructions; general size ceiling unknown.](../harness-codex/SKILL.md#instructions-and-skills) | [Managed AGENTS at base; 24,000-byte expanded file cap and 20k-token rules budget; split fix pending.](../harness-antigravity/SKILL.md#instructions-and-skills) |
| Tools, permissions and sandbox | [Control-channel MCP, scoped allow/deny/CLI gates; no extra OS-sandbox claim.](../harness-claude-code/SKILL.md#tools-permissions-and-sandbox) | [Dynamic tools/approvals; hosted Windows sandbox or explicit Session 0 fallback.](../harness-codex/SKILL.md#tools-permissions-and-sandbox) | [MCP bridge plus capability-denial hooks; read-only shell closed.](../harness-antigravity/SKILL.md#tools-permissions-and-sandbox) |
| Models and effort | [Claude tier/model pins and five native levels; eligible live change.](../harness-claude-code/SKILL.md#models-and-effort) | [Discovered model efforts; per-turn application and reported reroutes.](../harness-codex/SKILL.md#models-and-effort) | [Google pools/catalog; mapped levels; optional Claude model IDs encode effort.](../harness-antigravity/SKILL.md#models-and-effort) |

## Muse and OpenCode

| Topic | Muse Code | OpenCode |
| --- | --- | --- |
| How it runs | [MSP host/session, native steer/interrupt, held background results.](../harness-muse/SKILL.md#how-it-runs) | [ACP session/prompt, queued mid-turn mail, explicit load failure, session/cancel.](../harness-opencode/SKILL.md#how-it-runs) |
| Information and timing | [Text/reasoning deltas, item events, completion/aggregate usage; writing time unknown.](../harness-muse/SKILL.md#information-and-timing) | [Text/thought chunks, merged tool updates, per-prompt tokens; writing time unknown.](../harness-opencode/SKILL.md#information-and-timing) |
| Caching | [Cache receipts possible; price and TTL unknown.](../harness-muse/SKILL.md#caching) | [Custom-provider TTL/cost unknown; unsupported forecast.](../harness-opencode/SKILL.md#caching) |
| Compaction | [session/compact admission, success item required; automatic threshold unknown.](../harness-muse/SKILL.md#compaction) | [No configured threshold/RPC; native policy unknown; separate fresh handoff.](../harness-opencode/SKILL.md#compaction) |
| Instructions and skills | [Workspace rules and developer prompt/file fallback; native size ceiling unknown.](../harness-muse/SKILL.md#instructions-and-skills) | [Private primary-agent system, isolated config, additional roots empty at base; common sharing pending.](../harness-opencode/SKILL.md#instructions-and-skills) |
| Tools, permissions and sandbox | [MSP/MCP approvals; current writable roots each turn; Session 0 write seats unsandboxed.](../harness-muse/SKILL.md#tools-permissions-and-sandbox) | [ACP path callbacks/direct MCP; shell capability, no OS sandbox; Code Mode policy differs.](../harness-opencode/SKILL.md#tools-permissions-and-sandbox) |
| Models and effort | [Exact login catalog/variants; next-turn effort; proactive ultra excluded.](../harness-muse/SKILL.md#models-and-effort) | [Custom model/context config; reasoning effort unnegotiated/unknown at base.](../harness-opencode/SKILL.md#models-and-effort) |

## Provider routes

| Topic | OpenRouter | Local language server |
| --- | --- | --- |
| How it runs | [Key-selected/pinned Claude, Codex or OpenCode; cross-harness fresh handoff.](../route-openrouter/SKILL.md#how-it-runs) | [All three harnesses; Messages/Responses/Chat Completions respectively; concurrency admission.](../route-local-server/SKILL.md#how-it-runs) |
| Information and timing | [Driver telemetry plus key cap/account balance; native subscription windows n/a.](../route-openrouter/SKILL.md#information-and-timing) | [Driver telemetry; provider quota n/a; hardware cap not exhaustion.](../route-local-server/SKILL.md#information-and-timing) |
| Caching | [Backend-dependent, universal TTL unknown; never inherit native subscription TTL.](../route-openrouter/SKILL.md#caching) | [Server KV/cache retention unknown; no expiry promise.](../route-local-server/SKILL.md#caching) |
| Compaction | [Driver threshold where supported; backend summary retention unknown.](../route-openrouter/SKILL.md#compaction) | [Configured real window/driver threshold; bounded overflow handoff recovery.](../route-local-server/SKILL.md#compaction) |
| Instructions and skills | [Driver-native delivery and route-home differences; common sharing contract.](../route-openrouter/SKILL.md#instructions-and-skills) | [Driver-native delivery/isolated config; server-specific instruction ceiling unknown.](../route-local-server/SKILL.md#instructions-and-skills) |
| Tools, permissions and sandbox | [Inherits driver, not a separate sandbox; mail path also inherited.](../route-openrouter/SKILL.md#tools-permissions-and-sandbox) | [Inherits driver; Codex hosted web search disabled locally.](../route-local-server/SKILL.md#tools-permissions-and-sandbox) |
| Models and effort | [Catalog flags/rates can be unknown; saved effort not backend proof.](../route-openrouter/SKILL.md#models-and-effort) | [Server model/context catalog, version compatibility observations, backend effort unknown.](../route-local-server/SKILL.md#models-and-effort) |

## Gotchas and workarounds

| Harness or route | Gotchas |
| --- | --- |
| Claude Code | [Mail waits for PostToolUse; explicit tool-boundary interruption/follow-up is a workflow, not automatic. Generated argument timing requires actual deltas.](../harness-claude-code/SKILL.md#gotchas-and-workarounds) |
| Codex | [Windows runner can fail before shell start; eligible approval-based retry only. Graceful shutdown and durable forced-stop records matter.](../harness-codex/SKILL.md#gotchas-and-workarounds) |
| Antigravity | [Expanded-file truncation/aggregate rules budget; numbered parts do not raise total budget. Base overwrites managed AGENTS; split fix unapproved. Interrupt stops process tree.](../harness-antigravity/SKILL.md#gotchas-and-workarounds) |
| Muse | [Session 0 callbacks do not contain all writes; staged approvals/background custody matter. Usage cannot be freshly queried on demand; restart retention/reset-label improvement is pending.](../harness-muse/SKILL.md#gotchas-and-workarounds) |
| OpenCode | [No imported skill roots at this base; explicitly read an authorized skill file while sharing is pending. No mid-turn steer; explicit interruption/follow-up is manual. Tools may appear late; Code Mode denial is deliberate.](../harness-opencode/SKILL.md#gotchas-and-workarounds) |
| OpenRouter | [CLI brand is not billing, keys can share balance, and harness changes replace context.](../route-openrouter/SKILL.md#gotchas-and-workarounds) |
| Local server | [Match the actual protocol; separate model loading/overflow from quotas; cache retention remains unknown.](../route-local-server/SKILL.md#gotchas-and-workarounds) |

A human can deliberately interrupt a non-steering session at a tool-call boundary and continue with new input when waiting is unacceptable. That does not imply an automatic interrupt-on-mail feature: source dispatch uses native steering for Codex/Muse, hooks for Claude/AGY, and a queue for OpenCode. Completion receipts establish delivery or tool settlement, not instruction obedience or rolled-back side effects.

One shared tooling gotcha is distinct from a provider limit: the team's 2026-10-14 offscreen Electron visual checks in Windows Session 0 observed a 1024×768 display and clamped larger windows. Those fixtures should fit roughly 1000×700, or use an appropriately hosted interactive capture. Source: coordinator-team visual-capture notes, dated 2026-10-14. This test-environment observation does not establish every harness's or browser tool's display size. Read [engine start mode](../../app-settings/engine-start-mode/SKILL.md) for the current mode distinctions rather than inferring the selected mode from these older fixtures.

## See also

- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- [orgtree-harness-codex](../harness-codex/SKILL.md)
- [orgtree-harness-antigravity](../harness-antigravity/SKILL.md)
- [orgtree-harness-muse](../harness-muse/SKILL.md)
- [orgtree-harness-opencode](../harness-opencode/SKILL.md)
- [orgtree-route-openrouter](../route-openrouter/SKILL.md)
- [orgtree-route-local-server](../route-local-server/SKILL.md)
- See `orgtree-cache-continuity` (orgtree-working › accounts).
- See `orgtree-context-and-compaction` (orgtree-working › runtime).
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
