---
name: orgtree-route-openrouter
description: Explain how OpenRouter routing changes harness behavior, billing evidence, context and model compatibility.
---
Up: [orgtree-harnesses](../SKILL.md)

# OpenRouter routes

OpenRouter is a provider route, not a sixth agent harness. Installed Claude Code, Codex and OpenCode can all drive it. This page owns route differences; account/key/model-browser setup stays in [OpenRouter settings](../../providers/openrouter/SKILL.md).

## How it runs

A key carries its harness; an explicitly pinned seat can retain its own choice. The engine chooses that installed compatible driver without silently substituting a missing harness. Read [Claude Code](../harness-claude-code/SKILL.md), [Codex](../harness-codex/SKILL.md) or [OpenCode](../harness-opencode/SKILL.md) for process, start/end, interrupt, shutdown and resume mechanics.

Claude Code uses OpenRouter's Anthropic-compatible base with the route key as auth token and every reachable model pinned to the hired model. Codex uses the Responses endpoint in an isolated route home. OpenCode uses its private OpenAI-compatible configuration. These routes do not spend a Claude/OpenAI native subscription merely because that CLI is the harness.

A key/harness change applies at a turn boundary. Crossing harnesses starts a fresh session plus a handoff; another harness does not resume the first harness's native session. Durable predecessor history remains separate from new context.

## Information and timing

Streaming text/thoughts, tool argument visibility, execution intervals and turn completion follow the selected driver. Claude Code can expose writing time; the other two cannot synthesize it. Prompt token counts and gateway charges are different evidence: Orgtree can price known model rates, but OpenCode custom-provider cost remains unknown rather than trusting a zero amount.

OpenRouter metadata reports each key's cap/spending and shared account balance, with no fabricated rolling subscription reset. Native Claude/Codex subscription windows are n/a for this route. A key can be exhausted by zero balance even when its cap bar is below 100%. Cadence, stale/unsupported evidence and cached-read behavior belong in `orgtree-usage-windows` (orgtree-working › accounts).

## Caching

Provider/cache behavior depends on the routed model/backend, not the CLI brand. A verified universal OpenRouter TTL is unknown here. Do not transfer the native Claude subscription hour or OpenAI thirty-minute estimate to this gateway; displayed harness accounting/receipt defaults are not a backend retention contract. OpenCode explicitly reports unsupported cache lifetime.

Changing key/auth binding, model, provider or native session changes the namespace; identity/tool/MCP/startup rewrites can change prefix compatibility. Dynamic envelope facts, appended turns and effort-only controls do not independently rewrite an earlier prefix. See `orgtree-cache-continuity` (orgtree-working › accounts) for common receipt limits.

## Compaction

Claude Code receives the org percent override; Codex receives a token threshold when model context is known; OpenCode has no configured native compaction contract in this adapter. These are launch settings, not proof a gateway model can produce a useful summary. Backend-specific compaction quality/retention is unknown.

A harness switch already requires a fresh-session handoff. Manual/automatic cheap compact is a separate policy which retains durable files and Orgtree history while replacing prompt context; its gates belong in `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

Identity delivery and native rule selection follow the underlying driver. Codex uses a dedicated OpenRouter home; OpenCode uses isolated homes/config and a custom system identity. Claude Code's route retains its own native startup behavior while routing inference to OpenRouter. At `7f5f27f`, Orgtree supplies the user's personal globals read-only even across isolated profiles, excluding files loaded natively. At `de6d356`, all three drivers also receive shared native skill roots using their own delivery APIs. Skill/instruction changes participate in the combined startup boundary; Refresh does not rewrite a running turn. Source: `runtime/startup.rs:81`; `runtime/actor.rs:620`/`:2301`/`:2653`/`:2827` at `de6d356`.

Common bundle/global sharing is in [skills and instructions](../../providers/skills-and-instructions/SKILL.md), and grants/imports in [MCP servers](../../providers/mcp-servers/SKILL.md). A separate OpenRouter-specific instruction byte/token limit is unknown here; the harness/backend's actual limits still matter.

## Tools, permissions and sandbox

The selected harness owns permission callbacks, sensitive-path behavior and Windows/Session 0 posture. The route does not add an OS sandbox. MCP/tool availability still requires the seat's grants and a model capable of tool calling. A provider's tool-support catalog flag is not a successful native tool invocation.

Use each driver's actual mail path: Claude tool-boundary hook, Codex native exact-turn steering, OpenCode next-turn queue. A key change is not an automatic way to change permission policy.

## Models and effort

Selected favorites become hireable models; retained known records can keep existing seats identifiable after deselection. Catalog context, tool/image/reasoning flags and prices can be unknown. A model name or saved effort does not establish that the gateway honored it. Codex uses Responses; it is not configured for Chat Completions. OpenCode at this base does not negotiate custom-provider effort. Claude/native effort settings only establish what that harness was asked to send, not backend support.

Exact provider model behavior and reasoning implementation remain unknown until evidenced for that route/model; use the current catalog and actual returned errors rather than promising a family-wide compatibility rule.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **CLI brand is not billing identity:** inspect the routed key and model; never diagnose its exhaustion using the user's Claude/OpenAI subscription bars. Source: `runtime/actor.rs:2325`, `openrouter.rs:793`, `runtime/actor.rs:1747`.
- **Several keys can share one balance:** changing keys need not create capacity. Read key cap and account balance together. Source: `usage.rs:1467`, `usage.rs:1481`; window interpretation home linked above.
- **Harness moves are context moves:** a boundary switch seeds a fresh session; prepare breadcrumbs and retain predecessor history before requesting it. Source: `runtime/actor.rs:2097`, `openrouter.rs:841`.
- **Mail and timing follow the driver:** use the comparison to choose native steer versus hook/queue behavior; do not invent writing time or interrupt automatically on every new mail. Source: `runtime/actor.rs:1414`, `runtime/actor.rs:5290`, `runtime/actor.rs:5000`.

## See also

- [orgtree-openrouter](../../providers/openrouter/SKILL.md)
- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- [orgtree-harness-codex](../harness-codex/SKILL.md)
- [orgtree-harness-opencode](../harness-opencode/SKILL.md)
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
