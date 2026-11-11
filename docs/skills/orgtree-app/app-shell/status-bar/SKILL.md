---
name: orgtree-status-bar
description: Interpret organization status chips, connectivity, costs, and active-agent counts.
---

Up: [orgtree-app-shell](../SKILL.md)

# Status bar

The footer contains organization status and optionally Quick chat. Chips appear when their backing state calls for them; absence of a conditional chip does not establish a universal service guarantee.

| Chip | Meaning |
|---|---|
| Remote engine | Only in the window of an organization that runs on a remote engine, as the first chip: the engine's name with the remote glyph. Green while connected, amber when connected to a different engine version, red with the state word (offline, sign-in needed, can't connect, paused, connecting) otherwise. Click it, or press Enter/Space, for Connection details |
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

In a remote organization's window, a banner under the header appears while its engine is not connected: it says what is the matter and offers the one action (Retry now, Enter a new token, Connection details or Connect). The canvas is dimmed meanwhile: it shows the last known state, and changes are refused with the reason until the connection is back. A message you send meanwhile is not sent and stays in the composer, ready for when the connection returns. Reconnecting is automatic.

## See also

- [orgtree-quick-chat](../quick-chat/SKILL.md)
