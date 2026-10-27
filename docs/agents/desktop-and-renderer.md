# Desktop and renderer

## Inline object-mention wrapping (2026-10-27)

USER mc116439e87c9 makes Display > Text > Wrap object mentions opt-in (off by
default), superseding the earlier on-by-default interpretation. The persisted
runtime boolean `wrap_object_mentions` is read/configured through the ordinary
runtime endpoint and user `orgtree_settings` tool and pushed through app-feed.
Canonical ticket/document/app/panel links and legacy docket title links share
the opt-in behavior, including sanitized Markdown. Root-class mirroring keeps
browser popouts synchronized. Theme preferences and message text are unchanged.

Chromium buttons remain atomic even with display:inline. When enabled, shared
object controls therefore use inline spans with role=button, tabIndex and
Enter/Space activation, retaining object navigation/tooltip/copy attributes.
Off uses the original buttons. CSS uses normal word/dash breaking and
overflow-wrap:anywhere as a fallback; cloned decorations keep flares and hover
underlines on each fragment. Markdown's cheap-exit identity includes wrapping
mode, so unchanged reads preserve selection and a toggle rebuilds the controls.
[verified: `canvas/{mentionwrap,reflinks,refmd,workrefs}.tsx`, `styles.css`]

## Sandboxed agent HTML has no network, WebRTC included (2026-10-27, 4.5.0)

Four surfaces run agent script with CSP `connect-src 'none'`: app panel frames,
chat HTML replies, the inline HTML presentation frame in the reader pane, and
the HTML presentation viewer window. CSP does not govern WebRTC and WebRTC asks
no permission. Measured 2026-10-26/27 in Session 0 (Electron 44.2.0, Chrome
152, production CSPs and session rules, loopback listeners only): each surface
reached a host:port of its own choosing over STUN and ICE on UDP and over TURN
and ICE on TCP, carrying script-chosen bytes. Chromium 152 reports a CSP
`webrtc` directive as unrecognized, Electron has no switch that disables WebRTC,
and disabling Blink features by name changed nothing (measured).

Main closes it in two layers (`main/windows.ts`), and each alone left one
transport open (measured):
- `sealWebRtc`: every webContents gets the `disable_non_proxied_udp` IP
  handling policy from the app-wide `web-contents-created` hook. No UDP leaves.
- `sealSessionNetwork`: the window session (`persist:orgtree-v2`, which renders
  app panels, chat HTML replies and the inline presentation frame) and each
  presentation viewer window's own session get
  `fixed_servers` proxy `127.0.0.1:1`, a proxy that does not exist, with bypass
  `<-loopback>;127.0.0.1`. WebRTC's TCP must go through the session proxy, so
  it never connects and never falls back to direct. Only 127.0.0.1, where the
  desktop's engine always listens, stays direct, on any port, because an
  engine recovered in the same process may come back on another port. The seal
  is awaited before the session loads anything; a viewer whose seal fails is
  destroyed unshown.

