# engine/backend/orgtree — third-party Python dependencies added by PYPG

| Package | Version (tested) | Licence | Purpose |
|---|---|---|---|
| `psycopg[binary]` (psycopg + psycopg-binary) | 3.3.6 | LGPL-3.0-only | PostgreSQL driver for `ORGTREE_STORE=postgres` (`pgstore.py`) and `org_tx`'s PostgreSQL backend (`orgtx.py`). The binary wheel bundles libpq, so the runtime needs no PostgreSQL client install. Imported only when the postgres backend is selected. |
| `tzdata` (psycopg dependency on Windows) | 2026.4 | Apache-2.0 | Time zone data psycopg needs on Windows. |

Declared in `tools/runtime-requirements.in`; `tools/provision-runtime.py` resolves and stages it. psycopg is used as an unmodified dynamically imported library (LGPL-compatible use).
