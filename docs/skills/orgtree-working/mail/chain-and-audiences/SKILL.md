---
name: orgtree-chain-and-audiences
description: "Find the right communication route when reporting relationships or directional audiences determine access."
---

Up: [orgtree-mail](../SKILL.md)

# Choosing a communication route

Start with [ordinary recipient reach](../tool-message/SKILL.md): your direct superior, peers, and descendants are the normal routes. Being able to see an agent does not itself grant a communication audience. A more distant ancestor or an unrelated branch may need a grant before direct coordination.

An audience opens a direction of communication; it does not move an agent or delegate folder, tool or decision authority. A granted route is useful when a specialist needs to talk directly to a reviewer outside its reporting line. Keep the task owner and superior informed according to the assignment rather than treating a new route as a change of responsibility.

## Peer-mail setting

A visible reporting peer may be unreachable when the actual common parent's [peer-mail switch](../../team/peer-mail/SKILL.md) is OFF. The rule affects only direct tree siblings, applies equally under a manager or project, and requires a directional audience. Audience requests remain allowed; a shared nearest agent superior may grant between those direct siblings. A manager's switch does not propagate to deeper levels or to separate physical project groups.

## Request, decide, then use

If the route is missing, use [orgtree_audience](../tool-audience/SKILL.md). That page is the home for request/grant/deny/revoke parameters, pending-request exceptions, who may grant on whose behalf, and automatic reply audiences. Request only the route the work needs, with a reason the recipient can decide. End the turn if you cannot progress without the answer; an unanswered request is not a grant.

`user` and `extern` address different needs. The former concerns direct user contact; the latter concerns the organization inbox and outside correspondence. Read the tool's top-level rules before granting either. In particular, giving a new extern grant can replace another holder under single-holder routing. Coordinate the handoff rather than assuming both agents will receive future mail.

Use deny for an outstanding request and revoke for access already granted. Check current access when a route stops working; an earlier grant notice does not establish that it remains active. The audience tool's action rules cover the top-level waiting-requester exception as well as descendant-only cases; do not infer the rule merely from subtree membership.


## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents. It does not let B's agents write back. A reverse grant enables that reverse direction; with both grants, the two projects' direct agents may all correspond with one another. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agents below it, including nested agents, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

## See also

- [orgtree-tool-audience](../tool-audience/SKILL.md)
- [orgtree-delegating](../../team/delegating/SKILL.md)
