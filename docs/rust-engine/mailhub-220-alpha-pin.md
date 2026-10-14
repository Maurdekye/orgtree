# Local alpha bundled hub

Orgtree 4.3.0-alpha.0 adopts canonical mailhub
`1dcd3c7d9a1c03d89b81aa6ecefbe123782f8724`, version `2.2.0-alpha.0`.
This is a local alpha source pin, not a published standalone release.

The canonical merge retains approved picture/question source `33bb02d` and
released `2c22e3d`. Both already shared recovery runtime at `7290a59`; the
released-side difference was version metadata and recovery provenance.
The candidate's 56 runtime, test and migration blobs are identical to
`33bb02d`. Only version metadata and documentation changed; dependencies did
not. Eighteen static author checks passed and coordinator source/hash checks
confirmed the hand-in. Existing implementation reviews, explicit final-review
waivers and source-specific runtime receipts retain their original limits.

The existing schema-10 migration adds message metadata. First start on schema 9
migrates the hosted hub database; a 2.1.x hub then refuses it. A downgrade needs
a pre-migration backup and loses later mail. No automatic backup or downgrade
is added, and no live migration or rollback was performed for this adoption.

The designated builder must compile this exact hub, verify its version and
record its hash together with the Orgtree source and `mailhubCommit`. A source
pin alone is not proof that an installer includes it. Old 2.1.1 payloads must
not be reused. Publication, installation and live deployment remain separate.

## 2026-10-14: typing heartbeats

The pin moved to `959ed3769a4226509dfd940579b67591d05af5ba` (still version
`2.2.0-alpha.0`): six commits on `1dcd3c7` adding `/api/typing`, heartbeats
relayed to devices in use from memory and never stored (docs/typing.md in the
hub). Verified in rig-opus batch round 431: unit 7/7, integration incl. typing
2/2, load test ok, clippy only pre-existing warnings. No schema change.
