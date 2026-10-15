---
name: orgtree-tool-withdraw-ask
description: Withdraw your own entire open desktop request when its question, credit or scope decision is no longer needed.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_withdraw_ask

Use when your current user request is moot or needs to be replaced as a whole. It is not a message retraction, a single-tab editor, or withdrawal of another agent's request. The [ask leaf](../tool-ask/SKILL.md) owns the shared question/credit/scope batch contract.

Required tool group: `user`, inherited through your ancestor chain. The tool acts on your own agent ID; there is no target field or special top-level power to withdraw someone else's request. It has no separate user-audience requirement.

## Parameters and call

No arguments are required or exposed; there is no action, request ID, work-item selector or reason parameter.

```json
{}
```

## Effect

All your currently open request rows become withdrawn, with a resolution time and the recorded reason `withdrawn by the agent`. In the normal one-open-request model this closes the whole card: all questions, credit tab and scope items. It does not choose an answer, grant access/credits, change docket ownership or withdraw already-sent fallback mail.

If nothing is open, the tool succeeds with `You have no open request.` Otherwise it reports `Your request was withdrawn.` Repeating withdrawal is therefore harmless, but does not provide an undo of an earlier answer. Resolved requests remain historical records rather than being erased.

Without a user audience, [ask](../tool-ask/SKILL.md) and [scope requests](../tool-request-scope/SKILL.md) can route as ordinary mail to a superior instead of opening a card. This tool cannot retract that mail; notify the superior when the request is no longer relevant.

There are no tool-specific selectable actions or target-related refusals. A denied user tool group or unavailable caller/org context still prevents the call. Do not invent a success claim that the recipient forgot a message or that a prior decision was reversed.
