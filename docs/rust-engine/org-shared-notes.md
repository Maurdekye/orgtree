# The org's shared AGENTS.md

Agents of one org had no common notebook: `org.md` is the user's instructions and agents
don't edit it, each agent's scratch `AGENTS.md` is its own, and a shared notes folder only
worked once someone granted it to each agent by hand. New agents never got it. Now every org
has ONE shared `AGENTS.md` that every agent of that org reads and edits without any grant, and
agents of other orgs never see it. [decided: user 2026-10-13 18:10Z ("a shared AGENTS.md file
that all agents have implicit access to and can read & write", "all agents in an org"), "Build
it now" 18:12Z; coordinator rulings 18:19Z; docket
`shared-org-wide-agents-md-every-agent-in-the-org`]

## Where it is

`<data>\scratch\<org-slug>\_shared\AGENTS.md` (`Config::org_notes_dir`, `ORG_NOTES_FILE`).
An agent's name starts with a letter or digit (`ops::valid_name`), so `_shared` is never an
agent's folder. The folder holds nothing else of the org: `org.md` and the workspace
(`workspaces\<slug>`) stay out of reach, and so do the other agents' folders beside it.

The engine creates the folder before it starts a CLI (`ensure_proc`) and never creates, edits or
deletes the file: the first agent to write it creates it. Deleting an org moves the folder to
the trash with the rest of its scratch folder.

## Who holds it

Every launch adds the folder to the agent's effective folders (`scope::with_org_notes` in
`load_ctx`). Nothing is stored and the org's folder ceiling doesn't apply. The entry is
read-write when the seat may write its own folder (edit on and not plan mode), otherwise
read-only. It replaces a stored grant of the same folder and is marked `org_notes`. A launch
then gives each harness the folder the way it gives every granted folder:

| Harness | How it gets the folder |
|---|---|
| Claude Code (also OpenRouter and language-server seats on it) | `--add-dir`; a read-only entry adds Edit/Write/NotebookEdit/MultiEdit deny rules |
| Codex (also OpenRouter and language-server seats on it) | no folder is passed for any grant; a write outside the agent's folder is an approval request, which Orgtree accepts on a writable seat |
| Muse | a read-write entry is a workspace root; a read-only one is not |
| Antigravity | only its own folder is passed with `--add-dir`, for every grant; it runs with `--dangerously-skip-permissions`, so it reaches the file by path, and its rights hook enforces only the tool switches |

The same folder counts as one the agent holds for `orgtree_present`, attachments and file
watchdogs, so an agent may attach the file or watch it for changes.

## What the agent is told

Right after the sentence about its own scratch `AGENTS.md`, the prompt says where the file is,
that every agent of the org gets it at session start and may edit it, that other orgs never
see it, what belongs there, and how to edit it: re-read the file first, make small in-place
edits, never write the copy back over it. A read-only seat is told it may read the file but
not edit it. The folder is not listed with the agent's granted folders, and its `AGENTS.md`
isn't delivered as a granted folder's notes. A `CLAUDE.md` an agent drops there is never
delivered.

