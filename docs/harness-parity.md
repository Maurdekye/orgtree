# Harness parity in Orgtree 4.4

Source audit: **2026-10-20**, `rust-engine` at
**`32bb4144e0337a3c425e71515863a3412bf77987`**. This is the developer reference;
the [glossary comparison](skills/orgtree-app/harnesses/harness-comparison/SKILL.md)
is its shorter operational summary. Update both when an adapter changes.

OpenCode mail was updated on 2026-10-20 at `181cb4914c5a2373fafc4ca1defe80c0919fbdfa`;
[O-MAIL] and [O-MAIL-PROOF] cite that later contract and its offline measurement.
Other source keys retain the original audit revision.

## 4.4.0 follow-up audit, 2026-10-21

The following deltas were rechecked against `2ec8c0e7d15b8810a7d957add335ac69472541c8`.
They supplement the original matrices without changing the dates of native
measurements. This pass reads source and existing evidence only: no live CLI,
provider, account or installed-data probe was run.

| Area | Current behavior and boundary | Current source |
| --- | --- | --- |
| AGY tool annotations | Normalize eager/default-api and lazy `call_mcp_tool` wrappers onto shared tool names/arguments. PascalCase native file arguments produce file links. Successful results carry shared object refs; ambiguous matches are omitted. Bounded transcript reads heal retained historical chips, not every stored row at startup. | [annotation pipeline][A-ANNOTATIONS-44], [actor][ACTOR-44], `tools/mod.rs`, `http/nodes.rs` |
| AGY thinking | Read the exact completed conversation/step through a short read-only SQLite snapshot, including committed live WAL. Skip busy, malformed or unsafe data; prefer explicit native stream thinking, including redaction. No checkpoint/CLI close or old-transcript backfill is required. Recovery stays after DONE, not live reasoning streaming. | [reader][A-THINKING-44], [contract][A-THINKING-DOC-44] |
| AGY accounts | Registered profiles get their own home, auth latch, usage and admission reading. Missing identity fails closed; a default-identical identity is `not_isolated`. The 1.3.5 shared-keyring limitation remains, so a profile folder does not provide a second subscription. Transient launch checks retry once; real refusals do not. | [auth guard][A-AUTH-44], `usage/agy_reading_tests.rs`, `docs/rust-engine/antigravity-accounts.md` |
| Native context recovery | Claude/Codex context-window overflow receives one cheap fresh-session attempt, then terminal failure. Input-length, auth/quota and interruption policies remain separate. Original mail IDs/receipts survive; a recovery is not newly authored mail. | [actor][ACTOR-44], [recovery policy][RECOVERY-44], [contract][SIZE-DOC-44] |
| Measured-size compaction | After-turn and admission checks can split at the org threshold independently of cache temperature. Missing/estimated occupancy and native-compaction invalidation prevent a false repeat; working status defers the after-turn path. Cold-policy Off does not disable this separate size check. | [actor][ACTOR-44], [contract][SIZE-DOC-44] |
| OpenCode mail and startup | Exact 2.0.28 owned after-tool plugin remains enabled, with DND/urgent gates, stable custody and a single uncertain-recovery return. Discovery pending after restart does not by itself block resume of the known stored OpenCode lane. Other versions/missing hooks retain next-turn delivery. | [adapter][OPENCODE-44], [bridge][OPENCODE-MAIL-44], `docs/rust-engine/opencode-mail.md` |
| OpenRouter harness identity | An explicit hire-time harness, or the agent settings Model tab's Harness row, pins the seat (language model server seats too, from the Model tab); rehire keeps the pin. Unpinned seats follow their key (or server) at the next boundary with a fresh handoff when the driver changes, and a new pin moves the seat there the same way. Registry installation and account eligibility remain separate gates. | `domain/ops.rs::stamp_harness`, `openrouter.rs::seat_harness` |
| Muse identity versus quota | Metadata identity can recover after restart independently of a retained last-good usage observation. That never freshens quota or proves authentication; no on-demand fresh Muse usage query is added. | `providers/muse_models.rs`, `usage.rs`, `usage/muse_cache.rs`, `usage/muse_identity_tests.rs` |

The corresponding glossary leaves now include these contracts and the route
pages no longer call all OpenCode delivery next-turn-only. Other original
source citations below remain historical, not a claim to have rerun their
native proof. Model offers still come from the actual account's catalog;
unknown effort, prices and TTL remain unknown.

This describes what **Orgtree actually implements**, not everything an upstream
CLI might support. Five harnesses are registered: Claude Code, Codex CLI,
Antigravity, Muse Code and OpenCode. **Gemini is a model family inside the
Antigravity route here, not a sixth Gemini CLI adapter.** OpenRouter and language
model servers are provider routes through the first, second or fifth harness.
They do not inherit the native provider's billing or cache contract. [REG]

Every matrix cell links to the source index below. Line numbers refer to the
audited commit; they are navigation aids, not claims that later versions are
unchanged. **Implemented** means source-confirmed integration. **Unknown** means
no verified contract in the cited integration; it does not mean zero, disabled
upstream, or impossible. A dated native observation applies only to the measured
version. No live credentials, provider calls or new CLI measurements were used
for the original audit. The later OpenCode mail proof uses the real 2.0.28
CLI with an isolated engine and synthetic loopback model; no live auth.

## Execution, models and provider routes

| Feature | Claude Code | Codex CLI | Antigravity (AGY) | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Persistent protocol | Stream JSON; user messages and result events, control requests. [C-RUN] | JSON-RPC app-server; threads and turns. [X-RUN] | Stream JSON print mode; conversation and indexed steps. [A-RUN] | MSP host; sessions, turns and typed items. [M-RUN] | ACP v1; session/prompt, updates and one active request. [O-RUN] |
| Native provider in registry | Claude. [REG] | OpenAI. [REG] | Google account route, including its exposed Gemini and third-party model pools. [REG] [G-USAGE] | Muse. [REG] | No native subscription provider wired here. [REG] |
| OpenRouter / model-server use | Both; Messages-style protocol for servers. [REG] [LOCAL] | Both; Responses protocol for servers. [REG] [LOCAL] | Neither registered. [REG] | Neither registered. [REG] | Both; Chat Completions for servers. [REG] [LOCAL] |
| Model / effort source | Tier catalog and native model pins; only eligible tiers get live effort. [EFFORT] [CAT] | Discovered model metadata and allowed efforts; provider can report a reroute. [X-EVENT] [CAT] | AGY catalog and mapped CLI effort; some model IDs encode the effort variant. [A-RUN] [CAT] | Selected login's exact model/variant catalog; missing requested effort maps to that model's default, not a neighbouring model. [M-META] [EFFORT] | Custom model/context configuration; generic reasoning-effort negotiation is **unknown/not configured** in this adapter. [O-LAUNCH] [O-EFFORT] |
| Fast mode | Native Claude only, exact supported Opus model families; acknowledged `fastMode` control. Not `/fast`. [FAST] [C-CONTROL] | Native OpenAI only; exact model must advertise `fast` or `priority`; passed as turn service tier. [FAST] [SEND] | No fast-mode mapping. [FAST] | No fast-mode mapping. [FAST] | No fast-mode mapping. [FAST] |
| Detection / compatibility | Registry uses cached discovery or executable locator; version display is cached. [REG] | Same registry pattern; app-server initialization also negotiates experimental capabilities. [REG] [X-RUN] | Cached executable/version plus separately guarded auth/usage protocols. [REG] [A-AUTH] [G-USAGE] | Cached installation and schema/fingerprint-checked metadata; session capabilities must include required MCP configuration support. [REG] [M-META] [M-RUN] | Installed means validated ACP discovery, not merely an arbitrary executable found on PATH; runtime checks ACP compatibility. [REG] [O-DISCOVERY] |

Fast-mode support is neither account entitlement nor a promised speedup.
Saved model/effort values are not evidence of backend obedience. The source
registry and the selected account's catalog take precedence over a CLI's brand
name. [FAST] [CAT] [M-META]

