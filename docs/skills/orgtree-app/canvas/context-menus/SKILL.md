---
name: orgtree-context-menus
description: Read the shared agent and project menus, their desk opening choices and lifecycle actions.
---
Up: [orgtree-canvas](../SKILL.md)

# Context menus

Right-click a recognized object to open its menu. Copy actions come from that object's own identity attributes; an agent or project target supplies Copy mention (copying `@<name>`). The menu then uses the same action definition on cards, Agents List rows, Team rows and other registered navigation surfaces, including the Attention view. Availability depends on the actual object state and the handlers its surface supports, so a missing action is not evidence that every build supports it elsewhere. Both agents and projects start Open with **Desk**, **Desk as a pinned window**, **Desk in a separate window**, in that order when supported. Team and the other entries follow below. Project menus offer Copy mention, Focus, Open (the three desk entries, Project mailbox, Team, Project folder, Presentations → Team presentations, Project docket), Hire under this project, New project… (hiring beside or above uses the card's hire tokens), Settings, and subtree compact/halt/retire actions.

| Agent-menu item | Meaning/gate |
| --- | --- |
| Focus | Navigate to the agent; present but disabled when this surface has no focus handler. |
| Hire a subordinate | Opens a tier's existing draft form, creating no seat until confirmation; offered for an eligible live card with free hire edges, not a pile front. |
| New project… | Directly under Hire a subordinate (after Focus when no hire is offered): opens a draft project card under the agent, creating nothing until create. |
| Open → Desk | Temporary desk glance without changing focused agent/layout. |
| Open → Desk as a pinned window | Pin the desk, or raise its existing pinned canvas window. Second in the desk section for both agents and projects. |
| Open → Desk in a separate window | Detach the desk, or raise its existing native window. Third in the desk section for both agents and projects. |
| Open → Inbox | The agent's own mailbox. |
| Open → Team | The node itself and every descendant in the existing Agents List, with its filter and Active checkbox; also available as a desk tab, pinnable or popped out. |
| Open → Scratch folder | Existing local directory, offered on supported native surfaces for live/archived identities; missing paths error without creating them. |
| Open → Scratch folder → Team scratch folder | Submenu under Scratch folder when both are offered (inline under Open when only one exists); the team this agent leads, keyed by its numeric id even with no reports. Creates a missing managed folder on demand; supported native shells only. |
| Open → Docket | Agent-scoped work view when supported. |
| Open → Docket → Team docket | Submenu under Docket when both are offered (inline under Open when only one exists); work assigned to that agent or its descendants when supported. |
| Open → Presentations | Offered whenever the opener exists, regardless of current document count. |
| Open → Presentations → Team presentations | Submenu under Presentations when both are offered (inline under Open when only one exists): the documents presented by that agent or by anyone below it, passing through projects, paged like the agent gallery; each row names the presenter. |
| Continue on <account> | Engine-supplied eligible alternatives for a live frozen agent; no invented account choices from the menu. |
| Dismiss | Hide an explicitly revealed retired card again, where the surface supports that action. |
| Settings | Open the agent settings surface. |
| Acquire audience / Drop audience | Grant or revoke the agent's **user** audience. The label reflects whether `@user` is currently held; the action is offered on live agents where the surface supplies the handler. Acquire also approves a pending user-audience request. Revocation leaves already queued mail queued. |
| Compact… | Opens Normal compact (harness compaction), Cheap compact (fresh session with a summary handoff) and Cancel. Unsupported normal compact is disabled with its reason. Single-agent action remains disabled while busy or without a session. Managers offer Compact subtree… / Compact all subordinates…. These and the project/root bulk entries open the shared type picker: Cheap is selected by default; Normal previews supported targets and skipped reasons. Nothing runs until confirm; Cancel does nothing. Busy seats are skipped, and a Normal refusal is never reported as completed. |
| Halt / Unhalt | Direct stop/release has no ellipsis. Halt… / Unhalt… means an actual team submenu offers subtree/all subordinates; read counts and partial outcome messages. |
| Retire… / Dissolve… | Retire a leaf or explicitly dissolve a manager's subtree; submenu can leave the manager live while retiring all subordinates. Confirmation states the selected scope. |

Some rows are submenu roots with distinct click and expansion behavior; read their visible effect and count. Do not infer a new management power from the same menu being reachable on a second surface. Tool-side authority and parameters live in `orgtree-team` (orgtree-working › team) and `orgtree-runtime` (orgtree-working › runtime).

The user-root menu has a different organization-wide scope; see [user node](../user-node/SKILL.md). Pinned frame title bars also have menus for returning/opening windows, pinning and close; see [pinned windows](../pinned-windows/SKILL.md). A copy action copies the displayed object's identity and does not execute a path or modify the object.

## See also

- [orgtree-agent-card](../agent-card/SKILL.md)
