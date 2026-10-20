---
name: orgtree-harness-comparison
description: Compare all five harnesses: steering, effort, usage, fast mode, tool readiness and writing, accounts, caching, compaction, permissions and continuity.
---
Up: [orgtree-harnesses](../SKILL.md)

# Harness comparison

This is the operational summary of the developer harness parity reference, `docs/harness-parity.md`,
audited **2026-10-20 at `32bb4144e0337a3c425e71515863a3412bf77987`**.
Its matrices cite the implementation, recorded decisions and dated native
observations. The links below pin evidence to that source revision; the developer document contains the full file:line index and limitations.
Update both pages when behavior changes.

There are **five harnesses**: Claude Code, Codex CLI, Antigravity, Muse Code and
OpenCode. Gemini models run through Antigravity here. OpenRouter and language
model servers are routes through Claude Code, Codex or OpenCode, not extra
harnesses. A provider's cache, quota and authentication are separate from its
driver's transport features. [Roster and routes][REG].

“Unknown” means the integration has no verified contract, not zero or proof that
the upstream CLI cannot do it. “Delivered” means accepted input, not obedience.

## Controls and observable output

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Mid-turn **message** steering | Hook mail at PostToolUse; another user message is a follow-up. [WAKE] | Native exact-turn `turn/steer`. [X-CONTROL] | Invocation hooks with receipt-backed pending mail. [A-STEER] | Native exact-turn `turn/steer`. [M-CONTROL] | Queued until a later turn; no native steer integration. [O-RUN] |
| Mid-turn **effort** change | Eligible native Claude tiers only; next model call, “sent” is not measured effect. [EFFORT] | Next turn; process replacement/resume. [EFFORT] | Next launch/turn. [EFFORT] | Next turn, host may remain. [EFFORT] | Generic effort negotiation unknown. [O-EFFORT] |
| Fast mode | Exact native supported Opus models and acknowledged control. [FAST] | Native OpenAI model must advertise fast/priority service. [FAST] | No mapping. [FAST] | No mapping. [FAST] | No mapping. [FAST] |
| MCP readiness | Bounded status gate before first prompt; no-pending can include failed servers, so “ready” is not all-tools-success. [C-MCP] | Dynamic tools supplied at setup; no universal external-MCP ready barrier. [X-RUN] | Bridge configured; no all-tools-ready acknowledgment. [A-MCP] | Session MCP capability/config acceptance; not catalog readiness proof. [M-RUN] | Bounded bridge handshake observation; tools may still appear late. [O-RUN] |
| Tool-call writing time | Partial JSON deltas and observed writing interval. [WRITING] | Unknown; item execution timing is different. [X-TOOLS] | Unknown; step/parameter updates are different. [A-EVENT] | Unknown; item lifecycle is different. [M-TOOLS] | Unknown; tool updates are different. [O-EVENT] |
| Thinking in transcript | Exposed deltas/blocks; redacted material stays redacted. [C-STREAM] | Reasoning/summary deltas and items. [X-EVENT] | After DONE: exact session/step native history recovery before response; can safely skip. [A-THOUGHT] | MSP reasoning events/items. [M-EVENT] | Thought chunks if emitted. [O-EVENT] |
| Inline images | Validated image blocks. [IMAGES] | Local-image blocks. [IMAGES] | Text/path envelope only in this adapter. [SEND] | MSP image content. [M-IMAGES] | Text/path envelope only in this adapter. [SEND] |
| Live shell tail | No live-tail delta mapping here. [C-STREAM] [SHELL] | Native command-output deltas. [SHELL] | Settled step output; no live-tail mapping here. [A-EVENT] | Output deltas/in-progress snapshots. [SHELL] | In-progress content snapshots. [O-EVENT] |
| Interrupt | Control interrupt. [C-CONTROL] | Exact-turn interrupt. [X-CONTROL] | Stops process tree. [A-STOP] | Turn interrupt; separate background-task controls. [M-CONTROL] | Session cancel. [O-RUN] |

No automatic interrupt-on-mail feature is implied by the hook workaround.
DND is checked before delivery. Live shell tails are bounded and ephemeral, not a complete terminal recording. [SHELL] A manual interrupt does not undo external tool
effects. Thinking-token counts alone do not imply visible thinking text.
Control and transcript contracts [WAKE], thinking limits [A-THOUGHT] [A-HISTORY].

## Usage, accounts, cache and compaction

