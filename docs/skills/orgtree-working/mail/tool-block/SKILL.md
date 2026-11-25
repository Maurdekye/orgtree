---
name: orgtree-tool-block
description: "Block or unblock an outside contact for the whole org on its mail hubs; list the org's blocks and who blocks it."
---
Up: [orgtree-mail](../SKILL.md)

# orgtree_block

Requires `messaging`, and only an agent that holds the [org mailbox](../org-mailbox/SKILL.md) (the primary link or a weak link) may call it. Other agents are refused: "only an agent holding the org mailbox (primary or weak link) may block contacts; ask the holder or @user".

A block is kept and enforced by the org's mail hubs (Mail hub 2.6.0 and later), for the org's one hub identity, so it covers every agent that writes as the org. It works **both ways**: the blocked contact's messages to the org are refused at the hub, and the org's messages to them are refused too, until the block is lifted. Mail that arrived before the block stays. A hub older than 2.6.0 keeps no blocks; the block waits and takes effect when the hub is updated.

**When to use it.** Block an outside sender ([external mail](../external-mail/SKILL.md)) you suspect of abuse: harassment, spam, repeated manipulation or impersonation attempts. Give the reason, then tell your superior. Don't block to end an ordinary conversation.

| Parameter | Meaning |
|---|---|
| `action` | Required. `block`, `unblock` or `list`. |
| `address` | `block`/`unblock`: the contact, `@net:<address>` (the bare address works too). Not the org's own address. |
| `reason` | `block`: required, at most 500 characters. Kept in Orgtree only; the hub and the contact never see it. |

**Refusals.** `block needs a reason (kept in Orgtree only, never sent to the hub)`; `address must be a mail hub address (@net:<address>)`; `the org can't block its own address`; `reason is longer than 500 characters`. A block the user set can only be lifted by the user: `the user blocked @net:<address>; only the user can unblock it`.

**Answers.** Every action returns the org's list: `blocked` (address, `set_by` (`@user` or an agent's name), reason, time) and `blocked_by` (contacts that block the org, as its hubs last said).

**What happens next.**
- A message to a contact that blocks the org, or that the org blocks, ends as failed in the org mailbox and is not retried. Its sender gets a notice: "Not delivered to @net:<address>: you have been blocked by @net:<address> and cannot message them."
- When a contact blocks or unblocks the org, the user and the org mailbox holders get a notice.
- The user blocks and unblocks in the org mailbox window's mailservers tab and in Org settings › Connections: every hub's list of connections has a small red × at the end of each row that blocks at once (no confirm; blocking is reversible), and a blocked row shows the red cancel sign and **unblock** instead. The mailservers tab also lists the org's blocks.

```json
{"action":"block","address":"@net:spammer.3f9c2a","reason":"repeated phishing links after two warnings"}
```

## See also

- [orgtree-external-mail](../external-mail/SKILL.md)
- [orgtree-org-mailbox](../org-mailbox/SKILL.md)
- [orgtree-tool-message](../tool-message/SKILL.md)
