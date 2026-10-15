---
name: orgtree-account-lanes
description: Explain which permitted account serves an agent and how placement and fallback differ.
---
Up: [orgtree-accounts](../SKILL.md)

# Account lanes and bindings

Use account lanes to identify the credentials and allowance a task spends. Account activation, org permission, the saved binding and provider usage are separate checks; a low bar does not bypass any of them.

## Identify the serving account

The current turn's usage board stars its serving lane. A native sign-in is named `<provider>/primary`; additional logins have registry IDs. Each OpenRouter key is `openrouter-N` and a language server is `langserver:<id>`. Email/labels identify a login to a person; use canonical IDs for binding.

A running turn keeps the account captured at admission. A pending account change is for the next turn. Omitted account on a hire uses compatible hiring defaults and applicable placement; it does not inherit the manager's live login. Omitted account on a retool/rehire preserves the stored binding. `primary` restores the target native provider's sign-in, not guaranteed capacity. OpenRouter keys are peers, with no privileged primary; an unbound existing seat uses the first key in list order, while automatic new placement binds a key.

For the user's account control, see `orgtree-agent-account-tab` (orgtree-app › agent-settings).

## Gate first, then balance new work

Discard disallowed org lanes, inactive providers/accounts, unusable authentication, applicable marks/full windows and missing model entitlement. Muse entitlement is per login and exact model/version. A model exhausted on one account may still be available on another.

For compatible candidates, placement reads cached windows: use each account's highest applicable usage and latest applicable reset. Accounts resetting within 24 hours come first, earliest first. The rest with observations sort by lower usage, reset time and existing order. Unread accounts follow in their existing order; if all readings are missing the original order remains. Deterministic order does not prove room on an unread account.

Balance when placing authorized new work. A standing binding or team staffing rule is not permission to move an existing seat merely because another bar is lower. Changing credentials can sacrifice cache/session continuity; use [cache continuity](../cache-continuity/SKILL.md).

## Fallback is separate

Per-agent account fallback is opt-in. A qualifying limit can try another permitted account of the same provider. Registered subscriptions precede metered keys; a provider's API-key fallback switch must permit paid keys. Automatic subscription fallback requires affirmative room in needed windows; missing, stale or timed-out observations are insufficient. Muse additionally checks the destination's own model/version catalog; its native login can follow registered subscriptions.

Changing an org's allowed accounts is a separate next-turn eligibility gate: a disallowed binding must move to an allowed destination or wait frozen. Account removal likewise reassigns or freezes affected bindings; it is consequential, not a display-only cleanup.

## Act through the specific tool

Use [usage](../tool-usage/SKILL.md) for authorized cached evidence or a bounded refresh, [continue-on](../tool-continue-on/SKILL.md) for an authorized explicit move, and [account-mark](../tool-account-mark/SKILL.md) for the recorded restriction. Read their parameters and consequences before mutating anything.

## See also

- See `orgtree-agent-account-tab` (orgtree-app › agent-settings).
- [orgtree-usage-windows](../usage-windows/SKILL.md)
