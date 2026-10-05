# Orgtree 3.2.0-alpha.2 (local test build)

Local test build of the 3.2.0 data-model rewrite. Not published.

Changes since 3.2.0-alpha.1:

- Startup is more reliable: database upgrades and the conversion of large orgs get enough time to finish, and links between docket items are checked before the schema is updated.
- Fewer stalls and outages: background heartbeats, account checks and provider checks reuse idle database connections instead of taking the app's, and engine logging no longer stalls the engine.
- The org tree now updates from a live record feed instead of reloading the whole tree.
- Automatic compaction retries when it collides with other work, reports engine failures, and only switches to the successor agent once the compaction is saved.
- Inbound mail from other orgs reaches the right agents and keeps its receipts.
- Desk windows keep their temporary size and position when pinned or popped out, and the ring list and jump cards follow counterclockwise order.
- The repository now has an AGENTS.md guide and refreshed README screenshots.
