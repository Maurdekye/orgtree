# Transcript tokens and live context occupancy (4.4.0)

Tool rows show text-output token estimates beside their writing and execution
times. Token counts use a capital serif **T**, including live estimates and
finished-thought counts (user 2026-10-18). The glyph is decorative; full token
labels remain available to assistive technology. Finished thoughts show a provider count
only where one completed thought unambiguously owns that response's receipt.
Historical rows without observations acquire no invented count.

Compact counts use `t` below 1,000 and `kt` at or above it, with the existing
one-decimal k rounding. Hover shows the complete figure with a label and comma
grouping, such as `tool output: ~4,321t` or `thinking: 4,321t`. The existing `~`
qualifier continues to identify estimates, including their exact-number hover.

Writing and execution hover labels show recorded milliseconds with three
decimals (`writing time: 4.330ms`, `execution time: 0.432ms`). Recorded writing
seconds retain their supplied precision; timestamp durations preserve fractional
parts without adding tiny fractions to epoch-sized numbers. Coarse stamps
without millisecond precision say that precision is unavailable. Live hovers
sample elapsed time on hover/focus and keep the normal whole-second clock cadence.

## Estimates and receipts

The single generic encoding is OpenAI's MIT-licensed `o200k_base`, pinned with
its URL, SHA256 and licence in `runtime/tokenizer/README.md`. The immutable
encoding is gzip-compressed and loaded lazily on its first use. Decode and
counting run on Tokio's blocking pool. Rendering receives numbers only.

Every current tool count retains `~`, including at completion: no current
harness/model has a proven exact public encoding. An attributed real result
receipt can use the plain-number representation; current adapter contracts
expose no such dedicated per-result receipt. Input-token deltas, request spend,
Agent/Task child totals and numbers in tool text are never treated as one.

One process-local correction per harness starts at 1.0 and learns from real,
complete response text/count pairs. Tiny, implausible, sampled, clipped,
hidden-reasoning, child, mixed-modality or ambiguous scopes do not train it.
Calibration is a bounded moving average of reported/BPE ratios, shared without
a global mutex. It changes estimates, never provider-reported context usage.

Output is observed before transcript preview clipping. Up to 64 KiB is counted
whole; larger outputs use bounded UTF-8 head/tail samples and scale that BPE
estimate to observed bytes. The tooltip states when output is sampled. Images
are excluded; results without observed text have no text-output count.
Only 64 simultaneous output samples are retained per actor, each at most64KiB.

The approved aggregate benchmark used visible assistant text as a proxy,
excluding thoughts and calls. Held-out calibrated weighted absolute error was
2.95% on Claude (373 outputs/107,614 reported tokens) and 1.69% on Codex
(55/3,101). This does not establish tool-result error, sampled-output error or
exact model encoding. No private transcript text or identifiers are vendored.

## Harness boundaries

| Harness | Tool output | Thinking receipt |
| --- | --- | --- |
| Claude Code | Complete root `tool_result` text; child events stay private | Group response fragments by `message.id`; finalize at a later response/result boundary. Use optional `usage.output_tokens_details.thinking_tokens` only with one thought block |
| Codex | Command output deltas and complete command/dynamic/MCP/result text; omit synthesized file-change/status labels and query-as-output fallbacks | `last.reasoningOutputTokens`, only with one completed reasoning item since the preceding receipt and the matching turn |
| Antigravity | Actual completed tool result/output/response text | Recovered thought rows exist; no thinking-count attribution is implemented in this adapter yet, so omit |
| Muse | Visible tool-output deltas/snapshots and complete visible results | Completion `usage.reasoningTokens`, only with one completed reasoning item in that scope |
| OpenCode ACP | Original tool-content snapshots before preview clipping | No attributed field in the captured protocol, so omit |

Live counts coalesce to approximately one frame per second per actor. Their
node-stream frame updates the shared conversation's token overlay without
retiring prose/thought partials, fetching `/chat`, or invalidating the tree.
Terminal estimates live on ordinary durable chips. HTTP supplies live overlays
for a desk opened mid-call; older HTTP snapshots cannot replace newer counts.

## Live occupancy

Occupancy always uses the latest reported input/context snapshot, never an
output estimate or cumulative spend:

| Harness | Reported source |
| --- | --- |
| Claude Code | uncached input + cache read + cache creation, counted once |
| Codex | `tokenUsage.last.inputTokens`, without adding cached input again |
| Antigravity | latest response input + cache read |
| Muse | direct context snapshot when present, otherwise last counted-once prompt |
| OpenCode ACP | `usage_update.used` and `size` |

The actor coalesces to the latest pending reading with at most one publication
per second. Only that agent's runtime overlay changes; no per-event database
write or tree query occurs. Existing turn-end persistence remains authoritative.
Both HTTP and the desk header use the live reading; the header does not let a
stale chat snapshot hide newer runtime occupancy. Missing/invalid values retain
the last known observation, and explicit reported zero stays distinguishable
from unknown. The engine's compaction/next-turn query shares the source helper.
Muse and Antigravity initialize cumulative spend separately from occupancy:
`last_prompt` stays absent until a validated prompt receipt arrives. A missing
or invalid first receipt therefore cannot manufacture a measured zero.

For Claude results, an explicitly observed empty string or text block supports
an estimated zero. Missing/null content, malformed text blocks and results
containing only non-text blocks provide no textual observation and no count.

## Verification

The first five renderer specifications measured four expected semantic failures
and one passing missing/invalid-history control before implementation. Further
focused tests cover runtime agent isolation, stale chat precedence, live count
frames without extra reads/partial retirement, Unicode/chunk boundaries, public
BPE control counts, receipt ambiguity and coalescing. Final engine/renderer and
synthetic smoke results are recorded on the docket; do not infer a pass from
this source document alone.

The actual-adapter regression proofs `token-result-observations` and
`context-receipt-observations` cover absent/malformed versus explicitly empty
Claude text, missing/invalid versus reported-zero Muse/Antigravity prompts,
retention of previous occupancy, and cumulative spend controls.
