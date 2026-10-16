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

Argon offers low, medium and high effort. The saved choice reaches `agy` as
`--effort` when its process starts; changing it takes effect at the next turn
through process replacement, not mid-turn. Flash and AGY Claude also offer
medium; Pro, Barium and Carbon retain low/high. Model availability still depends
on the account's registry. These controls do not promise a measured change in
reasoning tokens, latency or answer quality.

`agent_response` steps stream text deltas. At the step's DONE state, its input/cache-read/output usage is accumulated; thinking-token counts join output. This adapter has no separate reasoning-text branch: a thinking-token count is not a visible chain of thought. A response supplied only in the final result still becomes a transcript row.

Tool steps provide a tool name, parameters, state and result/error. Orgtree records the first observed step as the start and DONE/ERROR as the end, updating arguments when later step information arrives. No distinct tool-writing phase is reported here; writing time is unknown, and these are engine-observed intervals rather than guaranteed native execution durations.

Usage windows come from the separate zero-inference `/usage` metadata path. Gemini and Claude-family offerings spend different groups; cadence/freshness and unsupported readings are defined in `orgtree-usage-windows` (orgtree-working › accounts). Result errors, sign-in blocks and typed window/reset evidence are not interchangeable.

## Caching

The engine currently assigns a 300-second value to Antigravity turn accounting/receipts. This is an adapter value, not a verified published provider retention contract; the actual provider TTL remains unknown in this review. Gemini local token-price estimates also do not establish a cache-retention promise. Claude-family costs on this route stay unknown rather than borrowing Gemini prices.

The launch fingerprint covers the Orgtree identity, tool/MCP config, folders/permission posture, model and account inputs. Model/provider/account/session changes and prefix rewrites can cost continuity; dynamic envelope facts and effort-only controls do not themselves rewrite earlier content. At integrated `0f41fc3`, `Inputs::Agy { home, cwd }` tracks native personal-global and project notes, wrapped with the shared personal-global snapshot and combined skill digest. Native note edits participate in the `startup` fingerprint at the next permitted boundary; generated identity parts do not feed back into it. This does not establish detection of every on-demand native rule. Source: `runtime/startup.rs` (`agy_project`, `native_files`), `runtime/actor.rs` (`startup_inputs`, `plan`), `runtime/global_instructions.rs`. Common rules are in `orgtree-cache-continuity` (orgtree-working › accounts).

## Compaction

The checked adapter does not pass the org Claude/Codex auto-compaction threshold to AGY, expose a native compaction RPC, or normalize an AGY compaction event. The exact native automatic threshold and what its summary retains are unknown here. The current `/compact` command path does not operate on this lane.

Orgtree cheap compact remains a separate fresh-session/handoff operation: durable files and records survive while old conversation is exported rather than carried wholesale. A known-cold automatic policy needs qualifying evidence; elapsed time alone or an assumed AGY TTL is insufficient. See `orgtree-context-and-compaction` (orgtree-working › runtime).

## Instructions and skills

The own-notes fix, independently approved at `3454e80` and integrated at `0f41fc3`, keeps the scratch working directory and writes the managed identity into owned rules instead of overwriting `AGENTS.md`. Scratch `AGENTS.md`, `GEMINI.md` and their `.agents/` counterparts remain native workspace inputs; Orgtree does not mirror those native files back into the identity. Non-native legacy `CLAUDE.md` and otherwise omitted granted-folder notes retain their standing-note delivery. Source: `runtime/agy.rs` (`workspace`, `write_identity_rules`), `runtime/startup.rs` (`agy_project`, `standing_notes`).

Antigravity 1.3.5's shipped Workspace Rules documentation, inspected on 2026-10-15, specifies **24,000 bytes per rule file after include expansion**, truncated at line boundaries. Standalone `GEMINI.md`/`AGENTS.md` files are always active for their directory scope and do not accept frontmatter. Always-on and global rules additionally share a **20,000-token rules budget**; over-budget rules become file pointers for on-demand reading. Native builtin-plugin rules are exempt. This is a dedicated rules budget, not the whole model context or the separate skills/workflows/subagents/MCP customization budget. Native tokenization and complete model visibility were not measured here.

The engine writes numbered `.agents/rules/orgtree-identity-NNNN.md` files with always-on headers and at most 23,000 UTF-8-safe body bytes, keeping each complete generated file below 24,000 bytes. Unchanged parts are not rewritten; surplus owned parts are removed at replacement. A reserved path without the exact ownership header refuses launch. This addresses raw per-file size; expanded includes and the aggregate budget still apply. Independent synthetic/fake-CLI checks verified output and note preservation, including a 56,918-byte identity fixture; native tokenizer budgets and complete model-visible inclusion remain unmeasured. Source: `runtime/agy.rs` (`write_identity_rules`); `docs/agy-standing-notes.md` records the approved receipt and its limits.

