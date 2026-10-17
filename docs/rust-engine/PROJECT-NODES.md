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

## Description: the project's team charter

A project's description (its `charter` column) is the standing charter of everyone under it
[user 2026-10-17 19:14Z]. The charter cascade an agent's instructions carry (every ancestor's
`team_charter`, root first) takes a project ancestor's description in its place, as "Standing
charter from project <name>: …", so nested projects each add theirs, outermost first. Agents above
the project don't get it. Like a team charter, it reaches a running CLI at its next start.

## Presentations

`orgtree_present project=<name>` stores the document under the project node (presenter recorded
on the document). The project's card shows its documents; the org gallery lists them under the
project's name.

## Docket (slice 2)

User 20:23Z: docket items may attach to a project, and every agent under the project then
co-owns the item with full owner rights.

- Storage: `work_items.extra.project_id` (no migration). The project's name is resolved at read
  time, so it follows a rename.
- Attach/detach: `orgtree_work` create/update `project=<name>`, or `project=""` to detach. It needs
  owner (manage) rights on the item, and to attach an agent must also reach the project. The user
  may attach or detach anything.
- Co-owners: every agent below the project gets manage rights on the item through `level()`. So
  does every agent above it, since control of a project's activities belongs to the agents above
  it too [ruling 2, user 20:40Z]. That covers list, get, update, assign, evidence, participants and
  linked-item visibility, and `event_readable` for watchdog events.
- The named owner stays the owner of record. Item-linked user replies keep going to it
  [user 20:40Z, choice 6].
- Display: `get`/`list` carry `project: {node, co_owners}`. The docket detail shows "Project
  <name> · co-owned by its agents". The project's docket ("Open project docket" in its menu,
  the per-node docket surface) lists its attached items: the page query's `agent` filter
  matches a project's attached items.

## UI (first slice)

- The canvas draws a project as its own dashed card in the tree like any node: a folder mark,
  its name, the first line of its description, the waiting-mail count and its documents. It has
  no desk, model, credit bar or turn controls. A click opens its mailbox.
- **The project hire token** [user 2026-10-16 21:02Z]: every hire strip ends with a light grey
  square with a folder icon, alone on the outermost row. That covers the eye card, all four
  edges of a card and a project's own strip. Its tooltip says "create a project … (free)" and
  it has no seat price. Like an agent token it opens a **draft project card** where the project
  will go and walks the camera to it [user 2026-10-17 19:14Z]: a dashed square with the folder
  mark, a name and a description, create and cancel (Escape and a click away cancel too). Create
  places the project the way a hire is placed: under the card, beside it (create, then the side
  hire's reorder) or above it, holding it (`above`). There is no separate form.
- Menus: agents get "New project here…" on the card and the Agents List row alike, and the eye
  card gets "New project…". Each opens the same draft project card. A project's own menu offers Open (mailbox, folder, presentations),
  Hire under this project, New project here… and Retire project….
- `orgtree_chart` and `orgtree_state_inspect` list projects with `kind: project`. How a project
  should look in the chart and on the docket is still with the user; this is provisional.

## Agent tools

- New `orgtree_project` (team group): `action=create`, `name`, `parent` (default: yourself),
  `index`, `description`.
- `orgtree_message`, `orgtree_inbox` (`project`), `orgtree_present` (`project`),
  `orgtree_watchdog` (`fair_queue`) and the tree tools accept a project as described above.
  Adding a tool changes every agent's tool prefix once (one cold turn after the update).

## Deferred

A docket picker for attaching from the app (the user attaches through an agent or the API for
now); a user composer for project mail; `@org:`/`@net:` mail to
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
