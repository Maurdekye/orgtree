# Project nodes (4.4.0)

Every node in the org hierarchy is an agent, so a project's shared files, mail and documents
always belong to one particular agent. A **project node** is a non-agent node in the tree that
stands for one project: it has its own folder, mailbox and presentations, it runs no turns, and
the agents under it work on it. A new watchdog kind, the **fair project mail queue**
(`fair_queue`), load-balances the project's incoming mail across the agents that watch it.
[decided: user 2026-10-16 16:09Z, 16:11Z, 16:13Z, 16:14Z, 20:21Z, 20:23Z; docket
`project-nodes-in-the-org-hierarchy-with-a-fair-p`, whose description is the authoritative scope]

Status: design plus first slice. Sections marked **(deferred)** are not built yet.

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
  *(Implementer's interpretation: the description does not say whom a project's children report
  to. A node that "takes no action" cannot receive reports, so they go to the nearest agent.)*

## It runs no turns

The actor refuses to start for a project (`runtime::actor::spawn` reads `kind` first), so no
CLI, warming, turn, checkup, reminder, freeze or session placement can happen to one, whatever
path asked for it. The sweeps that pick agents (warming, restart notices, waiting-mail recovery,
reminders, checkups, sign-in notices, org-inbox fallback) also filter `kind = 'agent'`.

## Cost

A project is free: seat 0, nothing for the project itself [user 16:11Z]. Its grant holds the
credits of the agents under it, exactly like a manager's grant; cascades raise it as usual. An
agent below the project that hires under it draws only on the project's free credits.

## Reach and control

**Reach** (user 16:11Z): the user, every agent above the project and every agent below it.
Agents outside that line cannot reach it. With reach an agent may:

- send mail to the project, and inspect its waiting mail (`orgtree_inbox` with `project`);
- watch it with a `fair_queue` watchdog;
- present a document under it (`orgtree_present` with `project`);
- read and write its folder;
- act on the project node as on a subordinate: hire under it, move its own reports into it,
  rename, reorder, retire, dissolve or move it (agents above), create a nested project in it.

*(Interpretation choices, flagged for the user:)* control means control over the **project
node and its activities**, not over the other agents inside it: an agent in a project cannot
retire its sibling. An agent cannot retire or dissolve a project that contains itself (that
would archive the caller mid-turn); its superiors can.

## Mailbox

- Mail to a project is an `ot.mail` row addressed to the project (`recipient_agent_id`), state
  `pending`. Nothing wakes for it.
- **Inspection** (user 16:14Z): `orgtree_inbox action=list|fetch|conversation project=<name>`
  shows the project's waiting (unread) mail without claiming it.
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
inspection) until one arms. *(Interpretation: the backlog goes to the first watcher that arms.)*

## Folder and AGENTS.md

A project's folder is its team workspace, `<data>\scratch\<org>\_teams\<project id>` (also its
`scratch_dir`). Every agent below the project holds it and gets its `AGENTS.md` at session start
exactly as a team's [user 16:11Z], labelled as the project's. Every agent above it holds the
folders of the live projects in its subtree too (no `AGENTS.md` delivery).

## Presentations

`orgtree_present project=<name>` stores the document under the project node (presenter recorded
on the document). The project's card shows its documents; the org gallery lists them under the
project's name.

## Docket **(deferred to slice 2)**

User 20:23Z: docket items may attach to a project, and every agent under the project then
co-owns the item with full owner rights. Plan: `work_items.project_agent_id`; attach/detach by
anyone with owner rights on the item who reaches the project; co-owner = any agent below the
project; the assigned owner stays the one owner of record and user replies keep routing to it;
the item shows "project <name> · co-owned by its agents" and appears in each co-owner's list.

## UI (first slice)

- The canvas draws a project as its own card (project mark, name, description line, waiting
  mail count, documents) in the tree like any node; no desk, no model, no turn controls.
- Menus: New project (on agents, projects and the top level), Hire under, Presentations, Open
  scratch folder, Rename, Retire.
- `orgtree_chart` and `orgtree_state_inspect` list projects with `kind: project`. How a project
  should look in the chart and on the docket is still with the user; this is provisional.

## Agent tools

- New `orgtree_project` (team group): `action=create`, `name`, `parent` (default: yourself),
  `index`, `description`.
- `orgtree_message`, `orgtree_inbox` (`project`), `orgtree_present` (`project`),
  `orgtree_watchdog` (`fair_queue`) and the tree tools accept a project as described above.
  Adding a tool changes every agent's tool prefix once (one cold turn after the update).

## Deferred

Docket attach/co-ownership (slice 2); a user composer for project mail; `@org:`/`@net:` mail to
projects; undo-history entries for project operations; project-aware Quick chat and hire
sheets; chart/docket visuals pending the user's answer.

## Test plan

- Rust unit tests: `clamp` transparency, the watcher ranking, project tree bodies, project team
  labels, `fair_queue` argument validation.
- Rig proof `tools/rig/proofs/project-nodes.mjs`: create a project, hire under it, mail it with
  no watcher (waits; inspection shows it unclaimed), two watchers alternate least-recently-woken
  first, a halted watcher still receives, present under the project, the child's prompt carries
  the project's AGENTS.md, a project never gets an actor.
