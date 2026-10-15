---
name: orgtree-harness-antigravity
description: Explain Antigravity stream events, invocation-hook mail, native rule budgets and scope limitations.
---
Up: [orgtree-harnesses](../SKILL.md)

# Antigravity

Antigravity (`agy`) drives the Google lane, including Gemini models and the optional Claude-family offerings. Claude models on this route use Google's login and third-party windows, not an Anthropic subscription.

## How it runs

One persistent `agy -p=` process accepts stream-JSON user messages, emits initialization/trajectory steps and ends each turn with a result. A saved conversation ID is supplied with `--conversation` after process restart. The reported initialization model is checked against the requested model; a mismatch ends the turn rather than silently accepting a different model.

Mid-turn mail is handed to `PreInvocation`/`PostInvocation` hooks, which insert a user-message step at an invocation boundary without interrupting the turn. This is hook injection, not a native `turn/steer` RPC. An emitted hook receipt proves local handoff, not model obedience. If hook installation/delivery fails, mail waits for a later turn.

Ordinary close drops stdin and waits five seconds before terminating a lingering process. The explicit interrupt has no gentler verified mechanism: it terminates the process job/tree. Kill also terminates directly. Exit observation is logged; this driver does not use the Codex/Muse durable graceful/forced-stop helper. Resume is conversation continuity, not restoration of running child commands.

## Information and timing

`agent_response` steps stream text deltas. At the step's DONE state, its input/cache-read/output usage is accumulated; thinking-token counts join output. This adapter has no separate reasoning-text branch: a thinking-token count is not a visible chain of thought. A response supplied only in the final result still becomes a transcript row.

Tool steps provide a tool name, parameters, state and result/error. Orgtree records the first observed step as the start and DONE/ERROR as the end, updating arguments when later step information arrives. No distinct tool-writing phase is reported here; writing time is unknown, and these are engine-observed intervals rather than guaranteed native execution durations.

Usage windows come from the separate zero-inference `/usage` metadata path. Gemini and Claude-family offerings spend different groups; cadence/freshness and unsupported readings are defined in `orgtree-usage-windows` (orgtree-working › accounts). Result errors, sign-in blocks and typed window/reset evidence are not interchangeable.

## Caching

The engine currently assigns a 300-second value to Antigravity turn accounting/receipts. This is an adapter value, not a verified published provider retention contract; the actual provider TTL remains unknown in this review. Gemini local token-price estimates also do not establish a cache-retention promise. Claude-family costs on this route stay unknown rather than borrowing Gemini prices.

The launch fingerprint covers the Orgtree identity, tool/MCP config, folders/permission posture, model and account inputs. Model/provider/account/session changes and prefix rewrites can cost continuity; dynamic envelope facts and effort-only controls do not themselves rewrite earlier content. At `7f5f27f`, `Inputs::Agy` tracks native personal-global files, wrapped with the shared personal-global snapshot. Their edits participate in the `startup` fingerprint at the next permitted boundary. This does not resolve the separate generated project-note feedback issue below or establish detection of every on-demand native rule. Source: `runtime/actor.rs:1939`, `runtime/startup.rs:81`, `runtime/global_instructions.rs:75`. Common rules are in `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

The checked adapter does not pass the org Claude/Codex auto-compaction threshold to AGY, expose a native compaction RPC, or normalize an AGY compaction event. The exact native automatic threshold and what its summary retains are unknown here. The current `/compact` command path does not operate on this lane.

Orgtree cheap compact remains a separate fresh-session/handoff operation: durable files and records survive while old conversation is exported rather than carried wholesale. A known-cold automatic policy needs qualifying evidence; elapsed time alone or an assumed AGY TTL is insufficient. See `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

At source `72ea305`, launch writes the full managed identity into scratch `AGENTS.md`, and the next plan can read that generated file back as standing notes. That overwrite/feedback behavior is a known separate issue, not a user-editable identity surface. Do not store irreplaceable personal notes by editing the generated envelope or describe the base as automatically splitting rules.

