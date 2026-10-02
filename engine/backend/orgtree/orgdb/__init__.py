"""One PostgreSQL database per org, plus a minimal app database.

The design is ``docs/state-system/pg-data-model-design.md`` (rev 7.1). Until
landing step 3 the new storage sits behind a switch: ``ORGTREE_STORAGE=orgdb``
turns it on for tests and rehearsals, and without it the engine keeps using
today's database, so every reader that is not ported yet keeps working.

Module map (each owns its part; only ``lifecycle`` ever holds the admin
connection, design §2.11 / Q10):

  names      database names from one prefix
  conn       connections to a named database, from a base conninfo
  migrate    the app and org migration folders, one database at a time
  lifecycle  the registry's claims, create, fences, unavailable and retry
  registry   the runtime's reads of the registry
"""

from __future__ import annotations

import os

SWITCH_ENV = "ORGTREE_STORAGE"
SWITCH_ON = "orgdb"


def enabled() -> bool:
    """True when the one-database-per-org storage is switched on."""
    return os.environ.get(SWITCH_ENV, "").strip().lower() == SWITCH_ON
