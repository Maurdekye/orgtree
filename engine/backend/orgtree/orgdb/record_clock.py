"""Durable clock publication through the normal deferred change flush.

The clock singleton serializes clock workers only. Source writers never take
it; source reads take no row locks. Changes belong to this transaction, and
the commit flush takes the revision last. Advancing the checkpoint and naming
crossings commit together, so retry/restart cannot strand an old cursor.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .record_time import Plan, Record


@dataclass(frozen=True)
class Published:
    watermark: datetime
    next_at: datetime | None
    records: frozenset[Record]


def publish(raw, *, candidates=None) -> Published:
    """Own one READ COMMITTED transaction, including candidate source reads.

    Providers take this explicit connection and return Boundary instances.
    They cannot check out a different snapshot. The optional provider also
    gives panel extensions a seam for testing their clock dependencies.
    """
    import psycopg  # noqa: PLC0415
    from .record_time_sources import boundaries  # noqa: PLC0415
    if raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
        raise ValueError('record clock must own its transaction')
    with raw.transaction():
        raw.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        watermark = raw.execute('SELECT watermark FROM orgtree.record_time_state '
                                'WHERE singleton FOR UPDATE').fetchone()[0]
        now = raw.execute('SELECT clock_timestamp()').fetchone()[0]
        plan = Plan((boundaries if candidates is None else candidates)(raw))
        due = plan.due(watermark,now)
        for entity,key in sorted(due):
            raw.execute('INSERT INTO orgtree.changes(xid,entity,entity_id) '
                        'VALUES (pg_current_xact_id(),%s,%s) ON CONFLICT DO NOTHING',
                        (entity,key))
        raw.execute('UPDATE orgtree.record_time_state SET watermark=GREATEST(watermark,%s) '
                    'WHERE singleton', (now,))
        # A backwards clock never republishes an already consumed crossing.
        return Published(max(watermark,now),plan.next(max(watermark,now)),due)
