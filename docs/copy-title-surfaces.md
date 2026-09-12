# Copy names and ticket titles

The two actions are **Copy agent name** and **Copy ticket title**. They copy
the recorded agent ID or the ticket's full title as plain text. Model badges,
mail's decorative `@` prefix, status, generation descriptions, and ticket slugs
are not added. A bearer ID such as `worker@12` keeps its generation suffix.
Whitespace, punctuation, Unicode, and line breaks in a title are preserved.

## Surface inventory

Inventory based on renderer JSX, every `useContextMenu` call, all `AgentName`
callers, and both reference renderers. Paths below are relative to
`apps/desktop/renderer/src`. These are application objects, rather than matching
arbitrary words in prose to names in the current org.

| Object surface | Rendering source | Menu treatment and headless evidence |
| --- | --- | --- |
| Agent canvas cards, normal/mini, live/archived/unrecoverable/bearer, pile fronts | `canvas/cards.tsx`, `NodeSquare` | Existing card menu gains copy. Tested across all states; existing retire/hire/navigation tests retained. |
| Compact map card | `canvas/cards.tsx`, `NodeSquare` map branch | Shared fallback. Direct renderer test checks the map branch. |
| Agents List rows, live/archived, filtered ancestors | `canvas/OrgCanvas.tsx`, `.tray-row` | Explicit row identity works with the shared fallback or an existing row menu. Tested live/archived with camera unchanged and list surviving copy/Escape. |
| Switchboard tabs, including tabs for pinned desks | `canvas/cards.tsx`, `EyeDesk` | Shared fallback; tested with open state unchanged. |
| Focused, switchboard, pinned, detached and compact desk headers | `canvas/desk.tsx`, `.cc-head-left`, `AgentName` | Shared fallback. Focused and bare desk variants tested; the bare renderer is shared by switchboard, pinned and compact desks. |
| Superior/report jump cards | `canvas/desk.tsx`, `NavChip` | Shared fallback; agent copy tested, human switchboard target excluded. |
| Pinned agent window title/name | `canvas/pins.tsx`, `.pinwin-title` | Existing Show on canvas/Unpin menu gains copy; pin and navigation remain unchanged. |
| Pinned/elsewhere desk placeholders | `canvas/pins.tsx`, `PinnedPlaceholder`; `canvas/deskhosts.tsx`, `RegisteredSlot` | Shared fallback; pinned placeholder tested, elsewhere text uses the same explicit identity. |
| Lineage generation entries and prior-generation identity | `canvas/desk.tsx`, `LineagePanel`, prior transcript notice | Shared fallback; generation IDs retained. Actual lineage rows tested. |
| Retired pile/live team stack picker entries | `canvas/modals.tsx`, `PilePicker` | Shared fallback; both pile kinds tested without choosing a front agent. |
| Agent configuration, inbox, lineage, docket and presentation window bars | `canvas/modalpin.tsx`, `PinFrame` using `restore.agent` | Existing window menu gains copy of the agent ID, without the surface suffix. Each actual modal tested. |
| Agent configuration/inbox/lineage/docket headings and gallery attribution | `canvas/modals.tsx`, `mail.tsx`, `desk.tsx`, `agentdocket.tsx`, `gallery.tsx` | Shared fallback; actual modal headings tested. |
| Agent identities in mail lists/readers, transcript senders, audience chips, ticket actors/reviewers/participants/recipients/history/groups | `canvas/identity.tsx`, `AgentName`; `App.tsx`, `SenderChip` | Names and their model chips are marked once in `AgentName`; existing row menus gain the nearest identity's copy entry. Mail list/reader/transcript and ticket actors tested, plus linked/plain/own-desk/prefixed/bearer `AgentName` variants. |
| Question/credit/scope issuer names, open and resolved requests | `canvas/asks.tsx`, `AskHead` / `NulledAsk` | Shared fallback; open/resolved question cards tested. |
| Presentation publisher names in org/agent gallery rows and readers | `canvas/gallery.tsx` | The publisher is an agent object inside a document row. Both gallery lists and readers tested; document title/menu remains a document. |
| Active, nested, archived, backlogged ticket rows | `canvas/docket.tsx`, `DocketRow` | Existing row menu gains full-title copy alongside Copy slug/Copy reference. Both org and agent docket variants tested, without selecting/folding. |
| Ticket detail title and slug line | `canvas/docket.tsx`, `DocketPane` / `SlugText` | Shared fallback copies the full title from the loaded ticket. Both docket variants tested. |
| Canonical agent/ticket references in React prose and rendered Markdown | `canvas/reflinks.tsx`, `RefChip`; `canvas/refmd.tsx`, `chipEl` | Shared fallback or containing object's existing menu. React and Markdown, navigable and read-only variants tested. Agent tokens supply an exact ID; ticket copy requires a known title. |
| Resolved bare ticket/agent mentions | `canvas/workrefs.tsx`, `WorkRefText` | Shared fallback. The mention index carries the exact title separately from its displayed slug. Linked/plain ticket mentions tested. |
| Detached versions of the above | `popout.tsx`, `MovableSurface` | Same boundary in the surface's document. Simulated child-window test checks clipboard, focus restoration, feedback, menu location and Escape. |

The retained compact outer sheet header and restored-desk recovery label in
`OrgCanvas.tsx` are marked as well. The current `mobile.tsx` exports
`isMobile = false` and `sheetGate = () => false`; the compact outer sheet
cannot be opened by this desktop build. The shared bare desk and map renderer
are exercised directly rather than claiming an unavailable mobile end-to-end run.

## Native behavior and boundaries

- Editable controls, ordinary nested hyperlinks, and a live text selection
  retain the browser's menu. Tests cover each and copying after selection ends.
- The human root/switchboard, an unfinished hire draft, model choices, file
  names, document titles, watchdogs, accounts and org names are other objects.
  Their existing menus are unchanged.
- Ordinary prose, raw event fields, import source reports and tooltip-only
  names do not become new objects through text matching. Existing explicit
  reference and identity renderers determine the scope.
- A ticket token containing only a slug, with no known title, cannot provide
  an exact title. It gets no title-copy action until the surface has that
  title; its normal navigation/reference behavior remains available.
  `RefWorld.itemTitles` is separate from display labels because docket labels
  deliberately remain slugs. No lookup invents a title from a slug.
- Read-only/public views use the same copy action on the information already
  shown. No copy path invokes an org operation or navigation callback.

## Shared implementation

`data-copy-agent-name` and `data-copy-ticket-title` identify exact copy text.
`useContextMenu.open` adds one copy entry to existing menus. `ObjectMenuBoundary`
replaces the app/surface's existing div, preserving DOM layout, and supplies
the same menu for marked objects without their own handler. It passes the
existing app toast callback through context; copying uses the existing
owning-window `copyToClipboard` helper. Missing, denied, or throwing clipboard
implementations return failure feedback without claiming a copy.

The menu's actual anchor is tracked in a WeakMap. Agents List click-away now
recognizes its own menu portal, and Escape closes that menu before its list.
Pinned window capture handlers use the same ownership test so choosing a copy
entry does not raise or reorder overlapping windows.
The shared focus restore accepts elements from a detached document's realm.

Run the headless tests with:

```
node apps/desktop/renderer/tests/run.mjs copytitles
node apps/desktop/renderer/tests/run.mjs contextmenu
npm run typecheck
```

These are jsdom interaction tests. They do not claim native OS clipboard or
visible GUI verification; no live backend or live user data is used.
