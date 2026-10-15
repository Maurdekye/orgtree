---
name: orgtree-org-hire-defaults-scope
description: Explain future hires' visibility, access mode and default account choices.
---

Up: [orgtree-org-settings](../SKILL.md)

# Hire-default scope and account

**Org settings > Hire defaults > Scope** supplies starting choices for future
hires. Existing agents retain their own settings. The user changes these
controls; agents explain and suggest. Edits join the footer Save described in
[orgtree-org-basic](../org-basic/SKILL.md).

| Control | Org key | Engine default | Choices |
| --- | --- | --- | --- |
| Visible agents | `org:default_visibility` | `subtree` | `self` = Only this agent; `team` = Its team; `subtree` = Its team and all reports; `full` = Everyone. |
| File and command access | `org:permission_mode` | `acceptEdits` | `plan` = Read only; `default` = Ask before changes; `acceptEdits` = Allow normal changes; `bypassPermissions` = Unrestricted access. |
| Provider / Account | `org:default_account` | No explicit binding (`null`; form uses empty string) | Provider chooses the account family; Account chooses the starting binding, subject to eligibility. |

The engine fills these defaults after application and org overrides. The UI
uses **full** if visibility is absent from a payload; that loading/missing-data
fallback does not change the engine's **subtree** default. Invalid visibility
or permission names are refused. Visibility semantics and inherited ceilings
are defined in `orgtree-visibility` and `orgtree-scope-and-permissions`
(orgtree-working > team).

The Provider selector offers Claude, Codex, Antigravity and Muse. Choosing one
sets its primary account as the candidate default. Account rows identify the
machine login and registered accounts; accounts unchecked in this org's
Accounts tab are ineligible. **Use machine default** clears the explicit org
choice so the hire's own default applies. Existing agents keep their account.
A nonexistent registered account or an org-restricted key from another org is
refused on save. Hiring still validates whether the chosen account can run the
selected model; an unsuitable org default is not an entitlement to that model.

Permission mode changes the starting approval policy; it is distinct from the
folder holdings and tool switches. Unrestricted access removes approval
prompts, including the sensitive shared-skill-file prompt. Saving an edited
Hire defaults tab also submits permission/folder fields and reconfigures org
processes, even though existing agents' saved modes are retained.

Suggest narrower starting visibility or access when the user wants new agents
to start with less scope. Suggest an account default when future hires should
prefer a particular allowed login. For account identity and selection, see
`orgtree-account-lanes` (orgtree-working > accounts).

## See also

- `orgtree-visibility` (orgtree-working > team).
- `orgtree-account-lanes` (orgtree-working > accounts).
- [orgtree-org-accounts](../org-accounts/SKILL.md).
- [orgtree-org-hire-defaults-folders](../org-hire-defaults-folders/SKILL.md).
