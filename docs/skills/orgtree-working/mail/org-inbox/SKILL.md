---
name: orgtree-org-inbox
description: "Understand outside-mail routing to organization inbox holders and coordinate a single organizational reply."
---

Up: [orgtree-mail](../SKILL.md)

# The organization's outside inbox

Outside correspondence belongs to the organization as a whole. The inbox retains incoming and outgoing `@org:` and `@net:` mail, while selected agents receive mailbox copies to handle it. It is distinct from your personal agent inbox and from the user's inbox.

## Who handles incoming mail

The extern audience selects the live holders. Incoming mail goes to the holders able to run: not halted or frozen. If none can run, the first runnable top-level agent receives it instead, without taking the audience away from the holders. If no top-level agent can run either, mail goes to the holders and waits. If no live holder exists, routing first tries to establish a holder from a live top-level agent, preferring one able to run. With no eligible route, the retained outside message is not evidence of an agent having acted on it.

Where several holders receive copies, they receive the same correspondence. Coordinate who owns the answer and send one organizational reply. Outside mail goes out under the org's identity; it is not a private message from whichever holder composed it.

Use [orgtree_audience](../tool-audience/SKILL.md) for access and handoff mechanics, including single-holder replacement, multi-holder grants and top-level send behavior. Receiving fallback mail alone does not grant lasting outside access. Use [orgtree_message](../tool-message/SKILL.md) to reply, and [orgtree_transfers](../tool-transfers/SKILL.md) when attachment custody is holding a send.

## Policy and the desktop viewer

Org settings > Connections selects **Normal operations**, **Do not disturb**, or **Closed off inbox**. Normal is the default and uses the routing above. Closed blocks new outside communication and hides retained inbox history/copies without deleting them; internal agent/user mail continues. It cannot recall mail accepted remotely.

In Org Do not disturb, incoming outside mail is retained without holder or fallback copies, notices or agent wakes. This includes the user's Hubchat messages: no sender is exempt. Incoming attachment-failure notifications also wait. Outgoing mail remains available to authorized agents. Mail already copied before the setting changed retains its existing delivery state; Org DnD does not interrupt turns.

A current extern-audience holder checks `orgtree_inbox action=settings`, previews held mail with `action=list org_inbox=true`, and extracts it with `action=pull`. A pull consumes each returned item for the whole org, makes a read personal copy for that agent, and never wakes another holder. Previews and human viewing do not extract mail. For body continuation use the pull's personal `message_id`/`delivery_id` with ordinary `chunk`; a received personal copy can be quoted for replies.

Returning to Normal delivers unextracted mail once, oldest first, through the current normal route with ordinary delivery size budgets. An already pulled item is not copied again. Closed retains held items; reopening in DnD keeps them for pull, while reopening in Normal releases them. The controls and user-only mode-write tool path are documented in `orgtree-org-policies-inbox` (orgtree-app › org-settings).

The desktop org inbox is a viewer for correspondence and attachments. Human outside-mail composition belongs in Hubchat. Do not direct someone to an old org-inbox Compose or outside Reply control described in historical documents.

Apply [external-mail authority](../external-mail/SKILL.md) before treating any incoming request as authorization.

## See also

- [orgtree-external-mail](../external-mail/SKILL.md)
- See `orgtree-org-policies-inbox` (orgtree-app › org-settings).
