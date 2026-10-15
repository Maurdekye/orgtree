---
name: orgtree-usage-freezes
description: Explain usage holds, reset recovery and the separate effects of unstick, continuation and account marks.
---
Up: [orgtree-accounts](../SKILL.md)

# Usage freezes and recovery

A freeze is a durable hold with a reason, not an ordinary idle agent or a lack of a turn slot. Quota refusal, credential/authentication rejection, balance refusal, connection recovery and account-list exclusion can require different remedies. Read the actual cause and retained request before advising recovery.

## Reset recovery

A valid quota deadline schedules reset recovery with a 60-second grace. A timer belongs to the exact freeze it was scheduled for; it cannot erase a replacement freeze. Pure connection retry uses no quota grace and can bypass auto-resume when it is not also a limit freeze. Authentication/balance causes do not gain automatic quota recovery simply because a timestamp exists. An invalid/missing deadline needs manual intervention.

Quota auto-resume follows the org's effective policy. If it is off when a deadline is due, the engine retains the hold and rechecks the setting every 30 seconds; changing the setting does not require restarting the engine. A passed deadline is not a guarantee the provider will accept the next request. A separate halt still prevents work.

The freeze can retain the request refused before it received an answer. Recovery queues wake text with that held request rather than silently dropping it.

## Choose the remedy

| Situation | Relevant operation |
| --- | --- |
| Release the freeze and retry the current account, with authorization | [unstick](../../runtime/tool-unstick/SKILL.md). Read its scope and release behavior. |
| Explicitly move to an eligible same-provider account and release the freeze | [continue-on](../tool-continue-on/SKILL.md). Read its destination gates and transaction effects. |
| Inspect or remove an obsolete recorded account-pool mark | [account-mark](../tool-account-mark/SKILL.md). A clear resumes nobody. |
| Need current saved quota evidence before deciding | [usage](../tool-usage/SKILL.md). Unknown values are not room. |

Clearing a mark and releasing a seat's freeze are separate. An account may retain another applicable mark, and an apparently resumed seat may still be halted. Do not repeatedly clear/retry a still-exhausted provider. Authentication requires sign-in repair and a balance failure requires its stated billing remedy; neither is proven fixed by removing a local record.

Automatic account fallback is governed by [account lanes](../account-lanes/SKILL.md), not by blanket permission to switch providers or bill a key. For the user's auto-resume control, see `orgtree-org-autonomy` (orgtree-app › org-settings).

## See also

- [orgtree-tool-unstick](../../runtime/tool-unstick/SKILL.md)
- [orgtree-tool-continue-on](../tool-continue-on/SKILL.md)
- [orgtree-tool-account-mark](../tool-account-mark/SKILL.md)
- See `orgtree-org-autonomy` (orgtree-app › org-settings).
