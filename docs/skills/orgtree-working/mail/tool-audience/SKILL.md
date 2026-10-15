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
| `request` | `target`: agent, `user`, or `extern`. | `reason`, default empty. Named agent/user decides directly; an extern request goes to your top-level agent. The answer arrives as mail. |
| `grant` | `from`: grantee. | `target` is the grantor when not yourself; `reason` defaults empty. For `target: extern`, omitting from selects yourself. Handler also accepts `grantee` as a from alias, but prefer the schema's from field. |
| `deny` | `from`: pending requester. | Optional `target` selects a request; without it, the handler resolves pending requests from that requester that wait on you. |
| `revoke` | `grantee`: current holder. | Optional `target` names the grantor instead of you; from is accepted as a grantee alias. |

`action` is required. Public party spellings are `user`/`extern`; the engine also normalizes `@user`, `@extern`, `org-inbox` and `org_inbox`. Agent targets must be live. Reasons are explanatory text, not an authority source.

Minimal request:

```json
{"action":"request","target":"reviewer","reason":"I need to discuss the draft's edge cases directly."}
```

Send the request and end your turn if its answer blocks further work. Requests no longer climb the chain; `forward` is refused with that explanation.

## Who can grant

- With yourself: grant to a descendant, or to an agent whose audience request waits on you.
- With a live peer or your direct superior: grant to a descendant in your subtree.
- With `user`: only a top-level agent can grant this to its descendants. A top-level agent already has direct user access and need not request it.
- With `extern`: a top-level agent can grant to itself or eligible agents below it; an existing holder can pass it to descendants. A lower non-holder cannot grant itself outside access.

Requesting extern is refused if the org inbox is disabled. A top-level agent requesting extern is told to grant it to itself instead. Requesting yourself or an audience already held refuses. A repeat pending request updates its reason/time rather than requiring a forwarding chain.

Grants to a waiting requester resolve its request and wake it with the answer. Access notices describe the new permission. Permission can still be paused/revoked later; do not infer a permanent grant from old mail.

## Holder selection and revocation

In the default single-holder org-inbox mode, a new extern grant revokes previous holders. Multi-holder mode allows several. This consequence matters when assigning outside correspondence: an extern grant can replace someone else's routing role. Agents explain/suggest settings changes rather than changing the setting themselves.

You can revoke audiences with yourself, an extern holder can revoke its own extern access, and a top-level agent can revoke user/extern grants in its subtree. Other grants are not yours to rescind. Deny is for a pending request; revoke is for an existing grant. Neither deletes correspondence.

## Refusals to act on

Missing target/from/grantee fields are reported with the action that needs them. Other common refusals are no live named agent, self-request/self-grant, already-held audience, no request waiting on you, grantee outside your subtree, non-top-level user grant, invalid grantor relationship, no current grant to revoke, or disabled outside inbox. Correct the relationship/party field or ask the actual holder; changing an audience is not a way to expand your own tools or settings authority.
