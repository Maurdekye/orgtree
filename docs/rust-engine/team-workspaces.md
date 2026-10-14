# Team workspaces

Agents in a team had no shared place for files: a manager could read its reports' scratch
folders, but reports could not read upward, and teammates could only share through the
org-wide `_shared` folder, which the whole org sees. Now every subtree has a team workspace.
Each agent holds the workspace of every subtree it is inside, from its own up to the top, plus
the org's shared folder. [decided: user 2026-10-14 13:26Z ("a 'team workspace' for every single
subtree"), 13:28Z ("yes, but with full upward workspace access, not just your own teams"),
13:55Z (every agent has its own workspace, reports or not; every workspace has an AGENTS.md
delivered at session start); docket `team-workspaces-a-shared-folder-per-subtree-visi`]

## Where they are

`<data>\scratch\<org-slug>\_teams\<root agent id>` (`Config::teams_dir`). The folder is named by
the id of the agent at the subtree's root, so renaming that agent never moves it; the prompt
names the team by the agent's current name. A leading `_` is never an agent's name, so `_teams`
is never an agent's folder.

## Who holds which

`domain::teams::held` reads the agent's chain from the tree: the agent itself, then each
ancestor up to the top. Each of them roots a subtree the agent is inside, so the agent holds
all of those workspaces, nearest first: its own, its superior's, and so on up to the top-level
agent's. Every agent has its own, whether it has reports or not. An agent never holds the
workspace of a subtree it is not inside: not a sibling's, not a cousin's, not another org's.

Nothing is stored. `load_ctx` computes the set at each launch and adds it to the effective
folders (`scope::with_team_workspaces`) with the org folder's write rule: read-write when the
seat may write its own folder (edit on and not plan mode), otherwise read-only. Each entry is
marked (`team`, `team_id`, `own_team`) and replaces a stored grant of the same folder. Every
harness then gets the folders the way it gets every granted folder (Claude Code `--add-dir`,
with Edit/Write deny rules on a read-only seat; Codex approvals; Muse and OpenCode write roots;
Antigravity by path), see [the org's shared folder](org-shared-notes.md). The same folders count
for `orgtree_present`, attachments and file watchdogs.

The launch creates the folders (`ensure_proc`); the engine never writes inside them.

## What the agent is told

After the org folder's rule, a `TEAM WORKSPACES:` sentence lists the folders nearest first,
each labelled ("your own team's", "lead's team"). It says that agents outside a subtree never
see its workspace, that a move changes the set from the next session, that each workspace's
`AGENTS.md` is that team's shared notes, and the org folder's rules (descriptive names or a
subfolder per topic or agent, re-read before changing, no secrets, not a delivery to the user).
A read-only seat is told it may read them but not write there. The folders are never listed
with the agent's granted folders, and their files are never delivered as a granted folder's
notes.

## Team notes

Each workspace's `AGENTS.md` is delivered at the end of the prompt as
`[TEAM NOTES - <path>, the shared AGENTS.md of <team> …]` … `[END TEAM NOTES]`, nearest team
first, then the org's `[ORG SHARED NOTES …]` block. Each file has the agent's own-notes cap
(12,000 characters) and truncation notice. A missing or blank file adds nothing.

They are delivered exactly like the org's notes: the copy is read when a CLI starts, another
agent's edit never respawns a warm CLI, and the team blocks share the org notes' digest
(`Fingerprint::org_notes`) and the cache keeper's `proc_notes`. An agent that needs the latest
text reads the file.

Worst-case growth: every file full, each block is at most the cap plus a header of about 250
characters. An agent at depth d (d ancestors) carries d + 1 team blocks and the org block, so
about (d + 2) × 12,250 characters: 24,500 for a top-level agent, 49,000 at depth 2, 85,750 at
depth 5, 147,000 at depth 10. Typical files are far smaller and missing files add nothing; the
total is bounded only by the tree's depth. The unit test
`worst_case_shared_notes_growth_is_bounded_per_file` prints the measured figures.

## Moves, retirement and deletion

- A move changes the agent's chain, so its next CLI holds a different set; a warm CLI keeps
  its folders until it restarts (the folders are part of the launch fingerprint, so the next
  turn after a move starts a new CLI: one cold turn).
- A retired agent's workspace stays on disk. Its former reports, moved elsewhere, stop holding
  it; a rehire under the same id restores it.
- Nothing deletes a workspace when its root agent is retired or its subtree is dissolved. The
  files stay until the org is deleted, which moves the whole scratch folder to the trash.

## Limits

- Changing the prompt rule and adding the team notes changes every agent's startup prefix
  from its next session (a new cache namespace: one cold turn each), and a move does the same
  for the moved agents.
- Files are plain files: no locking or ownership; the prompt asks agents to re-read before
  changing.
- An agent whose scope already reaches the whole disk (bypassPermissions, danger-full-access,
  Antigravity) can open any path; other subtrees' workspaces are never granted, listed or
  delivered to it.
