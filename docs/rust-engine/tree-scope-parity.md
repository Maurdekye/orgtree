# Tree, scope and Claude launch parity (P51–P57)

2026-10-07. Reference: Python engine on `origin/dev` at `4ddbfb1`, particularly
`ledger.py`, `api.py::_hire_seat`, `statepreview.py`, and `supervisor.py::clean_env`.
Composed on outage-astra's staffing restoration, integrated as `2eb8321`.

| Finding | Result | Restored behavior |
| --- | --- | --- |
| P57 | Fixed first | `ClaudeProc::spawn` removes inherited `CLAUDE_CODE_*` and `CLAUDECODE` before applying the authorized launch environment. Ordinary/profile/OpenRouter launches cannot inherit the host OAuth override. An explicitly selected OAuth account can still inject its own token afterward. Values are never logged by the cleanup. |
| P51 | Fixed | Accept 1–20 moves; refuse an oversized list before applying its first move. Execute all accepted moves in the existing operation transaction. Return the moved count alongside individual results. |
| P52 | Fixed | An omitted hire account uses a valid, provider-compatible org default, otherwise provider primary. It never inherits the parent's account. Explicit unknown/wrong-provider accounts are refused; explicit empty/primary selects primary. |
| P53 | Fixed | Superior placement checks authority over the target, accepting the caller itself or its descendants. Above a top-level seat remains user-only. The hire and staffing tools default an omitted superior target to the caller. Rehire uses the same placement rule; its already-authorized override/rename step survives the topology change. |
| P54 | Fixed with batch 1 composition | Both new and restored superiors inherit the target's effective folders, tools/MCP, visibility and permission mode. Conflicting explicit capability fields are refused. Effort and other independent hire/rehire choices remain separate. |
| P55 | Fixed; visibility amended by user 2026-10-07 08:28Z | Inspection returns actor, effective visibility and nodes with free credits, archive timestamp, effective permission/tools/MCP, safe account binding facts and pending model switch fields. Explicit hidden/missing/excluded archived targets are refused. Scope and visibility use one repeatable-read structural snapshot fetched in pages of 256. Visibility is the chart-visible set plus the caller's entire subtree, even at self visibility; this supersedes the narrower 3.x inspection contract. |
| P56 | Fixed | Retool validates supplied capability axes against the caller's effective grant. Valid deep grants raise only the affected axes of intermediate managers, name them in `cascaded`/warnings and notify/reconfigure affected branches after commit. Shrinks are stored on descendants so a later move cannot revive revoked grants. User grants reaching the top also enter org defaults. Folder containment normalizes dot segments, matching 3.x `normpath`. |
| Already archived retirement | Fixed | An authorized retire of an already archived seat succeeds with zero freed credits and a no-op explanation. Rescind retains its separate user-only behavior. |

No listed finding is dismissed as not applicable. Removed knowledge-bearer fields are not
reintroduced in inspection (PLAN B1); raw account handles, prompt/status prose and session
contents are not exposed by that diagnostic.

## Verification

Measured: `cargo check --offline -j 2` passes in the owner's E: target directory after
composition. A standalone, secret-free smoke uses the actual Claude environment-cleanup
block with synthetic markers: inherited host overrides are removed and an explicitly
selected account's token can be installed afterward. No CLI or provider is launched.

A small standalone Rust smoke copies the actual scope and inspection helpers (removing only
logging attributes). It exercises folder/tool/MCP/visibility/permission refusals, selective
ancestor raising, effective-scope folding, team/subtree inspection visibility, cyclic-chain
refusal, and dot-segment containment. All assertions pass. This is a brief smoke, not a
database integration suite.

Source checked, not runtime measured: PostgreSQL operation atomicity, topology changes,
credit effects, live account selection, cascade publications and the inspection SQL. No live
database, installation, restart or full test suite was used. The coordinator integrates and
builds this branch.
