---
name: orgtree-status-bar
description: Interpret organization status chips, connectivity, costs, and active-agent counts.
---

Up: [orgtree-app-shell](../SKILL.md)

# Status bar

The footer contains organization status and optionally Quick chat. Chips appear when their backing state calls for them; absence of a conditional chip does not establish a universal service guarantee.

| Chip | Meaning |
|---|---|
| Active/hired agent summary | Current busy agents and hired seats, with tier counts; the tooltip separates activity in other organizations |
| Audit warning | Credit ledger problems; shown when the audit fails |
| Cost | Recorded cost information when available; inspect the tooltip for API/subscription splits and unknown pricing rather than treating an estimate as a bill |
| Provider limit warning | A reported provider-specific limit flag |
| Headless | No user is present; user-bound requests are automatically denied |
| Primed restart | A supplied maintenance/restart record and its explanation |
| Hub | Enabled, visible hub connections; one hub uses its name, multiple hubs show connected/total, with queued messages and an offline warning when none are connected |
| Error | The current connection/error message, kept visible at the end of the bar |
| Version | The running app version |

Click the hub chip, or activate it with Enter/Space, to open Connections and inspect its diagnostics. A queued count is outstanding delivery, not proof of receipt. The active-agent count describes running activity and can differ from agents whose status is working.

## See also

- [orgtree-quick-chat](../quick-chat/SKILL.md)