Before replacement, after the old process closes, an exact recognized legacy generated envelope is moved byte-for-byte to a unique `AGENTS.generated-identity-<uuid>.bak`, then startup state is recaptured. Nonmatching notes and native leaf symlinks are left untouched. An authored edit inside a matching envelope moves into the recoverable backup too; inspect and manually restore such notes if needed. This cannot recover notes lost before the fix. Source: `runtime/agy.rs` (`migrate_generated_identity`, `legacy_identity_envelope`), `runtime/actor.rs` (migration before replacement planning).

Identity output and legacy migration resolve aliases in the trusted parent of scratch, such as macOS `/var`, then reject links or Windows junctions at scratch itself and below. A linked `.agents` or `rules` directory cannot redirect identity writes or cleanup. Native note-file symlinks remain native and are not migrated. Source: `runtime/agy.rs` (`identity_output_root`, `validate_identity_output`).

Personal globals are independently shared read-only at `7f5f27f`: native AGY globals are excluded from the appended block by canonical identity, while foreign personal globals enter the managed identity. Snapshot text and startup digest come from one capture. The own-notes fix preserves this global/project composition. Source: `runtime/startup.rs`, `runtime/global_instructions.rs`, `runtime/actor.rs` at `0f41fc3`.

At `de6d356`, shared skills are exported as owned `.agents/skills` workspace copies before launch, with deterministic aliases for imported bundles. Owned copies change only after the old process closes; user-created destinations are preserved or explicitly refused on conflict. The combined startup digest includes skill content and is retained by the own-notes fix. Skill copies and generated identity rules are separate outputs. Common discovery and limits live in [skills and instructions](../../providers/skills-and-instructions/SKILL.md). Source: `providers/skills.rs:103`, `runtime/actor.rs:2794` at `de6d356`, composed at `0f41fc3`.

## Tools, permissions and sandbox

Orgtree tools and granted external MCP servers use a private engine bridge and generated plugin configuration. Print mode cannot answer ordinary interactive permission prompts, so the CLI is launched with skip-permissions while Orgtree's PreToolUse hooks deny disabled terminal/edit/web/subagent capabilities. Read-only seats also have the terminal closed: no verified read-only shell containment is assumed.

These hooks are not an OS filesystem sandbox, and a folder grant does not establish shell containment. On Windows the rights-hook command must be reachable without unsafe cmd quoting, via a suitable path or its 8.3 alias; if the hook cannot be installed, the narrowed seat fails to launch. No separate Session 0 OS sandbox guarantee is established for AGY here.

## Models and effort

Use the discovered Google catalog. Gemini tiers spend Gemini windows; `agy-sonnet`/`agy-opus` require the app's `antigravity_claude_enabled` opt-in and the appropriate catalog offer. Its default is false. The runtime setting belongs to the app Runtime controls; enabling it neither signs in nor creates quota.

AGY maps `none`/`minimal` to `low`, unsupported larger names to `high`; `medium` is supported for Flash and the Claude-family route. Those Claude-family model IDs encode effort variants. A model/effort change can therefore change the model ID even though a pure effort-only control elsewhere does not rewrite the old prefix. Secondary subscription-profile selection is unsupported in this integration.

## Gotchas and workarounds

Source paths below use `engine/rs/orgtree-engine/src` at `72ea305`, unless a different source/date is named.

- **Silent rule truncation:** keep user-maintained rules below the expanded 24,000-byte cap. Orgtree now splits its generated identity into bounded always-on parts; do not edit those owned outputs. Keep combined inline rules within the 20,000-token budget; splitting never raises it. Read pointed-to overflow files when needed. Source: agy 1.3.5 embedded Workspace Rules, observed 2026-10-15, offset 59,700,176; integrated `0f41fc3` `runtime/agy.rs` (`write_identity_rules`).
- **Legacy generated notes:** use native `AGENTS.md` for durable notes, keeping it separate from generated identity rules. Recognized old envelopes migrate to a recoverable backup; interior authored edits move with them and require manual restoration. Nonmatching stale envelopes can still load natively. Source: integrated `0f41fc3` `runtime/agy.rs` (`migrate_generated_identity`), `docs/agy-standing-notes.md`.
- **Hook mail is boundary delivery:** when urgent redirection cannot wait, manual interrupt and follow-up at a tool-call boundary is a workflow option, but on AGY it stops the process tree and may stop child commands. No automatic interrupt-on-mail workaround is implemented at this base. Source: `runtime/actor.rs:1414`, `runtime/actor.rs:3132`, `runtime/agy.rs:194`.
- **Flat mail arguments:** this lane retains its verified flat tool shape; copying another harness's nested metadata form can fail. See `orgtree-tool-message` (orgtree-working › mail). Source: `runtime/agy.rs:95`, `tools/defs.rs:191`.

## See also

- See `orgtree-tool-message` (orgtree-working › mail).
- [orgtree-harness-comparison](../harness-comparison/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