## Running-turn controls

“Native mid-turn message steering” and “mid-turn effort adjustment” are different
features. A delivery receipt proves custody, not that the model followed the
message.

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Native message injection into the current turn | No exact-turn steer RPC used. Orgtree delivers mail at the PostToolUse hook boundary. Writing another user message queues a follow-up. [WAKE] [C-CONTROL] | **Yes:** `turn/steer` with `expectedTurnId`. [X-CONTROL] [STEER] | No exact-turn steer RPC used. Orgtree supplies mail through invocation hooks. [WAKE] [A-STEER] | **Yes:** `turn/steer` with `expectedTurnId`. [M-CONTROL] [STEER] | **Tool-boundary integration on 2.0.28:** the owned plugin calls native `session.prompt(delivery:"steer", resume:false)` after a tool; no ACP steer RPC. [O-MAIL] [O-MAIL-PROOF] |
| Delivery failure / boundary | No tool boundary means hook mail may wait; no automatic interrupt merely because mail arrived. [WAKE] | Failed steer leaves mail pending; success is committed for that turn only. [STEER] | Pending file is committed only after the matching emitted receipt; unconsumed mail is returned. A hook may not run immediately. [A-STEER] | Same exact-turn custody rule as Codex. [STEER] | Stable ID/session deduplicates confirmed admission. Unknown recovery returns once next turn, marked "may already have been delivered mid-turn". Unsupported version/missing hook/no further tools means next-turn delivery. [O-MAIL] |
| Mid-turn effort adjustment | **Eligible native Claude tiers only:** send `apply_flag_settings.effortLevel`; applies to a subsequent model call, not work already generated. “Sent” is not measured quality/effort. [EFFORT] [C-CONTROL] | Next turn; changed effort marks the process for replacement, then resumes the session where possible. [EFFORT] | Next turn/process configuration. [EFFORT] [A-RUN] | Next turn's `reasoningEffort`; host can stay running. [EFFORT] [M-CONTROL] | No negotiated live effort control; backend effect of a saved preference is **unknown**. [EFFORT] [O-LAUNCH] |
| Interrupt mechanism | Control-channel interrupt; separate from process shutdown. [C-CONTROL] | `turn/interrupt` bound to thread/turn. [X-CONTROL] | Ends the CLI process/job tree; not a reversible pause in that process. [A-STOP] | `turn/interrupt`; separate stop support for background tasks. [M-CONTROL] | `session/cancel`; close also cancels an active prompt. [O-RUN] |
| Do-not-disturb and urgent mail | Shared actor DND gate before delivery. [WAKE] | Same gate, then native steer if eligible. [WAKE] | Same gate, then hook delivery. [WAKE] | Same gate, then native steer if eligible. [WAKE] | Rechecked at atomic hook claim; urgent bypasses DND, ordinary mail waits. No automatic interruption or polling. [O-MAIL] [O-MAIL-PROOF] |

Interrupting does not undo a tool's external side effects. Neither an RPC response,
hook receipt nor a transcript row proves that those effects were rolled back.
The APIs above are delivery/cancellation contracts.

Queued interrupt (`queued:true`, optionally `restart:true`; user 2026-10-20):
Claude Code uses its held PostToolUse callback and Antigravity its held
PostInvocation callback, after active tools finish. Codex and Muse use attributed
tool/thought/response completion notices; ACP uses completed/failed tool updates,
since its text/thought chunks have no end marker. Those three notices are
asynchronous: a next step may already have started and be cut off early. Parallel
active items must settle first. Natural completion makes the stop a no-op,
but a restart still follows normal placement. No request survives into another
turn. Sources: [boundary tracking](../engine/rs/orgtree-engine/src/runtime/interrupt.rs),
[request/outcome handling](../engine/rs/orgtree-engine/src/runtime/actor/interrupt_control.rs),
[glossary](skills/orgtree-working/runtime/tool-interrupt/SKILL.md).


## Account allowance, token reporting and cost

An **account allowance observation**, **turn token receipt**, **context occupancy**
and **prompt-cache receipt** are separate measurements. `orgtree_usage` normally
reads the engine's cache; an explicit eligible refresh may call a provider
metadata reader. It does not spend a model turn to manufacture a reading.
Provider/window filters, freshness, cooldowns and authority still apply. [U-QUERY]
Manual refresh additionally requires inspection/runtime authority and exactly
one explicit active account; it does not switch the running agent's account.
[U-TOOL]

| Feature | Claude Code / Claude | Codex CLI / OpenAI | Antigravity / Google | Muse Code / Muse | OpenCode / custom provider |
| --- | --- | --- | --- | --- | --- |
| Account allowance source | OAuth usage metadata reader; CLI rate-limit events are additional evidence. [C-USAGE] [X-EVENT] | HTTP usage reader, with bounded app-server rate-limit fallback; live account rate-limit notifications also exist. [X-USAGE] [X-EVENT] | Guarded zero-token usage probe; native and registered-profile observations remain separate. [G-USAGE] | Metadata `usage/read` exposes the CLI's last observed reading. **Not a force-new allowance measurement.** [M-USAGE] [M-META] | No native subscription allowance adapter. OpenRouter key/account reader or server-local admission applies instead. [OR-USAGE] [LOCAL] |
| Windows / buckets | Session and weekly, plus applicable model-family limits; an API key is not a subscription window. [U-WINDOW] [C-USAGE] | Normalized primary/secondary windows and model limits when supplied; durations come from the response. [X-USAGE] | Gemini and third-party model groups have separate five-hour/weekly applicability. [G-USAGE] [U-WINDOW] | Rolling window (normally five hours) and weekly, with model scope when supplied. [M-USAGE] | OpenRouter cap/spend/balance, or server concurrency; no fabricated subscription window. [OR-USAGE] [LOCAL] |
| Refresh cadence / manual floor | Background cadence depends on pressure/activity; manual attempts have a 60-second floor. [U-CADENCE] [U-QUERY] | Same general cadence and 60-second manual floor. [U-CADENCE] [U-QUERY] | Manual floor 300 seconds; probe version/zero-token checks must pass. [U-QUERY] [G-USAGE] | Metadata probes normally every five minutes; a successful probe may return the same old timestamp. [M-USAGE] | OpenRouter uses metadata cadence; local-server capacity is an engine fact, not quota polling. [U-CADENCE] [OR-USAGE] [LOCAL] |
| Stale / absent evidence | Cache age remains explicit; no reading is not zero usage or proof of capacity. [U-QUERY] | Same; stream activity does not freshen a missing quota result. [U-QUERY] [X-USAGE] | Failed/missing profile evidence must not borrow the native account's quota. [G-USAGE] [A-ACCOUNTS] | Durable allowlist restores the original timestamp. After a reported reset passes, old percentage becomes unknown until a new reading. Fresh identity may overlay old quota **without** advancing quota age. [M-USAGE] [M-CACHE] [U-FRESH] | Provider response may omit/reset no window; unknown is preserved. Local concurrency is not “exhausted credits.” [OR-USAGE] [LOCAL] |
| Turn token accounting | Stream/result usage; session cumulative dollar counter is differenced. Last model-call input supplies occupancy. [TOKENS] | Difference of thread cumulative totals (fallback to last request); last prompt input supplies occupancy. [TOKENS] [X-EVENT] | Aggregate DONE-step input/cache/output; thinking token counts join output; last prompt is occupancy. [A-EVENT] [TOKENS] | MSP usage/aggregate events; child usage kept apart from the parent turn. [M-EVENT] [TOKENS] | ACP per-prompt usage/context fields when emitted. Missing native fields are not independently measured. [O-EVENT] [TOKENS] |
| Dollar cost provenance | CLI counter for native route; routed OpenRouter uses its own model prices. [TOKENS] [COST] | Model-price calculation when rates are known, not a settled invoice. [TOKENS] [COST] | Gemini-style estimates where mapped; AGY Claude-family cost remains unknown. [COST] | Price unknown; not shown as a free $0 turn. [TOKENS] [COST] | Custom ACP cost unknown; server-local cost labelled local. [COST] |
| Live token attribution | Generated text may have local estimates; bounded attribution only when the responsible tool/round is unambiguous. Not billed-token proof. [ATTRIBUTION] | Same distinction; native usage is authoritative for accounting. [ATTRIBUTION] [TOKENS] | Same; a thinking-token count is not recovered thinking text. [ATTRIBUTION] [A-THOUGHT] | Same; child aggregate is separate. [ATTRIBUTION] [TOKENS] | Same; do not invent unsupported provider counters. [ATTRIBUTION] [O-EVENT] |