| Feature | Claude Code / Claude | Codex CLI / OpenAI | Antigravity / Google | Muse Code / Muse | OpenCode / custom provider |
| --- | --- | --- | --- | --- | --- |
| Queryable allowance | OAuth metadata; session/weekly/model limits. [C-USAGE] | HTTP metadata plus app-server rate-limit fallback/events. [X-USAGE] | Guarded zero-token probe, distinct model pools/profile readings. [G-USAGE] | `usage/read` returns last observed quota; cannot force a new reading. [M-USAGE] | OpenRouter key cap/balance or server capacity, not native subscription quota. [OR-USAGE] |
| Usage timing | Cached normally; pressure/activity cadence and manual floor. [U-CADENCE] | Same distinction between cached quota and stream tokens. [U-CADENCE] | Five-minute manual floor; successful zero-token protocol required. [U-QUERY] | Metadata usually every five minutes; same timestamp remains stale. [M-USAGE] | Route-specific metadata/capacity. [OR-USAGE] |
| Turn tokens / cost | Result usage and differenced CLI dollar counter. [TOKENS] | Thread-total differences; model-price estimate. [TOKENS] | DONE-step usage; model-dependent cost estimate/unknown. [TOKENS] | Session usage; children separate; price unknown. [TOKENS] | ACP prompt usage if supplied; custom cost unknown/local. [TOKENS] |
| Multiple accounts | Managed/imported profiles and API keys. [ADD-ACCOUNT] | Selected Codex homes and API keys. [ADD-ACCOUNT] | Profile guards exist, but measured Windows CLI shares one keyring login; independent concurrent sign-ins not verified. [A-ACCOUNTS] | Managed config/data roots and keys; imported-folder sign-in refused. [ADD-ACCOUNT] | Custom keys/servers, not native OpenCode subscription profiles. [REG] |
| Prompt-cache expiry | Engine guidance/receipts: subscription ~1h, key ~5m; no guarantee. [CACHE-GUIDE] | Native 30-minute engine estimate; no guarantee. [CACHE-GUIDE] | Engine 300-second value; actual provider expiry unknown. [TOKENS] | Cache read may be known; TTL unknown. [FORECAST] | Custom-provider TTL unknown. [FORECAST] |
| Normal compaction | Yes; Claude-driven custom routes too. [COMPACT] | Not offered by Orgtree. [COMPACT] | Not offered by Orgtree. [COMPACT] | Yes; native completion required, not just request admission. [M-COMPACT-EVENT] | Not offered by Orgtree. [COMPACT] |
| Cheap compaction | Shared fresh session + bounded handoff; preserve history. [CHEAP] | Same; different from normal compact. [CHEAP] | Same engine operation. [CHEAP] | Same; unknown TTL cannot itself trigger cold reset. [CHEAP] | Same; unknown forecast cannot trigger cold reset. [CHEAP] |

Allowance freshness, turn tokens, occupancy and prompt-cache receipts are four
different facts. A fresh account label does not freshen old quota. After a Muse
reset passes, an old percentage becomes unknown until a new reading arrives.
Fallback respects org-enabled account lanes and eligibility; it is not a promise
that a different account will be chosen. Usage [U-TOOL] [M-USAGE] [U-FRESH], accounts [FALLBACK] [ORG-ACCOUNTS].

**Custom-route caveat:** OpenRouter through Claude/Codex can still display
driver-derived TTL values at this source version. They do not establish the
backend's expiry. Language model server and ACP forecasts explicitly report
unknown. Never promise a cache hit from a warm process or compatible prefix.
Cache evidence and implementation discrepancy [FORECAST].

## Continuity, instructions and safety boundaries

| Topic | Gotchas and source evidence |
| --- | --- |
| Model/account/harness changes | Reconciled at boundaries; process restart and native session reset are different. Cross-harness changes need a fresh handoff; OpenCode load failure is explicit. [RECONFIGURE] [O-RUN] |
| Startup files and skills | Per-harness native manifests plus deduplicated read-only personal globals. Claude shared root, Codex extra-roots RPC, AGY/Muse owned workspace entries, OpenCode configured roots. Startup changes apply at permitted boundaries. [STARTUP] [GLOBALS] [SKILLS] [X-RUN] [O-LAUNCH] |
| AGY instruction limits | Dated CLI 1.3.5 evidence: expanded 24,000-byte file cap and aggregate 20k-token rules budget. Numbered identity parts do not raise the total budget. [A-RULES-DOC] |
| Windows placement | All five harnesses, including Codex bypass seats, can use the selected signed-in session. Placement changes at boundaries; Session 0 has no user's desktop. [HOST] |
| Sandbox limits | Codex hosted/fallback posture differs; Muse has a documented Session 0 writable sandbox limitation; AGY hooks and ACP callbacks are not OS sandboxes. [X-PERM] [M-PERM] [A-PERM] [O-PERM] |
| Shutdown | EOF/cancel and bounded grace precede force where implemented. Explicit AGY interrupt is process termination. Durable forced-stop accounting is adapter-specific. [C-STOP] [X-STOP] [A-STOP] [M-STOP] [O-STOP] |
| Background work | Claude/Muse have explicit held-result handling; native subagent scope does not imply equal background protocols across every harness. [BACKGROUND] |
| Native MCP elicitation | Codex has the explicit human-only form/URL bridge. Equivalent integration on the other adapters is unknown; their approval callbacks are separate. [X-ELICIT] [ELICIT] |
| Refusals | Auth, quota, transport, permission denial and model refusal are different. A universal cross-provider content-filter taxonomy is unknown. [RECOVERY] |

