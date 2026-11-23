---
name: orgtree-app-export-and-import
description: "Explain the two app-wide Export and import settings: stripping secrets from exports, and the default way grants are shrunk on import."
---
Up: [orgtree-app-settings](../SKILL.md)

# Export and import

**App settings > Runtime > Export and import** holds two app-wide controls. They save immediately through `/api/app-settings/runtime` and apply to every organization.

| Control | Storage | Default | Governs |
| --- | --- | --- | --- |
| Strip secrets from exports | `rt:export_strip_secrets` | Off | Every export: the user's and the agents' |
| Shrink grants that do not fit | `rt:import_shrink_strategy` | From the bottom up | The user's own imports and duplicates |

**Strip secrets from exports.** Off: nothing is taken out of an export. The user's own export then stops and asks when it found secrets, and an agent's export lists what it found in its result. On: detected secrets are taken out of every export: passwords and tokens in text become `[secret removed]`, credential files (`.env`, key files) are left out, and watchdog credentials do not travel. What counts as a secret: the credentials of MQTT and WebSocket watchdogs, credential files by name, recognisable secrets in text, and any key this Orgtree holds. Personal data is not stripped. The Export dialog can override the setting for one export; an agent's tool cannot.

**Shrink grants that do not fit.** An exported team keeps its grants. When you import or duplicate one where fewer credits can be drawn than it costs, its spare credits are taken away until it fits:

- **From the bottom up**: the lowest agents give theirs first, then the ones above.
- **From the top down**: the topmost agent gives first, then the ones below.
- **Evenly**: one credit from each agent in turn.

Whole credits are taken, and seats are never touched: when the seats alone do not fit, nothing is imported. The dialog says how many credits are lost in all; the strategy is chosen here only ([orgtree-export-import-duplicate](../../canvas/export-import-duplicate/SKILL.md)). Agents are not governed by this setting: they name a strategy in the tool call or are refused. Whether your own imports may raise the grants above them is the Credit cost bubbling switch for hires ([orgtree-app-credit-bubbling](../app-credit-bubbling/SKILL.md)).

## See also

- [orgtree-app-credit-bubbling](../app-credit-bubbling/SKILL.md)
- [orgtree-export-import-duplicate](../../canvas/export-import-duplicate/SKILL.md)