API-key rows have separate local spend accounting; that is not native subscription
allowance. OpenRouter keys may share one account balance, so summing displayed
balances across keys would double-count it. [OR-USAGE]

## Prompt caching and compaction

The forecast describes compatibility with a past receipt. “Warm process,”
“compatible prefix” and “provider cache hit” are three different claims.
An internal TTL number is not a verified provider eviction promise. [FORECAST]

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Cache expiry knowledge | Engine guidance: subscription roughly one hour / API key five minutes, refined by reported cache-creation class. An estimate/receipt, never guaranteed retention. [CACHE-GUIDE] [C-RECEIPT] [TOKENS] | Native OpenAI **30-minute engine estimate**; the integration does not measure actual eviction. Do not transfer it to custom providers. [CACHE-GUIDE] [TOKENS] | Engine uses **300 seconds** in turn receipts; verified provider retention/eviction contract **unknown**. [TOKENS] [FORECAST] | Cache reads can be reported; expiry **unknown**, null TTL/countdown even after a positive receipt. [TOKENS] [FORECAST] [COST] | Verified custom-provider TTL **unknown**; forecast explicitly unsupported. [FORECAST] |
| What breaks compatibility | Account/auth, model, session and identity/tool/folder/startup changes are fingerprint inputs; dynamic envelopes need not rewrite the stable prefix. [FINGERPRINT] | Same; app-server replacement alone can still resume the same thread. [FINGERPRINT] [X-RUN] | Same; selected profile/native notes/identity rules matter. [FINGERPRINT] [STARTUP] | Same; model/effort next-turn semantics do not establish a cache hit. [FINGERPRINT] [EFFORT] | Same fingerprint concept, but no positive expiry contract. [FINGERPRINT] [FORECAST] |
| Receipt / keepalive meaning | Positive cache-use evidence is required; keepalive receipts can refresh the observed time/class. Still no promise for the next request. [C-RECEIPT] [FORECAST] | Positive cached tokens can establish a past entry, not future reuse. [TOKENS] [FORECAST] | Same, with the adapter's 300-second assumption disclosed. [TOKENS] [FORECAST] | Past read can be known while expiry remains unknown. [FORECAST] | Even a cache count does not make ACP expiry known. [FORECAST] |
| Normal compaction offered by Orgtree | **Yes:** native `/compact`; also Claude-driven OpenRouter/server routes. [COMPACT] [COMPACT-DOC] | **No:** unsupported admission in Orgtree, regardless of upstream possibilities. [COMPACT] | **No:** unsupported admission in Orgtree. [COMPACT] | **Yes:** `session/compact`; admission response alone is not successful compaction, completion evidence is required. [COMPACT] [M-COMPACT] [M-COMPACT-EVENT] | **No:** unsupported admission in Orgtree. [COMPACT] |
| Automatic native compaction | Launch percent override and native compact-boundary handling. [C-AUTOCOMPACT] [COMPACT-DOC] | Configured token limit from known window × compact fraction; compact events are recognized. [X-AUTOCOMPACT] [X-EVENT] | Threshold/control and normalized compact event **unknown** in this adapter. [COMPACT-DOC] [A-EVENT] | Native automatic threshold **unknown** here; manual compact has explicit lifecycle. [COMPACT-DOC] [M-COMPACT] | No configured threshold/RPC; upstream automatic policy **unknown**. [O-RUN] [COMPACT-DOC] |
| Cheap compaction / fresh handoff | Shared engine operation: preserve history, seed a fresh session with a bounded handoff. Automatic cold reset additionally needs known-cold forecast and measured occupancy. [CHEAP] | Same engine operation; distinct from unsupported normal compact. [CHEAP] [COMPACT] | Same engine operation, not native compaction. [CHEAP] | Same operation; unknown cache expiry must not itself trigger automatic cold reset. [CHEAP] [FORECAST] | Same operation; unsupported cache forecast must not trigger automatic cold reset. [CHEAP] [FORECAST] |

**Route caveat:** at this commit the Claude/Codex OpenRouter paths can still produce
driver-derived TTL receipts and forecast numbers. That is an implementation
fact, **not verified OpenRouter/backend expiry**. The forecast explicitly returns
unknown for language model servers and ACP. Keep these facts separate rather
than documenting a desirable “all custom routes unknown” policy as if already
implemented. [TOKENS] [FORECAST]

## Accounts, continuity and switching

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Multiple native accounts | Managed/imported profile roots and API-key rows; selected config per account. [ACCOUNTS] [ADD-ACCOUNT] | Managed/imported Codex homes and API-key rows; selected home per account. [ACCOUNTS] [ADD-ACCOUNT] | **Not verified as independent concurrent Windows sign-ins.** Profile-aware launch/quota guards exist, but measured CLI 1.3.5 uses one Windows keyring identity despite different homes. Fail closed on non-isolation. [A-ACCOUNTS] [A-AUTH] | Managed independent config/data roots and API-key rows; importing a pre-existing Muse folder is deliberately refused. [ADD-ACCOUNT] [M-META] | Multiple custom keys/servers, not multiple native OpenCode subscription logins in this integration. [REG] [OR-ROUTE] [LOCAL] |
| Account fallback | Engine same-provider candidates, org allowlist and auth/quota eligibility; fallback is a policy, not an automatic promise to switch. [FALLBACK] [ORG-ACCOUNTS] | Same policy, with selected account/home carried into launch. [FALLBACK] [ACCOUNTS] | Same candidate machinery must also satisfy profile isolation and profile-specific quota. [FALLBACK] [A-AUTH] [A-ACCOUNTS] | Same machinery plus selected login's model availability. [FALLBACK] [M-META] | OpenRouter key routing or fixed server route; not native subscription fallback. [OR-ROUTE] [LOCAL] |
| Model change without process restart | Orgtree's saved configuration changes take effect at a turn boundary and can replace the process. No universal in-place model-switch promise. [RECONFIGURE] | Boundary replacement/resume; reported provider reroute is separate. [RECONFIGURE] [X-EVENT] | Model is a launch argument; boundary replacement. [A-RUN] [RECONFIGURE] | Protocol has session model setup, but Orgtree still reconciles configuration at boundaries. Effort is the explicit same-host exception. [M-RUN] [RECONFIGURE] [EFFORT] | `session/set_config_option(model)` during setup; saved reconfiguration is reconciled at a boundary, not a live switch guarantee. [O-RUN] [RECONFIGURE] |
| Native resume / failure | Session resume plus session-file preparation where necessary. [C-RESUME] | Thread resume; failure can fall back to a new thread. Selected-home rollout preparation is separate. [X-RUN] [X-RESUME] | Conversation ID supplied to the print CLI; this is not proof of cross-account session portability. [A-RUN] | Session resume with required settings; failure may open a fresh session. [M-RUN] | `session/load` failure is **explicit**; no silent fresh-session substitution. [O-RUN] |
| Scope of continuity | Shared durable Orgtree conversation/mail survives; a fresh native session does not receive the whole previous native prompt. [CHEAP] [RECONFIGURE] | Same; retaining a session ID is not proof of equal provider cache state. [CHEAP] [FORECAST] | Same; hook mail uses receipt/dedupe rules across relaunches. [CHEAP] [A-STEER] | Same; child usage/background events require their own custody. [CHEAP] [BACKGROUND] | Same; cross-harness route changes require fresh handoff, not foreign session reuse. [CHEAP] [OR-ROUTE] |

