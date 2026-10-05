# Orgtree 3.2.0-alpha.1 (local test build)

Local test build of the 3.2.0 data-model rewrite. Not published.

Changes since 3.2.0-alpha.0:

- Moving an agent to a new place in the tree is now fast however large the org is, and the tree stays consistent while other work happens at the same time.
- The agents and docket data now use the reviewed final layout, and the conversion from older versions fills it in and checks it against the old data.
- Turns are queued and admitted through the database, so a turn is not lost or run twice when the app restarts or an agent is interrupted, retired or compacted.
- The engine runs at High priority on Windows every time it starts.
- The agent gallery and desk open faster and no longer stall on slow disk reads.
- Importing a transcript with missing details no longer fails.
- Agents' background context includes the mail hub's identity and status again.
