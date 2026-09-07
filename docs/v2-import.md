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

Agent names and generations stay stable. Every imported node receives a new
provider session ID, and copied Codex thread / Antigravity conversation IDs,
process IDs, remote-control PID records and cache continuity claims are
cleared. Reusing those IDs would make V2 resume mutable provider state that
V1 still owns. Native provider session and prompt-cache continuity are **not
retained** by this MVP importer.

Provider-neutral journal transcripts are copied. For Claude, the importer
also looks for the exact selected session under the V1 data folder's sibling
`.claude/projects` directory. It does not copy authentication or an entire
profile. A custom profile elsewhere is not inferred; an absent transcript is
explicitly reported as unavailable, while all copied organization history
and scratch remain readable. Copied history is stored under
`imports/<slug>/history/<node>.jsonl`, and its path plus original session ID
are recorded in `node.desktop_import`.

The engine owner wires:

```python
desktop_import.configure(on_imported=recover_imported_organization)
api.app.include_router(desktop_import.router)
```

The synchronous callback receives only the committed `slug`; it must use
the existing engine's active-only recovery and uncertain-operation receipt
reconciliation, and persist the recovery result. No source provider process
may be resumed or terminated. Saved `inflight` records identify agents that
were active. Their recovery text states that this is a new session, names the
copied transcript when available, and asks them to inspect current work and
reconcile uncertain effects before any mutation. Merely queued mail does not
authorize waking an idle agent. Enabled automation remains in the document
for the V2 engine's normal scheduler to restore after publication.

`desktop_import.imported_history_path(org, nid)` is a read-only history-view
and recovery seam. It must not be used as a native provider resume path.
UI history must keep this copied history readable after the fresh session
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