The Antigravity observation is dated **2026-10-16, CLI 1.3.5 on Windows**.
Synthetic isolated-profile tests prove Orgtree's separation/guard logic; they do
not prove that a newer native CLI has fixed keyring isolation. Re-measure with
explicit authorization before changing that status. [A-ACCOUNTS]

All providers' staffing choices also depend on the org's enabled account lanes
and harness availability. A signed-out but installed harness is a different
state from an absent harness; permission to select a model is not evidence of
successful authentication. [ORG-ACCOUNTS] [REG]

## MCP, tool previews and timing

“Ready” has at least three meanings: a configured connection, a completed
handshake/catalog observation, and an authorized tool call. None proves the
model has already incorporated the tool into its next generated call.

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Orgtree tool delivery | Control-channel MCP connection plus scoped external MCP configuration. [C-MCP] | Native dynamic tools for Orgtree; external MCP configured separately. [X-RUN] [X-MCP] | Private bridge/config in owned workspace; AGY-specific flattened mail schema. [A-MCP] | Required session MCP configuration via MSP; bridge/external servers supplied to session setup. [M-RUN] | Bridge and converted MCP config through private OpenCode launch config; split mail schema. [O-RUN] |
| First-turn readiness evidence | Polls `mcp_status` until no server is pending or the 30-second deadline passes. Failed servers are not kept pending: the resulting “ready” state does **not** prove all tools connected successfully. [C-MCP] | Dynamic definitions are supplied at thread setup; no equivalent universal external-MCP “all ready” barrier established here. [X-RUN] [X-MCP] | Configured bridge; no explicit all-tools-ready acknowledgment established. [A-MCP] | MCP capability/config acceptance required; that is not a proof that every external tool is callable. [M-RUN] | Observe bridge handshake for up to 5 seconds plus 250 ms settle; explicitly **not** model catalog acknowledgment. Unobserved is reported and tools may appear late. [O-RUN] |
| Streaming tool-call writing | **Yes:** content-block start, partial argument JSON deltas and stop. [C-STREAM] [WRITING] | No Claude-style argument-writing channel normalized in this adapter; unknown writing interval. [X-TOOLS] | Tool step/parameter updates, not a separate argument-generation interval. [A-EVENT] | Item starts/completions/full arguments, not a separate writing interval. [M-TOOLS] | Merged ACP tool updates, not a separate argument-writing interval. [O-EVENT] |
| Tool writing duration | Observed boundary interval; bounded 64 KiB live preview. Not CPU time or provider-internal generation time. [WRITING] | Unknown, **not zero**. [X-TOOLS] | Unknown, **not zero**. [A-EVENT] | Unknown, **not zero**. [M-TOOLS] | Unknown, **not zero**. [O-EVENT] |
| Tool execution / result timing | Observed start/stop and tool result lifecycle. [C-STREAM] | Item start/completion and dynamic/MCP response; full argument/result previews. [X-TOOLS] | First observed step and DONE/ERROR settlement. [A-EVENT] | Typed item/tool lifecycle. [M-TOOLS] | Tool-call/update state merged until completion. [O-EVENT] |
| Tool-output fidelity | Partial argument preview and settled result are distinct; no promise of every native shell stdout byte. [C-STREAM] | Start/end/result events are not a guaranteed continuous shell-output log. [X-TOOLS] | Step content may arrive in repeated cumulative updates. [A-EVENT] | Typed item updates are available; no universal per-tool streaming contract. [M-TOOLS] | Fidelity depends on ACP updates supplied by the CLI/provider. [O-EVENT] |
| Live shell-output tail | No native output-delta mapping into the live tail found here; settled output remains available. [C-STREAM] [SHELL] | `item/commandExecution/outputDelta` feeds the bounded live tail for the current turn. [SHELL] [X-EVENT] | No live-tail mapping found here; DONE/ERROR step output remains available. [A-EVENT] [SHELL] | Output/visibleOutput deltas and in-progress snapshots feed the tail. [SHELL] [M-TOOLS] | In-progress tool content snapshots feed the tail; input/status alone do not. [O-EVENT] |
| Native human MCP elicitation | Form/URL parity with the Codex bridge **unknown/not wired by this adapter**. [C-RUN] [ELICIT] | Explicit `mcpServer/elicitation/request` bridge: human-only form/URL requests, independently correlated, ephemeral and timed out. [X-ELICIT] [ELICIT] | Same form/URL integration **unknown**; capability hooks are a different mechanism. [A-MCP] [ELICIT] | Same form/URL integration **unknown**; MSP approval callbacks are a different mechanism. [M-RUN] [ELICIT] | Same form/URL integration **unknown**; ACP permission callbacks are a different mechanism. [O-PERM] [ELICIT] |

Live shell tails are ephemeral, separate from saved tool-result previews:
32 KiB per tool, 256 KiB per actor, coalesced at 250 ms. They disappear at
settlement/turn cleanup and are not a complete terminal recording. [SHELL]

## Text, thinking, attachments and child work

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Text and thinking | Text/thinking deltas, completed blocks and redacted-thinking handling. [C-STREAM] | Text/reasoning/summary deltas and completed items. [X-EVENT] | Text streams; thinking is recovered **after a matching step is DONE**, from explicit stream text if present or read-only native history. [A-THOUGHT] | Text/reasoning deltas and completed typed items. [M-EVENT] | Agent text/thought chunks if emitted. [O-EVENT] |
| Thinking limitations | Only exposed text; sealed/redacted material is not reconstructed. [C-STREAM] | Only supplied reasoning/summary; no claim to all internal reasoning. [X-EVENT] | Session + step match, dedupe, thinking before response; safe skip on unavailable/malformed DB, journal/WAL, redacted payload or identity mismatch. Not live thoughts and never log the recovered text. [A-THOUGHT] [A-HISTORY] | Only published reasoning events; unavailable content stays unknown. [M-EVENT] | Provider-dependent; absence of a thought chunk does not mean the model did not reason. [O-EVENT] |
| Inline image input | Supported image blocks with MIME/size checks. [IMAGES] | Native local-image content blocks. [IMAGES] | Actor sends text only; attached paths remain in the envelope. No native inline-image translation here. [SEND] | MSP image content with MIME/bytes. [SEND] [M-IMAGES] | Actor sends text only; no inline-image translation here. [SEND] |
| Other attachments | Paths/envelope plus allowed file tools; no universal native PDF/audio/video conversion contract. [SEND] [IMAGES] | Same; block transport does not prove selected model vision support. [SEND] [IMAGES] | Native tool access may read allowed files; not equivalent to inline multimodal input. [SEND] | Same distinction between attachment transport and model capability. [SEND] [M-IMAGES] | Same; server/model multimodal capability is **unknown** unless separately measured. [SEND] [LOCAL] |
| Background result custody | Held background-result handling; unsolicited autonomous continuation is not a second free engine turn. [BACKGROUND] | Native subagents can be scope-gated; parity with Claude/Muse held background-result protocol is **unknown/not established**. [X-PERM] [BACKGROUND] | Native subagent tools are capability-gated; parity with held background-result protocol is **unknown**. [A-PERM] [BACKGROUND] | Explicit background task stop/continue controls and held results; unauthorized child launch can be stopped. [M-CONTROL] [M-TOOLS] [BACKGROUND] | Native background/subagent reporting parity **unknown**; ACP prompt state is the observed contract. [O-RUN] [O-EVENT] |

AGY history recovery uses the selected launch home and exact conversation/step
identity. It opens SQLite read-only/immutable, avoids unsafe live journal states,
bounds payload size and emits at most the allowed display text. A missing thought
row is therefore not proof that the model produced none. The reader intentionally
does not expose raw reasoning/signature fields. [A-HISTORY]

