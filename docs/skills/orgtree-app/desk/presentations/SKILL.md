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

## Collections and reader

The org gallery groups documents from currently hired agents first, with Show retired to include retained retired/deleted-agent presentations. The agent gallery and desk Presented tab narrow to that agent. The agent menu's Open → Presentations → Team presentations widens the same view to the agent and everyone below it, passing through projects; for a project, Open → Presentations (and its desk's presented tab) lists the documents attributed to the project, and Open → Presentations → Team presentations adds those of every agent under it (both menu options are offered whenever their openers exist, even when empty). Every row and the reader name the presenter as a link that focuses it: the agent for its own document, and for one presented under a project the project (with its folder mark), with a "presented by <agent>" line beneath (in the reader, "this presentation was presented by <agent>"). A team window stays a team window when pinned, popped out or restored. Renaming an agent or a project keeps its presentations in its gallery, listed under its current name. Selection uses document identity, not a row index; exact document references can locate older entries beyond the first loaded window.

Open a card to read its Markdown or HTML preview. The reader identifies title/author/time and supported references, plus applicable reply/dismiss/download controls. A missing/failed load says so instead of manufacturing an empty document. An HTML card offers its explicit prototype/new-tab route; previewing content does not grant it an agent's tool authority.

Presentation lists highlight documents you have never opened, or that changed since your last view, like unread mail: a bold accent title and brighter metadata. This applies to the full Presentations window and agent/project Presented tabs, including pinned and popped-out views. Opening a presentation clears its highlight through the existing saved user viewed state. An agent reading it does not mark it viewed by you.

Each fresh opening automatically selects the oldest unread or changed presentation, ordered by its current creation/replacement time. If all are read, it selects the most recently created or changed presentation; an empty collection stays empty. Explicit document references take priority. Polling and viewed-state updates never replace your selection while it remains in the surface's scope, except that an authoritative refresh clears a selected document that has left the current scope (for example after its presenter moves out of that team) so later document links route using current ancestry. The engine locates the selected document across the whole collection. Every fresh opening includes the newest end as well as the selection: a distant oldest-unread target gets another bounded range with a gap control between the ranges. The unread selection is revealed after layout without repeatedly pulling the list back during refresh. Gap controls load intervening documents; Load newer documents reaches entries above the current window and scrolling down loads older ones.

Readers are one per scope: the organization's Presented documents, one for each agent or project, and one for each agent's or project's team. Several can be open at once, each with its own place. Opening a document (a card, chip, badge, reference or docket link) brings to the front an open reader that can show it, showing it: one already showing it in its current scope first, then the document's own agent or project reader, then the nearest team reader above it, then the organization's. If none is open, the document's own agent or project reader opens on it. The Team box in a reader switches it to that team's reader in the same place.

Pin/window controls change the reading surface. Closing a reader leaves the presentation in its collection; Dismiss removes its displayed card through the document operation. These are different from retiring its author.

Pinned agent and team readers remember the document currently selected, even
after another reader opens. Restoring the saved window reopens that document
for the same node generation and reader scope.

Organization and agent presentation modals collapse the list into a menu-controlled overlay when their reading area is 896 CSS pixels wide or less. The breakpoint follows that area's width in a popout too, including snap-layout resizing; widening restores the list column. Resizing and moving the panel retain selection, filters and list position. Inline desk lists remain columns.

## Copy, download and reply

Document menus can copy title/reference, open/close, download Markdown or the HTML prototype bundle, stage a reply in the desk composer (`Reply` on presentation chips in an agent's desk header and rows in its Presented tab), and dismiss when the surface permits it. Contextual replies address the presentation's source and support attachments where available. A failed reply does not amend the document.

Download saves a file; it is not proof the user read the card or that a file was sent through a different delivery route. File cards/images have their own view/download behavior and custody. Do not suggest that moving a scratch file into a folder will make it appear in Presented.

For the agent-side publishing contract see `orgtree-tool-present` (orgtree-working › user); for an installer/log/export/image wanted as a file see `orgtree-tool-send-file` there. Those pages own limits and supported input formats.

## See also

- See `orgtree-tool-present` (orgtree-working › user).
- See `orgtree-tool-send-file` (orgtree-working › user).
