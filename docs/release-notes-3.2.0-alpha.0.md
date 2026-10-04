# Orgtree 3.2.0-alpha.0 (local test build)

Local test build of the 3.2.0 data-model rewrite. Not published.

- Each org now has its own PostgreSQL database, and the new storage is on by default.
- On first launch, existing data (from 2.1.x, 3.0.x or 3.1.0) is converted into the new layout. The old data is left untouched, so the previous version can still be reinstalled on it.