## Instructions, skills and startup context

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Native standing instructions | CLAUDE/local/rules/imports, installed AGENTS fallback and bounded auto-memory prefix. [STARTUP] | AGENTS/AGENTS.override project chain and selected Codex home. [STARTUP] | Native personal/project notes; generated numbered identity rules stay separate. [STARTUP] [A-RULES] | Selected config and workspace native rules; foreign global material supplied separately. [STARTUP] [GLOBALS] | Private generated identity/system text; no native startup-note manifest claimed by `Inputs::None`. [STARTUP] [O-LAUNCH] |
| Cross-harness personal globals | Shared read-only snapshot excludes files already loaded natively by canonical identity. [GLOBALS] | Same, inserted with developer instructions. [GLOBALS] [X-RUN] | Same; own native rule files remain native. [GLOBALS] [A-RULES] | Same; selected profile roots control native exclusion. [GLOBALS] | Shared global text supplied in private launch context. [GLOBALS] [O-LAUNCH] |
| Shared skills delivery | Native shared skill root via added directory. [SKILLS] | Native `skills/extraRoots/set` before thread setup. [X-RUN] [SKILLS] | Owned workspace skill entries; preserve user files. [SKILLS] | Owned workspace skill entries; preserve user files. [SKILLS] | Explicit native skill paths and allow rules in generated config. [O-LAUNCH] [SKILLS] |
| Changes while parked / active | Fingerprint/startup changes take effect at a permitted boundary with resumed session; not a live prompt rewrite. [STARTUP] [RECONFIGURE] | Same. [STARTUP] [RECONFIGURE] | Same; generated identity excluded from recursive startup hashing. [STARTUP] [A-RULES] | Same boundary snapshot; next-turn effort is separate. [STARTUP] [EFFORT] | Relaunch/config boundary; upstream live reload outside that contract **unknown**. [STARTUP] [O-LAUNCH] |
| Native loading ceilings | Engine tracks first 25 KiB / 200 auto-memory lines and five import hops; not all lazily read memory topics. [STARTUP] | Project override replaces AGENTS in its directory; proprietary total prompt ceiling not established here. [STARTUP] | Dated native rule investigation: expanded file cap about 24,000 bytes and aggregate 20k-token rule budget. Numbered parts avoid per-file truncation, **not** total budget. [A-RULES-DOC] | Exact native truncation ceiling **unknown** here. [STARTUP] [GLOBALS] | Exact backend/native instruction ceiling **unknown** here. [O-LAUNCH] |

Skill discovery, startup prefix inclusion and lazy skill use are different events.
The shared registry avoids native duplicates and keeps external/user files;
shipping a skill does not prove that a model read or followed it. [SKILLS]

## Permissions, Windows placement, shutdown and failures

| Feature | Claude Code | Codex CLI | Antigravity | Muse Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Permission / filesystem boundary | CLI modes, allow/deny tool scope and approval controls; no separate OS sandbox guarantee inferred. [C-RUN] | Read-only/workspace-write/danger modes plus approvals; Windows hosted/fallback posture differs. [X-PERM] | CLI skip-permission launch plus Orgtree capability-denial hooks; read-only shell is closed. Hooks are **not** an OS filesystem sandbox. [A-RUN] [A-PERM] | MSP approvals and current writable roots; native sandbox availability is conditional. [M-PERM] [M-CONTROL] | ACP path/permission callbacks and scoped config; shell permission is not an OS sandbox. Code Mode execution is denied outside the unrestricted posture. [O-PERM] |
| Windows Session 0 | Shared session host can place CLI in selected signed-in session; falls back to engine/Session 0. No desktop in Session 0. [HOST] | **Bypass seats too** may be hosted. Without helper, fallback is unsandboxed; read-only closes command escape with restrictive approval. [HOST] [X-PERM] | Same shared placement; no extra AGY Session 0 sandbox promise. [HOST] [A-PERM] | Shared placement; dated 1.4.6 Session 0 sandbox pipe failure means writable seats use unsandboxed operation. Callbacks alone do not contain all writes. [HOST] [M-PERM] | Same shared placement; ACP callbacks do not create a Windows sandbox. [HOST] [O-PERM] |
| Graceful process close | Close stdin, wait about 5 seconds, force on timeout. Explicit kill is a different path. [C-STOP] | Shared graceful helper, 3-second kill / 5-second close grace; forced-stop handling retained. [X-STOP] | EOF plus about 5-second close wait; interrupt itself terminates job/process tree. [A-STOP] | Shared graceful helper, 3/5-second kill/close grace. [M-STOP] | Cancel active prompt, close connection/stdin, shared 5-second graceful wait. [O-RUN] [O-STOP] |
| Forced-stop evidence | Do not infer the same durable stop record merely from a warning log; adapter close path differs. [C-STOP] | Shared process-stop lifecycle records forced escalation. [X-STOP] [HOST-STOP] | Native interrupt/termination path differs from graceful-close accounting. [A-STOP] | Shared process-stop lifecycle records forced escalation. [M-STOP] [HOST-STOP] | Shared graceful helper handles escalation; cancellation completion is distinct from tool rollback. [O-STOP] [HOST-STOP] |
| Auth / transport failure | Shared recovery classification from native errors; not every failure is quota exhaustion. [RECOVERY] | Native error events, including retryable errors, feed shared recovery. [X-EVENT] [RECOVERY] | Pre-admission Unavailable/Timeout can retry/hold; SignedOut/NotIsolated refuse. No real turn is fabricated for a failed check. [A-AUTH] [A-ADMISSION] | Typed MSP auth/retryable errors augment shared recovery. [M-EVENT] [RECOVERY] | ACP transport/load/prompt errors explicit; no silent session replacement. [O-RUN] [RECOVERY] |
| Refusal / content-filter parity | Model/provider-specific; a universal content-filter classification is **unknown**, separate from permission denial. [RECOVERY] | Same limit; retryability/turn completion must be read from events. [RECOVERY] [X-EVENT] | Same; do not treat all ERROR steps as auth/quota. [RECOVERY] [A-EVENT] | Typed errors improve classification, not a universal safety-refusal taxonomy. [RECOVERY] [M-EVENT] | Backend-specific; normalized refusal taxonomy **unknown**. [O-EVENT] [RECOVERY] |

Session placement is chosen at launch/turn boundaries, never a magical migration
of an active CLI. Signing out terminates hosted children with their helper.
Filesystem grants and a selected desktop session do not establish a working OS
sandbox. [HOST]

## Route overlays: apply these after the harness column

| Concern | OpenRouter | Language model server (including llama.cpp) |
| --- | --- | --- |
| Harness choice | Explicit seat pin wins; otherwise selected key's harness. Missing pinned harness refuses instead of silently substituting another. [OR-ROUTE] | Server record fixes the harness/protocol; model choices belong to that server. [LOCAL] |
| Credentials / accounts | Multiple key rows, org allowlist and per-key harness; CLI brand does not identify the billing provider. [OR-ROUTE] [ORG-ACCOUNTS] | Server endpoint/auth and per-org lane; no native subscription identity assumed. [LOCAL] [ORG-ACCOUNTS] |
| Usage and admission | Key cap/spend plus potentially shared account credit; unknown reset is not an invented date. [OR-USAGE] | Engine/server concurrency admission and configured context; hardware load/overflow is not allowance exhaustion. [LOCAL] |
| Steering, tools, images | Inherit the selected driver's implemented transport. Backend acceptance/capability can still differ. [REG] [SEND] [WAKE] | Same; Responses-compatible does not prove every Codex tool/model feature. [LOCAL] [SEND] |
| Fast mode / live effort | Native provider fast-mode mapping does not apply; live effort actor path is native Claude-only. Backend support **unknown** unless separately integrated. [FAST] [EFFORT] | Same; generic server reasoning negotiation **unknown**. [FAST] [EFFORT] [LOCAL] |
| Cache | Backend-dependent expiry **unknown**; Claude/Codex driver-derived forecast values may still appear. [TOKENS] [FORECAST] | Server KV retention **unknown**; forecast explicitly suppresses an expiry claim. [FORECAST] |
| Compaction | Normal only with Claude Code; all-driver engine fresh handoff remains separate. [COMPACT] [CHEAP] | Same; known context size can configure driver thresholds, not prove server summary retention. [COMPACT] [X-AUTOCOMPACT] [LOCAL] |
| Cross-harness change | Fresh context/handoff; a Codex thread cannot become an ACP or Claude session. [OR-ROUTE] [RECONFIGURE] | Changing server/harness is route reconfiguration, not foreign-session resume. [LOCAL] [RECONFIGURE] |

