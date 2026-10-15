---
name: orgtree-harness-claude-code
description: Explain Claude Code lifecycle, streamed evidence, compaction, instructions and permission gotchas.
---
Up: [orgtree-harnesses](../SKILL.md)

# Claude Code

Claude Code is a harness for Claude subscription/key seats and for the separate [OpenRouter](../route-openrouter/SKILL.md) and [local-server](../route-local-server/SKILL.md) routes. A harness choice does not determine the billed provider.

## How it runs

Orgtree starts one `claude -p` process per active agent with stream-JSON input/output, partial messages and a generated append-system-prompt file. A user-message envelope starts a turn; a `result` ends it. Warming may retain the process across turns. A restarted process can use `--resume`; Orgtree searches/copies the matching transcript when the account/project location changed, otherwise prepares a fresh-session handoff.

Mail is injected by the control-channel `PostToolUse` hook as `additionalContext` after a tool call. This is hook delivery, not an immediate native `turn/steer` RPC. Mail arriving during model generation can wait for that boundary or the next turn. The control-channel interrupt requests that the current turn stop. Ordinary close drops stdin, waits five seconds, then terminates a lingering process tree; the explicit kill path terminates directly. Exit observation is logged; this driver does not use the Codex/Muse durable graceful/forced-stop helper. Do not describe every stop as graceful shutdown.

Background tasks and unread background results can hold a process open even when ordinary warming is off. Orgtree interrupts autonomous CLI turns used to deliver background results, then admits the agent's next turn itself. A live process and an admitted agent turn are separate states.

## Information and timing

Text and thinking arrive as partial content-block deltas; completed assistant blocks become durable rows. Tool-use block start, partial JSON arguments and block stop expose the tool-writing phase. Orgtree persists `writing_secs` only when that phase was actually observed. The completed tool-use block creates the execution chip; a user `tool_result` supplies completion, output/error and the engine's observed end timestamp. Those timestamps measure adapter-observed intervals, not an independently verified remote execution clock.

The result carries turn usage and a cumulative session cost counter, whose difference is charged to the turn. Input, cache-read, cache-creation and output counts stay separate; latest model-call input supports context occupancy. `rate_limit_event` supplies structured limit evidence; result errors and process exits remain distinct. Thinking is supplied provider text, not proof that every internal reasoning token is visible.

Claude account session/weekly/scoped windows come from a separate usage metadata reader. It shares the sixty-second attempt floor and provider-wait rules with desktop and permitted tool readers; the turn-envelope board itself never probes. Exact windows, freshness and cadence belong in `orgtree-usage-windows` (orgtree-working › accounts).

## Caching

Claude subscription guidance is sixty minutes; API-key guidance is five minutes. Receipt fields can distinguish one-hour and five-minute cache writes. A positive read/write receipt and compatible sent fingerprint support the forecast; neither a warm process nor a resumed session guarantees the next provider hit.

The compared prefix includes identity/charters, tools and MCP definitions, folders, permission mode, account credential generation, model and native startup files. Provider/account/model/session changes or rewriting already-sent content can cost continuity. Append-only turns and dynamic envelope facts, or an effort-only control change, do not by themselves rewrite the earlier prefix. Detailed common receipt rules live in `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

Orgtree passes the effective org `compact_at` fraction as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in percent when the CLI starts. A warm CLI retains its launch configuration. Native `compact_boundary` events record compaction and reported pre-compaction tokens; they are not fresh-session resets. An idle existing session can receive `/compact` through the command path.

Cheap compact instead exports earlier conversation and starts a fresh session with a bounded handoff on the same agent. Durable files and Orgtree records survive; the complete old conversation is not inserted into the new prompt. Exact provider-summary retention is unknown here. Automatic cold resets require the configured policy and qualifying measured context/cache evidence; see `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The native startup manifest accounts for managed/user `CLAUDE.md`, the project ancestor chain's `CLAUDE.md`/`CLAUDE.local.md`, cwd `.claude/CLAUDE.md`, unscoped rules and imports. Installed CLI evidence records project `AGENTS.md` fallback only when that project chain has no nonempty Claude notes. Native `--add-dir` alone does not load granted-folder notes; Orgtree supplies otherwise omitted standing notes without duplicating native files.

The manifest follows imports up to five hops and fingerprints only the native auto-memory prefix of 25 KiB/200 lines. These are the checked startup-reader bounds, not a universal instruction-file limit. A general native maximum for all instruction files is unknown here. Startup edits apply at a subsequent process/turn boundary, not by rewriting an active turn.

Common built-in/user skill discovery, native export status and personal global sharing are owned by [skills and instructions](../../providers/skills-and-instructions/SKILL.md). Orgtree's own tools use its in-process MCP control channel; external definitions/grants use [MCP servers](../../providers/mcp-servers/SKILL.md).

## Tools, permissions and sandbox

The launch applies permission mode, allowed/disallowed tools and read-only-folder write denials. Sensitive-path writes can have a separate CLI gate; a folder grant alone does not override it. Terminal, web, edit and subagent capability switches also narrow the launch. Do not claim these controls are a separate OS filesystem sandbox or infer extra Session 0 containment from the folder list.

Headless approvals and tool capability checks remain distinct from account/model availability. A missing tool is not permission to change credentials or loosen the seat's mode.

## Models and effort

Claude tiers include Fable, Opus, Sonnet and Haiku; the effective offer and version pin determine the selected model. Claude effort vocabulary is `low`, `medium`, `high`, `xhigh`, `max`; unsupported saved values clamp at launch while the stored value remains unchanged. Eligible Claude seats can receive `apply_flag_settings` for the next model call mid-turn; acknowledgement is not proof of model compliance. Other routes/model catalogs have their own limits.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **No immediate mail-steer RPC:** the hook waits for a tool boundary. When urgent redirection cannot wait, a human can interrupt at a tool-call boundary and continue with follow-up input. This is an explicit workflow, not an automatic interruption on every new mail; interruption does not prove a side effect rolled back. Source: `runtime/actor.rs:1414`, `runtime/actor.rs:3704`, `runtime/claude.rs:272`.
- **Background work is process-owned:** closing the CLI can orphan unfinished work. Follow the runtime's held-process/background-result policy and record durable progress before a fresh session. Source: `runtime/actor.rs:4530`, `runtime/actor.rs:4550`; DECISIONS 77.
- **Instruction fallback differs:** a project Claude note can suppress native AGENTS fallback. Check delivered standing notes and the native manifest rather than assuming every adjacent file loaded. Source: `runtime/startup.rs:120`, `runtime/startup.rs:93`.
- **Cache and tool timings are evidence-limited:** retain unknown writing time when the partial stream was missed, and use positive receipts rather than a process-warm badge. Source: `runtime/toolwriting.rs:23`, `runtime/actor.rs:5495`, `runtime/identity.rs:728`.

## See also

- [orgtree-providers-tab](../../providers/providers-tab/SKILL.md)
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
