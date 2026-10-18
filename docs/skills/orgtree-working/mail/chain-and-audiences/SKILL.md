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

A live project can be the grantee or the named grantor of an audience. Its active, explicit grants are effective for its live **direct members only**. A nested project may itself inherit access, but never relays inherited grants: its members need that nested project's own explicit grant. Moving out, retirement, pause and revoke remove inherited access immediately; moving in gains it. Independent explicit grants remain in force. Chart and state inspection identify the source project.

Sending from either the project's default message box or its megaphone broadcast grants the project the user audience after a successful delivery. A post-delivery grant failure is reported explicitly as “delivered but audience grant failed”. System fair-queue nudges do not grant user access.

A project's nearest real-agent superior manages its requests and decisions; the user does so when none exists. Direct members cannot manage project grants. Request on a managed project's behalf with `action=request from=project-name target=agent-or-project`; a request to a project routes to its manager. Grant/deny/revoke accept project endpoints under the same actual-caller authority checks. The project context menu offers Acquire/Drop audience after Settings. Inherited-only access has no personal revoke button; change the source project's grant instead.

The org inbox/outside-mail audience remains agent-only and is not inherited from projects. The separate permission to present under one's own project includes nested members; it does not imply recursive audience inheritance.

## See also

- [orgtree-tool-audience](../tool-audience/SKILL.md)
- [orgtree-delegating](../../team/delegating/SKILL.md)