## Per-harness operational notes

- **Claude Code:** strongest exposed tool-argument writing telemetry and explicit
  MCP readiness polling. Mid-turn mail is hook-bound; live effort and live mail
  are different controls. Native compact is supported. Imported/account-specific
  startup notes and later prefix changes need boundary reconciliation. [C-MCP]
  [C-STREAM] [EFFORT] [WAKE] [STARTUP]
- **Codex CLI:** exact-turn steer/interrupt and dynamic tool definitions; model
  events, reasoning and token totals are separate. Native normal compact is not
  offered by Orgtree. Effort change may restart the local app-server without
  deliberately discarding the thread. All-seat Windows hosting supersedes the
  older “bypass stays in Session 0” rule. [X-RUN] [EFFORT] [COMPACT] [HOST]
- **Antigravity:** hooks supply mid-task mail and enforce capabilities; stop is
  process-tree interruption. Thinking comes after DONE and can legitimately be
  unavailable. Profile/quota separation logic must not be confused with a proven
  independent keyring login. [A-STEER] [A-PERM] [A-STOP] [A-THOUGHT] [A-ACCOUNTS]
- **Muse Code:** exact-turn steering, typed events, background custody and native
  compact are integrated. A metadata read can return yesterday's usage; a
  repaired email label does not freshen quota. Cache price/expiry remain unknown.
  Session 0 writable operation has a documented sandbox limitation. [M-CONTROL]
  [M-COMPACT] [M-USAGE] [FORECAST] [M-PERM]
- **OpenCode:** custom providers over ACP; owned plugin mail at tool boundaries
  on 2.0.28 with next-turn fallback otherwise [O-MAIL]. No live effort control,
  explicit session-load failure, and bounded bridge observation rather than a
  model-ready acknowledgment. Treat effort, native background parity and
  provider-cache expiry as unknown. [REG] [O-RUN] [O-LAUNCH] [FORECAST]

## Unknowns, evidence limits and maintenance

This is an exhaustive inventory of differences found in the audited integration,
not a claim that no additional upstream feature exists. Add a sourced row whenever
a new difference is found. In particular:

1. Actual provider cache eviction, cache-hit probability and custom-route TTLs
   remain unverified; engine guidance must not be promoted into vendor promises.
   The OpenRouter driver-derived TTL discrepancy is a documentation finding,
   not changed by this docs-only landing. [CACHE-GUIDE] [FORECAST]
2. A newer AGY CLI's independent Windows login isolation needs a fresh authorized
   measurement. Native history format/readability and instruction ceilings are
   version-sensitive too. Synthetic tests are not that measurement. [A-ACCOUNTS]
   [A-HISTORY] [A-RULES-DOC]
3. No generic proof exists that external MCP tools are visible to the model at
   the instant a configuration/handshake completes. Preserve readiness states
   instead of flattening them to a universal yes/no. [C-MCP] [O-RUN] [M-RUN]
4. Exact multimodal acceptance, content-filter behavior, effort obedience and
   native background/subagent semantics depend on the selected model and CLI.
   Missing adapter events are an integration gap or unknown, not proof of a
   model's incapability. [SEND] [RECOVERY] [BACKGROUND]
5. Re-audit after protocol/CLI changes. Record date, exact version, route,
   account type, session placement and whether evidence is static source,
   synthetic fixture or authorized native measurement. Never put credentials
   or recovered thinking into diagnostics while collecting it.

## Source index

All code paths below are relative to `engine/rs/orgtree-engine/src/` unless they
begin with `docs/`. The numbered ranges identify the audited implementation,
including boundaries where a feature is deliberately absent. A source citation
does not mean the associated native operation was executed during this audit.

