---
name: orgtree-agent-desk
description: Explain the desk header, runtime banners, tabs and available agent controls.
---
Up: [orgtree-desk](../SKILL.md)

# Agent desk

The Team tab appears only while the agent/project has live physical child nodes.
Its badge counts those physical children, including projects; the Team list
itself includes all descendants. Hiring or retiring updates the tab live. If
the last physical child leaves while Team is open, an agent desk returns
to Chat and a project desk returns to Summary. A later hire does not reopen Team.

Desk tab selections are remembered per organization and node across restarts. An unavailable tab falls back to Chat. The shared memory rules and project Mail-folder behavior are documented in [orgtree-project-desk](../project-desk/SKILL.md).

Open an agent's desk from its name/card or desk navigation. A focused desk, a pinned canvas window and a detached window show the same agent identity and work tabs. Pinning fixes it in screen space; pop-out opens its window surface. These view choices are not agent lifecycle changes.

## Empty desk tabs and team defaults

Desk **Docket** and **Presented** tabs hide when neither the node nor its team has anything the tab would list under its default filters. A tab appears or disappears as content changes, but stays visible while you are on it; an empty tab disappears when you leave. Search and sorting do not hide tabs. If availability cannot be confirmed, the desk retains its last confirmed tab availability while retrying; an incomplete reply does not close the desk. The Docket check follows the existing list, including recently completed tickets during their one-hour window and attention exceptions. Show archived and Show backlogged include those groups when enabled. Presented starts with hired presenters; Show retired includes retired presenters.

When only the team has content, entering the tab starts with **Team** checked and auto-select works in that team scope. A manual untick is remembered for this organization and node across visits/restarts until own content arrives. Own content keeps the ordinary own-node default. Live arrivals do not switch the scope or selection of a reader you are using. These rules apply to both agent desks and project Presented tabs. A project Docket already lists its subtree and keeps that scope without a Team checkbox.

## In-chat media

Delivered files and message attachments show images inline and offer **Play video**
or **Play audio** for supported media in the desk, floating/pinned chat and pop-out.
Nothing plays or loads before Play. Native controls provide pause, seek and volume;
scrolling the card out of view, hiding the window or changing chat stops and releases
playback. Returning does not restart it. Composer staging and Files rows stay compact.

Video fits the chat width and stays at most 320 px tall. Playback is limited to
256 MiB per file; larger files remain downloadable. Supported containers are
MP4/WebM and MP3/WAV/Ogg/M4A/AAC/FLAC as Chromium supports; a codec or file failure
keeps Download with a clear fallback. Files remain behind ordinary org/node file
authorization; there is no direct filesystem or remote-media permission increase.
Play/pause/seek/volume are local presentation controls. Existing delivery,
`orgtree_files` and authorized file/shell/computer-use workflows provide agent parity.

## Badges

A **badge** is a small marker, separate from the containing agent/zoom card
and from composer controls. There are two named groups:

| Group | Meaning and members |
| --- | --- |
| **State badges** | Agent state shown on the desk header and zoom card: serving account; next-turn account, model, effort and fast mode; current effort; fast mode; frozen; halted; do-not-disturb (DND); Session 0. These are display-only; on a zoom card their clicks pass to the card's normal focus/select gesture. The serving-account badge retains its account/email native tooltip and matching accessible label, reachable by keyboard focus. Dedicated desk actions remain separate. Name an individual marker by kind, such as **next-turn model badge** or **Session 0 badge**. |
| **Header badges** | Desk-only setup and context: MCP tool count/readiness, cache forecast, held audiences, cost/spend (with rights/metadata in its tooltip), separately reported status and queued-message count. |

The renderer also shares reserve-route, secondary serving-account, limit-lock,
bearer-provenance and held-project-slot state badges between the desk and zoom
card. A waiting project-slot claim is a desk header badge and a separate canvas
watchdog satellite; it is not an extra shared zoom-card state badge. Audience
header badges include inherited project access and folded retired grantors.

Members are conditional, not guaranteed to appear together. At this documented
base the desk shows current effort alongside a queued effort change; the zoom
card can show a local effort override without one. The active fast mode bolt
is on the zoom card, while the desk has its composer toggle and queued fast
mode state badge. Halt state also appears in the shared status presentation.
The **Session 0 badge** appears on the desk header and zoom card when the
engine reports Session 0 placement. Null placement or signed-in placement hides
it; saved preferences alone never show it. Its native tooltip explains why:
signed out of Windows, sign-in helper did not connect in time, the agent's own
session choice, or its CLI still running background work. Older records without
a reason say **Runs in Windows Session 0**. A known placement time appears as
**Since** with the local date and time. Keyboard focus exposes the same text
as an accessible label. `orgtree_session` already reports placement to agents.

