# Transcript tokens and live context occupancy (4.4.0)

Tool rows show text-output token estimates beside their writing and execution
times. Token counts use an **I-beam text cursor**, including live estimates and
finished-thought counts (user 2026-10-18 09:10Z, replacing the earlier serif T).
The glyph is decorative; full token
labels remain available to assistive technology. Finished thoughts show a provider count
only where one completed thought unambiguously owns that response's receipt.
Historical rows without observations acquire no invented count.

The writing pencil, execution arrow and token cursor use the same MUI icon
box and inline separator/icon/number spacing. The token slot adds no flex gap.

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

### File reads (4.4.5, 2026-10-24)

Read rows count the returned text slice rather than a short read summary. They
use the same calibrated public BPE and `~` qualifier as other tool outputs;
these are estimates of content tokens, not exact model receipts or billed usage.
The file's total size and the tool's input arguments are not counted.

Claude Code's native text-read result supplies `file.content`. It belongs only
to the single matching root result in that envelope; parallel results and errors
cannot borrow it. Antigravity uses the exact completed tool step from the
process's bound conversation and selected history home. The existing indexed,
read-only snapshot, zero lock wait and 2 MiB step limit also apply to this
read. Raw file paths are never reopened.

Antigravity stores a read as a generic tool step, as it does every native tool
(USER 2026-10-27 m30b9178ed978; shape measured the same day on ten real
histories, 2,291 tool steps): the payload's field 1 is 132, the call is
field 5 -> 4 with the tool name in its field 2, and the text the model was
given is field 140 -> 2 -> 1, each field once and UTF-8. `read_file` and
`view_file` both use it; `CortexStep.view_file` (field 14) never occurs, which
is why file-read rows had no count before 4.5.0 (the reader looked there). The
step's own tool name must be a file read, so a stale index never lends another
tool's text to a read row; a step with no field 140 -> 2 -> 1 (an error, a
media-only result) has no read-content count.

The same step also counts any other Antigravity tool whose stream carried no
output text (`result`, `output` or `response`): `run_command`, MCP calls, edits
and the rest read their field 140 -> 2 -> 1 when the stream is silent. A stream
that does carry output keeps it, and a file read never falls back to the stream.

Muse's `visibleOutput` is a bounded display surface. Completed native reads
instead use the same session/item's available `outputRef` through
`item/readOutput`. At most two read-only requests retain 64 KiB in total, with
a three-second deadline each. Pages must match their requested byte ranges,
length, encoding, media type and end marker. Outputs over 64 KiB use the same
head/tail scaling as ordinary tool estimates. Missing, inaccessible or invalid
retained output has no read-content count; it does not fall back to a summary.
Muse read summaries also do not produce live output-token estimates.

Codex's declared command/dynamic/MCP text and OpenCode ACP's original text
content continue through their existing full-output observations. No adapter
re-reads a source file, guesses a count from line totals or backfills history.
Offline protocol fixtures establish these paths; real native read variants
still require the release's hands-on verification.

| Harness | Tool output | Thinking receipt |
| --- | --- | --- |
| Claude Code | Complete root `tool_result` text; child events stay private | Group response fragments by `message.id`; finalize at a later response/result boundary. Use optional `usage.output_tokens_details.thinking_tokens` only with one thought block |
| Codex | Command output deltas and complete command/dynamic/MCP/result text; omit synthesized file-change/status labels and query-as-output fallbacks | `last.reasoningOutputTokens`, only with one completed reasoning item since the preceding receipt and the matching turn |
| Antigravity | Actual completed tool result/output/response text; when the stream has none, the completed native step's result text (always, for file reads) | Recovered thought rows exist; no thinking-count attribution is implemented in this adapter yet, so omit |
| Muse | Visible tool-output deltas/snapshots and complete visible results | Completion `usage.reasoningTokens`, only with one completed reasoning item in that scope |
| OpenCode ACP | Original tool-content snapshots before preview clipping | No attributed field in the captured protocol, so omit |

