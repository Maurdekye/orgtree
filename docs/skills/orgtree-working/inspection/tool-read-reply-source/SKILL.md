---
name: orgtree-tool-read-reply-source
description: Read bounded exact source text and its digest for verified selection replies.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_read_reply_source

Read one canonical source part before attaching an exact passage to a reply, or
recover live context around a selection delivered in mail. Requires effective
`tools.orgtree.inspection`. It never consumes mail, claims/acknowledges project
work, marks a presentation viewed, imports history or reads native provider files.

## Parameters

| Parameter | Required/default | Meaning |
| --- | --- | --- |
| `target` | Required | Legacy mail ID; `{kind: mail\|document\|presentation, org, id}`; `{kind: work_item, org, slug}`; or `{source_event_ref: {org, agent, generation, eventId}, mail_id?}`. Same-org identity only, without a selection wrapper. |
| `part` | Required | Object with `part` and, when needed, `tool_id`, `pointer`, `role`, `entry`; see below. Unknown properties refuse. |
| `offset` | Default `0` | Nonnegative Unicode-scalar offset into this exact part. |
| `expected_sha256` | Required for nonzero offset | Lowercase digest returned by the first window. A mismatch refuses; restart the read rather than join different versions. |

| Part | Additional selector |
| --- | --- |
| `mail.body` | A mail identity or individual transcript mail card. |
| `text`, `cmd_out`, `thinking` | Exact transcript event. User `text` contains only visible segments, never machine state/envelopes. Thinking must have retained displayed text. |
| `tool.input` | Required `tool_id`; optional RFC6901 `pointer` (default root), `role` = `value` (default) or `key`. Key requires a pointer to an object property. Decoded strings stay exact; other JSON uses deterministic pretty JSON. Retained inputs use ordinary credential redaction. |
| `tool.result`, `tool.error` | Required `tool_id`. Only retained result/error text; no fabricated full output or synthetic JSON closers. |
| `document.body`, `document.title` | Markdown presentations only. |
| `work_item.title`, `work_item.objective`, `work_item.blocked_reason`, `work_item.dropped_reason` | Exact retained field. An absent reason is unavailable. |
| `work_item.done_so_far`, `work_item.working_on_next`, `work_item.evidence.note` | Required zero-based `entry`, at most 49. Duplicate entry text refuses because these lists have no stable element IDs. |

## Authority and bounds

Mail must be among your ordinary received/sent mail. Transcript events require
self/downward authority, including exact generation; full chart visibility does
not add peer/superior access. Transcript mail-card reads follow that same rule.
The current running transcript turn refuses; older settled turns remain readable.
Docket reads use the ordinary owner/creator/superior/participant/reviewer ACL.
Presentations must be authored by you or in a project you currently reach. Top-level
agents follow these same source gates. A delivered quote grants no extra live access.

Each returned `text` window is at most 4,096 UTF-8 bytes without trimming. Result
fields include `target`, `part`, `revision`, `projection: source-v1`,
`unit: unicode-scalar`, `sha256`, `offset`, `total_scalars` and `next_offset`.
Continue only while `next_offset` is non-null, with the same digest. A single
canonical part is limited to 1 MiB; select a smaller retained field/JSON scalar
for larger inputs. Missing/deleted sources, invalid parts, stale generation,
HTML, unretained output, out-of-range offsets and unauthorized reads refuse.
No source scan searches other objects to guess a missing location.

```json
{"target":"mail-1","part":{"part":"mail.body"}}
```

Use the returned digest and half-open Unicode-scalar range in
[orgtree_message selection replies](../../mail/tool-message/SKILL.md#selection-replies).
Recent [transcript reads](../tool-read-transcript/SKILL.md) expose `event_id`,
`convo_revision` and the current `generation` to identify exact source rows.

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)

## Compact message schema and JSON result parts

The eager message tool exposes only the minimal `{target, selection}` wrapper. Load this deferred tool and read this Guide before constructing selectors; the engine still enforces the full contract. `projection` is `source-v1`, `unit` is `unicode-scalar`, `expected_sha256` is the returned exact UTF-8 digest, and `start`/`end` are half-open offsets in the same canonical part. No caller-owned quote/context fields are accepted.

Send the wrapper in `orgtree_message` replies. Optional `tool_id`, `pointer`,
`role` and `entry` must match the canonical part read here. The engine derives
the excerpt and refuses changed digests before sending. Selection replies are
internal-only: at most eight selections, each at most 4,096 UTF-8 bytes, with
48 KiB combined metadata. Never supply `excerpt`, `prefix` or `suffix` as
caller-owned metadata.

`tool.result` also accepts `pointer` and optional `role: key` for complete retained JSON results. Strings are decoded scalar text; other values use deterministic pretty JSON. Invalid or clipped JSON is never repaired into a selectable part. A failed shell's separately retained full output is read before its clipped chip summary. The tool remains bounded and does not fetch provider-native history files.

Transcript discovery retains bounded supplied thinking, sealed/truncated markers and incomplete/interrupted flags alongside selection event/revision IDs. A mixed readable/sealed row can expose its supplied readable summary; a sealed-only empty part remains unavailable. Ciphertext is never a source part.
