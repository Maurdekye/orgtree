Orgtree 2.0.0 is the stable desktop release.

- Transcript history is stored in SQLite and loaded in small pages sized to the visible agent window, with extra rows for smooth scrolling. Earlier history loads as you scroll. Streaming events keep the transcript updating even when reads are slower than the event stream.
- Pending mail, delivered mail and submitted question answers preserve one visible representation through delivery. User and agent messages share the same card layout and reply annotations.
- Registered secondary accounts appear separately in the Usage modal. Managed Claude profiles sign in and read transcripts from their own folders. Reset estimates use the serving account's usage, preserve measured deadlines, and keep API-key billing separate.
- Inbox and presentation lists read the metadata and history ranges they need. Presentation previews stay in the collection's preview pane. HTML mockups have a visible badge.
- Individual agent dockets include backlog/archive filters, sorting by update, creation or status change, and grouping. Tickets support image/file attachments, and owners, participants, reviewers and assignees can change ticket state.
- Hide retired agents consistently hides retired jump and audience entries while retaining the retired-list control. Pinned modals come to the front when activated, and reopening an org fits the graph inside the remaining canvas area.
- The Windows taskbar uses Orgtree's icon and application identity. Updates use the silent installer path and retain the installation mode and directory. Header controls remain clickable while blank title-bar areas drag the window.

The installer is unsigned. Windows may display its normal publisher or elevation prompt. The secondary-account settings redesign and mailhub authentication design pass remain deferred as requested.
