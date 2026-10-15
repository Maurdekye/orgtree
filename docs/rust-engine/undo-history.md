# Persistent undo history — engine contract

Docket: `persistent-undo-history-undo-several-move-hire-r` (renderer and proofs:
ordering-sol); engine foundation `undo-history-engine-foundation-durable-journal-a`
(openrouter-keys-opus). Design input: ordering-sol's packet
`D:/orgtree-work/ordering-sol/undo-history-design.md`.

Status: **contract v1.1, 2026-10-14** (implemented; v1.1 answered the renderer's
questions: step back-references, duplicate results, 100 steps, and the route
rename forced by the existing `/history` browser). The renderer builds against
this document. A change to anything below is announced to the renderer owner
before it lands.

## Rulings this implements

- User 2026-10-14 18:27Z / 18:28Z: a persistent undo buffer for the user's own
  **move, hire, retire and retool** actions; durable per org across restarts;
  redo (Ctrl+Y, Ctrl+Shift+Z / Cmd+Shift+Z); a new action clears redo; redo
  uses the same conflict rules; undoing a hire whose agent has taken a turn asks
  first, one that never ran is retired without asking.
- Coordinator 2026-10-14 18:34Z: bound 100 entries per org, a typed allowlist,
  no secrets, **refuse-then-older**, precise guards.
- Agents' own tool actions never enter the user's history, **except autonomous
  Logo edits** (user 2026-10-15 22:07Z: immediate, logged and undoable).

## Model

Two tables (migration `0023_undo_history`): `ot.undo_heads` (one row per org:
the history lock and the feed revision `rev`) and `ot.undo_entries`, per org:

| column | meaning |
|---|---|
| `id` | entry id (monotonic, the identity the UI targets) |
| `org_id` | the org (history never crosses orgs) |
| `kind` | `move` \| `hire` \| `retire` \| `retool` \| `logo` |
| `state` | `done` (undoable) \| `undone` (redoable) \| `refused` (left behind, with its reason) |
| `label` | a short UI label, at most 120 characters |
| `request_id` | the caller's idempotence key, unique per org when given |
| `data` | typed, allowlisted before/after facts (below); never sent to a window |
| `reason` | why it was refused (`state = refused` only) |
| `created_at`, `changed_at` | timestamps |

- **Bound: 100 entries per org**, all states counted. Recording a new entry
  deletes the oldest beyond 100 in the same transaction.
- **Undo target:** the newest entry (highest `id`) in state `done`.
- **Redo target:** the `undone` entry with the lowest `id`, i.e. the most
  recently undone, since undo walks from new to old.
- **A new recorded action clears redo:** every `undone` entry of the org is
  deleted in the recording transaction.
- **Refuse-then-older:** an undo or redo that meets a conflict marks that entry
  `refused`, with its reason, and changes nothing else. The next undo targets
  the next older `done` entry; a refused redo leaves the next redo target to
  the following `undone` entry. A refused entry is never retried
  automatically, and no older inverse runs in the same keypress.
- Undo and redo never create entries of their own and never clear redo
  (except as described above).

## What is recorded

