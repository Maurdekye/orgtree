# Project nodes (4.4.0)

Every node in the org hierarchy is an agent, so a project's shared files, mail and documents
always belong to one particular agent. A **project node** is a non-agent node in the tree that
stands for one project: it has its own folder, mailbox and presentations, it runs no turns, and
the agents under it work on it. A new watchdog kind, the **fair project mail queue**
(`fair_queue`), load-balances the project's incoming mail across the agents that watch it.
[decided: user 2026-10-16 16:09Z, 16:11Z, 16:13Z, 16:14Z, 20:21Z, 20:23Z, 2026-10-17 19:14Z; docket
`project-nodes-in-the-org-hierarchy-with-a-fair-p`, whose description is the authoritative scope]

Status: slices 1 and 2 are built (engine, agent tools, canvas, docket), plus draft project cards and
descriptions as team charters (2026-10-17). Sections marked **(deferred)** are not
built yet.

## Data model

- A project is a row in `ot.agents` with `kind = 'project'` (migration 0025; every existing row
  is `kind = 'agent'`). So it shares the tree: unique name in the org, `parent_id`, sibling order,
  `state` (live / archived / deleted), move, reorder, rename, retire, dissolve, delete.
- Columns a project uses: `name`, `parent_id`, `sibling_order`, `state`, `title`, `charter` (its
  description), `grant_credits`, `scratch_dir`. Fixed for a project: `tier = 'project'` (a
  sentinel, never a catalog tier), `seat = 0`, no account, provider, session or turns.
- Scope: a project's stored scope is `{"transparent": true}` and `scope::clamp` passes the
  parent's effective scope straight through such a node. A project never narrows or widens what
  its children may do; they are clamped by the agents above it.
