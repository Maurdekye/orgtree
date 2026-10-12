# Org-inbox isolation

User rulings (2026-10-12): the Orgtree engine stops an external message before it leaves a disabled org or contacts a hub. Sends fail before queue admission. Retained inbox history is hidden from humans and agents until re-enabled, as is the canvas inbox node. Same-org agent/user correspondence remains available. Preserve stored records, audiences and network identity.

The initial proposed hub protocol extension was **superseded** by the user's 06:10 clarification. No hub source, migration, registration protocol or remote acceptance contract changes belong to this task. The pinned hub2.1.1 does not know this engine-local policy; do not describe local isolation as a rejection received by an unrelated sender at its hub.

## Implementation boundaries (in progress)

- Check persisted org-local settings before outside send admission and all inbox reads. Missing settings retain enabled behavior.
- Local sender/recipient admission takes their org rows in ascending ID order. Retained records and all recipient copies publish atomically; the settings writer uses the same org row lock.
- Each org has a separate external-I/O cancellation gate. Setting changes cancel existing leaf I/O futures and wait for them to drop before committing. Every new HTTP request checks persisted policy after admission. No database transaction spans network I/O; unrelated orgs do not share a lock.
- Removing an org from active polling preserves its registry/identity and owed custody receipts. Already accepted durable messages remain stored. Requests refused before queue admission have no row to revive on re-enable.
- Already dispatched requests may have reached the remote server before cancellation; remote acceptance cannot be undone. Previously supplied content cannot be erased from a recipient's memory or external copies.

This branch is not ready to integrate until worker, attachment, actor/manual-history and re-enable controls have been proved. The initial setting/canvas changes alone are not isolation enforcement.
