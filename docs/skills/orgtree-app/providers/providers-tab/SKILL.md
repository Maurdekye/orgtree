---
name: orgtree-providers-tab
description: Explain provider installation, sign-in status, enablement and the legacy-model display setting.
---
Up: [orgtree-providers](../SKILL.md)

# Providers tab

App settings → Providers groups Claude/Claude Code, ChatGPT/Codex, Gemini/Antigravity, Muse/Muse Code, plus OpenRouter and Language Server. Each native row shows installation/connection status and any reported version, identity, sign-in kind/source, path, reason and tier seats. “Installed” is executable discovery, not sign-in or model entitlement.

## Enabled

The app-wide provider Enabled control uses the provider-enabled endpoint and defaults on when no value is saved. It controls whether the lane is offered for hiring; runtime eligibility also checks it. Turning it off can prevent future turns on that lane. This is separate from individual account Active and org account allowlists.

There is no UAC/app restart built into this provider toggle. It can change which tasks/accounts are eligible; suggest it only when the user intends to enable/disable that provider. Agents explain these controls and do not operate them themselves.

## Sign-in and Refresh

Refresh re-runs provider discovery/status and keeps the previous result visible while loading; a status error is not proof credentials disappeared. A missing executable offers its official download guidance.

Available native sign-in controls use the desktop bridge: Claude can request a pasted verification code; Codex uses its browser flow. Antigravity/Muse open a terminal, then tell the user to sign in there and refresh. “Terminal opened” does not verify success. A browser-only client has no native sign-in bridge. Registered-account sign-in targets that row's profile; see [accounts registry](../accounts-registry/SKILL.md).

Do not paste secrets into chat or treat provider Refresh as a model inference test. Consult the actual discovery result when a tier is unavailable.

## Legacy models

“show legacy models (Terra, Gemini Pro)” is a renderer localStorage preference `orgtree-show-legacy-models`, default off. It changes hire/model chooser and tier-list visibility. Existing agents on those models retain their model and remain visible either way. It does not buy entitlement, change runtime credentials, restart the app or alter a model's price.

Suggest enabling it only to expose a deliberately requested legacy choice. The account and catalog must still offer that choice.

## See also

- [orgtree-accounts-registry](../accounts-registry/SKILL.md)
