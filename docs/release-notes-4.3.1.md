# Orgtree 4.3.1

Orgtree 4.3.1 keeps agents working before Windows sign-in and gives them desktop access when you sign in. It also adds canvas backgrounds, independent active-agent filters, clearer session and context information, and fixes for desks, pinned panels and popped-out windows.

## Windows startup and desktop sessions

- **One Run on boot switch** replaces the separate boot/sign-in engine choice on all-users Windows installations. The engine can run before sign-in, while new agent turns use your signed-in desktop session when the helper is available. Turning the switch off disables automatic startup. Installations without boot support use **Run on sign-in** instead.
- **Desktop session preferences** in Agent settings let an agent prefer a signed-in session or the background session. Agents can inspect available sessions and request a different placement for their next turn. This applies across the supported harnesses.
- Session changes take effect at turn boundaries. Signing in does not forcibly move a running turn; a process holding background work keeps its placement until that work allows a move. Agents receive sign-in, sign-out and session-change notices.
- If signing out cuts off a hosted turn, Orgtree starts a continuation in an available session. The sign-in helper recovers when it is missing, and its administrator setting follows **Run Orgtree as administrator**.
- Upgrading converts either former automatic engine-start choice to Run on boot enabled; a disabled startup setting stays disabled.

## Canvas, panels and conversations

- **Shift+F6** fits the organization in view, **Shift+F7** returns to the last desk, and **Shift+F8** focuses the switchboard. These navigation shortcuts also work with pinned panels.
- **Middle-button panning works over real desk content**, including headers, transcripts and composers, in both layouts. Pinned frames keep their positions, and left/right actions and wheel scrolling keep their usual behavior.
- Ring reorder previews now sit beside the first or last agent instead of far away in the empty arc. Between-agent previews and the resulting order are unchanged.
- Presentations and docket panels accept arrow navigation immediately on opening. Popped-out presentation and inbox sidebars respond to their own window's width after moving between windows or resizing.
- Provider-reported context compaction has a live **compacting for** timer in the transcript. Opening the human inbox selects the oldest unread mail, or the oldest unanswered request when there is no unread mail.

## Filters and Quick chat

- **Active-only filters** show agents currently running a turn, retaining ancestors for context. The canvas Agents list, Quick chat superior picker and Attention desk each remember their own filter choice independently.
- Each filter checkbox sits beside the search box of the list it filters, including when pinned or popped out.
- Quick chat preserves the selected superior when a filter hides that agent, rather than silently changing the selection.

## Backgrounds and EPIC Mode

- **Canvas backgrounds** in Display settings add line and hex grids, Checkerboard, and outlined square, triangular and hexagonal tiles alongside the original dot grid. Each background remembers its own intensity and uses the current theme's colors.
- **Claude Waves** adds an animated, pointer-responsive backdrop. It adapts to zoom, pauses when hidden, supports reduced motion and recovers from graphics-context loss or heavy load. It requires hardware WebGL2.
- Optional **EPIC Mode** gains lingering effects, session progression and an urgent-mail alarm. Its combo display stays in a small corner badge, and typing sparks follow the caret across wrapped lines.
- EPIC Mode remains off by default. Reduced-motion settings suppress shake and blur; effects stop when the mode is switched off.

## Models and providers

- Antigravity model lists group Claude and Gemini families consistently across hiring and provider settings, with model ordering aligned between those surfaces.
- **Gemini 4 Argon medium effort** is selectable and retained for the next turn when the account offers it. Model and effort availability still depend on the selected account.

## Agent tools and shared workspaces

- **Session controls** through `orgtree_session` tell agents where their current and next turns run. An agent can interrupt its own turn and request one immediate restart when no background work is running. Watchdogs can react to sign-in and sign-out events.
- **Next-turn inspection** through `orgtree_next_turn` reports instruction-prefix changes and available compaction evidence. Missing evidence stays unknown; the answer does not promise a prompt-cache hit.
- **Working checkups** can wake a quiet working agent after about 20 minutes even without a docket item. Docket reminders remain separate, and sign-in can prompt an earlier checkup for working agents waiting in the background session.
- **Organization Logo tools** let agents set or remove their organization's picture when the Logo tool group is enabled, which is the default. Changes identify the agent and can be undone or redone through the existing history.
- Agent menus can acquire or drop the agent's audience with you. They also open the agent's team scratch folder; the switchboard and organization settings can open the organization's shared scratch folder.
- The built-in Orgtree skill library also recognizes **glossary** and **Orgtree Encyclopaedia** as names for the same guides.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
- Muse write agents running in the Windows background session still run without Muse's OS sandbox. Hosted Muse agents use its sandbox in the signed-in session. Harness capabilities and model availability continue to differ by account and platform.
