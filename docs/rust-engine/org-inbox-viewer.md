# Org inbox viewer

User 2026-10-12 08:41Z made Hubchat the canonical human hub-mail client and requested removal of the org-inbox Compose mail button and feature. The Orgtree window now reads the retained inbox and sent records, shows attachments and recorded reply quotes, marks incoming mail read, navigates older mail by reference, and displays mailservers and transfers. Human outside replies were another composition entry point and are removed with the modal.

The renderer no longer exports human send/upload or saved-draft API helpers. The engine no longer registers `/org_inbox/send`, `/org_inbox/upload`, `/org_inbox/upload_limit`, or any `/org_inbox/staging` route. They return 404, including legacy clients that still try them. These endpoints had no other production caller. No substitute human route or Hubchat launch flow was added.

Agent `orgtree_message`, same-org human-to-agent sends and contextual internal reply composers retain their existing paths. Shared transport, transfer inspection/control, audience admission and the engine-local disabled-inbox boundary are unchanged. The old human-only quote helper and HTTP staging module are removed; agent and incoming reply-quote helpers remain.

No database migration or record/file deletion is needed. Existing org-inbox entries, upload metadata, completed staging records, downloaded files and accepted transfer jobs retain custody. Domain staging cleanup stays for interrupted legacy uploads and preserves completed files. Disabled history and file access restore on re-enable. Stored pin configuration is not rewritten. The historical compose scenarios in the modal-pin browser probe are retired; its org-inbox title fixture remains a viewer.

## Measured verification

- Final `cargo build --locked -p orgtree-engine --bin orgtree-engine -j2` and matching `cargo check` pass under the shared lock. No warning in final outputs.
- Root TypeScript check passes with external dependency resolution, without source dependency copies or junctions.
- Six contained mounted renderer suites pass 73/73: viewer, mailwire, closemenu, composerparity, attachenable and replyinstant. The new viewer assertion fails on exact predecessor 2ef0122 because compose/reply controls exist. The predecessor check uses git-object source overrides, not a modified checkout.
- Disposable native viewer proof passes 16/16, including all nine retired method/route combinations returning404, retained human-row body/quote/attachment access, same-org user/agent sends, disabled access and restoration without new records or deletion.
- Adapted isolation proof passes32/32; file8/8, hidden-mail8/8 and inspection-count12/12 pass after replacing retired human setup sends with agent tool calls or explicit retained-upload fixtures. All eight concurrency schedules observed disable winning; this does not prove send-winning timing.

Renderer runs use the repository Job Object limiter with a2048MB aggregate ceiling,60second tree deadline and512MB V8 heap. Earlier custom runs were interrupted and are not passing evidence; their memory incident is separately recorded and preserved for the incident owner. The first native check attempt refused low RAM before acquiring the lock; final check ran after recovery.

## Limits

No live mail, settings, provider, installed-app, package, device or hub change was performed. This is source/native/contained-DOM verification, not installed-app acceptance. The mailhub-v2 proof is adapted to agent attachment/reply setup and syntax checked; its loopback transport and optional1GiB case were not rerun for this removal. The historical Python browser probe edits are source checked, not executed. Previously copied transcripts/provider content cannot be recalled by removing a composer.