Antigravity 1.3.5's shipped Workspace Rules documentation, inspected on 2026-10-15, specifies **24,000 bytes per rule file after include expansion**, truncated at line boundaries. Standalone `GEMINI.md`/`AGENTS.md` files are always active for their directory scope and do not accept frontmatter. Always-on and global rules additionally share a **20,000-token rules budget**; over-budget rules become file pointers for on-demand reading. Native builtin-plugin rules are exempt. This is a dedicated rules budget, not the whole model context or the separate skills/workflows/subagents/MCP customization budget. Native tokenization and complete model visibility were not measured here.

The pending own-notes fix at `514861a` writes numbered `.agents/rules/orgtree-identity-NNNN.md` files with always-on headers and at most 23,000 UTF-8-safe body bytes. It is unapproved source-only work awaiting independent verification, absent from this base. It addresses raw per-file size; expanded includes and the aggregate budget still apply.

Personal globals are independently shared read-only at `7f5f27f`: native AGY globals are excluded from the appended block by canonical identity, while foreign personal globals enter the managed identity. Snapshot text and startup digest come from one capture. This leaves the existing project-note overwrite/feedback issue unchanged. Source: `runtime/startup.rs:81`, `runtime/global_instructions.rs:75`, `runtime/actor.rs:1878`.

At `de6d356`, shared skills are exported as owned `.agents/skills` workspace copies before launch, with deterministic aliases for imported bundles. Owned copies change only after the old process closes; user-created destinations are preserved or explicitly refused on conflict. The combined startup digest includes skill content. These copies are separate from the still-pending identity splitter. Common discovery and limits live in [skills and instructions](../../providers/skills-and-instructions/SKILL.md). Source: `providers/skills.rs:103`, `runtime/actor.rs:2794` at `de6d356`.

## Tools, permissions and sandbox

Orgtree tools and granted external MCP servers use a private engine bridge and generated plugin configuration. Print mode cannot answer ordinary interactive permission prompts, so the CLI is launched with skip-permissions while Orgtree's PreToolUse hooks deny disabled terminal/edit/web/subagent capabilities. Read-only seats also have the terminal closed: no verified read-only shell containment is assumed.

These hooks are not an OS filesystem sandbox, and a folder grant does not establish shell containment. On Windows the rights-hook command must be reachable without unsafe cmd quoting, via a suitable path or its 8.3 alias; if the hook cannot be installed, the narrowed seat fails to launch. No separate Session 0 OS sandbox guarantee is established for AGY here.

## Models and effort

Use the discovered Google catalog. Gemini tiers spend Gemini windows; `agy-sonnet`/`agy-opus` require the app's `antigravity_claude_enabled` opt-in and the appropriate catalog offer. Its default is false. The runtime setting belongs to the app Runtime controls; enabling it neither signs in nor creates quota.

AGY maps `none`/`minimal` to `low`, unsupported larger names to `high`; `medium` is supported for Flash and the Claude-family route. Those Claude-family model IDs encode effort variants. A model/effort change can therefore change the model ID even though a pure effort-only control elsewhere does not rewrite the old prefix. Secondary subscription-profile selection is unsupported in this integration.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **Silent rule truncation:** keep user-maintained rules in numbered always-on parts below the expanded 24,000-byte cap. Keep the combined inline rules within the 20,000-token budget; splitting never raises that budget. Read pointed-to overflow files when needed. Do not edit engine-generated identity parts or claim the pending split fix is active. Source: agy 1.3.5 embedded Workspace Rules, observed 2026-10-15, offset 59,700,176; pending `514861a` `runtime/agy.rs:380`.
- **Generated AGENTS overwrite/feedback:** keep durable notes in the supported separate notes/files and track the own-notes fix; the baseline managed envelope is not a safe personal editing target. Source: `runtime/agy.rs:384`, `runtime/actor.rs:1936`; pending `514861a` own-notes fix.
- **Hook mail is boundary delivery:** when urgent redirection cannot wait, manual interrupt and follow-up at a tool-call boundary is a workflow option, but on AGY it stops the process tree and may stop child commands. No automatic interrupt-on-mail workaround is implemented at this base. Source: `runtime/actor.rs:1414`, `runtime/actor.rs:3132`, `runtime/agy.rs:194`.
- **Flat mail arguments:** this lane retains its verified flat tool shape; copying another harness's nested metadata form can fail. See `orgtree-tool-message` (orgtree-working › mail). Source: `runtime/agy.rs:95`, `tools/defs.rs:191`.

## See also

- See `orgtree-tool-message` (orgtree-working › mail).
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
