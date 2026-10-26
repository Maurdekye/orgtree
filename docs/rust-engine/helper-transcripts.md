# Inline helper transcripts (4.4.0 initial slice)

## Live helper inspector (4.5.0, 2026-10-26)

USER m95e7ead06333 requested a chat-header count and a helper details/live
transcript panel. The header now shows a button while the actor has observed
running helper identities. It opens a temporary inspector in the originating
desk's owning document, including pinned and popped-out desks. Closing it stops
its reads. Finished entries remain inspectable while open; the badge disappears
when the observed live count reaches zero. Type, description, model, observed
start and status are shown. Missing values stay "Not reported"; start times
are engine receipt times, not invented native execution timestamps.

Measured source/native-format inventory (not live-provider execution):

| Harness | Observable helper lifecycle/details | Live helper transcript |
| --- | --- | --- |
| Claude Code | Root Agent/Task inputs and native task IDs/snapshots/notifications. Foreground results settle foreground calls; background launch replies do not settle helpers. Shell jobs/nested events are excluded; task/tool IDs join one identity. | Existing first-level `parent_tool_use_id` capture during the parent's running turn, including an observed live background helper whose launch call returned. |
| Codex | Parent-thread/turn `collabAgentToolCall` receiver IDs and explicit `agentsStates` status. A completed spawn tool does not finish its helper; missing status stays unknown. | Not available in this adapter. No child thread is resumed/read/subscribed by opening the panel. |
| Muse | Parent-turn `subagent` item lifecycle, `subagentId`, role/objective and supplied model. | Not available; no child-session subscription. |
| OpenCode | No trusted child-session join currently negotiated by the ACP adapter. | Not available for this harness. |
| Antigravity | Generic helper tools provide no verified child identity/lifecycle join. | Not available for this harness. |

The table is checked against `runtime/{tasks,actor,live_helpers}.rs`, focused
native-format lifecycle controls and existing fake-CLI formats. It is the
acceptance support table. Codex status is the latest explicit parent-stream
observation, not an independently subscribed child heartbeat. Zero observed
helpers does not establish native support for an unsupported harness.

Actor-owned metadata retains at most 64 identities, evicting settled entries
first. Saturation is disclosed; list/count cover retained identities only.
Descriptions cap at 400 characters, model at 120, type at 80, IDs at 160.
Only the count enters the org feed; details use the parent actor's separate
lock-free read view. No global lock, native file scan, model call or history
search is added. CLI closure clears the view; unconfirmed foreground status at
the parent turn boundary becomes unknown. Metadata is not historical storage
and never revives a cold actor.

`GET .../nodes/{nid}/helpers` uses ordinary authenticated parent resolution.
`orgtree_read_transcript` provides the list with `helpers:true`, or one retained
transcript with `helper:{seq,tool}`, under unchanged self/strict descendant
authorization. HTTP and tool transcript paths share one indexed, redacted
reader. Neither accepts a child session or path; content is excluded from
method/wire diagnostics. Ordinary transcript reads are unchanged.

The panel reuses normal helper `Msg`/tool disclosures and follows new output
until the reader scrolls away from the bottom. Returning to the bottom resumes
following. Existing transcript size/credential-redaction bounds and one-level
limit remain in force.

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
opens another helper transcript. Completed arguments are normalized and passed
through the ordinary transcript credential redactor before capture. Inline
MQTT/WebSocket credentials and secret URL values are hidden; ordinary arguments
and credential-file paths remain available.

Partial tool JSON stays in an unlogged, bounded 8 KiB draft until it parses as
a complete argument object that can be normalized and redacted. Until then the
input disclosure says "Arguments withheld until complete JSON can be redacted."
Truncated or unidentified wrappers are withheld too. Drafts are cleared at the
block/message boundary and completed-message replacement. Older saved snapshots
are sanitized by the authenticated read route; clipped JSON from those records
is withheld because its secrets cannot be reliably identified. This protects
publication without rewriting historical storage. [verified: 2026-10-21,
`runtime/helper_transcript.rs`, `http/nodes.rs`; hardening credential fix]

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
