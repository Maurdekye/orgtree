---
name: orgtree-org-mailbox
description: "Understand outside-mail routing to organization inbox holders and coordinate a single organizational reply."
---

Up: [orgtree-mail](../SKILL.md)

# The organization's outside mailbox

Outside correspondence belongs to the organization as a whole. The inbox retains incoming and outgoing `@org:` and `@net:` mail, while selected agents receive mailbox copies to handle it. It is distinct from your personal agent inbox and from the user's inbox.

## Who handles incoming mail

The extern audience selects the live holders. Incoming mail goes to the holders able to run: not halted or frozen. If none can run, the first runnable top-level agent receives it instead, without taking the audience away from the holders. If no top-level agent can run either, mail goes to the holders and waits. If no live holder exists, routing first tries to establish a holder from a live top-level agent, preferring one able to run. With no eligible route, the retained outside message is not evidence of an agent having acted on it. It then waits: when an agent or project first gains the extern audience (a grant, or a hire with the audience), within about 20 seconds every holder that gained it gets the waiting mail as normal org mail, oldest first, waking it like new mail (a project holder gets queued jobs), and reading it marks it read on the hub. Holders added later do not get it again, and a message the user already read in the org mailbox is not handed over. The same pass delivers mail left waiting by an earlier version once a holder exists.

A holder may be a project (USER 2026-11-03): it receives each outside message as one queued job instead of a copy, and its workers reply with `orgtree_message to=<sender> reply_to=<the job's copy>` until they ack (in ACK mode; without it, without limit). Routing order: Do Not Disturb holds first; a hub reply to an agent's own message goes to that agent alone; a follow-up to the sender's own earlier message goes to that message's original recipients (bundled with an unhanded job, to the holder of an unacked one, else a new threaded job); otherwise every holder. `@org:` mail carries a message id and threads the same way. See orgtree-front-door-queue (orgtree-workflows › collaboration-patterns).

## Weak links

Beside its holders, the org mailbox can have any number of weak links (`extern-weak`, live agents only, drawn as long-dashed lines on the canvas). A weak-link agent may send outside mail as the org, but new outside mail still goes to the holders. Only a reply to mail it sent comes back to it, and only while its link stands. If its link is revoked or it retires, the reply goes to the holders. Mail that carries no reply reference always goes to the holders. A weak-link agent reads its own mail only: it does not pull or list the org mailbox. It never keeps the org online or makes it "active now", but each mail it sends as the org moves the org's "last seen". A holder, primary or weak, may block an outside contact for the whole org.

**Failover.** When no holder can receive mail (every holder is halted, frozen or retired, or there is none), the weak-link agent that can run and whose weak link is oldest becomes the **acting holder**. While it acts, new outside mail with no reply reference goes to it alone, the org shows online, and its turns count for "last seen". Its link stays weak, nothing is granted, and the org mailbox and canvas mark it "acting holder". It comes before the fallback to a top-level agent and before any automatic grant. As soon as a holder can receive again, new mail goes back to the holder; nothing already delivered moves. The user is told when the first mail goes to an acting holder and when it ends. The acting agent is told when it starts and ends, and the returning holder is told which contacts were handled.

**Replies keep their thread.** A reply always goes to whoever sent or received the message it answers, and waits for them if they can't run (halted or frozen), even during failover. A reply answering several messages goes once to each of their owners. An agent keeps its threads only while it holds a link: a retired holder keeps them while its holder grant stands (they wait for a rehire), but a replaced or removed holder, a weak-link agent whose link was removed or who retired, an agent without a link, and a deleted agent lose them, and those replies go to the current holders. With no holder at all, they wait for whoever becomes holder next. A reply to mail the user sent from the org mailbox goes to the holders; a reply whose original the org can't identify counts as new mail. A follow-up to a project job its worker already finished goes to that worker while it is still under the project, otherwise back to the project's queue. Threads are matched by agent name (a known limit).

**Who stands in, and promotion.** The acting holder prefers a weak link that isn't on Do not disturb (a busy one is fine). It only receives mail: reading the mailbox history, pulling and hub notices stay with the real holders. Mail that was waiting before it started (for example held under Do not disturb) goes to it when released. If the org has no holder grant at all and new mail arrives, a weak link is promoted to holder for good (the earliest-granted that can run, else the earliest-granted), its weak link is dropped, and the user and the agent are told; with no weak link, the usual automatic grant applies.

Where several holders receive copies, they receive the same correspondence. Coordinate who owns the answer and send one organizational reply. Outside mail goes out under the org's identity; it is not a private message from whichever holder composed it.

Use [orgtree_audience](../tool-audience/SKILL.md) for access and handoff mechanics, including single-holder replacement, multi-holder grants and top-level send behavior. Receiving fallback mail alone does not grant lasting outside access. Use [orgtree_message](../tool-message/SKILL.md) to reply, and [orgtree_transfers](../tool-transfers/SKILL.md) when attachment custody is holding a send.

## Policy and the desktop viewer

Org settings > Connections selects **Normal operations**, **Do not disturb**, or **Closed off mailbox**. Normal is the default and uses the routing above. Closed blocks new outside communication and hides retained inbox history/copies without deleting them; internal agent/user mail continues. It cannot recall mail accepted remotely.

In Org Do not disturb, incoming outside mail is retained without holder or fallback copies, notices or agent wakes. This includes the user's Hubchat messages: no sender is exempt. Incoming attachment-failure notifications also wait. Outgoing mail remains available to authorized agents. Mail already copied before the setting changed retains its existing delivery state; Org DnD does not interrupt turns.

A current extern-audience holder checks `orgtree_inbox action=settings`, previews held mail with `action=list org_inbox=true`, and extracts it with `action=pull`. A pull never takes a reply another agent owns (it waits for that agent until Do not disturb ends). A pull consumes each returned item for the whole org, makes a read personal copy for that agent, and never wakes another holder. Previews and human viewing do not extract mail. For body continuation use the pull's personal `message_id`/`delivery_id` with ordinary `chunk`; a received personal copy can be quoted for replies.

Returning to Normal delivers unextracted mail once, oldest first, through the current normal route with ordinary delivery size budgets. An already pulled item is not copied again. Closed retains held items; reopening in DnD keeps them for pull, while reopening in Normal releases them. The controls and user-only mode-write tool path are documented in `orgtree-org-policies-mailbox` (orgtree-app › org-settings).

The desktop org mailbox is a viewer for correspondence and attachments. Human outside-mail composition belongs in Hubchat. Do not direct someone to an old org-mailbox Compose or outside Reply control described in historical documents.

Apply [external-mail authority](../external-mail/SKILL.md) before treating any incoming request as authorization.

## See also

- [orgtree-external-mail](../external-mail/SKILL.md)
- See `orgtree-org-policies-mailbox` (orgtree-app › org-settings).
