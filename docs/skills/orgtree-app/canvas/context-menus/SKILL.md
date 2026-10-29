---
name: orgtree-context-menus
description: Read the shared agent and project menus, their desk opening choices and lifecycle actions.
---
Up: [orgtree-canvas](../SKILL.md)

# Context menus

Ordinary **Hire a subordinate**, **Hire under this project** and **New project…**
drafts follow App settings > Display > Desk > **New hires go** (End by default).
They share the token workflow; confirming creates the node at that position.
See [draft hires](../draft-hires/SKILL.md).

## Shared object links

Mail **Copy contents** / **Copy message text** copies the complete message,
including folded text. Complete local bodies copy immediately; previews and
chunked bodies require a successful full lookup. If that lookup fails or any
required chunk is unavailable, the action says the full message is unavailable
and leaves the clipboard unchanged. It never silently substitutes a preview.

Links to the same kind of object use the same context menu and hover information across canvas cards, Chat and tool references, Mail, Docket, Presented, lists, and pinned or separate windows. Owner, Presenter, Project and Sender submenus use that object's shared identity actions too. Right-click the specific link for its object menu; right-click the surrounding row for the row's menu. A missing object or unavailable route can limit actions; reaching a menu grants no extra authority. The name-visible, icon-only and far-zoom tooltip rules are described under [agent-card identity](../agent-card/SKILL.md#identity-tooltips).

Document links show their full current title on hover, led by `Unread · ` for one you have never opened or `Modified since you last read it · ` for one replaced since you last opened it. Docket/ticket links show the current docket status label, then ` · `, then the ticket's slug, because the link already draws the full title (for example, `Open · project-card-resizes`; a ticket of another org reads `Open · org/project-card-resizes`). Archived tickets show `Archived`; an unknown or unreadable status leaves the slug alone. Each new hover or focus reads the exact ticket again, so a transcript's older status snapshot cannot become the tooltip's state. This same tooltip applies to every ticket identity, including mentions, tool rows, inbox and docket references, and menu identity links. File links show the full path and share file actions such as opening or revealing the parent folder when the host supports them. Mail references identify the exact mailbox message; Sender opens the sender's identity submenu. The @user chip identifies the user's inbox, rather than an agent: its menu offers Open inbox, Copy mention and, inside a live desk composer, Mention.

In every context menu that offers an **Open** submenu, it is the second action,
including nested node menus. The first action and the relative order of the
remaining actions stay the same. This also applies when Mention is first inside
a desk; Copy mention then follows Open. A plain Open action without a submenu
keeps its existing position.

Right-click a recognized object to open its menu. Copy actions come from that object's own identity attributes; an agent or project target supplies Copy mention (copying `@<name>`). Inside an agent or project desk with a live composer, any agent or project link (across Chat, Inbox, Docket, Presented, Team, header and jump cards) puts **Mention** first, above **Copy mention**, inserting `@<name> ` into the desk's message box at the caret (or appended when unfocused) and focusing the box without sending. Ticket links there (Chat and Mail references, tool-call ticket chips, the idle docket reminder's ticket cards) and Docket tab rows put **Mention** first too, above Open details: it inserts the ticket's reference, `@item:<org>/<slug> `, the same way. The menu then uses the same action definition on cards, Agents List rows, Team rows and other registered navigation surfaces, including the Attention view. Availability depends on the actual object state and the handlers its surface supports, so a missing action is not evidence that every build supports it elsewhere. Both agents and projects start Open with **Desk**, **Desk as a pinned window**, **Desk in a separate window**, in that order when supported. Team and the other entries follow below. Project menus offer Copy mention, Open (the three desk entries, Project mailbox, Team, Project folder, Project docket, Presentations → Team presentations), Focus, Hire under this project; inside a desk, Mention stays first and Open stays second, followed by Copy mention and those remaining actions. Other project actions include, New project… (hiring beside or above uses the card's hire tokens), Settings, and subtree compact/halt/retire actions.

| Agent-menu item | Meaning/gate |
| --- | --- |
| Project Open → Slots | One direct entry opens the standalone slots modal; present only while that project has slots > 0. Pin and pop-out are in the modal's standard controls and the slots tab's shortcut row, rather than a menu submenu. |
| Project Open → events | After Slots: opens the project's standalone events window (the events tab's view, with its **Register…** menu); present only while the project's **Project events** setting is on, as the tab is. Pin and pop-out are in the window's standard controls and the events tab's corner. |
| Focus | Navigate to the agent; present but disabled when this surface has no focus handler. |
| Hire a subordinate | Opens a tier's existing draft form, creating no seat until confirmation; offered for an eligible live card with free hire edges, not a pile front. With **Show legacy models** on, its tiers (and those of a project's **Hire under this project**) include Gemini Pro as `pro · legacy`. |
| New project… | Directly under Hire a subordinate (after Focus when no hire is offered): opens a draft project card under the agent, creating nothing until create. |
| Open → Desk | Temporary desk glance without changing focused agent/layout. |
| Open → Desk as a pinned window | Pin the desk, or raise its existing pinned canvas window. Second in the desk section for both agents and projects. |
| Open → Desk in a separate window | Detach the desk, or raise its existing native window. Third in the desk section for both agents and projects. |
| Open → Mail | The agent's own mailbox (the desk's Mail tab as a window). A project's entry is Open → Project mailbox. |
| Open → Team | The node itself and every descendant in the existing Agents List, with its filter and Active checkbox; also available as a desk tab, pinnable or popped out. |
| Open → Scratch folder | Existing local directory, offered on supported native surfaces for live/archived identities; missing paths error without creating them. |
| Open → Scratch folder → Team scratch folder | Submenu under Scratch folder when both are offered (inline under Open when only one exists); the team this agent leads, keyed by its numeric id even with no reports. Creates a missing managed folder on demand; supported native shells only. |
| Open → Docket | Agent-scoped work view when supported. |
| Open → Docket → Team docket | Submenu under Docket when both are offered (inline under Open when only one exists); work assigned to that agent or its descendants when supported. |
| Open → Presentations | Offered whenever the opener exists, regardless of current document count. Below Docket, for agents and projects alike. |
| Open → Presentations → Team presentations | Submenu under Presentations when both are offered (inline under Open when only one exists): the documents presented by that agent or by anyone below it, passing through projects, paged like the agent gallery; each row names the presenter. |
| Continue on <account> | Engine-supplied eligible alternatives for a live frozen agent; no invented account choices from the menu. |
| Dismiss | Hide an explicitly revealed retired card again, where the surface supports that action. |
| Settings | Open the agent or project settings surface (live or retired). |
| Acquire audience / Drop audience | Grant or revoke the agent's **user** audience. The label reflects whether `@user` is currently held; the action is offered on live agents where the surface supplies the handler. Acquire also approves a pending user-audience request. Revocation leaves already queued mail queued. |
| Compact… | Opens Normal compact (harness compaction), Cheap compact (fresh session with a summary handoff) and Cancel. Unsupported normal compact is disabled with its reason. Single-agent action remains disabled while busy or without a session. Managers offer Compact subtree… / Compact all subordinates…. The latter covers descendant agents at every depth and excludes the selected manager. These and the project/root bulk entries open the shared two-action confirmation: compact N agents and cheap-compact N agents, plus Cancel, with count-only acting/skip summaries and no radios, chips or expanders. Hover each summary for every covered name. Mid-turn and no-measured-context lines appear under both modes with hover names; other shared reasons appear once below modes. Normal-only reasons stay under Normal. Each zero-target action is disabled; Normal checks support on opening and stays disabled while pending, without blocking eligible Cheap. Nothing runs until its button is clicked; Cancel does nothing. Busy seats are skipped, and a Normal refusal is never reported as completed. |
| Halt / Unhalt | Direct stop/release has no ellipsis. Halt… / Unhalt… means an actual team submenu offers subtree/**all subordinates** (descendants, excluding the selected root); read counts and partial outcome messages. |
| Retire… / Dissolve… | Retire a leaf or explicitly dissolve a manager's subtree; the **all subordinates** submenu leaves the manager live while retiring live descendant agents at every depth. Confirmation states the selected scope. |

Some rows are submenu roots with distinct click and expansion behavior; read their visible effect and count. Do not infer a new management power from the same menu being reachable on a second surface. Tool-side authority and parameters live in `orgtree-team` (orgtree-working › team) and `orgtree-runtime` (orgtree-working › runtime).

The user-root menu has a different organization-wide scope; see [user node](../user-node/SKILL.md). Pinned frame title bars also have menus for returning/opening windows, pinning and close; see [pinned windows](../pinned-windows/SKILL.md). A copy action copies the displayed object's identity and does not execute a path or modify the object.

## See also

- [orgtree-agent-card](../agent-card/SKILL.md)
