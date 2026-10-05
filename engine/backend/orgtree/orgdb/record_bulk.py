"""Transaction-local capture suspension for conversion and bulk rewrites."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator


@contextmanager
def writer(raw: Any, *, new_database: bool = False) -> Iterator[None]:
    """Caller owns a READ COMMITTED transaction. A rewrite invalidates cursors.

    New converter databases retain revision zero. Restoring the previous GUC
    also permits ordinary writes later in the same transaction. No commit or
    row lock occurs here; the deferred change flush owns the revision.
    """
    previous = raw.execute("SELECT current_setting('orgtree.capture',true)").fetchone()[0]
    raw.execute("SELECT set_config('orgtree.capture','off',true)")
    try:
        yield
        if not new_database:
            raw.execute('SELECT orgtree.invalidate_cursors()')
    finally:
        from psycopg.pq import TransactionStatus   # noqa: PLC0415
        if raw.info.transaction_status != TransactionStatus.INERROR:
            raw.execute("SELECT set_config('orgtree.capture',%s,true)", (previous or '',))
