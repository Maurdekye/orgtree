# V1 copy import into V2

First launch starts with an empty V2 data root. Import is an explicit later
action in Settings. It never moves or changes the V1 data root and never
copies the V1 installation, root ownership files, authentication profiles,
`accounts.json`, global environment overrides, or executable deployment flags.

## Desktop API

The launcher includes `orgtree.desktop_import.router` in the real API app
inside its desktop token gate. Only the desktop operator credential may
reach `/api/desktop/*`; an agent credential cannot import organizations.

`POST /api/desktop/import-v1/preview`

```json
{"source_root":"C:\\Users\\example\\orgtree"}
```

Returns `organizations: [{slug, name, nodes, conflict}]` and `warnings`.
`conflict` is null for an available destination. A preview never publishes an
organization. Preview validates identities, hierarchy and history shapes by
reading a private copy; its evidence remains under V2 `.import-staging/`.

`POST /api/desktop/import-v1`

```json
{"source_root":"C:\\Users\\example\\orgtree","organizations":["example"],"acknowledge_duplicate_work":true}
```

The checkbox must explicitly acknowledge that V1 may continue working and
that imported active agents and enabled automation can repeat work in the
same external projects. There is no requirement to stop V1.

The response contains:

- `imported`: `{slug, name, active_nodes, warnings, recovery_pending, recovery?}`.
- `failed`: `{slug, error, not_attempted}` when an earlier organization was
  committed but a later publication failed. Each organization is its own
  publication boundary; the batch is not advertised as one transaction.
- `warnings`: the duplicate-work and provider-continuity notices.

The UI displays global and per-organization warnings, refreshes the
organization list after success, and does not repeat an already imported
slug. Invalid inputs return 422, absent organizations 404, overlaps and
conflicts refuse before publication (conflicts return 409). A source changing
during the copy returns 409 so the user can retry. An unconfigured recovery
hook returns 503 before copying. A recovery-hook failure after commit returns
the successful copy with `recovery_pending: true`; it is not an import retry.

## Copy and validation

Both SQLite V1 organizations and legacy JSON documents are supported; the
destination is SQLite. Existing JSON migration consent, rollback readers,
`BackendMismatch` and `MigrationRefused` are untouched. The importer never
rebinds the engine store to the source.

All source reads use ordinary read-only file handles. The database and WAL
are hashed, copied, and checked again as a group before SQLite opens the
private copy. SQLite then backs that private database up consistently. This
captures committed WAL rows without opening SQLite against the original:
even a `mode=ro` SQLite open can create a missing `-shm` beside the source.
A present rollback journal, changed files, corrupt database or unsupported
schema refuses the import. The source can keep running; a continuously
changing source may need another attempt.

The copied document is reconstructed with the existing store reader and its
candidate SQLite database must pass the existing full-document migration
verifier plus SQLite integrity checks. An exact original JSON document is
retained at `imports/<slug>/original.json`. Mail, receipts, events, work items,
documents and archived agents retain their content and order. The importer
copies `scratch/<slug>`, `workspaces/<slug>`, `journals/projects/<slug>` and
`turnlog/<slug>`, including document assets and transcript projection sidecars.
Runtime workspace, directory-grant, document-file and watchdog paths below
V1 are resolved and redirected into V2, including Windows short-path aliases.
Paths to external projects remain external, which is why duplicate work is
warned about. Free-form historical text retains its source-era meaning.

This is a database snapshot plus individually checked files; it is not an
atomic filesystem snapshot of a running source. The importer refuses a file
that changes during its copy and preserves the exact database source document
for reconciliation. Directory links, symbolic links, junctions and other
reparse points are refused rather than followed. Virtual-disk-backed V1
organizations are refused because their real scratch is outside this normal
layout; they need a regular-folder export first.

All selected candidates validate before any publication. Files arrive first;
an exclusive atomic link publishes each fully validated database last. The
engine's document lock serializes publication with ordinary organization
mutations. Existing destination database, rollback artifacts, scratch,
workspace, journal or import archive causes a conflict; nothing is replaced.
An interrupted/failed publication leaves diagnostic files and staging in
place, with no partially written runnable database. Those leftover files
deliberately block a blind retry under the same slug. There is no automatic
recursive cleanup.

## Provider history and recovery contract

Agent names and generations stay stable. Native Claude/OpenRouter JSONL
conversations are copied under a new UUID into
`imports/<slug>/native/<node>/<uuid>.jsonl`. Native message content and UUID
parent chains survive; sessionId and runtime cwd are rebound to the copy.
The source bytes remain separately archived and unchanged. This replaces the
initial implementation's unconditional empty-session reset, which was **not
an accepted scope reduction**. Prompt-cache continuity is not guaranteed.

Both requests accept optional `native_sources` with `claude_profile`,
`codex_profile`, and/or `sessions` (an `organization/node` to absolute JSONL
path mapping). These are read-only source locators, never authentication or
account configuration. Profiles are not copied. Preview exposes per-node
`native_context` with provider, available/held status, path or reason.
Invalid relative paths, overlapping destination paths, reparse points,
ambiguous session matches, malformed identity/parent chains and incomplete
final records cannot become native-ready imports.

