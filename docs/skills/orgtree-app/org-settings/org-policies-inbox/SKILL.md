---
name: orgtree-org-policies-inbox
description: Explain the org's outside-mail enable switch and multiple-holder policy.
---

Up: [orgtree-org-settings](../SKILL.md)

# External org inbox policy

**Org settings > Policies > External org inbox** holds two org boolean
settings. Agents explain them; the user changes them with the shared footer
Save in [orgtree-org-basic](../org-basic/SKILL.md).

| Switch | Storage key | Default | Effect |
| --- | --- | --- | --- |
| allow outside communication through the org inbox | `org:org_inbox_enabled` | On | Off blocks communication to/from other orgs and mail-hub peers, hides the org-inbox node and makes outside-mail history unavailable. Same-org mail continues. |
| allow multiple org-inbox audience holders | `org:org_inbox_multi_holder` | Off | Off gives one holder at a time; granting another holder moves the audience. On permits multiple holders. |

Disabling access is an isolation policy, not deletion of recorded outside mail.
Turning it back on restores access under the org's current routing and audience
rules. A disabled outside path refuses with **the organization's inbox is
disabled; outside communication and its history are unavailable**. The org
history browser omits its Organization mail collection while access is off.

Turning multi-holder off while more than one live holder remains is refused:
**revoke extra org-inbox holders before disabling multi-holder mode**. First
choose the remaining holder and revoke the others, then save again. The
setting does not silently select a survivor. Both switches reject values that
are not booleans.

Suggest disabling outside access when the user wants this org isolated from
external peers. Suggest multi-holder when the user intends shared outside-mail
handling and understands its routing. Audience eligibility, delivery/fallback
and communication authority belong in `orgtree-org-inbox`
(orgtree-working > mail); these toggles do not authorize arbitrary external
senders to act for the user.

## See also

- `orgtree-org-inbox` (orgtree-working > mail).
- [orgtree-org-connections](../../mailhub/org-connections/SKILL.md).
- [orgtree-org-history](../org-history/SKILL.md).
