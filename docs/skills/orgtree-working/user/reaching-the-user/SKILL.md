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

The tool pages own parameters, limits, permission checks and response meanings. In particular, presenting a document outside a project you belong to requires effective user access; an explicit audience or one inherited from a live direct-parent project counts. Presenting within your own project, including through nested membership, has its separate member permission. The send_file implementation has different checks. Honor the session's communication scope; that implementation difference does not authorize bypassing the superior route.

## Keep requests current

After asking, do independent work if possible and end the turn when waiting for an answer. Do not simulate a synchronous dialog with polling. Revisit an open request when new information arrives: if the need was resolved elsewhere or its premise died, use [orgtree_withdraw_ask](../tool-withdraw-ask/SKILL.md). Read that tool before withdrawing a mixed request, because the withdrawal affects its combined parts.

A question is different from agent review, and a request or card appearing is different from approval. Keep required decisions pending until an actual answer arrives. Use the docket attention page for flag lifecycle rather than leaving a stale flag or question on the user's screen.

## What the user receives

Question cards and presented documents have desktop surfaces; file delivery produces a chat download card, with supported images displayed inline. Their tool successes record those deliveries, not that the user read, downloaded or accepted the content. Cards are also distinct from native notifications. Native alerts depend on application preferences and platform delivery; see `orgtree-app-notifications` (orgtree-app › app-settings) for kinds and defaults. Do not promise that creating a card necessarily produces an OS alert.

## The user can join project coordination

The user can participate directly from a project desk, without an agent seat. Their registrations appear as @user in the interface and as `user` in agent tool output. They share the agents' slot line, listener counts and fair mail queue, and survive an engine restart. These are user-owned desktop operations: agents, including project ancestors, cannot create, alter, cancel or release them on the user's behalf. There is no agent tool or Hubchat equivalent for these user registrations. The corresponding agent operations use [slot and listener watchdogs](../../watchdogs/tool-watchdog/SKILL.md) and [the project tool](../../team/tool-project/SKILL.md).

### Hold concurrency slots

In the project's Slots header, the user chooses a number and presses **Hold N slots**. A request waits in the same strict FIFO line and is granted as one whole lease; smaller later requests do not bypass it. Several user holds are allowed, but their held and pending quantities together cannot exceed the project's configured capacity. The number control uses that remaining personal allowance, not a promise that the requested capacity is currently free. A grant is shown in the Slots view without waking an agent or mailing the user. The user can cancel a waiting request or release a granted hold. User holds have no idle reclaim and remain until the user releases them, including across restart. Agent force-release and unqueue authority does not cover the user's rows.

### Listen for an event or a listener count

The Listeners header's **Register…** panel lets the user listen continuously or once for a project event, and register a one-time watch for a count of armed event listeners (1–1,024). Creating a new listener or watch enables the project's event-listeners setting; their own armed listener contributes to the count. An already-met count fires at once. Event fires and watch notifications arrive as ordinary mail in the user's inbox. The user keeps one listener and one watch per project: registering again switches once/continuous mode or updates the watched count in place, retaining the registration rather than creating a duplicate. Removing it is a separate user action. Turning project event listeners off pauses registrations through the normal project switch; turning it back on restores those paused by that switch.

### Take work from a mail queue

The project Mail header lets the user **Join mail queue**, with a batch capacity of 1–20 jobs. They take turns with agent listeners; assigned jobs arrive as ordinary user-inbox mail. Joining again changes the existing batch in place and keeps their queue order and held jobs. Raising capacity can dispatch waiting work immediately; lowering it does not reclaim jobs already held. The user's queue registration counts as a listener, so a queue with only that listener is not an unwatched inbox.

In ACK mode, reading the mail does not complete it. The user chooses **Reply & acknowledge** or **Acknowledge without reply** in the inbox; an optional sent reply is retained as the completion record. Leaving the queue stops new assignments but keeps held jobs until acknowledged. User-held jobs are not automatically reclaimed or taken back by an agent. Non-ACK delivery follows the project's ordinary queue mode.

For the exact controls and project history views, see `orgtree-project-desk` (orgtree-app › desk). For agent mechanics, see [orgtree-projects](../../team/projects/SKILL.md); for coordination recipes, see `orgtree-concurrency-primitives` (orgtree-workflows › collaboration-patterns).

## See also

- [orgtree-tool-ask](../tool-ask/SKILL.md)
- [orgtree-tool-present](../tool-present/SKILL.md)
- [orgtree-tool-send-file](../tool-send-file/SKILL.md)
- [orgtree-docket-review-and-attention](../../docket/docket-review-and-attention/SKILL.md)
