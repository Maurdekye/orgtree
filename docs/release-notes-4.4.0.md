# Orgtree 4.4.0

Orgtree 4.4.0 adds Projects: free containers with shared work queues, concurrency slots and event listeners. It also brings native MQTT and WebSocket watchdogs, richer transcripts, more flexible desk windows, and a consistent Windows background engine with agents hosted in the signed-in session.

## Projects and watchdogs

- **Projects organize agents without taking a seat**, with a Summary, folder, mailbox, presentations and desk. Reporting and credits pass through; the project docket shows its team's work.
- **Fair mail queues** distribute jobs with batches, optional acknowledgments, reminders, reclaim and dead-letter retry/drop controls. **Concurrency slots** reserve limited capacity in first-come order, including several slots in one lease.
- **Project Events**, with an **events** desk tab, lets agents wait for project signals or listener counts. Watchdogs can run authorized tool actions when they fire. Project tables show waiting/holding times, linked jobs, recent fires and older history as you scroll.
- **You can participate too:** hold slots, join queues, acknowledge jobs and register listeners from the desk. Its composer sends to the queue or broadcasts, warning when nobody is listening.
- **Native MQTT and WebSocket watchdogs** manage subscriptions, credentials, reconnection and connection status. Agents can publish or send through an existing connection. Connection messages default to passive notices, with wake or off available.
- **Usage watchdogs** watch cached allowance changes without extra provider requests. Larger watchdog inventories expand into paged lists; already-satisfied one-shot requests return their effects immediately.
- Project audiences reach direct live members, with inherited sources visible. A manager or project can turn off direct sibling mail while preserving hierarchy communication.

## Windows sessions and Run as admin

- The **Windows boot engine** stays in Session 0 through boot, updates, restarts and recovery. A sign-in helper hosts turns in the signed-in session whenever reachable; signing out resumes interrupted work in Session 0. Desks and cards show actual placement.
- After a restart, **process warm-up and manual starts wait for the sign-in helper** under the same bounded grace as turns. With warming enabled, eligible idle Session 0 processes move to the signed-in session at sign-in, up to three at once, respecting session choices and background work. Codex reuses processes only in the selected session.
- **Run as admin** in Settings and the tray changes the engine and helper together, with one Windows permission prompt per change and no repeated prompts on later starts. The change restarts the engine; restart notices report measured rights, and failed setting changes explain why.
- **Run on boot** controls automatic startup triggers. Turning it off leaves explicit starts and recovery available. Per-user Windows installations and other platforms retain their sign-in startup route.

## Canvas and windows

- Consecutive project wrappers form compact **project bunches**, with display options for bunching and rearrangement. Retired piles load lazily and support name search.
- **Several panels of one kind can coexist**, with their own pins, pop-outs and placement. Document links reuse an appropriate global, node or team reader. App settings can pin or pop out too.
- Desks remember their last tab, Mail replaces the Inbox tab name, and Team views extend navigation, docket and presentations to descendants. Long jump rows scroll; tab pop-outs inherit the originating geometry.
- Links share menus and tooltips, files offer native actions, and ticket hovers include status. Light-theme contrast, card sizing and retired badges are more consistent.

## Desks and conversations

- **Expanded Claude helper calls show first-level live transcripts**, including supplied thoughts and tools. Nested helpers and uncaptured history retain ordinary details.
- **Antigravity completed-step thinking** appears before its response, and tools gain file/object references. Supported shell calls show live output; tool rows show approximate output-token counts and context can update mid-turn.
- **Offline LaTeX and guarded image embeds** work on shared Markdown surfaces. Presentations highlight unread/changed documents and open at the oldest unread entry.
- **Normal and cheap compaction** share clear single-agent and bulk choices with capability checks and skip reasons. Native Claude/Codex context overflow gets one summary-based fresh-session retry.
- Composers grow with messages and accept pasted files in replies. Scratch opens in the file explorer; event History moves to settings. Optional EPIC Mode adds activity sounds, heat and a tray mute.

## Accounts and models

- **Credit cost bubbling** in **App settings > Runtime** has two default-on switches for your own hires, allocations and model upgrades across all organizations. Agents always pass these costs up the chain within their grant limits, regardless of the switches.
- **Fast mode** requests native faster inference on supported Codex/Claude models, with per-agent controls and hiring defaults. Current speed and queued intent are distinguished; entitlement and additional usage remain provider decisions.
- Click a model icon to choose from the shared model tree. Choices save immediately; running turns show queued changes in header badges. Menus respect runnable accounts and credits, and selecting the current model cancels a queued switch.
- Antigravity account setup explains its one-subscription-sign-in-per-Windows-user limit and offers the supported API-key path. Registered profiles cannot silently use another login.
- Usage history has a compact sticky header, clearer account filters and a projected-ahead slider. Long gaps draw steps instead of misleading slopes. Local inference providers are labeled **Language model servers**.

## Mail, mentions and Hubchat

- **Custom mail tags** support combined filters across retained history. Inbox/Sent lists page older mail; leaving opened user mail marks it read. The inbox remembers its selection and offers deletion.
- Plain user mentions produce Attention entries and notifications across prose, mail, documents and docket items. Urgent mail has a distinct highlight; DND holds non-urgent mail until turn end.
- Supported OpenCode installations receive mid-turn mail after native tool calls. Codex MCP permission requests appear as human request cards instead of being automatically declined.
- The taskbar offers recent organizations, Home and New organization, plus an attention dot. The tray scrolls recent organizations. Human hub conversations continue in the separately released Hubchat app.

## Templates and standalone use

- **Heavy dev shop** supplies a large mixed-model development team, Liaison/coordinator roles and a build-slot project. Liaison and Developer charter presets clarify those roles.
- Templates can include projects and opt-in AGENTS.md copies, previewed without overwriting existing notes. Compact instructions, per-harness skills and expanded workflow guides reduce repeated setup.
- **Standalone engine mode** adds token authentication, configurable listening and persistent storage, with selected user MCP actions and Docker build assets. Provider sign-in remains separate.

## Fixes

- Sign-out detection is more reliable while Windows closes a session.
- Hardened private-content and credential logging, project-mail authorization, queue fairness, event delivery and stale-claim handling.
- Repaired window restoration, pinned reader selections, cross-window controls, exact mention/read identities and full-body copy failures.
- Corrected provider reset/account evidence, conditional Antigravity model retention, queued-model fast validation and completed thought timing. Reduced inbox/card flicker and repeated rendering during streaming.

## Upgrade notes

- Database migrations apply automatically on startup. Keep a pre-upgrade data backup if you need to return to an older version; there is no automatic reverse migration.
- Existing organizations keep their effective automatic-compaction policy. **New organizations default to automatic cheap compaction at 25%**, unless an explicit app or template choice overrides it.
- Previous per-organization and new-org-default credit-bubbling values are ignored. The two app-wide Runtime switches default on and affect only your own actions.
- Existing project listeners remain enabled through migration; new projects default **Project Events** off. Older network watchers adopt passive connection notices. Existing panel placements migrate to target-specific records.
- Review copied standing notes before sharing a template. Standalone Docker execution and real headless provider turns retain verification gaps.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
