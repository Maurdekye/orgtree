---
name: orgtree-tool-audience
description: Request, grant, deny or revoke directional Orgtree communication audiences beyond ordinary recipient reach.
---

Up: [orgtree-mail](../SKILL.md)

# orgtree_audience

Use when the missing permission is **who may communicate**, rather than a folder/tool grant. An audience lets the grantee write to the grantor; it is directional and does not change reporting lines, tool groups or file authority. Required tool group: `messaging`, inherited through the ancestor chain.

Ordinary [mail reach](../tool-message/SKILL.md) already includes direct superior, descendants and peers. Do not request an audience you already hold. `user` means direct access to the user; `extern` means the org inbox and outside `@org:`/`@net:` correspondence. These are different grants.

## Actions and arguments

| Action | Required fields | Optional fields and result |
| --- | --- | --- |
| `request` | `target`: agent, project, `user`, or `extern`. | `reason`, default empty; `from` may name a project you manage. Named agent/user decides directly; a project’s manager decides for it; an extern request goes to your top-level agent. The answer arrives as mail. |
| `grant` | `from`: grantee. | `target` is the grantor when not yourself; `reason` defaults empty. For `target: extern`, omitting from selects yourself. Handler also accepts `grantee` as a from alias, but prefer the schema's from field. |
| `deny` | `from`: pending requester. | Optional `target` selects a request; without it, the handler resolves pending requests from that requester that wait on you. |
| `revoke` | `grantee`: current holder. | Optional `target` names the grantor instead of you; from is accepted as a grantee alias. |

`action` is required. Public party spellings are `user`/`extern`; the engine also normalizes `@user`, `@extern`, `org-inbox` and `org_inbox`. Agent and project targets must be live. Reasons are explanatory text, not an authority source.

Minimal request:

```json
{"action":"request","target":"reviewer","reason":"I need to discuss the draft's edge cases directly."}
```

Send the request and end your turn if its answer blocks further work. Requests no longer climb the chain; `forward` is refused with that explanation.

## Who can grant

- With yourself: grant to a descendant, or to an agent whose audience request waits on you.
- With a live peer or your direct superior: grant to a descendant in your subtree.
- Between two direct tree siblings: their shared nearest agent superior may grant `from=A target=B`. This includes agents directly under one project. The grant permits A to write to B, including when their parent has turned peer mail OFF; a reverse route needs a separate audience.
- With `user`: only a top-level agent can grant this to its descendants. A top-level agent already has direct user access and need not request it.
- With `extern`: a top-level agent can grant to itself, descendants, or a live requester whose audience request waits on it, including one outside its subtree. A lower existing holder can pass extern only to descendants. A lower non-holder cannot grant itself outside access.

Requesting extern is refused if the org inbox is disabled. A top-level agent requesting extern is told to grant it to itself instead. Requesting yourself or an audience already held refuses. A repeat pending request updates its reason/time rather than requiring a forwarding chain.

Grants to a waiting requester resolve its request and wake it with the answer. Access notices describe the new permission. Permission can still be paused/revoked later; do not infer a permanent grant from old mail.

## Holder selection and revocation

In the default single-holder org-inbox mode, a new extern grant revokes previous holders. Multi-holder mode allows several. This consequence matters when assigning outside correspondence: an extern grant can replace someone else's routing role. Agents explain/suggest settings changes rather than changing the setting themselves.

You can revoke audiences with yourself, an extern holder can revoke its own extern access, and a top-level agent can revoke user/extern grants in its subtree. Other grants are not yours to rescind. Deny is for a pending request; revoke is for an existing grant. Neither deletes correspondence.

## Refusals to act on

Missing target/from/grantee fields are reported with the action that needs them. Other common refusals are no live named agent, self-request/self-grant, already-held audience, no request waiting on you, grantee outside the allowed relationship for that grant, non-top-level user grant, invalid grantor relationship, no current grant to revoke, or disabled outside inbox. Apply the pending-request exceptions above before treating an outside-subtree grantee as forbidden. Correct the relationship/party field or ask the actual holder; changing an audience is not a way to expand your own tools or settings authority.


## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents. It does not let B's agents write back. A reverse grant enables that reverse direction; with both grants, the two projects' direct agents may all correspond with one another. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agents below it, including nested agents, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

## See also

- [orgtree-mail-basics](../mail-basics/SKILL.md)
- [orgtree-chain-and-audiences](../chain-and-audiences/SKILL.md)
- [orgtree-external-mail](../external-mail/SKILL.md)
- [orgtree-org-inbox](../org-inbox/SKILL.md)

For suggested team patterns, see `orgtree-committee-mode` and `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).
