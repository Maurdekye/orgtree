---
name: orgtree-tool-read-transcript
description: Read bounded recent transcript rows for yourself or a descendant.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_read_transcript

Read recent conversation context to understand a descendant's progress or recover your own history. This is a read: opening an idle or archived transcript does not start its actor or a model turn.

## Parameters

| Parameter | Required/default | Meaning |
|---|---|---|
| `node` | Required | Your name or a descendant's name in this org; leading `@` accepted. |
| `last` | Default `30` | Number of recent stored rows; integer range `1`–`80`. |
| `helpers` | Optional `true` | List observed live/recent helper identities/details instead of ordinary rows. |
| `helper` | Optional object | Read one retained transcript using listed `seq` and `tool`; mutually exclusive with `helpers:true`. |

Requires effective `tools.orgtree.inspection`. Self is permitted; otherwise the target must be a strict descendant. Full chart visibility does not authorize reading a peer or superior's transcript. Top-level agents have the same self/downward rule. Existing non-deleted archived descendants can be read without an `include_archived` flag.

## Result and bounds

### Helper agents (4.5.0)

`{"node":"worker","helpers":true}` returns `count`, bounded `items` and
`truncated`. Items supply identity, harness, type/description, reported model,
observed start, status/live and retained `seq`/`tool` where available. The
64-entry limit is explicit; counts cover retained identities. This reads current
actor state without searching history or starting a CLI.

`{"node":"worker","helper":{"seq":7,"tool":"call-id"}}` reads that
call's bounded first-level transcript (`messages`, `live`, optional note and
truncation), with the desktop's shared indexed/redacted reader. It accepts no
native session or path. Access remains self or a strict descendant.

| Harness | Measured adapter support | Transcript |
| --- | --- | --- |
| Claude Code | Explicit root Agent/Task and background lifecycle; excludes shell jobs/nested helpers. | Captured first-level output during the parent's turn. |
| Codex | Parent-linked receiver IDs and explicit child states; spawn-tool completion does not finish a helper. | Not available for this harness. |
| Muse | Explicit parent-turn subagent item lifecycle and supplied metadata. | Not available for this harness. |
| OpenCode | No verified negotiated child identity/lifecycle join. | Not available for this harness. |
| Antigravity | No verified child identity/lifecycle join. | Not available for this harness. |

This is source/native-format measured, not a live provider execution claim.
Missing models stay unknown; start means observed receipt time. Codex states
are latest parent-stream observations without a child subscription. Developer
contract: `docs/rust-engine/helper-transcripts.md` in the source repository.

The structured response contains `node`, `access`, persisted `busy`, `occupancy`, `occupancy_estimated`, and `messages`. Each message has `role`, `text`, the stored `tools` array, `event_id` and `convo_revision`; the result also includes current `generation`. Use those identities with [read reply source](../tool-read-reply-source/SKILL.md) for exact bounded parts, including retained tool input and displayed thoughts. The newest requested rows are returned in conversation order. A row is not necessarily a whole turn; tools and messages may span several rows.

Messages also include `thinking`, `thinking_sealed` and `thinking_truncated`.
`thinking` contains supplied readable thinking for any harness, limited
independently to **1,200 Unicode characters**; the truncation flag says that
this projection shortened the stored thinking. `thinking_sealed: true` means
the row includes a sealed/unavailable thought, detected from either its row
marker or its ordered thought blocks. A mixed row can have readable thinking
and a sealed marker together. Empty thinking with no sealed marker is not proof
that a reasoning step occurred. Encrypted reasoning is never reconstructed.

Each message's text is limited to 1,200 Unicode characters. Stored tool/card objects are retained, but separately stored on-demand tool input/output is not reconstructed by this projection. There is no `before`, `after`, cursor, or older-page parameter, and increasing `last` cannot exceed 80. The runtime can attempt an earlier-history import; failure to import does not manufacture missing historical rows.

Each message has `tokens` (4.5.0): `{count, reported}` when the provider
reported it for that row (for Claude, the response's final output); `{count,
estimated, sampled, covers}` for an engine estimate; or `{not_counted}` with the
reason. A delivered message's `tokens` also has `own`, one `{id, count,
estimated, sampled}` per mail: the count the desk shows in that message's
header, the message as if sent alone with its framing. Its `extras` list the
parts sent with them that appear only sometimes (`Org state`, `Provider usage`,
`Handoff note`, `More mail follows`), and `extra` is their sum, the desk's `+N`.
`count` stays the whole text sent. Messages delivered before own counts carry
`parts` instead. It is `null` on rows written before 4.5.0, never 0. Tool
objects can carry `input_tokens` beside `output_tokens`.

Each message also has `incomplete` and `interrupted` booleans. Unfinished
streamed replies retained when a turn ends have `incomplete: true`; interruption
or killing also sets `interrupted: true`. They remain ordinary assistant text,
not thoughts. A matched later native completion replaces the partial row and
clears both flags. These flags describe received text, not tool-call outcomes.

Pass an integer for `last` as declared. The handler also accepts numeric coercions and clamps finite values to `1`–`80`, truncating fractions; absent/null/empty string uses 30. Invalid/nonfinite values refuse with `last must be a number`.

Missing `node`, unknown/deleted names, or an out-of-chain target are refused. The downward error says `you can only read the transcript of your reports and their reports; … is not below you`. A stored busy flag is a snapshot, not proof that a tool is still executing now.

## Example

```json
{"node":"worker","last":40}
```

For exact scope/state use [state inspection](../tool-state-inspect/SKILL.md). For a saved handoff file use [read scratch](../tool-read-scratch/SKILL.md).

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)
