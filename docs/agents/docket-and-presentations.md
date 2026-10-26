# Docket and presentations

Continued docket readers pass their own saved/current identity to the paged
feed's bounded candidate lookup, independently of generic collection memory.
Org, agent and team scopes keep their ordinary filters and server eligibility;
an off-page continuation never fetches the intervening history. Polls retain
that reader's candidate without re-running its initial selection choice.
[verified: `canvas/useworkitems.ts`, `canvas/{docket,agentdocket}.tsx`,
`tests/docketcontinuation.test.tsx`; 2026-10-23]

## Inline HTML presentations (2026-10-26)

The reader pane shows the selected HTML presentation inline (`HtmlPresentationView`
in `canvas/docs.tsx`, mounted by the shared gallery `DocPane`); list rows and History
never render one. It fetches the stored preview the window shows (the
`/documents/{id}/mockup` route, captured local assets inlined) with the app's own
credentials and renders it as `srcdoc`:

- `sandbox="allow-scripts"` only: an opaque origin with no app DOM, storage,
  credentials, forms, popups, modals, downloads or top navigation.
- The window viewer's CSP (`http/docs.rs` `mockup`) as a `<meta>` after the author's
  doctype, so standards or quirks mode matches the window, and before every author
  element; then `<base href="about:srcdoc">`, which keeps `#section` links inside the
  document, and a no-referrer policy. The doctype scan is linear: agent-written
  leading comments must not be able to stall the renderer.
- The main session's request guard (`main/windows.ts` `configureEngineSession`)
  cancels every subframe request that is not `about:`, closing CSP's navigation gap;
  only the app's own top frame is signed or granted a permission.
- One frame at a time, up to 4 MiB of stored preview (`HTML_PRESENTATION_INLINE_MAX`,
  provisional). A larger preview, possible only when a folder bundle's assets are
  inlined, shows a note and keeps the window link; a body whose Content-Length
  declares it too large is cancelled unread.

**Fit width** (the default) is an in-frame script: content wider than the frame is
scaled down with CSS `zoom` on the root element, measured unzoomed, and fitted again on
resize, load and structural changes. **100%** removes the zoom. The reader posts the
choice into the frame (`{orgtreePresentationFit}`), so switching keeps the
presentation's own state, and the choice carries to the next presentation opened in
that window. A link click that would leave the document does nothing, as in the
window viewer, while #fragment and javascript: links work; a navigation started by a
script is cancelled by the guard and leaves an error page in the frame, where the
window keeps its page. That parent-to-frame post is the only message: the app registers no
`message` listener for presentation frames.

Presentations are one-way and custom apps are the two-way feature; the two stay
separate (user 2026-10-26 21:36:16Z m2da6e3eb205d, mc5f0c7fac8ff). App-to-agent
notification goes only through declared fired events, never mail or direct agent
targeting (user m61de6ee6429c). **Open in a new window** in the reader toolbar, and
**Open HTML presentation in a new window** on the context menu and in History, open the
isolated window viewer, as one click on a canvas chip or desk badge does.
[decided: user 2026-10-26 m027a7754ab06, m180c5c6cad58, m2da6e3eb205d, mc5f0c7fac8ff,
m61de6ee6429c; coordinator m9834e9b5599b; verified: `canvas/{docs,gallery}.tsx`,
`api.ts::getPresentationHtml`, `main/windows.ts`, `tests/htmlpresentation.test.tsx`; 2026-10-26]

## Bounded gallery location (2026-10-23)

Explicit/continued `locate` reads return only the target's admitted page and
actual offset, rather than the full history prefix. The sparse reader keeps
its newest and target ranges and re-locates the target by identity on later
polls. [verified: `http/docs.rs::gallery_locate_page`,
`tests/presentationopening.test.tsx`; 2026-10-23]

## Desk reader availability (2026-10-23)

Desk **Docket** and **Presented** tabs hide when neither the node nor its team has anything the tab would list under its default filters. A tab appears or disappears as content changes, but stays visible while you are on it; an empty tab disappears when you leave. Search and sorting do not hide tabs. The Docket check follows the existing list, including recently completed tickets during their one-hour window and attention exceptions. Show archived and Show backlogged include those groups when enabled. Presented starts with hired presenters; Show retired includes retired presenters.

When only the team has content, entering the tab starts with **Team** checked and auto-select works in that team scope. A manual untick is remembered for this organization and node across visits/restarts until own content arrives. Own content keeps the ordinary own-node default. Live arrivals do not switch the scope or selection of a reader you are using. These rules apply to both agent desks and project Presented tabs. A project Docket already lists its subtree and keeps that scope without a Team checkbox.

`reader_availability.rs` returns four booleans from scoped EXISTS reads. It uses
the same `PAGE_GROUP_SQL` as the docket page, canonical open ask tabs, owned-or-reviewed
agent membership, and descendant-owned project/team membership. It never loads docket
history, document bodies or an entire gallery. Document membership is by agent ID
with the existing legacy name fallback; subtree traversal is cycle-safe. No migration.
Desk presentation pages opt into `visible=true`; their rows, totals and opening/locate
positions share dismissed/hired filters, so invisible history cannot produce a blank
first page or a wrong opening position. Other reader callers keep their existing pages.

The renderer validates all four boolean availability facts before publishing a
successful read. An incomplete successful response is unavailable, not an empty
collection; the poll keeps its last confirmed facts and retries through its
normal live/fallback schedule. This keeps malformed/older endpoint replies out
of the desk filters. The shared single-node FakeServer models this endpoint;
team-specific fixtures must provide their explicit scoped summary.

`deskreaders.ts` owns the shared visibility and team defaults. It holds a settled
scope while active and waits for the first availability answer before mounting a
fresh reader, so an own-scope opening cannot race ahead of a team default. Manual
team choices use the existing per-org/node desk memory and follow rename/reset.
Header badge counts remain separate. These are user display/navigation preferences;
existing docket and presentation read tools retain their authority and scope, with
no new agent tool card, tool-prefix growth or user-viewed write by an agent.
[decided: user 2026-10-23 m725412d6748e, m46f154fe793f; coordinator m6327d4ef662e;
verified: `canvas/deskreaders.ts`, `canvas/{desk,projectdesk,gallery}.tsx`, `http/reader_availability.rs`]


## Opening priority (2026-10-23)

A fresh opening selects the topmost ticket with a manual attention flag, or the oldest unread/changed presentation by its current update/creation time. Otherwise it restores the last viewed eligible item for that organization and collection scope (org, node/project or team), then the topmost row, or nothing for an empty list. Closed tickets and dismissed documents do not win the remembered-item preference. The preference survives close/reopen and restart, respects current filters, and does not mark a document viewed on an agent's behalf.