Other card furniture keeps its specific name: lifecycle/pinned/remote markers
can be zoom-only; retired-count badges open a list rather than report turn
state. The unstick button is a recovery action. Agent cards, zoom cards, jump
cards, presentation cards and document chips remain distinct objects. A badge
does not by itself prove a process is running or a queued change has applied.

These memberships follow the agent desk metadata row and the zoom card badge
row (canvas/desk.tsx, cards.tsx, nextturn.tsx, effort.tsx,
slotchips.tsx); the two group names follow the user's 2026-10-22 07:38Z ruling.

## Header controls

| Control/indicator | Meaning |
| --- | --- |
| Agent name | Identity/navigation target; available menus can copy the name. |
| DND | Toggles Do Not Disturb for the current turn, or arms **DND next turn** when idle. The opening batch still starts that turn normally. Turning it off releases all held mail now at native delivery boundaries, preserving size budgets. The agent itself and authorized superiors can clear it too; agent parity is `orgtree_status node=<agent> dnd=true/false` (runtime plus descendant authority). The inert DND state badge remains separate. Native hover text explains the non-urgent hold, urgent bypass and current/next-turn activation or release action. See orgtree-do-not-disturb in orgtree-working > runtime. |
| Model token | Opens Change agent model. A model stays offered when an eligible managed account can serve it even if the default login is unavailable or spent. A pick uses the default login when eligible, otherwise the first eligible compatible account reported by the engine; the model tooltip names that secondary account, as does a cross-provider confirmation. Picking saves immediately when idle or queues it while busy. Switching providers asks to reset the conversation; the current generation remains in lineage and scratch/mail survive. Selecting the current model cancels a queued model switch without changing its account. |
| Context wheel | Context occupancy/window and compact threshold; where available it opens Normal compact / Cheap compact / Cancel. Normal uses the harness; cheap starts a fresh session with a summary handoff on the same agent. Unsupported normal compaction is disabled with a reason. |
| Process indicator | Current process lifecycle, warming/relaunch/pause information and an enabled process action when the engine provides one. Starting the process from it, on an engine in Windows Session 0, starts the CLI where the agent's next turn would run: right after a restart it first waits for the sign-in helper, as a turn does, so the click can take a few seconds to answer. |
| Turn status | Engine turn activity/result and reported status summary; a self-reported status is not proof a process runs. |
| Halt / Finish halt / Unhalt | Distinguishes blocking admission, a turn still ending, and explicit release; use the shown state rather than repeatedly clicking. |
| Retire / dissolve | A live agent without live children offers retire; one with live children offers dissolve, each with confirmation. Native hover tooltips explain that retirement stops/archives the agent, dissolution includes its whole team, reserved credits are freed, and history/files are kept. |
| Rehire / dismiss | Retired desk actions; dismiss hides that retired view, rehire is a lifecycle operation. |
| Gear | Opens this agent's settings. |
| Pin, pop-out/window controls | Change the viewing surface rather than starting a different agent. |

The metadata row mixes header badges (MCP readiness, cache forecast, audiences, cost, queued-message count and separately reported status) with state badges (halt, freeze/limit, held slots and serving-account/route information). Queued account, model, effort and fast mode state badges describe pending configuration separately. Distinguish current versus “last” route/account evidence.

Audience header badges on agent and project desks show held access. For inherited
access, the native hover tooltip starts with **Inherited from project <name>**,
one line per source project, followed by the audience explanation. If the audience
is also held explicitly, it says **Also held explicitly**. Keyboard focus exposes
the identical text as an accessible label; it does not open a custom popup.
Explicit-only header badges keep their existing tooltip. Only an explicit grant
offers the personal Revoke button; inherited access is managed at its project.

Idle age measures time since the last completed turn ended, including killed turns, across every harness. Open or legacy records without a completion time retain their start-time fallback. Active time measures the current turn's admission; ordinary Antigravity mid-turn hook mail keeps that original active clock. The card and tray use the same idle reference. Halted and usage-freeze clocks retain their own timestamps. The idle, active and halted ages read on the common age scale (seconds, minutes, hours up to 36 hours, then days, weeks, months and years: 45s, 12m, 5h, 3d, 3w), and hovering one shows the full local date and time it counts from. A usage freeze's reset or wake countdown is not an age and keeps its own wording.

Freeze badges show the recorded cause/deadline/provenance rather than promising a guaranteed wake. The user unstick control is an explicit recovery override. For freeze mechanics see `orgtree-usage-freezes` (orgtree-working › accounts). For cache evidence see `orgtree-cache-continuity` there.

## Jump cards

The row above the conversation jumps up to the agent's superior; the row below jumps down to its reports, then its watchdogs. Projects pass through: an agent under projects gets an up card for its nearest agent superior and for each project in between (superior first, then outermost to innermost), and a report that is a project brings a card for each of its live members, through nested projects. A project's card shows a folder instead of a model letter. Long rows fold per **Collapse many jump cards on desks**.

