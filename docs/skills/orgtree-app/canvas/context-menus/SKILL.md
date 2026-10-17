---
name: orgtree-context-menus
description: Read the shared agent menu and its state-dependent navigation, placement and lifecycle actions.
---
Up: [orgtree-canvas](../SKILL.md)

# Context menus

Right-click a recognized object to open its menu. Copy actions come from that object's own identity attributes; an agent-name target can supply Copy agent name. The menu then uses the same agent-action definition on cards, list rows and other registered navigation surfaces. Availability depends on the actual object state and the handlers its surface supports, so a missing action is not evidence that every build supports it elsewhere.

| Agent-menu item | Meaning/gate |
| --- | --- |
| Focus | Navigate to the agent; present but disabled when this surface has no focus handler. |
| Hire a subordinate | Opens a tier's existing draft form, creating no seat until confirmation; offered for an eligible live card with free hire edges, not a pile front. |
| New project… | Directly under Hire a subordinate (after Focus when no hire is offered): opens a draft project card under the agent, creating nothing until create. |
| Open → Open desk | Temporary desk glance without changing focused agent/layout. |
| Open → Open desk in a new window / Show desk window | Detach a desk, or raise its existing native window. |
| Open → Pin desk as a window / Show pinned window | Pin or raise its canvas window. |
| Open → Open inbox | The agent's own mailbox. |
| Open → Open scratch folder | Existing local directory, offered on supported native surfaces for live/archived identities; missing paths error without creating them. |
| Open → Open team scratch folder | Immediately after personal scratch; the team this agent leads, keyed by its numeric id even with no reports. Creates a missing managed folder on demand; supported native shells only. |
| Open → Open docket | Agent-scoped work view when supported. |
| Open → Open team docket | Work assigned to that agent or its descendants when supported. |
| Open → Open presentations | Offered when the agent has presented documents and the opener exists. |
| Continue on <account> | Engine-supplied eligible alternatives for a live frozen agent; no invented account choices from the menu. |
| Dismiss | Hide an explicitly revealed retired card again, where the surface supports that action. |
| Settings | Open the agent settings surface. |
| Acquire audience / Drop audience | Grant or revoke the agent's **user** audience. The label reflects whether `@user` is currently held; the action is offered on live agents where the surface supplies the handler. Acquire also approves a pending user-audience request. Revocation leaves already queued mail queued. |
| Compact… | Opens Normal compact (harness compaction), Cheap compact (fresh session with a summary handoff) and Cancel. Unsupported normal compact is disabled with its reason. Single-agent action remains disabled while busy or without a session. Managers offer Cheap compact subtree… / Cheap compact all subordinates…; busy seats are skipped by bulk processing. |
| Halt / Unhalt | Direct stop/release has no ellipsis. Halt… / Unhalt… means an actual team submenu offers subtree/all subordinates; read counts and partial outcome messages. |
| Retire… / Dissolve… | Retire a leaf or explicitly dissolve a manager's subtree; submenu can leave the manager live while retiring all subordinates. Confirmation states the selected scope. |

Some rows are submenu roots with distinct click and expansion behavior; read their visible effect and count. Do not infer a new management power from the same menu being reachable on a second surface. Tool-side authority and parameters live in `orgtree-team` (orgtree-working › team) and `orgtree-runtime` (orgtree-working › runtime).

The user-root menu has a different organization-wide scope; see [user node](../user-node/SKILL.md). Pinned frame title bars also have menus for returning/opening windows, pinning and close; see [pinned windows](../pinned-windows/SKILL.md). A copy action copies the displayed object's identity and does not execute a path or modify the object.

## See also

- [orgtree-agent-card](../agent-card/SKILL.md)
