---
name: orgtree-draft-hires
description: Configure a canvas draft hire and its staged permissions before creating the actual agent seat.
---
Up: [orgtree-canvas](../SKILL.md)

# From a hire chip to a seat

Hire chips open a draft at the chosen relationship: subordinate, coworker or inserted superior; the user root opens a top-level draft. The chip's cost is a seat reservation, not dollars or tokens. Provider rows retain their own groups; within each group hire tokens run from cheaper to more expensive seats with stable ties. Disabled choices explain an availability reason; expanding the strip only exposes choices, it does not hire anyone.

The dashed draft says uninitialized because no live seat exists yet. It shows the selected tier, name, permission gear, charter/presets, grant bar and Hire/Cancel. A nonblank name enables submission; engine validation can still refuse an invalid/duplicate name. The human form allows an optional charter, unlike the explicit full charter required on an agent's hire tool.

| Draft control | Staged behavior |
| --- | --- |
| Model icon | Click to open the model/tier menu. Pick a model to replace the proposed hire's tier; name, charter/presets, grant and placement stay. Availability and refusal reasons follow the regular hire choices. No seat or running agent changes until Hire. Escape closes this menu first. |
| Name | Starts empty; the first chosen charter preset can fill an empty name, still editable. |
| Charter presets | Named source files shown as removable cards; their text is prepended to manual charter text only when finalized. Loading errors have Retry; a bounded preset warns how much was omitted. |
| Grant bar | The draft's allocation editor. Opening grant comes from draft/org defaults, not a universal fixed number. It is bounded by the org cap or available parent room when hire cascade is off. |
| Permission gear | Opens Draft permissions; Apply stores choices in the draft, Cancel leaves them unapplied. Neither creates a seat. |
| Hire / Cancel | Submit the proposed seat, or abandon the draft. Escape cancels; submission can still fail the engine's current checks. |

## Draft permissions

The initial proposal uses the parent's scope when present, otherwise organization defaults. It snapshots the proposal for editing rather than replacing the user's staged choices during a refresh. Folders can be added by path/picker, toggled RW/RO or removed. The form also offers visible-agent scope, thinking effort, account, native tools, Orgtree groups and MCP server grants.

Effort choices follow the chosen tier and, for Muse, the selected login's model catalog. Account choices follow the provider and warmed staffing offers; Use machine default clears a manual selection. Stale/unavailable offers can still be refused at final admission. MCP can select all registered current/future servers or individual discovered servers, with a refresh control. These are proposed grants, bounded by inherited capability.

Apply returns to the draft; only final Hire creates the seat. The final engine operation supplies the placement and chosen scope as a human action. For agent-side explicit fields, funding and kickoff, see `orgtree-tool-hire` (orgtree-working › team) and `orgtree-hiring` (orgtree-working › team). Do not infer that creating a seat starts a task: task/assignment mail is a separate concern.

Changing the model keeps staged folders, tools and visibility. An account belonging to another provider, or excluded by the target model's known staffing offers, returns to automatic placement. A known unsupported effort maps to the highest supported level at or below it, otherwise the lowest; models with no effort setting inherit. Open Draft permissions to choose again. Final Hire still validates current accounts, model support and credits.

Default-setting details belong to [Hire defaults: scope](../../org-settings/org-hire-defaults-scope/SKILL.md), [folders](../../org-settings/org-hire-defaults-folders/SKILL.md) and [tools](../../org-settings/org-hire-defaults-tools/SKILL.md), rather than a copied price/default table here.

## Projects

Every hire strip also has a **project token**: a light grey square with a folder icon, alone on the strip's outermost row. Its tooltip says "create a project … (free)" and names where the project lands. Like the agent tokens it opens a draft card where the project will go and walks the camera to it: a dashed square with a folder mark, a name and a description (optional; it becomes the standing charter of every agent under the project), with create and cancel. The project lands where the strip points: under the card, beside it (it is created and then moved to that side), or above it, taking the card's place and holding it. The eye card's token and "New project…" entry create one at the top level. "New project…" in a card's or an Agents List row's menu, directly under Hire a subordinate, opens the same draft under that node. A project costs no seat, so no grant bar is shown. On the canvas a project is a dashed card with a folder mark, its description and the header's activity chip (a spinner while any agent under it works, then active/hired agents under it); zoomed out it is just a large folder, without the tier stripe agent cards have. Its mailbox button (with the waiting-mail count) appears only when Show agent card shortcuts is on. Clicking it, or zooming in, opens its project desk (never a modal): the desk tab has jump cards up and down and its description, shown as Markdown and edited as plain monospace text when clicked (leaving the box saves it); inbox, docket and presented are the agent desk's tabs. The header shows active/hired agents under it with a spinner while any works, halt all, dissolve project and the settings gear; the desk pins as a window like an agent's. Its menu offers its folder, presentations, hires and nested projects under it, and Retire. For what a project is, see `orgtree-projects` (orgtree-working › team).

## See also

- `orgtree-hiring` (orgtree-working › team)
- [orgtree-org-hire-defaults-scope](../../org-settings/org-hire-defaults-scope/SKILL.md)
