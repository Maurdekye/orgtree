---
name: orgtree-org-policies-inbox
description: Explain three outside-inbox modes, the Hubchat warning and multiple-holder policy.
---

Up: [orgtree-org-settings](../SKILL.md)

# External org inbox policy

**Org settings > Connections > External org inbox** contains the outside-communication dropdown and multiple-holder switch. They use the panel's shared **Save** button. Connections is available without a hub identity.

| Mode | Storage | Effect |
| --- | --- | --- |
| Normal operations | org:org_inbox_mode=normal, legacy org:org_inbox_enabled=true | Default. Retains incoming outside mail and delivers agent copies through normal routing. |
| Do not disturb | org:org_inbox_mode=dnd, legacy enabled=true | Accepts and retains outside mail without holder/fallback copies or agent wakes. Extern holders must extract it with orgtree_inbox action=pull. |
| Closed off inbox | org:org_inbox_mode=closed, legacy enabled=false | Blocks new outside sends/receives and hides retained outside history/copies and the inbox node. Internal agent/user mail continues. |

DnD shows: **Hubchat and other outside messages are kept but not read or delivered automatically. An agent must check the org inbox to receive them.** This includes the user's Hubchat messages; no sender is exempt. Already copied mail is not recalled; current turns continue. Authorized outgoing communication remains available in DnD.

Returning to Normal publishes unextracted mail once, oldest first, to current normal recipients within normal size/chunk budgets. Pulled items are not copied again. Human viewing/marking read does not extract a held item. Closed retains holds; reopening in DnD keeps them for pull, reopening in Normal releases them.

Mode writes are **user-only**, through desktop HTTP settings or standalone user MCP orgtree_inbox action=configure mode=normal|dnd|closed. Current extern holders can read action=settings; agents cannot configure regardless of rank/audience. Ask a superior or the user. Invalid modes and conflicting mode/legacy boolean writes refuse. Legacy enable=true maps to Normal and false maps to Closed. Both keys remain org-local and portable through template settings.

**allow multiple org-inbox audience holders** (org:org_inbox_multi_holder, default off) retains its boolean behavior. Turning it off with multiple live holders refuses: **revoke extra org-inbox holders before disabling multi-holder mode**. It never chooses a survivor silently.

## See also

- `orgtree-org-inbox` and `orgtree-tool-inbox` (orgtree-working › mail): authority, routing, extraction and continuations.
- [Connections](../../mailhub/org-connections/SKILL.md): identity and hub memberships.
- [History](../org-history/SKILL.md): retained history.
