---
name: orgtree-org-autonomy
description: Explain usage-limit account fallback, automatic reset resume and resume now.
---

Up: [orgtree-org-settings](../SKILL.md)

# Autonomy

**Org settings > Autonomy > Usage-limit freezes** contains two org settings
and a manual action. They apply **immediately**, independently of the footer
Save. Agents explain and suggest; the user changes them.

| Control | Storage key | Engine default | Effect |
| --- | --- | --- | --- |
| automatically switch accounts after a usage limit | `org:account_fallback_default` | Off | Org default for automatic fallback. Each agent can override on/off or inherit. Another eligible account in the same provider lane may be selected and retained. |
| auto-resume frozen agents when the usage limit resets | `org:auto_resume` | On | Allows scheduled usage-limit resumes one minute after the reported reset. |

These defaults apply in the absence of app/org overrides. In particular,
the UI uses false when an auto-resume field is missing, but the engine default
and timer fallback are **true**. Read the loaded effective value.

Fallback still respects org account eligibility, active/provider switches,
the seat's model entitlement and capacity rules. It is not permission to
switch provider or to use a metered API key contrary to its separate fallback
setting. See `orgtree-usage-freezes` (orgtree-working › accounts) for the
selection and continuation contract.

Automatic resume requires a usable deadline. Unknown reset times are not
invented. A due usage freeze waits while auto-resume is off; the timer rechecks
that gate every 30 seconds, so turning it on does not require an app restart.
Pure connection-retry freezes bypass this usage-limit switch. A stale timer
does not clear a newer freeze. Both settings accept booleans only.

## Resume now

When live agents are frozen, **resume N frozen agents now** lists their names
in its tooltip. It manually clears their freezes without waiting for the
reported reset and reports the resumed count. Retired agents are excluded.
When none qualifies the tab says **no agents are frozen right now**. The
action does not turn auto-resume on, guarantee provider capacity, or remove
other stop conditions such as halt; a provider may limit the next attempt again.

Suggest fallback only when the user wants eligible account changes after a
limit. Suggest auto-resume when the user wants unattended continuation at a
reported reset; off when resumption should remain a manual choice. Suggest
resume now when the user knows a freeze can be retried earlier, explaining
that a clear is not proof of recovered quota.

## See also

- `orgtree-usage-freezes` (orgtree-working › accounts).
- [orgtree-org-accounts](../org-accounts/SKILL.md).
