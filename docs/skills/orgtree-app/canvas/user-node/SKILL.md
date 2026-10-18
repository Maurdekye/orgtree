---
name: orgtree-user-node
description: Use the user root and switchboard while recognizing the scope of its organization-wide actions.
---
Up: [orgtree-canvas](../SKILL.md)

# The user root and switchboard

The eye-shaped root represents the user. Focusing it opens the switchboard: direct lines to live top-level agents and agents holding a user audience. Tabs follow the canvas's spatial order. They are not a promise that every agent in the organization may send directly to the user.

Selecting a tab opens/minimizes that chat, or raises its pinned window. The separate jump control navigates to the agent's place. A close control on an audience-granted line revokes that audience; intrinsic top-level lines have no equivalent revoke control. Its mail count and busy indicator belong to that tab's agent.

The switchboard's auto toggle controls whether a newly arriving direct line opens while the switchboard is already being viewed and another panel fits without horizontal scrolling. Otherwise the new line arrives minimized. Catch-up lines discovered when returning to the switchboard do not all force themselves open. This is presentation behavior, not a new user audience.

## Root menu

| Item | Scope |
| --- | --- |
| Focus | Navigate to the user root/switchboard. |
| Hire an agent | Choose an offered tier and open a top-level [draft hire](../draft-hires/SKILL.md). |
| Open inbox | User inbox, not the outside-org inbox. |
| Open global docket | Organization work view; see [docket screens](../../desk/docket-screens/SKILL.md). |
| Open presentations | Organization document gallery; see [presentations](../../desk/presentations/SKILL.md). |
| Open shared scratch folder | Open this org's shared scratch folder in the OS file manager, creating it on demand. Supported native shells only; available on the overview card and focused switchboard header. |
| Org settings | Full org settings dialog, including hire defaults. |
| Compact all agents… | Shared two-action confirmation for the live set: compact N agents and cheap-compact N agents, plus Cancel. Both type previews name eligible/skipped agents and reasons; zero-target actions are disabled. Each action runs sequentially and Cancel changes nothing. Busy agents are skipped. |
| Halt all agents… / Unhalt all agents… | Counted live set; the label becomes Unhalt only when every target is halted. Read per-target results. |
| Retire all agents… | Whole-organization retirement confirmation; context retention does not mean unfinished docket work is complete. |

These are human controls. They do not extend an agent's downward authority or turn a top-level agent into the user. Inspect the counted set and confirmation before a bulk action. For the relevant stop/session mechanics see `orgtree-tool-halt` (orgtree-working › runtime), `orgtree-tool-unhalt` (orgtree-working › runtime) and `orgtree-tool-cheap-compact` (orgtree-working › runtime); for archiving a team see `orgtree-tool-dissolve` (orgtree-working › team).

## See also

- [orgtree-confirm-dialogs](../../app-shell/confirm-dialogs/SKILL.md)
