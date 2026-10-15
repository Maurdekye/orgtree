---
name: orgtree-mobile-layout
description: Find agent controls and hiring in the narrow layout and recognize the legacy drawer.
---

Up: [orgtree-app-shell](../SKILL.md)

# Narrow layout

At mobile width, selecting an agent can open a sheet instead of the full desktop card arrangement. Its header shows the agent name, tier, and status with controls for watchdogs, hiring under a live agent, inbox, settings, and closing the sheet. The conversation uses the same desk chat surface; closing the sheet does not retire the agent.

The hire sheet exposes the model/provider choices, name, grant, and placement relative to the selected agent: below, left, right, or above where offered. Model rows distinguish availability checks, missing harnesses, and signed-out accounts. Follow their App settings destination to resolve availability; a hidden or disabled row is not evidence that a hire succeeded.

The older renderer layout also contains a drawer with app usage/settings, All organizations, an organization list, and a creation form. The current shell uses its application menu for that navigation. Do not assume every narrow screen has the legacy drawer: first identify the shell actually displayed.

The agent desk's tabs and lifecycle actions retain their normal meanings; use its detailed reference for those controls rather than inferring different permissions from the smaller layout.

## See also

- [orgtree-agent-desk](../../desk/agent-desk/SKILL.md)