Orgtree's renderer reaches nothing but its engine, so the UI is unaffected.
What remains: TCP to other ports of 127.0.0.1 itself, never off the machine.
Any new session or window that renders agent HTML must be sealed before it
loads; never remove either layer. The inline presentation frame needs no code
of its own: it is a sandboxed `srcdoc` iframe in the window session, so both
layers already reach it (the UDP policy covers a webContents' subframes, the
session proxy covers every frame in the session). Measured with both layers
(probe proxy bypass limited to the page server): 0 STUN, 0 ICE UDP, 0 TURN TCP
and 0 ICE TCP packets on all four surfaces; the base had all four.
App internet access (net.fetch, 4.5.0) keeps all of this: the panel frame stays
offline and `orgtree.net.fetch` asks the engine, which makes the request
([custom apps](../rust-engine/custom-apps.md#internet-access-2026-10-27)).
[decided: coordinator 2026-10-26 assignment, user 2026-10-26 "No, 4.5.0 only"
(m65b128578ffb); verified: `main/{windows,index}.ts`; control:
`tests/sandboxed-html-network.test.mjs`]

## Normal-card hover names (2026-10-26, 4.4.5)

Hovering the whole normal agent/project card, including its body and effort
chip, reveals a genuinely clipped name on its existing static background plate.
Normal reveal ignores open desks: the user keeps normal names available while a
desk is open here or popped out into another window, superseding the normal
part of the 4.4.0 suppression rule. Since 2026-10-27 mini names ignore open
desks too: hovering or focusing a mini node shows the floating plate above every
card (user 2026-10-26 never hide on hover; 2026-10-27 names above nodes). That
replaces the rest of the rule (0a47651), and its desk counter
(cardnamereveal.tsx) is gone. A desk's own header remains unchanged. No card
layout, motion, hit target or fit measurement changes.
[decided: user 2026-10-26, 2026-10-27; verified: canvas/{cardname,farzoomname,cards}.tsx;
controls: namehover.test.tsx, desknameplate.test.tsx, mininameguard.test.tsx, cardhoverfit.test.tsx]

## Text editing and spelling menus (2026-10-24, 4.4.5)

Native `editmenu.ts` uses Chromium's edit flags, pointed misspelling and
suggestions. Commands and dictionary additions target the originating
webContents/session; never use a globally focused window or recompute clipboard
availability in the renderer. Undo/Redo/Delete extend the existing edit menu;
Paste as plain text is offered for rich editing only. Read-only selections have
Copy/Select All, including the custom exact-passage menu which keeps Reply to
selection. Custom Copy captures text before menu focus, and document-wide Select
All waits until the menu has unmounted. Default spelling language is unchanged.
The displayed shortcuts are editor conventions, not new global bindings.
See [native menu tests](../../tests/edit-menu.test.mjs), renderer
`texteditmenu.test.tsx`, and the [user guide](../messages-and-work.md#text-editing-menus).

## Draft permission edits (2026-10-24)

Agent/project draft settings omit footer Close buttons and opt into PinFrame's
visible header X (`closeInModal`), retaining Escape and outside-dismiss paths. The
unpinned non-pinnable bar otherwise has no children and measures zero: dispatching
a contextmenu event to it is not a pointer interaction. Capture checks require
nonzero on-screen X geometry, hit-testing and a trusted CDP pointer click. Project drafts
use a dedicated panel class with natural height and an 88vh scrolling cap, without
changing live-project or agent settings dimensions. Existing close-interaction
fixtures drive the header X. [decided: user2026-10-24; verified:
`canvas/{modalpin,modals,newproject}.tsx`, `styles.css`]

`DraftScopeModal` publishes its local proposal to the owning `DraftNode` after
each change, without closing the panel or creating an agent. Closing retains
the proposal; final Hire alone submits it. Keep callback identity out of the
publish effect to avoid an update loop. Draft rows and section groups keep
their natural height in the fixed-height scrolling panel. Existing live-agent
settings retain their explicit Save path. The draft shares Charter/Model/Scope/Tools tabs,
charter, fallback, compaction, native-tool and credit-editor presentation with live settings.
`CreditGrantControl` passes the absolute target and its displayed/accepted baseline
to the commit callback. Live `CreditGrant` subtracts that baseline, never stale
`node.grant`, so a second edit before tree refresh cannot overallocate. Draft
callbacks retain the first argument's absolute semantics; never mount `NodeConfig`
against a fake node.
DraftNode owns identity, compiled instructions, grant and tab; the scope snapshot owns other preferences.
Model changes remount the snapshot after clearing version/speed and sanitizing account/effort.
`confirmDraft` forwards every independent preference in both direct and undo hires, omitting
all four inherited permission fields for superior insertion. History/session telemetry,
queued switches, scratch and lifecycle actions require a persisted agent.
[decided: user m2dbdd9edf6d6; verified: `canvas/{modals,cards}.tsx`, `styles.css`]

## Windows Shift+Alt+Space and navigation tooltip bindings (2026-10-24)

On Windows, Shift+Alt+Space now cancels only its native system-menu request,
then uses the ordinary renderer navigation guards. Plain Alt+Space and titlebar
right-click keep the Windows menu. Each native Orgtree window, including a
pop-out, keeps separate modifier state and clears it on blur; org actions keep
their existing main-canvas scope. No global shortcut or OS setting is changed.
Navigation command tooltips show the shared binding in parentheses on the
same line, without an action caption; arrow directions use ← ↑ → ↓. Agent and
project links, including neighbour and superior/subordinate jump cards, keep
their ordinary identity tooltips without shortcut hints. Switchboard commands
and the generic Focus last desk command retain their hints.

The main process observes WM_SYSCHAR Space with its Alt context, then cancels
Electron system-context-menu only while that window holds Shift+Alt without
Ctrl/Meta. Non-client/right-click messages cannot reuse the keyboard marker.
Only an initial Space not already delivered to Chromium is forwarded; held-key
repeats do not replay Fit. Main creation installs it on every BrowserWindow.
Agent/project identity hover remains canonical without a shortcut suffix.
USER me6e893c5863c (2026-10-24) supersedes the all-controls hint rule
(m8f522c3882a2), retaining compact hints only on commands that are not
agent/project links; m76d83710011c defines the same-line parentheses format.
[verified: `main/shift-alt-space.ts`, `shell/orgnavigationbindings.ts`,
`canvas/{agentnav,desk,OrgCanvas}.tsx`; user report meeb3ea29d6f8]

## Selection-menu viewport anchor (2026-10-24, 4.4.5)

`useContextMenu` measures the pressed descendant when its anchor has
`display:contents`. The original anchor still owns source/composer custody,
canonical link lookups and dismissal. A contents boundary has a zero rect:
using it for position puts the menu at the viewport's top-left edge. Keep client
coordinates and the portal in the anchor's owner document; keyboard fallback
and viewport clamping use the measured box. `selectionmenu.test.tsx` stubs
nonzero text boxes across canvas/floating/pinned geometry and another document,
and the capture uses a real pinned `DeskChat`. The same rule fixes whole-event
Reply/Copy menus on transparent live/thought rows (`liveeventmenu.test.tsx`);
ordinary boxed rows keep their existing anchor. This restores intended
placement without changing selection-reply actions or the agent tool contract.

## Manual-hire desk focus (2026-10-24)

The default-on app preference `orgtree-hire-auto-focus` gates automatic
completion focus only. Draft success, placement seeds, first-use progression,
undo and model/superior memory remain unconditional. Read it when arming and
consuming the queued draft reveal and when Quick chat completes; the shell
also cancels pending Quick chat focus when disabled before tree arrival.
Do not gate explicit navigation or draft editing. Project creation, compact
HireSheet and immediate Staff currently request no automatic focus. This is a
renderer view preference with no engine/tool field or per-frame layout work.
[decided: user m64582ef89f52, coordinator m07cd1a99908f; verified:
`hirefocus.ts`, `canvas/OrgCanvas.tsx`, `QuickChatBox.tsx`, `App.tsx`]

## Superior insertion retains the anchor slot (2026-10-25)

Canvas above hires omit ordinary user_position. Admission must retain the
anchor's sibling ordinal when no explicit position was requested. Imported
ties retain the full ordinal/numeric-id rank through canonical placement and
same-transaction normalization when needed. This matches
withDraftTree's wrapper and OrgCanvas's retained birth position. Appending a
mid-row superior instead overlays its following sibling until a tree change;
Centre makes this case common. Keep agent-tool explicit index and self-parent
contracts. The focused engine proof supplies actual before/after trees to the
Session 0 renderer capture, which checks nonzero boxes throughout completion.
[verified: domain/ops.rs, canvas/{shared,OrgCanvas}.tsx;
tools/rig/proofs/superior-centre-ordering.mjs; 2026-10-25]

## New-hire position (2026-10-23)

USER m0d1975636f40: **New hires go** is an app Display preference, not an org
default or a new agent tool. Renderer localStorage `orgtree-new-hire-position`
stores end/start/centre, with Centre for missing/invalid values and storage-event
updates across profile windows. USER 2026-10-24 mbb3df1e28668 replaces the End
default with Centre; valid saved End/Start/Centre choices are kept. Ordinary drafts/tokens/shared menus, compact
HireSheet, Quick chat, project drafts and immediate Staff submit the choice at
creation time. Request Staff delegates unchanged. Agent hire/staff `index`
supplies parity; no tool schema/prompt change is required.

Memoized preview and admission use ceil(n/2) for Centre over live physical
children, including projects. Preview work stays off animation-frame dependencies.
Rows/rings consume the same ordered sibling list. Explicit side/above placement,
moves, existing nodes and templates keep their order. The UI `user_position`
field resolves against the engine's locked live sibling set in the existing
serializable transaction. End/omission keeps historical append behavior;
explicit indices/anchors take precedence. Quick Staff includes placement in its
retry identity and forwards it only on immediate creation.
[verified: `src/hireposition.ts`, `canvas/OrgCanvas.tsx`, `canvas/newproject.tsx`,
`canvas/quickstaff.ts`, `domain/ops/ordering.rs`, `domain/staffing.rs`]

## Fractional canvas overlay bounds (2026-10-23)

The always-mounted Attention `.org-slot` is an absolute sibling of the canvas
viewport. Measure its fractional border box in the shared containing block,
including that block's border and scroll offset. Integer `offsetWidth` and
`offsetHeight` can round beyond the window edge at fractional display scaling,
making root scrollbars alternate the canvas width and retrigger camera refocus.
Keep the existing change guards and viewport observer; do not hide legitimate
transcript or panel scrollbars to mask this loop. The isolated native fixture
is `tests/scrollbar.capture.cjs` with `scrollbar.visual.tsx`.
[decided: user 2026-10-23; verified: `canvas/OrgCanvas.tsx`]

## Move hover preview anchor (2026-10-23)

The move ghost uses the projected moved-node offset from its new superior,
anchored to the superior's current rendered spring position. Memoize the
projection independently of animation frames; apply the current anchor on
each render. The actual drop still uses the final projected layout, including
any superior movement. Preserve row/circular, user-root, pending-order,
hidden-retiree and project-bunch projections and invalid-hover clearing.
This is a display correction; move/reorder tool authority is unchanged.
[decided: user 2026-10-23; verified: `canvas/{moveghost,OrgCanvas}.tsx`,
`tests/{pendingmove,hiddenretiredbunch}.test.tsx`]

## Effort bar release (2026-10-23)

Clear the pre-drag hover preview when committing a pointer release. Otherwise
the label falls back to that old preview after the drag ends, even after the
saved effort and pip update. Clearing it also restores the caller's inherited
label when pressing the pinned level clears the override. Keep hover previews,
dragging, keyboard behavior and the existing single commit unchanged.
[verified: `canvas/effortbar.tsx`, `tests/effortbar.test.tsx`]

## Effort bar glide (2026-10-27, 4.5.0)

The pip and the fill glide (`transition: left/width .15s ease-in-out`) to every
level a press lands on or a drag crosses, in every place the bar appears (desk
pop-out, agent settings, hire sheet, org defaults, Quick chat). The old
`.effort-bar.dragging` rule set `transition: none` once a press had travelled,
so only a plain click glided (USER 2026-10-27, "it should animate between every
position, not just on the first click"). A new level restarts the CSS transition
from where the pip is, so a quick drag retargets and never queues; keyboard steps
glide the same way, and `prefers-reduced-motion` still turns the transition off.
`tests/effortbar.test.tsx` reads the real `styles.css` cascade through jsdom while
a press drags across five levels; `tools/rig/proofs/effort-selects.mjs` samples
the pip every frame on each leg of a real drag (needs the engine and a UI bundle).
[verified: `canvas/effortbar.tsx`, `styles.css`, `tests/effortbar.test.tsx`, `tools/rig/desktop/effort-selects.cjs`]

## Mention copy gestures (2026-10-27, 4.5.0)

Three user requests, one rule: a mention is one gesture away.

- **Docket rows** (`DocketRow`: org Docket view, desk Docket tabs, attention
  list): double-click copies `@item:<org>/<slug>`. It copied the bare slug from
  2026-09-07; the menu's Copy slug keeps the slug. With no `org` prop the row
  still copies the slug (no token with a guessed org).
- **Presented rows** (`GalleryEntry`: the org-wide list and the desk tab):
  double-click copies `@doc:<org>/<id>`. The single click is unchanged.
- **Apps and panels**: `appLinkMenu` and `panelLinkMenu` (`canvas/apps/links.ts`,
  shared by the Apps list rows and the `@app:`/`@panel:` chips) gain **Copy
  mention** (`@app:<org>/<slug>`, `@panel:<org>/<slug>`) above Settings, built
  by `mentionCopyEntry` beside `agentCopyEntry`, toast "copied mention". The
  panel window's header has no context menu and gets none.

The two row gestures share `canvas/rowcopy.tsx` (`useRowCopy`): the guard for
embedded controls, the selection clear, the clipboard write on the row's own
window and the `Copied!` bubble, moved out of `DocketRow` unchanged. The row needs
`position: relative` (`.docket-row`, `.doc-gallery-row`). Tests:
`tests/mentioncopy.test.tsx`, `tests/contextmenu.test.tsx` §B4b,
`tests/appmentions.test.tsx`; clipboard stubbed.
[verified: `canvas/rowcopy.tsx`, `canvas/docket.tsx`, `canvas/gallery.tsx`, `canvas/apps/links.ts`]

## Queue-group disclosure defaults (2026-10-23)

Every nonempty `PendingRun` exposes its native summary. The 2026-10-24 user
refinement places its arrow and count in the separator line and removes the
separate duplicated Show/Hide row; the accessible action label remains. The
one undelivered group includes system cards and optimistic/failed sends. Current-turn
mail stays normally visible above the live reply; neither is inside the disclosure.
Idle chats put all undelivered mail in this one group. Actor `chat.busy` takes
precedence over stale tree/row flags; native stage wins over legacy via. A nullable
local choice distinguishes the untouched six-row automatic default from an
explicit open/closed choice. Count-driven native toggle events must not become
manual choices: compare the observed open state with the controlled value.
Explicit summary activation and reply-target reveals preserve their choice
while the run is mounted. Existing run/desk/generation teardown resets it;
never transfer a queue-group choice to delivered transcript rows. Keep card
mounts, event deduplication, current/later positions, five-line body previews,
and delivered system-notice bundles unchanged. This is local
display state, not a new agent tool operation. [decided: user 2026-10-23
m4f228e48f792; verified: `canvas/{pendingrun,transcriptflow}.tsx`,
`tests/{pendingrun,pendingtoggle}.test.tsx`]

## User-message jump previews (2026-10-23)

`authoredUserLabel` requires a canonical user actor plus a communication variant
(`ordinary.*`, `reply.*`, `answer.ask`, or `lifecycle.kickoff`). User-initiated
operations also carry actor=user and engine_authored=false, so neither actor nor
that flag alone establishes a written message. Retain only the last eligible
summary in each delivered batch; do not join its event titles. Automatic-only
batches return null and cannot replace an older real-message target. Keep the
existing batch anchor, geometry, disclosure reveal and transcript cards intact.
This changes a display/navigation label, with no new agent action or delivery
authority. [verified: `events/segments.tsx`, `canvas/desk.tsx`,
`tests/youpreview.test.tsx`; 2026-10-23]

## Organization keyboard navigation (2026-10-23)

Consecutive move recovery (2026-10-24, 4.4.5): a real-renderer 588019a control
opens one desk then blocks moves 2-6 because its composer autofocuses. Preserve
that autofocus/direct typing, but mark its provenance per document only during
an accepted org-navigation sequence. Exact org chords may leave only that
marked active composer; local tab shortcuts and other editors keep their guard.
Pointerdown, non-navigation keys (including Tab), input/composition, window blur
and main-listener teardown release the exception. Ordinary focus never grants it.
[verified: `composerfocus.ts`, `shell/{appshortcuts,navigationkeys}.ts`,
`canvas/{desk,projectdesk}.tsx`, `tests/navigationsequence.test.tsx`]

Gesture recovery (2026-10-24, 4.4.5): `installNavigationKeys` reconciles a
tracked pointer on captured pointermove/pointerover with buttons=0. A missed
document pointerup without blur otherwise leaves navigation blocked indefinitely.
Remove only the observed pointer; retain other live touches and held-button
drags. Blur/cancel/up and listener teardown retain their existing cleanup.
Measured at the browser-event contract; no claim that this is every reported
intermittent stop. [verified: `shell/navigationkeys.ts`, `tests/navigationrecovery.test.tsx`]

4.4.5 refinement (USER 2026-10-24, coordinator-approved focus definition):
Shift+Alt arrows fall back only from an empty origin to the last live, visible
agent/project desk per org. Explicit focus/jump intent, settled camera focus
(including manual pan/zoom), and pinned/Attention interaction record visits;
selection, hover and intermediate camera glides do not. Fit preserves the visit;
switchboard remains its own origin. Keep this memory separate from agent history
and Shift+F7. Validate remembered node liveness and layout visibility on every use.
[verified: `canvas/OrgCanvas.tsx`, `canvas/keyboardnavigation.ts`, `tests/lastdesknavigation.test.tsx`]

`shell/appshortcuts.ts` owns the main-window Shift+Alt navigation table;
`canvas/keyboardnavigation.ts` uses visible physical placement, including project
stops, and bounded per-org session agent history. Route every jump through
`centerOn`, preserving pin/popout/Attention custody. DeskTabs cycles its actual
displayed tab array in the surface's owning document. Bubble after local handlers,
defer to editors/widgets/composition/overlays/gestures, and require exact modifiers
on older Alt-arrow handlers so navigation cannot alter a credit offer. See the
[keyboard glossary](../skills/orgtree-app/app-settings/app-keyboard-shortcuts/SKILL.md).
[decided: user 2026-10-23 m0d10d980821a; verified: renderer sources named above]

## Desk lifecycle hover help (2026-10-23)

Agent retire/dissolve and project dissolve use native button titles, like Halt
and DND. Explain the affected agent/team/project and preserved history/files;
do not promise that restoring a root also rehires every former member. DND's
title explains holding non-urgent mail while urgent mail passes, with its
existing current/next-turn and release-boundary behavior. These are explanatory
changes only; confirmations, lifecycle operations and DND authority stay in
their existing handlers. [verified: `canvas/desk.tsx`, `canvas/projectdesk.tsx`,
`canvas/dnd.tsx`; user 2026-10-23]

## Template availability while typing (2026-10-23)

The Create form rechecks template availability when the name changes because
accounts can be scoped to an organization. Keep the last confirmed row styling
while that request is pending: clearing the unavailable/collapsed presentation
made each keystroke expand and then collapse those rows. A returned availability
result (including genuine sign-in checking) and Reload still update the list;
stale responses cannot overwrite the current name's result. Selection and preview
overrides persist. [verified: `shell/templatepicker.tsx`,
`tests/template-name-refresh.test.tsx`; user 2026-10-23]

## First-use annotation placement (2026-10-23)

The first hire-token note stays left of the entire token strip and user node;
the name note stays right of the entire draft card. Measure the rendered note's
height and the complete target group after transforms, rather than estimating
clearance from one button or input. Narrow views fall back below/above the group,
or yield if neither fits. Side notes shift vertically clear of visible canvas
controls, including the zoom toolbar. Both notes stay within the canvas; the connector leaves
the corresponding note edge. Progress and hire-completion logic are unchanged.
[verified: `canvas/firstuse.tsx`, `canvas/firstuseplacement.ts`; user 2026-10-23]

## Welcome setup layout (2026-10-23)

The homepage's first-run Welcome card uses the shared `shell-page-inner`
management container, centered horizontally below the header. Its width is
bounded by that container on narrow windows; vertical scrolling keeps all
setup actions reachable on short windows. The canvas first-use
guide is a separate surface. [decided: user 2026-10-23; verified:
`shell/homepage.tsx`, `shell.css`]

## First-use guide hire completion (2026-10-22)

The pending-hire layout effect advances the first-use guide before removing a
draft replaced by its recognized hired node. This covers a change feed that
arrives ahead of the hire response; clearing the draft first let the no-draft
recovery effect treat success as Cancel and reset the guide to its first step.
The response still advances normally when it arrives first. Repeating completion
is harmless, including after the first message finishes the guide. Pending hires
carry their originating org, so replacement cannot advance another org's guide.
Genuine cancellation, refused/editable drafts, unrelated feed nodes and the
existing lost-form recovery retain their previous rules. No guide copy, layout
or new action changes; agent parity remains the existing hire/message actions.
[verified: `canvas/OrgCanvas.tsx`, `tests/{firstuse-hire,firstuse,pendinghire}.test.tsx`;
decided: coordinator 2026-10-22, 4.4.2 defect assignment]

## Mention navigation

Shift+F4 visits the current org's retained mention destinations, including seen entries, through bounded cursor reads. History begins at 4.4.2 with a bounded pending seed; the feed retains 2,000 entries per org. Preserve exact transcript identities and the shared Settings/matcher table. See [mention navigation](../rust-engine/mention-navigation.md). [decided: user 2026-10-22, m5c9a92bca6d8; coordinator defaults mec06fbc099af]

## Deep compatibility tree reads (2026-10-22)

The initial/full HTTP tree response writes project nesting with an explicit
heap stack from flat records. Do not rebuild a recursively nested JSON Value:
its construction, serialization and destruction can each exhaust the engine
thread's stack. Keep field escaping in serde_json, sibling order, parent names,
runtime overlays, retired counts and revision/foreground metadata unchanged.
The former depth-1024 truncation is removed from this transport; project bunch
grouping is unrelated. The focused synthetic depth fixture is
`tools/rig/proofs/deep-project-nesting.mjs` (approved depths are explicit in the
fixture). It retains generated context files before rig cleanup and checks
ancestry separately from the compatibility response. An HTTP fix does not
prove all descendant operations or template paths at the same depth.
[verified: `http/{tree,orgs}.rs`; 2026-10-22]

The per-turn org chart uses a separate explicit work stack in
`runtime/envelope.rs`. Preserve preorder, per-level archived summaries, shown
identities, status words and unchanged-header deltas. Archived-subtree checks
also iterate with a visited set; fixing the HTTP projection alone does not
make prompt generation safe at the same depth.
[verified: `runtime/envelope.rs`, `envelope/header_delta_tests.rs`; 2026-10-22]

## Canvas superior insertion target (2026-10-22)

Superior draft permissions identify the insertion target and keep its scope
inherited at admission. The modal offers effort and account separately, and
`confirmDraft` excludes folders, tools and visibility overrides for an `above`
draft, including retained snapshots. Both direct operations and undo gestures
use that request boundary; the engine's inheritance refusal remains intact.
The focused fixture rejects the engine's four forbidden scope fields and
exercises gear Apply, effort and account above root/nested agents in both
transports. Subordinate draft grants retain their existing editing behavior.
[verified: `canvas/{OrgCanvas,modals}.tsx`, `tests/superiorhire-target.test.tsx`;
decided: coordinator 2026-10-22, 4.4.1 release-defect assignment]

Superior drafts retain their anchor in `above` for the engine's operation
endpoint. The undo gesture forwards its steps to that same endpoint; keeping
only the agent-tool fields `hire_type: superior` and `target` loses the anchor.
Both request forms must retain the operation field, including a draft above a
root agent where `parent` is null. The compact hire sheet supplies `above` as
well, with history enabled or disabled, so its superior insertion is atomic;
it must not hire a sibling and chain a separate move afterward.

The top strips use `spawnAbove` and the shared draft confirmation. Existing
shared context menus deliberately offer subordinate hiring only (user
2026-10-18 07:17Z); do not add a superior entry as part of this fix. The compact
sheet branch is retained even though `mobile.tsx` currently disables mobile
mode. The correction uses existing operation/tool contracts and leaves engine
credit/scope/admission checks intact. Agent parity remains `orgtree_hire` with
`hire_type: superior` and the explicit `target`; no new tool is introduced.
[verified: `canvas/OrgCanvas.tsx`,
`tests/superiorhire-target.test.tsx`, `http/undo.rs`, `domain/ops.rs`;
decided: user report 2026-10-22 19:42:05Z, coordinator scope 19:45Z]

## Unresolved tool file paths (2026-10-22)

`ToolChip` uses `ToolFilePath` for every recorded `file_paths` entry, across
tools and harnesses. The projection's `link` flag means a native target has a
base; it does not establish that the file exists. The existing native
`localFileStatus` bridge decides whether a filename-only link is appropriate.
Pending, missing and unavailable status retain the full attempted path with a
dim directory; a relative path without cwd is never passed to native file
actions. Native click delegation blocks these unresolved targets. The shared
file menu always retains path/name copying, even when it cannot offer Open or
Show in folder; prose links receive the same copy fallback.

Status reads are local to each mounted path, refreshed on tool completion and
hover/focus. Replaced/unmounted requests cannot overwrite newer results; no
global status cache or filesystem polling is added. Resolved links preserve
their existing labels, title and actions. This is a display/clipboard fix using
existing native capabilities, so there is no new engine action or agent tool.
[decided: user 2026-10-22 18:39:30Z, staffing defaults 19:35:49Z;
verified: `canvas/{desk.tsx,toolfilepath.tsx,localfile.ts,shared.ts}`, tests
`toolmissingpaths.test.tsx`]

History trimming must reopen older paging whenever it discards rows, including
after reaching the true start. Retain an unchanged window's metadata; recreate
Rust cursors from the oldest retained sequence and refresh opaque legacy tails
in full. This applies to return-to-tail and last-desk close, across harnesses.
[verified: `convo.ts::retainTail`, `historytrim.test.tsx`; 2026-10-22]
See [transcript history](../rust-engine/transcript-history-retries.md#returning-from-history-2026-10-22).

The desk model picker reads the warm staffing answer. `default_ok` describes host/org availability; `native_ok` adds the native login's usage gate, while `accounts` independently contains eligible managed choices. `DeskModelButton` prefers an eligible native login, otherwise selects the first compatible managed account in engine order and names it in the token tooltip/cross-provider confirmation. It sends that same ID through both legacy `switch_model` and history gestures; current-tier queue cancellation never rewrites account or model version. General engine usage policy is unchanged. [verified: `canvas/deskmodel.tsx`, `domain/staffing.rs::options`; 2026-10-22]

State badges are display-only and let card pointer gestures reach the normal focus/select path (USER 2026-10-22 09:58Z). `ServingAccountBadge` is a focusable span with the same account/email native title and aria-label on the desk and zoom card; it stops no events. Next-turn, effort, fast mode, frozen, halted, DND and Session 0 markers already use inert spans on cards. Dedicated settings and halt/unstick actions remain separate. Regression: `statebadgefocus.test.tsx` compares each marker's pointerdown/up/click path with the body, with the gear as an action control.

## Ticket Mention and @-completion (2026-10-22)

The shared ticket menu (`ticketReferenceActions`, so docket rows and every
`ObjectNavHost` ticket link) puts **Mention** first inside a desk composer
scope, inserting `@item:<org>/<slug> ` exactly as agent links insert `@<name> `.
Capture it when the menu opens (`captureTicketMention`): the object host reads
the item afterwards. `captureMention` no longer consumes the right-click caret
snapshot, since a ticket and its Owner submenu each capture one; its one-second
age bound remains. The `@` completion adds current and backlogged tickets
(since 2026-10-27 from the engine's mention read, see
[Mention menu](#mention-menu-every-kind-newest-first-2026-10-27); never the
archive), matched by slug or title, with transcript recency keyed
`item:<org>/<slug>`.
The highlighted entry is held by identity so a late answer cannot move it.
Composer text action: agents already write the reference; no tool added.
[decided: user 2026-10-21 19:12:54Z, 2026-10-22 18:15:39Z, 18:16:44Z, 19:36:06Z;
verified: `canvas/{ticketmenu,objectactions,objectnavhost,docket,agentmentions,ticketmentions}.ts*`,
`tests/ticketmention.test.tsx`]

## Composer warning focus lifetime (2026-10-22)

Focus-only cache notices use the composer-and-warning boundary, rather than
textarea blur, so a pointer press or keyboard focus transfer cannot remove the
settings link before activation. The link follows composer controls in DOM Tab
order while CSS keeps the warning above the box. Leaving the region hides the
mid-turn warning; existing readiness/context gates and settings routing remain.
Compact modal notes, job-ack notes and project inbox no-listener notes have no
focus visibility gate and need no lifetime change.
[verified: `canvas/desk.tsx`, `agentcompact.tsx`, `jobackpane.tsx`,
`inboxwarning.tsx`, `projectdesk.tsx`; decided: user 2026-10-22 09:37Z]

## Session 0 state badge (2026-10-22)

`SessionZeroBadge` in `canvas/nextturn.tsx` renders the normal tree-feed
`session_placement` field on both the agent desk header and zoom-card state row.
Only `session0` shows it, with the engine reason and known placement time; no
preference, process or runtime-overlay inference is permitted. Native title and
keyboard accessible label are identical. The normal tree-to-canvas spread
preserves the field; missing legacy records hide the badge. Agent parity is the
existing `orgtree_session` read, not a new UI action.
[verified: `canvas/nextturn.tsx`, `desk.tsx`, `cards.tsx`, `shared.ts`;
decided: user 2026-10-22 07:35Z, engine contract 2026-10-22 08:29Z]

**State badges** describe agent state on both the desk header and zoom card
(next-turn, effort, fast mode, frozen, halted, DND, Session 0). **Header badges**
are desk-only setup/context markers (MCP, cache, audience, cost and related
metadata). See the [definitions and renderer member inventory](../skills/orgtree-app/desk/agent-desk/SKILL.md#badges).
The containing agent/zoom card and other actual cards retain their names.
[decided: user 2026-10-22 07:36Z and 07:38Z]

## Audience header badge inheritance (2026-10-22)

The shared agent/project desk audience header badge leads its native tooltip
with each inherited project source, before the grant explanation. An additional
explicit grant is identified below. Inherited badges are keyboard-focusable with
the identical accessible label, following the serving-account native-tooltip
pattern; explicit-only badges and revoke eligibility are unchanged. This is
presentation of existing audience fields, with no new action or engine contract.
[verified: `canvas/desk.tsx`; decided: user 2026-10-22 07:39Z,
coordinator 2026-10-22 07:42Z accessibility clarification]

## Full mail copy failures (2026-10-21)

`resolveFullMailCopyText` rejects unavailable/incomplete bodies and missing
chunks; unknown-length chunks must terminate within the existing 128-read
bound. Every mail-copy caller (desk, mailbox, both reply previews, shared mail
identity host) reports the same full-message failure without writing to the
clipboard or reporting success. Complete local bodies remain synchronous at
the caller; full fetched bodies and assembled chunks preserve whitespace.
This replaces fallback-to-preview copying. Clipboard actions are local UI
operations; no engine mutation or agent tool was added.
[verified: `canvas/copytext.ts`, `desk.tsx`, `mail.tsx`, `mailreply.tsx`,
`replypreview.tsx`, `objectnavhost.tsx`; decided: coordinator 2026-10-21 hardening assignment]

## A question notification goes to the asker's open desk (2026-10-27)

Before the Attention queue and the Inbox, App's banner-click effect asks
`claimQuestionDesk(slug, agent)` (`canvas/deskhosts.tsx`) for a question whose
`agent` and `generation` match the tree. It reads the organization's one desk
registry (`orgDesks`, set while `DeskHosts` is mounted) and answers where the
desk is open: `popout` (a live `desk:<identity>` window), `floating` (the Open
desk modal's `borrow` slot), or a slot marked `openIn` (`'pin'` from
`pins.tsx`, `'attention'` from `AgentDeskPanel`, `'card'` from the agent's
zoomed card and its switchboard panel in `cards.tsx`, which now share the
card's `eligible = !worldHidden`) that is eligible.
Open in more than one, the slot holding the live desk (`entry.last`) wins; if
only placeholders are open, a pin, else the Attention desk, else the card takes
it through `moveHere`, never by writing ownership directly. App then reveals the
window (`revealExistingDesk`), shows the pin (`showPin`: raise, keep on screen,
pulse) or raises the Attention desk panel (`raisePinnedModal`); a zoomed card is
already at the camera's centre. After the commit `focusQuestionCard`
(`notification-visibility.ts`) focuses the card inside that slot, preferring a
desk's card over the inbox's. `openIn` draws nothing and plays no part in
`pick`. Main already shows the organization window before delivering the click
(`revealInOrgWindow`). A taskbar click and a question open nowhere keep their
routes. [decided: user 2026-10-27
m007c48d12f28, m41e0735bee13, m1a947c081d09; verified: `src/App.tsx`, `src/canvas/{deskhosts,desk,pins,cards,OrgCanvas,elicitation}.tsx`,
`src/attention/AgentDeskPanel.tsx`, `src/notification-visibility.ts`,
`tests/questionnotificationdesk.test.tsx`; 2026-10-27]

## Transcript mention notification identity (2026-10-22)

Both native-banner and taskbar/forced-desk App routes use the clicked notice's
mention ID and `source_id`, preserving existing generation guards. The current
tree marker may provide a missing event ID only when its mention ID equals the
clicked ID. A newer marker cannot replace the target or be acknowledged by that
click. The engine's existing ID-matched mention-seen endpoint remains unchanged.
The desk pages for a known event within its existing bounds. If that event is
unavailable, or the clicked notice has no identifiable source, it centers no
substitute row; the latest visible mention is never a fallback destination.
This is routing/acknowledgement correction, with no new action or tool. [verified:
`src/App.tsx`, `src/notifications.ts`, `src/canvas/desk.tsx`,
`tests/{stalementionnotice,mention-click-scroll}.test.tsx`, `http/nodes.rs`; 2026-10-22]

## Retained mail reconciliation (2026-10-21)

`useMailboxHistory` refreshes the bounded head on pushed revisions and then
reconciles only retained IDs missing from that head, up to 200 per request.
User, agent and project history share the same folder/identity checks. The
server echoes `refreshed_ids` so an older engine ignoring the query cannot
cause false deletion. Failed/malformed/incomplete reads keep rows and Retry;
success updates pending/delivered state without resetting paging or selection.
The existing history GET supports JSON-array `ids` with `folder`, refusing
empty/over-200 lists and cursor combinations; indexed IDs retain mailbox/org
and hidden-outside-mail filtering. This is automatic display reconciliation,
with no new user action or agent-tool mutation.
[verified: `src/usemailhistory.ts`, `domain/mail_history.rs`,
`http/{mailbox,nodes}.rs`; decided: coordinator 2026-10-21 hardening assignment]

## Project draft response ownership

Project creation owns a specific request, draft object and org. Only that owner
may clear the form or seed the created card from its draft spring. Cancel,
replacement and org changes invalidate ownership synchronously; a late success
still completes its original server bookkeeping without touching the newer form.
Create/Enter are disabled while pending, with a synchronous submission guard;
Cancel remains available. A refusal re-enables only its still-current form.
[verified: `canvas/OrgCanvas.tsx`, `canvas/newproject.tsx`,
`tests/projectdraft-response.test.tsx`; coordinator 2026-10-21 23:31Z]

## Typed monitor senders

Monitor-event mail rows render the shared `WatchdogLink` with the recorded
org, handle, owner and label. A display-name collision never resolves an agent
or adds its model chip. Live watchdogs use their usual detail route and tooltip;
missing registry metadata stays neutral. The recorded handle remains on the
sender wrapper and searchable. [verified: `canvas/mail.tsx`,
`tests/monitor-sender-collision.test.tsx`; 2026-10-21]

## Register menu in popped-out documents

RegisterMenu tests containment after a structural node check, rather than the
opener's `Node` constructor: portal controls belong to the pop-out realm, while
an adopted trigger can still belong to the opener. Inside pointer/wheel events
keep the menu mounted; outside events and Escape retain their close behavior.
The second-document regression dispatches pointerdown before click, including
the count input and a second trigger press. [verified: `canvas/registermenu.tsx`,
`tests/registermenu-realm.test.tsx`; 2026-10-21]

## Saved project desk identity

Project desk modal pins and pop-outs save the project's generation and restore
through the canvas's per-target instance list. Explicit generation mismatches
remain unavailable. Early 4.4 alpha records without a generation may restore
only against a currently live project with the same id; their next capture or
pin marker write records the current generation. Missing or retired projects
do not receive this legacy fallback, nor do other window kinds.
[decided: coordinator 2026-10-21 23:24Z; verified:
`canvas/{OrgCanvas,deskshell,projectdesk}.tsx`, `windowlayout.ts`,
`tests/projectdeskrestore.test.tsx`]

Native-window storage retains every open row and only the newest 20 closed
placements per base kind and organization, using last-write order. Read-time
trimming and legacy-name migration apply the same policy; an open alias wins
over a closed alias when migration produces the same key. No storage schema
change is needed. [decided: user 2026-10-20, DECISIONS 92; verified:
`windowlayout.ts`, `tests/windowretention.test.ts`; 2026-10-21]

Each saved pop-out row records the native window's own content box (`exact:
true`) when main reports it (`popout-state` `bounds` from `popoutRegistry`'s
`getContentBounds()`, published when tracked, on `moved`/`resized` and 100 ms
after `move`/`resize` settles), rather than the renderer's `screenX`/`outerWidth`
(which on Windows include the 8 px invisible frame on left, right and bottom).
Restoring an `exact` row passes `orgtreeExactRect=1,orgtreeNativeRect=1` to
`window.open`; main skips `popoutDisplayBounds` (already screen DIPs) and
applies `setExactPopoutBounds`, so a reopened or startup-restored pop-out lands
where it was left without drifting 8 px left and 16x8 px larger each time.
[verified: `main/windows.ts`, `popout.tsx`, `windowlayout.ts`,
`tests/popout-windows.test.mjs`, `tests/popoutnativebox.test.tsx`; 2026-10-27]

Pinned agent and team presentation readers report their current selected
document to the canvas's marker owner. Selection changes and opening another
reader preserve that document in the pinned open marker; reload restores it
along with the same node generation and reader scope. [verified:
`canvas/{OrgCanvas,gallery}.tsx`, `tests/readers.test.tsx`; 2026-10-21]

## Monitor card partial watchdog previews and team reader scope

Monitor event cards (`WatchdogObjectLabel` in `events/card.tsx`) keep a watcher's
live detail/menu button when its owner's loaded preview is partial
(`route.counts[owner].total > WATCHDOG_CARD_LIMIT` and the watcher falls outside the eight-row
preview), matching `WatchdogLink`. Show `(no longer exists)` only when the
watcher has confirmed spent evidence or is absent from a complete owner preview.
See [watchdog panel](../skills/orgtree-app/desk/watchdog-panel/SKILL.md).
[verified: `events/card.tsx`, `tests/eventcard.test.tsx`; 2026-10-21]

Team presentation readers (`AgentGalleryView` in `canvas/gallery.tsx`) clear an
in-memory `selId` when an authoritative refresh removes that document from the
current team scope (such as after its presenter moves out of that team), and
`pickReader` (`canvas/readers.ts`) ignores `showing(docId)` handles whose rank is
`Infinity` when current ancestry is known, so later document links route using
current team membership. See [presentations](../skills/orgtree-app/desk/presentations/SKILL.md).
[verified: `canvas/{readers,gallery}.ts*`, `tests/readers{-order,}.test.ts*`; 2026-10-21]

## Tray administrator setting

The tray Run as admin checkbox and Settings share the protected admin-change
handler and its guard, set before any asynchronous read or warning. The tray
keeps the authoritative checkmark during prompts, refreshes it after Settings
changes and on menu open, and never replaces an open native menu. Availability
uses the same boot-task detection as Settings. See [runtime desktop](../skills/orgtree-app/app-settings/app-runtime-desktop/SKILL.md).
[decided: user 2026-10-21 22:36Z; verified: `main/index.ts`, `tests/tray-admin.test.mjs`]

## Project jump activity

The shared `NavChip` derives project activity from `subtreeAgents(node)` and
the agents' observed `busy` flag, matching project header counts/activity.
Nested projects and agents are crossed; retired agents and bearer ghosts do
not activate it, and agent jump cards retain their own busy flag. All superior
and report jump cards in agent/project desks, including windowed desks, use
the same `DestinationBusy` arrows/animation. A reported Working status alone
does not count. [decided: user 2026-10-21 22:21:42Z; verified:
`canvas/desk.tsx`, `canvas/bulkcompact.tsx`, `tests/projectjumpworking.test.tsx`]

## Root retired-list stacking

The external root retired-list satellite uses layer 2: above resting cards
(1), below the focused eye (5) and its hover raise (6). Do not reuse the old
inset-bunch layer 7: it covers the eye's provider hire rows. Agent/project
retired badges live in their header flow. This restores the root relationship
in `571c0b8`, regressed by the global layer increase in `50ca4f3` and retained
for the root by `0235610`. [decided: user 2026-10-21 22:11Z; verified:
`canvas/OrgCanvas.tsx`, `tests/rootretiredhire{.test.tsx,-capture.cjs}`]

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Canvas, desks, links, menus, windows, geometry, rendering and visual behavior.

### Ticket identity hover

Every ticket link's native hover resolves the current exact ticket and shows
`Status · full title`, replacing the title-only hover. It uses the docket's
shared `docketstatus.tsx` labels, including their existing clarifications;
`archived: true` shows `Archived`. Missing/unrecognized status shows the full
title alone. Only concurrent identity reads coalesce; settled answers are not
cached, so a later hover/focus sees state/title changes even if the transcript
or row still holds an older snapshot. Adopted documents use the same reader
and stale-response/cleanup guards. Menu labels, navigation and copied titles
stay unchanged. [decided: user 2026-10-21 17:38:28Z; verified:
`canvas/objecttooltip.ts`, `canvas/docketstatus.tsx`,
`tests/tickethoverparity.test.tsx`]

### Stable live identity titles

Watchdog and agent/project native titles stay snapshotted until pointer and focus both leave.
Watchdog chips keep ticking with timer-only labels; their tooltips retain
"next check in …". Descendant entry does not refresh agent/project facts.
See [identity tooltip behavior](../rust-engine/agent-identity-tooltip.md#live-watchdog-titles-2026-10-21).
[decided: user 2026-10-21 17:39Z, coordinator 17:40Z; verified: `canvas/{nativetitle,agentnav,watchdogtitle}.ts*`]

Agent and project retired counts share a clickable header badge, replacing the
external/inset overlay label. See [retired header badges](../rust-engine/retired-header-badges.md).
[decided: user 2026-10-21 11:16Z; verified: `canvas/retiredbadge.tsx`]

Normal agent/project card faces scale uniformly only when their complete content
would overflow; fixed card bounds stay unchanged and fitting content stays at scale 1.
Transient full-name hover overlays are excluded from fit measurement; real content
changes still refit. Grey retired chips follow the other header chips.
[decided: user 2026-10-21 11:21Z; verified: `canvas/cardface.tsx`]

Project identity tooltips use the coloured header chips' exact text on one
facts line, in slot/listener/queue order; multiple listener chip texts join
with semicolons within their section. Only identity-less targets prefix a name line.
With no coloured header fact chips, every class instead shows the project name
alone, including near names and mini cards; both paths use projectHeaderFacts.
See [identity tooltip](../rust-engine/agent-identity-tooltip.md).
[decided: user 2026-10-21 11:17:42Z, 15:56:49Z, 15:59:29Z and 16:00:17Z;
verified: `canvas/OrgCanvas.tsx`, `canvas/projectcard.tsx`, `canvas/projectheaderfacts.ts`]

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Desk send-feedback position

The existing send-status row, including **steering in mid-task**, precedes the
bottom report/watchdog jump cards in the shared agent desk. Keep it outside the
transcript scroller and before `DeskReportRow`; retain the existing send-result
selection, timers and clearing behavior. The jump cards remain above the composer.
This is display ordering and adds no tool action. [decided: user 2026-10-23;
verified: `canvas/desk.tsx`, `tests/steeringorder.test.tsx`]

<a id="e-ce6c8f6006d5c62b"></a>

## Tray org lists reserve a scrollbar gutter only above ten orgs. Short lists

Original section: AGENTS.md — working on Orgtree. Source lines 360–362.

<!-- preserved:e-ce6c8f6006d5c62b -->
- Tray org lists reserve a scrollbar gutter only above ten orgs. Short lists
  keep symmetric insets; automatic overflow still serves constrained displays.
  [decided: user 2026-10-19 21:39Z; verified: `main/traylist.ts`]
<!-- /preserved:e-ce6c8f6006d5c62b -->

<a id="e-cbac513f45e879be"></a>

## Desk-tab pin/pop-out requests snapshot the owning .desk-tabpanel before

Original section: AGENTS.md — working on Orgtree. Source lines 602–609.

<!-- preserved:e-cbac513f45e879be -->
- Desk-tab pin/pop-out requests snapshot the owning `.desk-tabpanel` before
  the modal mounts. Shared one-shot origin metadata carries its client box
  and window; modal buttons still measure their own panel. Pins keep existing
  minima/canvas clamping; inline pop-outs use native exact client mapping and
  request-only work-area clamping, without changing other exact-frame launches
  or saved state. See [tab window origins](../../docs/rust-engine/tab-window-origins.md).
  [decided: user/coordinator 2026-10-19 13:32/13:38Z; verified:
  `canvas/{panelcorner,modalpin}.tsx`, `popout.tsx`, `main/windows.ts`]
<!-- /preserved:e-cbac513f45e879be -->

<a id="e-af823d06ad14a3c4"></a>

## Centered Quick chat side minima must be measured with each side temporarily

Original section: AGENTS.md — working on Orgtree. Source lines 685–690.

<!-- preserved:e-af823d06ad14a3c4 -->
- Centered Quick chat side minima must be measured with each side temporarily
  unconstrained (`min-width: max-content`), restoring its inline style before
  paint. Reading flex-clipped control widths feeds the previous minimum back
  into ResizeObserver and can alternate Quick chat widths. Only publish changed
  minima; observe nested title/control text too. See [width stability](../../docs/rust-engine/quickchat-width-stability.md).
  [verified: `shell/equalsides.ts`, `tests/quickwidth-capture.cjs`; 2026-10-19]
<!-- /preserved:e-af823d06ad14a3c4 -->

<a id="e-117fab1de7ec2e64"></a>

## A canvas hire keeps its draft until the card arrives (USER 2026-10-20

Original section: AGENTS.md — working on Orgtree. Source lines 840–850.

<!-- preserved:e-117fab1de7ec2e64 -->
- A canvas hire keeps its draft until the card arrives (USER 2026-10-20
  16:45Z): after Hire the draft stays, greyed (`draft-pending`, tag "hiring…")
  and inert, and the new card takes its exact position with no movement
  (`OrgCanvas` `pendingHire`; the swap is a layout effect, so no frame shows
  both). The feed can beat the hire's response: the hired name stands for the
  card unless a card had that name at Hire, and a response that comes after
  its card still records the hire (toast with undo, the walk to its desk).
  React 18 has no boolean `inert` prop (it warns and drops it): set the
  attribute with `toggleAttribute('inert', …)` in a layout effect, as
  `AgentDeskPanel` does. [decided: user 2026-10-20 16:45Z; verified:
  `canvas/{OrgCanvas,cards}.tsx`, `tests/pendinghire.test.tsx`; 2026-10-20]
<!-- /preserved:e-117fab1de7ec2e64 -->

<a id="e-175d9a7c8a253f9e"></a>

## Org window headers show the canonical cropped org logo immediately before

Original section: AGENTS.md — working on Orgtree. Source lines 940–946.

<!-- preserved:e-175d9a7c8a253f9e -->
- Org window headers show the canonical cropped org logo immediately before
  the name, at text height. Pushed `picture_revision` changes refresh it; a
  missing/removed/failed logo leaves no image or reserved space. The shared
  component also covers legacy and separate Organization settings headers.
  Centered headers remeasure nested title changes against intrinsic text width,
  so a late logo does not leave the org name clipped to its old allocation.
  [decided: user 2026-10-18 15:54Z; verified: `shell/{header,orgheaderlogo}.tsx`, `shell/equalsides.ts`, `App.tsx`]
<!-- /preserved:e-175d9a7c8a253f9e -->

<a id="e-bb01cec316dad2ab"></a>

## Quick chat's empty Files paperclip keeps the compact hire-options dropdown

Original section: AGENTS.md — working on Orgtree. Source lines 971–976.

<!-- preserved:e-bb01cec316dad2ab -->
- Quick chat's empty Files paperclip keeps the compact hire-options dropdown
  mounted while the native picker is open and after selection or cancellation.
  Do not call picker `back()` before opening the file input. Existing Escape /
  outside-press dismissal and attachment uploads remain unchanged. See
  [file picker](../../docs/rust-engine/quickchat-files-picker.md).
  [verified: `QuickChatBox.tsx`, `tests/quickchat-narrow.test.tsx`; 2026-10-19]
<!-- /preserved:e-bb01cec316dad2ab -->

<a id="e-8862a2e7893cee77"></a>

## Shared Markdown renders offline LaTeX ($...$, \(...\), $$...$$,

Original section: AGENTS.md — working on Orgtree. Source lines 994–1000.

<!-- preserved:e-8862a2e7893cee77 -->
- Shared Markdown renders offline LaTeX (`$...$`, `\(...\)`, `$$...$$`,
  `\[...\]`) through isolated Marked math tokens and pinned KaTeX. Preserve
  code/currency/shell text, source fallback, trust:false and request-local
  macros; reference decoration skips math subtrees. CSS/fonts bundle locally.
  Preserve text-only MathML `annotation` in DOMPurify after raw HTML escaping.
  See [math](../../docs/rust-engine/markdown-math.md). [decided: user 2026-10-18
  15:59Z; verified: `canvas/{shared,markdownmath,refmd}.ts*`, `styles.css`]
<!-- /preserved:e-8862a2e7893cee77 -->

<a id="e-6195f01a4608a74f"></a>

## Team's centered, pinned and detached panel uses one shared title/action row:

Original section: AGENTS.md — working on Orgtree. Source lines 1024–1028.

<!-- preserved:e-6195f01a4608a74f -->
- Team's centered, pinned and detached panel uses one shared title/action row:
  long titles ellipsize before Active and the window controls; the filter is
  below it. `PinFrame.titleInModal` is opt-in and keeps the same header and
  list DOM across pin/unpin. See [Team chrome](../../docs/rust-engine/team-panel-chrome.md).
  [decided: user 2026-10-19 11:38Z; verified: `canvas/{team,modalpin}.tsx`, `styles.css`]
<!-- /preserved:e-6195f01a4608a74f -->

<a id="e-13aa796da9dc2578"></a>

## Every jump row (.desk-nav) caps at 8 chip rows and scrolls, CSS only:

Original section: AGENTS.md — working on Orgtree. Source lines 1058–1064.

<!-- preserved:e-13aa796da9dc2578 -->
- Every jump row (`.desk-nav`) caps at 8 chip rows and scrolls, CSS only:
  the cap is derived from the chip (11.5px text, body line 1.5, 2px padding,
  1px border), so restyling `.desk-nav-chip` means recomputing it
  (`deskjumpscroll.test.tsx` pins both). The superior row folds under the
  same rule but keeps its agent superior out of the fold (`keep`), folding
  only the project levels as "N projects". [decided: user 2026-10-20
  09:41Z-09:43Z, 09:50Z; verified: `styles.css`, `canvas/deskjumpcards.tsx`]
<!-- /preserved:e-13aa796da9dc2578 -->

<a id="e-5cf18b78bd667358"></a>

## Team panels reuse the canvas Agents tray-panel frame and direct AgentTray,

Original section: AGENTS.md — working on Orgtree. Source lines 1103–1108.

<!-- preserved:e-5cf18b78bd667358 -->
- Team panels reuse the canvas Agents `tray-panel` frame and direct `AgentTray`,
  with Active in `PinFrame.headerActions`; no settings wrapper or bottom Close.
  The inline desk Team tab puts Active and existing PanelCorner buttons in an
  in-flow toolbar outside the tray, leaving a full-width filter below. See
  [Team panel chrome](../../docs/rust-engine/team-panel-chrome.md).
  [decided: user 2026-10-18 14:22Z/14:44Z; verified: `canvas/{team,desk,projectdesk}.tsx`, `styles.css`]
<!-- /preserved:e-5cf18b78bd667358 -->

<a id="e-d2403b89c380c6ce"></a>

## Panel buttons hide an already open local pin, even behind another panel,

Original section: AGENTS.md — working on Orgtree. Source lines 1234–1243.

<!-- preserved:e-d2403b89c380c6ce -->
- Panel buttons hide an already open local pin, even behind another panel,
  and reopen it at its saved placement on the next click. This replaces the
  12:09Z always-raise rule for buttons (user 2026-10-18 16:42Z). Detached windows
  still activate through the live registry (native restore/show/focus); explicit
  menu and pin/pop-out ensure-open routes keep their target open. Agent and
  project desk tabs activate only matching node/generation panels; closed or
  unrelated windows leave normal inline tab selection intact. See
  [panel activation](../../docs/rust-engine/panel-activation.md).
  [decided: user 2026-10-18 12:09Z/16:42Z; verified: `windowlife.ts`,
  `canvas/{modalpin,panelcorner,desk,projectdesk,OrgCanvas}.tsx`, `App.tsx`]
<!-- /preserved:e-d2403b89c380c6ce -->

<a id="e-fbc155fff7a65fd6"></a>

## Markdown links to local Windows files may use file:///C:/... or another

Original section: AGENTS.md — working on Orgtree. Source lines 1461–1465.

<!-- preserved:e-fbc155fff7a65fd6 -->
- Markdown links to local Windows files may use `file:///C:/...` or another
  drive letter; normalize only this empty-authority form before sanitization and
  keep ordinary clicks reveal-only. Unsupported file URLs stay plain text after sanitization
  removes their href. [verified: `apps/desktop/renderer/src/canvas/shared.ts`,
  `apps/desktop/renderer/tests/windowslinks.test.ts`; 2026-10-17]
<!-- /preserved:e-fbc155fff7a65fd6 -->

<a id="e-073e6f624d2a73b3"></a>

## EPIC heat's world grid bounds use the complete borrowed canvas layout,

Original section: AGENTS.md — working on Orgtree. Source lines 1664–1669.

<!-- preserved:e-073e6f624d2a73b3 -->
- EPIC heat's world grid bounds use the complete borrowed canvas layout,
  including virtualized edge cards. Never derive those bounds from only mounted
  cards: camera pan/zoom would regrid and resample temperatures. Heat inherits
  the cards' `.space` transform without a camera loop. [decided: user 2026-10-17
  12:58Z; verified: `epic/heatmap.ts`; contract:
  [EPIC heat](../../docs/rust-engine/epic-activity-sound.md#heat-equation)]
<!-- /preserved:e-073e6f624d2a73b3 -->

<a id="e-9fd820a2479bbb12"></a>

## Windows taskbar lists active orgs in a custom Recent category above fixed

Original section: AGENTS.md — working on Orgtree. Source lines 1877–1887.

<!-- preserved:e-9fd820a2479bbb12 -->
- Windows taskbar lists active orgs in a custom Recent category above fixed
  Tasks (Home, New org). Org logos and matching HomeOutlined/Add action glyphs
  use content-addressed app-owned ICOs; the app feed carries logo hashes only.
  Windows privacy refusal of custom categories keeps fixed Tasks available.
  The native app feed updates names/membership/logos; unchanged contents
  never rewrite the shell list. Strict `--orgtree-taskbar=` navigation queues
  until window routing is ready, including single-instance handoffs; orgs use
  their canonical window and relaunches drop the one-shot navigation argument.
  [decided: user 2026-10-16 and 2026-10-17 19:11–19:12Z;
  verified: `main/{jumplist,jumplist-icons,index}.ts`, `appfeed.rs`, `profile_pictures/mod.rs`;
  contract and verification limits: `docs/rust-engine/taskbar-jumplist.md`]
<!-- /preserved:e-9fd820a2479bbb12 -->

<a id="e-013a31e734ef85cd"></a>

## The canvas Agents list, Quick chat superior picker and dynamic Attention desk

Original section: AGENTS.md — working on Orgtree. Source lines 1906–1909.

<!-- preserved:e-013a31e734ef85cd -->
- The canvas Agents list, Quick chat superior picker and dynamic Attention desk
  each have an independent persisted active-only filter. Quick chat and desk
  default off; toggling one never changes another. [decided: user 2026-10-16;
  verified: `App.tsx`, `QuickChatBox.tsx`, `AttentionView.tsx`, `policy.ts`]
<!-- /preserved:e-013a31e734ef85cd -->

<a id="e-95eeb3d49bece625"></a>

## Canvas background themes (App settings &gt; Display): optional

Original section: AGENTS.md — working on Orgtree. Source lines 1948–1977.

<!-- preserved:e-95eeb3d49bece625 -->
- Canvas background themes (App settings > Display): optional
  `DesktopPreferences.canvasBackground` (absent = the original parallax dot
  grid, byte-identical) selects the `.canvas-bg` layer — `dots`, `line-grid`,
  `hex-dots`, `hex-lines`, `checkerboard` (2×2 square checkerboard; legacy
  unversioned `'square-tiles'` selections/intensities migrate here, while
  `version: 2` selects the new gapped `'square-tiles'`), `square-tiles`,
  `triangle-tiles`, `hex-tiles`, and `ascii` (labeled **Claude Waves**, placed
  last in the picker; stored `'ascii'` and `'claude-waves'` resolve to
  `'ascii'`) — each with a per-theme intensity stored sparsely, drawn in
  current theme colours, mobile off. New themes pan/zoom 1:1 like a floor; only
  dots keep the 0.88 parallax. Hex lines and the three gapped tile presets
  (`square-tiles`, `triangle-tiles`, `hex-tiles`) are SVG masks over a
  theme-colour fill (`var(--line)`), with each tile drawn as its own closed
  outlined polygon inset from its `{4,4}`, `{3,6}`, or `{6,3}` cell so
  neighbouring tiles have a small even gap and share no edges. Claude Waves
  (`ascii`) is an exact-match WebGL2 re-implementation of the Claude Code
  backdrop algorithm (user 2026-10-15 19:55Z, 2026-10-16: real renderer studied
  read-only, re-implemented independently, NO Anthropic code in repo/docs/tests):
  wind-field + glyph passes in `canvas/asciigl.ts`, spec + CPU mirror in
  `canvas/asciifield.ts`, seeded per-mount visit, world-coordinate sampling
  with zoom-out density floor (`z >= 0.35`, `gridScale >= 0.75 * dpr`) and
  cached glyph atlases, pointer stir/ripples/heart, 180s settle-to-calm, hidden
  pause, still mode under reduced motion, graceful load backoff (`opacity: 0`
  when `busy-off` so no frozen world frame sticks to the viewport, 1.5s→8s
  auto-recovery retry, `WEBGL_lose_context` / `webglcontextlost` +
  `webglcontextrestored` resource regeneration), and silent absence without
  hardware WebGL2. Contract, evidence and limits:
  [canvas background themes](../../docs/rust-engine/canvas-background-themes.md).
  [decided: user 2026-10-15, 2026-10-16; verified from source:
  `canvas/canvasbackground.tsx`, `canvas/asciigl.ts`, `contracts/canvas-background.ts`, `main/policy.ts`]
<!-- /preserved:e-95eeb3d49bece625 -->

<a id="e-118ee031d668ac37"></a>

## EPIC Mode, the final version (branch epic/final): the Opus take's architecture

Original section: AGENTS.md — working on Orgtree. Source lines 2040–2063.

<!-- preserved:e-118ee031d668ac37 -->
- EPIC Mode, the final version (branch `epic/final`): the Opus take's architecture
  with the best of the four takes folded in; comparison, credits, inventory and
  verification in [EPIC Mode final](../../docs/rust-engine/epic-mode-final.md). The secret
  switch is the last row of Settings › Developer, drawn in nothing but the background
  until hovered (`--panel-2`), revealed in the theme accent when checked, invisible
  again when unticked; stored as optional native `DesktopPreferences.epicMode`
  (boolean only, absent = off). OFF CONTRACT: one preference subscription per window
  (`epic/sync.ts`), a borrowed latest-tree reference, and null-checked taps (`epic?.frame` in App.tsx,
  `epic?.refused` on `req`'s failure path; `interruptNode` returns the bare request
  while off). Never add listeners, DOM or audio outside `epic/director.ts`, which
  loads only by `import()` when on and removes everything when it stops. A tree is a
  selection: a hire needs a recent `created`, a retirement live→archived. The org
  socket's only `node_event` pulses are `turn_done`, `frozen` and `renamed`
  (`changes.rs`); read every other agent change from trees. No effect
  celebrates a request the engine refused or did not carry out (the interrupt waits
  for `interrupted: true`), and a 100% usage reading is a reading, never "LIMIT".
  One stage frame loop that sleeps when idle; while only lingering marks
  (`Stage.leave`: at most 48, none past 30 s, aged on the clock) are alive
  it draws 15 frames a second on a timer. Sounds are Web Audio synthesis and art is canvas drawing,
  never assets. Check the strict renderer and test configs as well as root: the
  test overlay must clear the inherited `exclude: ["tests"]`.
  [decided: user 2026-10-14 23:38–23:43Z; the lingering marks and the slow lane: user
  2026-10-15, plan approved by the coordinator; verified from source: `epic/*`, `api.ts`,
  `appfeed.ts`, `changes.rs`, 2026-10-15; branch `epic/final`; measured: `epicmode-linger`]
<!-- /preserved:e-118ee031d668ac37 -->

<a id="e-ffd4085d82d91d2b"></a>

## Measuring inside a desk on the canvas: .space carries the camera's scale(view.z)

Original section: AGENTS.md — working on Orgtree. Source lines 2089–2098.

<!-- preserved:e-ffd4085d82d91d2b -->
- Measuring inside a desk on the canvas: `.space` carries the camera's `scale(view.z)`
  and `.desk-inner` its own `scale(0.13333 × --desk-dpi)`, so `getBoundingClientRect()`
  is in screen px while offsets, padding, scroll and text measured in the element's
  font stay in its own px. Multiply those by the element's screen scale
  (`box.width / offsetWidth`) before adding them to a screen position. Pinned and
  popped-out desks are scale 1, so the mistake shows only on the canvas: EPIC Mode's
  typing sparks landed up to 92 px off the caret this way (fixed in `caretSpot`;
  [EPIC Mode final](../../docs/rust-engine/epic-mode-final.md)). [verified: `epic/director.ts`,
  `canvas/docket.tsx`; measured: `tools/rig/epic-mode-visual.mjs` typing scene,
  2026-10-15]
<!-- /preserved:e-ffd4085d82d91d2b -->

<a id="e-2a730b86cf3911f1"></a>

## A textarea has no API for its caret's position on screen. EPIC Mode's

Original section: AGENTS.md — working on Orgtree. Source lines 2100–2111.

<!-- preserved:e-2a730b86cf3911f1 -->
- A textarea has no API for its caret's position on screen. EPIC Mode's
  `caretSpot` lays the text out in a hidden copy of the field (its font,
  spacing, wrapping and exact content width without the scrollbar), puts
  everything from the caret in a marker span and reads the marker's first
  client rect; a zero-width space marks the end of the text or of a line,
  since it never moves a break. Measuring by newlines alone misses soft wraps:
  the typing sparks stayed at the end of the first line (user report
  2026-10-16). jsdom lays nothing out, so check wrapping in Electron
  (`tools/rig/epic-mode-visual.mjs`, typing scene). A visual fixture that
  models the caret must also model what `caretSpot` clamps (4 screen px inside
  the right edge).
  [verified: `epic/director.ts`; measured: typing scene, 2026-10-16]
<!-- /preserved:e-2a730b86cf3911f1 -->

<a id="e-89dec1f0b67138ab"></a>

## Photographing a popped-out window in the offscreen capture: a child opened by

Original section: AGENTS.md — working on Orgtree. Source lines 2113–2119.

<!-- preserved:e-89dec1f0b67138ab -->
- Photographing a popped-out window in the offscreen capture: a child opened by
  `window.open` from an `offscreen: true` page never produces a frame, even when its
  `webPreferences` are offscreen too (`capturePage()` returns an empty image, no
  `paint` event, `showInactive()` does not help; the DOM receipt still passes and the PNG
  is a 0-byte file). Open it from `setWindowOpenHandler` as a hidden ordinary window
  (`show: false`, `paintWhenInitiallyHidden: true`, no `offscreen`): it captures at its full
  size. [measured: `tests/epicmode-capture.cjs` wrap pass, 2026-10-16]
<!-- /preserved:e-89dec1f0b67138ab -->

<a id="e-6d144ff6c2cca614"></a>

## EPIC Mode must not strobe, and its shakes and blurs stay within comfort bounds

Original section: AGENTS.md — working on Orgtree. Source lines 2131–2148.

<!-- preserved:e-6d144ff6c2cca614 -->
- EPIC Mode must not strobe, and its shakes and blurs stay within comfort bounds
  (photosensitivity). The stage enforces them for every effect, so a new effect flashes,
  dips, shakes and blurs the window only through `Stage.flash`, `flicker`, `shake` and
  `blur`: no two flashes or brown-out dips start closer than `FLASH_GAP_MS` (340 ms; a
  flash asked for sooner waits and later ones join it), so at most three a second, on
  screen too (each is timed from the frame it first shows in, never from its schedule); a
  shake is at most 20 px for 0.9 s, a weaker one never cuts a stronger one short, and the
  window shakes at most 1 s of any 2 s; a blur (a `backdrop-filter` layer of the stage's
  own) is at most 6 px over the window or 10 px at its edges, for 0.7 s, one per 0.6 s;
  under `prefers-reduced-motion` nothing shakes or blurs and flashes are half as strong. An
  event's shake and blur come from its weight (`WEIGHT` in the director). Attention and
  halt space their repeated flashes `FLASH_EVERY_MS` (360 ms) apart, and urgent mail's
  alarm tints every window showing the org in smooth pulses 0.8 s apart (never under
  0.4 s), with a klaxon at EPIC's normal level, until the mail is read or for 8 s
  ([EPIC Mode final](../../docs/rust-engine/epic-mode-final.md)). [decided: user 2026-10-15;
  coordinator 2026-10-15 (flash merging, the flicker cap); verified: `epic/director.ts`,
  `epic/stage.ts`; measured: `epicmode-comfort`, `epicmode-urgent`,
  `tools/rig/epic-mode-visual.mjs` urgent and blur sections, 2026-10-15]
<!-- /preserved:e-6d144ff6c2cca614 -->

<a id="e-34c90713a8b9c9b0"></a>

## EPIC Mode has no combo meter, ranks, milestones or rank fanfare. Keep the

Original section: AGENTS.md — working on Orgtree. Source lines 2157–2163.

<!-- preserved:e-34c90713a8b9c9b0 -->
- EPIC Mode has no combo meter, ranks, milestones or rank fanfare. Keep the
  small sounds' rising pitch: a private burst count resets after 2.5 s and
  climbs at most one octave at 36 events; it never keeps the stage awake.
  Momentum, charge, level, chains and progression unlock notes are separate
  and stay unchanged. This replaces the small corner combo badge ruling.
  [decided: user 2026-10-16 20:45–20:46Z; verified: `epic/director.ts`,
  `epic/stage.ts`, `epic/audio.ts`; contract: `docs/rust-engine/epic-mode-final.md`]
<!-- /preserved:e-34c90713a8b9c9b0 -->

<a id="e-a2234c2e98328da4"></a>

## The revealed Rainbow mode row appears only for Custom themes. Selecting a

Original section: AGENTS.md — working on Orgtree. Source lines 2186–2190.

<!-- preserved:e-a2234c2e98328da4 -->
- The revealed Rainbow mode row appears only for Custom themes. Selecting a
  preset hides it without altering saved revealed/enabled/epoch preferences;
  returning to Custom restores its prior state. [decided: user/coordinator
  2026-10-14 23:24UTC; verified: `themes.tsx`; contract:
  `docs/rust-engine/rainbow-custom-toggle.md`]
<!-- /preserved:e-a2234c2e98328da4 -->

<a id="e-00c835aac320ed06"></a>

## Remaining preset contrast and retired Grey migration

The six provider presets retain their ruled deep light-surface partners,
hover/ink contrast, chip backing and popout propagation. Orgtree Grey was
removed2026-10-23; its selected base color migrates to Custom #b6bdc8 while
unset provenance retains provider detection. The earlier signed palette is
[historical](legacy-and-superseded.md#e-00c835aac320ed06). See
[migration](../rust-engine/removed-grey-theme.md) for the three-case contract.
[decided: user/coordinator2026-10-23; verified: visual-theme.ts, policy.ts, themes.tsx]


<a id="e-151563aeff92b242"></a>

## App settings uses a 791px modal width (formerly660/726/783px), retaining the94vw

Original section: AGENTS.md — working on Orgtree. Source lines 2262–2273.

<!-- preserved:e-151563aeff92b242 -->
- App settings uses a 791px modal width (formerly660/726/783px), retaining the94vw
  cap and pinned-window sizing. Scope the override to `.settings.acct-panel`;
  organization/agent settings and other modals keep their own widths.
  Rig439 measured minimum783px (719px tabs +64px chrome); coordinator20:21UTC
  adds8px margin for font/scaling variation. Narrow94vw is unchanged.
  At1366×768 rig439 verifies791px panel and727/727px tab client/scroll,
  with allnine tabs visible. scrollWidth-clientWidth measures overflow only,
  not spare margin;8px remaining is inferred from earlier719px overflowing content.
  The supported offscreen runner fixesDPR1;125/150%scaling is unmeasured.
  Do not change tab labels/style. [measured: rig439; decided: user/coordinator2026-10-14;
  [panel proof and limits](../../docs/rust-engine/panel-widths-provider-headings.md)]
  [decided: user 2026-10-14 17:54UTC; verified: renderer `styles.css`]
<!-- /preserved:e-151563aeff92b242 -->

<a id="e-c67c4829b224d495"></a>

## Middle-button pan uses native DOM capture on each visible canvas viewport,

Original section: AGENTS.md — working on Orgtree. Source lines 2500–2506.

<!-- preserved:e-c67c4829b224d495 -->
- Middle-button pan uses native DOM capture on each visible canvas viewport,
  including registry-owned desk portals whose React ancestry bypasses it
  (2026-10-16). Reuse the background pan/persisted camera. Suppress middle
  mousedown/auxclick defaults; never set the eye's click-focus flag for it.
  See [middle pan](../../docs/rust-engine/middle-pan.md).
  [decided: user 2026-10-13 22:29UTC, 2026-10-16 13:15UTC;
  verified: `canvas/OrgCanvas.tsx`, `canvas/deskhosts.tsx`, `popout.tsx`]
<!-- /preserved:e-c67c4829b224d495 -->

<a id="e-c43eaad8eab50f77"></a>

## Tray Harness setup reads the engine registry, with a five-harness shell fallback;

Original section: AGENTS.md — working on Orgtree. Source lines 2508–2512.

<!-- preserved:e-c43eaad8eab50f77 -->
- Tray Harness setup reads the engine registry, with a five-harness shell fallback;
  detected first, one separator before missing, all setup actions clickable.
  Keep legacy desktop IPC IDs and primary-click toggle behavior. See
  [tray harness setup](../../docs/rust-engine/tray-harness-setup.md).
  [decided: user 2026-10-13 22:22UTC; verified: desktop `harnesses.ts`, `index.ts`]
<!-- /preserved:e-c43eaad8eab50f77 -->

<a id="e-d2f868fd15c76927"></a>

## Failed shell errors show a compact indicator; expansion reads retained output

Original section: AGENTS.md — working on Orgtree. Source lines 2528–2533.

<!-- preserved:e-d2f868fd15c76927 -->
- Failed shell errors show a compact indicator; expansion reads retained output
  via authenticated org/node/seq/tool `tooloutput`, with a UTF-8-safe 1 MiB cap
  and explicit truncation note. Keep raw output out of chat/feed and wire logs;
  successful calls/other tools keep existing clipping. See
  [retention and proof limits](../../docs/rust-engine/shell-error-fold.md).
  [decided: user/coordinator 2026-10-13; verified: runtime `convo.rs`, HTTP `nodes.rs`, renderer `desk.tsx`]
<!-- /preserved:e-d2f868fd15c76927 -->

<a id="e-6cea9fae253bb4b7"></a>

## Sibling drag preview is a node-height accent separator: vertical in tree rows,

Original section: AGENTS.md — working on Orgtree. Source lines 2571–2578.

<!-- preserved:e-6cea9fae253bb4b7 -->
- Sibling drag preview is a node-height accent separator: vertical in tree rows,
  radial through the eye in rings. Preserve angular/x drop request semantics;
  marker geometry is visual-only. Ring ends use a 16-world-pixel gutter beyond
  the endpoint card's tangent extent, including a single remaining target;
  never space the endpoint marker through the unused arc. Between-agent
  midpoints are unchanged. See [reorder separator](../../docs/rust-engine/reorder-separator.md).
  [decided: user 2026-10-13 18:58UTC; coordinator 2026-10-16 13:58UTC;
  verified: `canvas/reorderpreview.tsx`, `canvas/ringreorder.ts`, `OrgCanvas.tsx`]
<!-- /preserved:e-6cea9fae253bb4b7 -->

<a id="e-42d44ca9ad024672"></a>

## Tray primary clicks toggle pending or visible org lists; dismissal invalidates

Original section: AGENTS.md — working on Orgtree. Source lines 2579–2583.

<!-- preserved:e-42d44ca9ad024672 -->
- Tray primary clicks toggle pending or visible org lists; dismissal invalidates
  late activity/HTML loads. Windows tray-induced blur consumes one immediate
  click, while outside dismissals and later clicks remain usable. Preserve the
  double-click open-app route and sandbox. See [tray toggle](../../docs/rust-engine/tray-toggle.md).
  [decided: user 2026-10-13 18:42UTC; verified: desktop `main/index.ts`]
<!-- /preserved:e-42d44ca9ad024672 -->

<a id="e-d41fba9d3b8742ae"></a>

## Ctrl/Cmd+Z runs the newest visible toast Undo in its own window; keep text

Original section: AGENTS.md — working on Orgtree. Source lines 2611–2614.

<!-- preserved:e-d41fba9d3b8742ae -->
- Ctrl/Cmd+Z runs the newest visible toast Undo in its own window; keep text
  editor undo and the 12-second deadline. Clicks and mirrors consume the same
  callback once before invoking it. See [toast shortcut](../../docs/rust-engine/toast-undo-shortcut.md).
  [decided: user 2026-10-13 18:14UTC; verified: renderer `toasts.tsx`, `App.tsx`]
<!-- /preserved:e-d41fba9d3b8742ae -->

<a id="e-a2a8e8e316dcba04"></a>

## Native popout Close dismisses PinFrame through its existing close callback;

Original section: AGENTS.md — working on Orgtree. Source lines 2691–2699.

<!-- preserved:e-a2a8e8e316dcba04 -->
- Native popout Close dismisses `PinFrame` through its existing close callback;
  explicit Pop in returns the same mounted content. Persistent desk Close keeps
  content but never activates a missing main-window destination or creates a
  recovery box for it. Main exit, hosted-parent recovery, temporary borrowing
  and failure recovery keep their restoration paths. See
  [Close versus Pop in](../../docs/rust-engine/popout-close.md).
  [decided: user 2026-10-13 08:22Z, coordinator caller ruling 08:26Z;
  verified from source: renderer `popout.tsx`, `canvas/modalpin.tsx`,
  `canvas/deskhosts.tsx`, 2026-10-13]
<!-- /preserved:e-a2a8e8e316dcba04 -->

<a id="e-8e3ffb71b7e07772"></a>

## With "Hide retired agents" off the canvas draws a retired pile only from

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2759–2775.

<!-- preserved:e-8e3ffb71b7e07772 -->
- With "hide retired agents" off the canvas draws a retired pile only from
  retired records it holds, so the record feed's shared set carries, beside the
  live agents, each visible parent's first and last archived child in the
  canvas's sibling order (`sibling_order`, then id): the top level's, every live
  agent's and, in turn, each pile front's (design §1.3, 3.x `_pile_edges`).
  Buried pile members stay out. `compute::pile_edges` probes the partial index
  `agents_retired_pile_edges` (migration 0044) twice per visible parent, so the
  read follows the live tree, not retired history. The actor re-reads it only
  for batches touching a retired agent, a representative, an agent entering the
  live set or an org reload, in one snapshot with the `foreground` counts (no
  write refreshed those before). A rehire also marks its old parent: a retired
  one may front a pile. The HTTP tree subtracts held representatives
  from each hidden count. Measured at 1411 retired (debug engine): `/records`
  36.5 KB in about 13 ms. See [record feed](../../docs/state-system/pg-step6-record-feed.md).
  [decided: user 2026-10-20 11:00Z, coordinator 11:11Z; verified: `feed/compute.rs`,
  `feed/mod.rs`, `http/tree.rs`, `domain/ops.rs` rehire, `tools/rig/proofs/retired-piles.mjs`,
  `retired-piles-scale.mjs`, 2026-10-20]
<!-- /preserved:e-8e3ffb71b7e07772 -->

<a id="e-3060dce792c23ed5"></a>

## Quick chat's superior picker puts its selectable top level eye row

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2794–2800.

<!-- preserved:e-3060dce792c23ed5 -->
- Quick chat's superior picker puts its selectable `top level` eye row
  inside the Agents List after the filter, with every agent one depth deeper.
  A filtered agent keeps its ancestor chain and a ghost root; keyboard choices
  skip ghosts and empty results cannot select a hidden root. Other Agents Lists
  keep their depths. See [superior picker root](../../docs/rust-engine/superior-picker-root.md).
  [decided: user 2026-10-14 10:54:49Z; verified from source: `QuickChatBox.tsx`,
  `canvas/agenttray.tsx`; batch verification pending]
<!-- /preserved:e-3060dce792c23ed5 -->

<a id="e-58a5f2bb9f9e273e"></a>

## Canvas sibling drags and their Undo preview before the reorder endpoint answers.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3063–3068.

<!-- preserved:e-58a5f2bb9f9e273e -->
- Canvas sibling drags and their Undo preview before the reorder endpoint answers.
  Preview Rust's live-sibling midpoint ordering through the shared chart/list tree;
  clear only the matching operation on refusal or after success plus an agreeing
  tree (five-second success fallback). An old response/read/timer cannot cancel a
  newer pending drag. [verified: renderer `canvas/pendingorder.ts`,
  `canvas/OrgCanvas.tsx`, 2026-10-11; proof: `docs/rust-engine/move-preview.md`]
<!-- /preserved:e-58a5f2bb9f9e273e -->

<a id="e-ee5d1f5a03f607f1"></a>

## Agent Open &gt; Open scratch folder is a native directory-only action. Resolve

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3143–3155.

<!-- preserved:e-ee5d1f5a03f607f1 -->
- Agent Open > Open scratch folder is a native directory-only action. Resolve
  stored/imported/renamed paths through authenticated agent identity; never
  reconstruct a path in the renderer or open a file. Missing folders report an
  error without creation. Open team scratch folder uses that agent's numeric
  own-led team id, even for a leaf. Switchboard and Org settings > Basic open
  the same org shared scratch folder. These new managed targets create on
  demand inside org scratch, refusing link/reparse/file components. Reuse the
  same IPC/engine route; scoped capability and response markers prevent older
  shells/engines silently opening personal scratch instead.
  Synthetic checks cover managed/personal paths and all three UI entries;
  the final OS opener is injected, so real file-manager launch remains untested.
  [decided: user 2026-10-16 10:16Z; verified: `http/nodes.rs`, `domain/teams.rs`,
  `main/scratch-folder.ts`; details: `docs/rust-engine/scratch-folder.md`]
<!-- /preserved:e-ee5d1f5a03f607f1 -->

<a id="e-9381f6226f165ba7"></a>

## Size and rect state fed by observers is set as a VALUE, and layout effects

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3359–3365.

<!-- preserved:e-9381f6226f165ba7 -->
- Size and rect state fed by observers is set as a VALUE, and layout effects
  schedule only a changed value. A lower-priority updater (`set(prev => …)`)
  is re-run from its stale base on every higher-priority render and returns a
  new object each time; the zoom HUD's layout effect keyed on that object
  re-ran until React's nested-update limit crashed the canvas (rig finding F1).
  [verified with `tools/rig/proofs/canvas-resize-crash.mjs`: 2026-10-07;
  `canvas/OrgCanvas.tsx`]
<!-- /preserved:e-9381f6226f165ba7 -->

<a id="e-690e872468fd31c7"></a>

## App and Org settings checkboxes use SetToggle: checkbox left, label/hint,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3367–3372.

<!-- preserved:e-690e872468fd31c7 -->
- App and Org settings checkboxes use `SetToggle`: checkbox left, label/hint,
  on/off state right. Its optional `labelContent` preserves decorative text
  with a plain accessible name; `action` keeps independent right-side controls
  outside checkbox labels (e.g. Open logs folder). Turn-limit switches mean
  enabled; off still persists zero seconds. [user 2026-10-07 17:41–17:42Z;
  typecheck and isolated Appearance/Debug/turn-limit renderer smoke]
<!-- /preserved:e-690e872468fd31c7 -->

<a id="e-eba844c285fa8054"></a>

## Agent settings shares the canvas credit paint and stats in creditbarpaint.tsx;

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3413–3418.

<!-- preserved:e-eba844c285fa8054 -->
- Agent settings shares the canvas credit paint and stats in `creditbarpaint.tsx`;
  the horizontal bar rotates that paint and expands its initial 2x grant range
  during right-edge drags. Identity/actions sit above the tabs, and setting
  controls use `settingskit` rows. Keep the UI-only restyle separate from drag
  behavior changes. [recorded-decision / verified-from-source: 2026-10-07;
  `docs/rust-engine/agent-settings-refresh.md`, DECISIONS 52 addition]
<!-- /preserved:e-eba844c285fa8054 -->

<a id="e-1a647c7f2dfbfa7b"></a>

## Cost labels show only $X.XX, including partial nonzero totals; unknown zero

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3570–3573.

<!-- preserved:e-1a647c7f2dfbfa7b -->
- Cost labels show only `$X.XX`, including partial nonzero totals; unknown zero
  stays `$?`. Partial/estimated explanations stay in the existing hover titles.
  [recorded-decision: user 2026-10-07 09:49Z; verified-from-source:
  renderer `canvas/desk.tsx`, `shell/treeinfo.tsx`]
<!-- /preserved:e-1a647c7f2dfbfa7b -->

<a id="e-fe604f14bf3b4282"></a>

## Draft hire cancellation saves the camera intent (org fit or focused target)

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3596–3601.

<!-- preserved:e-fe604f14bf3b4282 -->
- Draft hire cancellation saves the camera intent (org fit or focused target)
  and exact manual pan/zoom, plus any mounted desk's keyboard/caret state.
  Restore after layout settles through the shared cancellation route; every
  draft entry uses the same snapshot and confirmation discards it. A saved
  target must still match its generation. [verified from source and isolated
  real-browser smoke: 2026-10-07; `docs/rust-engine/draft-cancel-focus.md`]
<!-- /preserved:e-fe604f14bf3b4282 -->

<a id="e-21c837a0d728a6dd"></a>

## Passive notices repaint an event card's left edge (.event-notice, after the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3626–3630.

<!-- preserved:e-21c837a0d728a6dd -->
- Passive notices repaint an event card's left edge (`.event-notice`, after the
  family rules). A variant that needs its own edge colour, like the two restart
  cards (red edge, neutral other sides), needs a rule after it that is at least as
  specific as `.msg.user.event-surface.event-notice`. [user 2026-10-13; verified
  from source, `tests/restartedge.test.tsx`]
<!-- /preserved:e-21c837a0d728a6dd -->

<a id="e-e31eec2ea2cef16b"></a>

## Every keyboard shortcut is listed in renderer/src/shortcuts.ts, which App

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3638–3643.

<!-- preserved:e-e31eec2ea2cef16b -->
- Every keyboard shortcut is listed in `renderer/src/shortcuts.ts`, which App
  settings → Keyboard shortcuts renders read-only (user 2026-10-14: Settings only,
  no overlay or menu entry). `tests/shortcuts.test.tsx` scans `renderer/src` and
  `main` for key literals (`.key === 'X'`, `[...].includes(e.key)`, `accelerator:`)
  and fails both ways, so a new binding lands with its entry, or in `BUILTIN` with
  the reason it is not shown. [user 2026-10-14; verified: `tests/shortcuts.test.tsx`]
<!-- /preserved:e-e31eec2ea2cef16b -->

<a id="e-e771f47a14224118"></a>

## Agent card and Agents List menus share canvas/agentmenu.tsx. The hire-tier

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3662–3685.

<!-- preserved:e-e771f47a14224118 -->
- Agent card and Agents List menus share `canvas/agentmenu.tsx`. The hire-tier
  submenu uses `hireTierOffer` (also used by HireSheet) and opens the existing
  local draft form; only confirmation creates a seat. Halt/Unhalt shares
  `toggleAgentHalt` with the desk control, including the settling halt phase.
  Copy agent name flows directly into Focus, then Hire a subordinate.
  Open submenu follows Hire: desk, popout and pin destinations together,
  then a separator before inbox, docket, team docket and presentations.
  Destination availability keeps its existing gates.
  Switchboard tab names and desk headers reach this same builder through
  `agentnav`; they do not maintain a separate action list.
  The final separated group has clickable Cheap compact, Halt/Unhalt and
  Retire/Dissolve roots; live teams get subtree/all-subordinates submenus.
  All compaction entries use the yellow caution tint. Busy/sessionless heads
  cannot compact themselves but retain access to eligible descendants.
  Manager retirement includes its team in the engine, so its root says Dissolve.
  The switchboard header exposes the eye's general menu, including yellow
  Cheap-compact all agents and count-confirmed batch Halt/Unhalt all agents.
  This batch does not apply the broader STOP ALL organization/watchdog latch.
  Team halt actions confirm live target counts and use HTTP ops `nodes`, with
  all targets validated before the shared F05 parallel executor. Each set
  offers Unhalt only when all its live targets are halted; mixed sets offer Halt.
  Cheap compact confirms the existing `cheap_compact` operation and is
  disabled for non-live, busy or sessionless agents. [user 2026-10-07 17:16Z;
  verified from source and isolated renderer screenshots/smoke]
<!-- /preserved:e-e771f47a14224118 -->

<a id="e-9f7d75431386cefd"></a>

## The canvas Agents panel's active checkbox is in the shared PinFrame title

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3687–3691.

<!-- preserved:e-9f7d75431386cefd -->
- The canvas Agents panel's **active** checkbox is in the shared PinFrame title
  bar beside pop-out and pin, not in the scrolling tray. It filters by the
  renderer's live-turn `busy` flag; the persisted preference also filters the
  Attention drawer. [user 2026-10-16; verified: `OrgCanvas.tsx`,
  `canvas/agenttray.tsx`, `canvas/modalpin.tsx`]
<!-- /preserved:e-9f7d75431386cefd -->

<a id="e-e25bcf73e4bb3e12"></a>

## One executable, orgtree-engine.exe, in the Cargo workspace engine/rs/ (crates

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3705–3708.

<!-- preserved:e-e25bcf73e4bb3e12 -->
- One executable, `orgtree-engine.exe`, in the Cargo workspace `engine/rs/` (crates
  `orgtree-engine` and the `orgtree-logged` macro). It replaces the whole Python engine; the
  desktop and its UX contract stay. The Python engine stays in the tree untouched, so going back
  is "run the old build". [verified: `engine/rs/`; decided: user, DECISIONS 1–3]
<!-- /preserved:e-e25bcf73e4bb3e12 -->

<a id="e-18c06ea7902046e9"></a>

## The desktop starts it from resources/engine/orgtree-engine.exe when packaged, or from

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3709–3710.

<!-- preserved:e-18c06ea7902046e9 -->
- The desktop starts it from `resources/engine/orgtree-engine.exe` when packaged, or from
  `ORGTREE_ENGINE_BIN` in development. [verified: `apps/desktop/main/index.ts`, `package.json`]
<!-- /preserved:e-18c06ea7902046e9 -->

<a id="e-8f4eeafe9fbf4c03"></a>

## Stopping: the engine's callers kill its whole tree (PostgreSQL with it) soon after asking it to

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3715–3730.

<!-- preserved:e-8f4eeafe9fbf4c03 -->
- Stopping: the engine's callers kill its whole tree (PostgreSQL with it) soon after asking it to
  stop: the desktop's Quit after 8 s for an engine it started (3 s request + 5 s, `stop()` in
  `apps/desktop/main/engine.ts`) and after about 12 s for an attached one (`stopForQuit`, the whole
  quit capped at 26 s); the background host after 15 s (`host.rs`: 5 s request + `SHUTDOWN_WAIT`
  10 s); the installer upgrade waits 45 s and never kills (it offers Retry/Cancel); the rig keeper
  after 45 s (run.json `stopKillMs`). A killed cluster's next start fsyncs its whole data folder
  before WAL replay: 5-185 s in the rig on a busy disk. The engine reaches the database stop
  within 0.1-0.5 s of the request (agents mid-turn included); `pg_ctl stop -m fast` then gets 120 s
  (`STOP_WAIT` in `src/pg.rs`), and `checkpoint_timeout` is 5 min so a stop has little to flush
  (the live cluster dirties 0.7-1 MB a minute, p99 2.4). A CHECKPOINT before the stop, early or
  late, was measured and dropped: with nothing to overlap it only adds a second checkpoint's
  fixed cost. On a disk saturated with fsyncs even a 4 MB stop takes 3-7 s, so the 8 s budget is
  not guaranteed there; the live disk's shutdown checkpoints take under 0.3 s. Measure before
  changing any of these numbers: `tools/rig/proofs/pg-stop.mjs` stops a run with fsync on under
  each budget. [measured: rig pg-stop and a read-only summary of the live cluster's checkpoint
  log, 2026-10-10; decided: coordinator 2026-10-10]
<!-- /preserved:e-8f4eeafe9fbf4c03 -->

<a id="e-a26be1ca50afb8ed"></a>

## Viewport history fill uses before cursor pages, not a larger moving tail:

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3780–3786.

<!-- preserved:e-a26be1ca50afb8ed -->
- Viewport history fill uses `before` cursor pages, not a larger moving tail:
  a burst while a window is away can make a valid enlarged tail look stalled.
  Rust cursors are decimal oldest-row sequences; preserve that cursor when
  trimming incremental rows, and retain the read range from page-request start.
  Caller/browser `AbortError` and superseded errors are silent; `TimeoutError`
  remains a real failure. [verified-from-source and mounted mock: 2026-10-07;
  `docs/rust-engine/transcript-history-retries.md`]
<!-- /preserved:e-a26be1ca50afb8ed -->

<a id="e-50bb1f59fa68fdf3"></a>

## Activity summary strip (2026-10-07). ActiveAgentSummary uses the org list's

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3947–3955.

<!-- preserved:e-50bb1f59fa68fdf3 -->
**Activity summary strip (2026-10-07).** `ActiveAgentSummary` uses the org list's
`active/live` count and spinning-arrow styles, but keeps counting its own live
tree nodes (`busy` means active); per-tier totals and tooltip use that same tree.
The shared org activity spinner stays visible but static under reduced motion,
and is absent while idle. Its 14px slot remains reserved and centre-aligned,
with a 4px gap before the count. Counts use tabular digits without extra leading
width; the pill's left and right padding match. [user follow-ups 2026-10-07 09:51Z, 09:57Z;
verified from source: `shell/treeinfo.tsx`,
`shell/orgrows.tsx`, `styles.css`; recorded decision: user 2026-10-07 09:44Z]
<!-- /preserved:e-50bb1f59fa68fdf3 -->

<a id="e-07d44cfe835e7ad2"></a>

## Transport: HTTP for loads and actions, the org and app sockets for pushed updates, with

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3991–3993.

<!-- preserved:e-07d44cfe835e7ad2 -->
- **Transport:** HTTP for loads and actions, the org and app sockets for pushed updates, with
  rooms so a window receives only what it shows; agents reach the engine over their CLI's own
  pipes, never HTTP. [decided: user, DECISIONS 13–14; PLAN §2, §4]
<!-- /preserved:e-07d44cfe835e7ad2 -->

<a id="e-6cf2c5e91d40fa7b"></a>

## Desk geometry and ordering (2026-10-06). Explicit desk pop-outs measure the visible

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4032–4035.

<!-- preserved:e-6cf2c5e91d40fa7b -->
**Desk geometry and ordering (2026-10-06).** Explicit desk pop-outs measure the visible
desk frame, then map its CSS rectangle through the owner's native content origin and browser
zoom. Windows cross-display mapping goes through physical pixels; content bounds exclude
invisible frame allowances. Lifecycle restores still use saved standalone placement.
<!-- /preserved:e-6cf2c5e91d40fa7b -->

<a id="e-8e30d186ebc6058a"></a>

## Desk popout navigation (2026-10-07, verified from source and browser smoke).

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4043–4047.

<!-- preserved:e-8e30d186ebc6058a -->
**Desk popout navigation (2026-10-07, verified from source and browser smoke).**
Card and agent-list menus request the canonical desk window without recentering.
An unopened desk gets an on-demand launch slot, removed after detach or failure;
registry notifications must not recreate its registration props. Explicit Focus
and redock navigation remain separate. See `canvas/deskhosts.tsx`.
<!-- /preserved:e-8e30d186ebc6058a -->

<a id="e-60b5e834a51616ee"></a>

## Temporary desks (2026-10-07, verified from source and browser smoke). Their jump

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4049–4054.

<!-- preserved:e-60b5e834a51616ee -->
**Temporary desks (2026-10-07, verified from source and browser smoke).** Their jump
cards use normal desk navigation; an explicit jump closes the temporary host. Keep
the host at layer 20, below dialogs (30/31). Canvas-owned dialogs must also escape
the viewport through `ModalOverPins`: z-index alone cannot escape its stacking
context. The temporary host yields keyboard focus to portaled dialogs, menus and
listboxes, including dialogs without `aria-modal`.
<!-- /preserved:e-60b5e834a51616ee -->

<a id="e-5dacbbbd6bbcd5d8"></a>

## An agent link hands its handler the click event too: NodeLink/AgentName call

Original section: Desktop and renderer. Source lines 4665–4672.

<!-- preserved:e-5dacbbbd6bbcd5d8 -->
- **An agent link hands its handler the click event too:** `NodeLink`/`AgentName` call
  `onFocus(id, event)`, and the canvas's `centerOn(id, z, onCanvas)` fits that slot, so a
  surface passing it through whole sent the event as the zoom: a NaN camera, the desk
  closed, the camera never moved and the sticky focus then fought every drag (the
  project desk's tables, user bug 2026-10-19 21:17Z). `centerOn` takes only a finite
  number as `z` and only `true` as `onCanvas`; keep it so, and wrap any other handler
  with a second parameter. [verified: `canvas/OrgCanvas.tsx`, `canvas/identity.tsx`,
  `tests/projectlinkjump.test.tsx`, 2026-10-19]
<!-- /preserved:e-5dacbbbd6bbcd5d8 -->

<a id="e-9446b240e55c6b00"></a>

## Centered modal surfaces dismiss on Escape or backdrop click and do not need a

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5233–5238.

<!-- preserved:e-9446b240e55c6b00 -->
- Centered modal surfaces dismiss on Escape or backdrop click and do not need a
  dedicated close button. Keep decision/action buttons such as confirmation
  Cancel, Save and Apply. Pinned and detached surfaces are windows and retain
  their window controls; do not confuse those with modal close buttons.
  [decided: user 2026-10-19; verified: `canvas/modalpin.tsx`,
  `canvas/tempdesk.tsx`, `tests/modalpin.test.tsx`, `tests/tempdesk.test.tsx`]
<!-- /preserved:e-9446b240e55c6b00 -->

## Settings auto-save (2026-10-24)

Organization settings and both Defaults placements save dirty fields in order via `settingsautosave.tsx`; discrete changes commit immediately, numeric/text input debounces 750 ms, and Close flushes ordinary edits. Failed fields remain retryable with inline errors and returned warnings. Never resend untouched folder grants or charter text. Org charter retains explicit Save with read/truncation/revision guards; blur/close never publish it. Project draft policy is controlled by the owning draft and needs no Save. Live agent/project and service/credential/logo editors retain their existing submission controls. [decided: user 2026-10-24; verified: `App.tsx`, `shell/defaults.tsx`, `canvas/newproject.tsx`]

## The Changelog panel (2026-10-24, 4.4.5)

For 4.5.0, rows emphasize major > minor > patch (USER 2026-10-26
m91a2252773ec, target m0bce503007bb). `data-release-level` selects theme-token
inset edges and 19/17/15 px version text at 800/750/700 weight. Ordinary ink,
selection, timestamps, ordering and navigation retain their existing rules.
The treatment is provisional; prereleases/build metadata provisionally follow
their numeric base version, and unknown formats use patch styling.

`changelog.tsx` has the Presentations panel's shape: the gallery frame, the
`.mailpane` list and reading pane, the row classes and `usePanelSteps`. Rows are
the engine's: version plus release date & time (`fmtStamp` in a row, `fmtFull`
in the pane), newest first. The latest is selected on every opening: the
`opening` request from the menu, the after-update opening and a restored pin.
It is app-wide like Usage history (`useScopedOpen`, pinned per organization,
centred at home). Its header's **Show this every time** is the Presentations
header's checkbox line (`checkline gallery-showretired`, as "Show retired
agents"), switching `ls:orgtree-changelog-after-update` in place: the same
setting as App settings › Display › Startup (`changelog_after_update`). It
replaced a header link to that row (user 2026-10-25 09:09:02Z). Rows are
published releases only. Data and the after-update rule:
[startup and release](startup-and-release.md#the-changelog-and-the-first-launch-after-an-update-2026-10-24-445).
[decided: user 2026-10-24 22:13:55Z–22:17:14Z, 2026-10-25 09:01:38Z, 09:09:02Z;
verified: `changelog.tsx`, `App.tsx`, `shell/menu.tsx`]

## Mention kinds and app or panel mentions (2026-10-27, 4.5.0)

A reference kind lives in one grammar (`canvas/workrefs.tsx` REF_TOKEN_RE and
END), one resolver (`resolveRef`, `KIND_WORD`) and two chip builders that must
match (`RefChip`, refmd `chipEl`); every world that judges tokens declares the
kinds it opens in `handles` (`useRefRoutes` and the docket panel's own world).
Names come from one shared label path, `canvas/refnames.ts`: a kind registers a
bounded reader and a change signal, answers are kept per org and re-read on
that signal with the old answer on screen, and only an answered read makes a
target absent. `@app:`/`@panel:` read the Apps `refs` (`canvas/apprefs.ts`,
re-read on `custom_apps_changed`); `@item:` reads the work-item references for
the item's current title (`canvas/itemrefs.ts`, re-read on the engine's
`docket_changed` frame from `domain/docket.rs` changed(); user 2026-10-27
m7bb9eb904138), and a title never decides an item's outcome. A reader's answer may
carry a `flare` (`RefFlare` {cls, tip}): `itemrefs.ts` the item's status
(`docketstatus.tsx` ticketFlare, the `status-*` palette), `docrefs.ts`
unread/modified from the `?refs=` answer's `at`/`viewed_at` through
`docviewed.ts` docUnread; `resolveRef` copies it onto ready item/doc chips only,
both builders add `ref-flare <cls>` and `refChipTitle` (`<tip> · <title>`), and
`chipSig` includes it. `name(kind, row, org)` may read local state;
`refNames.touch()` re-decides chips with no read (docrefs calls it on every
viewed mark). Clicks go through the Apps rows'
`openAppPanel`, and their hover text and app/panel menus through
`canvas/apps/links.ts`, which the rows use too. Every ready chip except mail
leads with its kind's mark (`canvas/refmarks.tsx`, one element for both
builders; agents and projects keep their identity badge); failed chips keep the
token and verdict with no mark. See [custom apps](../rust-engine/custom-apps.md#mentions-2026-10-27).
[decided: user 2026-10-27 m449dc0a35cbe, m6d0cdc7a2be6, m33e4a043b457; verified:
`canvas/{workrefs,reflinks,refmd,refmarks,apprefs,objectnavhost}.ts*`, `canvas/apps/{links,ui}.ts*`]

App/panel Settings and Delete… context entries use the Apps-list settings route
and its existing deletion confirmation; only confirming sends the revision-
checked delete action. Preserve the pressed link's owner document before the
metadata read, and never add actions to missing or other-org chips.
The app menu's New panel uses panel_open closed:true: it creates a fresh saved
copy off/closed through the agent creation path, without showing or running it.
The Apps-list app row uses that same menu. Tool parity is agent panel_open with app.
[decided: user 2026-10-27 mda7854f1f89b; verified: `canvas/apps/{links,ui,settings}.ts*`]

## Network mention chips (2026-10-27, 4.5.0)

`@net:`/`@org:` chips (`HubContactChip` and refmd `hubChipEl`, one element)
take their kind, icon and hover from `canvas/netmentions.tsx`. The kind is the
hub roster's (`org`, `person`, or `chat`: an agent session), read from the
on-screen org's `tree.net` (fed in `OrgCanvas`); `@org:` is always an org and an
address no roster lists is `unknown`. The icon is the picture, else the
Hubchat mark when `hubchat_pc` says installed, else a globe. Pictures come only
from the engine (`GET /api/orgs/{slug}/net/profile-picture?address=`), never
from renderer URLs: asked once per advertised revision, for the org's own logo
and for local orgs (every two minutes), never for an unlisted address or a
removal. ONE hover, `hubAddressTitle`, serves both chips and the Sender
submenu; an org on this PC keeps `orgTitle`, which its org rows share. The
Markdown chip's signature carries kind, icon and picture revision, so a
picture's arrival rebuilds it. Styles live in `canvas/netmentions.css`
(Hubchat's kind palette, light themes included). Clicks and menus are unchanged.
See [mention pictures](../rust-engine/profile-pictures.md#mention-pictures-450).
[decided: user 2026-10-27 m08fbc691a349, mc96766993067, m82cf84439a0d,
ma1f33944e69d, mf8697b8ba8fc; verified: `canvas/{netmentions,agentmentions,refmd,objectactions}.ts*`]

A party the roster names shows that name instead of its address (user
2026-10-27 mb7ea64d82743 "Show the name"). A `.net-named` chip draws the name
from `data-net-name` in CSS, on the kind's outlined pill; the icon marks the
outside party (m442b6dcaab52 "their link will be distinguished by the icon").
The address stays the chip's only text, out of sight, so `Selection.toString`,
a copy, Reply to selection (`data-ref-token`) and the written token keep the
address. The hover is kind: name, the address, then the click, and the
accessible name `name (address)`. A local org and `@org:` take no roster name.
The Markdown signature carries the name, so a rename rebuilds the chip.
[decided: user 2026-10-27 mb7ea64d82743; verified: `canvas/{netmentions,agentmentions,refmd}.ts*`, `canvas/netmentions.css`]

## Mention menu: every kind, newest first (2026-10-27)

The composer's @ list offers agents, projects, tickets, presentations, apps and
panels, newest first by the latest of mentioned, operated on and presented, and
a kind prefix (`@agent:` `@project:` `@item:` `@doc:` `@app:` `@panel:`) lists
all of one kind. Tickets, presentations, apps and panels come from one bounded
engine read, `GET /api/orgs/{slug}/mention-candidates?kinds&q&after&limit`
(`domain/mention_candidates.rs`, `http/mention_candidates.rs`): ranked, keyset
paged by `[at_ms, lower(label), kind, id]`, at most 50 rows. `at_ms` is in
milliseconds, the precision of every engine time, so the list's own sort agrees
with the pages. The read first runs a bounded catch-up of mail mentions into
`ot.mention_recency` (migration 0076; one cursor, 2,000 messages per read, 200
read again behind it for late commits, `SKIP LOCKED` so readers never queue).
Its first page carries `nodes`, the newest mail mention of each agent or project
name.
- `canvas/mentionsearch.ts` holds the answers: one read per org in flight (the
  latest query waits), answers per org, kinds and text for five seconds, a
  continued page appended, and the nearest shorter query's rows standing in
  (paging nothing) until the exact one arrives. It replaced
  `ticketmentions.ts` and `presentationmentions.ts`.
- `canvas/agentmentions.tsx` `matchMentionQuery` reads a kind prefix (an
  unknown `@word:` opens nothing), and `filterMentionCandidates` ranks:
  transcript mentions first (as before), then `max(at, node mail mention)`, then
  name, kind and id. A tree node's `at` is `nodeActivity` (newest turn, status,
  turn in flight, else creation). The hook draws 60 rows at a time; an
  IntersectionObserver marker at the far end draws more and asks for the next
  engine page, as do the arrow keys near the end.
- The menu ranks with the window's rows: a typed word narrows without
  reordering, and the engine's `q` filter is the same every-word-in-name-or-id
  rule. A row shows a ticket's full title, like a presentation's (USER
  m3eb804e5023a); the slug stays in its tooltip and in what Tab inserts.
- `@project:<org>/<name>` (USER md30a04a62550) parses as a node reference with
  `as: 'project'`; `projectFormPlain` leaves it plain text unless it names a
  live project here (another org's keeps its chip); `refToken` keeps the form.
- Agent parity: composer completion inserts text agents already write; no tool.
- Proofs: `tests/mentionmenu.test.tsx`, `tests/projectform.test.tsx`, native
  `migrate/mention_recency_tests.rs` (rig `proofs/mention-recency.mjs`), and
  `proofs/mention-menu.mjs` (Session 0 window: every kind by one word, then
  `@doc:`).
[decided: user 2026-10-27 m042c82fb0228, mdb3b4aef1062, m35d9b7cf74f6,
m79e889ce1609, md30a04a62550; verified: `canvas/{agentmentions.tsx,mentionsearch.ts,workrefs.tsx,reflinks.tsx,refmd.tsx}`,
`domain/mention_candidates.rs`]