The leading agent-superior or switchboard card stays outside that fold; only intervening project levels fold behind it. Expanded jump lists scroll after eight rows rather than growing indefinitely.

Jump cards show the spinning arrows while their destination agent is mid-turn.
A project jump card shows those same arrows whenever any live agent under it
is mid-turn, through nested projects and agents. The indicator stops when none
is active; a recorded Working status alone does not animate it. This applies
to superior and report cards in agent/project desks, including pinned and
separate windows.

## Composer banners

Send feedback such as **steering in mid-task** appears above the bottom report/watchdog jump cards, between the conversation and those cards. The jump cards remain above the message box. This changes the feedback's position, not its delivery meaning or dismissal behavior.

Halted/organization-stop banners identify the durable hold; waiting-for-turn-slot points to concurrency limits; model-loading reports startup work. Cache warnings describe send-time risk or configured compaction, not guaranteed provider behavior. Where the warning says a cheap-compact **will** happen ("sending will cheap-compact this session first", and the mid-turn "it will trigger a cheap-compact before delivery"), it ends in a **Turn off in settings** link; the "automatic cheap compaction is off" and "does not report" variants have none. The link opens the control that governs this agent, scrolled into view, focused and briefly highlighted: Org settings > Policies (see `orgtree-org-policies-compaction`), or, for an agent with its own explicit On override, that agent's Model tab (see `orgtree-agent-fresh-start`), since the org switch would not stop it. It works from a docked, pinned or popped-out desk, and lands in a settings panel that is itself pinned or popped out. A queued/compacting agent has no running steering window merely because it has pending work.

The separate Halt and Stop controls are consequential: Stop interrupts a response; Halt also blocks later wakes until explicitly released. View navigation itself does neither.

The focus-only mid-turn cache warning stays visible while focus is in the
composer or its warning link. Pointer activation preserves composer focus;
keyboard Tab reaches the link after the composer controls, and leaving that
whole area hides the warning. Its settings destination and warning conditions
are unchanged.

## Tabs and next destination

Tool-row output estimates use an I-beam token mark, `t`/`kt` and `~`; these
are separate from this header's input/context occupancy and provider usage.
See [tool-output counts](../desk-chat/SKILL.md#tool-output-token-counts) for
hover precision, thinking receipts and missing observations.
A message's card shows its own count after its time, and its delivery's last
card `+N` for the data hidden in the turn envelope; see
[token counts in messages](../desk-chat/SKILL.md#token-counts-in-messages-450).

- [Chat](../desk-chat/SKILL.md): conversation and composing.
- [Mail](../inbox-screens/SKILL.md): the agent's mailbox, with its inbox and sent folders.
- [Docket](../docket-screens/SKILL.md): its work items.
- [Presented](../presentations/SKILL.md): document collection.
- **Files**: a compact list of this agent's retained deliveries, oldest above
  newest. The tab opens at the bottom. Each row has filename, size, delivery
  time and Download; images also have View. Hover the filename for its note.
  Downloads use the original snapshot. Scroll up to load older files
  automatically, keeping the visible file in place. New files append below;
  the list follows them only while you are at the bottom. New deliveries update
  live in both canvas desks and popped-out desks, without pressing Refresh.
  Refresh returns to the newest page and scrolls to the bottom.
  Agents use orgtree_files (orgtree-working > inspection) for the same list.
- [Team](../../canvas/agents-list/SKILL.md): the same Agents List restricted to this node and all descendants, including its Filter, Active and archived controls. Project desks offer Team as well.

The shared agent/project context menu's **Open → Team** entry opens that node's Team panel. Team supports pinning and popping out through the existing window controls. Its saved window placement is tied to the organization, node and node generation, so a replacement identity does not inherit the old panel. Rows and membership follow the current feed; opening Team does not start another agent or turn.

Agent event history is available in the agent settings panel when the agent has retained records. Scratch folders open in the OS file explorer through **Open → Scratch folder** in the agent menu or **Open scratch folder** in the settings header.

Counts appear for Mail, Docket and Presented when nonzero. For configuration fields see [agent settings](../../agent-settings/agent-config/SKILL.md).

## Retired reports and slot holds

With retired agents hidden, the report-jump row keeps a retired-count badge for both agent and project desks. Click it, or choose Open retired list from its own menu, to search the retained reports and reveal one. This is navigation, not rehire.

Held-slot state badges and waiting-claim header badges name the project, show quantities for multi-slot claims and open that project's Slots panel when a route is available. Their hover gives held/waiting time; waiting-claim header badges also show line position. A grant notification and an active lease are separate facts: inspect the Slots panel to confirm what is still held.

## See also

- [orgtree-project-desk](../project-desk/SKILL.md)
- [orgtree-desk-chat](../desk-chat/SKILL.md)
- [orgtree-agent-config](../../agent-settings/agent-config/SKILL.md)
