---
name: orgtree-agent-account-tab
description: Explain an agent's account binding and automatic fallback override.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Account and switch-when-limited controls

These controls are in the Model tab. They apply to the selected agent. Agents explain or suggest settings changes; they do not change settings themselves.

## Account

**Account** is `node:account`, stored as the agent's binding. The selector appears for Claude, Codex, Antigravity and Muse. It starts from the current binding; an empty/inherited binding displays the provider's default login without silently rewriting the saved value. Default login is selectable even without a registered-account row. Account identity text distinguishes the login; unavailable identity is not invented.

A vanished saved account remains visible as unavailable. If only one replacement exists, **Use …** explicitly selects it. The mere opening or saving of an unchanged selector does not silently rebind it. Muse choices additionally reflect which logins offer the selected model; an unknown or stale eligibility answer still requires engine validation.

A queued account change is shown as the selected target. To cancel it, choose
the account currently serving the agent again, then Save (settings) or Apply
(desk model picker). This submits the existing account cancellation request;
the next-turn account card clears on the engine update. Saving an untouched
selector preserves the queue.

Changing providers updates the form's account choice for the new provider. On Save a model switch and its account travel together; an account-only edit uses account assignment before the scope save. A busy assignment is queued for the turn boundary. A direct idle rebind validates the account and marks the process for reconfiguration. It refuses a genuine usage-limit freeze: releasing that freeze requires the continuation/recovery workflow, not an account selector used as an unlock.

An account change creates a new cache namespace; account and provider session behavior is harness-specific. Do not promise that a displayed subscription login is free of limits or that a manual binding will be balanced onto another login automatically. See `orgtree-account-lanes` (orgtree-working › accounts) for account gates, billing, manual choices and continuation behavior.

Suggest a binding change when the user intends to move this agent to another allowed login, or to repair a missing binding. Explain any metered billing and session consequences before suggesting a different auth lane.

## Switch accounts when limited

This selector is `node:account_fallback`, an optional boolean in scope:

| Choice | Stored meaning |
|---|---|
| Org default (on/off) | Remove the override and follow `account_fallback_default`. The built-in org default is off. |
| On | Explicitly enable fallback for this agent, subject to provider and candidate gates. |
| Off | Explicitly disable fallback for this agent, regardless of the org default. |

Leaving the selector unedited sends no fallback change. Selecting Org default explicitly clears the override. The control is enabled for Claude, Codex and Muse; it is disabled for other providers with an unsupported message. The Codex hint warns of a new conversation on switching; Muse's hint requires the exact model and available room and names a new Muse session. Candidate selection and API-key fallback policy belong to `orgtree-account-lanes` (orgtree-working › accounts).

Suggest On only when the user wants automatic continuation across eligible accounts after limits. Suggest Off when a deliberate binding or usage policy should keep the agent waiting on its assigned account. A standing fallback-off instruction is not permission to turn it on.

## See also

- `orgtree-account-lanes` (orgtree-working › accounts).
- [orgtree-agent-model-tab](../agent-model-tab/SKILL.md).
- [orgtree-org-autonomy](../../org-settings/org-autonomy/SKILL.md).
