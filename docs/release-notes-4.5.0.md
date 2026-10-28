# Orgtree 4.5.0

Orgtree 4.5.0 adds custom apps: small HTML tools that agents build for you, with their own saved data, permission prompts and events that reach agents. It also plays video and audio in chat, shows token counts on messages, lists running helpers, runs HTML presentations inline and makes mentions richer and faster to copy.

## Custom apps and panels

- **Agents can build you apps.** An app is a small HTML tool kept by one organization. Open **Apps** beside Presentations in the org header; an empty list tells you to ask an agent for one. Each **panel** of an app has its own label and saved JSON data. Click an app to open its latest panel, or **+** for a new one; panels are named Panel 1, Panel 2 and so on. Apps are listed newest first, each with its panels in one block, and the Apps button counts apps you have not seen yet. Agents point you at an app or panel with an `@app:` or `@panel:` link. They can create panels but only you open windows.
- **Readable, permanent ids.** Every app, panel and presentation gets a short id made from its name or title, such as `caption-board`. It never changes when you rename it, and older ids keep working.
- **Panels run in a sandbox and ask before they reach out.** An app's HTML has no Orgtree sign-in and no network. By default it can read the organization's chart, fire its declared events, create docket items and read and write the organization's own scratch, uploads and delivered files. Anything more asks in a native prompt outside the HTML: **Allow once**, **Always allow** or **Deny**. That covers one chosen file, a folder or the whole computer. Outside the organization, each change is confirmed with the exact file, operation, size and SHA-256.
- **Files, media and the internet.** Apps can browse what you grant them and play video and audio from files you chose, remembered when the panel is reopened. Internet access is off until you allow it, site by site: HTTPS only, without your cookies or Orgtree credentials, and never to your own computer or network. **App settings > Permissions** lets you review and revoke everything, and **Permission history** lists each change and prompt answer.
- **Events connect panels and agents.** An app declares named events. An agent listens with an app event watchdog for one panel or all of them and receives the event's data when a panel fires it. Apps reach agents only through events. A panel's **Fire event** tab sends one by hand, starting from the event's latest data, and lists its fires. An event's data shows as structured JSON in the agent's mail. **Connections** shows who is listening, live, and **History** lists fired events, starts and stops, newest first, with the exact body of each.
- **Panels keep running when hidden.** Closing a panel's window hides it; **Power off** stops it. A light on each panel in Apps shows whether it runs visibly, runs hidden or is off, and **Start running** starts a stopped one without opening it. Panels run only while Orgtree is open, tray included, and come back as they were after a restart. Starting or stopping a visible panel zooms it in or out.
- **Windows.** Panels open as a centered window. The pin keeps one where it is on the window, like a pinned desk, and pop-out opens it in its own window, which it returns to when you open it again.
- **Settings and sharing.** **App settings** has General, Events, Permissions and Permission history tabs. **Panel settings** has the name, General (Duplicate, Delete), State, Connections, Fire event and History. Export an app as a portable `.orgtree-app` file, with or without its panels' data, and import one after a preview; permissions never travel with it. Organization templates now include app definitions, without panel data.
- **Theme colors.** Panels can use Orgtree's current colors and restyle at once when you change **Display > Appearance**.

## Chat, documents and mentions

- **Video and audio play in chat.** **Play video** and **Play audio** appear on media file cards in every chat, including pinned and popped-out ones. Media loads only after Play, up to 256 MiB per file, and stops when you scroll away or switch chats.
- **Token counts on messages.** A message's header shows how many tokens it adds, and the last card of a delivery shows `+N` for the hidden turn envelope; hover it for the parts. Tool rows keep their counts, and Antigravity file reads now show theirs.
- **See an agent's running helpers.** When a chat has observed helpers, its header shows **N helpers**. Click it to open **Helpers**, which shows each helper's type, model, start and status, with a live transcript for Claude Code.
- **HTML presentations run inline.** Scripts and controls work in the reader, in an offline sandbox that cannot send anything back to the agent. They carry an **HTML** tag, and **Fit width**, **100%** and **Open in a new window** control the view. The presentation list now stops at 400 px wide.
- **Mentions show what they point at.** Each mention wears an icon for its kind. Ticket mentions show the item's current title and status color, presentation mentions are highlighted until you open them, and `@project:` and `@agent:` links with the organization name work as long forms.
- **The @ menu offers everything, newest first.** Agents, projects, contacts, tickets, presentations, apps and panels, ordered by what was most recently mentioned, worked on or used. Type `@agent:`, `@project:`, `@item:`, `@doc:`, `@app:` or `@panel:` to list one kind.
- **Copy a mention in one gesture.** Double-click a docket item or a row in the Presented list to copy its mention, with a brief **Copied!**. Right-click an app or panel and choose **Copy mention**.
- **Outside contacts show their name and picture.** Network mentions are tinted for an Orgtree org, a person or an agent session, and show the name and picture the hub reports. Contact lists use the same links. A link to your own account opens your chat with the organization instead of your Hubchat settings.
- **Wrap object mentions.** A new switch in **App settings > Display > Text** lets long ticket, presentation, app and panel links continue on the next line. It starts off.
- **Mail lists show four tags,** with a count for the rest.
- **The Changelog stands out major and minor releases** with larger, heavier version text.

## Improvements

- **Question notifications go to the asker's desk.** Clicking one focuses the question in the asking agent's open desk instead of the Inbox.
- **Agents' docket updates refuse less often.** Adding progress needs no revision number, repeated entries are not added twice, a mistyped item name suggests the nearest one, and calls that change nothing succeed.
- **A stuck holder no longer blocks a project's slots or queue.** When an agent is frozen by a usage limit, halted, moved out of the project or loses its turn, its slot leases and un-acked mail jobs return at once, and the next waiter is granted. Restarting Orgtree releases nothing.
- **Antigravity follows your sign-in.** After you sign in to another Google account, Orgtree reads the new login's model list by itself and restarts Antigravity processes still on the old login. Argon has its own weekly usage window, and a full one holds back only Argon.
- **Agents' context stays smaller.** The provider-usage block is resent only for rows whose usage changed.
- **An agent ending its own turn reads "Ended this turn as requested"** instead of an error.
- **Integrator charter preset.** A new preset for the seat that rebases, builds and tests an implementer's work; the Implementer preset can now hand integration to such a pool, and the workflows guide describes the pattern.
- **Org-modifying tools.** Agents' tool settings gain this group for apps and the organization logo, on by default. An older explicit logo denial still applies.
- **Settings tabs and Org settings are tidier.** The intro paragraph at the top of each App settings and Panel settings tab is gone, and Org settings no longer has a footer Close button.
- **Smaller touches.** The effort slider's thumb and fill glide to every level a drag crosses. Rename is always shown and enabled once the name changes. Mention icons sit centered on their label. Gemini Pro is marked legacy in the canvas hire menus when legacy models are shown. The Apps list's **+** and gears highlight on hover.

## Fixes

- **A dragged window pin stays where you dropped it,** and a popped-out window reopens at its exact position and size.
- **Hovering a card at far zoom shows its name above the other cards,** also while a desk is open.
- **Desk Docket and Presented tabs update as soon as an item or presentation arrives.**
- **The @ list opens below its box when there is no room above.**
- **A popped-out app panel fills its window.**
- **Agent-made HTML pages in the reader cannot use WebRTC** to reach the network.

## Notes

- The agents' glossary and user guides were reviewed against the changes since 4.4.6. Small documentation gaps were corrected; no larger gaps were deferred.
- Windows builds remain unsigned. macOS and Linux desktop builds remain prototypes. Downloads include `SHA256SUMS.txt`.
