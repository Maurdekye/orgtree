# Workspace: organizations, canvas and windows

[Documentation](../README.md#documentation) · [Previous: Getting started](getting-started.md) · [Next: Managing agents](managing-agents.md)

The canvas is a place to build a team. This page covers everyday navigation, finding a busy agent and keeping the right work in view. You can use several organizations without combining their conversations or work records.

## Open an organization

The homepage lists your organizations, with hired and active agent counts. Choose one to open it; an organization already open in another main window is brought forward. With a longer list, use the name filter. A loading or unavailable row is different from an empty organization: use its Retry action if the read failed.

The **Orgtree** application menu provides **New window**, **Open organization**, **Create new organization**, **App settings**, **Usage** and **Usage history**. You can switch organizations through that menu without returning to the homepage. App settings apply across the application; Organization settings apply to the selected organization.

## Read the canvas

The **YOU** eye card is the human root. Agents appear below their superiors; projects group work inside the tree. A card's model mark identifies its tier, while its status, busy indicator and badges explain its current state. Hover a badge for its meaning before acting on it.

Three things can differ:

- **Busy** means an agent is currently running. The elapsed timer is time spent, not an estimate of time remaining.
- **Working, done or blocked** is an agent's own reported status. A working agent can be between turns.
- **Queued, halted or frozen** explains why it is not running now: waiting for a turn slot, deliberately stopped, or stopped by a provider limit.

An agent's context wheel describes conversation occupancy. It is separate from provider usage limits and organizational credits. Current serving model/account information can also differ from a change queued for the next turn. See [Settings and usage](settings-and-usage.md) for those displays.

The **Agents** list helps find agents in a large tree. Search rather than panning through every branch. Archived inclusion and the **Hide retired agents** display option control whether retired cards clutter the canvas; they do not rehire anyone. By default retired cards remain visible, marked **Archived**. When hidden, a retired badge/list lets you find them again.

The list's **Active** filter means currently mid-turn, not merely reporting “working.” Dim ancestor rows can remain to show a matching agent's place in the tree. A desk's **Team** list uses the same controls within that subtree. A crowded-team stack or retired pile is only a display grouping: open its picker to bring another member forward. With retired agents shown, two or more retired siblings form a counted pile once a representative has loaded, with the latest retiree normally in front; a single retiree has its own card. Hidden workers keep their identities, conversations and capacity. The retired pile's **Delete all** confirmation covers the entire pile, even with a name filter active; it is different from hiding the pile or choosing its front.

The full tree preserves deeply nested project chains. Bunching or folding changes the display, rather than cutting off the reporting chain or the agents below it. In a Team tab, the badge counts immediate physical children, including projects, while the list covers descendants.

## Move around

Drag empty canvas space to pan, and use the wheel over the canvas to zoom. Middle-drag also pans when you begin over a card or desk. The wheel inside a scrollable desk or list scrolls that surface instead. Pinned windows keep their screen position while the canvas moves.

The canvas fills the available window and stays aligned with Attention when you resize it, including at fractional display scaling. Resize or maximize the window for more room; pan and zoom to navigate the canvas instead of scrolling the whole page.

Click an agent to focus its desk. Use identity links in transcripts, mail, work items and menus to reach the same agent or project. Their context menus collect related actions. **Focus** navigates to the target; **Open > Desk** borrows its existing desk into a temporary modal for a glance. Escape or a backdrop click returns that desk to its former placement, with its draft and scroll state.

Moving a card is a structural operation, not just rearranging a picture. It moves that node and its subtree under a new superior; dropping among siblings can reorder them. Escape cancels a drag. A refused move returns to the valid structure. See [Managing agents](managing-agents.md) before reorganizing grants or access.

When you hover over a new superior, a dashed outline previews the moved agent relative to that superior's current position. It keeps their final spacing, so a superior that will shift during the move does not pull the preview away from the visible target. Releasing the card lets the whole tree settle into its final layout.

There is one special drop target: dropping an agent on the **organization inbox** tile gives it an org-inbox audience. It does not move the agent under the tile. [Collaboration](collaborating.md) explains what that contact permission allows.

## Use the switchboard and header

Focus **YOU** to open the switchboard. Its tabs are your direct lines to top-level agents and agents granted a user audience. Selecting a tab opens or minimizes that chat, or raises its pinned window. The separate jump control goes to the agent's canvas location. A granted line can be closed to revoke that user audience; an intrinsic top-level line has no equivalent revoke control.

The switchboard's auto option can open newly arriving direct lines while there is room. It is a layout preference, not a grant of new communication rights. For an existing task, continue in that agent's chat. **Quick chat** hires a new agent from one message; it does not choose an existing conversation.

The organization header provides:

| Control | Use |
| --- | --- |
| Canvas / Attention | Switch between the organization tree and the needs-attention queue. |
| Inbox bell | Open questions and mail requiring your attention. |
| Work | Open the organization's docket. |
| Presentations | Open presented documents. |
| Organization settings | Edit this organization's configuration. |
| Glowing @ button, when present | Visit the newest unobserved transcript mention and highlight its passage. Repeated clicks visit remaining mentions. Mail mentions use the inbox path. |
| STOP ALL | Emergency organization-wide control; see [Operating and troubleshooting](operating-orgtree.md). |

Use **Shift+F4** for the newest recorded user mention across transcripts, mail and tickets, including seen entries. Separate presses step backward without wrapping; a newer mention restarts from the newest. This is a different navigation path from the header's pending-transcript @ button. See [mention history and limits](settings-and-usage.md#keyboard-shortcuts).

The footer reports activity, version and connection errors. Conditional chips can show recorded cost, a provider warning, hub delivery state or a headless session. Cost information may include unknown pricing; it is not your provider's invoice. Click the Hub chip to inspect Connections. A queued delivery count means delivery is outstanding.

## Keep useful surfaces open

Pin a desk to keep it in screen space while navigating the canvas. Drag its title bar to move it and its edges to resize it. With snapping enabled, Shift allows free placement. The close/unpin action returns the desk to its usual place; **Show on canvas** helps locate a card that is off-screen.

Many other panels can also be pinned or opened in a separate window: settings, mail, docket, presentations, project slots and listeners. A panel belonging to one target opens for that target. Opening another agent's Team, for example, can leave the first agent's Team beside it. Opening the same target again raises its existing surface. Placement is remembered per organization and target, within the saved-history limit.

**Open in new window** moves the canonical surface; it does not create an independent conversation. **Pop in / Return to main window** brings it back. A desk already hosted elsewhere can show a placeholder with **Show**. Read a native window's Close action as dismissal/return according to the surface, not as a promise to save an unfinished form. At the homepage, App settings and Usage are centered because there is no organization's canvas to pin them to.

## Triage attention

**Attention** puts **Needs attention** beside a desk. The queue combines open question cards, unread urgent or user-mention mail, and manually flagged docket items. Choose a row to read it and use its normal question, mail or work controls. The desk can be changed independently with its agent drawer.

Answering a question removes it from the open-question feed. Reading a selected mail can keep it in view until the selection changes. Click a selected row again, or press Escape with the queue list focused, to clear the reading pane. Changing a work item's status does not clear its manual attention flag. Loading, stale and failed states are shown separately from a verified empty queue.

Attention, inbox, work and presented-document details are covered in [Messages and work](messages-and-work.md).

## Reuse a layout

After a team works well, use **Organization settings > Basic > Templates > Save as template**. Give it a name, review the include choices and save it. The result becomes a **Starting layout** when creating another organization. It saves the currently stored organization, not unsaved settings edits.

Tree structure, names and tiers are included. Include choices cover charters/project Summary, credits, effort/fast mode/explicit OpenRouter harness pins, tools, org instructions, Quick chat defaults and portable org/project queue/event settings. Accounts, machine-specific folders and standing-note copies need particular care when sharing. Mail, transcripts, docket items and watchdog runtime history are not copied. Projects are saved as free containers.

**Include watchdogs** and **Include audiences** start on. The preview discloses each node's watchdog count and explicit contact grants, including user and outside-mail access. Renamed nodes remap their references; removed or outside endpoints are dropped with warnings. Audiences grant contact, not tools or files. Inspect these include choices before sharing or creating another organization.

Machine-specific watchers are a separate off-by-default choice. They restore paused. Saved watcher credential fields and credential-file references are omitted, including in nested on-fire actions: affected actions are removed, and credential-dependent watchers remain paused with a reason and need recreation with credentials. Review command/message text too; arbitrary text can contain private data. Portable eligible watchers arm after every imported definition exists and can wake agents even when the first-message checkbox is off. Runtime output, clocks, queue positions and held leases are not restored. Per-watcher refusals can leave an already-created org with visible warnings. [Projects and automation](projects-and-watchdogs.md) explains the recreated watchers and their effects.

A template has no fixed node-count or depth ceiling in 4.4.2, with a **16 MiB** UTF-8 file bound. The preview pages 100 nodes at a time and shows actual levels/parents with bounded visual indentation. Older readers retain their own limits. Another computer may lack models, supported speed or a pinned harness: correct the preview's unavailable choices before Create. Typing the org name keeps the last confirmed template rows and selection in place while availability refreshes; Reload re-reads template files.

Standing-note copies remain opt-in and bounded: only the fixed shared/team/personal `AGENTS.md` files are copied, at most 16,000 UTF-8 bytes per file and 128,000 combined. Review their text before sharing. A partial note-copy failure does not undo an organization already created. [Providers and tools](providers-and-tools.md) and [Collaboration](collaborating.md) cover portability and standing notes.

## Details and limits

- Narrow windows retain the canvas layout. Some mail/presentation readers use a list overlay and Quick chat gathers options into a dropdown; there is no separate mobile agent sheet in this release.
- A confirmation dialog shows the action and counted targets. Read it before a bulk change. Cancel changes nothing; a successful operation can still contain per-target skips or failures.
- Undo is available for supported recorded changes through its toast/history. It is not a universal rollback for commands, provider activity or external files. The retained **History** browser is for reading records, not undoing them.
- Organization settings mix buffered fields and immediate actions. Basic, Hire defaults, Policies and Connections' external-inbox mode/holder fields wait for the footer Save; logo, template, account and hub-membership actions have their own saves. A failed multi-part save can leave some changes applied. Re-read before repeating it.
- If you encounter the legacy inline New organization form, **advanced…** holds initial extra folders and local/remote hub choices. **done** returns to that form without creating the org; the parent creation action submits them. Established organizations use their normal settings and Connections tabs.

Continue with [Managing agents](managing-agents.md) to choose roles, credits and access before expanding the team.
