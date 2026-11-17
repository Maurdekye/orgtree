# Agent Files tab

USER 2026-10-23 07:59:47Z requested a per-agent Files tab listing every
presented download card; 08:00:58Z selected the release after 4.4.2.

The shared domain reader uses existing ot.deliveries rows and deliveries_agent
(agent_id, id DESC). Every page also checks org_id. It fetches at most limit+1
rows, with a positive id cursor and limit 1..100 (default 50). No migration or
backfill is needed. Stable agent_id attribution preserves history after rename
and retirement; delivery_id retries remain deduplicated by send_file.

GET /api/orgs/{slug}/agents/{node}/files serves the user. Deferred inspection
tool orgtree_files uses the same reader after the usual self/descendant check,
passing through projects. Projects and unrelated agents refuse. The reader
does not read a transcript, touch snapshots or mutate delivery state. File
downloads retain existing snapshot-path authorization. Hub transfer jobs are
separate and intentionally excluded.

The agent desk Files tab uses compact rows in chronological display order:
newest at the bottom, opening there, with name, size, time, snapshot Download
and image View. The filename hover retains the delivery note. Scroll-up loads
older pages automatically, retaining a visible-row anchor. Live pages merge
without discarding older rows; the view follows new arrivals only at the bottom.
A live bump during a request queues a refresh; multi-page arrival bursts catch
up to the retained history before merging. Refresh resets to the latest page.
Mounted Files readers also observe the accepted org record cursor: record-mode
WebSocket commits bypass the legacy live bump. These commits merge the newest
file page in place, including in popouts; runtime-only publications do not read
files again. Use actual record commits without bumpLive in regression fixtures.
The API/tool retain their newest-first paging contract. Older metadata does not
imply externally removed bytes exist. Project placement is unchanged.
[decided: user 2026-10-24 m07dbc1323f5b, me76bad5e5bc4; verified:
canvas/files.tsx, tests/files.test.tsx]

[verified: domain/deliveries.rs, tools/orgview.rs, http/docs.rs; 2026-10-23]

## Detached downloads and image Escape (2026-10-25)

Files filename and Download links do a HEAD check in the authoritative main renderer
(so an engine refusal shows beside the link), then click a plain anchor: Electron's own
download (main/remote-downloads.ts, `will-download`; the same handler as the Files panel
of a remote organization) streams the file to the place the user picks in the Save dialog.
No Blob of the file is made, so the only size limit is the engine's 32 GiB send cap.
Portal request authentication stays restricted.
The image viewer captures Escape in its own document, ahead of a detached
surface's bubbling boundary; matching cleanup prevents a stale key listener.
One Escape closes the viewer without closing its desk or another document.
[verified: canvas/{files,filedownload,lightbox}.tsx/ts; tests/filespopout.test.tsx]

The image viewer's download link uses the same native download as the file cards,
including in a separate window.
