# Attachment transfer implementation and verification

This branch adds durable file transfers while keeping a message queued until all of its files are ready. Success changes transfer state without sending notices. Terminal failures produce one user notice and one mail per involved agent; intentional user cancellation is silent.

## Retained browser staging records

Human composition and its browser staging API were retired on 2026-10-12; human hub mail is now composed in Hubchat. Existing upload metadata and completed bytes remain in place, including files owned by already accepted messages. No migration drops upload tables or deletes stored history. The bounded domain staging sweep remains to settle interrupted legacy uploads and clean only failed/cancelled partial bytes; it never sweeps completed files. See [the viewer contract](org-inbox-viewer.md).

## Queue admission and inspection

The message and outgoing transfer IDs commit together, before the send result returns. Tool responses carry those IDs with the queued message; agents can immediately inspect them with `orgtree_transfers`. Selecting a registered hub later binds the route without replacing IDs. A failed transfer insert rolls back the queued message too.

Queue admission scans at most 100 peer heads per pass and advances its cursor past held or unavailable peers, preserving order within each peer. Both schedulers filter eligible organization/hub/address tuples before selecting a job. A backlog for disconnected hubs cannot hide ready work; hub concurrency exclusion applies to both directions. Inspection lists unfinished work before completed history and returns at most 100 records with a `next_cursor`. The desktop has page controls, and agents pass that cursor to the list tool. Every page applies the same sender/audience restrictions.

## Recovery and identity boundaries

Outgoing transfer authority and failure recipients use the sender agent ID and generation captured at admission. Renaming an agent does not transfer its work to another agent taking that name. Older rows without a captured identity remain user-managed; no name-based identity is inferred.

Inbound publication commits the org-inbox entry and all selected holder mailbox copies in one short transaction. A failed holder insert rolls the whole publication back; retry after a crash following commit sees the existing inbox entry and does not duplicate mailbox copies. Wakes and feed changes follow commit.

If a crash leaves confirmed bytes equal to the expected total but no completed marker, the download revalidates the last byte and EOF using Range/If-Range. It does not repeatedly request an impossible range starting at the total.

`tools/rig/proofs/net-transfer-review.mjs` covers rename takeover and notice routing, failed second-holder insertion and replay across restart, the EOF checkpoint, and admission of new unbound work behind 150 held/unavailable peer heads.

## Verification and remaining work

The retired browser-staging proof is replaced by `tools/rig/proofs/org-inbox-viewer.mjs`, which checks absent human routes and retained record/file custody. Agent transport and transfer proofs remain separate.

The wider feature is still in progress: integration rebase, Hubchat work, and joint 1 GiB / interrupted socket / process restart / Android device acceptance remain. A small-file or graceful-restart proof does not establish those acceptance results.
