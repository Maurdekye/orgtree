# Panel activation

User rulings: 2026-10-18 12:09Z and 16:42Z, docket
`opening-an-already-popped-out-panel-inbox-docket` (4.4.0).

Opening an already detached panel reveals the same window. `windowlife` looks
up a live surface by kind and organization; a desk tab also requires the current
node and generation. `revealSurface` resolves the owning surface, whose existing
native `focusPopout` path restores a minimized window, shows it and focuses it.
No second window is created and the retained DOM, drafts and reader state stay
with the original surface. Closed registrations do not absorb an open action.

`revealOpenPanel` also handles mounted pins, using the existing modal store and
shared pin layer. A saved rectangle alone is not an open panel. Desk tabs leave
another node's pin alone and select their normal inline view when no matching
panel is available. Menus, explicit tab activation and pin/pop-out ensure-open requests
keep pins open. Their own close and unpin controls retain their meanings.

The 16:42Z ruling supersedes always-raise for panel buttons: the same button
hides its already open local pin, including a pin behind another panel. The next
click reopens at the saved rectangle. `toggleOrRaiseModal` applies this to the
global Inbox, Docket, Presentations, Usage, Usage history and Settings buttons;
Agents list and the org inbox use it too. App settings and defaults already
toggle their pins. `toggleNodePanel` shares that decision for node Inbox, Team,
Docket, Presentations, Settings, lineage and watchdog buttons, per target since
2026-10-20 (below): another target opens its own window; an ensure-open request
never toggles it off. Detached windows retain their existing restore/show/focus
activation path.

Shell and node menus and panel-corner routes pass ensure-open explicitly;
header and card shortcut buttons retain the toggle rule.

## Several instances of one kind (2026-10-20)

User 17:24:20Z, defaults approved by the coordinator 18:58:51Z, readers
19:03:28Z and 19:05:36Z (DECISIONS 92). Every per-target surface is stored as
`kind:target` (`modalkinds.ts` `instanceKind`): the modal pin, the open marker,
the window row, the pin/pop request channel and the pin layer, so each target
has its own placement and pin/pop state. Desks (`desk:[org,id,gen]`) and
documents already had this shape. The canvas keeps the open targets of each
kind in `useModalInstances` (`canvas/modalinstances.ts`), which replaced the
single id and `toggleNodePanel` for these kinds:

- the same target: reveal its window or raise its pin; without ensure-open the
  node's own button hides its own open pin
- a new target: pinned and popped-out siblings stay; a centred one closes (one
  centred instance per kind); then `placeNewInstance` pins it at its own saved
  rect, else at the kind's template (`orgtree-modal-templates`: set by a pin,
  drag or resize, cleared by an unpin) cascaded 28 px past the open siblings
  (`cascadeRect`, wrapping to the canvas's top left), else leaves it centred;
  the panel-corner pin and pop-out routes pass `place: false` and place the
  window at the tab themselves
- `pruneClosed` keeps the newest 20 placements of closed instances per kind per
  org; open ones are never dropped
- `renameModalInstances` and `renameWindowRows` carry a renamed node's records

Readers (`canvas/readers.ts`): App's Presented documents is the global reader;
the canvas keeps `agent-gallery:<id>` and `team-gallery:<id>` (one centred
reader across both). Each mounted reader registers its scope, the document it
shows and a `show(doc)`; `openDocView` asks `pickReader` first: a reader
already showing the document, then its own node's agent reader, then the team
readers from its node upwards, then the global reader, ties by scope name.
Otherwise its own agent/project reader opens on it; a document the tree does
not list is fetched first (`DocOpening`) to learn its node.

Migration is one-off, on first read of each store: a single pin and its open
marker move to the target the marker names (the pin also becomes the kind's
template; a pin with no marker is only the template), window rows move to
their restore target, the team docket joins the agent docket and a team
gallery record becomes the team reader. The canvas and docket readers' old
records reopen through `openDocView` and are closed.

Focused renderer evidence uses synthetic windows and real desk/menu/movable
surface components. It verifies registry routing, exact native focus command,
single window creation, retained DOM/draft, identity guards and shared pin
stacking. It does not claim an OS foreground-window observation. The native
restore/show/focus implementation is reused without changes.