Only **explicit user UI actions** (the HTTP routes below, `Actor::User`) and
the specifically authorized `orgtree_org_logo` agent tool record. Other agent
tools, request approvals, retries, no-ops (`unchanged`, "already
archived", "already live") and undo/redo replays never record.

| kind | user operations it covers |
|---|---|
| `move` | `move`, `moves`, `reorder` (reparent and sibling position, single or grouped) |
| `hire` | `hire` (including `hire_type` superior/side), alone or with the placement steps of the same gesture (`reorder`/`move` of the new or anchor agent) |
| `retire` | `retire` (a seat with live reports takes its whole live subtree) |
| `retool` | `retool`, `switch_model`, `account`, and the settings scope Save (`scope` step below): model, effort, model version, account, folders, tools, visibility, permission mode, account fallback, auto cheap-compact, charter, team charter |

Out of scope (never recorded, never undone): rename, reallocate, rehire from
the archive pile, dissolve, rescind, delete, swap, self-subjugation, cheap
compact, org settings other than the agent Logo exception, chat.

### Logo history

User 2026-10-15 22:07Z made autonomous Logo set/remove changes immediate,
logged and undoable. Migration `0024_logo_undo` extends the kind constraint.
The `orgtree_org_logo` tool atomically records kind `logo`, agent id, created
time and `Set/Remove Logo: <agent>` label alongside the picture write. Its
typed internal data is `{agent: <numeric id>, generation: <number>, before: <normalized record or
null>, after: <normalized record>}`. Records are bounded stripped PNGs (≤256
KiB image bytes), not original inputs. No source path, credentials or image
bytes appear in history responses, feeds or logs. The usual 100-entry bound,
redo clearing and org isolation apply.

Undo/redo guards the exact current picture against the snapshot the entry
left. A later independent UI, agent or remote edit conflicts and leaves that
newer picture untouched; the entry is refused under normal refuse-then-older
rules. A successful inverse restores the desired normalized image (or a
versioned removal for initial absence) with a **fresh greater revision**, then
notifies/kicks the same publisher as the human editor. It updates only the
revision field of other done/undone Logo snapshots that reference the exact
restored revision, so several consecutive undos/redos remain usable without
mistaking a history restoration for an independent later edit. There is no
agent tool to undo history; the user's existing history/shortcuts do it.

Source and pending verification: [profile pictures](profile-pictures.md#autonomous-logo-tool-431).

### One gesture is one entry

1. **Single operation:** the existing user routes `POST /api/orgs/{slug}/ops`,
   `POST /api/orgs/{slug}/nodes/{nid}/reorder`, `POST /api/orgs/{slug}/nodes/{nid}/account`
   and `POST /api/orgs/{slug}/nodes/{nid}/scope` record one entry per
   successful, non-no-op request of a covered op. Each also accepts the
   optional `history_label` (≤ 120 chars) and `request_id` (≤ 64 chars). A
   single request runs exactly as a one-step gesture (below), so these routes
   now run in one serializable transaction, retried on a serialization
   conflict as `/ops` always was. A move that leaves an agent with the same
   parent, live neighbours and state (a reorder onto its own place) is a no-op.
2. **Several requests in one gesture** (settings Save; side or superior hire
   plus its placement; a multi-member pile reorder) use the new gesture route,
   which runs every step in **one transaction** and records **one entry**:

```http
POST /api/orgs/{slug}/gesture
{ "label": "Settings: alice",           // optional, ≤ 120 chars; else the engine names it
  "request_id": "6f1c…",                // optional, ≤ 64 chars
  "steps": [ { "op": "switch_model", "node": "alice", "tier": "sonnet" },
             { "op": "account", "node": "alice", "account": "claude-5" },
             { "op": "scope", "node": "alice", "effort": "high", "tools": {"web": true} } ] }
```

- `steps`: 1–100 items (more: **400 `gesture_too_large`**). Each item is an ordinary op request; `op` is one of
  `move`, `moves`, `reorder`, `hire`, `retire`, `retool`, `switch_model`,
  `account`, `scope`. `scope` takes the same body as
  `POST /api/orgs/{slug}/nodes/{nid}/scope` plus `node`; `account` the same
  body as `POST /api/orgs/{slug}/nodes/{nid}/account` plus `node`.
- **Back-references** (v1.1): a string value that is exactly `"$<i>.node"`,
  where `i` is an EARLIER step's zero-based index, is replaced by that step's
  answered `node` before the step runs, in the fields `node`, `target`,
  `parent`, `new_parent`, `above`, `before`, `after` and `moves[].node` /
  `moves[].new_parent`. A reference to the step itself or a later one, any
  other `$…` form, or a step that answered no `node`: **400 `gesture_ref`**.
  Example (a side hire placed first): `[{"op":"hire","name":"dana","parent":"bob","tier":"sonnet"},
  {"op":"reorder","node":"$0.node","index":0}]`. A superior hire needs no
  extra step: the `hire` op itself moves its `above` anchor.
- Every step runs through the same code and permission checks as its own
  route, in order, in one serializable transaction; effects are published only
  after commit. Any step refusing refuses the whole gesture (nothing applied).
- The gesture's kind: `hire` when a step is `hire`; `retire` when a step is
  `retire`; else `move` when every step is `move`/`moves`/`reorder`; else
  `retool` when every step is `retool`/`switch_model`/`account`/`scope`.
  A `hire` gesture may hold only `hire`, `move`, `moves` and `reorder` steps,
  a `retire` gesture only `retire` steps. Any other mix is refused **400
  `gesture_mixed`**, and an op outside the list **400 `gesture_op`**; both
  before anything runs.
- Answer: `{ "results": [ <each step's own answer> ], "history_entry": {…} }`.

Every recording answer (single op or gesture) carries
`"history_entry": { "id": 41, "kind": "move", "label": "Move alice under bob" }`.
A request whose `request_id` this org already recorded is **not applied
again**: the answer is `{ "duplicate": true, "history_entry": {…}, "results": [ { "node": … } ] }`
(200): one item per original step, `node` the CURRENT name of the agent that
step touched (followed by numeric id, so a later rename shows), or null. The
original step answers are not replayed. A request id is remembered as long as
its entry is (the bound prunes it, and a new action deletes an undone one).
A refused request (any step refusing) records nothing, so it may be retried
with the same id.

## Endpoints

All history endpoints are user routes (the windows); there is no MCP tool to
step history. The Logo tool is the single agent recording exception above.

**Route rename (v1.1):** `/api/orgs/{slug}/history` and `/history/{section}`
are the existing Settings › History browser, so the undo routes live under
`/undo-history`.

### `GET /api/orgs/{slug}/undo-history`

```json
{ "bound": 100,
  "undo": { "id": 41, "kind": "hire", "label": "Hire alice", "at": "2026-10-14T18:40:00Z",
            "confirm_required": true },
  "redo": null,
  "entries": [ { "id": 41, "kind": "hire", "label": "Hire alice", "state": "done", "at": "…" },
               { "id": 39, "kind": "move", "label": "Move bob under carol", "state": "refused",
                 "at": "…", "reason": "bob was moved again since" } ] }
```

`entries`: newest first, at most `bound`. `confirm_required` (undo target
only) says the target is a hire whose agent has started at least one turn.
No before/after values, charter text, scope payloads or account records are
ever in a response.

### `POST /api/orgs/{slug}/undo-history/undo` and `/undo-history/redo`

Body: `{ "id": 41, "confirm": "<token>" }`; `id` is required (the entry the
window shows), `confirm` only for a confirmed hire undo.

| answer | when |
|---|---|
| 200 `{ "status": "undone" \| "redone", "id", "label", "history": <GET shape> }` | applied |
| 200 `{ "status": "confirm", "id", "label", "agent": "alice", "turns": 3, "confirm": "<token>", "history" }` | undo of a hire whose agent has started ≥ 1 turn, without a valid token. Nothing is consumed; cancelling needs no call. |
| 404 `{ "code": "history_empty", "history" }` | nothing to undo / redo |
| 409 `{ "code": "history_moved", "history" }` | `id` is no longer the target (another window acted, or a new action came). Nothing changed. |
| 409 `{ "code": "history_conflict", "id", "label", "reason", "history" }` | the world changed: this entry is now `refused` with `reason`; the next undo moves on to the next older entry |

- **Confirmation token:** binds the entry, the agent's id and its turn count
  at preflight. Submitting it re-checks: if another turn started meanwhile, the
  answer is a fresh `confirm` (new count, new token) instead of retiring.
- Two windows sending the same undo: the engine consumes the entry once; the
  second gets `history_moved`.
- Redo never asks for confirmation.

### Feed

Each org's feed carries the org header group **`undo`** (record `org`/`undo`)
with one field, `undo_history`: `{ "rev": 17, "undo": <target or null>,
"redo": <target or null> }` (the GET shape's `undo`/`redo`). `rev` changes on
every record, undo, redo, refusal or pruning; a window refetches
`GET …/undo-history` when it needs the list. The renderer adds `'undo'` to its
`treeOrgGroups`; a renderer that does not ignores the group.

## Inverses and guards

**Retool side effects are restored exactly** (coordinator 2026-10-14 19:07Z):
an undo lowers the grants the forward change raised on ancestors and in the
org's settings, and hands back the folders it clamped from agents beneath;
redo does the reverse. Every recorded `side` row must still hold the value the
entry left (else 409 `history_conflict` naming it, nothing restored). After
the forward ops of the inverse ran, every row of the agents, their ancestors
and descendants and the four org settings is written to exactly the recorded
value, or back to its value before the undo when the entry did not change it;
the agents' fields are then checked against the record. Nothing is partially
restored.

Every inverse runs in one serializable transaction through the same code paths
and permission checks as the forward operation (`Actor::User`): `move`,
`reorder` (placing after the recorded previous live sibling, else before the
recorded next one), `retire`, `rehire` (with an explicit `target`, never the
nearest-ancestor fallback), `switch_model`, `account` and the user scope save.
The history head is locked first, then the org row, then agent rows. Any
refusal from a guard or from the forward code (a parent no longer live, no
room for a stake, a model or login no longer allowed) is the entry's reason;
the transaction rolls back to before the inverse and only the entry's state
changes. After an undo or redo the entry keeps the positions that now stand,
so the next redo or undo guards against them. Guards compare **only the
facts the entry touched**, never an agent's whole `row_version`: turns, mail,
status and unrelated settings changes never invalidate an entry.

| kind | undo | redo | refused when (reason given) |
|---|---|---|---|
| `move` | each moved agent back to its recorded parent and live-sibling slot (credits move as a move moves them) | each agent to its recorded after-placement | the agent's parent or position differs from what the entry left; the old parent is gone or not live; the recorded neighbouring slot no longer exists (no nearest-ancestor or append fallback); the move would place it inside its own team |
| `hire` | retire the hired agent (archived, as any retire); a superior hire also moves the anchor back to its recorded place | rehire **the same record** at its recorded parent and position (never a fresh namesake) | the agent is no longer live (undo) / no longer archived (redo); it has live reports of its own now (never retired as collateral); its parent changed; redo: the parent is gone or there is no room |
| `retire` | rehire **exactly the recorded set** (the root and every member it archived), each under its recorded parent at its recorded position, with its session and context; credits as a rehire charges them | retire the same root again | any member is live, deleted or unrecoverable now, or was moved; the root's parent is gone or not live; no room for the stake; a recorded slot no longer exists |
| `retool` | restore the recorded **before** value of every field the entry changed (absent stays absent; a model or account change made while the agent was busy is queued exactly as a forward change is) | restore the **after** values | any changed field's configured value (a queued switch/account counts as configured) is not what the entry left; the old model/account/folder is no longer allowed or available |

Hire undo confirmation: `ot.turns` rows for the agent's numeric id, counted
inside the undo transaction.

## Entry data allowlist (internal; never in a response or a log)

- Identities are numeric agent ids; names are only in labels.
- Every entry: `steps`, the numeric agent id each step touched (or null),
  for the duplicate answer.
- `move`: `{moved: [{agent, live, before: {parent, order, prev, next}, after: {parent, order, prev, next}}]}`
  where `prev`/`next` are the neighbouring live siblings' ids.
- `hire`: `{hires: [{agent, after: {parent, order, prev, next}}], moved: [<move facts>]}`;
  `moved` holds the superior hire's `above` anchor and any other agent a
  placement step moved.
- `retire`: `{retires: [{root, before: {parent, order, prev, next}, members: [{agent, parent, order}]}]}`;
  members top-down, siblings in order; a team retired inside another team of
  the same gesture belongs to the first step that retired it. A retire whose
  team exceeds 2000 members is applied and recorded **not undoable**
  (`not_undoable` with its reason, no members): reaching it, undo refuses it
  409 `history_conflict` ("this retire is too large to undo (N agents; at most
  2000 per team)") and the next undo moves on, so Ctrl+Z never silently skips
  it (coordinator 2026-10-14 19:07Z).
- `retool`: `{agents: [{agent, fields: {<name>: {before, after}}}]}`; names
  `add_dirs`, `tools`, `org_visibility`, `permission_mode`, `effort`,
  `model_version`, `account_fallback`, `auto_cheap_compact`, `charter`,
  `team_charter`, `tier`, `account`; values are the configured value (a queued
  switch or account counts) or the marker `{"absent": true}` (an empty charter
  is absent); `account` stores only the account id. Only fields whose value
  differs before and after are recorded. Plus `side`: `{scopes: [{agent, before, after}], org: {<key>: {before, after}}}`,
  the stored scope of every row the gesture changed among the agents
  themselves, their ancestors and everything beneath them (a grant raised on
  the way up, a folder clamped beneath), and the org settings `dirs`,
  `default_tools`, `default_visibility` and `permission_mode` it changed.
- Never: request bodies, settings objects, account records, credentials,
  tokens, transcript or mail text.

## Limits

- A Muse seat's catalog is refreshed before an undo or redo that switches its
  model, as before the forward op; a scope save's effort or version check on a
  Muse seat reads the logins as last refreshed.
- The confirmation token binds the entry, each hired agent and its turn count
  (`ot.turns` rows, a started turn counts); it is not a secret.

- The forward routes stay as they are; the renderer moves composite gestures
  onto `/gesture` to get one entry per gesture.
- History is per org and per machine (the engine store); it is not exported
  with an org template.
