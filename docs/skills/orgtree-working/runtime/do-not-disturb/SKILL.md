---
name: orgtree-do-not-disturb
description: Hold non-urgent incoming mail for one focused turn on any harness, with urgent bypass and explicit inbox reads.
---

Up: [orgtree-runtime](../SKILL.md)

# Do Not Disturb

Call `orgtree_status status=working summary="Focused work" dnd=true` during your own running turn. DND is available with status reporting, even with every tool group off. The card and desk show a small DND badge. It protects every harness, including Antigravity and other harnesses whose mid-turn mail handoff can interrupt work and lose prompt-cache reuse.

Non-urgent mail stays durably unread in your mailbox. It does not steer, hand off to, or interrupt the running turn. Sender identity makes no exception: user mail and superior mail wait too. Senders see **held (do not disturb)**. Existing checkups and reminder scheduling continue; their non-urgent mail is held by the same rule.

DND belongs only to the current turn. When that turn actually ends, including an error, halt or engine restart, DND turns off and all still-unread mail is offered in one ordered admission, **all at once, within the prompt size budget**. There is no ordinary message-count cap for that released batch. A tail that exceeds the hard input-byte budget stays durable and ordered for the next admission. A queue containing only held notices is released too. Halt, freeze and kill-switch admission rules still apply.

`dnd=false` releases early. Reporting `status=done` does not itself end a turn; DND remains until the actual boundary unless explicitly switched off. A later turn starts with DND off; enable it again when needed.

## Read selected mail yourself

`orgtree_inbox list` and `conversation` show previews and leave held mail unread. An explicit `fetch` or valid `chunk` of a held message marks only the returned message read; its sender sees **read**, and it is excluded from the end-of-turn batch. Missing IDs and messages deferred by the tool's response budget are not consumed. Outside DND, manual reads retain their usual non-consuming behavior. Reading a project's waiting mailbox never claims its mail.

## Urgent bypass

Only mail marked urgent bypasses DND. An urgent send requires a nonblank `urgent_reason` and ordinary mail authority. Agent recipients can be marked urgent only while they are currently in DND; a stale or non-DND target is refused clearly by the agent tool, per recipient for a plural send. Urgency adds no new wake or notification-noise behavior to agent mail; normal notice and wake rules still apply. It shows the existing urgent marking in the mail view.

The user's agent composer shows the urgent toggle and reason only while its recipient is in DND, changing live. A project megaphone shows it when any recipient is in DND and applies urgent only to those recipients; other recipients receive ordinary mail. Normal delivery results remain per recipient. Urgent mail to the user keeps its existing behavior.

## See also

- [orgtree-tool-status](../tool-status/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-tool-inbox](../../mail/tool-inbox/SKILL.md)
- [orgtree-tool-message](../../mail/tool-message/SKILL.md)
