---
name: orgtree-org-policies-mailbox
description: Explain the outside-mailbox modes (Org decides by default), the lockdown setting, the Hubchat warning and multiple-holder policy.
---

Up: [orgtree-org-settings](../SKILL.md)

# External org mailbox policy

**Org settings > Connections > External org mailbox** contains the outside-communication dropdown, the lockdown dropdown and the multiple-holder switch. They use the panel's automatic saving. Connections is available without a hub identity.

| Mode | Storage | Effect |
| --- | --- | --- |
| Org decides | org:org_inbox_mode=org | Default. The org mailbox holders choose open (Normal) or closed (default open); the row adds what is in force now, e.g. "Now closed (the org's choice)." Existing orgs start here with their earlier open/closed carried over as the org's choice. |
| Normal operations | org:org_inbox_mode=normal, legacy org:org_inbox_enabled=true | Retains incoming outside mail and delivers agent copies through normal routing. |
| Do not disturb | org:org_inbox_mode=dnd, legacy enabled=true | Accepts and retains outside mail without holder/fallback copies or agent wakes. Extern holders must extract it with orgtree_inbox action=pull. |
| Closed off mailbox | org:org_inbox_mode=closed, legacy enabled=false | Blocks new outside sends/receives and hides retained outside history/copies and the inbox node. Internal agent/user mail continues. |

DnD shows: **Hubchat and other outside messages are kept but not read or delivered automatically. An agent must check the org mailbox to receive them.** This includes the user's Hubchat messages; no sender is exempt. Already copied mail is not recalled; current turns continue. Authorized outgoing communication remains available in DnD.

Returning to Normal publishes unextracted mail once, oldest first, to current normal recipients within normal size/chunk budgets. Pulled items are not copied again. Human viewing/marking read does not extract a held item. Closed retains holds; reopening in DnD keeps them for pull, reopening in Normal releases them.

Setting the mode is the user's, through desktop HTTP settings or standalone user MCP orgtree_inbox action=configure mode=org|normal|dnd|closed. Under Org decides the holders open or close the mailbox with orgtree_lockdown action=outside; an explicit user value replaces the org's choice and agents can't change it until the user sets Org decides again. Do not disturb stays a user mode. Current extern holders can read action=settings. Invalid modes and conflicting mode/legacy boolean writes refuse. Legacy enable=true maps to Normal and false maps to Closed. Both keys remain org-local and portable through template settings.

**Lockdown** (Org decides by default, On, Off) is the user's say over the org mailbox lockdown, the last resort against a flood of new outside accounts: only listed `@net:` addresses reach the org mailbox while it is on. Under Org decides the holders turn it on and off and edit the list (`orgtree-tool-lockdown`, orgtree-working › mail); On forces it on (the user edits the list), Off forces it off. When the user turns it on (On, or Lock down now), the linked phone address from Connect your phone goes on the list as an ordinary entry the user can take off; it comes back at the user's next enable, and an agent's enable adds nothing. It saves at once and says what is in force ("Now on", "on some hubs only", "not yet on the hubs"). While the lockdown is in force (On, or Org decides while the org has it on), the lockdown section shows right below the setting, the same one as in the org mailbox's mailservers tab: a header with its state and, under Org decides, **Lift lockdown** / **Lock down now**; each hub's enforcement in plain words; **Allowed addresses**, the listed contacts under their hub in the same list as each hub's connections, each with a small × that takes it off; **Add** opens a searchable dropdown of the connected contacts not listed yet, and a choice adds it at once. There is no address box: an address that isn't a connected contact is added by an agent with the tool. Below the list, **Set aside mail from unlisted addresses** keeps such mail out of the agents' mail to read one at a time (otherwise it is refused), and **Show set-aside mail (N)** appears once some is set aside.

**Allow multiple org-mailbox audience holders** (org:org_inbox_multi_holder, default off) retains its boolean behavior. Turning it off with multiple live holders refuses: **revoke extra org-mailbox holders before disabling multi-holder mode**. It never chooses a survivor silently.

## See also

- `orgtree-org-mailbox` and `orgtree-tool-inbox` (orgtree-working › mail): authority, routing, extraction and continuations.
- [Connections](../../mailhub/org-connections/SKILL.md): identity and hub memberships.
- [History](../org-history/SKILL.md): retained history.
