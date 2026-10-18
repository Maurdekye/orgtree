# Context menu parent actions

User rulings, 2026-10-18 14:25Z, 14:34Z and 17:14Z, Orgtree 4.4.0:

- Agent and project **Open** parents open the same temporary desk as their
  **Desk** child when clicked or activated with Enter, and close the menu.
- **Hire a subordinate**, **Hire under this project** and the switchboard's
  **Hire an agent** open the existing hire draft with the current org's
  Quick chat tier selected, using the same callback as that tier's child.
  They create no seat until the user confirms the form. Their tooltips explain
  this shortcut and the tier submenu. The parent remains the selected agent,
  project, or top level respectively; the shortcut does not focus Quick chat.
- Hover and ArrowRight continue to expand either parent's submenu without
  running its action. With no temporary-desk handler, Open only expands.
  With no remembered/template Quick chat tier, or with that tier not offered
  in the existing hire choices, Hire only expands. It does not substitute a
  different model.

`NestedMenuItem` already supports actions on submenu parents. The canonical
agent/project builders set `submenuOnly` according to the available action;
no menu event or keyboard algorithm changes. The canvas's shared row menu and
agent/project card and switchboard read `readQuickChat(slug, tree.quick_chat)` when their menu opens,
so changes after mounting are honored. Existing per-org, template and app-wide
choice precedence remains in `quickchat.ts`.

The focused renderer tests exercise actual context-menu click/Enter, hover,
ArrowRight/focus and child selection, unavailable-action controls, tooltip
copy and actual card choice wiring. They use synthetic nodes and callbacks;
they do not create agents or use live data.

Project row/header/mention menus share the canonical project builder. Canvas
hire tokens and explicit tier children retain their draft callbacks. The
existing draft and engine retain parent-specific credit charging, top-level
grant defaults, model/account validation and project audience inheritance.
