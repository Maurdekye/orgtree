---
name: orgtree-app-display-desk-and-chart
description: Explain browser-local chart, desk text, stacks, shortcuts and pinned-panel display choices.
---

Up: [orgtree-app-settings](../SKILL.md)

# Desk and chart display

Display > Desk saves immediately to renderer localStorage for this profile, shared across its windows where the preference's storage listeners apply. These are display choices, not organization settings. Agents explain and suggest changes; the user operates them. They do not change an agent's model, permissions, mailbox, grant or prompt prefix.

| Control | Storage | Default | Effect |
| --- | --- | --- | --- |
| org chart layout | `ls:orgtree-chart-layout` | row | Row places teams in rows by depth; circular places the top-level node centrally and teams behind parents in rings. |
| desk text size | `ls:orgtree-desk-dpi` | 100% | Minus/plus changes by 25 percentage points, bounded 75–250%; reset restores 100%. Scales desks, cards and canvas text, while settings panels keep their own sizing. |
| collapse crowded teams into one stack | `ls:orgtree-crowd-piles` | Off | Teams with more than eight active agents can draw as a counted stack. See the piles screen for opening one. |
| hide retired agents | `ls:orgtree-hide-retired` | Off | Removes retired agents from ordinary canvas/lists; retired tokens and archived switchboard rows remain routes to them. It does not delete their records. |
| show agent card shortcuts | `ls:orgtree-agent-shortcuts` | Off | Shows action buttons below names on canvas cards. |
| fade pinned desks and modals over expanded desks | `ls:orgtree-modal-overlap-fade`, enabled | Off | Enables the overlap treatment for pinned windows. |
| overlap opacity | Same stored object's opacity | 70% | Range 20–90%, steps 5%; disabled while overlap fading is Off. |
| snap pinned panels to edges | `ls:orgtree-pin-snap` | On | Drag/resize snaps at window edges or beside pinned panels; Off leaves the chosen position. |
| Collapse many jump cards on desks | `ls:orgtree-jump-fold` | On | More than sixteen report/watchdog jump cards fold behind a counted control; Off shows them separately. |
| keep canvas controls inside the area pins leave free | `ls:orgtree-canvas-anchor-bounded` | On | Changes the available rectangle used to anchor canvas corner controls, preserving their corner/offset relationships. |

Suggest larger desk text for legibility, stacks/folding for crowded teams, or a different chart layout for navigating the current organization. Explain that hidden or stacked seats still exist and retain their capacity and work. Suggest snapping/overlap/anchor changes for window arrangement rather than as a way to stop an agent.

Local storage can be unavailable in restricted browser contexts; the implementation falls back to its defaults and the current in-memory state where supported. A renderer preference is not proof another browser profile or machine shares it.

## See also

- [orgtree-org-canvas](../../canvas/org-canvas/SKILL.md).
- [orgtree-pinned-windows](../../canvas/pinned-windows/SKILL.md).
- [orgtree-piles](../../canvas/piles/SKILL.md).
