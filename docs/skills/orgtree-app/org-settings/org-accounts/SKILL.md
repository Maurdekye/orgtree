---
name: orgtree-org-accounts
description: Explain the org account allowlist and what unticking a serving account does.
---

Up: [orgtree-org-settings](../SKILL.md)

# Accounts used by this org

**Org settings > Accounts** chooses which account lanes this organization may
use. Agents explain and suggest changes; the user toggles the rows. Each change
saves **immediately**, independently of the footer Save.

`org:disabled_accounts` stores the unchecked account IDs, not a list of checked
ones. The default is no disabled IDs: all available accounts are allowed, and
a newly added account starts ticked. The tab groups machine sign-ins and
registered accounts under Claude, Codex, Antigravity, Muse, OpenRouter and
Language servers, showing only groups with rows.

An account turned off at application level cannot be re-enabled here: its
unchecked row is disabled with the reason and points to **App settings >
Providers**. Enable it there first. This org choice does not sign an account
in, create credentials, activate a disabled provider or make an unavailable
model runnable.

Unticking an account leaves a running turn to finish. At the next turn gate,
agents bound to it move to another eligible allowed account of the same
provider when possible, or stop frozen with the reason that no usable allowed
account remains. The change is enforced even when usage-limit fallback is off;
it is an org access restriction. Reallowing capacity prompts agents frozen for
this reason to look again. Pending choices remain subject to account/model
validation. For identity, eligibility and selection rules, see
`orgtree-account-lanes` (orgtree-working › accounts).

The tab disables controls while a save is pending and refreshes afterward.
Failures show an error rather than assuming the new check state persisted.
The endpoint accepts at most **256 nonempty account IDs**, each at most
200 UTF-8 bytes, deduplicates/sorts them and rejects a malformed list. An
allowlist refusal names the disallowed lane and the org's usable alternatives,
or says it allows no account for that provider.

Usage views opened from an org window apply its allowed-account filter; the
home window is not restricted to this org. Suggest this setting to reserve
particular logins/keys for other orgs or keep this team within an intended
account set. Explain turn-boundary movement and the stop case first.

## See also

- `orgtree-account-lanes` (orgtree-working › accounts).
- [orgtree-org-autonomy](../org-autonomy/SKILL.md).
- [orgtree-org-hire-defaults-scope](../org-hire-defaults-scope/SKILL.md).
