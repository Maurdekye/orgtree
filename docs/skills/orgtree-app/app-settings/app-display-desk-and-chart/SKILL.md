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
| bunch consecutive projects | `ls:orgtree-project-bunches` | On | Each uninterrupted column of two or more projects forms a tightly packed round bunch, with a snaking order and short curves in the normal hierarchy-edge style. An agent or split ends that bunch; another direct project run can bunch below it. Sibling projects stay separate. Off restores ordinary columns. |
| rearrange projects in a bunch | `ls:orgtree-project-bunch-rearrange` | Off | Enables insertion points and project-order changes when dragging inside a bunch. Off keeps ordinary whole-subtree dragging and reparenting everywhere. Changes update open windows; it only has an effect when bunching is on. |
| desk text size | `ls:orgtree-desk-dpi` | 100% | Minus/plus changes by 25 percentage points, bounded 75–250%; reset restores 100%. Scales desks, cards and canvas text, while settings panels keep their own sizing. |
| collapse crowded teams into one stack | `ls:orgtree-crowd-piles` | Off | Teams with more than eight active agents can draw as a counted stack. See the piles screen for opening one. |
| hide retired agents | `ls:orgtree-hide-retired` | Off | On removes retired agents from ordinary canvas/lists; retired tokens and archived switchboard rows remain routes to them. Off shows siblings as a counted retired pile once a retired representative is loaded (latest retiree by default), or one card for a single retiree. It does not delete records. See [piles](../../canvas/piles/SKILL.md). |
| show agent card shortcuts | `ls:orgtree-agent-shortcuts` | Off | Shows action buttons below names on canvas cards. |
| fade pinned desks and modals over expanded desks | `ls:orgtree-modal-overlap-fade`, enabled | Off | Enables the overlap treatment for pinned windows. |
| overlap opacity | Same stored object's opacity | 70% | Range 20–90%, steps 5%; disabled while overlap fading is Off. |
| snap pinned panels to edges | `ls:orgtree-pin-snap` | On | Drag/resize snaps at window edges or beside pinned panels; Off leaves the chosen position. |
| Collapse many jump cards on desks | `ls:orgtree-jump-fold` | On | More than sixteen report/watchdog jump cards fold behind a counted control; Off shows them separately. |
| keep canvas controls inside the area pins leave free | `ls:orgtree-canvas-anchor-bounded` | On | Changes the available rectangle used to anchor canvas corner controls, preserving their corner/offset relationships. |

Suggest larger desk text for legibility, stacks/folding for crowded teams, or a different chart layout for navigating the current organization. Explain that hidden or stacked seats still exist and retain their capacity and work. Suggest snapping/overlap/anchor changes for window arrangement rather than as a way to stop an agent.

Local storage can be unavailable in restricted browser contexts; the implementation falls back to its defaults and the current in-memory state where supported. A renderer preference is not proof another browser profile or machine shares it.

A bunch keeps every project separately selectable and draggable. With **rearrange
projects in a bunch** enabled, drag within it to change project order using the
existing move/reorder operations; the bottom member group stays beneath the new
bottom project. This is off by default: ordinary dragging moves the project with
its subtree, inside or outside a bunch. Creating a project above an existing project, or above
the sole agent under the bottom project, extends the bunch. Creating one above
one of several children preserves that split. Bunching itself changes drawing only;
swap remains agent-only and is not used for bunch reordering. In the circular chart
a bunch takes one wider slot on its ring; the other cards on that ring keep their
usual dense spacing and arcs.

## New hires go

Display > Desk > **New hires go** saves immediately to
`ls:orgtree-new-hire-position` for this app profile, across its organizations and
windows. Choices are End (default), Start and Centre. It selects the insertion
position of ordinary new agents AND projects; changing it never moves existing
nodes. Centre goes just after the middle of the existing live direct children,
counting agents and projects: A B [new] C for three; A B [new] C D for four.
Retired nodes and grandchildren do not count.

This covers tokens/menus, the compact hire sheet, Quick chat and immediate Staff.
In circular view the same sibling order places the new node within its team's
arc; Centre is a list position, not a fixed screen angle. Explicit side/above
tokens, moves and template order retain their placement. Agent hire/staff tools
keep their required explicit `index`; no new tool is needed for this user choice.

## See also

- [orgtree-org-canvas](../../canvas/org-canvas/SKILL.md).
- [orgtree-pinned-windows](../../canvas/pinned-windows/SKILL.md).
- [orgtree-piles](../../canvas/piles/SKILL.md).