## Detailed pages

- [Claude Code](../harness-claude-code/SKILL.md)
- [Codex](../harness-codex/SKILL.md)
- [Antigravity](../harness-antigravity/SKILL.md)
- [Muse](../harness-muse/SKILL.md)
- [OpenCode](../harness-opencode/SKILL.md)
- [OpenRouter](../route-openrouter/SKILL.md)
- [Language model servers](../route-local-server/SKILL.md)
- [Skills and instructions](../../providers/skills-and-instructions/SKILL.md)
- Full source index and unknowns: `docs/harness-parity.md` in the development checkout.
- See `orgtree-cache-continuity` (orgtree-working › accounts).
- See `orgtree-context-and-compaction` (orgtree-working › runtime).

[A-ACCOUNTS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/docs/rust-engine/antigravity-accounts.md#L3
[A-EVENT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L5660
[A-HISTORY]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/agy_thinking.rs#L17
[A-MCP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/agy.rs#L153
[A-PERM]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/agy.rs#L318
[A-RULES-DOC]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/docs/agy-standing-notes.md#L1
[A-STEER]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L3777
[A-STOP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/agy.rs#L221
[A-THOUGHT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L5685
[ADD-ACCOUNT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/http/accounts.rs#L104
[BACKGROUND]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L5261
[C-CONTROL]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/claude.rs#L294
[C-MCP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L58
[C-STOP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/claude.rs#L332
[C-STREAM]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L6228
[C-USAGE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L748
[CACHE-GUIDE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/identity.rs#L956
[CHEAP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L2482
[COMPACT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/domain/compaction.rs#L47
[EFFORT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L1547
[ELICIT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/elicitation.rs#L1
[FALLBACK]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/freeze.rs#L282
[FAST]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/providers/fast_mode.rs#L7
[FORECAST]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L8113
[G-USAGE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L1181
[GLOBALS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/global_instructions.rs#L67
[HOST]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/session_host.rs#L1
[IMAGES]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L8248
[M-COMPACT-EVENT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L5138
[M-CONTROL]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/muse.rs#L708
[M-EVENT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L4752
[M-IMAGES]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/muse.rs#L1068
[M-PERM]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/muse.rs#L82
[M-RUN]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/muse.rs#L550
[M-STOP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/muse.rs#L782
[M-TOOLS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L4950
[M-USAGE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L1433
[O-EFFORT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L3380
[O-EVENT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L3401
[O-LAUNCH]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/opencode.rs#L163
[O-PERM]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/acp_scope.rs#L1
[O-RUN]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/opencode.rs#L42
[O-STOP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/acp.rs#L169
[OR-USAGE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L1582
[ORG-ACCOUNTS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/org_accounts.rs#L73
[RECONFIGURE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L1610
[RECOVERY]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L7252
[REG]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/harnesses.rs#L32
[SEND]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L4234
[SHELL]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/shell_output.rs#L1
[SKILLS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/providers/skills.rs#L28
[STARTUP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/startup.rs#L1
[TOKENS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L7104
[U-CADENCE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L1884
[U-FRESH]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage/query.rs#L74
[U-QUERY]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L432
[U-TOOL]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/tools/usage.rs#L260
[WAKE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L1655
[WRITING]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/toolwriting.rs#L23
[X-CONTROL]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/codex.rs#L420
[X-ELICIT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/codex.rs#L620
[X-EVENT]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L4614
[X-PERM]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/codex.rs#L95
[X-RUN]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/codex.rs#L330
[X-STOP]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/codex.rs#L456
[X-TOOLS]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/runtime/actor.rs#L5993
[X-USAGE]: https://github.com/Maurdekye/orgtree/blob/32bb4144e0337a3c425e71515863a3412bf77987/engine/rs/orgtree-engine/src/usage.rs#L904
