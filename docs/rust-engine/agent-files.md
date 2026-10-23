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

The agent desk Files tab shows name, size, delivery time and note with the
existing file download/image behavior. Pages load on demand; refresh begins at
the newest page. Older metadata does not imply externally removed bytes exist.
Project presentations and their existing placement are unchanged.

[verified: domain/deliveries.rs, tools/orgview.rs, http/docs.rs; 2026-10-23]
