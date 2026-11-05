---
name: orgtree-tool-state-inspect
description: Inspect permitted agents' structured state and effective scope without reading their conversations.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_state_inspect

Scope inspection follows the complete ancestor chain through nested projects.
Outer restrictions still apply at every depth; a cycle or missing ancestor is
refused rather than returning a partial effective scope.

Use this to diagnose agent state, folder grants, tool permissions, visibility, sibling positions or remaining work gates. It reads persisted structured records; a snapshot does not establish that an agent's implementation works or that a queued operation has completed.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `node` | Omitted | One exact agent name. |
| `nodes` | Omitted | Array of exact agent names; combined with `node` when both are given. |
| `include_archived` | `false` | Include non-live, non-deleted records otherwise permitted by the read rule. |
| `activity` | `false` | With exactly one node, add that agent's activity-history page to its row ([Activity history](#activity-history)). |
| `activity_limit` | `20` | Spans per activity page, 1 to 100. Needs `activity=true`. |
| `activity_cursor` | Omitted | The previous page's `activity.next_cursor`. Needs `activity=true`. |

Names are trimmed and a leading `@` is accepted. With no names, return all permitted records. The activity cursor and limit are the only cursor or page-size parameters, and there is no caller-selectable org. Requires effective `tools.orgtree.inspection` permission.

## Read access

You can inspect yourself and all descendants, including structural project rows, at every visibility, including `self`. With visibility other than `self`, you can also inspect your nearest agent superior and agents with the same superior, skipping projects, plus physical parent/sibling project context. With `full`, all non-deleted org nodes are eligible. Top-level callers have no agent superior; other top-level agents can sit in different projects. Agents sharing a superior are not necessarily physical peers; see [relationship terms](../../team/team-shape/SKILL.md#relationship-terms). Top-level position alone does not grant full visibility or cross-project mail reach.

Every explicitly requested name must be in the returned permitted set. An unknown, deleted, out-of-scope, or archived-without-opt-in name causes `state inspection is outside your visible scope: …`; it does not return a successful partial answer for the other names. Invalid structural ancestry can refuse with `invalid scope ancestry` or `missing scope ancestor`.

## Returned fields

The response has `actor`, your effective `visibility`, and `nodes`. Agent records include:

- identity, parent, title, state, generation, tier/model and provider;
- grant, seat cost, free credits, and archive time;
- live `sibling_index` (zero-based), `live_sibling_count`, and `live_child_count`; archived rows have no live index;
- safe account-binding presence/missing flags, freeze provider/cause/pool/deadline, halt/limit-lock and mid-turn flags;
- last status name/time, safe pending-model-switch fields, occupancy/context window, and pending-mail count;
- effective scope: visibility, permission mode, folders and modes in `add_dirs`, Bash/web/edit/subagents switches, Orgtree group switches and MCP grants;
- OpenRouter session harness and pin flag when recorded.
- `kind: project` for structural project rows; their presence is not an agent runtime or a new scope ceiling;
- `audiences_held`, `audiences_explicit` and `audiences_inherited`, the last naming each `grantor` and source `project`;
- each returned node's active actor `interrupt` record when available, including queued/applied/refused/cancelled/restart outcome, turn and harness boundary. This runtime snapshot is not restored across an engine restart.

Folder grants are ancestor-clamped effective grants, not merely the target's configured request. Structural projects pass agent scope through rather than imposing their old scope keys as a new ceiling. `parent` still names the physical parent, and sibling indices/counts use physical siblings, not all agents with the same superior. The mail count is pending mail, not message bodies and not a guarantee that every counted row will wake a turn. Free credits are not populated as a live funding balance for archived rows. Prompt text, transcripts, mail bodies and account secrets are absent.

## Activity history

`activity=true` with one node adds an `activity` object to that agent's row: the same history the user reads in the agent's **Activity** tab in settings (what the five states mean is described there: see the Agent settings glossary page `orgtree-agent-history-tab`). Use it to see whether a report is stuck or how long it has been idle without reading its conversation.

Rules:

1. Exactly one name in total across `node` and `nodes`; otherwise `activity reads one agent at a time; pass a single node`.
2. `activity_limit` or `activity_cursor` without `activity=true` is refused: `activity_limit and activity_cursor need activity=true`. A limit outside 1 to 100 or not an integer is `activity_limit must be an integer from 1 to 100`; a cursor that is not a positive integer string is `activity_cursor must be a returned activity cursor`. A non-boolean `activity` is `activity must be true or false`.
3. Visibility, the archived opt-in and the refusal text are exactly the read rules above: an out-of-scope, unknown, deleted or archived-without-opt-in name is `state inspection is outside your visible scope: …`.
4. A project is refused: `activity history lists an agent's states; a project has none`.
5. Read-only: it wakes nobody and writes no mail, notice, docket or transcript row; the target's state is not touched.

The row gains:

```json
"activity": {
  "as_of": "2026-11-05T10:12:03.004Z",
  "spans": [ {"state":"idle","start":"…Z","end":"now","secs":312,"dur":"5m"},
             {"state":"active","start":"…Z","end":"…Z","secs":1840,"dur":"31m"} ],
  "next_cursor": "48213",
  "totals": { "h24": {"active":{"secs":5400,"dur":"2h"}, "idle":{"secs":0,"dur":"0s"}, "blocked":{…}, "halted":{…}, "frozen":{…}},
              "d7":  { … } }
}
```

Spans are newest first; the open (current) span has `"end":"now"` and runs to `as_of`. `dur` uses the desk's compact age words. `totals` (time per state over the last 24 hours and 7 days, all five states, zero shown as `0s`) appear on the **first page only**: on a page fetched with a cursor the key is absent. `next_cursor` is `null` on the last page; pass it back as `activity_cursor` for the next, older page. An agent with no recorded state changes returns `spans: []` and zero totals. The history is read just after the visibility snapshot, as a second read: an agent archived in between still returns its first page.

## Example

```json
{"nodes":["worker","reviewer"],"include_archived":false}
```

The activity history of one report, then its next older page:

```json
{"node":"worker","activity":true}
{"node":"worker","activity":true,"activity_cursor":"48213"}
```

For conversations use [read transcript](../tool-read-transcript/SKILL.md); for a human-readable roster use [chart](../tool-chart/SKILL.md).

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)

## Saved speed

`scope.fast_mode` is the node-local saved boolean (absent storage reads false),
not a claim about a running turn's serving speed or model eligibility. It is
never inherited. Managers change it with hire/rehire/staff/retool `fast_mode`;
[fast defaults](../../team/tool-fast-defaults/SKILL.md) affect future hires.