Codex native rollouts are forked by the local Codex app-server using
`thread/fork` with a private snapshot path and deferred goal continuation.
The loader uses an empty temporary profile, blank authentication variables,
and a closed-loopback provider; it never starts a model turn or compacts.
The returned independent rollout is stored inside the destination import;
the engine must resume it using `thread/resume` with its explicit `path`
and destination `cwd`. Source provider settings are retained in the native
record, while actual work uses the application's configured connection.
Readable engine journals are copied separately under the new session ID.
The source locator searches the selected profile's sessions/archived_sessions
or accepts an exact file. Ambiguous IDs and local attachment references hold.

Antigravity cloning and native sidecar layouts remain unfinished. The Codex
loader-only probe has verified native fork and resume with preserved prior
user/assistant items on installed Codex 0.153.4, without provider turns or auth.
This does not establish actual engine/Settings resumption; core integration
and assembled acceptance remain separate. Missing/unsupported native context has
`node.desktop_import.native_continuity.status="held"`, and must stay held
at actual engine admission. Readable history is not an empty-session fallback.

Provider-neutral journal transcripts are copied. For Claude, the importer
also looks for the exact selected session under the V1 data folder's sibling
`.claude/projects` directory. It does not copy authentication or an entire
profile. A custom profile can be supplied explicitly; an absent transcript is
explicitly reported as unavailable, while all copied organization history
and scratch remain readable. Copied history is stored under
`imports/<slug>/history/<node>.jsonl`, and its path plus original session ID
are recorded in `node.desktop_import`.

`desktop_native.native_session_path(org,nid)` returns only a ready clone
whose session identity and destination-owned path agree. The Claude command
must use `--resume <absolute-jsonl-path>` (without forking that clone again).
The installed Claude 2.1.241 parser/loader supports this path and adopts its
sessionId and directory; no CLAUDE_CONFIG_DIR or credential copying is needed.
`native_path_for_session(sid)` and `native_index()` serve existing transcript
readers and startup checks. Duplicate imported IDs are omitted from the index
and listed by `native_conflicts()`; individual lookup refuses an ambiguous ID
and must never fall back to a foreign provider file. Unrelated IDs remain usable.
`native_hold_reason(org,nid)` must gate every
imported-node dispatch. Core owns these narrow integration calls and the
recovery UI/route; helper existence alone is not assembled acceptance.

Inline native tool-use/result records are retained. Regular files directly
inside the selected Claude session's `tool-results` directory are copied
with stable-source checks into the independent session directory. Explicit
native tool-output paths and persisted-output text are rebound to those
copied files; unrelated message text is preserved. Missing or mixed external
references, nested directories, unknown subagent metadata and
special worktree/remote layouts remain explicitly held until their independent
restoration is verified. These held layouts are unfinished coverage.
The Claude parser/selection/output-formatter probe uses extracted installed
functions and a synthetic filesystem adapter; it is component evidence,
not a full CLI or provider-turn proof.
Flat `subagents/agent-<id>.jsonl` native sidechains are validated and copied
under the new parent session directory. Their agent IDs and message UUID/parent
chains are preserved; parent session identity, runtime cwd and explicit copied
dependency references are rebound. The installed Claude subagent path/listing
functions use the explicit resume directory and new parent ID; a component
probe verifies discovery and native chain traversal of the copied child.
Unknown filenames, mismatched agent/session identities and nested layouts hold.

