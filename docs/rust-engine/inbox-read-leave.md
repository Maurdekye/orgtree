# Inbox read lifecycle

The user requested consistent read-on-leave on 2026-10-19 13:20Z. Selecting an
unread message keeps its unread state while its full body is displayed. The
shared `MailList` records committed reading-pane bodies and acknowledges each
departing real mail once, retaining its org-bound callback across prop changes.
This covers click/keyboard selection, reference jumps, text/tag filtering,
folder changes, refreshed data removal and host unmount (modal, tab or pin).
Folded notices display all member bodies and acknowledge those members.
Scrolling the list does not mark a still-displayed reading pane read.

`mailleave.ts` retains pending saves after a list unmount. Native main/pop-out
close dispatches a promise-carrying flush event and waits before continuing the
existing close policy. A repeated close joins the same drain. A renderer drain
timeout/error leaves the ordinary window alive and reports failure. App quit
and update use the existing bounded layout/shutdown event, now awaiting its
pending read promises before stopping the engine. Browser unload/pagehide also
flush, with keepalive read requests as fallback. Hard kills and crashed
renderers cannot guarantee a read save.

Portal readers bind to their actual surface document: a child close flushes
that child, and app exit drains all windows owned by the top-level renderer.
Sent rows and question cards are excluded. Agent/project mail lists have no
user-read callback: inspecting or closing them never claims or acknowledges
their delivery queues. The org-wide external inbox keeps its existing shared
read-cursor behavior; its callback now returns its save promise for draining.
