# Orgtree 3.0.0

Orgtree 3.0 keeps your organizations in a database instead of in one file per
organization. The database is a private PostgreSQL server that comes with
Orgtree and runs on this PC only. There is nothing extra to install, and
nothing is sent anywhere else.

3.0.0 includes everything in 2.1.13 and 2.1.14: Claude Sonnet 5.5, GPT-6.1 Sol,
and the model pins that keep existing agents on the model they already run.

## Before you update

Make a copy of the folder `%APPDATA%\Orgtree v2` first (paste that path into
the Explorer address bar to find it). Orgtree keeps your old files during the
update, but a copy of your own is the simplest way back if anything goes wrong.

## The first start: a one-time conversion

The first time 3.0.0 starts, it copies every organization from its old file
into the new database. Orgtree shows a window with the progress.

- It usually takes a minute or two. Very large organizations take longer.
- Do not close Orgtree or turn off the PC while it runs. If it is
  interrupted anyway, nothing is lost: the old files are still in use, and the
  conversion starts again from the beginning at the next start.
- Each organization is read back and compared with its old file. Orgtree
  switches to the database only after every organization matches.
- The conversion needs free disk space of about the size of your
  organizations' files.
- After it finishes, the old organization files are moved, unchanged, to
  `%APPDATA%\Orgtree v2\data\pre-postgres\orgs`. Orgtree never deletes them.
- Organizations in the trash are not converted. They are set aside, unchanged,
  in `%APPDATA%\Orgtree v2\data\pre-postgres\deleted`.
- Transcripts, attachments, workspaces and sign-ins stay where they are and
  are used as before.

### If the conversion stops

When Orgtree cannot convert, it stops before changing anything and shows a
message. Your data stays as it was, and 2.1.14 can still open it. The usual
causes are:

- **Orgtree was started as administrator.** The database refuses to run with
  administrator rights. Start Orgtree normally, from the Start menu or the
  desktop shortcut.
- **The data folder is a junction or link** to another drive. Orgtree 3.0
  needs `%APPDATA%\Orgtree v2\data` to be a real folder. Move the data back
  into that folder, remove the link, and start Orgtree again.
- **Some data is not recognised.** Orgtree refuses to convert anything it does
  not understand, rather than drop it. The message names the folder with the
  details.
- **Another program is using the database's port**, for example a database
  process left over from an earlier start. Restarting Windows clears it.

## Going back to 2.1.14

