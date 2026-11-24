# Agents, teams and projects as a file: export, import, duplicate

One node, or a node with everything under it, can be written to a single zip file, brought
into the same or another organization from that file, or copied inside its organization
without a file. Added in 4.7.0. Docket:
`agent-team-project-export-import-and-duplication`.

The user's words, which decide everything below (2026-11-23):

- 10:32Z mb05f4fda0d92: "agent / team / project export. choose an agent, and either just them,
  or them and their entire subtree is exported as a single zip file containing all of their
  context: their full scratch folder contents, full transcript and all transcript history,
  full configuration, credits, and everything. this is a ui feature, a context menu option on
  agents / projects for import / export, an agent tool for creating and applying these exports
  autonomously on their own subtrees (allowing them to send full agents over to other orgs or
  the mailhub), and include a dedicated agent duplication tool on top of that. imports by
  agents are always restricted by credits, never for the user if bubble up is enabled."
- 10:43Z m3c072bcdc19a: strip nothing unless an app setting is ticked, off by default; a manual
  export warns and asks when secrets are detected and nothing is stripped; names are numbered
  as at a hire; a manual import goes under the node whose menu was used; an agent decides
  where; grants are saved and reused; a shrink strategy (bottom-up, top-down, even) when the
  seats fit and the grants do not; the export is stamped with its Orgtree version, which is
  not read yet; agents import only into their own subtree.
- 20:30Z m2106530cca00, 20:31Z m664d722b9e98, 20:32Z m62418cf863fe, 20:44Z m36ba89488717: the
  answers to the design's questions, quoted where they apply.

## Where the code is

| Part | File |
|---|---|
| Zip writer and strict reader | `src/zipfile.rs`, `src/zipfile/read.rs` |
| File format | `src/portable/format.rs` |
| Export | `src/portable/export.rs`, secrets in `src/portable/secrets.rs`, seal in `src/portable/seal.rs` |
| Reading a file | `src/portable/reader.rs` |
| The plan | `src/portable/plan.rs`, credits in `src/portable/credits.rs`, names in `src/portable/names.rs` |
| Import, step 1 (nodes) | `src/domain/ops/import.rs` |
| Import, step 2 (history and files) | `src/portable/import.rs`, CLI sessions in `src/portable/sessions.rs` |
| Jobs and the one way in | `src/portable/jobs.rs`, `src/portable/service.rs` |
| Routes | `src/http/portable.rs` |
| Tools | `src/tools/portable.rs` |
| Undo | `src/domain/undo.rs` (`import_record`, `apply_import`), migration `0090_import_undo.sql` |

## The file

A zip (stored or deflated, ZIP64 when needed), written once from front to back. Its parts:

| Part | Holds |
|---|---|
| `manifest.json` | Kind `orgtree-export`, format 1, the Orgtree version, when and where it was made, the root, the counts, what was included, the secrets note, the digest of the index, the seal |
| `index.jsonl` | One line per part: name, size, SHA-256, and the record count of a part written line by line |
| `nodes.json` | The nodes in tree order: each after the one above it. Name, kind, charters, tier, account, seat, grant, scope, session, costs, what was going on when it was read |
| `links.json` | Audiences among the nodes and with the user (never the org mailbox); watchdog definitions of the agents and the projects; docket items a node only takes part in; what was left out |
| `nodes/NNNN-name/…` | Per node: `convo.jsonl`, `tool-images.jsonl`, `turns.jsonl`, `sessions.jsonl`, `asks.jsonl`, `documents.jsonl`, `deliveries.jsonl`, `uploads.jsonl`, `docket.jsonl`, `icon.json`, and the folders `scratch/`, `team/`, `uploads/`, `docket/`, `native/<harness>/` |
| `mail.jsonl` | Each mail row once: with its sender when a node sent it, else with its recipient |
| `events.jsonl` | The event log rows about the nodes. An archive: no import reads it |
| `report/secrets.json`, `report/not-included.txt` | What was detected and stripped; what could not be taken |

The limit is 256 GiB unpacked (USER 20:30Z: "256gb"); one file is never split.

**The reader trusts nothing** (`reader.rs`): the manifest names the index's digest, the index
names every part's size and SHA-256, and a part is used only when the index names it and it
reads back as the index says. A zip entry the index does not name is never unpacked. A name
that is not a plain path inside its own folder is refused (`names::safe_parts`). The zip
reader itself refuses encryption, other compression, multi-disk archives, names that are not
UTF-8, entries that overlap or lie outside the file, and an entry longer or shorter than it
says (`zipfile/read.rs`).

