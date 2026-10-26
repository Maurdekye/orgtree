# Orgtree 4.4.5

Orgtree 4.4.5 adds an offline Changelog and an agent Files tab, makes hiring and settings easier to use, improves navigation and text editing, and expands what you can manage through the standalone engine.

Watch [Orgtree School 1: Introduction](https://youtu.be/c2SF2xMG0uk) (8:43) for a guided tour of Orgtree's workspace and agent workflow.

## Navigation and desktop

- **A Changelog inside the app.** Open **Changelog…** from the Orgtree menu to read every published release's notes offline. A narrow list shows versions in bold with their release date and time below; select one to read its notes. The panel can be pinned or popped out in an organization window.
- **See what changed after an update.** The Changelog opens on the first start after an update that brings a newer published release. Fresh installations do not open it automatically. Its **Show this every time** checkbox and **App settings > Display > Startup > Open changelog after updates** control the same preference; you can always open it from the menu.
- **Shift+Alt navigation remembers the last desk.** With no desk focused, arrow navigation continues from the last available agent or project desk in that org. Fit and overview keep that memory. Consecutive jumps also keep working through automatic composer focus and after a pointer release outside the window.
- **Shift+Alt+Space works on Windows without opening the system menu.** Plain Alt+Space keeps its normal Windows behavior. Navigation command tooltips show their shortcuts; agent and project links keep their identity tooltips.
- **Long agent names show in full on hover at normal zoom again**, including while another desk is open or popped out into its own window. Far-zoom nodes and desks keep hiding the plate while a desk is open.
- **The taskbar attention dot matches Hubchat**, with a red centre, a light rim and no number. It still follows unresolved attention rather than ordinary unread mail.

## Hiring and settings

- **Choose where new agents and projects go.** **New hires go** offers Centre, Start and End. Centre is the default when no choice was saved; an existing choice is kept. It places the new node just after the middle of its live direct siblings, including projects. Explicit side/above placement and existing nodes keep their ordering.
- **Keep your view after hiring.** Turn off **Open desk after manual hire** to stop a canvas hire or Quick chat from jumping to the new desk. The agent is still hired and Quick chat still sends its task. The option starts on.
- **Draft settings match an agent's settings tabs.** Configure instructions, model/version, effort, account/fallback, credits, session, folders and tools before hiring. Changes stay in the draft as you edit or switch tabs; only Hire or Create creates the node. Creation preferences are stored together before the agent starts.
- **Draft settings have a reachable header X.** Closing them keeps staged changes. Project settings fit their content and scroll when space is short.
- **Organization settings and organization defaults save ordinary edits automatically.** Choices save immediately and text/numbers after a short pause. **Org charter** keeps its own explicit Save; closing does not publish unsaved charter edits. Agent settings retain their existing Save behavior.
- Settings labels use sentence case. The effort control clears its hover preview when you release a choice, so its label follows the selected level.

## Messages, transcripts and files

- **An agent's Files tab keeps its delivered downloads together.** Compact rows show filename, size and delivery time, with Download and image View actions. The tab opens at the newest files at the bottom; scrolling up loads older deliveries. New deliveries appear live and follow only while you are at the bottom. Downloads use the delivered snapshot. Agents can list their own or a descendant's deliveries with `orgtree_files`.
- **One separator folds all undelivered mail**, including system notices and messages still sending. Click the arrow/count line itself. Current-turn input and the live reply remain visible; the count appears only once.
- **Text menus include spelling and familiar edit commands.** Right-click editable text for the default spellchecker's suggestions and Add to dictionary, plus Undo, Redo, Cut, Copy, Paste, Delete and Select All where available. Rich text also offers Paste as plain text. Read-only selections keep Copy, Select All and Reply to selection.
- **Selection menus open beside the pointer** in canvas, floating, pinned and popped-out desks, including passages inside transparent text wrappers.
- **New Codex and Muse thinking rows retain their measured durations**, including sealed thoughts where timing is supplied. Missing starts and older rows remain unknown; a duration does not reveal hidden thought text.
- **Read token estimates measure the returned content**, rather than a short display summary or the file's total line count. Counts remain estimates; retained slices and large-output sampling keep their existing limits.
- **One-time agent mail can omit a new reply audience.** Agents can use `one_time:true` for a message or passive notice to a same-org agent or project. The delivered header explains that it granted no reply audience. Existing access is preserved; ordinary desktop mail is unchanged.

## Accounts and reliability

- **Claude usage retries respect cooldowns.** Repeated throttling backs off from a minute through 2, 4, 8 and 15 minutes, honoring longer provider waits. Transient failures keep the backoff; a successful reading resets it. Old observations keep their date.
- **Automatic account fallback can use native Claude and Codex sign-ins** even without an extra registered account row. Registered subscriptions are considered first, then an eligible native login, then any separately permitted paid keys. Fresh capacity and existing account/org permissions still apply; fallback remains opt-in.
- **Credential lookups have coordinated time limits**, and local `gh help` and `gh --version` no longer wait for authentication they do not need.

## Installation and updates

- **A failed update no longer leaves Orgtree unable to start.** Setup now registers its background tasks turned off and turns them on only once the installation has finished. If an update fails or stops partway, Setup restores both tasks to how they were and records the error in `orgtree-installer.log`.
- **A disabled background-engine task is reported instead of waiting.** Orgtree shows the reason with **Retry** and **Quit**. To repair, run Setup again as administrator, then choose **Retry**.

## Standalone engine

- **Give each client its own token.** Create, list and revoke named tokens through authenticated HTTP or the orgless user MCP endpoint. Revoking one disconnects that client's existing HTTP, WebSocket and MCP connections. Tokens have user authority; keep them private.
- **More administration through user MCP.** Manage tree moves, ordering, retooling, rehires and credits; discover and answer pending questions, credit/scope requests and native permission forms; read or configure supported org/default/runtime/provider settings; and manage supported provider accounts and keys. These use the existing user-operation checks. Unsupported agent-mail options and agent-only tools remain refused.
- **Private inputs stay out of responses and query diagnostics.** Account credentials and private form answers use private request boundaries; database query parameter dumps are omitted from engine logs.
- **Improved Linux and Docker operation.** The standalone image uses PostgreSQL 17 and supports bounded-memory compilation. The operator guide covers direct Linux/WSL operation and provider login over SSH, with managed profiles kept in persistent storage. Native provider login remains a separate step from creating an account row.

## Notes

- The agents' glossary and user guides were reviewed against the changes since 4.4.4. Three small documentation gaps were corrected; no larger documentation gaps were deferred.
- Windows builds remain unsigned. macOS and Linux desktop builds remain prototypes. Downloads include `SHA256SUMS.txt`.