This applies to the top-bar buttons, agent/project Open submenus including team views, and entering a desk's Docket/Presented tab. Leaving a desk tab and returning is a fresh opening. Explicit item/document links keep their target. Bringing forward, resizing, pinning, popping out or restoring an already-open reader keeps its current selection, including a deliberate empty pane. Polls never replace a choice.

`readeropening.ts` stores identity-only local navigation under `orgtree.reader.last.v1:`
plus a JSON scope tuple. Clearing a pane does not erase the last-viewed identity.
Window/pin restore metadata additionally stores `selection` (empty string means
deliberately empty); do not confuse continuation with a fresh generic opening.
This is display/navigation behavior. Agents retain `orgtree_work get` and existing
document reads; no new tool definition or user-viewed write is added for them.

Presentation opening passes `previous` to the existing scoped opening lookup;
unread still wins across unloaded history. The final fallback follows actual list order (document ID descending), not the modification timestamp used for unread priority. Docket first pages may include at most
two extra `opening_rows`: one manual flag and one named remembered row, under the
same group/search/node filters. Normal page cursors stay unchanged; refresh only
keeps the named row and never re-arms opening. No migration is required.
## Retained download cards (2026-10-23)

Download-card history uses ot.deliveries, independently of documents and hub
transfers. Keep the bounded per-agent reader and existing immutable snapshots;
never recover this list by scanning transcripts. The Files tab uses compact rows,
newest at the bottom, with anchored scroll-up paging and live append that follows
only a reader already at the bottom (USER 2026-10-24). See
[agent files](../rust-engine/agent-files.md).
[decided: user 2026-10-23, release after 4.4.2; verified: domain/deliveries.rs]

## Object actions belong to a composer (2026-10-22)