The file's text is the LAST block of the prompt, `[ORG SHARED NOTES - <path>, …]` … `[END ORG
SHARED NOTES]`. It has the same 12,000-character cap and truncation notice as the agent's own
notes. There is no block while the file is missing or blank.

## When agents see an edit: at CLI start

Each CLI gets the file's text as it is when that CLI starts: a new hire, a fresh session or
compaction, an engine restart, the agent's own reconfiguration, or a CLI closed while idle.
Another agent's edit never respawns a warm CLI, so nobody pays a cold-cache turn because
someone else wrote a note, and D-181 holds. [decided: coordinator 2026-10-13 18:19Z, option
(b): "session-start delivery only, no respawn on others' edits"] An agent that needs the
latest text reads the file; the prompt says the copy may be older.

The launch fingerprint keeps the copy's digest beside its seven parts (`Fingerprint::org_notes`,
`["org_notes", <digest>]` in the saved receipt). The `system_prompt` part hashes the prompt
without it, and equality ignores it, so a warm CLI is reused. The cache forecast lists
`org_notes` as a changed input only when the next turn will start a CLI: no warm one, a
reconfiguration, or another changed part. Closing a CLI while idle refreshes the forecast:
the idle timeout, eviction, a manual stop, or an exit between turns. A receipt saved before
this change reads with the notes digest unknown and is never counted as changed. Switching to
next-turn delivery (like an agent's own notes, decision 61) would mean putting the copy back
into the `system_prompt` hash; every agent of the org would then pay a cold turn per edit.

The working cache keeper reads an agent's prefix from its own forked CLI, built from the plan
of the moment. Because a warm CLI keeps its copy, the keeper must read THAT copy: the actor
keeps the notes block each CLI started with (`proc_notes`), and the keepalive uses it in place
of the file's current text. Otherwise the keeper would keep a prefix warm that the agent's next
turn never reads.

## Concurrent edits

Ordinary file semantics. Orgtree never writes the file, so it never loses an agent's edit.
Claude Code's Edit refuses a file changed since it was read, and Codex's patches fail on
changed context. The prompt tells agents to re-read the file right before editing and never
to write their session-start copy back over it.

## Limits

- An agent whose scope already reaches the whole disk (bypassPermissions, danger-full-access,
  Antigravity) can open any path, other orgs' folders included. That is unchanged: other orgs'
  folders are never granted, listed or delivered to it.
- Antigravity's access is by path, not as a workspace folder, the same as every grant on that
  lane. It hasn't been checked with the real `agy`.
- Skills: a folder Claude Code holds can carry `.claude/skills`. An agent able to write there
  could add a skill every Claude agent of the org loads, as the shared notes can carry
  instructions for every agent. The sensitive-path gate still guards `.claude` on non-bypass
  Claude seats.
- First launch after the update: every agent's prompt gains the rule (and the copy once there
  is a file) and its folders gain one entry, so each agent's first turn on the new engine is a
  changed prefix (one cold turn each).

## Verification (2026-10-13, on `rust-engine` `fa3a5f3`)

Measured in an isolated rig (scratch data root and cluster, fake home); no live data, provider
or account was involved. Engine binaries were built here: `fa3a5f3` (before) and the change
(after).

- `cargo build`, `cargo check --all-targets`: 0 warnings. The Unix compile check
  (`--target x86_64-linux-android`) passed with 4 warnings, all in `core_monitor.rs` and
  `core_startup.rs`, which this change doesn't touch. It shows only that the code compiles.
- Unit tests of the touched modules (identity, prompt, scope, the fingerprint, startup, docs,
  watchdogs): 18 of 19 pass, including the 4 new ones. The failing one,
  `prompt_follows_every_combination_of_group_switches` ("disabled orgtree_state_inspect in 2
  Claude top=false"), fails the same way at `fa3a5f3` (14 of 15). It predates this change.
- `org-shared-notes.mjs` (fake CLIs): 15 of 15 checks after, 2 of 15 before. The two that hold
  before are "an edit doesn't respawn a warm CLI" and "no agent of this org got the other
  org's text", which hold without the feature.
- `org-shared-notes-real.mjs` (installed Claude Code 2.1.292, a language-server seat on
  `fakellm.mjs`): 5 of 5 after, 1 of 5 before. After, the CLI's own Write created the org's
  file ("File created successfully at …") on an acceptEdits seat; before, the same Write was
  refused ("Claude requested permissions to write to …"). Writing another org's file was
  refused both times.
- `org-shared-notes-keeper.mjs`: 3 of 3 after. The keeper's forked read carried the warm CLI's
  V1 copy after an edit to V2, and the warm CLI ran on. This was measured only on the change;
  that the keeper would otherwise read V2 is inferred from the source (it builds its read from
  the current plan).
- Not measured: the real Codex, Muse and Antigravity CLIs (their prompts and folders were
  checked on the fake ones), a packaged app, and every case beyond these proofs.