Claude project auto-memory travels with the scratch folder. The installed
Claude 2.1.241 reads it from `<config>/projects/<key>/memory/`, where `<key>`
is the process working directory (or the canonical root of the git checkout
containing it) with every non-alphanumeric character replaced by `-`, and a
base36 hash suffix past 200 characters. Local `--resume` does not adopt the
transcript's recorded cwd; the engine starts every generation of a node in
`scratch/<slug>/<base node id>`, so the rebound native cwd and the memory key
both use that base folder. `desktop_native_claude_memory` stages the source
memory directory once per base folder (regular files only, reparse points
refused, at most 64 MiB and 5000 files, hashes recorded, source untouched),
keeps an archive under `imports/<slug>/memory/<base>/` with a manifest, and
creates the destination directory exclusively at publication beside the
rewind publish. A pre-existing destination with identical content is
accepted and its content is compared again at publication; different content
is never overwritten. When the copied base scratch folder is itself a git
checkout or worktree, its `.git` entry is evaluated as it will read at the
published path, and at every admission the key is recomputed from the real
working directory and held if it no longer matches. Any override of the memory
location (environment `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, or
`autoMemoryDirectory` in managed, local, project or user settings) means both
installations would share one directory, which is not independent
continuity, so it is recorded as unsupported. Remotely delivered flag
settings cannot be read here. Every unavailable case is recorded on the node
as `desktop_import.memory` with a reason, appears in the import warnings, and
holds native continuation through `native_hold_reason` until resolved; an
absent source memory directory is recorded as `none` and holds nothing. A
destination that changes between staging and publication refuses the import
with 409 before any profile write. `tests/fixtures/claude_memory_key.cjs` is
the extracted CLI key function and is the control for the Python port.

Native file-rewind backups use Claude's selected config profile. The importer
stages only referenced native backup blobs, validates their native digest/version
filenames, and exclusively creates `file-history/<new-imported-SID>` in that
selected destination profile before publishing the organization. Existing
source/profile files remain byte-for-byte unchanged, including when source and
destination use the same profile. No credentials or settings are copied. A
collision refuses; a partial new directory from a failed publication is retained
without publishing the organization or admitting work. This is restoration of
one independent session, not profile/account migration.

The profile resolver uses `clean_env()` plus this destination node's existing
environment overrides; admission holds if that selected profile later changes
or a required backup is missing. Rewind tracked paths inside the V1 data root
are remapped into V2, including deleted-file snapshots. Snapshots targeting the
source provider profile itself remain held. The installed native backup path
getter/filename validator component probe locates the copied bytes by the new
SID; full provider-driven rewind is not exercised by these no-provider tests.
`retire_native_binding(org,nid,predecessor)` permits a later legitimate
lineage transition only after checking the actual archived predecessor and
generation/session relation. Compacted successors also need a real native
transcript. Renames keep a stable storage-node locator. The predecessor's
metadata is deep-copied and retained; an arbitrary SID edit still holds.
For a validated Claude compacted successor or native bearer, the rewind helper
copies the predecessor's required backup files under the new SID in the same
selected profile. A folder already produced by the native fork is accepted only
when every required backup is present and byte-identical; it is never filled or
overwritten. Failed partial new folders remain unavailable. The caller must
complete validation before committing the lineage change, and preserve the
returned rewind binding so later profile changes or missing backups hold work.

Local loader evidence executed only the installed Claude 2.1.241 native
resume parser/selection functions (`e4s`, `pst`, `mwr`, `uAt`, `ZQi`) with a
synthetic read-only JSONL adapter and no hooks, authentication or provider
process. It loaded the independent session ID and complete three-record
tool-use/result chain. This is a component-level native loader check, not a
complete CLI/provider turn or general sidecar support claim.

The engine owner wires:

```python
desktop_import.configure(on_imported=recover_imported_organization)
api.app.include_router(desktop_import.router)
```

The synchronous callback receives only the committed `slug`; it must use
the existing engine's active-only recovery and uncertain-operation receipt
reconciliation, and persist the recovery result. No source provider process
may be resumed or terminated. Saved `inflight` records identify agents that
were active. Their recovery text identifies the independent clone, names the
copied transcript when available, and asks them to inspect current work and
reconcile uncertain effects before any mutation. Merely queued mail does not
authorize waking an idle agent. Enabled automation remains in the document
for the V2 engine's normal scheduler to restore after publication.

`desktop_import.imported_history_path(org, nid)` is a read-only history-view
and recovery seam. It must not be used as a native provider resume path.
UI history must keep this copied history readable after the native clone
starts. The launcher/supervisor integration is owned by the engine slice;
this module never invokes a provider.

`kiosk`, `sandbox` and disk activation settings are excluded; the exact old
document preserves them as history. `accounts.json` is explicitly reported
as skipped when present. A copied network identity is archived and cleared
so the copy cannot impersonate or displace the still-running source; use
Connections to connect the new copy.

## Verification

Run with an explicit throwaway root before imports:

```powershell
$env:ORGTREE_DATA = 'C:/path/to/throwaway/import-test-entry'
$env:ORGTREE_STORE = 'sqlite'
python -m unittest tests.test_desktop_import -v
```

The suite creates only synthetic, explicitly bound temporary roots. It checks
real SQLite and JSON imports, an open writer's WAL-only committed row,
independent destination file/database mutations against source hashes,
documents with assets, ordered history, active-node selection, fresh session
IDs, malformed data, root/conflict guards, mutation during copying,
transaction/publication failure, partial batch receipts, post-commit recovery
failure and token-gated route positive/negative controls. The reparse guard
has an injected Windows attribute positive control; no live junction is
created or recursively removed. No live import or provider turn is used.

`AssembledImportTests` additionally runs the real `launch.load_app()` and its
installed routes in an isolated child process. It refuses missing and valid
agent credentials on the import endpoint, imports a synthetic SQLite source,
checks recovery persistence at the turn-admission boundary, retains idle
queued mail, and reads the real chat endpoint before and after a fresh native
transcript appears. The normal watchdog scan observes the imported enabled
file watcher while leaving a paused control inert. Provider process creation
is forbidden and turn admission/watchdog delivery are recorded instead of
calling providers. Source hashes remain unchanged throughout. This is actual
ASGI engine-route evidence; the separate rendered Settings tests use mocked
HTTP and are not by themselves proof of a native desktop import.
