---
name: orgtree-reaching-the-user
description: "Choose a question, attention flag, document, file or mail route for what the recipient needs."
---

Up: [orgtree-user](../SKILL.md)

# Choose the delivery for the need

Use the surface that lets the recipient act on the result. A local path alone is not delivery. For a person writing through Hubchat, follow [outside-mail reply routing](../../mail/external-mail/SKILL.md); their chat does not receive your local turn text or desktop cards automatically.

| Need | Read this page |
| --- | --- |
| Missing information or a decision | [orgtree_ask](../tool-ask/SKILL.md), including the superior fallback without a user audience. |
| A docket decision or deviation the user must see, without asking a question | [Docket review and attention](../../docket/docket-review-and-attention/SKILL.md). |
| A report, plan, proposal or Markdown document meant for reading | [orgtree_present](../tool-present/SKILL.md). |
| Bytes wanted as a file, such as a log, export, installer or image | [orgtree_send_file](../tool-send-file/SKILL.md). |
| More team capacity or missing folder/tool access | [Credit request](../tool-request-credits/SKILL.md) or [scope request](../tool-request-scope/SKILL.md). |
| An ordinary update to an authorized recipient | [orgtree_message](../../mail/tool-message/SKILL.md). |

The tool pages own parameters, limits, permission checks and response meanings. In particular, presenting a document requires direct user access, whereas send_file's implementation has different checks. Honor the session's communication scope; that implementation difference does not authorize bypassing the superior route.

## Keep requests current

After asking, do independent work if possible and end the turn when waiting for an answer. Do not simulate a synchronous dialog with polling. Revisit an open request when new information arrives: if the need was resolved elsewhere or its premise died, use [orgtree_withdraw_ask](../tool-withdraw-ask/SKILL.md). Read that tool before withdrawing a mixed request, because the withdrawal affects its combined parts.

A question is different from agent review, and a request or card appearing is different from approval. Keep required decisions pending until an actual answer arrives. Use the docket attention page for flag lifecycle rather than leaving a stale flag or question on the user's screen.

## What the user receives

Question cards and presented documents have desktop surfaces; file delivery produces a chat download card, with supported images displayed inline. Their tool successes record those deliveries, not that the user read, downloaded or accepted the content. Cards are also distinct from native notifications. Native alerts depend on application preferences and platform delivery; see `orgtree-app-notifications` (orgtree-app › app-settings) for kinds and defaults. Do not promise that creating a card necessarily produces an OS alert.

## See also

- [orgtree-tool-ask](../tool-ask/SKILL.md)
- [orgtree-tool-present](../tool-present/SKILL.md)
- [orgtree-tool-send-file](../tool-send-file/SKILL.md)
- [orgtree-docket-review-and-attention](../../docket/docket-review-and-attention/SKILL.md)
