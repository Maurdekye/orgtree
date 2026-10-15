---
name: orgtree-route-local-server
description: Explain local language-server harness routes, concurrency, protocol compatibility and context recovery.
---
Up: [orgtree-harnesses](../SKILL.md)

# Local language-server routes

A language server such as llama.cpp supplies inference; an installed Claude Code, Codex or OpenCode harness runs the agent. The server is not an extra agent CLI. Setup, addresses, model lists and concurrency controls are owned by [Language servers](../../providers/language-servers/SKILL.md).

## How it runs

Claude Code requires an Anthropic-compatible Messages API; Codex requires Responses; OpenCode uses Chat Completions. The configured server must support the selected protocol and model. The engine enforces an agents-at-once cap for that server before starting a turn; waiting for a slot is different from a frozen provider quota.

Process protocol, turn start/end, shutdown, resume and interruption belong to [Claude Code](../harness-claude-code/SKILL.md), [Codex](../harness-codex/SKILL.md) and [OpenCode](../harness-opencode/SKILL.md). Claude/Codex local routes isolate native config homes and route credentials; the selected route does not send a native cloud login as its server key. OpenCode likewise uses private custom-provider configuration.

For an Ollama route, model loading can occur before the CLI request while the seat holds its scheduler slot. A cancelled warm-up releases that load/slot. Exact external server startup/shutdown/resume behavior is outside Orgtree's harness contract and unknown here; Orgtree does not infer a running command survived a CLI restart.

## Information and timing

The harness exposes text/thoughts/tool starts/results according to its own stream. Model/server support can omit or normalize fields. Only Claude's observed partial tool arguments produce writing-time evidence; no local-server route creates missing telemetry for Codex/OpenCode. Tool timestamps measure received events rather than a guaranteed hardware execution clock.

Provider usage windows and monetary quota are n/a for local inference; the concurrency cap is admission policy. Orgtree treats this hardware as unbilled inference, not as evidence about electricity/hosting expense. A context overflow or slow server is not a subscription reset signal. Window/unsupported-state interpretation is in `orgtree-usage-windows` (orgtree-working › accounts).

## Caching

The server may keep its own in-memory prompt/KV cache, but Orgtree has no verified receipt/lifetime contract for it. Forecasts therefore leave expiry unknown, regardless of a harness token field or parked process. A cloud provider TTL must not be applied to llama.cpp or another local implementation.

Identity/tool/startup rewrites and provider/model/session/auth-route changes can still change compatibility. Append-only messages and dynamic envelope facts do not by themselves rewrite previous content, but the server's actual cache key/eviction behavior remains unknown. See `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

Claude Code is told the model's real context window, bounded output size and org compaction percent. Codex receives the route context window and `window × compact_at` threshold. OpenCode receives context/output limits but has no explicit compaction threshold in this adapter. Native summary quality/retention depends on the served model and remains unknown; a huge configured window is not measured occupancy.

When recognized local context-full/failed-summary errors occur, Orgtree can perform a bounded fresh-session recovery with a handoff instead of endless overflow retries. That differs from a successful native compaction or provider quota reset. Cheap compact and automatic policy retain durable files/history but replace prompt context; see `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The selected driver owns identity/native file delivery; the local route supplies dedicated Claude/Codex configuration homes and explicit model/context settings. At `7f5f27f`, personal globals are supplied read-only across those profiles with canonical native deduplication. At `de6d356`, shared skills use each driver's native delivery: Claude snapshot `--add-dir`, Codex `skills/extraRoots/set`, or OpenCode private `skills` roots and exact skill-ID allow rules. Combined startup digests preserve both instruction and skill state; changed content applies at the next permitted launch boundary. This does not prove a local model will select or obey a skill. Source: `runtime/startup.rs:81`; `runtime/actor.rs:620`/`:2301`/`:2653`/`:2827` at `de6d356`.

Common discovery and limits are in [skills and instructions](../../providers/skills-and-instructions/SKILL.md); MCP imports/grants are in [MCP servers](../../providers/mcp-servers/SKILL.md).

A server-specific instruction-file byte/token ceiling is unknown here; native harness limits and the configured model context still apply. Splitting a document does not manufacture additional model context or prove all pieces were sent.

## Tools, permissions and sandbox

Folder/tool grants and Windows/Session 0 behavior are those of the driver; a loopback endpoint adds no filesystem sandbox. Codex hosted web search is explicitly disabled for the local route because that service runs on OpenAI servers. Other tool availability depends on native scope and the model's ability to call tools.

Mail uses Claude's tool-boundary hook, Codex exact-turn steer or OpenCode next-turn queue. When a non-steering route urgently needs redirection, a deliberate tool-boundary interruption plus follow-up is a workflow, not an implemented automatic mail interrupt; stopping a tool does not reverse side effects.

## Models and effort

Models are discovered/configured per server. The context window comes from server/model metadata and fallback configuration; it must not be inferred from transcript size. Codex's generated local catalog can supply model context/reasoning support. OpenCode custom effort is not configured at this base; all exact backend reasoning behavior remains unknown without route-specific evidence.

The saved preset help records llama-server b11540 as a tested Codex Responses baseline, not proof every older/newer build is compatible. It warns that a vLLM model name containing `/` is unsuitable for its Claude route, and some vLLM reasoning models reject reasoning items Codex sends back. Treat these as recorded compatibility observations and inspect the actual error/model offer.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **Protocol mismatch:** choose Messages for Claude Code, Responses for Codex, Chat Completions for OpenCode; an OpenAI-compatible label alone is insufficient. Source: `langserver.rs:105`, `langserver.rs:1033`, `langserver.rs:1072`.
- **Slow first token:** local launch settings allow slow requests and Ollama can preload, but a time limit still ends work. Distinguish model loading, a tool stall and a provider timeout before retrying. Source: `runtime/actor.rs:1414`, `langserver.rs:1033`, `runtime/actor.rs:973`.
- **Repeated context overflow:** use the bounded handoff recovery/cheap-compact path and durable breadcrumbs; a failed summarizer is not fixed by repeatedly submitting the same full prompt. Source: `runtime/actor.rs:6155`, `runtime/recovery.rs:171`, `runtime/convo.rs:559`.
- **No quota/cache invention:** explain a saturated agents-at-once slot as concurrency and unknown KV retention as unknown, not as exhausted cloud credits or a known TTL. Source: `runtime/actor.rs:1414`, `runtime/actor.rs:6801`, `tools/usage.rs:188`.

## See also

- [orgtree-language-servers](../../providers/language-servers/SKILL.md)
- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- [orgtree-harness-codex](../harness-codex/SKILL.md)
- [orgtree-harness-opencode](../harness-opencode/SKILL.md)
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
