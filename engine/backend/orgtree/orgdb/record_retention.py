"""Atomic history pruning, with the revision singleton taken last.

Only committed, old history is removed. A reader's repeatable-read snapshot
therefore sees either the complete old log or the new floor, never half a log.
This function owns its transaction; host timers and future jobs use the same
kernel. It neither assigns a revision nor sends a notification.
"""
from __future__ import annotations

from dataclasses import dataclass
import asyncio
import math


KEEP_SECONDS = 24 * 60 * 60
KEEP_REVISIONS = 10000


@dataclass(frozen=True)
class Pruned:
    floor: int | None
    changes: int = 0
    revisions: int = 0


def prune(raw) -> Pruned:
    """Keep at least 24 hours AND the newest 10,000 revisions.

    Writers insert only their own xid/revision rows, so they never wait on the
    historical rows this transaction deletes. The singleton is the last write,
    after both deletes; a concurrent bulk reset can only raise its floor.
    """
    import psycopg  # noqa: PLC0415
    if raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
        raise ValueError('retention must own its transaction')
    with raw.transaction():
        raw.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        candidate = raw.execute(
            'SELECT max(h.rev) FROM orgtree.revisions h CROSS JOIN orgtree.org_revision r '
            'WHERE h.at < clock_timestamp() - make_interval(secs => %s) '
            'AND h.rev <= r.rev - %s AND h.rev > r.floor',
            (KEEP_SECONDS, KEEP_REVISIONS)).fetchone()[0]
        if candidate is None:
            return Pruned(None)
        changes = raw.execute(
            'DELETE FROM orgtree.changes c USING orgtree.revisions h '
            'WHERE c.xid=h.xid AND h.rev < %s', (candidate,)).rowcount
        revisions = raw.execute(
            'DELETE FROM orgtree.revisions WHERE rev < %s', (candidate,)).rowcount
        floor = raw.execute(
            'UPDATE orgtree.org_revision SET floor=GREATEST(floor,%s) RETURNING floor',
            (candidate,)).fetchone()[0]
        return Pruned(int(floor), changes, revisions)


def sweep():
    """Visit active orgs, including those without a tree/socket host.

    Registry checkout validates identity. An unavailable org does not prevent
    another org from pruning; an org without the record migration is skipped.
    Errors return to the event loop for the host's normal error reporting.
    """
    from . import registry  # noqa: PLC0415
    errors = []
    for slug in registry.active_slugs():
        try:
            with registry.connection(slug) as raw:
                if raw.execute("SELECT to_regclass('orgtree.revisions')").fetchone()[0] is not None:
                    prune(raw)
        except Exception as exc:
            errors.append(exc)
    return errors


class Timer:
    """Host staging for the prune job: start explicitly and await shutdown.

    A sweep runs immediately and then hourly, without a revision or a socket
    being needed. Shutdown stops the sleep and awaits any database transaction
    already running; it never abandons a background worker mid-prune.
    """
    def __init__(self, error, *, worker=sweep, interval=3600, retry=60):
        if any(type(n) not in (int,float) or not math.isfinite(n) or n <= 0
               for n in (interval,retry)):
            raise ValueError('invalid retention timer interval')
        self.error, self.worker = error, worker
        self.interval, self.retry = interval, retry
        self.stop = asyncio.Event()
        self.task = None

    def start(self):
        if self.task is None and not self.stop.is_set():
            self.task = asyncio.create_task(self._run())

    async def _run(self):
        while not self.stop.is_set():
            try:
                errors = await asyncio.to_thread(self.worker)
            except Exception as exc:
                errors = [exc]
            for exc in errors:
                self.error(exc)
            try:
                await asyncio.wait_for(self.stop.wait(),
                    timeout=min(self.interval,self.retry) if errors else self.interval)
            except asyncio.TimeoutError:
                pass

    async def close(self):
        self.stop.set()
        if self.task is not None:
            await asyncio.shield(self.task)
