# Docket and transcript ticket menus

USER 2026-10-20 17:26:35Z requires the exact same item menu for docket rows
and ticket links everywhere, including quick Staff on backlogged items. This
supersedes the earlier separate transcript menu with row-only Staff. Coordinator
clarification 17:27:20Z keeps Show/Hide sub-items only where a real list fold exists.

## Exact menu

Both call `ticketMenuEntries` in `canvas/ticketmenu.ts`; there is no separate
reduced link menu. It uses `ticketReferenceActions` and `ticketOwnerAction` for:

1. Open details (always that label; an already selected docket row stays open).
2. Owner... (displayed with an ellipsis glyph), when the ticket has an owner.
   Its submenu starts with Copy mention, then the current canonical agent
   entries. Selecting its parent invokes the enabled Focus entry. With no
   available Focus, the parent is action-disabled while the submenu stays usable.
3. Separator.
4. Copy ticket title (full title).
5. Copy slug.
6. Copy reference (@item:org/slug).

Both add Staff when the ticket is unarchived, backlogged and scoped to a real
org, using the same `ticketStaffEntry` and existing `quickStaffEntry`. Rows alone
may insert Show/Hide N sub-items before Staff when kids>0, a real fold callback
exists and search has not locked folding. One separator precedes these actions,
and none appears when neither exists. Canonical node Open submenus remain second
at every level through the shared context-menu renderer.

Rows retain draw-time warm-up, pointer/focus refresh and loading/error updates.
Reference menus fetch the current item, reuse any held staffing preview, and
otherwise join the existing single-flight per-ticket preview request. The engine
preview reads cached availability; links do not mount a hidden docket, poll or
invent provider/model choices. Preview refusals produce the same disabled Staff
entry as rows. Existing request/direct modes, model/effort/account gates,
idempotent submission and commit-time revalidation remain in `quickstaff.ts` and
the engine's quick-staff endpoint.

Left clicks still toggle docket selection, and double-click still copies the
slug with its existing success bubble and selection cleanup. The context-menu
Open details route uses the latest selection so it never closes an open ticket.
Copy slug keeps its existing row feedback; title copy uses the canonical value
and feedback. Normal product row callers supply org. The unscoped standalone
row retains its existing omission of Copy reference/Staff instead of inventing
an org. Manual attention flags do not add a dismissal menu; detail-pane dismissal
controls are unchanged. The stale row comment claiming such an entry is removed.

ObjectNavHost routes its current item to the same builder as DocketRow; its
owner entry retains the canonical labels, child order, Focus gate and callback.
The common menu wrapper leaves explicitly supplied Copy ticket title in its
canonical position, without prepending its automatic copy entry/separator.
Other automatic object-copy paths and more-specific agent/object menu precedence
remain unchanged. Reference menus now include the complete item actions,
including Staff; list-local folds remain on their actual rows.

## Focused verification

Ticket hover text is the authoritative full title on rows, React and Markdown
references, bare slug links and tool-result links (user 2026-10-21 06:53Z).
The document-local object tooltip host asks for only the exact hovered ticket,
coalesces concurrent reads without retaining a stale catalog, and ignores a
reply after the target changes, leaves, disconnects or its host is removed.
Popout documents register the same host. Row-local fold/staff controls and
their existing prefetch rules remain unchanged.

Presentation identities use this same document-local tooltip mechanism with
their full title (user 2026-10-21 06:53Z); cards, both galleries, tool cards,
React/Markdown references and inner reply targets share `presentationMenu`.
Gallery selection may still change Open to Close and add genuine reply/dismiss
actions. A reply frame keeps its contents/sender actions while its inner
document target wins with the document menu. Late presenter metadata replaces
the complete canonical menu rather than appending identity actions out of order.
Unread classes/read marks, dimmed retired rows and native download/HTML-preview
controls keep their existing behavior; only identity hover text is unified.

`ticketstaffmenu.test.tsx` compares complete row menus with real React,
Markdown and bare ticket references for backlogged/open/done and archived items.
It covers request submission, direct model/effort gates, denied previews, a
standalone link with no docket mounted, current versus historical status, and
canonical owner Open ordering. `docketmenuparity.test.tsx` retains the broader
owner/attention/archived matrix, copy behavior and real fold controls.

The author measured the new regression red first: ten tests, five passes and
five intended failures. The focused ticket/parity/Open tests pass. The broader
objectnav suite retains one independently reproduced base failure for its
removed-watchdog fallback expectation; that watchdog path is outside this item.
Raw evidence is retained by the author. Renderer proof uses synthetic data and
one inspected offscreen 1000x700 capture, with no installed-app/live-data claim.
# Mail identity links (2026-10-21)

Local organization rows, React/Markdown `@org:` links and Sender submenus share
`orgMenuEntries` and `orgTitle`. Only rows with the real deletion-confirmation
callback add Delete. Remote addresses retain the Hubchat capability check rather
than acquiring a local organization route. [decided: user 2026-10-21 06:53Z;
verified: `orgidentity.ts`, `agentmentions.tsx`, `shell/orgrows.tsx`]

Mail links use `mailMenuEntries` for their common Open/copy-text/copy-reference
menu. Inbox rows retain real Close, reply, read, retract and delete capabilities;
reply frames retain their contextual menu, while the inner message link uses the
message menu. The shared native tooltip resolves the exact mailbox/id and formats
sender, full date and id through `mailTitle`. It never searches history or another
mailbox. User-inbox identity (`@user`) is distinct from a message id. Full-message
copy uses the existing chunk resolver and preserves body whitespace. [decided:
user 2026-10-21 06:53Z; verified: `mailidentity.ts`, `objectnavhost.tsx`,
`objecttooltip.ts`, `maillinkparity.test.tsx`]
