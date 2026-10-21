---
name: orgtree-accounts-registry
description: Explain account activation, supported add paths, removal and the clear-capacity-mark dialog.
---
Up: [orgtree-providers](../SKILL.md)

# Account registry and dialogs

The Providers account list identifies each login/key with its account label/identity and tint, sign-in standing, Active state, bound-agent count and management controls. Native/default rows and registered rows are distinct; a native profile cannot be removed.

## Active and account identity

Registered Active is app-wide `accounts/{id}/enabled`, default active for a new account. Inactive rows remain stored and inspectable but do not serve inference/fallback; an affected agent can wait at its next admission. Native Active is the subscription-inference control, whose home is [API-key fallback and subscription inference](../api-key-fallback/SKILL.md). Org allowlists are another layer.

Account refresh checks the selected row's identity. Sign-in, where supported, addresses its own managed/imported profile. A bound-agent count identifies impact, not extra permission to remove the login. No OS elevation or whole-app restart is inherent in Active.

## Add account

The dialog supplies independent paths rather than converting a subscription into a key:

| Path | Fields and effect |
| --- | --- |
| Create managed account | Creates a separate profile, then the user signs in. No existing login is assumed. |
| Import folder | Profile-folder path typed or chosen with Browse; uses that existing provider profile. Available for supported Claude/Codex paths, not Muse. |
| Use API key | Required secret key; bills that provider's API credits. Offered independently of a working subscription. |

Google's dialog explains the measured Antigravity CLI 1.3.5 limit: one Google
sign-in per Windows user in Credential Manager, even with different profile
folders. A second sign-in would replace the default for all agents. It offers
an API key and links upstream account-profile support, with no second
subscription terminal or managed/import path. Existing registered Google
subscription rows run only when their silent identity check proves a distinct
login; otherwise they fail closed rather than using the default credentials.
Their usage and admission checks use their own quota reading. See
[Antigravity accounts](../../harnesses/harness-antigravity/SKILL.md#registered-accounts-and-the-windows-sign-in-limit).
Muse manages separate config/data roots and refuses an imported-folder shortcut.
Busy submissions prevent another create/close operation; errors stay in the dialog.
Verified 2026-10-21 at `2ec8c0e`: `canvas/accountsregistry.tsx`,
`providers/agy_auth.rs`, `usage/agy_reading_tests.rs`.

Keys belong in the password control, never in an agent prompt. Adding a key is not enabling automatic paid fallback. See the separate fallback control before advising on billing behavior.

## Remove

Remove is available for registered rows even with bound agents; it is disabled for a native/default row. It is consequential: the engine reassigns bindings/queued intents/defaults or leaves an agent frozen when no eligible destination can run its model. Muse tries eligible model-entitled subscription replacements and can refuse to invent entitlement. The toast reports moved/frozen outcomes. Suggest removal only if the user intends those consequences, not to refresh a stale status.

## Clear capacity mark dialog

The account row lists active pool marks, reset, inferred/observed provenance and age. “clear…” opens an exact account/pool confirmation with a reason, companion effect and consequence text. If the stored mark changed, nothing is cleared and the dialog displays the updated state for reconsideration.

Clear adds no capacity and resumes no agent. For the exact fingerprint, companion and audit behavior see `orgtree-tool-account-mark` (orgtree-working › accounts). Use the dialog to explain the user's control; do not repeat its mechanics as a different recovery rule.

## See also

- See `orgtree-account-lanes` (orgtree-working › accounts).
- See `orgtree-tool-account-mark` (orgtree-working › accounts).