| Key | Audited source locations | What it establishes |
| --- | --- | --- |
| [REG] | `harnesses.rs:32-180` | Five-harness roster, providers, installation and cached versions |
| [C-RUN] | `runtime/claude.rs:120-250` | CLI launch, permissions, persistent stream transport |
| [X-RUN] | `runtime/codex.rs:330-384` | Initialize, native skills, dynamic tools, thread start/resume |
| [A-RUN] | `runtime/agy.rs:103-161` | Stream-JSON launch, model/effort/conversation and profile environment |
| [M-RUN] | `runtime/muse.rs:550-638` | Required MSP capabilities, session MCP, resume/new and model setup |
| [O-MAIL] | `runtime/opencode_mail.rs:1`, `runtime/opencode_mail_plugin.mjs:1`, `runtime/opencode.rs:55` at `181cb49` | Owned hook, exact-version gate, durable custody, DND/urgent filtering and bounded recovery |
| [O-MAIL-PROOF] | `tools/rig/proofs/opencode-mail.mjs:1` at `e8f7ff4`; `docs/rust-engine/opencode-mail.md` | Dated offline 2.0.28 lifecycle proof and limitations |
| [O-RUN] | `runtime/opencode.rs:42-155` | ACP setup, load/new/model, bridge observation, prompt/cancel |
| [LOCAL] | `langserver.rs:102-106,201-213,305-326,393-454,995-1133` | Server protocols, installed harness, fixed route and model configuration |
| [CAT] | `providers/catalog.rs:20-100,123-219` | Tier/provider metadata and effort mappings |
| [FAST] | `providers/fast_mode.rs:7-64` | Exact native model/service-tier support |
| [C-CONTROL] | `runtime/claude.rs:294-329` | Send user, interrupt, effort, MCP status and fast-mode controls |
| [X-CONTROL] | `runtime/codex.rs:420-454` | Turn start/steer/interrupt |
| [M-CONTROL] | `runtime/muse.rs:708-771` | Turn start/steer/interrupt, roots and background task controls |
| [SEND] | `runtime/actor.rs:4234-4282` | Actual per-driver message/image dispatch and native fast mode |
| [O-DISCOVERY] | `runtime/opencode.rs:321-374` | Discovery and ACP compatibility |
| [A-AUTH] | `providers/agy_auth.rs:1-74,115-145,538-565` | Shared-keyring guard, selected profile, transient-only launch retry |
| [M-META] | `providers/muse_models.rs:1-27,249-272` | Metadata/schema/fingerprint and cached usage contract |
| [O-LAUNCH] | `runtime/opencode.rs:163-282` | Private ACP provider config, instructions, skill paths and text-only model declaration |
| [O-EFFORT] | `runtime/actor.rs:3380-3395` | OpenCode process has no configured reasoning effort |
| [WAKE] | `runtime/actor.rs:1655-1674` | DND gate and native-steer/hook/queued delivery split |
| [STEER] | `runtime/actor.rs:3721-3774` | Exact-turn Codex/Muse delivery and pending-mail recovery |
| [A-STEER] | `runtime/actor.rs:3777-3884` | AGY pending hook file and matching receipt custody |
| [EFFORT] | `runtime/actor.rs:1547-1607` | Claude-only live effort, process replacement, Muse same-host exception |
| [A-STOP] | `runtime/agy.rs:221-257` | Process-tree interrupt and EOF close |
| [U-QUERY] | `usage.rs:432-505` | Cached/manual usage query, rate limits and refresh admission |
| [U-TOOL] | `tools/usage.rs:260-420` | Usage-tool scope, exact-account refresh and cached-query boundary |
| [C-USAGE] | `usage.rs:748-903` | Read-only Claude quota metadata path |
| [X-USAGE] | `usage.rs:904-1117` | OpenAI HTTP reader, app-server fallback and window normalization |
| [G-USAGE] | `usage.rs:1181-1370` | AGY versioned zero-token reader and profile cache selection |
| [M-USAGE] | `usage.rs:1433-1566` | Muse observation age, identity overlay and probe cadence |
| [OR-USAGE] | `usage.rs:1582-1800` | OpenRouter cap/balance and API-key local spending |
| [U-WINDOW] | `usage.rs:230-348` | Model-group applicability and positive allowance rules |
| [U-CADENCE] | `usage.rs:1884-2057` | Pressure/idle cadence, reset catch-up and cached turn board |
| [M-CACHE] | `usage/muse_cache.rs:36-77` | Durable non-secret quota allowlist and timestamp restoration |
| [U-FRESH] | `usage/query.rs:74-140` | Freshness and reset-passed unknown semantics |
| [TOKENS] | `runtime/actor.rs:7104-7170` | Per-driver final token accounting, occupancy, TTL and costs |
| [COST] | `runtime/actor.rs:7170-7208,7348-7363` | Route pricing, unknown costs and durable TTL/cost provenance |
| [ATTRIBUTION] | `runtime/actor.rs:6415-6478` | Observed/estimated token attribution and ambiguity |
| [CACHE-GUIDE] | `runtime/identity.rs:956-980` | Engine cache guidance and its estimate language |
| [C-RECEIPT] | `runtime/actor.rs:6917-6924` | Claude keepalive receipt class/time |
| [FORECAST] | `runtime/actor.rs:8113-8193` | Prefix compatibility, route exclusions, receipts and TTL forecast |
| [FINGERPRINT] | `runtime/actor.rs:677-735,2109-2225` | Fingerprint fields and stable launch-plan construction |
| [COMPACT] | `domain/compaction.rs:47-68` | Canonical normal-compaction capability/admission |
| [COMPACT-DOC] | `docs/rust-engine/compact-choice.md:1-86` | Normal/cheap compact behavior and proof limits |
| [C-AUTOCOMPACT] | `runtime/actor.rs:2640-2655` | Claude auto-compact launch percentage |
| [X-AUTOCOMPACT] | `runtime/actor.rs:3105-3124` | Codex configured auto-compact token threshold |
| [M-COMPACT] | `runtime/muse.rs:774-779` | MSP compact request admission |
| [M-COMPACT-EVENT] | `runtime/actor.rs:5138-5185` | Muse compact completion/error lifecycle |
| [CHEAP] | `runtime/actor.rs:2482-2600` | Cold reset and bounded fresh-session handoff, history preservation |
| [ACCOUNTS] | `accounts.rs:1-28,114-131,309-359` | Registry, selected config/home and native aliases |
| [ADD-ACCOUNT] | `http/accounts.rs:104-160` | Managed/imported/key rows and Muse root restriction |
| [A-ACCOUNTS] | `docs/rust-engine/antigravity-accounts.md:3-82` | 2026-10-16 native keyring measurement versus synthetic profile/usage proofs |
| [FALLBACK] | `runtime/freeze.rs:282-330` | Same-provider candidates, auth/usage and org eligibility |
| [ORG-ACCOUNTS] | `org_accounts.rs:73-196,370-391` | Canonical enabled account lanes, provider choices and admission |
| [RECONFIGURE] | `runtime/actor.rs:1610-1626,2340-2480,4103-4130` | Boundary reconciliation, process replacement and queued configuration |
| [OR-ROUTE] | `openrouter.rs:830-865` | Per-key harness versus explicit seat pin and missing-harness refusal |
| [C-RESUME] | `runtime/claude.rs:154-160,547-592` | Native session argument and selected-home preparation |
| [X-RESUME] | `runtime/codex.rs:758-827` | Rollout preparation across selected homes |
| [C-MCP] | `runtime/actor.rs:58-59,3887-3925,6187-6224` | Bounded first-prompt readiness gate and initialization state |
| [X-MCP] | `runtime/codex.rs:691-757,840-879` | Dynamic tool descriptors and external MCP configuration |
| [A-MCP] | `runtime/agy.rs:153-213` | Owned bridge/config and launch profile/history snapshot |
| [C-STREAM] | `runtime/actor.rs:6228-6340,6535-6558` | Claude text/thinking/tool argument events and completed thinking |
| [WRITING] | `runtime/toolwriting.rs:23-77` | Bounded partial-JSON preview and observed writing interval |
| [X-TOOLS] | `runtime/actor.rs:5993-6068` | Codex dynamic/MCP tool lifecycle and previews |
| [A-EVENT] | `runtime/actor.rs:5660-5859` | AGY response/tool steps and usage accumulation |
| [M-TOOLS] | `runtime/actor.rs:4950-5137` | Muse typed item/tool/subagent lifecycle |
| [O-EVENT] | `runtime/actor.rs:3401-3500` | ACP text/thought/tool/usage notifications |
| [SHELL] | `runtime/shell_output.rs:1-69` | Codex/Muse live shell mappings, bounded ephemeral tails and coalescing |
| [ELICIT] | `runtime/elicitation.rs:1-80` | Human-only ephemeral MCP form/URL request contract |
| [X-ELICIT] | `runtime/codex.rs:620-640` | Codex native MCP elicitation request dispatch |
| [X-EVENT] | `runtime/actor.rs:4614-4726` | Codex token/rate/model/reasoning/error/compact notifications |
| [M-EVENT] | `runtime/actor.rs:4752-4870,5010-5035` | Muse deltas, usage, typed errors and thinking rows |
| [A-THOUGHT] | `runtime/actor.rs:5685-5736` | DONE-step thinking recovery before response with session/step binding |
| [A-HISTORY] | `runtime/agy_thinking.rs:17-112` | Read-only bounded native history, identity validation and privacy exclusions |
| [IMAGES] | `runtime/actor.rs:8248-8343` | Claude image validation and Codex local-image input |
| [M-IMAGES] | `runtime/muse.rs:1068-1095` | MSP MIME/image content translation |
| [BACKGROUND] | `runtime/actor.rs:5261-5405` | Claude/Muse held background results and autonomous-turn suppression |
| [X-PERM] | `runtime/codex.rs:95-141,190-210` | Sandbox/approval posture, Windows fallback and native capability restrictions |
| [A-PERM] | `runtime/agy.rs:318-415` | Capability-denial hooks and narrowed launch constraints |
| [STARTUP] | `runtime/startup.rs:1-60,82-145` | Native instruction manifests and boundary digest |
| [GLOBALS] | `runtime/global_instructions.rs:67-156,373-458` | Read-only canonical snapshot and native exclusion, selected-profile controls |
| [A-RULES] | `runtime/agy.rs:421-492,536-563` | Owned identity-rule parts and reversible generated-note migration |
| [A-RULES-DOC] | `docs/agy-standing-notes.md:1-134` | Dated AGY 1.3.5 native documentation and rule-size/budget evidence |
| [SKILLS] | `providers/skills.rs:28-77,115-200` | Native deduplication, shared snapshot and owned workspace skill export |
| [M-PERM] | `runtime/muse.rs:82-108` | Measured Windows sandbox limitations and approval posture |
| [O-PERM] | `runtime/acp_scope.rs:1-150` | ACP paths, approvals, shell and Code Mode policy |
| [HOST] | `runtime/session_host.rs:1-44` | All-harness signed-in session placement, bypass inclusion and sign-out |
| [C-STOP] | `runtime/claude.rs:332-359` | Direct kill versus EOF/timeout close |
| [X-STOP] | `runtime/codex.rs:456-495` | Graceful stop helper with bounded grace |
| [M-STOP] | `runtime/muse.rs:782-805` | Graceful stop helper with bounded grace |
| [O-STOP] | `runtime/acp.rs:169-177` | Close stdin/connection before graceful wait |
| [HOST-STOP] | `runtime/session_host.rs:412-461` | Shared graceful helper and durable forced-stop handling |
| [RECOVERY] | `runtime/actor.rs:7252-7315` | Typed Muse error handling and common recovery classification |
| [A-ADMISSION] | `runtime/actor.rs:4076-4091` | AGY preflight before mail claim/inference turn |