Live counts coalesce to approximately one frame per second per actor. Their
node-stream frame updates the shared conversation's token overlay without
retiring prose/thought partials, fetching `/chat`, or invalidating the tree.
Terminal estimates live on ordinary durable chips. HTTP supplies live overlays
for a desk opened mid-call; older HTTP snapshots cannot replace newer counts.

## Row counts (4.5.0)

USER 2026-10-27 m10e4ca6d8934, "token counts in messages of all kinds (agent,
monitor event, system, etc)", and mafe020c4912b, "and user messages"; design
approved by the coordinator (m179c9d46b166). Every conversation row the actor
writes carries a `tokens` object in its `ot.convo` body (no migration):

- `{count, reported}`: the provider reported this count for exactly this row.
  Claude reports each response's output, and one row is one response, so its
  `count` covers that response's thinking, text and tool calls. It is the
  response's final output: the CLI's assistant event for each block carries the
  usage as it stood before the response finished (a reply of about 130 tokens
  showed 8t, USER 2026-10-27 mf421a040506c), so `State::claude_output` keeps the
  largest output seen for the response and its `message_delta` supplies the
  final one. A Codex or Muse
  request that produced only the reply (no reasoning, no calls) puts its
  reported output on that reply's row (`Receipt::text_of`).
- `{count, estimated, sampled, covers?, parts?}`: the engine's estimate (the
  calibrated public BPE above, on the blocking pool, bounded per row).
  A delivered message (the turn's opening message, a mid-turn or hook delivery)
  keeps `count`, exactly the text sent, and from `prompt::Batch` carries `own`,
  each mail by id counted as if it were sent alone with the framing that always
  comes with it (`turn_text` of that mail alone, or its mid-task wrapper), and
  `extras`, the parts sent with them that appear only sometimes and that the
  sender does not control (`prompt::context_parts`: `Org state`, `Provider
  usage`, `Handoff note`, and `More mail follows` when the byte budget cut the
  batch), with `extra` their sum (USER 2026-10-27 m7c48d80b13f4, md965e01802ba,
  m90b8a18987ea). Each is estimated alone, so they need not add up exactly to
  `count`: framing shared by several messages is counted with each. Rows from
  the first 4.5.0 alphas carry `parts` instead. Text the CLI adds itself is not
  visible to the engine and is not counted. Response
  rows without a reported count are estimated once at turn end
  (`count_turn_rows`; `covers` names `text`, `tool calls` or both), and each tool
  chip gains `input_tokens`/`input_tokens_estimated` for its call input. Shown
  thinking is a provider summary, so it is never estimated: unreported thinking
  says so. A thought alone (Codex, Muse and Antigravity give each reasoning item
  its own row) carries the reasoning the provider reported for it, or
  `not_counted`, and the desk shows it once, on the thought line.
- `{not_counted}`: why the row has no count, never 0. Display-only rows (`not
  sent to the agent`), engine compactions (their summary opens the next turn
  and is counted there), provider compactions (the provider keeps the summary;
  `pre_tokens` keeps its reported context size before), slash commands for the
  CLI, and mail the agent fetched itself (counted in that orgtree_inbox result).

The desk (USER 2026-10-27 m4bad9bdbd3a1, "for messages, like user messages, place
the count in the header, next to the time. or everything else jkust omit it")
shows a message card's own count after its time, and `+N` with the extras
itemized on the delivery's last mail card that is not a folded system notice
(`transcriptEntries` hands every card the counts and only that card the extras).
Rows without a timed header (replies, system cards and lines, compactions) show
none; tool chips and thought lines keep their inline counts.

Counts are written once by the actor (the only writer): mail rows when they are
appended, response rows at their receipt or at turn end, onto the stored row's
count fields only. Reads (desk pages, orgtree_read_transcript) project stored
fields; nothing rereads or recounts history and there is no backfill, so rows
written before 4.5.0 have no `tokens` and show nothing. orgtree_read_transcript
rows carry the same `tokens` object (a result change only; no tool text).

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