**The seal.** The exporting engine seals a few facts of the manifest with a key that never
leaves its data folder. A file whose seal does not open here is "foreign": made on another
computer, or changed since. It only decides a banner: an agent's import of a foreign file
needs no approval (USER 20:32Z: "agent imports need no ok"), and the user's own import of one
shows a warning.

## Export

`export::run` writes the file on one blocking thread and interrupts nobody. It reads each
node's rows a page at a time, with no transaction held over the file, then copies the folders.
An agent that is mid-turn is exported as far as it had got.

What is taken: the node's row (settings, charters, credits), its transcript with every
earlier row, tool images, the turn ledger, session records, questions, documents (a
project's are the ones presented under it, so a document presented to a project outside the
export stays behind: USER 20:31Z), sent-file and upload records with their files, docket
items it owns with their history and attachments, its scratch folder, its team folder (with
`subtree`), a project's folder and icon, and the files of its current CLI session.

What is never taken: provider keys, sign-ins, the hub identity, client tokens, the engine's
own files in a scratch folder (`export::engine_owned`: `.orgtree-*`, including
`.orgtree-mcp.json`, which holds resolved MCP credentials), links (named, never followed),
folders granted outside the scratch and team folders (USER 20:30Z, question 9), slot leases,
listener registrations, queued switches, halt, freeze, do-not-disturb.

A project's own watchdogs travel like an agent's (USER 2026-11-24 m516cde3ebdef): the owner is
the project's place in `nodes.json`, and the definition also keeps its delivery form
(`project_delivery`). A relay from a project that is in the export follows that project's new
name; one whose source project stayed behind is dropped and named.