- **Superior** of an agent = its nearest *agent* ancestor (`ot.superior_of(id)`, SQL function in
  0025). A project is transparent for reporting: status notices, "your superior" in the prompt,
  the superior/peer mail rules and the "top-level agent" tests use the nearest agent ancestor.
  Agents under a top-level project are therefore top-level agents (they may write to the user).
  [decided: user 2026-10-16 20:40Z, confirming the implementer's proposal: a node that "takes no
  action" cannot receive reports, so they go to the nearest agent]

## It runs no turns

The actor refuses to start for a project (`runtime::actor::spawn` reads `kind` first), so no
CLI, warming, turn, checkup, reminder, freeze or session placement can happen to one, whatever
path asked for it. The sweeps that pick agents (warming, restart notices, waiting-mail recovery,
reminders, checkups, sign-in notices, org-inbox fallback) also filter `kind = 'agent'`.

## Cost

A project is free and transparent in the credit hierarchy, as though it were not there: every
credit cost of the agents under it goes to the nearest agent above the project [user 16:11Z;
user 20:40Z, replacing the first draft's "the project's grant funds its children"]. It has no
seat and no allocation of its own. Mechanically its `grant_credits` is a mirror that always
equals the stake of its live children (`projects::settle_credits`, run at the end of every tree
operation), so the agent above holds those stakes, cascades raise the agent above, and a
project's free credits are always zero. An agent below a project cannot fund a hire under it
(that would draw on the agent above); the user's top-level cap applies to each agent under a
top-level project, never to the project's mirror. A project cannot be given credits
(`reallocate` refuses).

## Reach and control

**Reach** (user 16:11Z): the user, every agent above the project and every agent below it.
Agents outside that line cannot reach it. With reach an agent may:

- send mail to the project, and inspect its waiting mail (`orgtree_inbox` with `project`);
- watch it with a `fair_queue` watchdog;
- present a document under it (`orgtree_present` with `project`);
- read and write its folder;
- act on the project node as on a subordinate: rename, reorder, retire, dissolve or move it,
  create a nested project in it; hire under it or move its own reports into it when the credits
  come from its own allocation (see Cost: only an agent above the project can pay).

**Creating one**: `create_project` (agents: `orgtree_project`). The parent defaults to the
caller; agents must give `index`; only the user creates at the top level; an agent creates one
only under itself, its reports or a project it is inside. `above=<node>` (the canvas's top-edge
token) puts the project in that node's slot and moves the node, with its team, under it. It
needs a superior hire's insertion authority. Scope and credits do not change because the
project is transparent.

Control means control over the **project node and its activities**, not over the other agents
inside it: an agent in a project cannot retire its sibling. An agent cannot retire or dissolve a
project that contains itself (that would archive the caller mid-turn); its superiors can.
[decided: user 2026-10-16 20:40Z, confirming the implementer's choices 1–4 and 6]

## Mailbox

- Mail to a project is an `ot.mail` row addressed to the project (`recipient_agent_id`), state
  `pending`. Nothing wakes for it.
- **Inspection** (user 16:14Z): `orgtree_inbox action=list|fetch project=<name>` shows the
  project's waiting (unread) mail without claiming it.
- Claiming happens only through fair-queue delivery.

## The fair project mail queue (`kind: fair_queue`)

`orgtree_watchdog create kind=fair_queue target=<project>`: the owner must reach the project;
`fire_mode` is `event`; no pattern; `once` and `notice` work as for other kinds.

Delivery (per project; one mail per short transaction, serialized by a `FOR NO KEY UPDATE` on
the project row, never a global lock):

1. Take the project's oldest waiting mail.
2. Pick one watcher among the project's **armed** `fair_queue` dogs whose owner is live and
   still reaches the project: least recently woken first (`last_fired` ascending, never-woken
   first), ties to the oldest watcher (`created_at`, then row id) [coordinator choice, user
   16:13Z delegated it]. Busy, halted or frozen owners stay eligible: the mail waits in their
   mailbox until they can run [user 16:13Z].
3. The project's copy is marked read and records who claimed it; the watcher receives the mail
   itself, from its original sender, as ordinary mail (so replies go to the sender), marked
   "via project <name>". The dog's `fired`/`last_fired` advance (a one-shot dog is spent). The
   watcher is woken unless its dog is a `notice` dog.

Runs when mail lands, when a `fair_queue` dog is armed (create, resume, rehire) and at engine
start. With no eligible watcher the mail waits in the project mailbox (shown on the card and to
inspection) until one arms; the backlog goes to the first watcher that arms [decided: user
2026-10-16 20:40Z].

## Folder and AGENTS.md

A project's folder is its team workspace, `<data>\scratch\<org>\_teams\<project id>` (also its
`scratch_dir`). Every agent below the project holds it and gets its `AGENTS.md` at session start
exactly as a team's [user 16:11Z], labelled as the project's. Every agent above it holds the
folders of the live projects in its subtree too (no `AGENTS.md` delivery).

## Summary: the project's team charter

A project's Summary (`description` in tools/API, its `charter` column) is the standing charter of everyone under it
[user 2026-10-17 19:14Z]. The charter cascade an agent's instructions carry (every ancestor's
`team_charter`, root first) takes a project ancestor's Summary in its place, as "Standing
charter from project <name>: …", so nested projects each add theirs, outermost first. Agents above
the project don't get it. Like a team charter, it reaches a running CLI at its next start.

## Presentations

`orgtree_present project=<name>` stores the document under the project node (presenter recorded
on the document). The project's card shows its documents; the org gallery lists them under the
project's name.

On a project desk, a presentation card's context menu can stage a typed document reply in the
project composer. A normal project message or broadcast then carries that document target; a
presentation reader also offers the project broadcast toggle and Alt+B shortcut. Broadcast
target references are resolved for each recipient before fan-out, preserving recipient-scoped
mail and transcript access checks.

## Docket

User 2026-10-17 22:21Z, superseding the 2026-10-16 20:23Z ruling that items may attach to a
project: "just have a 'project docket' that can be viewed which shows all tickets assigned to
agents under the project".

- Items no longer attach to projects and nobody co-owns an item through a project. `orgtree_work`
  create/update refuse a `project` argument with a plain explanation.
- A project's docket (the desk's docket tab, "Open project docket" in its menu) lists every item
  OWNED by an agent under the project, through nested projects: the page query's `agent=<project>`
  reads as the team view rooted at the project, and the renderer uses `teamItems`.
