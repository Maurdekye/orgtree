---
name: orgtree-tool-list-tiers
description: Read model-tier identifiers and staffing seat prices without assuming catalog listing proves launch eligibility.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_list_tiers

Requires `inspection`, although this page is in the team section. It takes **no parameters** and is read-only; all callers, including top-level agents, use the same tool. Use it before choosing the `tier` for [hire](../tool-hire/SKILL.md) or [switch model](../tool-switch-model/SKILL.md).

```json
{}
```

The result has `tiers` and `seat_floor`. Built-in entries expose `tier`, provider label, `seat`, model and context capacity. OpenRouter favorite entries expose tier/provider/seat/model; language-server entries additionally identify `server` and available context. Seat price is concurrent credit capacity, not token pricing or cost per turn. Use returned values rather than an old hard-coded price table.

The handler excludes legacy built-ins and disabled built-in providers, and conditionally filters Antigravity offers; it appends OpenRouter favorite tiers and enabled language-server tiers. This is **not the full staffing-admission preview**: a listed tier is not proof the selected account offers it, is signed in/active, has usage room, belongs to the org allowlist, or has an installed runnable harness. The tool returns no effort-level list or per-login model-version entitlement.

If a tier is absent, do not invent its identifier or change user settings yourself. If it is present, the hiring/model-change path still validates availability, org/account restrictions and credit room and can refuse. No special top-level bypass exists. Use current account/provider information and the chosen model's offered effort levels when assembling a staffing call.
