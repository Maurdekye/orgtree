# Switchboard context menu

User 2026-10-19 17:27Z moved the switchboard's Open actions into one **Open**
submenu, replacing the 2026-10-11 flat layout. It contains **Inbox**, **Global
docket**, **Presentations** and **Shared scratch folder**, when their existing
capabilities are available. The scratch-folder entry keeps its nested **Open
folder / Edit AGENTS.md** actions when the managed folder has an AGENTS.md.
With no available Open routes, the branch is omitted.

The menu follows this order: Focus, Hire an agent, New project, Open, Agents
list, Org settings, separator, Compact all agents, Halt/Unhalt all agents and
Retire all agents. Agents list and Org settings remain top-level. All entries
use the same `useContextMenu` renderer, typography, spacing,
warning/danger states and submenu presentation as agent menus. The lifecycle
separator moves before compaction; there is no extra separator before retirement.
Existing bulk confirmations and shortcut visibility rules remain unchanged.
Unhalt uses the agent menu's neutral style; Halt and Retire retain danger styling.

Focus reuses `centerOn(USER)`. Hire an agent uses the same `hireTierChoices` and
`tierLabel` as the agent subordinate menu, with the same eligibility gates. Choosing
a tier calls the switchboard's existing `onSpawn`, which opens the standard draft
through `spawn(USER, tier)` with `parent: null`. It never chooses an existing agent
as parent or inserts a superior. Choosing a tier alone does not submit a hire.

The shell supplies docket and gallery handlers through OrgCanvas to UserNode.
They call the same `toggleSurface` routes as the header buttons, preserving pin
raising/toggle behavior. Global docket means the current org's full docket,
without the agent/team filter; presentations opens its full gallery rather than
an agent-specific gallery. Optional unavailable shell handlers omit their entries.

Verification uses synthetic data only: mounted switchboard menu actions and
grouped Open entries, separator position, tier choices, and the real OrgCanvas draft
submission path (`parent: null`, no `above`). Related canvas-navigation and
keyboard-hire tests are included; typecheck passes. The offscreen renderer fixture
`switchboard-menu` renders the real switchboard and agent menus in dark/light at
desktop/narrow widths, checking shared computed style and lifecycle separation.
No live hire, hierarchy/settings mutation, installed-app or package claim.

Historical 2026-10-11 receipts for the prior layout: 35/35 focused cases in `switchboard-menu-tests.log` and clean
`switchboard-menu-typecheck.log` under the local evidence root. Four offscreen
viewport/theme pairs pass in `rig/agy-astra/switchboard-menu-visual/result.json`;
the narrow light switchboard and agent reference screenshots were inspected.
The visual run preceded only the neutral Unhalt style adjustment, which has a
focused rendered assertion. Focus is also tested through the actual canvas camera,
against the existing HUD action. Shell docket/gallery wiring was source-inspected;
no mounted full-App or installed navigation acceptance claim.

The current `switchboard-open.test.tsx` mounts overview and focused header
surfaces, checks the grouped order and original reveal arguments, and exercises
the nested shared-folder actions through the keyboard. A synthetic native
capture renders those actual menus in light/dark at desktop/narrow widths,
without opening real folders or writing live state.