- Migration `0029_project_items_detach` moves any `extra.project_id` to `extra.former_project_id`,
  a plain record with no rights attached. The item keeps its owner, history and every other field,
  so nothing is lost; an item whose owner sits under the project still shows on its docket.

## UI (first slice)

- The canvas draws a project as its own dashed card in the tree like any node: a folder mark,
  its name, the first line of its description and its documents (no "project" label; its
  mailbox button with the waiting-mail count shows only with Show agent card shortcuts on, like
  an agent card's hover row [user 2026-10-17 19:37Z]). It has
  no model, credit bar or turn controls.
- **Card look** [user 2026-10-17 21:20Z, 21:21Z]: zoomed out, the card is its large folder, with no
  tier/provider stripe; at middle zoom its meta row carries `ProjectActivity`, the app header's
  activity chip (spinner while any agent under it works, then active/hired). The app header's own
  count (`liveCounts`) skips project nodes.
- **Neighbour lines** [user 2026-10-17 21:23Z]: `peerLinkPairs` joins consecutive AGENT siblings
  only, so a project at a row's end has no neighbour segment and agents on either side of a project
  are joined by one line running past it; message sparks follow the same lines.
- **Last activity** [user 2026-10-17 22:21Z]: "active now" while any live agent under the project
  runs a turn, else "quiet for <age>" of the newest turn end under it (nested included), on the
  desk header and on the middle-zoom card beside the activity chip; none if nobody ever ran one.
- **Hover row** [user 2026-10-17 22:21Z]: with Show agent card shortcuts on, the card shows the
  agent card's docket, mailbox (waiting count) and presented (the project's own document count)
  buttons. Like an agent card's, the buttons show while the card is hovered; a waiting count keeps
  the mailbox showing. The quiet age shares the state word's font; an idle activity chip keeps no
  spinner slot (coordinator visual review 2026-10-17 23:25Z).
- **Team presentations** [user 2026-10-17 22:47Z; 2026-10-18 07:19Z–07:22Z]: the agent menu's
  `Open → Presentations → Team presentations` (offered unconditionally alongside `Presentations`
  whenever handlers are supplied; inline as `Team presentations` if `onPresentations` is omitted)
  opens the agent gallery in team scope: `GET documents?node=<agent>&team=1`
  lists the agent's documents and every descendant's, recursing through projects (`subtree_members`
  in `http/docs.rs`), paged, counted and located like the agent gallery. A team gallery skips the
  client's `node === nid` row filter. Its window keeps the scope when pinned, popped out, restored
  or raised (`WindowRestore.team`, `restoredAgentGallery`); asking for the same agent in the other
  scope switches the window over.