1. Quit Orgtree completely (right-click the Orgtree icon in the tray, then "Quit Orgtree").
2. Download `Orgtree-Setup-2.1.14.exe` from the
   [2.1.14 release page](https://github.com/Maurdekye/orgtree/releases/tag/v2.1.14)
   and run it. It installs over 3.0.0.
3. Put your old data back. If the conversion stopped with a message, skip
   this step: nothing was changed. Otherwise, either restore your own copy of
   `%APPDATA%\Orgtree v2`, or run these commands in a Command Prompt:

   ```bat
   cd /d "%APPDATA%\Orgtree v2\data"
   ren store-backend.json store-backend.json.after-v3
   mkdir pre-postgres\markers
   move orgs\*.pg pre-postgres\markers\
   move pre-postgres\orgs\* orgs\
   if exist pre-postgres\deleted\* move pre-postgres\deleted\* deleted\
   ```

4. Start 2.1.14 and turn off **App settings > Runtime > Automatic updates**,
   so that it does not install 3.0.0 again by itself.

Anything you did in 3.0.0 is not carried back to 2.1.14. If you install 3.0
again later, it converts your 2.1.14 data again.

## New features

### Windows and the app menu
- One **Orgtree** menu in every window: New window, Open organization…, Create new organization…, Usage… and App settings….
- "Open organization…" opens a submenu beside the menu, with a search box, live activity and agent counts for each organization.
- Each organization opens in its own window, and several can be open at once. Choosing an organization that is already open brings its window forward and marks it "Already open".
- Homepage windows: a window that shows the organization list and the Orgtree menu.
- At startup Orgtree can reopen the windows you had open, in the same positions, or start at a fresh Homepage (App settings → Display → Startup).
- Each organization remembers whether it was on the Canvas or the Attention view, and comes back on the same view at startup.
- If some windows could not be reopened at startup, one short notice says which.
- A status strip along the bottom of each organization window holds the status chips that used to be in the header.
- The running version of Orgtree is shown in the status strip, and beside the title on the Homepage and New organization windows.
- Creating an organization from a Homepage turns that same window into the "Create new organization" form. Cancel takes it back to the Homepage.
- A four-step "Getting started" guide in a newly created organization points at what to click to hire and message your first agent.
- The taskbar icon follows the visual theme, as the tray icon already did.

### Attention view
- A new **Attention** view, beside the Canvas, switched from the header. It shows one "Needs attention" list next to one agent desk.
- The list holds tickets flagged for you, unread urgent mail and open questions, and each is handled in place: tickets with the docket's own detail and reply, mail with the inbox's own reading pane and reply, questions with the inbox's own answer card.
- Dismissing a ticket's flag removes its row the moment you click.
- The divider between the list and the desk can be dragged, and both panels follow it.
- The agent desk has an agents drawer that you open by clicking. It shows the same Agents List as the canvas, darkens the desk while open, and closes when you pick an agent, click outside it, press Escape or move the pointer well away from it.
- Clicking an agent's name anywhere in the Attention view opens that agent's desk in the right panel.
- When nothing is selected, the first entry in the list is selected for you.
- An empty list says which kinds of entries appear there. When both panels are pinned or popped out elsewhere, the empty view says so.
- The whole Attention panel (list and desk) can be pinned or popped out into its own window.
- A desk that was open on the hidden Canvas moves to the Attention view, so it stays usable there.
- Clicking a notification focuses its entry in the Attention list.
- An agent waiting for a model switch is marked in the agents drawer.

### Canvas
- A circular org-chart layout: agents in rings around the top node (App settings → Display; the row layout stays the default).
- In the ring layout, the lines between neighbours follow the ring, and the hire-coworker buttons place the new agent on the side the arrow points to.
- At far zoom, agent names are drawn above neighbouring cards, so they stay readable.
- At medium zoom, hovering an agent whose name is cut off shows the full name.
- An agent with a thinking effort different from the organization's default shows a small badge with the level (for example "high") on its card and desk.
- Right-click the eye card for "Cheap-compact all agents…", or a manager for "Cheap-compact subtree…". A confirmation lists every agent that will be compacted or skipped and why.
- "Open desk" (from an agent's right-click menu) shows the agent's real desk in a pop-over for a quick look, with a Pin button, and leaves everything as it was when closed.
- A desk shows a card for each watchdog its agent owns. Clicking one opens the watchdog's details.
- A desk whose agent is waiting for a free turn shows a yellow banner naming the turn limit, with a button that opens that setting.
- A desk that is open in one place shows "open elsewhere" in the other, with "Show desk" and **"Move desk here"**.
- Retired agents are loaded only when you open the retired pile, search or jump to one, so large histories don't slow the canvas.

### Settings
- **Run Orgtree as administrator** (App settings → Runtime, off by default) gives the background engine and its agents full administrator rights. Windows asks for permission when you change it.
- A setting for how many agent turns may run at once (App settings → Runtime → Turns, 1 to 512, default 16), applied live. Waiting turns are served in arrival order and fairly across organizations.
- "Charter template folders" (App settings → Runtime): add folders of `.md` charter templates and they appear in the hire form.
- Clear a stuck account limit mark from App settings, after a confirmation that names the account, the limit and its reset time.
- A Developer tab with an engine debug view: live update queues, engine memory and docket traffic.
- "Show legacy models" (App settings → Runtime) shows Terra and Gemini Pro again in hire, tier and Usage lists.
- "Snap pinned panels to edges" (App settings → Display → Desk, on by default).
- An About tab in App settings with the version, engine build, engine start time and GitHub link.

### Agents and tools
- Agents can list and read their own waiting mail on demand with a new inbox tool.
- Agents can clear one exact stuck account limit mark with a new tool, as you can from App settings.
- Codex agents (Astra, Luna and others) take several waiting messages in one turn instead of one turn per message.

### Reliability
- If the background engine Orgtree started stops answering, Orgtree ends it and starts a new one.

## Changed features

### Storage and speed
- Saving changes only the records involved instead of locking the whole organization, so agents working on unrelated things no longer wait on each other.
- Checking for mail when there is none costs about a tenth of what it did, so busy organizations respond faster.
- Opening a desk loads only the latest part of the conversation. Older messages load as you scroll back.
- The Work docket list loads as a light summary and fetches an item's details when you open it, instead of re-downloading the whole docket every few seconds.
- Long docket lists draw only the rows on screen.
- An agent's inbox opens almost at once (about 20 ms instead of up to a second).
- Presentations open without scanning the whole organization.
- Saving an agent's settings, switching its model and showing its lineage no longer read the whole organization.
- A large organization window shows its tree first and fills in the side panels afterwards.
- Short requests to the engine are no longer held up behind long ones.
- Reading per-account usage no longer holds up the engine.
- Startup, organization lists, the docket, mail and the tree read only active data, so a big history does not slow them down.
- The lines between agents and the moving mail dots are drawn with the graphics card when possible.

### Windows, header and menus
- The header's buttons (Work, Inbox, Presentations, Org settings) are icons only, with their names in tooltips.
- The Stop all button sits to the left of the header buttons and grows into the empty space, so the other buttons never move.
- The Canvas/Attention switch is one word per side.
- Default org settings are opened from App settings instead of the sidebar.
- Usage opens only from the Orgtree menu.
- When something needs you, the taskbar flashes that organization's window, or the last-used window if it has none, never every window.
- The footer agents chip's tooltip now gives the same numbers as the chip: live agents by model, agents active now, and activity in other organizations.

### Canvas and desks
- The agent right-click menu: the old "Open desk" is now **Focus** and comes first; "Open desk temporarily" is now **Open desk**; Settings is the last entry.
- An agent's glow ("halo") now means it has a running process, and is brighter while it works. It used to glow only while parked.
- An agent's attention glow goes out on the click that answers it.
- Moving an agent to a new parent by dragging shows at once, and moves back if the change is refused.
- Changing a Claude agent's thinking effort reaches a turn that is already running, from its next model call.
- Canvas controls stay clear of pinned windows by default.
- Focus, fit-all and zoom take pinned windows into account after the window is resized or moved to another screen.
- A desk no longer jumps between two places when you move the mouse; it stays where it was last opened.
- A submitted question card disappears on the click, and "Request resolved" is queued at once.
- A new question's card appears together with its notification instead of seconds later.
- A model change shows at once in every view.
- The Agents side list uses its empty left space, so agent names show more characters.

### Inbox and mail
- An answered question stays in the inbox, marked as answered. Answered questions are listed newest-answered first.
- A question attached to a ticket lights only the Inbox, not the Work button. The ticket's row shows "question waiting" until you answer.
- The inbox dot counts only the organization in that window.
- Answering a question card clears the inbox dot and glow at once.
- Marking a mail read, and replying to it, take effect on the click.

### Work docket
- Dismissing a ticket's attention flag turns off the Work button's glow and count at once. It glows again only for a new flag.
- A ticket whose only reason for attention is a question keeps its normal look instead of the orange "Needs attention" styling.
- The Integration review section of a ticket is plain and starts collapsed, with the short commit id in its header.
- Agent names inside ticket text still link after the agent retires, and numbers, timestamps and IDs are no longer mistaken for names.

### Presentations
- The presentations gallery opens on the newest visible presentation.

### Settings
- App settings tabs are, in order: Providers, Runtime, Display, Default org settings, Mail hub, Developer, About. App settings opens on Providers.
- Tab titles stay on one line; the tab row scrolls sideways if it has to.
- The "on startup" choice is an ordinary dropdown under Display → Startup.
- The OpenRouter harness choice is an ordinary row in App settings → Runtime → Agent processes.
- Default org settings say "applied to every NEW organization" once instead of in every section.
- A turned-off provider no longer shows a "turned off in App settings → Providers" line in its own section.
- Button hover, focus and colour styles are the same across providers.

### Models
- Terra and Gemini Pro are legacy models, hidden from hiring, tiers and Usage unless "Show legacy models" is on.
- GPT-6 Astra is always offered in the hire form, whatever the account's model list says.

### Agents and tools
- The background engine and every agent now run as your normal Windows user, not as administrator (see "Run Orgtree as administrator" to change this). At first start, Orgtree gives you back access to folders an earlier administrator-run engine had locked.
- The text agents read for Orgtree's tools is about half as long, so turns are slightly cheaper and faster.
- Agent tools refuse a blank message and any field they don't know, instead of sending empty mail.
- Retiring, dissolving, deleting or compacting an agent stops its background tasks instead of refusing.
- An agent's credential works only for that exact hire, so a replaced or retired agent's leftover process cannot act as its successor.

### Installer
- The installer is about 40 MB larger, because it includes the PostgreSQL database server.

## Bug fixes

### Data and reliability
- Under load, a save could silently overwrite a change made moments earlier (for example a ticket's evidence row) while reporting success. Fixed.
- Mail that was being delivered when the engine stopped is handed back after a restart only once the old process is really gone.
- A stale account limit mark could keep agents frozen until the account files were edited by hand.
- A busy or hung window could make engine memory grow by gigabytes per hour. Each window's update queue is now capped, and a window that stops reading reconnects by itself.
- One malformed message in a transcript no longer stops the whole transcript from loading.
- Usage boards no longer report an account as changed when its name could not be read.
- The resource-reservation limit counts only reservations that are actually held.

### Desks and chat
- The copy button on a code block did nothing inside panels (mail, the Work docket, presentations, the Attention view). It now copies the exact text.
- Links to local files and pictures inside those panels did nothing when clicked. Files now open in their folder and pictures open in the viewer.
- A local file link in a popped-out window did nothing. It now shows the file in Explorer.
- After an agent compacted, text you had typed but not sent moved into the sent history. It now stays in the message box.
- An answered question card could come back at full size after the agent was compacted.
- A draft in the message box did not resize when the panel's width changed.

### Canvas and windows
- The camera could aim behind a pinned window after the window was resized or moved to another screen.
- Resizing a pinned panel did not snap the edge you moved.

## Removed

- The organization sidebar (replaced by the Orgtree menu and one window per organization).
- The Usage button in the organization header (Usage is in the Orgtree menu).
- The "About Orgtree" menu entry (the version is shown in the window, and App settings has an About tab).
- The Import tab and Orgtree v1 import.
- The "close" button at the bottom of your inbox and agents' inboxes (Escape, a click outside or the title bar's Close still close them).
- The text labels on the header buttons (icons only).
- The second pop-out button on the Attention view's desk (an agent's own desk can still be popped out from its right-click menu).
- The popup that appeared on every run when a downloaded update could not install itself (the held update still shows on the tray and the header's Update now button).
- The "a-list team coordinator" and "review workflow" charter templates.
- The external-chat connector (`@mcp:` addresses). Agents are told to use the mail hub (`@net:`); old `@mcp:` messages stay readable.
- The agent self-update tool in the desktop app, and the retired mode of the agent restart-wake tool.
- The near-limit warning colour on the Usage button (the button is gone).

## Known limits

- An agent or database process left running by an administrator-run engine
  from before this version cannot be stopped by the new engine until Windows
  restarts.
- "Run Orgtree as administrator" applies only while the background engine is
  running.