The org mailbox never travels (USER 2026-11-24 m63824e37d3d6: "the org inbox audience should
never move / be saved with an import"). An export holds no audience with it and does not name it
as left behind. An import or a duplicate grants none, from any file: one found in a file written
by 4.7.0-alpha.1 is ignored and named in the result's notes. The canonical grant of the org
mailbox takes it from its other holders, which is why no import may make it.

A watchdog's fire actions that hold credentials, or name a credentials file, travel where its
sealed credentials do in a file: only in the user's own export that strips nothing, after the
user confirmed what was detected (USER 2026-11-24 mf7c65a1b2403). They are in the watchdog's
`fire_actions` member of `links.json`, never in its `args`, and count as watchdog credentials
in the manifest. An agent's export, a stripped export, a template and a duplicate drop them:
the watchdog arrives without them, paused, and says it needs credentials.

### Secrets

Four kinds are detected (USER 20:30Z, question 1): the sealed credentials of MQTT and
WebSocket watchdogs; credential files by name (`.env`, key files, cloud credential files);
recognisable secrets in text (private keys, provider tokens, web tokens, authorization
headers, password-like assignments, passwords in URLs); and exact matches of any key this
Orgtree holds. Personal data is not a secret here and is not stripped.

- App setting `export_strip_secrets` (Runtime, off by default) takes them out of every export.
- With it off, the user's own export that detected something ends in the state `confirm`: the
  file is handed out only after the user has seen what was found. Sealed watchdog credentials
  travel in that file, and only in that one (question 2).
- An agent's export follows the setting, lists what it detected in its result, is recorded in
  the organization's event log, and never carries sealed credentials (questions 2 and 3).
- A file larger than 64 MiB is not scanned and is named as not scanned.

## Import

Cheap checks come before the expensive step (USER 2026-11-15: no wasted time): the file is
opened and checked whole, the plan is worked out, the disk is measured, and only then is
anything created.

### The plan (`plan.rs`)

Pure: `domain::ops::import::gather` reads the facts under the import's own transaction and
`plan::build` decides. The preview and the import run the same code; an import that was
previewed carries the plan's digest (`expect`) and is refused when the plan has changed.

- **Names.** A free name is kept; a taken one becomes `name-2`, `name-3` (USER 10:43Z). Names
  are compared without case: two names that differ only in case would share one folder.
- **Tiers.** An agent on a tier this computer cannot staff comes in retired (USER 20:30Z,
  question 11), and takes the nodes under it with it, as a retire does. While a sign-in is
  still being checked the plan refuses rather than decide.
- **Accounts.** The saved account is used when this computer has it for the tier; otherwise the
  hire chooses, as for any hire that names none.
- **Settings.** Tools, MCP servers, Orgtree tool groups, visibility, permission mode and
  folders are clamped to what the destination holds, with a warning each. Nothing is refused
  and nothing above is raised. A setting this computer would refuse at a hire (an effort
  level, a pinned version, fast mode, a harness of its own) is dropped with a warning.
- **Credits.** Each agent's seat is this computer's price; its grant is the saved one, raised
  only to what its reports hold here. What can be drawn under the destination is what
  `ensure_room` would give: for an agent, its own allocation and no more; for the user,
  everything up to the top-level cap with bubble-up on, and the nearest agent's free credits
  with it off. When the full cost does not fit, a strategy takes spare credits away:
  `bottom-up` from the lowest nodes first, `top-down` from the topmost agent first, `even`
  one credit from each agent in turn. Whole credits are taken. An agent that names no
  strategy is refused (20:44Z, S3). The user's own import uses the app setting
  `import_shrink_strategy` (Runtime, bottom-up by default: 20:30Z and 20:44Z, S1). The dialogs
  never ask for one (USER 23:51Z m84e35b23ed2e, which replaced S2), though the routes still
  take a `strategy`. When not even the seats fit, it is refused whatever the strategy.
- **The top-level cap.** With no agent at or above the destination, every top agent of the
  import is a top-level agent: its grant is brought down to the organization's cap out of its
  own team's spare credits (question 10).

### Step 1: the nodes (`domain/ops/import.rs`)

One serializable transaction, retried on conflict. Every live node is created by the
canonical `hire` or `create_project`, as the importer, in tree order. Retired nodes are stored
as a retire leaves them. Each new agent is held with the halt record (`by: "import"`), so no
turn can start. Audiences among the nodes and with the user are granted
through the canonical grant as the importer; one that the importer may not grant is left off
and named. One `import` (or `duplicate`) event is written beside the ordinary hire events.
A hire leaves a notice for the superior and the peers of the newcomer (`lifecycle::record`);
the ones addressed to nodes this import created are deleted in the same transaction, because
each of them arrives with its team and is told so by the import's own notice. The node the
import went under, and its other reports, keep theirs.
Mentions of a renamed node follow it in charters, team charters and project descriptions, and
nowhere else (question 4). A refusal rolls all of it back, and nothing was unpacked.

Each created node is marked `extra.ported` (where it came from, its old name, the old→new
folder pairs, the parts already in). **Never** use `extra.imported_from` for this: that is the
3.x upgrade's mark, and `runtime::history::ensure` replaces the history rows of an agent that
has it.

### Step 2: history and files (`portable/import.rs`)

Outside any long transaction, node by node, on a blocking thread. A failure here never undoes
a finished node: the import ends with the leftovers named.

- **Transcript.** Rows go in below the range the agent's actor writes, `ver` 0, in their
  order, as a 3.x agent's history does (`runtime/history.rs`). A row's own numbers (`seq`,
  `row_id`, `event_id`, a tool chip's `input_seq`) follow its new place. Two rows of the
  import's own close it: when the last state row was not idle, an idle state row at seq -1,
  at the time of the export; and always, at seq 0, a system line of kind `ported` ("Imported
  from the organization X. Everything above happened there.", or "Copied from alice. ...").
  **The row at seq 0 is not decoration.** `ConvoWriter::load` continues at `max(seq) + 1`,
  and a row at 0 or below is never amended (`ConvoWriter::update_batch` takes `seq > 0`,
  `count_turn_rows` skips `seq <= 0`): with imported rows ending at -1, the actor's first row
  here would land at 0 and lose its later amendments (found by the rig, 2026-11-23). The part
  is read twice, first to learn how it ends.
- **Times.** Every row's time is clamped to the import's time, so "turns since the import" is
  exact for the undo history.
- **Ledger, sessions, documents, sent files, uploads, docket items**: rows of this
  organization under new ids. Documents arrive already viewed, each under a slug the database
  makes from its title; the presenter is the node's name here, and a presenter that did not
  come along is not kept as a name (here it could be somebody else's; a duplicate keeps it).
  A part that cannot be written twice is written in one transaction with its mark in
  `extra.ported.parts`.
- **Mail.** A delivered message between two imported nodes becomes a message between them
  here. Mail with anyone else, mail that was still waiting, and every question go to
  `imported-history/` in the agent's own folder. Nothing is delivered, asked or answered
  again, and nothing appears in this organization's inbox (question 5).
- **Folders.** Only what the index names, only to a plain path inside the node's own folder,
  never through a link. Each file is written beside its place and takes it only when its
  digest matches.
- **CLI session** (question 8: "prefer own cli session with full context"). Claude Code and
  Codex keep a session as files; they are placed under a NEW session id (two agents never
  share a session) where the new agent's CLI reads them, and the agent's first turn resumes
  it. The session is recorded as the actor records one it has just learned: `session_id` and
  `provider` on the agent, and a row of `ot.agent_sessions`. The provider matters: a Codex
  thread is resumed only when the stored provider is the seat's own (`runtime/actor.rs`).
  Every mention of the old id in the files becomes the new one, so an id shorter than 8
  characters (none of a real CLI's) is not carried. Any other harness, or a session that did
  not come along, starts fresh with the standing handoff note, which is set only where there
  was a conversation. A resume that fails falls back the same way (the actor's own rule).
- **OpenCode's session** (USER 2026-11-24 m4778ba0aed9e). An OpenCode seat keeps its sessions
  in a store of its own, `profiles/opencode/<org id>/<agent id>/<generation>/` (`data` and
  `state`). Both parts travel whole and are placed in the new agent's own store, and the
  session keeps its id: the one exception to "a new id", allowed only because no two agents
  read that store (`sessions::keeps_id`). Nothing inside the store is rewritten. The import
  marks the session `extra.ported.carried_session`. When the CLI cannot load a session that
  still has the mark (`session/load` fails), the same start opens a new session and the agent
  gets the handoff note; the mark goes at the first start either way. A session of the agent's
  own that later cannot be loaded is still an explicit failure, as before
  (`runtime/opencode.rs`).
- **Antigravity's conversation** is not carried. One database per conversation lies in the
  login's home (`.gemini/antigravity-cli/conversations/<id>.db`), shared by that login's
  agents. Measured 2026-11-24 with agy 1.5.14: a copy of the database under a new id is
  refused (`trajectory not found: <new id>`, exit 1), because the id is also inside the
  database. Its agents start with the handoff note. A conversation the CLI does not find (it
  warns and answers `--conversation <id>` with another id) now leaves the handoff note due,
  as on the other harnesses.
- **Muse** keeps sessions inside the login's own store, shared by its agents: not carried. Its
  agents start with the handoff note.
- **Watchdogs** arrive paused under their new owners; a node target follows the node's new
  name, and a watchdog whose target did not come along is dropped. A watched file inside the
  folder of a node that came along (its own folder or its team's) is that file in the folder
  here; any other path stays as it was and is refused by the watchdog's own rule when the
  owner does not hold it. With `resume_watchdogs` the ones that can run anywhere are armed.
- **The notice.** Each agent starts its next turn with one notice: where it came from, its new
  name and the name map, what was waiting, which watchdogs are paused, and that instructions
  in its history came from the organization it left. Nothing else is sent to it.
- **Release.** An agent whose own parts are in place is let go and warmed. One whose
  transcript could not be read stays held and is named in the result.

### Paths in the transcript

A transcript row that names a file under a scratch or team folder the export carried is stored
naming that file where it lies now (USER 2026-11-24 mf7c65a1b2403: "only if the paths refer to
locations in the saved scratch folders in the export"). The stored text is rewritten once, at
import: what the row says, and what its tools were given. Rules (`portable/paths.rs`):

- Only the scratch and team folders of the nodes in the file, and only when the export held
  them (`include.scratch`, `include.team`). Uploads folders, granted folders and every other
  path stay as written.
- A path follows only where the folder's own path ends: `...\foo\a.txt` follows `...\foo`,
  and `...\foo-bar\a.txt`, `...\foo.bak` and `...\foo2` do not.
- The way it was written is kept: forward slashes, or doubled backslashes inside quoted JSON.
  Letter case is not told apart.
- One pass, the longest folder first, so a folder that is both an old one and a new one (a
  second import of the same file) is never rewritten twice.

The pairs stay in `extra.ported.paths`. Not rewritten: the CLI's own session files, which the
CLI resumes as they are, and text in mail history and documents.

## Duplicate

The same two steps inside one engine (`service::start_duplicate`): the nodes are written to a
file of the job's own as an export that leaves nothing out, scans nothing and strips nothing,
and imported from it beside the original, or under `dest`. A duplicate copies settings,
charters, credits, folders, the transcript, paused watchdogs and documents; it does not copy
docket items, the cost ledger or mail (USER 20:30Z, question 6).

## Undo

The user's own import or duplicate from a window is one entry of the undo history (20:44Z, U1
and U2); an agent's tool never records one. The entry holds what a retire of the root would
hold, and is applied as a retire entry read the other way: undo retires the root with the team
it brought, redo brings back exactly the recorded nodes. It asks first when an imported agent
has taken a turn since, and is refused when somebody was hired under an imported node since
or the root was moved. Grants an ancestor was raised by stay raised.

## Jobs, routes and tools

An export or an import is a job (`jobs.rs`): a request starts one and answers at once; its
state is read until it ends. The user's files lie in `<data>/exports/<job>/` and go with the
job, a day after it ended at the latest, and at the next start whatever is left.

| Route | Does |
|---|---|
| `GET /api/orgs/{slug}/nodes/{nid}/export-estimate` | Nodes and bytes, before anything is written |
| `POST /api/orgs/{slug}/nodes/{nid}/export` | Start an export |
| `GET`, `DELETE /api/orgs/{slug}/exports/{id}` | Its state; forget it |
| `POST /api/orgs/{slug}/exports/{id}/confirm` | The user has seen what it found |
| `GET /api/orgs/{slug}/exports/{id}/file` | The zip, once done and confirmed |
| `PUT /api/orgs/{slug}/imports/upload` | Send an export file up |
| `POST /api/orgs/{slug}/imports/{id}/plan`, `/apply` | The plan; the import |
| `GET`, `DELETE /api/orgs/{slug}/imports/{id}` | Its state; forget it |
| `POST /api/orgs/{slug}/nodes/{nid}/duplicate` | The plan (`preview`) or the copy |

A read-only viewer may use none of them; a member of a remote organization may use all.

The tools `orgtree_export` (group `inspection`), `orgtree_import` and `orgtree_duplicate`
(group `team`) start the same jobs for an agent inside its own subtree and wait about 25
seconds; a longer job is read by calling the tool again with `job`. Their guides are
`orgtree-tool-export`, `orgtree-tool-import` and `orgtree-tool-duplicate`.

## Sending an export by mail

"allowing them to send full agents over to other orgs or the mailhub" (USER 10:32Z). An agent
writes its export into its own folder and attaches it to mail.

- **To the mail hub (`@net:`)**: as any attachment, under the hub's own size limit.
- **To another organization on this computer (`@org:`)** (question 13): the file is copied
  into that organization's mailbox folder, `uploads/<org>/@org-inbox/<id>/<n>/<name>`, where
  what arrives over the hub is kept too, at most 256 GiB each. Its agents read none of the
  sender's folders, and the copy stays when the sender's file changes or goes. Before a byte
  is copied the send's cheap refusals are made (`orginbox::attachment_room`: both mailboxes
  open, the organization there, the sender allowed to write outside, the size, the free
  space); mail that is refused afterwards leaves no copies.
- **Importing it.** `orgtree_import` takes a file in a folder the agent holds, or the path of a
  file that was sent to it: an attachment of mail it received, or a file the user gave it
  (`tools::portable::import_file`). Such a file lies in the organization's own folders, which
  no agent holds; it is the agent's to read by having been addressed to it, by exactly the
  path its mail names. Another agent naming the same path is refused.

## What is measured, and what is not

Measured in the rig (`tools/rig/proofs/agent-export.mjs`, fake CLIs, two synthetic
organizations in one engine): every route and tool above, the plan and what an import
creates, undo and redo, a project, retired agents, the strip setting, the strategies, mail to
`@org:` with an export and its import by the receiver, and the first turn of an imported
agent: its CLI is started with `--resume <the new id>`, gets its new identity as a system
prompt update, and writes from seq 1. The export zip opens in Python's `zipfile`, .NET's
`ZipFile` and Windows `tar`.

Not measured: a resume of a carried session by a real Claude Code or Codex CLI (the files are
placed as the engine's own carry, `claude::ensure_session` and `codex::ensure_rollout`,
expects them, and the unit test finds a placed Codex thread under its new id); a file made on
another computer, end to end (`file.foreign`); credentials of a watchdog carried in a manual
export; an agent on a model this computer cannot staff arriving retired (the plan's unit
tests cover the decision); an export larger than a few hundred kilobytes.