- **Project presentations vs team presentations** [user 2026-10-17 23:28Z, point 27, replacing
  point 8's subtree-wide Presented tab; 2026-10-18 07:20Z–07:22Z]: a project's PRESENTATIONS are
  the documents attributed to it (`orgtree_present project=` by any agent above or below it):
  `node=<project>` lists only those, and the desk's presented tab, its count, the hover presented
  button and `Open → Presentations` show them. Its TEAM presentations (`team=1`, menu
  `Open → Presentations → Team presentations`) add every document by the agents in its subtree;
  both menu options are offered whenever their handlers are supplied. The presentation chips on
  the card and desk header keep showing own + subtree (the 22:47:29Z ruling).
- **Presenter on every row** [user 2026-10-17 22:47:51Z]: list rows carry `presented_by` (the
  agent that presented it, the node for older rows) and `presenter_tier`; the gallery rows and the
  reader show that agent, so a document presented under a project names its author. In the list
  rows the presenter is an agent link (`AgentName`): a click focuses that agent and leaves the row
  selection alone (review of a590555).
- **Project presentation chips** [user 2026-10-17 22:47:29Z]: the project card and the desk header
  carry chips for the project's own documents and its subtree's, newest first (`subtreeDocs`).
- **Fair-queue watcher lines** [user 2026-10-17 22:48Z]: every armed or paused `fair_queue` dog
  draws a line from its owner to the project it serves (`fairQueueLinks` in `canvas/shared.ts`,
  matched by the dog's target name, which a rename moves). The line has its own colour token
  `--fq-line` (rose, deepened in the light themes, used by nothing else); a paused dog's line is
  dashed and dimmed. It bows out past both cards' right sides so it never lies on a tree edge.
- **Menus** [user 2026-10-17 22:23Z, 23:28Z, 23:29:47Z; 2026-10-18 07:17Z–07:28Z] take every
  agent/switchboard entry that applies: `Copy mention` (copies `@<project>`); `Focus`;
  `Open > Desk` (the project desk as a temporary modal, `ProjectDeskModal`), `Pop out to new
  window` (that modal popped out, `requestSurfaceAction('project-desk', …)`), `Pin desk as a
  window` / `Show pinned window` (in the top `desk` section before the separator, matching agents),
  `Project mailbox`, `Project folder`, `Presentations > Team presentations`, `Project docket`;
  `Hire under this project` and `New project…` (hiring beside or above a project uses the card's
  hire tokens [user 2026-10-18 07:17Z]); `Settings`; `Cheap-compact all agents under it…`;
  `Halt/Unhalt all agents under it…`; `Retire project…`. Card and Agents List row offer the same
  menu. Left out: model, account and continue-on entries, credits, team scratch folder and team
  docket (the project folder and docket already are the team's), retire-all-subordinates. Rename
  and move/reorder are not menu entries because the agent menu has none either: rename is in
  Settings, move and reorder are drags.
- **Desk jump cards pass through projects** [user 2026-10-17 22:13Z]: an agent desk's up row has its
  nearest agent superior and every project between them (superior first, then outermost to
  innermost; `upJumpTargets`); its down row lists each report and, for a project, its live members,
    recursing through nested projects (`downJumpTargets`). Folding of long rows still applies.
  - **Project desk collapse parity** [user 2026-10-18 14:45Z]: project member rows
    use the same `DeskJumpCards` as agent report/watchdog rows: more than 16 cards
    start collapsed behind the counted button, with the shared Display preference
    and expand/collapse controls. Canvas, pinned, popped-out and Attention project
    desks all use `ProjectDesk`; their parent jump remains separate.
- **Hires around a project** [user 2026-10-17 21:24:34Z]: a project card has an agent card's four
  strips: under it, a coworker to either side (a sibling, then the side hire's reorder) and a parent
  above it (a superior spliced in with `above`, holding the project). The token tooltips say
  "(free, structural)" (21:24:27Z).
- **The project token** [user 2026-10-17 21:23:44Z] wears the project card's theme colours
  (background, dashed border, accent folder) instead of the earlier light grey.
- **The project desk** [user 2026-10-17 19:38Z–20:10Z]: a click, or zooming in, walks the
  camera to the project and opens its desk (`canvas/projectdesk.tsx`) in the agent desk's frame
  and header; a click never opens a modal (20:04Z). No chat: a project takes no turns. It pins as
  a window like an agent desk.
  - Tabs: **desk**, then the agent desk's three: **inbox** (its mailbox), **docket** (items
    owned by agents under it) and **presented** (documents presented under it with `orgtree_present
    project=`; the subtree's are its team presentations, point 27).
    An agent's own gallery is unchanged.
  - A project mail's list row (in its inbox, and in the Sent folder of whoever mailed the
    project) takes three lines: sender and time; its kind chip and queue state (`→ @recipient`,
    awaiting ack, acked, released, ack of, dead letter, purged); the preview. In the project's
    own mailbox a mail nobody holds yet puts its kind chip on that middle line too. Nothing in
    it wraps: the recipient yields with an ellipsis [user 2026-10-18 14:24Z].
  - The desk tab holds the chat desk's jump cards (up to the parent, down to its live members)
    and the Summary editor: Markdown (`md`) while unfocused, a monospace text box while
    focused. Leaving the box saves a change with `set_description`; Escape drops it.
  - Header: active/hired agents under it (live agents, nested projects crossed, project nodes
    not counted; active = a turn executing, the org list's rule) with the spinner while any is
    active; halt all / unhalt all (the agent batch-halt confirmation); dissolve (the
    agent dissolve confirmation; retire when nobody is under it); restore when retired; pin; the
    settings gear.
- **Dissolving a project** is the agent `dissolve`: the project and every agent under it are
  archived with context kept, fair_queue and other dogs of the archived agents pause, and each
  comes back with rehire (a restored project comes back alone, its agents stay retired until
  rehired). Its folder, mailbox (waiting mail stays) and presentations are untouched; docket
  items stay with their owners.
- **Project settings** (`ProjectConfig`, 20:10Z): Open project folder, Name (rename), Project
  actions (retire or dissolve, restore, delete permanently), Summary, Subordinates may
  message each other, and History when the node has records. Left out as turn- or credit-only:
  model, effort, account, rescind, credit grant, visible agents, file and command access,
  tools/MCP and turn limits.
- **`set_description`** (op; `orgtree_project action=describe` for agents) replaces a project's
  Summary. It is authorized like rename (the user, agents above or below the project) and
  reconfigures the subtree.
- **The project hire token** [user 2026-10-16 21:02Z]: every hire strip ends with a (since 21:23:44Z theme-coloured)
  square with a folder icon, alone on the outermost row. That covers the eye card, all four
  edges of a card and a project's own strip. Its tooltip says "create a project … (free)" and
  it has no seat price. Like an agent token it opens a **draft project card** where the project
  will go and walks the camera to it [user 2026-10-17 19:14Z]: a dashed square with the folder
  mark, a name and a Summary, create and cancel (Escape and a click away cancel too). Create
  places the project the way a hire is placed: under the card, beside it (create, then the side
  hire's reorder) or above it, holding it (`above`). Spaces in the typed name become hyphens,
  as in a hire (`normalizeUserEnteredName`). There is no separate form.
- Menus: agents get "New project…" on the card and the Agents List row alike, and the eye
  card gets "New project…". Each opens the same draft project card. A project's own menu offers Open (mailbox, folder, presentations),
  Hire under this project, New project… and Retire project….
- `orgtree_chart` and `orgtree_state_inspect` list projects with `kind: project`. How a project
  should look in the chart and on the docket is still with the user; this is provisional.

## Agent tools

- New `orgtree_project` (team group): `action=create`, `name`, `parent` (default: yourself),
  `index`, `description`.
- `orgtree_message`, `orgtree_inbox` (`project`), `orgtree_present` (`project`),
  `orgtree_watchdog` (`fair_queue`) and the tree tools accept a project as described above.
  Adding a tool changes every agent's tool prefix once (one cold turn after the update).

## Deferred

A user composer for project mail; `@org:`/`@net:` mail to
projects; undo-history entries for project operations; renaming a project or editing its
description from the canvas (agents can `orgtree_rename` it); project-aware Quick chat and hire
sheets; chart/docket visuals pending the user's answer.

## Tests

- Rust unit tests: `clamp` transparency (`scope`), the watcher ranking and round robin
  (`projects`), the project tree body (`tree`).
- Rig proof `tools/rig/proofs/project-nodes.mjs` (41 checks; debug engine, fake CLI, scratch
  DB). It covers:
  - creating a project and its fields, and that it gets no turns;
  - mail waiting with no watcher, inspection without claiming, the backlog going to the first
    watcher, round robin, and a halted watcher keeping its turn;
  - transparent credits and the refused hire from below;
  - present under a project;
  - the superior, the project's AGENTS.md and PROJECTS BELOW YOU in prompts, status notices
    and the mail rules through a project;
  - retire, rename and agent-only refusals;
  - wrapping a node with `above`.
- Renderer: `tests/projecttoken.test.tsx` (the hire token) and `tests/projectnode.test.tsx`
  (the form, the card, the menus). Both are red at base 88e029a.
