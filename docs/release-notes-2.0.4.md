Orgtree 2.0.4 improves pinned windows, retirement responsiveness and message delivery, and adds control over automatic updates and account fallback.

- Pinned agents and panels share one ordering system: newly pinned or clicked windows rise to the front, including with many pins open. Unpinned dialogs stay above them.
- Background reminder checks skip archived agents before loading their records, removing repeated work that delayed UI refreshes in large organizations.
- Pending messages with confirmed mail identities stop briefly duplicating their delivered copies.
- Automatic updates have an app-wide toggle, on by default, in Settings and the tray menu. Manual update controls remain available.
- Automatic account fallback is off by default, with an organization default and per-agent On/Off/inherit controls. After a usage limit, Claude and Codex agents can move to a registered account with freshly verified capacity for the same lane, resume the interrupted task, and keep the replacement account. Paid API-key targets are excluded. Antigravity cannot select a separate account per agent and does not support this option. Switching accounts changes the provider cache namespace; Codex also crosses a session boundary.
- The README now includes installation, first-run, provider, workspace, update and V1 migration guidance.
