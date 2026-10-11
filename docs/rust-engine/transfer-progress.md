# Attachment transfer implementation and verification

This branch adds durable file transfers while keeping a message queued until all of its files are ready. Success changes transfer state without sending notices. Terminal failures produce one user notice and one mail per involved agent; intentional user cancellation is silent.

## Browser staging

`POST /api/orgs/{slug}/org_inbox/staging` creates a ticket before bytes flow. The body supplies `name`, `bytes`, `to`, and an optional draft identifier used to aggregate local failure notices. `POST .../staging/{id}` streams the raw bytes. Only a successful flush, sync and database commit creates a usable `ot.uploads` entry. `GET` recovers an ambiguous completion response. `DELETE` persists user cancellation before interrupting the body reader.

The browser reports bytes sent separately from confirmation. Compose and reply block Send while a chosen file is pending, failed or cancelled. Retry starts a new local ticket; a browser cannot persist its File object across reload. Closing a composer leaves its request running, and the resulting ticket remains recoverable. Explicit Cancel and Remove abort the request after persisting cancellation intent.

`GET .../staging?after=<id>` pages saved metadata, without filesystem paths. Saved local files lets the user explicitly attach a completed file to a new draft, or see why an interrupted file needs to be selected again. It does not restore message text or automatically attach files to unrelated drafts. Successful sends hide their saved entries. `POST .../staging/{id}/dismiss` hides an entry without deleting bytes a queued message might own.

Cleanup checks at most 32 tickets every five seconds, with a keyset cursor so active or undeletable files cannot starve later records. It preserves live writers, marks interrupted writers and queued tickets older than 24 hours failed, and removes partial bytes outside the transaction. A failed removal keeps a retryable cleanup record. Published files are not part of this partial-file sweep.

Local failure intent commits with failure state. Draft failures create only a user notice, since no receiving or sending agent is involved yet. The shared dispatcher inserts notices and their delivery marker atomically. Cancellation does not overwrite an existing failure or erase its notice. Completing a file never creates a notice.

## Verification and remaining work

The disposable rig proof is `tools/rig/proofs/local-staging.mjs`, with real HTTP bodies, PostgreSQL, engine restarts, a throttled offscreen desktop, and explicitly aged scratch records. It covers send gates, one writer, stalled cancellation, lost completion responses, reload/reselection, saved-file pagination, failure aggregation, live-writer expiry exclusion and retry after a filesystem cleanup error. Runtime results belong in the docket evidence; this document is not itself a test result.

The wider feature is still in progress: send-result transfer identifiers, eligibility and inspection bounds, integration rebase, Hubchat work, and joint 1 GiB / interrupted socket / process restart / Android device acceptance remain. A small-file or graceful-restart proof does not establish those acceptance results.
