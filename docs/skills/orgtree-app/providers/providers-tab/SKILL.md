---
name: orgtree-providers-tab
description: Explain provider installation, sign-in status, enablement and the legacy-model display setting.
---
Up: [orgtree-providers](../SKILL.md)

# Providers tab

App settings → Providers groups Claude/Claude Code, ChatGPT/Codex, Gemini/Antigravity, Muse/Muse Code, plus OpenRouter and Language model server. Each native row shows installation/connection status and any reported version, identity, sign-in kind/source, path, reason and tier seats. “Installed” is executable discovery, not sign-in or model entitlement.

## Enabled

The app-wide provider Enabled control uses the provider-enabled endpoint and defaults on when no value is saved. It controls whether the lane is offered for hiring; runtime eligibility also checks it. Turning it off can prevent future turns on that lane. This is separate from individual account Active and org account allowlists.

There is no UAC/app restart built into this provider toggle. It can change which tasks/accounts are eligible; suggest it only when the user intends to enable/disable that provider. Agents explain these controls and do not operate them themselves.

## Sign-in and Refresh

Refresh immediately requests a new engine discovery/sign-in check instead of just reading the five-minute periodic snapshot. It uses the same checks as periodic discovery, with one check in flight; overlapping calls and repeated clicks within two seconds of completion reuse that result. The previous result stays visible while loading; a status error is not proof credentials disappeared. A missing executable offers its official download guidance.

Available native sign-in controls use the desktop bridge: Claude can request a pasted verification code; Codex uses its browser flow. Antigravity/Muse open a terminal, then tell the user to sign in there and refresh. “Terminal opened” does not verify success. A browser-only client has no native sign-in bridge. Registered-account sign-in targets that row's profile; see [accounts registry](../accounts-registry/SKILL.md).

The default Codex account also offers **Sign in** (or **Sign in again** when connected), using Codex's existing browser flow and default profile. Post-login verification refreshes that provider's status without probing unrelated providers. The button does not sign in by itself: the user completes the provider's browser authorization.

For agent tool parity, `orgtree_list_tiers` with `refresh: true` requests the same bounded provider discovery; it needs inspection and runtime permission and still returns tier/seat information. This differs from `orgtree_usage` account usage refresh. Sign-in reuses the existing desktop/CLI login action rather than granting an agent new authentication authority; an agent should ask the user to complete the browser flow.

Do not paste secrets into chat or treat provider Refresh as a model inference test. Consult the actual discovery result when a tier is unavailable.

An unavailable authentication probe is distinct from a confirmed signed-out
reply. Keep its actual reason; repeated Refresh is not evidence that an account
lost credentials. Known signed-out model choices can remain visible in a draft
preview so the user can choose before signing in, but creating/running a seat
still passes engine eligibility checks. Hire, desk and settings model menus
share org account restrictions and installed-harness eligibility; an eligible
profile can differ from the ambient account. Verified at `2ec8c0e`:
`providers/mod.rs`, `providers/agy_auth.rs`, `canvas/staffingoptions.ts`,
`canvas/shared.ts` and `canvas/modals.tsx`.

## Legacy models

“show legacy models (Terra, Gemini Pro)” is a renderer localStorage preference `orgtree-show-legacy-models`, default off. It changes hire/model chooser and tier-list visibility. Existing agents on those models retain their model and remain visible either way. It does not buy entitlement, change runtime credentials, restart the app or alter a model's price.

Suggest enabling it only to expose a deliberately requested legacy choice. The account and catalog must still offer that choice.

## See also

- [orgtree-accounts-registry](../accounts-registry/SKILL.md)
