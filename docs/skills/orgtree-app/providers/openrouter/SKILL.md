---
name: orgtree-openrouter
description: Explain OpenRouter key controls, model selection, spend standing and harness changes.
---
Up: [orgtree-providers](../SKILL.md)

# OpenRouter models and keys

Providers → OpenRouter configures hireable catalog models and one or more keys. OpenRouter supplies model service/billing; the selected installed Claude Code, Codex or OpenCode harness runs agent tools. An enabled provider and an allowed active key are separate gates.

## Keys and add/edit dialog

All keys are peers with IDs `openrouter-N`; none is the primary/original key. Active governs that key's availability. Refresh checks key standing. Remove can reassign bound agents to eligible keys or leave them waiting; it is not a harmless list cleanup.

| Dialog field | Default/behavior |
| --- | --- |
| Name | Optional, UI limit 80 characters; blank uses the key's OpenRouter label. |
| Harness | Installed compatible choices, retaining a saved missing value with its explanation. A per-agent harness pin keeps that agent's choice. |
| API key | Required on Add; blank on Edit retains the secret. A replacement is stored locally and never displayed again. |

The key's harness change reaches its unpinned agents at the next turn, on a fresh session seeded with a summary. That can change context/cache continuity. A missing harness refuses launch rather than silently changing it. The dialog has Save/Cancel and prevents submitting while busy. No app-wide restart/UAC is intrinsic to saving a key, but agent startup/session effects are real.

Spend caps and prepaid balance are read from OpenRouter's key/account standing, not editable budget fields in this dialog. Keys of one OpenRouter account can share its balance. Do not promise independent balances or a fabricated reset. For window interpretation see `orgtree-usage-windows` (orgtree-working › accounts).

## Model browser

The selected chips are the models that can be hired; removing a chip changes that selection. The browser searches name/vendor/ID and pages the catalog. Sort/reverse and provider grouping can change ordering; an explicit sort can displace best-match ranking. Rows show model identity, context and reported price/capability details. Unknown tool/image/reasoning support and prices remain unknown, not zero.

Model toggles persist the selection; entering/exiting a browser is not a transactional draft of every favorite. Selecting a model does not establish key capacity or install a harness. Suggest changes when the user wants that model offered, then verify the selected key/harness supports the route.

Do not expose stored keys in troubleshooting. Distinguish missing model selection, exhausted key, excluded account and missing harness; they require different remedies.

## See also

- [orgtree-harness-opencode](../../harnesses/harness-opencode/SKILL.md)
