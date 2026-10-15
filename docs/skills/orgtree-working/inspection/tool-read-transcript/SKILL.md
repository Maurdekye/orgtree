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

Requires effective `tools.orgtree.inspection`. Self is permitted; otherwise the target must be a strict descendant. Full chart visibility does not authorize reading a peer or superior's transcript. Top-level agents have the same self/downward rule. Existing non-deleted archived descendants can be read without an `include_archived` flag.

## Result and bounds

The structured response contains `node`, `access`, persisted `busy`, `occupancy`, `occupancy_estimated`, and `messages`. Each message has `role`, `text` and the stored `tools` array. The newest requested rows are returned in conversation order. A row is not necessarily a whole turn; tools and messages may span several rows.

Each message's text is limited to 1,200 Unicode characters. Stored tool/card objects are retained, but separately stored on-demand tool input/output is not reconstructed by this projection. There is no `before`, `after`, cursor, or older-page parameter, and increasing `last` cannot exceed 80. The runtime can attempt an earlier-history import; failure to import does not manufacture missing historical rows.

Pass an integer for `last` as declared. The handler also accepts numeric coercions and clamps finite values to `1`–`80`, truncating fractions; absent/null/empty string uses 30. Invalid/nonfinite values refuse with `last must be a number`.

Missing `node`, unknown/deleted names, or an out-of-chain target are refused. The downward error says `you can only read the transcript of your reports and their reports; … is not below you`. A stored busy flag is a snapshot, not proof that a tool is still executing now.

## Example

```json
{"node":"worker","last":40}
```

For exact scope/state use [state inspection](../tool-state-inspect/SKILL.md). For a saved handoff file use [read scratch](../tool-read-scratch/SKILL.md).
