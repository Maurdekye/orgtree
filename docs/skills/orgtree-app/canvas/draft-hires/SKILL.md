---
name: orgtree-draft-hires
description: Configure a canvas draft hire and its staged permissions before creating the actual agent seat.
---
Up: [orgtree-canvas](../SKILL.md)

# From a hire chip to a seat

App settings > Display > Desk > **New hires go** chooses End (default), Start or
Centre for ordinary agents and projects, including root creation and hires under
projects. Centre inserts just after the middle of the live direct children,
counting agents and projects, excluding retired nodes: A B [new] C for three;
A B [new] C D for four. The draft previews that position in rows and circular
arcs. Side/above tokens keep their placement. The compact hire sheet's ordinary
report placement follows the same app preference; existing nodes do not move.
See [Desk and chart display](../../app-settings/app-display-desk-and-chart/SKILL.md#new-hires-go).

Hire chips open a draft at the chosen relationship: subordinate, coworker or inserted superior; the user root opens a top-level draft. The chip's cost is a seat reservation, not dollars or tokens. Provider rows retain their own groups; within each group hire tokens run from cheaper to more expensive seats with stable ties. Disabled choices explain an availability reason; expanding the strip only exposes choices, it does not hire anyone.

Each round hire token shows the tier's letter. Its seat cost appears in the
tooltip as `(-N)`, or `(free)` for a zero-cost seat, rather than as a visible
price number. These tokens form hire strips on the card edges and beside an
open desk; the desk keeps the strip on the edge nearest the pointer. They are
separate from the icon row controlled by **Show agent card shortcuts**, which
does not draw over an opened desk.

An agent's top hire strip opens a superior draft above that exact agent,
including a top-level agent directly under the user. Hire preserves this
insertion target when undo history is enabled or disabled; the new superior
and its existing report are placed together in one operation. The compact
hire sheet's superior placement follows the same rule. Superior hiring stays
on the hire strips or placement form; the shared context menu offers
subordinate hiring, rather than adding a superior-menu action.

The dashed draft says uninitialized because no live seat exists yet. It shows the selected tier, name, permission gear, charter/presets, grant bar and Hire/Cancel. A nonblank name enables submission; engine validation can still refuse an invalid/duplicate name. The human form allows an optional charter, unlike the explicit full charter required on an agent's hire tool.

| Draft control | Staged behavior |
| --- | --- |
| Model icon | Click to open the model/tier menu. Pick a model to replace the proposed hire's tier; name, charter/presets, grant and placement stay. Availability and refusal reasons follow the regular hire choices. No seat or running agent changes until Hire. Escape closes this menu first. |
| Name | Starts empty; the first chosen charter preset can fill an empty name, still editable. |
| Charter presets | Named source files shown as removable cards; the entire file (heading, introduction and separator included) is prepended to manual charter text only when finalized, in pick order. Loading errors have Retry; a bounded preset warns how much was omitted. A preset changes text only, not placement or permissions. |
| Grant bar | The draft's allocation editor. Opening grant comes from draft/org defaults, not a universal fixed number. It is bounded by the org cap or available parent room when hire cascade is off. |
| Permission gear | Opens Draft permissions; each change is stored in the draft immediately and the menu stays open. Close or Escape keeps those choices. Only Hire creates a seat. |
| Hire / Cancel | Submit the proposed seat, or abandon the draft. Escape cancels; submission can still fail the engine's current checks. After Hire the draft stays where it is, greyed, its tag reading HIRING…, and takes no input until the new card arrives; the card then takes its exact place without moving. The camera walks to its desk unless Display > Desk > Open desk after manual hire is Off (On by default). Off keeps the completion camera, including side/above hires; the draft still closes. A refused hire returns the draft to normal with its fields kept, and says why. |

## Draft permissions

Subordinate, coworker and top-level drafts start with the parent's scope when present, otherwise organization defaults. They snapshot the proposal for editing rather than replacing the user's staged choices during a refresh. Folders can be added by path/picker, toggled RW/RO or removed. The form also offers visible-agent scope, thinking effort, account, native tools, Orgtree groups and MCP server grants.

A superior draft's permissions panel identifies the existing agent it will be inserted above. Folders, tools, visible-agent scope and file access are inherited from that target at final Hire and cannot be overridden in this panel. Thinking effort and account remain editable. Opening or editing this menu preserves scope inheritance with undo history enabled or disabled; it does not submit scope overrides. Final Hire still validates current target permissions, accounts, credits and placement.

Effort choices follow the chosen tier and, for Muse, the selected login's model catalog. Account choices follow the provider and warmed staffing offers; Use machine default clears a manual selection. Stale/unavailable offers can still be refused at final admission. MCP can select all registered current/future servers or individual discovered servers, with a refresh control. These are proposed grants, bounded by inherited capability.

There is no Apply button. Closing the menu keeps its current choices; only final Hire creates the seat. Live-agent settings retain their explicit Save action because they can retool or restart an existing agent. The final engine operation supplies the placement and chosen scope as a human action. For agent-side explicit fields, funding and kickoff, see `orgtree-tool-hire` (orgtree-working › team) and `orgtree-hiring` (orgtree-working › team). Do not infer that creating a seat starts a task: task/assignment mail is a separate concern.

Changing the model keeps staged folders, tools and visibility. An account belonging to another provider, or excluded by the target model's known staffing offers, returns to automatic placement. A known unsupported effort maps to the highest supported level at or below it, otherwise the lowest; models with no effort setting inherit. Open Draft permissions to choose again. Final Hire still validates current accounts, model support and credits.

Default-setting details belong to [Hire defaults: scope](../../org-settings/org-hire-defaults-scope/SKILL.md), [folders](../../org-settings/org-hire-defaults-folders/SKILL.md) and [tools](../../org-settings/org-hire-defaults-tools/SKILL.md), rather than a copied price/default table here.

## Liaison preset placement

The bundled liaison role is for a large organization where the user needs a conversation partner above a busy coordinator. Open a superior draft above the existing coordinator and select liaison; selecting the preset on a subordinate draft would still create a subordinate. The intended shape is user → liaison → coordinator → workers. The coordinator remains the liaison's sole direct report and handles execution and staffing. Keep the coordinator's required capabilities available through its new superior; the charter itself limits the liaison to discussion, decision records and delegation. See orgtree-charters (orgtree-working › team) for the role, tool insertion and separate audience rules, and [charter documents](../../app-settings/app-charters-and-templates/SKILL.md) for bundled/local copies.

## Projects

The project draft's **gear** opens Project settings before creation. It shares the live project's peer-mail, queue, sender-exclusion, slots, Project Events and acknowledgement controls. Name and Summary remain on the draft card; history, folders and lifecycle actions require an existing project. Every change stages policy in the draft immediately and keeps the menu open; there is no Save step. Close or Escape keeps those choices without abandoning the draft. Reopening shows the current choices. Create submits those settings atomically with the project, and a refusal keeps them for retry. The gear is disabled while creation is pending. Agents use `orgtree_project action=create` with the same policy fields in `settings`; see `orgtree-tool-project` (orgtree-working › team).

While project creation is pending, Create and Enter cannot submit it again; Cancel and opening a replacement draft remain available. A late response preserves the replacement's fields, and a refusal keeps the current form ready to correct and retry.

Every hire strip also has a **project token**: a square with a folder icon in the project card's theme colours, alone on the strip's outermost row. Its tooltip says "create a project … (free, structural)" and names where the project lands. A project card has all four strips too: hire under it, a coworker to either side, or a superior above it. Like the agent tokens it opens a draft card where the project will go and walks the camera to it: a dashed square with a folder mark, a name and a Summary (optional; it becomes the standing charter of every agent under the project), with create and cancel. The project lands where the strip points: under the card, beside it (it is created and then moved to that side), or above it, taking the card's place and holding it. The eye card's token and "New project…" entry create one at the top level. "New project…" in a card's or an Agents List row's menu, directly under Hire a subordinate, opens the same draft under that node. A project costs no seat, so no grant bar is shown. On the canvas a project is a dashed card with a folder mark (its Summary is on its desk, not the card) and the header's activity chip (a spinner while any agent under it works, then active/hired agents under it); zoomed out it is just a large folder, without the tier stripe agent cards have. Neighbour lines skip a project: agents on either side of one stay joined by a line running past it. Its mailbox button (with the waiting-mail count) appears only when Show agent card shortcuts is on. For the focused project desk, its tabs, composer, worker/history tables and remembered navigation, see [orgtree-project-desk](../../desk/project-desk/SKILL.md). For project behavior and reach, see `orgtree-projects` (orgtree-working › team).

## See also

- `orgtree-hiring` (orgtree-working › team)
- [orgtree-org-hire-defaults-scope](../../org-settings/org-hire-defaults-scope/SKILL.md)

## Native replacement-tool exception

Fresh ordinary drafts always start Disabled by Orgtree off, even when the parent holds it. The optional tools.orgtree_disabled boolean requires an explicit selection in Native Tools and remains parent-clamped. Its hint lists coverage for the selected harness, or the per-harness summary before a custom route is resolved. Superior-insertion drafts retain their existing inherited, non-editable scope.
