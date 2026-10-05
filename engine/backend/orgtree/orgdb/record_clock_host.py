"""Host scheduling for durable time crossings, including socketless orgs.

The loop owns scheduling state; a single worker owns database transactions.
Source notifications received during that worker remain dirty for its next
run. Shutdown wakes the sleep and awaits the worker rather than cancelling it.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
import math
import time

from . import record_clock, registry


@dataclass(frozen=True)
class Sweep:
    active: frozenset[str]
    deadlines: dict[str, datetime | None]
    failed: frozenset[str]
    errors: tuple[Exception, ...]


def sweep(slugs=None):
    """Validate each checkout and isolate failures; skip unmigrated orgs."""
    active = frozenset(registry.active_slugs())
    chosen = active if slugs is None else active.intersection(slugs)
    deadlines, failed, errors = {}, set(), []
    for slug in sorted(chosen):
        try:
            with registry.connection(slug) as raw:
                migrated = raw.execute(
                    "SELECT to_regclass('orgtree.record_time_state')").fetchone()[0]
                deadlines[slug] = record_clock.publish(raw).next_at if migrated is not None else None
        except Exception as exc:
            failed.add(slug)
            errors.append(exc)
    return Sweep(active,deadlines,frozenset(failed),tuple(errors))


class Timer:
    """Discover at startup/periodically; run at deadlines or source changes.

    Periodic discovery also bounds sleep after a host wall-clock adjustment.
    Starting a host makes no revision unless the durable watermark has crossed
    a source deadline. No socket or later org write is needed to publish it.
    changed() is called on the event loop, just like the revision observers.
    """
    def __init__(self,error,*,worker=sweep,discovery=60,retry=60,now=time.time,monotonic=time.monotonic):
        if any(type(n) not in (int,float) or not math.isfinite(n) or n <= 0
               for n in (discovery,retry)):
            raise ValueError('invalid record clock timer interval')
        self.error,self.worker,self.now = error,worker,now
        self.monotonic = monotonic
        self.discovery,self.retry = discovery,retry
        self.dirty = set()
        self.deadlines = {}
        self.retries = {}
        self.wake = asyncio.Event()
        self.stopping = False
        self.task = None

    def start(self):
        if self.task is None and not self.stopping:
            self.task = asyncio.create_task(self._run())

    def changed(self,slug):
        if not self.stopping:
            self.dirty.add(slug)
            self.wake.set()

    async def _run(self):
        discovery_at = 0
        while not self.stopping:
            stamp = self.now()
            elapsed = self.monotonic()
            discover = elapsed >= discovery_at
            chosen = self.dirty | {slug for slug,at in self.deadlines.items()
                                   if at is not None and at <= stamp}
            chosen.update(slug for slug,at in self.retries.items() if at <= elapsed)
            # Clear before dispatch, never after await: notifications during
            # the worker must schedule another run, even for the same slug.
            self.wake.clear()
            if discover or chosen:
                self.dirty.difference_update(chosen)
                try:
                    answer = await asyncio.to_thread(self.worker,None if discover else tuple(sorted(chosen)))
                except Exception as exc:
                    self.error(exc)
                    discovery_at = self.monotonic()+self.retry
                    for slug in chosen:
                        self.deadlines.pop(slug,None)
                        self.retries[slug] = discovery_at
                else:
                    stamp = self.now()
                    if discover:
                        discovery_at = self.monotonic()+self.discovery
                    self.deadlines = {slug:at for slug,at in self.deadlines.items() if slug in answer.active}
                    self.retries = {slug:at for slug,at in self.retries.items()
                                    if slug in answer.active and slug not in answer.deadlines}
                    self.deadlines.update({slug:None if at is None else at.timestamp()
                                           for slug,at in answer.deadlines.items()})
                    for slug in answer.failed:
                        self.deadlines.pop(slug,None)
                        self.retries[slug] = self.monotonic()+self.retry
                    for exc in answer.errors:
                        self.error(exc)
                continue
            waits = [discovery_at-elapsed,self.discovery]
            waits.extend(at-stamp for at in self.deadlines.values() if at is not None)
            waits.extend(at-elapsed for at in self.retries.values())
            try:
                await asyncio.wait_for(self.wake.wait(),timeout=max(0,min(waits)))
            except asyncio.TimeoutError:
                pass

    async def close(self):
        self.stopping = True
        self.wake.set()
        if self.task is not None:
            await asyncio.shield(self.task)
