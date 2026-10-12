# Org-inbox isolation

User rulings (2026-10-12): the Orgtree engine stops an external message before it leaves a disabled org or contacts a hub. Sends fail before queue admission. Retained inbox history is hidden from humans and agents until re-enabled, as is the canvas inbox node. Same-org agent/user correspondence remains available. Preserve stored records, audiences and network identity.

The initial proposed hub protocol extension was **superseded** by the user's 06:10 clarification. No hub source, migration, registration protocol or remote acceptance contract changes belong to this task. The pinned hub2.1.1 does not know this engine-local policy; do not describe local isolation as a rejection received by an unrelated sender at its hub.

## Implementation boundaries

- Check persisted org-local settings before outside send admission and all inbox reads. Missing settings retain enabled behavior.
- Local sender/recipient admission takes their org rows in ascending ID order. Retained records and all recipient copies publish atomically; the settings writer uses the same org row lock.
- Each org has a separate external-I/O cancellation gate. Setting changes cancel existing leaf I/O futures and wait for them to drop before committing. Every new HTTP request checks persisted policy after admission. No database transaction spans network I/O; unrelated orgs do not share a lock.
- Removing an org from active polling preserves its registry/identity and owed custody receipts. Already accepted durable messages remain stored. Requests refused before queue admission have no row to revive on re-enable.
- Already dispatched requests may have reached the remote server before cancellation; remote acceptance cannot be undone. Previously supplied content cannot be erased from a recipient's memory or external copies.

- Holder mailbox copies, manual recall/chunks, agent admission, user failure notices, history lists and attachment access apply the same policy. SQL filtering precedes pagination. A running turn already given content cannot be retroactively erased; no transcript or provider-context rewrite is attempted.
- Active feed mailbox windows are invalidated with org policy changes. The canvas removes the inbox, audience edges and an open inbox panel. The underlying records and grants remain stored.
- Retained accepted transfers can resume after enable; a refused send has no durable envelope to resume. Failure notices are published under the org admission lock. A failure creating an ancillary notice cannot turn an already-committed delivery into a reported send failure.
- An org's hub configuration remains editable. Connected/queue diagnostics do not reveal retained message errors/counts while isolated. The global hub probe is an app configuration action, not an org send.

## Bounded verification

The supported isolated rig uses fake CLI agents and a disposable database. `org-inbox-isolation.mjs` covers default-enabled delivery, both local directions, remote queue admission, human/API and agent/manual history, retained audiences, same-org/user mail, automatic actor intake, re-enable and concurrent bidirectional send/disable. `org-inbox-network-isolation.mjs` counts actual loopback HTTP from the production attachment workers and outbox drain, including stale participant snapshots, no calls while off, cancellation of an outstanding download, custody refusal, partial-file nonpublication and accepted-work recovery. No hub registration or real outside message is used.

The existing `org-inbox.mjs` proof checks enabled holder/fanout behavior. Native `net::isolation::tests` cover cancellation epochs, draining existing guards, blocking new admissions until a setting writer finishes, and independence between orgs. Renderer `mailwire` mounts the actual canvas/panel; `orginboxplace` covers placement. Typecheck and native compilation are separate checks.

These are isolated source-level proofs, not a live installation or remote-hub acceptance test. An HTTP request dispatched before disable may already have been accepted elsewhere. Historical content previously copied into an agent transcript or external file is not scrubbed; protected inbox/history routes stop serving their retained source records until enabled.
