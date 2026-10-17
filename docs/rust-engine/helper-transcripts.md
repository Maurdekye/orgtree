# Inline helper transcripts (4.4.0 initial slice)

Expanding a helper's tool call shows the helper's own transcript inside it.
The user chose live updates and **one level only** (2026-10-16 20:23Z):
the helper's own helper calls keep ordinary tool details, with no further
transcript expansion.

## Initial implementation

New Claude Code `Agent`/`Task` calls use the harness's explicit
`parent_tool_use_id` link. Only a known root call in the current parent turn
can own output. Helper text, supplied thoughts, tools and results stay private
in that call's `ot.convo.tool_inputs` entry, outside chat/feed payloads and
the parent's usage. Token writes coalesce at 250 ms; expanded readers refresh
without starting a CLI, running inference or reading a native file.

The authenticated `helpertranscript/{seq}/{tool}` route resolves the same
org/agent as chat, then reads that exact row and tool. It exposes no browser
supplied session or file path. Content is excluded from method/wire logging.
Live state requires the parent call to belong to the current running turn.
Completion flushes helper deltas before ending the parent tool/turn.

Capture is bounded to 16 helper calls per parent turn, 64 messages and 64 KiB
per snapshot, 8 tools per message and bounded text/arguments/results.
Truncation is shown explicitly. Captured output survives reopening the desk;
unrecorded calls explain that no helper transcript was retained.

## Normal transcript presentation (user feedback 2026-10-17)

Helper rows now use the desk's normal `Msg` and `ToolChip` components: Markdown
prose, expandable supplied thinking and ordinary input/result disclosures. The
nested section keeps its helper heading, scroll/height limit and normal message
typeface instead of inheriting its parent tool row's monospace styling.

Each helper has its own fold store, pruned against retained rows, so a native ID
cannot open a parent or sibling helper's fold. Child input uses `ToolInputDetails`
with a retained payload; it never looks up a tool in the parent conversation or
opens another helper transcript. Clipped arguments stay readable verbatim.

New capture includes at most 64 ordered content fragments per message, within
the unchanged message/tool/serialized-byte caps. Text and thinking ranges use
UTF-16 offsets for JavaScript slicing, after NUL removal and text caps. Both
streamed and completed records retain native text/thinking/tool order; completed
records replace drafts. Existing snapshots without order use the normal grouped
fallback. No native history recovery or additional adapter is introduced.

The view passes through supplied thought duration, completed tool clocks and
task token totals. Current Claude helper capture does not supply those clocks
or totals; the normal unknown-time slot remains unknown and no parent usage or
clock is borrowed. Synthetic fixtures with supplied fields test the slots, and
are not evidence of native provider timing/token availability.

## Research and deferred adapters

| Harness | Verified format/link | Deferred work |
| --- | --- | --- |
| Claude Code | Live events carry `parent_tool_use_id`; native sidecars use `subagents/agent-<agentId>.jsonl`, `agentId`, `isSidechain`; installed Agent output includes `agentId`/`outputFile` | Historical sidecar recovery; helpers continuing after the parent turn; remote helpers |
| Codex | `collabAgentToolCall.id`, `senderThreadId`, `receiverThreadIds`; thread metadata includes parent provenance; read-only thread history APIs exist in saved CLI schema | Validate child ancestry and stream/read child history without resuming it; prevent child notifications entering parent rows |
| Muse | Saved MSP schema explicitly documents `Item.childSessionId`, `session/read`, `view/page`, and read-only `view/subscribe` with cursor replay | Retain child IDs and attribute/subcribe child records separately from parent state |
| OpenCode | Saved ACP source tracks child `parentID`/depth; opt-in `opencode/child-session-updates` capability separates child notifications | Verify projected parent-tool provenance, negotiate and attribute the extension |
| Antigravity | Helper tools exist; current adapter accepts `init`, `step_update`, `result` | No trustworthy child-transcript locator/parent-call join verified; research before adding capture |

These are static source/schema findings, not real-provider execution proofs.
Other harnesses and older calls show an unavailable explanation in this slice.
No recursive transcript, transcript-to-model replay, new helper execution or
change to native helper permissions is included.

## Focused evidence

`apps/desktop/renderer/tests/helpertranscript.test.tsx` covers expansion-only
reads, live replacement, collapse cleanup, one-level tool details, retry and
ordinary-tool exclusion. `runtime/helper_transcript.rs` has focused fold/bounds
controls. `tools/rig/proofs/helper-transcript.mjs` covers fake-Claude live
capture, private storage, nested-event exclusion, parent completion and halt.
The exact hand-in records what actually ran and screenshot paths; authored
checks alone are not a pass.
