---
name: orgtree-accounts
description: Find the account workflows and tools for usage, bindings, freezes and cache continuity.
---
Up: [orgtree-working](../SKILL.md)

# orgtree-accounts

Provider accounts from an agent's side: usage windows, account binding, freezes and cache continuity.

## Workflows and rules

- [orgtree-account-lanes](account-lanes/SKILL.md): Account lanes and binding: which account your turns run on, fallback, and why agents do not switch on their own.
- [orgtree-usage-windows](usage-windows/SKILL.md): Reading usage windows: session, weekly and scoped windows, freshness, and when a reading counts as exhaustion.
- [orgtree-usage-freezes](usage-freezes/SKILL.md): Usage-limit freezes: what freezes an agent, auto-resume, unstick, continue_on and account marks.
- [orgtree-cache-continuity](cache-continuity/SKILL.md): Provider prompt-cache continuity: what changes the cache namespace or prefix, TTLs per auth lane, and why no hit is guaranteed.

## Tools

- [orgtree-tool-usage](tool-usage/SKILL.md): Provider usage readings, filters and refresh rules.
- [orgtree-tool-continue-on](tool-continue-on/SKILL.md): Move a frozen agent to another account of the same provider.
- [orgtree-tool-account-mark](tool-account-mark/SKILL.md): Inspect or clear an account's capacity mark.
