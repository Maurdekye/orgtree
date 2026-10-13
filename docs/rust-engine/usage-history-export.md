# Usage history export

User 2026-10-13 requested CSV and JSONL downloads in place of each series card's
table, and removal of the chart's current-time vertical line. The footer now
offers CSV and JSONL. Reset markers, next reset, hover crosshair, end dot and the
shaded future area retain their existing behavior.

Each export takes the same `m.segments.flat()` measured points the table used.
These are the response's displayed/downsampled first/last observations; exports
do not invent missing observations, expand aggregates into unavailable raw
samples, or include projections. The selected period and filters remain the
authority for which cards and readings are shown. Fields in both formats are
`timestamp`, `value`, `provider`, `account`, `window`, `group`, `model`, `kind`
and `unit`. Timestamps are ISO-8601 UTC; values retain numeric precision. Empty
model scope remains an empty string (every model), unknown unit remains null in
JSONL and empty in CSV. A nonfinite or missing numeric value is null/empty,
never zero. Rows are chronological.

CSV uses a header, CRLF records and RFC 4180 quoting; JSONL uses one JSON object
per LF-terminated line. Blobs use UTF-8 content types and the app's existing
anchor download path, with the anchor created in the clicked button's document.
That supports the main window and adopted popouts without a new IPC capability
or an engine endpoint. The filename contains bounded filesystem-safe provider,
account, window, group and model components plus selected period dates, ending
at the response's `until` (not the future projection horizon).

The recording/retention engine, HTTP response, chart model and statistics are
unchanged. Cards without numeric observations continue to show the existing
empty-series explanation; no phantom reading is created for export.

## Focused verification

`apps/desktop/renderer/tests/usagehistoryexport.test.ts` checks precision, UTC,
chronology, identity, CSV quoting, JSONL equivalence, nulls/zeros, filenames,
empty data and main/child-document download custody. Existing `usagehistory`
tests run against base `62f39ad` and the implementation.

`tools/usage-export-verify.mjs` bundles those tests, runs the existing source
typecheck and a hidden offscreen Electron fixture around the actual modal,
popout and native window/session configuration. Native pointer/Enter activation
downloads each format in both windows to synthetic paths, and checks the saved
bytes, filtered account/selected-period identity and retained chart features.
The probe creates screenshots `main.png` and `popout.png`. No real account,
engine, browser/network send, live data, app build or installer is involved.

Invoke the runner under `apps/desktop/renderer/tests/joblimit.ps1` with a 2048 MB
kernel Job, 180-second deadline and 512 MB Node heap. It takes the shared build
lock in queue order and resolves the existing dependencies on E without links
or copies. `USAGE_EXPORT_BUILD` must be under
`C:\orgtree-build\hubchat-dm-sol\`; `USAGE_EXPORT_STATE` must be under
`D:\orgtree-work\rig\hubchat-dm-sol\`. Set TEMP/TMP to the owned C temporary
directory and `ORGTREE_AGENT=hubchat-dm-sol`.

First measured phase at `b2e8026`: existing tests **8/8 at base** and focused
tests **15/15 at tip** (eight existing plus seven new, no skips), exit 0 each.
The runner then stopped before typecheck or Electron on a package-export lookup
error for `typescript/bin/tsc`. Runner-only correction `7781a39` uses the
dependency's direct executable path and allows `--remaining` to resume those
unperformed checks without repeating passed tests. Initial test logs are
retained under the owned C `usage-export` output. Shared lock handed on normally.

Second phase at `6fe462e`: source typecheck passed (exit 0). The actual modal
rendered the export footer, reset/future/end/next-reset marks and crosshair with
no table or current-time rule. Main CSV native download completed and matched
all four exact filtered readings and identity fields. Overall **8/9**, exit 1:
the unfocused hidden window did not activate JSONL through keyboard input, so
that stage timed out before popout checks. No JSONL/popout pass is claimed.
Partial receipt is preserved at
`D:\orgtree-work\rig\hubchat-dm-sol\usage-export\partial-1906\result.json`.

Test-only correction `a212efa` focuses the native window before sending input,
matching the earlier HTTPS proof's native input setup. Only remaining renderer
verification is queued; production code and passed serializer/typecheck inputs
are unchanged. Native Save-dialog interaction with a person and the installed
artifact are outside this synthetic proof.
