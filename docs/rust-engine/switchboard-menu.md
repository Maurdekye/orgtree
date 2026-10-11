# Switchboard context menu

User 2026-10-11 requested the same format, order and separators as agent context
menus, with three Open entries kept flat instead of under an Open submenu.

The menu now follows this order: Focus, Hire an agent, Open inbox, Open global
docket, Open presentations, Org settings, separator, Cheap-compact all agents,
Halt/Unhalt all agents, Retire all agents. Open inbox is the existing third Open
action. All entries use the same `useContextMenu` renderer, typography, spacing,
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

Verification uses synthetic data only: mounted switchboard menu actions and flat
Open entries, separator position, tier choices, and the real OrgCanvas draft
submission path (`parent: null`, no `above`). Related canvas-navigation and
keyboard-hire tests are included; typecheck passes. The offscreen renderer fixture
`switchboard-menu` renders the real switchboard and agent menus in dark/light at
desktop/narrow widths, checking shared computed style and lifecycle separation.
No live hire, hierarchy/settings mutation, installed-app or package claim.

Measured receipts: 35/35 focused cases in `switchboard-menu-tests.log` and clean
`switchboard-menu-typecheck.log` under the local evidence root. Four offscreen
viewport/theme pairs pass in `rig/agy-astra/switchboard-menu-visual/result.json`;
the narrow light switchboard and agent reference screenshots were inspected.
The visual run preceded only the neutral Unhalt style adjustment, which has a
focused rendered assertion. Focus is also tested through the actual canvas camera,
against the existing HUD action. Shell docket/gallery wiring was source-inspected;
no mounted full-App or installed navigation acceptance claim.
