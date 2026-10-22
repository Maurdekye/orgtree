---
name: orgtree-do-not-disturb
description: Hold non-urgent incoming mail for one focused turn on any harness, with urgent bypass and explicit inbox reads.
---

Up: [orgtree-runtime](../SKILL.md)

# Do Not Disturb

Agent cards and desks show a DND state badge in their badge row, beside effort rather than status. The composer's round `!` urgency button sits beside Fast and turns orange-red (`#ff4500`) when armed; the message box outline uses the same color. It appears only for a current DND recipient. A project composer offers the same button while broadcast is on and at least one live recipient is in DND; only those recipients receive urgent mail, while other recipients receive ordinary mail. User-originated urgent sends do not require a reason.

The user can toggle DnD in a live agent's desk header. An agent can control a descendant with `orgtree_status node=<agent> dnd=true/false`, without status or summary; this needs the runtime tool group and descendant authority. Peers, superiors, projects and retired targets are refused. Self control needs no tool group. The target can always clear its own DnD, whoever set it.

For a running target, the hold applies to the current turn. For an idle target, a superior or the user arms **DND next turn**, visible on its card/desk and as `dnd_next_turn:true` in the tool result. The opening mail batch starts that turn normally; admission atomically consumes the armed flag into the turn's DnD. Arming does not block the mail needed to start the turn and is not yet an urgent-mail bypass target. Clearing before admission disarms it. A self `dnd=true` still needs the agent's own running turn.

Call `orgtree_status status=working summary="Focused work" dnd=true` during your own running turn. DND is available with status reporting, even with every tool group off. The card and desk show a small DND badge. It protects every harness, including Antigravity and other harnesses whose mid-turn mail handoff can interrupt work and lose prompt-cache reuse.

Non-urgent mail stays durably unread in your mailbox. It does not steer, hand off to, or interrupt the running turn. Sender identity makes no exception: user mail and superior mail wait too. Senders see **held (do not disturb)**. Existing checkups and reminder scheduling continue; their non-urgent mail is held by the same rule.

Active DND belongs only to the current turn. When that turn actually ends, including an error, halt or engine restart, DND turns off and all still-unread mail is offered in one ordered admission, **all at once, within the prompt size budget**. There is no ordinary message-count cap for that released batch. A tail that exceeds the hard input-byte budget stays durable and ordered for the next admission. A queue containing only held notices is released too. Halt, freeze and kill-switch admission rules still apply.

`dnd=false` removes active and armed DnD immediately, whoever enabled it, and triggers delivery of all held mail now, without waiting for turn end or imposing a message-count cap. This applies to self, superior and user clearing. Native delivery uses exact-turn steering for Codex/Muse, PostToolUse for Claude, the next invocation hook for Antigravity, and the next tool boundary for supported OpenCode. It does not interrupt or restart the agent. Existing input-size/chunking limits still apply: overflow stays durable and ordered for follow-up deliveries at the next supported boundaries. Halt, freeze and kill-switch admission rules still apply.

Reporting `status=done` does not itself end a turn; DND remains until the actual boundary unless explicitly switched off. A later turn starts with DND off; enable it again when needed. An idle armed flag survives until cleared or consumed by admission; an active turn hold clears at its boundary, including recovery.

## Read selected mail yourself

`orgtree_inbox list` and `conversation` show previews and leave held mail unread. An explicit `fetch` or valid `chunk` of a pending received message marks only returned content read, during DND or outside it; its sender sees **read**, and it is excluded from automatic input. Missing IDs and output-budget deferred messages are not consumed. Opened received and project mail appears after the tool in the transcript without duplicating mail already displayed. Reading a project's waiting mailbox never claims its mail; sent history and previews add no transcript entries.

## Urgent bypass

Only mail marked urgent bypasses DND. A user-originated urgent send may omit `urgent_reason`. Agent-originated urgent mail sent through `orgtree_message` still requires a nonblank `urgent_reason` and ordinary mail authority. Agent recipients can be marked urgent only while they are currently in DND; a stale or non-DND target is refused clearly by the agent tool, per recipient for a plural send. Urgency adds no new wake or notification-noise behavior to agent mail; normal notice and wake rules still apply. It shows the existing urgent marking in the mail view.

The user's agent composer shows the urgent toggle only while its recipient is in DND, changing live; it does not ask the user to type a reason. A project megaphone shows the toggle when any recipient is in DND and applies urgency only to those recipients; other recipients receive ordinary mail. Normal delivery results remain per recipient. Agent-originated urgent mail to the user still requires a nonblank reason.

## See also

- [orgtree-tool-status](../tool-status/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-tool-inbox](../../mail/tool-inbox/SKILL.md)
- [orgtree-tool-message](../../mail/tool-message/SKILL.md)
