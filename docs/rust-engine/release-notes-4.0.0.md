# Orgtree 4.0.0

Orgtree 4 replaces the Python engine with a new Rust engine, built for faster responses and lower CPU use while many agents work at once. [check: confirm the performance wording against release measurements.] The familiar workspace, desks, inboxes and mail hub remain. Your existing data upgrades automatically from 3.x or directly from 2.x on first start.

## New

- **Choose what Enter does.** App settings > Display > Typing lets you choose Send message (Enter sends; Shift+Enter adds a line) or Insert new line (Enter adds a line; Ctrl+Enter sends). The choice applies across message composers.
- **Adjust credits directly in agent settings.** Drag the grant bar or use its arrow keys, with the available range and credit breakdown visible.
- **Enable accounts individually.** Each subscription or API-key account has its own active checkbox. Disabling one lets its current turn finish and prevents new turns on it.
- **Watch engine events without polling.** Watchdogs can react to turns, mail, tickets, account limits and other events, including thresholds for the number of active agents.

## Improved

- Agent menus keep destinations and lifecycle actions together. Team and switchboard actions can halt or resume multiple agents together.
- Model and account switches retain the existing session where possible. A provider switch or fresh session gets a handoff summary, with the desk history saved in the agent's folder.
- Settings use consistent controls and shorter descriptions. Cost chips show the amount, with explanations of partial totals available on hover.
- The background engine, warmed agent processes, prompt-cache forecasts, external MCP connections and cross-organization mail remain available.

## Fixed

- Transcripts stay at the bottom while messages stream or cards change size. A small upward scroll releases following immediately; returning to the bottom resumes it.
- Failed history loads retry every five seconds, preserving your position and avoiding duplicate rows. Returning from another window no longer mistakes incoming messages for a failed history load.
- Cancelling a hire restores the previous canvas view and desk focus.
- Imported usage-limit pauses recover after their reset when automatic resume is enabled. Unread-mail counts and attention notifications retain their pending state reliably across restarts.

## Removed or changed

- **No separate agent generations or lineage panel.** Cheap compact and provider switches continue with the same agent, using a fresh session and saved history when needed.
- **A simpler docket.** Tickets, ownership, replies, history and note evidence remain. Acceptance checklists, captured verification receipts, separately granted artifacts, findings, review seats and packets, post-completion addenda, scope archives and reservation/landing slots are removed. Review and Approved are ordinary statuses. Earlier ticket owners no longer gain special access to each other's transcripts or scratch folders.
- **Audience requests go directly to the named recipient** for approval, rather than through each level of management.
- **Credit cascades stop at the acting agent's allocation.** They cannot raise that agent's own grant or grants above it.
- Codex Luna reserve routing, Fable-specific lock and limit/filter policies, remote session control and idle cache keep-alive pings are removed. Cache forecasts remain.
- Detailed cost/cache-break diagnostics and Codex version-drift reports are removed. Per-turn costs and tokens remain. Engine troubleshooting uses the new logs and debug counters.
- Agents can no longer restart or relaunch Orgtree through their tools. The primed-restart indicator and watchdog Supersede action are removed. Organization deletion still moves it to trash; permanent purge is removed.
- `/compact` remains locally supported; other slash commands are passed to the provider CLI. After an engine interruption, agents receive a continuation message; unfinished tool calls are not automatically reconciled. Mid-turn mail has one Delivered state.

## Upgrading

Install 4.0.0 and start Orgtree normally. The first start copies active organizations into the new database, including agents, settings, accounts, tickets, documents, watchdogs and supported mail/history records. Recent conversation history is loaded from the old transcript sources when you first open an imported desk. Historical logs and conversations are bounded; this is not a copy of every old record.

The import reads the old databases and files without modifying or deleting them. Successfully imported organizations are skipped on later starts; failed organization imports retry. The old data remains available for rollback by running the previous version. Changes made in 4.0 are stored separately and are not copied back into the older version's data.