[REG]: ../engine/rs/orgtree-engine/src/harnesses.rs#L32
[C-RUN]: ../engine/rs/orgtree-engine/src/runtime/claude.rs#L120
[X-RUN]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L330
[A-RUN]: ../engine/rs/orgtree-engine/src/runtime/agy.rs#L103
[M-RUN]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L550
[O-RUN]: ../engine/rs/orgtree-engine/src/runtime/opencode.rs#L42
[LOCAL]: ../engine/rs/orgtree-engine/src/langserver.rs#L102
[CAT]: ../engine/rs/orgtree-engine/src/providers/catalog.rs#L20
[FAST]: ../engine/rs/orgtree-engine/src/providers/fast_mode.rs#L7
[C-CONTROL]: ../engine/rs/orgtree-engine/src/runtime/claude.rs#L294
[X-CONTROL]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L420
[M-CONTROL]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L708
[SEND]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L4234
[O-DISCOVERY]: ../engine/rs/orgtree-engine/src/runtime/opencode.rs#L321
[A-AUTH]: ../engine/rs/orgtree-engine/src/providers/agy_auth.rs#L1
[M-META]: ../engine/rs/orgtree-engine/src/providers/muse_models.rs#L1
[O-LAUNCH]: ../engine/rs/orgtree-engine/src/runtime/opencode.rs#L163
[O-EFFORT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L3380
[WAKE]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L1655
[STEER]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L3721
[A-STEER]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L3777
[EFFORT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L1547
[A-STOP]: ../engine/rs/orgtree-engine/src/runtime/agy.rs#L221
[U-QUERY]: ../engine/rs/orgtree-engine/src/usage.rs#L432
[U-TOOL]: ../engine/rs/orgtree-engine/src/tools/usage.rs#L260
[C-USAGE]: ../engine/rs/orgtree-engine/src/usage.rs#L748
[X-USAGE]: ../engine/rs/orgtree-engine/src/usage.rs#L904
[G-USAGE]: ../engine/rs/orgtree-engine/src/usage.rs#L1181
[M-USAGE]: ../engine/rs/orgtree-engine/src/usage.rs#L1433
[OR-USAGE]: ../engine/rs/orgtree-engine/src/usage.rs#L1582
[U-WINDOW]: ../engine/rs/orgtree-engine/src/usage.rs#L230
[U-CADENCE]: ../engine/rs/orgtree-engine/src/usage.rs#L1884
[M-CACHE]: ../engine/rs/orgtree-engine/src/usage/muse_cache.rs#L36
[U-FRESH]: ../engine/rs/orgtree-engine/src/usage/query.rs#L74
[TOKENS]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L7104
[COST]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L7170
[ATTRIBUTION]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L6415
[CACHE-GUIDE]: ../engine/rs/orgtree-engine/src/runtime/identity.rs#L956
[C-RECEIPT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L6917
[FORECAST]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L8113
[FINGERPRINT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L677
[COMPACT]: ../engine/rs/orgtree-engine/src/domain/compaction.rs#L47
[COMPACT-DOC]: ../docs/rust-engine/compact-choice.md#L1
[C-AUTOCOMPACT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L2640
[X-AUTOCOMPACT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L3105
[M-COMPACT]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L774
[M-COMPACT-EVENT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L5138
[CHEAP]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L2482
[ACCOUNTS]: ../engine/rs/orgtree-engine/src/accounts.rs#L1
[ADD-ACCOUNT]: ../engine/rs/orgtree-engine/src/http/accounts.rs#L104
[A-ACCOUNTS]: ../docs/rust-engine/antigravity-accounts.md#L3
[FALLBACK]: ../engine/rs/orgtree-engine/src/runtime/freeze.rs#L282
[ORG-ACCOUNTS]: ../engine/rs/orgtree-engine/src/org_accounts.rs#L73
[RECONFIGURE]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L1610
[OR-ROUTE]: ../engine/rs/orgtree-engine/src/openrouter.rs#L830
[C-RESUME]: ../engine/rs/orgtree-engine/src/runtime/claude.rs#L154
[X-RESUME]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L758
[C-MCP]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L58
[X-MCP]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L691
[A-MCP]: ../engine/rs/orgtree-engine/src/runtime/agy.rs#L153
[C-STREAM]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L6228
[WRITING]: ../engine/rs/orgtree-engine/src/runtime/toolwriting.rs#L23
[X-TOOLS]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L5993
[A-EVENT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L5660
[M-TOOLS]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L4950
[O-EVENT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L3401
[SHELL]: ../engine/rs/orgtree-engine/src/runtime/shell_output.rs#L1
[ELICIT]: ../engine/rs/orgtree-engine/src/runtime/elicitation.rs#L1
[X-ELICIT]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L620
[X-EVENT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L4614
[M-EVENT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L4752
[A-THOUGHT]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L5685
[A-HISTORY]: ../engine/rs/orgtree-engine/src/runtime/agy_thinking.rs#L17
[IMAGES]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L8248
[M-IMAGES]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L1068
[BACKGROUND]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L5261
[X-PERM]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L95
[A-PERM]: ../engine/rs/orgtree-engine/src/runtime/agy.rs#L318
[STARTUP]: ../engine/rs/orgtree-engine/src/runtime/startup.rs#L1
[GLOBALS]: ../engine/rs/orgtree-engine/src/runtime/global_instructions.rs#L67
[A-RULES]: ../engine/rs/orgtree-engine/src/runtime/agy.rs#L421
[A-RULES-DOC]: ../docs/agy-standing-notes.md#L1
[SKILLS]: ../engine/rs/orgtree-engine/src/providers/skills.rs#L28
[M-PERM]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L82
[O-PERM]: ../engine/rs/orgtree-engine/src/runtime/acp_scope.rs#L1
[HOST]: ../engine/rs/orgtree-engine/src/runtime/session_host.rs#L1
[C-STOP]: ../engine/rs/orgtree-engine/src/runtime/claude.rs#L332
[X-STOP]: ../engine/rs/orgtree-engine/src/runtime/codex.rs#L456
[M-STOP]: ../engine/rs/orgtree-engine/src/runtime/muse.rs#L782
[O-STOP]: ../engine/rs/orgtree-engine/src/runtime/acp.rs#L169
[HOST-STOP]: ../engine/rs/orgtree-engine/src/runtime/session_host.rs#L412
[RECOVERY]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L7252
[A-ADMISSION]: ../engine/rs/orgtree-engine/src/runtime/actor.rs#L4076

[O-MAIL]: https://github.com/Maurdekye/orgtree/blob/181cb4914c5a2373fafc4ca1defe80c0919fbdfa/engine/rs/orgtree-engine/src/runtime/opencode_mail.rs#L1
[O-MAIL-PROOF]: rust-engine/opencode-mail.md#measured-offline-proof-2026-10-20

[A-ANNOTATIONS-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/convo.rs
[ACTOR-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/actor.rs
[A-THINKING-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/agy_thinking.rs
[A-THINKING-DOC-44]: rust-engine/antigravity-thinking.md
[A-AUTH-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/providers/agy_auth.rs
[RECOVERY-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/recovery.rs
[SIZE-DOC-44]: rust-engine/context-full-recovery.md
[OPENCODE-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/opencode.rs
[OPENCODE-MAIL-44]: https://github.com/Maurdekye/orgtree/blob/2ec8c0e7d15b8810a7d957add335ac69472541c8/engine/rs/orgtree-engine/src/runtime/opencode_mail.rs
