---
name: orgtree-presentations
description: Explain document galleries, readers, previews, pinning, replies, dismissal and downloads.
---
Up: [orgtree-desk](../SKILL.md)

# Presented documents and file cards

Document-reader HTTP bodies and private handler returns are omitted from diagnostics in both logging modes. Request paths/status remain recorded, and document text still reaches the reader unchanged.

Presented documents are reading surfaces. File-delivery cards provide downloadable files. The distinction is the delivery purpose, not whether the underlying content happens to be Markdown.

Markdown images using the checked endpoint follow the shared
[image limits and refusal rules](../desk-chat/SKILL.md#markdown-image-limits).
Supported format alone does not guarantee an inline embed.

## Empty desk tabs and team defaults

Desk **Docket** and **Presented** tabs hide when neither the node nor its team has anything the tab would list under its default filters. A tab appears or disappears as content changes, but stays visible while you are on it; an empty tab disappears when you leave. Search and sorting do not hide tabs. The Docket check follows the existing list, including recently completed tickets during their one-hour window and attention exceptions. Show archived and Show backlogged include those groups when enabled. Presented starts with hired presenters; Show retired includes retired presenters.

When only the team has content, entering the tab starts with **Team** checked and auto-select works in that team scope. A manual untick is remembered for this organization and node across visits/restarts until own content arrives. Own content keeps the ordinary own-node default. Live arrivals do not switch the scope or selection of a reader you are using. These rules apply to both agent desks and project Presented tabs. A project Docket already lists its subtree and keeps that scope without a Team checkbox.

## Collections and reader

Team collections traverse the whole selected team without a fixed project-nesting cutoff. A malformed cycle cannot duplicate members or keep loading forever. Retained presenter identities, Show retired and document paging keep their usual behavior.

The org gallery groups documents from currently hired agents first, with Show retired to include retained retired/deleted-agent presentations. The agent gallery and desk Presented tab narrow to that agent. The agent menu's Open → Presentations → Team presentations widens the same view to the agent and everyone below it, passing through projects; for a project, Open → Presentations lists the documents attributed to the project, and its desk's Presented tab adds a Team checkbox, and Open → Presentations → Team presentations adds those of every agent under it (both menu options are offered whenever their openers exist, even when empty). Every row and the reader name the presenter as a link that focuses it: the agent for its own document, and for one presented under a project the project (with its folder mark), with a "presented by <agent>" line beneath (in the reader, "this presentation was presented by <agent>"). A team window stays a team window when pinned, popped out or restored. Renaming an agent or a project keeps its presentations in its gallery, listed under its current name. Selection uses document identity, not a row index; exact document references can locate older entries beyond the first loaded window.

The list is a third of the window but never wider than 400 px, so a wide or maximised window, such as a pinned or popped-out reader or a desk across the screen, gives the extra room to the presentation (user 2026-10-27).

Open a card to read its Markdown or HTML preview. The reader identifies title/author/time and supported references, plus applicable reply/dismiss/download controls. A missing/failed load says so instead of manufacturing an empty document. HTML presentations carry an **HTML** tag (`</> HTML`, or `</>` on compact canvas chips; user 2026-10-27). The reader shows the selected HTML presentation inline, below its title, in a sandboxed frame: its scripts, controls and in-page links work; links to other pages do nothing, and it has no network, form submission, popups or app access, and it cannot send anything back to an agent (presentations are one-way; custom apps are the two-way feature). **Fit width**, the default, scales a presentation wider than the pane down to the pane's width; **100%** shows its actual size, scrolling inside the frame. Switching keeps the presentation's state and carries to the next one you open. Only the selected presentation renders, never a list row. A stored preview over 4 MiB (possible when a folder's captured files are inlined) shows a note instead. **Open in a new window** above the frame, and **Open HTML presentation in a new window** on its context menu, open it in its own isolated window, as one click on a canvas chip or desk badge does. Previewing content does not grant it an agent's tool authority.

Presentation lists highlight documents you have never opened, or that changed since your last view, like unread mail: a bold accent title and brighter metadata. A dot before the title tells the two apart (user 2026-10-27): the full accent for one you have never opened, a duller one for one modified since you last read it, and the row's tooltip says which. Presentation mentions, the presentation cards under an agent's orgtree_present tool rows, desk badges and canvas chips are highlighted the same way (see [desk chat](../desk-chat/SKILL.md)). This applies to the full Presentations window and agent/project Presented tabs, including pinned and popped-out views. Opening a presentation clears its highlight through the existing saved user viewed state. An agent reading it does not mark it viewed by you.

Each fresh opening automatically selects the oldest unread or changed presentation, ordered by its current creation/replacement time. If all are read, it restores this scope's last viewed eligible presentation, otherwise the topmost card; an empty collection stays empty. Explicit document references take priority. Polling and viewed-state updates never replace your selection while it remains in the surface's scope, except that an authoritative refresh clears a selected document that has left the current scope (for example after its presenter moves out of that team) so later document links route using current ancestry. The engine locates the selected document across the whole collection. Every fresh opening includes the newest end as well as the selection: a distant oldest-unread target gets another bounded range with a gap control between the ranges. The unread selection is revealed after layout without repeatedly pulling the list back during refresh. Gap controls load intervening documents; Load newer documents reaches entries above the current window and scrolling down loads older ones.

Readers are one per scope: the organization's Presented documents, one for each agent or project, and one for each agent's or project's team. Several can be open at once, each with its own place. Opening a document (a card, chip, badge, reference or docket link) brings to the front an open reader that can show it, showing it: one already showing it in its current scope first, then the document's own agent or project reader, then the nearest team reader above it, then the organization's. If none is open, the document's own agent or project reader opens on it. The Team box in a reader switches it to that team's reader in the same place.

Pin/window controls change the reading surface. Closing a reader leaves the presentation in its collection; Dismiss removes its displayed card through the document operation. These are different from retiring its author.

Pinned agent and team readers remember the document currently selected, even
after another reader opens. Restoring the saved window reopens that document
for the same node generation and reader scope.

Organization and agent presentation modals collapse the list into a menu-controlled overlay when their reading area is 896 CSS pixels wide or less. The breakpoint follows that area's width in a popout too, including snap-layout resizing; widening restores the list column. Resizing and moving the panel retain selection, filters and list position. Inline desk lists remain columns.

## Opening priority and remembered selection

A fresh opening selects the topmost ticket with a manual attention flag, or the oldest unread/changed presentation by its current update/creation time. Otherwise it restores the last viewed eligible item for that organization and collection scope (org, node/project or team), then the topmost row, or nothing for an empty list. Closed tickets and dismissed documents do not win the remembered-item preference. The preference survives close/reopen and restart, respects current filters, and does not mark a document viewed on an agent's behalf.

This applies to the top-bar buttons, agent/project Open submenus including team views, and entering a desk's Docket/Presented tab. Leaving a desk tab and returning is a fresh opening. Explicit item/document links keep their target. Bringing forward, resizing, pinning, popping out or restoring an already-open reader keeps its current selection, including a deliberate empty pane. Polls never replace a choice.

## Copy, download and reply

Project presentations use a shared project bucket. An agent currently authorized to present into that project can replace a card there even if another agent originally presented it. The project remains its owner and the **presented by** line changes to the replacing agent. Personal agent galleries keep their own-agent replacement boundary. See `orgtree-tool-present` for the authority checks.
Download cards delivered by an agent are collected separately in that agent's
**Files** desk tab, beside Presented. It includes retained earlier deliveries
with name, size, time and note, using the same immutable download snapshots.
Hub attachment transfers are tracked separately. A recorded card can remain
listed if its snapshot was removed externally; a failed download does not
recreate the file. Project document placement is unchanged.

In a live message-box context, presentation cards and reference links put
**Mention** and **Reply** first. Mention inserts the same `@doc:<org>/<id>`
reference that Copy reference copies; the id is the presentation's readable slug
(an older link written with its earlier generic id still opens it). Agents
give a presentation whose title isn't in English a short English slug, while
the title keeps its own language. A presentation link shows the presentation's current title, and typing `@` in a
message box offers presentations by title. Reply prepares an answer about that presentation
in the nearest owning composer without sending. Canvas content can use its
Quick chat footer; standalone galleries retain their existing actions. See
[composer routing](../desk-chat/SKILL.md#composer).

Document menus can copy title/reference, open/close, download Markdown or the HTML presentation (**Download HTML presentation**: a ZIP when it captured local files), stage a reply in the desk composer (`Reply` on presentation chips in an agent's desk header and rows in its Presented tab), and dismiss when the surface permits it. Replies in a live message box keep that box's recipient and support attachments where available. A failed reply does not amend the document.

Download saves a file; it is not proof the user read the card or that a file was sent through a different delivery route. File cards/images have their own view/download behavior and custody. Do not suggest that moving a scratch file into a folder will make it appear in Presented.

For the agent-side publishing contract see `orgtree-tool-present` (orgtree-working › user); for an installer/log/export/image wanted as a file see `orgtree-tool-send-file` there. Those pages own limits and supported input formats.

## See also

- See `orgtree-tool-present` (orgtree-working › user).
- See `orgtree-tool-send-file` (orgtree-working › user).

## Reply to a selected passage

In a Markdown reader, highlight part of the title or body and choose **Reply to selection**. The nearest reader reply box keeps your draft and recipient. Stage several passages, inspect **Nearby context**, remove one or cancel all, then reply through the existing direct/project broadcast control. The engine rechecks the source digest before delivery. A later edit never changes the saved excerpt; opening a quote checks for its exact or uniquely relocated passage and otherwise reports **Source changed** or **Source unavailable**. Interactive HTML presentations do not support selection replies.

The shared [selection limits](../inbox-screens/SKILL.md#reply-to-selected-mail-text) also apply here. The Working category documents matching agent access in **orgtree-tool-read-reply-source** and selection wrappers in **orgtree-tool-message**.

## Files downloads and image viewers

In an agent's Files tab, both the filename and Download save the delivered
snapshot, including from a desk in a separate window. Downloads are limited to
256 MiB; a failed download shows an error beside its link. View opens an image
in that window. Escape closes the image viewer and leaves the desk open; the
Close button and backdrop also close the viewer.

The image viewer's download link uses the same authenticated download path,
256 MiB limit and visible failure handling, including in a separate window.
