---
name: orgtree-harness-opencode
description: Explain OpenCode ACP reporting, queued mail, isolated custom-provider sessions and permission gotchas.
---
Up: [orgtree-harnesses](../SKILL.md)

# OpenCode over ACP

OpenCode is an optional installed harness for [OpenRouter](../route-openrouter/SKILL.md) and [local-server](../route-local-server/SKILL.md) seats. Discovery negotiates OpenCode 2.x/ACP1 and session-load support; a matching filename alone is insufficient. It uses the selected provider, not the user's OpenCode login.

## How it runs

An isolated OpenCode ACP process speaks JSON-RPC. Orgtree initializes, loads an existing session or opens a new one, selects the model, then issues one `session/prompt` per turn. Ordered session updates arrive before the final prompt result. Session-load replay is suppressed; a failed load is explicit rather than silently opening a replacement conversation. Persistent isolated lane state holds resume history; temporary launch config is removed on teardown.

There is no implemented mid-turn steering channel. Mail waits for the next turn. Manual interrupt sends `session/cancel`; ordinary close cancels an active prompt, drops the connection/stdin and waits five seconds before recorded forced termination if necessary. Cancellation is not an acknowledgement that queued mail entered the old prompt.

## Information and timing

`agent_message_chunk` and `agent_thought_chunk` stream text/thought content when supplied. `tool_call`/`tool_call_update` carry ID, raw input/output, locations, status and content; the engine merges updates and observes the chip's start and end. It routes tool chips through the shared item renderer. No partial argument-writing telemetry is provided, so writing time is unknown, not zero.

The prompt result's input/output/cached-read/cached-write counts are per prompt. `usage_update` gives context used/window independently. A custom provider's zero `cost.amount` is not a price receipt; cost stays unknown. Generic ACP error codes do not establish a typed subscription quota/reset freeze. OpenRouter key standing or the local server's concurrency state is separate from ACP token telemetry; native subscription windows are n/a for this adapter.

There are bounded transcript previews and at most 512 distinct tool items per turn; these are Orgtree display/admission bounds, not the provider's context or native instruction limit. Text-only prompt blocks include attachment path references; native ACP image blocks are not sent by this integration.

## Caching

Custom-provider cache lifetime is unknown and the forecast marks the capability unsupported. Reported cached tokens do not create a verified TTL. The configured identity/tools/scope/model/account startup fingerprint can still detect incompatibility. Provider/account/model/session changes and prefix rewrites can cost continuity; dynamic envelope facts and appended turns do not themselves rewrite old prefix content. Effort-only saved controls are not proof this custom route negotiated reasoning settings.

See `orgtree-cache-continuity` (orgtree-working › accounts) for the shared rule: a live process, resumed session or compatible local fingerprint never guarantees a provider hit.

## Compaction

The checked adapter neither sends a native auto-compaction threshold nor exposes a dedicated compaction operation/event to Orgtree. The exact OpenCode native automatic policy and what a native summary retains are unknown here. Native `/compact` through the current Orgtree command path is unsupported; its generic refusal is not proof compaction is impossible inside every OpenCode version.

Use the separate cheap-compact fresh-session/handoff workflow when authorized and appropriate. Durable files/Orgtree history survive; the old full prompt does not become the new context. See `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The private config supplies the Orgtree identity as the primary agent's `system` text. At `72ea305`, explicit `skills`, `instructions` and plugin lists are empty, project OpenCode config is disabled, and private homes/config/cache/state prevent inheriting the user's OpenCode login or project mutation settings. Do not translate empty additional roots into a claim that every native skill loader is disabled.

Native global/project instruction precedence and a general instruction byte/token cap are unknown for this isolated base unless separately evidenced. Pending native skill roots and cross-harness personal-global delivery are documented once in [skills and instructions](../../providers/skills-and-instructions/SKILL.md). Granted MCP servers enter private config as direct tools with `codemode:false`.

## Tools, permissions and sandbox

Direct native read/write paths are canonicalized against grants, including nearest existing ancestors and all reported locations/raw/diff paths. Missing or unknown paths fail closed; read-only grants authorize no writes. Shell follows the terminal capability, and external MCP follows exact granted server namespaces; arbitrary MCP arguments are not interpreted as native filesystem paths.

Code Mode `execute` is refused in default/acceptEdits because nested tools/fetch are not individually exposed for approval. Bypass permits them unrestrictedly. Approvals choose only once-only allow/reject, never an always-allow rule. This is callback scope enforcement, not an OS sandbox, and no additional Windows Session 0 containment is claimed.

## Models and effort

The custom model comes from the selected OpenRouter/local route with explicit context/output limits and text/tool capabilities. Its actual server must support that protocol/model. At this base no custom-provider effort option is configured; a saved effort string is not evidence reasoning was applied. Exact server-native model/effort internals are unknown here.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **No live mail steer:** wait for the next turn, or deliberately interrupt at a tool-call boundary and send follow-up input when urgent. The current adapter does not automatically interrupt on new mail. Do not assume a cancelled command's side effects rolled back. Source: `runtime/actor.rs:1414`, `runtime/opencode.rs:139`, `runtime/actor.rs:3346`.
- **Tools may appear late:** startup waits up to five seconds for bridge initialize/tools-list and then 250 ms to settle. This observes the handshake, not the model's catalog. A timeout continues with an explicit tools-may-appear-late note. Source: `runtime/opencode.rs:81`, `runtime/opencode.rs:127`.
- **Code Mode is not direct tool approval:** do not bypass a denial by wrapping it in `execute`; bypass mode intentionally changes the policy and is not a folder-scope workaround. Source: `runtime/acp_scope.rs:35`, `runtime/opencode.rs:251`.
- **Unknown price/TTL:** consult the provider key's standing rather than treating custom-provider zero cost or cached-token counts as a billing/cache guarantee. Source: `runtime/acp.rs:282`, `runtime/actor.rs:6800`.

## See also

- [orgtree-openrouter](../../providers/openrouter/SKILL.md)
- [orgtree-language-servers](../../providers/language-servers/SKILL.md)
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
