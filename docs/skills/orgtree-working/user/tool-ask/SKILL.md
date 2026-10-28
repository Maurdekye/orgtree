---
name: orgtree-tool-ask
description: Ask desktop question cards with options or free text and understand shared request tabs, docket links and superior routing.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_ask

Use for missing information or a decision, with enough context for the recipient to answer. After asking, end your turn; the answer arrives as mail. Withdraw a request that becomes moot with [orgtree_withdraw_ask](../tool-withdraw-ask/SKILL.md). For Hubchat preset-answer questions use [orgtree_message](../../mail/tool-message/SKILL.md), which has a different options shape and route.

Required tool group: `user`, inherited through your ancestor chain. Agents with no agent superior and live, unpaused effective user-audience holders create a card on the user's desk; an inherited project audience counts. Without that audience, the normalized questions go to your nearest agent superior through intervening projects as mail, with their labels/options and docket context; no user card is opened. That superior's reply arrives as mail. This fallback is not a user-audience grant.

## Parameters

Use either the single-question form or `questions`. A non-null questions field overrides the single form; the call has no required top-level field in the schema, but the handler requires actual question text.

| Field | Default and limit |
| --- | --- |
| `question` | Required nonblank complete text in the single form, or inside each questions object. Trimmed. |
| `header` | Optional short chip label; schema recommends about twelve characters. Handler reduces it to a 24-character gist. |
| `options` | Optional array of up to four `{label, description?}` objects. Offer two to four choices, or omit for free response. Label should be concise, one to five words; description explains the choice. |
| `multi` | False by default; true lets the recipient select several options. This is named multi, unlike message's multiple. |
| `work_item` | Optional readable docket slug. Applies to the single form, or as fallback for tabs that do not specify their own. |
| `questions` | Array of one to four objects per call, each with question and optional header/options/multi/work_item. |

Minimal free-response call:

```json
{"question":"Which repository branch should this change target?"}
```

Single-choice example:

```json
{"question":"Which output do you need?","header":"Format","options":[{"label":"CSV","description":"A plain tabular export"},{"label":"JSON","description":"Structured records"}]}
```

Option normalization preserves at most the first four input entries. Blank/missing labels are dropped, labels trim and clip at sixty characters, descriptions at three hundred. Compatibility strings and label aliases are accepted by the handler; write the exposed object schema rather than relying on that repair. An entirely unusable option list yields a free-response question rather than an invented choice.

## Formatting

Question text and option descriptions render as chat does: Markdown (headings, lists, emphasis, code, tables, links), LaTeX (`$...$` or `\(...\)` inline, `$$...$$` or `\[...\]` as a block) and mention links (`@agent`, `@item:<org>/<slug>`, `@doc:<org>/<slug>`, `@app:`/`@panel:`, `@net:`/`@org:`). This holds on the open card and the answered card, wherever the user sees them: their desk, inbox, Attention view and a linked docket item. Plain text looks as it always did. The dollar rules are chat's: currency and shell variables stay text, and `\(...\)` writes a formula that `$...$` would leave alone.

Option labels are short button text: keep them plain. A mention in a label stays text. The inbox list's one-line preview and the desktop notification show a plain gist of the source text. A question card is not relayed to Hubchat.

```json
{"question":"## Release\n\n- Tests pass for @item:my-org/ship-it\n- Error bound: $\\epsilon \\le 10^{-3}$\n\nShip now?","options":[{"label":"Ship","description":"Tag it once @release-lead confirms"},{"label":"Wait"}]}
```

## One open request and amendments

Each agent has at most one open user request combining question tabs, a [credit tab](../tool-request-credits/SKILL.md), and [scope items](../tool-request-scope/SKILL.md). Asking again amends that request: identical question text replaces its tab; new text appends a tab. It does not replace all earlier tabs merely because you sent a new questions list.

A single call carries at most four questions, but the combined open request can contain up to eight question tabs after amendments. Growing it past eight refuses without changing earlier tabs. Wait for the recipient's submit or withdraw the batch before replacing obsolete questions. Withdrawal removes the whole request, including its credit/scope parts.

The user sees a tabbed card, including mixed requests, and submits a combined decision. The result is mail, not a synchronous tool return. A dismissal/skip is not an affirmative answer. A revision check protects against submitting an answer to an amended card; do not ask the user to approve a stale screenshot or summary after changing its tabs.

## Docket attachment and refusal behavior

`work_item` attaches the question to a readable docket item. Each tab can target a different slug; tabs without a target still belong to the full request. The handler validates all docket references before opening a card **or** sending superior fallback mail. Inaccessible/missing items refuse the call. A question link does not assign or change ownership of the item. Use it for an item-related question rather than setting the item's agent-review status to ask the user.

Typical refusals are `a question needs its text`, non-array/empty questions, more than four questions in a call, the combined eight-question cap, inaccessible docket links, or unrecoverable tool-call markup in the question text. The engine can recover some leaked options markup, but do not depend on it: send structured fields and readable prose.

You do not gain additional authorizations by asking. Wait for the actual answer when it controls dependent work; elapsed time, a card appearing, or a mail acknowledgement is not consent. Fresh-session replacement can make an open request moot; use the handoff context and re-ask only if the need remains.

## See also

- [orgtree-reaching-the-user](../reaching-the-user/SKILL.md)