Ticket/presentation Mention and Reply capture the nearest owning message box
before asynchronous metadata reads. `canvas/composerobjects.tsx` registers
desk bodies and mail readers; Quick chat registers only the canvas-world in
the main area sharing its footer. A nearer unavailable desk blocks fallback,
and closed/replaced scopes invalidate captured callbacks. Standalone galleries
and dockets keep their prior menus. Reading panes embedded in a desk use
their own contextual reply box before the desk's box; ACK-job reply boxes use
the same routing. Reply stages an identity without sending
or changing recipient; ticket wires must include the canonical `slug` field.
Project sends/broadcasts retain object targets; Quick chat defers kickoff until
after hire when it must send a typed reply. See the [composer glossary](../skills/orgtree-app/desk/desk-chat/SKILL.md#composer).
[decided: user 2026-10-22 21:49:14Z, coordinator routing 21:51Z;
verified: `canvas/composerobjects.tsx`, `canvas/ticketmenu.ts`,
`canvas/docs.tsx`, `eventReply.ts`]

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Selection reply snapshots preserve exact text/context independently of source
edits; canonical part reads retain ordinary source authority, bounded windows,
and no mail/viewed side effects. List entries without durable IDs refuse duplicate
text; never relocate to another entry. See [selection replies](../rust-engine/selection-replies.md).
[verified: `domain/{selections,reply_sources}.rs`; decided: user 2026-10-23]

Work records, questions, documents, attachments, viewers and attention.

**Every docket selects its first shown ticket on open (user 2026-10-21
16:50:46Z):** replaces the org-only, unarchived/non-backlogged default of
2026-10-13 recorded below. `DocketModal` serves the org panel/pop-out;
`AgentDocketView` serves agent/team/project modals and agent/project desk tabs.
Both use their displayed section/nesting/fold order, including any enabled
archive/backlog sections. Wait for initial data, consume even an empty first
load, and reset only for a fresh open or a different org/node. Explicit item
links keep their target through the existing org docket jump route. A user
selection or clear consumes opening; polling, sorting and filtering never
reselect. Project page fixtures must model `http/docket.rs::page`'s
`agent=<project>` subtree interpretation, rather than treating the project as
an item owner. [decided: user 2026-10-21; verified: `canvas/docket.tsx`,
`canvas/agentdocket.tsx`, `canvas/desk.tsx`, `canvas/projectdesk.tsx`,
`tests/docketopening-all.test.tsx`]

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-5af536d67d272161"></a>

## Presentations reveal the opening unread selection once inside their list,

Original section: Unsectioned integration notes. Source lines 47–52.

<!-- preserved:e-5af536d67d272161 -->
- Presentations reveal the opening unread selection once inside their list,
  including a distant target page. Capture unread before the reading pane
  marks it read; defer hidden lists until measurable, using their owner window.
  Polls and later user selection/scrolling never re-arm the opening request.
  [decided: user 2026-10-20 18:53Z; verified: `canvas/gallery.tsx`,
  `tests/presentationscroll.test.tsx`]
<!-- /preserved:e-5af536d67d272161 -->

<a id="e-1d016b2bf8978b98"></a>

## Docket rows and every ticket-link menu use canvas/ticketmenu.ts for all

Original section: Unsectioned integration notes. Source lines 73–78.

<!-- preserved:e-1d016b2bf8978b98 -->
- Docket rows and every ticket-link menu use `canvas/ticketmenu.ts` for all
  item actions, including Staff on eligible backlogged items. Only real list
  folds stay row-specific. Link menus read current item state and share the
  row's staffing cache, preview/commit gates and action implementation.
  [decided: user/coordinator 2026-10-20 17:26Z/17:27Z; verified:
  `canvas/{docket,objectnavhost}.tsx`, `tests/ticketstaffmenu.test.tsx`]
<!-- /preserved:e-1d016b2bf8978b98 -->

<a id="e-64f1421f316d793b"></a>

## HTML capture failures for missing/unreadable local assets name the source

Original section: Unsectioned integration notes. Source lines 80–84.

<!-- preserved:e-64f1421f316d793b -->
- HTML capture failures for missing/unreadable local assets name the source
  reference as written, its resolved path and the referring HTML/CSS file.
  Preserve typed refusal context at the tool boundary; outer anyhow context
  alone is discarded for UserError. Capture bounds/containment stay unchanged.
  [verified: `domain/html_bundle.rs`, `domain/html_bundle_tests.rs`; 2026-10-20]
<!-- /preserved:e-64f1421f316d793b -->

<a id="e-95d2138b00155eed"></a>

## Presentation galleries select the oldest unread/changed card on each fresh

Original section: AGENTS.md — working on Orgtree. Source lines 285–297.

<!-- preserved:e-95d2138b00155eed -->
- Presentation galleries select the oldest unread/changed card on each fresh
  open, otherwise the newest by current `at`; explicit references and later
  user choices win. Every opening includes the newest end too (replacing the
  old detached target-page opening): <=200 contiguous rows, or two 40-row
  pages for a distant target, with a labelled scroll/click gap. Later reads
  stay <=200 rows each. `documents?opening=1` still locates the target via
  migration 0041 indexes; `docwindow.ts` owns the loaded ranges. Opening waits
  for pending local viewed marks; SQL unread checks use wire millisecond
  precision, and matching viewed marks store the full current timestamp.
  This prevents read cards with submillisecond timestamps becoming phantom
  unread targets. Org defaults exclude retired authors.
  [decided: user/coordinator 2026-10-20; verified: `http/docs.rs`,
  `canvas/gallery.tsx`, `tests/presentationopening.test.tsx`]
<!-- /preserved:e-95d2138b00155eed -->

<a id="e-4b012b48dd3defab"></a>

## Docket palette tests read the shared --docket-status-color mapping. The

Original section: AGENTS.md — working on Orgtree. Source lines 337–340.

<!-- preserved:e-4b012b48dd3defab -->
- Docket palette tests read the shared `--docket-status-color` mapping. The
  ticket-edge Chromium capture checks computed Waiting equals `--warn` and
  differs from Open in both themes. [verified: `tests/{docket.test.tsx,ticketedge-capture.cjs}`;
  coordinator hardening finding 2026-10-20]
<!-- /preserved:e-4b012b48dd3defab -->

<a id="e-97eb329227553714"></a>

## Attention list rows toggle off on a second click; Escape clears when the

Original section: AGENTS.md — working on Orgtree. Source lines 536–541.

<!-- preserved:e-97eb329227553714 -->
- Attention list rows toggle off on a second click; Escape clears when the
  list itself has focus. A reader-cleared pane stays empty through refreshes,
  without reading another mail. Initial/empty-queue arrivals and resolved-row
  neighbor selection still open normally; explicit clicks/keys/notifications
  resume selection. [decided: user/coordinator 2026-10-19; verified:
  `attention/AttentionQueue.tsx`, `tests/attentiondeselect.test.tsx`]
<!-- /preserved:e-97eb329227553714 -->

<a id="e-286431a269ca55ff"></a>

## Presentation lists share unread mail's bold/accent title and brighter metadata

Original section: AGENTS.md — working on Orgtree. Source lines 635–639.

<!-- preserved:e-286431a269ca55ff -->
- Presentation lists share unread mail's bold/accent title and brighter metadata
  for new or replaced documents, using existing `viewed_at` plus `docviewed` marks.
  Shared gallery rows subscribe to viewed changes; successful user opens clear
  the highlight across surfaces. Agent reads do not consume this user state.
  [decided: user 2026-10-19 13:17Z; verified: `canvas/{gallery,docviewed,docs}.ts*`, `http/docs.rs`]
<!-- /preserved:e-286431a269ca55ff -->

<a id="e-016ef838c2ea1489"></a>

## Inbox read-on-leave follows committed reading-pane bodies, not selection

Original section: AGENTS.md — working on Orgtree. Source lines 640–647.

<!-- preserved:e-016ef838c2ea1489 -->
- Inbox read-on-leave follows committed reading-pane bodies, not selection
  call sites. Filters, references, folders, tabs and unmounts preserve the
  departing mail and its org-bound reader. Native window close/app exit drain
  pending reads before teardown; adopted pop-outs use their owner document.
  Scrolling while the body stays displayed does not leave it. Agent/project
  delivery queues remain read-only to this UI (no user-read callback).
  [decided: user 2026-10-19 13:20Z; verified: `mailleave.ts`,
  `canvas/mail.tsx`, `main/mail-read-close.ts`]
<!-- /preserved:e-016ef838c2ea1489 -->

<a id="e-5707ea246383c7ce"></a>

## The persistent app-wide taskbar badge reads existing native app-feed attention

Current artwork (USER 2026-10-24, 4.4.5): Windows matches Hubchat's red centre,
light rim and antialiased edge, with no count. This supersedes the historical
no-ring artwork below; attention qualification and lifecycle remain unchanged.
See [current geometry and verification](../rust-engine/taskbar-dot.md).

Original section: AGENTS.md — working on Orgtree. Source lines 656–683.

<!-- preserved:e-5707ea246383c7ce -->
- The persistent app-wide taskbar badge reads existing native app-feed attention
  totals and qualifying notices: urgent mail, questions, ticket flags and mentions.
  Ordinary unread mail and standalone failures do not count. Failure notices
  retain the engine's existing urgent-or-mention `attention` flag; the badge
  and menu share `isTaskbarAttentionNotice`. [decided: user 2026-10-19 16:51–16:55Z;
  verified: `main/{taskbar-badge,jumplist}.ts`, `domain/notices.rs`]
  These indicators are independent of toast preferences/focus.
  The overlay artwork has no tray-style white ring. Its PNG alpha is decoded
  by Electron with separately sampled 100–400% DPI representations; raw bitmap
  helpers use premultiplied BGRA. [decided: user 2026-10-19 17:10Z;
  verified: `main/taskbar-dot-art.ts`, `tests/taskbar-badge-native.cjs`]
  Windows uses an overlay, macOS a dock bullet, Linux its badge API. Update on
  feed change and attach new windows immediately; no new poll/counter. Existing
  per-org arrival pulses and tray attention count retain their policies. See
  [taskbar dot](../../docs/rust-engine/taskbar-dot.md).
  The Windows menu replaces Recent with the complete waiting-item inventory;
  activation revalidates an opaque org/notice identity through a held event.
  Question destination is `questionTarget` (`desk` default, or `mail`), and
  explicit taskbar desk actions prefer an existing pin/pop-out even in Attention
  view. Banner muting never disables these navigation actions. [decided: user
  2026-10-19 11:32–11:33Z; verified: `main/jumplist.ts`, `renderer/src/notifications.ts`]
  [decided: user 2026-10-19 11:26Z; verified: `main/{taskbar-badge,index}.ts`]
  `TaskbarAttention` is the existing native controller (arrival pulses plus
  persistent badge lifecycle); jump-list rows are `TaskbarAttentionItem` and
  the pure projection is `taskbarAttentionItems`. Keep those names distinct
  from the host's controller variable. Validate host changes with the ROOT
  typecheck: scoped module checks and esbuild do not catch host name collisions.
  [verified: `main/{index,taskbar-attention,jumplist}.ts`; 2026-10-19]
<!-- /preserved:e-5707ea246383c7ce -->

<a id="e-c95ee994be48b89b"></a>

## Shared reply quotes activate their original target from the whole block or

Original section: AGENTS.md — working on Orgtree. Source lines 1254–1259.

<!-- preserved:e-c95ee994be48b89b -->
- Shared reply quotes activate their original target from the whole block or
  Enter/Space, preserving nested links and text selection. Presentation labels
  use current titles or an exact org/id read, never raw ids; missing targets keep
  a clear fallback. Older message jumps page on demand and center only their
  owning list. See [reply quote navigation](../../docs/rust-engine/reply-quote-navigation.md).
  [decided: user 2026-10-18 11:21–11:22Z; verified: `canvas/{replypreview,mailreply,presentationtitle,desk,mail}.ts*`]
<!-- /preserved:e-c95ee994be48b89b -->

<a id="e-e55bd78701f666eb"></a>

## Renderer document-level event handlers (native agent tooltip, Markdown image

Original section: AGENTS.md — working on Orgtree. Source lines 1621–1625.

<!-- preserved:e-e55bd78701f666eb -->
- Renderer document-level event handlers (native agent tooltip, Markdown image
  fallback, copyCode/revealFile/lightbox) must be registered on EVERY owning
  document, including adopted pop-out panels, with cleanup on redock/close;
  binding only the global `document` silently breaks pop-outs. [verified:
  `popout.tsx`, `agentnav.tsx`, `shared.ts`; coordinator 2026-10-17]
<!-- /preserved:e-e55bd78701f666eb -->

<a id="e-5c5412144ccf6b64"></a>

## The generic specification/feedback and hardening release pattern has its home

Original section: AGENTS.md — working on Orgtree. Source lines 1642–1646.

<!-- preserved:e-5c5412144ccf6b64 -->
- The generic specification/feedback and hardening release pattern has its home
  in `orgtree-iterative-development` (orgtree-workflows › collaboration-patterns).
  Phase gates and release-line routing there are suggested workflow rules, not
  automatic product permissions. [decided: user 2026-10-17 14:50Z; documented:
  `docs/skills/orgtree-workflows/collaboration-patterns/iterative-development/SKILL.md`]
<!-- /preserved:e-5c5412144ccf6b64 -->

<a id="e-fe5ffe2a1ca10141"></a>

## Fresh-session recovery leads with current docket scope/blockers/dependencies,

Original section: AGENTS.md — working on Orgtree. Source lines 1869–1875.

<!-- preserved:e-fe5ffe2a1ca10141 -->
- Fresh-session recovery leads with current docket scope/blockers/dependencies,
  recorded shell directory and recent superior mail before older context. Shell
  inputs in saved history/digest retain 8,192 UTF-8 bytes with explicit clipping;
  legacy missing inputs stay unknown. Write any command you'll re-run into
  breadcrumbs.md or a script file the first time you run it. See
  [recovery commands](../../docs/rust-engine/recovery-commands.md).
  [decided: coordinator 2026-10-16; verified: `runtime/convo.rs`]
<!-- /preserved:e-fe5ffe2a1ca10141 -->

<a id="e-191b70a4cdba3784"></a>

## Working checkups depend on current working status and more than 20 minutes

Original section: AGENTS.md — working on Orgtree. Source lines 1929–1936.

<!-- preserved:e-191b70a4cdba3784 -->
- Working checkups depend on current `working` status and more than 20 minutes
  of inactivity, with no docket requirement (user 2026-10-16; replaces the
  2026-09-10 actionable-work gate). Docket reminders are independent and keep
  their blocked/user-held exclusions. If both are due, the docket reminder
  wins that sweep; its resulting turn refreshes the working timer. Existing
  busy/queued/delivery and turn-admission gates remain. Contract and evidence:
  [working checkups](../../docs/rust-engine/working-checkups.md).
  [decided: user 2026-10-16; verified: `engine/rs/orgtree-engine/src/runtime/reminders.rs`]
<!-- /preserved:e-191b70a4cdba3784 -->

<a id="e-0f41db9a3158601f"></a>

## Presentations and docket panels share panel-level Alt+Up/Down navigation

Original section: AGENTS.md — working on Orgtree. Source lines 1995–2005.

<!-- preserved:e-0f41db9a3158601f -->
- Presentations and docket panels share panel-level Alt+Up/Down navigation
  over their filtered, unfolded row order. Their list root takes focus once
  on opening so auto-selected entries accept arrows without a click; keep an
  already focused descendant and never reclaim focus on later list polls.
  Preserve editor/ask ownership and boolean draft markers on reply/ask
  components, including attachments and inactive question tabs; virtualized
  docket selections mount before nearest scrolling. Mail's own handler stays
  unchanged. Contract/evidence:
  [panel Alt arrows](../../docs/rust-engine/panel-alt-navigation.md).
  [decided: user/coordinator 2026-10-15; verified from source:
  `canvas/{panelsteps,gallery,docket,mail,asks}.ts*`, `shortcuts.ts`]
<!-- /preserved:e-0f41db9a3158601f -->

<a id="e-cd0d893ad30efaeb"></a>

## When an Orgtree system, tool, screen, panel or setting changes, update its

Original section: AGENTS.md — working on Orgtree. Source lines 2081–2087.

<!-- preserved:e-cd0d893ad30efaeb -->
- When an Orgtree system, tool, screen, panel or setting changes, update its
  built-in skill leaf and the [skill-tree manifest](../../docs/skills/tree.json) in
  the same landing. Add a leaf for a new public tool or setting and extend
  the source inventory used by `tests/skills-tree-coverage.test.mjs` when
  its UI representation changes. The [tree](../../docs/skills/TREE.md) assigns
  each fact one home; registered category descriptions stay short.
  [decided: user 2026-10-15, built-in skills scope]
<!-- /preserved:e-cd0d893ad30efaeb -->

<a id="e-cb5d699ca9d2d35d"></a>

## User-history undo/redo and transient toast Undo share undokeys.ts chord

Original section: AGENTS.md — working on Orgtree. Source lines 2239–2253.

<!-- preserved:e-cb5d699ca9d2d35d -->
- User-history undo/redo and transient toast Undo share `undokeys.ts` chord
  classification; preserve native editing in the event's own document.
  Classification alone never consumes a key. See
  [renderer history and limits](../../docs/rust-engine/undo-history-renderer.md).
  Durable commands outlive toasts, use journal entry IDs, guard pending keys,
  and mirror worked-hire confirmation in the presentation's own document.
  Composite canvas hires/reorders and agent settings Save each use one gesture.
  Durable shortcuts use window capture before transient toast bubbling:
  owner-document discovery can register the history listener later regardless
  of JSX order. [verified: `historyui.tsx`, 2026-10-14]
  Shortcut documentation/scanning tracks `undokeys.ts` plus its durable and
  transient consumers; only the durable consumer binds redo.
  [verified: `shortcuts.ts`, `tests/shortcuts.test.tsx`, 2026-10-14]
  [decided: user/coordinator 2026-10-14; verified from source: `undokeys.ts`,
  `toasts.tsx`, `historyui.tsx`, `canvas/{OrgCanvas,modals}.tsx`]
<!-- /preserved:e-cb5d699ca9d2d35d -->

<a id="e-818e8f955ec02fb6"></a>

## Inbox and presented-document modals collapse their list at &lt;=896 CSS px of

Original section: AGENTS.md — working on Orgtree. Source lines 2282–2293.

<!-- preserved:e-818e8f955ec02fb6 -->
- Inbox and presented-document modals collapse their list at <=896 CSS px of
  their own reading box. `NARROW_MAILER_WIDTH` aliases `NARROW_DOCS_WIDTH`,
  replacing inbox's former560px boundary; inline desk lists stay persistent.
  Both organization and agent gallery callers retain the896px value.
  On adoption into a popout or return, the list observer must be recreated
  from the current surface document's window. A main-window observer can
  retain the adopted node without delivering its new document's widths.
  Contract and measured browser proof: [popout list width](../../docs/rust-engine/popout-list-width.md).
  [verified: `canvas/narrowlist.tsx`, real Electron adoption/resize, 2026-10-16]
  [decided: user 2026-10-14 23:07UTC, superseding mail exception from17:51UTC;
  verified from source:
  `canvas/gallery.tsx`, `canvas/narrowlist.tsx`]
<!-- /preserved:e-818e8f955ec02fb6 -->

<a id="e-a4c44404ece5e210"></a>

## Main app menu orders App settings / Usage / Usage history; main ShellHeader

Original section: AGENTS.md — working on Orgtree. Source lines 2413–2431.

**2026-10-23 supersession (USER m0d10d980821a, 4.4.4):** Shift+F6/F8 in the
historical snapshot below are unbound. Shift+Alt+Space fits the org; physical
Shift+Alt+S opens the switchboard; Shift+F7 remains. New navigation defers to
editors/widgets/composition/overlays/gestures. Current arrows, history and desk-tab
rules live in the [keyboard glossary](../skills/orgtree-app/app-settings/app-keyboard-shortcuts/SKILL.md).

<!-- preserved:e-a4c44404ece5e210 -->
- Main app menu orders App settings / Usage / Usage history; main ShellHeader
  orders Inbox / Work (Docket) / Presentations / Org settings. `APP_FKEYS` backs
  main-window function-key actions and the Settings explainer; typing fields
  keep these keys active. F1 is app Settings, F9 org Settings. F10 arms only,
  never releases a persistent halt; Shift+F10 immediately uses killAll. Local
  arming expires after five seconds; keep mouse's 500 ms safety delay and other
  modifier chords except assigned Shift+F1/F2/F3/F6/F7/F8/F10. Shift+F1/F3 reuse menu
  New/Create window actions; Shift+F2 opens/focuses its organization submenu.
  F1-F3/F6-F9 and Shift+F2 toggle their exact open target via its normal close
  cleanup, even if pinned behind another; mouse open/raise rules stay unchanged.
  Different panel targets still stack. Repeated keydown events do nothing.
  Shift+F1/F3 remain native window navigation, never close windows on re-press.
  Shift+F6 fits the org, Shift+F7 focuses the last live agent desk, and Shift+F8
  focuses the switchboard through the canvas's existing camera actions; these
  three are no-ops while an org modal surface is open.
  [decided: user/coordinator 2026-10-14 17:58/18:02UTC]
  See [function keys](../../docs/rust-engine/app-menu-shortcuts.md).
  [decided: user/coordinator 2026-10-14; verified from source: `App.tsx`,
  `shell/{menu,appshortcuts}.ts*`, `KillSwitch.tsx`]
<!-- /preserved:e-a4c44404ece5e210 -->

<a id="e-3ecc088fe9333b00"></a>

## The org Docket selects its first visible unarchived, non-backlogged row once

Original section: AGENTS.md — working on Orgtree. Source lines 2585–2589.

<!-- preserved:e-3ecc088fe9333b00 -->
- The org Docket selects its first visible unarchived, non-backlogged row once
  after opening/initial load, using current grouping/nesting/sort. Requested
  jumps and deliberate selection/clear take precedence; polls cannot reselect.
  The popped-out org surface shares DocketModal; agent/team lists are unchanged.
  [decided: user 2026-10-13 18:46UTC; verified: `canvas/docket.tsx`]
<!-- /preserved:e-3ecc088fe9333b00 -->

<a id="e-2d8de8e49415576f"></a>

## Providers presentation keeps provider enablement in each header and account

Original section: AGENTS.md — working on Orgtree. Source lines 2680–2689.

<!-- preserved:e-2d8de8e49415576f -->
- Providers presentation keeps provider enablement in each header and account
  (OpenRouter key and language model server) activation beside identity, inside the
  row's panel, with short visible labels ("Active") and full accessible names
  (`<server> active`). New provider, key or server rows follow the same pattern.
  Scope density CSS to the Providers tab; retain usage/reset/error/inactive states,
  account/key distinctions and separate add/configure dialogs. See
  [compact presentation and proof limits](../../docs/rust-engine/provider-compact.md).
  [decided: user 2026-10-12 20:22Z, 2026-10-14 11:42Z (language model server switch);
  verified from source: `canvas/accounts.tsx`, `canvas/accountsregistry.tsx`,
  `canvas/langserver.tsx`, 2026-10-12; `canvas/openrouterkeys.tsx`, 2026-10-13]
<!-- /preserved:e-2d8de8e49415576f -->

<a id="e-f79cd7d648b48a3a"></a>

## Language model servers setup is documented in README.

Original section: AGENTS.md — working on Orgtree. Source lines 2701–2714.

<!-- preserved:e-f79cd7d648b48a3a -->
- Language model servers setup is documented in [README](../../README.md#language-servers).
  Presence comes from explicitly saved servers and offered models; harness
  choices detect installed Claude Code/Codex CLIs. Keep app/server enablement,
  org access and model offerings distinct, and match the server's real context
  window. [Muse integration notes](../../docs/rust-engine/muse-code.md) document the integrated lane:
  detection, terminal sign-in/Refresh, managed accounts, each login's model/effort
  catalog and contributor-off behavior. Keep published availability and historical
  real-model evidence distinct from later fixture-based acceptance and remaining
  real-account/platform gaps. This replaces the conditional documentation hold.
  [verified from source: `langserver.rs`, `providers/mod.rs`, renderer
  `canvas/langserver.tsx`, `orgaccounts.tsx`, 2026-10-12;
  decided: user via coordinator 2026-10-12 22:03Z;
  verified: 2026-10-13 `providers/muse_models.rs`, `canvas/accountsregistry.tsx`,
  `main/providerlogin.ts`, `docs/rust-engine/muse-code.md`]
<!-- /preserved:e-f79cd7d648b48a3a -->

<a id="e-4f3f4a8a7c023e3c"></a>

## orgtree_message with kind question to @net: addresses may carry

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2935–2947.

<!-- preserved:e-4f3f4a8a7c023e3c -->
- `orgtree_message` with kind `question` to `@net:` addresses may carry
  `options` (2-10 one-line answers of at most 100 characters, all different;
  user 2026-10-12 21:12Z) and `multiple`: Hubchat question cards. The body
  gets a numbered `Pick one:` / `Pick one or more:` list every client reads,
  and the hub payload turns a question body ending in that list into `meta`
  (`question` plus a suffix `fallback` range) only when the list passes
  `net_cards::options` as written; a hub without the `meta` feature drops it.
  Answers return as ordinary mail with `> ` and `Answer: ` / `Skipped` lines;
  Orgtree does not track whether a card is settled, and nothing relays
  `orgtree_ask`. See [Hubchat question cards](../../docs/rust-engine/hubchat-question-cards.md).
  [decided: user 2026-10-11 22:42-22:44Z, 2026-10-12 21:12Z; verified:
  `net_cards.rs`, `net.rs` outgoing_payload, `tools/mailtools.rs`,
  `tools/defs.rs`, 2026-10-13]
<!-- /preserved:e-4f3f4a8a7c023e3c -->

<a id="e-7ebcd951310b08b9"></a>

## OpenRouter query IDs are its canonical lanes (openrouter for the original,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3177–3182.

<!-- preserved:e-7ebcd951310b08b9 -->
  OpenRouter query IDs are its canonical lanes (`openrouter` for the original,
  added key IDs for the others). Public readers reserve each lane; a permitted
  manual refresh calls the private reader under its existing permit, avoiding
  self-contention. Floors and caches remain per lane. Raw canned key-check
  documents in `rig.rs` are also unlogged, while safe refresh diagnostics remain.
  [verified: `usage.rs`, `tools/usage.rs`, `rig.rs`, 2026-10-13]
<!-- /preserved:e-7ebcd951310b08b9 -->

<a id="e-145699ad0736bb60"></a>

## The local 4.3 alpha bundles hub 2.2.0-alpha.0 at 959ed37 (2026-10-14:

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3184–3192.

<!-- preserved:e-145699ad0736bb60 -->
- The local 4.3 alpha bundles hub **2.2.0-alpha.0** at `959ed37` (2026-10-14:
  `1dcd3c7` plus in-memory typing heartbeats, `/api/typing`), retaining
  released 2.1.1 recovery plus approved pictures and question metadata. This
  supersedes the prior `2c22e3d` pin; it is not a published hub release.
  Packaging must verify the exact pin and rebuilt payload. Existing schema 10
  blocks downgrade to 2.1.x without a pre-migration backup; no automatic backup
  is added. See [local hub adoption](../../docs/rust-engine/mailhub-220-alpha-pin.md).
  [verified: canonical merge, unchanged runtime blobs and package pin guard,
  2026-10-13; decided: coordinator, existing local-alpha scope]
<!-- /preserved:e-145699ad0736bb60 -->

<a id="e-f012586feb53f988"></a>

## Desk document metadata is newest presentation/update first (at DESC, id

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3354–3357.

<!-- preserved:e-f012586feb53f988 -->
- Desk document metadata is newest presentation/update first (`at DESC, id
  DESC`), including replacements of old documents; the desk takes its first
  four entries. Keep the separate total count unchanged. [verified-from-source
  and disposable PostgreSQL smoke: 2026-10-07; feed/compute.rs, canvas/desk.tsx]
<!-- /preserved:e-f012586feb53f988 -->

<a id="e-ae31661e4802c5e6"></a>

## Desktop notifications retain the complete pending inventory (keyset batches,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3386–3391.

<!-- preserved:e-ae31661e4802c5e6 -->
- Desktop notifications retain the complete pending inventory (keyset batches,
  no document age-out), classify typed terminal failures separately from routine
  mail, and use a persisted attention epoch rather than dismissal `set_rev`.
  Deferred work/ask triggers reconcile effective attention at commit; imports
  preserve epochs. [verified-from-source and disposable PostgreSQL/Rust smoke:
  2026-10-07; `docs/rust-engine/desktop-notifications.md`]
<!-- /preserved:e-ae31661e4802c5e6 -->

<a id="e-0ea27d15e8d36432"></a>

## Opening a settings panel AT a control (docket cheap-compact-warning-turn-off-in-settings-link-o,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3420–3440.

<!-- preserved:e-0ea27d15e8d36432 -->
- Opening a settings panel AT a control (docket cheap-compact-warning-turn-off-in-settings-link-o,
  user 2026-10-20 12:24Z): a link anywhere (the desk's cheap-compact warning, docked or popped
  out) calls `openSettingsAt({ scope, org, agentId?, target: { tab, field } })` from
  `canvas/settingskit.tsx`, the window event `orgtree:open-settings-at` (the pattern of
  `openAppSettings`; the popped-out desk's code runs in this renderer, so the event reaches it).
  App.tsx answers `scope: 'org'` (org settings) and OrgCanvas `scope: 'agent'` (the agent's gear)
  through `useSettingsAsk`: each opens or raises the panel, ensuring it is open and never toggling it
  shut (a pinned or popped-out panel is revealed), and hands it a `SettingsTarget { tab, field, seq }`;
  the receiver bumps `seq`, so the same control asked twice is two requests and a rerender with the
  same seq moves nobody. The panel switches to `tab` and calls `useSettingsTarget` with its tab
  strip's ref (`SettingsTabs stripRef`): it finds the row tagged `field="..."` on a `SetRow`/`SetToggle`
  (`data-settings-field`) among the strip's own siblings, in the strip's own document, so two panels
  with a `cheap-compact` row, or a popped-out panel, never get each other's landing; scrolls it into
  view, focuses its control and marks it `set-target-hl` for `SETTINGS_TARGET_MS` (1.8 s; the
  `set-target-fade` keyframes in the theme's `--accent`/`--accent-soft`, no layout shift). The ruling
  on WHICH panel: the org's Policies switch normally, the agent's gear (Model tab) when its
  `configured_scope.auto_cheap_compact.enabled` is true (the org switch would not stop it); the link
  is drawn only where the warning says a cheap-compact WILL happen. Tests: `cachewarninglink`,
  `settingstarget` (incl. a second document), `settingsask`. The app-settings panel uses the same
  mechanism (`AccountsPanel` takes `target`; see the App settings entry below). [decided: user 2026-10-20 12:24Z,
  coordinator ruling 12:28Z; verified: the real App in Electron, docked and popped out, both themes]
<!-- /preserved:e-0ea27d15e8d36432 -->

<a id="e-2f169982bef62e30"></a>

## App settings pins and pops out like every other modal (docket

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3442–3457.

<!-- preserved:e-2f169982bef62e30 -->
- App settings pins and pops out like every other modal (docket
  app-settings-pinnable-and-pop-out-able-like-ever, user 2026-10-20 12:26Z "i want app settings to
  be pinnable and popoutable like every other modal", 12:53Z "put it in 19"). It replaces the
  earlier rule that `app-settings` is a global dialog: `PinFrame` keeps only `defaults` and
  `advanced-org` in its always-global list, and App scopes `app-settings` exactly as it scopes
  Usage (`useScopedOpen(slug)`, `usePersistedModalOpen('app-settings', slug, ...)`, restore per
  organization, `toggleSurface` so a pinned or popped-out panel is revealed and never toggled
  shut). In an organization it pins, pops out and persists per organization; at HOME (no
  organization to pin into) it stays a centred modal with no pin or pop-out button, as Usage does
  there, so one organization's pin never follows the user home or into another. The
  `orgtree:open-app-settings` ask (the turn-slot banner's "Open settings", detail `{ tab, focus }`)
  goes through `toggleOrRaiseModal(..., ensureOpen)` and hands `AccountsPanel` a `SettingsTarget`:
  the Runtime turn-limit row is `field="max_concurrent_turns"`. Tests: `appsettingspin` (the real
  App: pin, per-org, reload, the ask on a pinned panel, a panel in another document), plus the
  `pinspace`, `appsettingsclose` §7 and `closemenu` expectations flipped from "never pinnable".
  [decided: user 2026-10-20; verified: the real App in Electron, pinned and popped out, both themes]
<!-- /preserved:e-2f169982bef62e30 -->

<a id="e-82a3415cba4cfd8c"></a>

## Attached ask cards are grouped by request ID and ticket, never tab text.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3563–3568.

<!-- preserved:e-82a3415cba4cfd8c -->
- Attached ask cards are grouped by request ID and ticket, never tab text.
  `asks::attached_tabs` preserves tab indices and filters exact ticket links;
  the docket reader repairs duplicate attachment lists from earlier builds.
  The full batch remains the answering form. Optimistic question counts use
  actual header request IDs, not revision keys. [verified from source and
  synthetic smoke: 2026-10-07; `docs/rust-engine/attached-ask-cards.md`]
<!-- /preserved:e-82a3415cba4cfd8c -->

<a id="e-155442c22ed0880c"></a>

## Verbose UI-open timings use opentiming.ts and /api/diagnostics/ui-open.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3575–3581.

<!-- preserved:e-155442c22ed0880c -->
- Verbose UI-open timings use `opentiming.ts` and `/api/diagnostics/ui-open`.
  `frame_ms` means the first animation frame after ready content commits, not
  GPU presentation. Filter hidden/unfocused samples; off creates no timing
  work or diagnostic requests. Diagnostic POSTs bypass `req` mutation hooks;
  read the run's rotated `.log.*.gz` segments as well as its active log.
  [verified from source and packaged logs: 2026-10-07;
  `docs/rust-engine/docket-read-performance.md`]
<!-- /preserved:e-155442c22ed0880c -->

<a id="e-44927a3e634880bd"></a>

## Docket UI lists use 100-row server pages with full counts and bounded named

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3609–3613.

<!-- preserved:e-44927a3e634880bd -->
- Docket UI lists use 100-row server pages with full counts and bounded named
  references; never fetch the whole archive to resolve links. Per-item docket
  `view` is exempt from logging by the user's 2026-10-07 ruling.
  [verified from source / recorded decision: 2026-10-07;
  `docs/rust-engine/docket-read-performance.md`]
<!-- /preserved:e-44927a3e634880bd -->

<a id="e-0d6ee75e14f389d6"></a>

## The Work docket and every agent/team docket tab share one DocketControlBar

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3615–3625.

<!-- preserved:e-0d6ee75e14f389d6 -->
- The Work docket and every agent/team docket tab share one `DocketControlBar`
  (`canvas/docket.tsx`): one wrapping row of 24px ghost controls (heading, search,
  Arrange, Sort, Show archived, Show backlogged); only the org docket folds the
  options behind its sliders button below a 760px container. The sort caption
  (`.docket-sort-why`) is the Sort select's tooltip and accessible description,
  visually hidden. Tests and probes pin the class names, ids (`#docket-group`,
  `#docket-sort`, `#docket-view-options`) and labels; keep them. [user 2026-10-13:
  "keep it minimal and small but streamlined and clean"; verified from source]
  Every docket view also shares one list/ticket split: the base `.mailer-list`
  width (36%, 140-340px); the desk and team tabs have no override. [user
  2026-10-13; coordinator ruling on team tab; verified from source]
<!-- /preserved:e-0d6ee75e14f389d6 -->

<a id="e-9faaa6dbd5055d95"></a>

## Request parity: questions allow 4 per call and 8 accumulated; overflow refuses without

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3743–3752.

<!-- preserved:e-9faaa6dbd5055d95 -->
- Request parity: questions allow 4 per call and 8 accumulated; overflow refuses without
  dropping pending tabs. Credits use `ceil(round(total, 2))`; an already-held total removes
  only the credit tab, and zero chain/cap headroom refuses. Scope items merge by identity
  (8 maximum), omit capabilities already held after ancestor clamps, and require a reason.
  Question docket links pass the existing agent read gate before card creation or routing.
  Batch submits require every live component's revision and every explicit decision;
  grants, resolution and answer mail commit together, with notifications after commit.
  [verified from source: 2026-10-07, `domain/asks.rs`, `domain/scope.rs`; Python baseline
  `4ddbfb1:engine/backend/orgtree/ledger.py`; parity P18–P20/P29/P31–P32;
  details: `docs/rust-engine/request-parity.md`]
<!-- /preserved:e-9faaa6dbd5055d95 -->

<a id="e-10cf45fc2552cf56"></a>

## Composer Enter behavior is app-wide: App settings › Display › Typing › Enter key defaults to

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3756–3761.

<!-- preserved:e-10cf45fc2552cf56 -->
- Composer Enter behavior is app-wide: App settings › Display › Typing › Enter key defaults to
  Send message; Insert new line uses Ctrl+Enter to send. Questions' free-text fields are
  multiline; single-line inputs and document editors keep their own shortcuts. The app
  feed updates open windows. No one-setting General tab.
  [decided: user 2026-10-07, DECISIONS 48; verified: `http/settings.rs`, `appfeed.rs`,
  renderer `canvas/accounts.tsx`, `enterkey.ts`, `composerkeys.ts`]
<!-- /preserved:e-10cf45fc2552cf56 -->

<a id="e-35f25c5413b34ad5"></a>

## Docket policy parity (2026-10-07). Keep the retained 3.x link/read rights,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3892–3897.

<!-- preserved:e-35f25c5413b34ad5 -->
**Docket policy parity (2026-10-07).** Keep the retained 3.x link/read rights,
revision-checked progress patches, closed-only archive, deletion pointer cleanup,
upward handoff and attention wording/history. Automatic participant notices use
the actor's mail rights, report refusals and never grant reply audiences. The
signed F2–F5 removals remain. [verified from source: `domain/docket.rs`, `domain/mail.rs`;
details and Python references: `docs/rust-engine/docket-parity-batch5.md`]
<!-- /preserved:e-35f25c5413b34ad5 -->

<a id="e-f7ded7d01c3c769b"></a>

## Inbox mail styling (2026-10-07). Rust mail carries passive delivery as

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3912–3928.

<!-- preserved:e-f7ded7d01c3c769b -->
**Inbox mail styling (2026-10-07).** Rust mail carries passive delivery as
`notice: true`, independently of `kind`; legacy mail uses `kind: notice`.
Mailbox rows must recognize both for the dashed edge and system-notice folding.
Plain message/notice rows have no type badge; typed question/request/decision/status
markings remain. Only consecutive delivered system notices fold (same typed variant
and object kind); pending rows and system decisions remain separate. This is a
mail-list grouping rule. Passive delivery's dashed edge also belongs on transcript,
pending, standalone and read-pane cards, independent of typed family; only the
owning card has the edge (not its pending wrapper). Shared `isNoticeRow` gives an
explicit notice flag precedence over legacy kind. Transcript writes retain the
flag; old missing flags are recovered read-only from recipient-scoped original
mail in bounded batches, without rewriting history. [user follow-up 2026-10-07
11:22Z; verified from source: `runtime/actor.rs::mail_row`, `runtime/convo.rs`,
renderer `events/card.tsx`, `events/segments.tsx`, `events/decode.ts`;
verified from source:
`feed/compute.rs::mail_entry`, renderer `canvas/shared.ts` and `canvas/mail.tsx`;
recorded decision: user inbox styling request 2026-10-07]
<!-- /preserved:e-f7ded7d01c3c769b -->

<a id="e-70ddc1ec4c782ba2"></a>

## Open request cards (2026-10-07): emit kind: batch with typed tabs, even for

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3968–3973.

<!-- preserved:e-70ddc1ec4c782ba2 -->
- **Open request cards (2026-10-07):** emit `kind: batch` with typed `tabs`, even for
  question-only or single-tab requests, as 3.x did. That selects the existing renderer's
  next-unanswered-tab navigation; multi-select and typing do not advance. Recompose
  already-open Rust rows on read; keep stored kinds for resolved-card history.
  [verified: `src/domain/asks.rs::compose`, `src/domain/tree.rs::ask_card`, renderer
  `canvas/asks.tsx::BatchAsk`]
<!-- /preserved:e-70ddc1ec4c782ba2 -->

<a id="e-73f802e8ab8d258b"></a>

## Never hand a jsdom element to an assertion (assert.equal(el.querySelector(s), null)).

Original section: Desktop and renderer. Source lines 4717–4723.

<!-- preserved:e-73f802e8ab8d258b -->
- **Never hand a jsdom element to an assertion** (`assert.equal(el.querySelector(s), null)`).
  When it fails, node's reporter serialises the element with its whole document and dies
  out of memory (`Array buffer allocation failed`, `Worklist::Segment::Create`) before
  any result, so a red control reports nothing. Reduce it first: `=== null`, `!!`, a
  `textContent` or an attribute. 2026-10-14 [verified: renderer
  `tests/attentionaudit.test.tsx` §5; measured again in batch round 439 on
  `toolclock-turn.test.tsx`]
<!-- /preserved:e-73f802e8ab8d258b -->

<a id="e-b1b3e7a9c44f9298"></a>

## Still binding for 4.0.0 except where PLAN.md §10 or DECISIONS.md changes them (e.g. no lineage nodes, lean docket withou

Original section: Product rulings. Source lines 4727–4727.

<!-- preserved:e-b1b3e7a9c44f9298 -->
> Still binding for 4.0.0 except where [PLAN.md §10](../../docs/rust-engine/PLAN.md) or [DECISIONS.md](../../docs/rust-engine/DECISIONS.md) changes them (e.g. no lineage nodes, lean docket without review machinery, `orgtree_send_notice` → `orgtree_message notice:true`). (2026-10-06)
<!-- /preserved:e-b1b3e7a9c44f9298 -->

<a id="e-e3f18d7647d64c36"></a>

## Notifications default to needs-attention only (questions, urgent mail, ticket attention).

Original section: Desktop UI. Source lines 4874–4877.

<!-- preserved:e-e3f18d7647d64c36 -->
- Notifications default to needs-attention only (questions, urgent mail, ticket attention).
  Ordinary clicks on local file links reveal the file in Explorer and never open or run it;
  the tool-row context menu separately offers an explicit `Open` choice (user 2026-10-19).
  [decided: user 2026-09-07, 2026-09-13; updated 2026-10-19]
<!-- /preserved:e-e3f18d7647d64c36 -->

<a id="e-2e51d308b9ab4825"></a>

## Written against the 3.x engine's tools. Under 4.0.0 the tool set and docket changed (PLAN.md §6, §10 F and P): no reserv

Original section: Gotchas in Orgtree's own agent tools. Source lines 5034–5034.

<!-- preserved:e-2e51d308b9ab4825 -->
> Written against the 3.x engine's tools. Under 4.0.0 the tool set and docket changed ([PLAN.md §6, §10 F and P](../../docs/rust-engine/PLAN.md)): no reservations, review seats, `approve_stage`, acceptance checks or relaunch tools. (2026-10-06)
<!-- /preserved:e-2e51d308b9ab4825 -->

<a id="e-9534fe084290c8b2"></a>

## Markdown image local paths accept only absolute drive-letter syntax and reject

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5213–5218.

<!-- preserved:e-9534fe084290c8b2 -->
- Markdown image local paths accept only absolute drive-letter syntax and reject
  reparse-point components before opening; the opened handle must resolve to a
  regular file on a drive-letter path before reading. A local disk writer can
  still race component checks; this is a documented threat-model limit. See
  [Markdown image embeds](../../docs/rust-engine/markdown-image-embeds.md).
  [verified: `engine/rs/orgtree-engine/src/http/markdown_image.rs`, 2026-10-17]
<!-- /preserved:e-9534fe084290c8b2 -->
