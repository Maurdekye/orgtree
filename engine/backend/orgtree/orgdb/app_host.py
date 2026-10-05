"""Ordered app copies and active-span reads (step-6 addendum section 5).

Runners belong to the event loop; read callbacks do their SQL in workers.
The lock covers clock assignment, stored values and every complete copy.
Neither SQL nor an awaited socket send runs under that lock.
"""
from __future__ import annotations

import asyncio
import copy
import threading
import time
from dataclasses import dataclass

from .record_runtime import HOST_CLOCK
from .record_transport import CoalescedRunner, FrameQueue


class AppReplaced(RuntimeError):
    """An app replacement requires a new engine run, hence a new host epoch."""


@dataclass(frozen=True)
class Span:
    row: dict


class AppHost:
    def __init__(self, read_registry, read_org, error, *, clock=HOST_CLOCK,
                 interval=1.0, monotonic=time.monotonic, sleep=asyncio.sleep):
        self.clock, self.error = clock, error
        self.read_registry, self.read_org = read_registry, read_org
        self.interval, self.monotonic, self.sleep = interval, monotonic, sleep
        self.lock = threading.RLock()
        self.registry = None
        self.summaries, self.notices = {}, {}
        self.values, self.working = {}, {}
        self.spans, self.runners, self.last_read = {}, {}, {}
        self.clients = set()
        self.invalid = False
        self.closed = False
        self.retries = {}
        self.refresh = CoalescedRunner(self._registry_read, self._registry_failed)

    def _retry(self, key, wake):
        if self.closed or self.invalid or key in self.retries:
            return
        def retry():
            self.retries.pop(key, None)
            if not self.closed and not self.invalid:
                wake()
        self.retries[key] = asyncio.get_running_loop().call_later(self.interval, retry)

    def _registry_failed(self, exc):
        self.error(exc)
        self._retry(None, self.refresh.wake)

    def _org_failed(self, key, exc):
        self.error(exc)
        if key in self.spans:
            self._retry(key, lambda: self._wake(key))

    def _wake(self, key):
        if key in self.spans and key in self.runners:
            self.runners[key].wake()

    def _prune(self, key, runner):
        # Do not cancel an in-flight worker: to_thread SQL would still run.
        # A replacement span must keep using that same serialized runner.
        if key not in self.spans and self.runners.get(key) is runner:
            if runner.task is not None:
                runner.task.add_done_callback(lambda _: self._prune(key, runner))
                return
            self.runners.pop(key, None)
            self.last_read.pop(key, None)
            timer = self.retries.pop(key, None)
            if timer is not None:
                timer.cancel()

    def _send(self, frame):
        for queue in tuple(self.clients):
            if not queue.offer(frame):
                self.clients.discard(queue)

    def _check(self):
        if self.invalid:
            raise AppReplaced('app identity changed within this host epoch')
        if self.closed:
            raise RuntimeError('app host is closed')

    def _copy(self):
        self._check()
        return copy.deepcopy(dict(type='app_snapshot', **self.clock.stamp(),
            registry=self.registry, summaries=self.summaries, notices=self.notices,
            runtime=dict(values=self.values, orgs=self.working)))

    async def ready(self):
        if self.registry is None:
            self.refresh.wake()
            await self.refresh.idle()
        self._check()
        if self.registry is None:
            raise RuntimeError('app registry is not ready')

    async def full(self):
        await self.ready()
        with self.lock:
            return self._copy()

    async def connect(self, **limits):
        await self.ready()
        queue = FrameQueue(reset=False, **limits)
        with self.lock:
            queue.offer(self._copy())
            if not queue.closed:
                self.clients.add(queue)
        return queue

    def disconnect(self, queue):
        with self.lock:
            self.clients.discard(queue)
            queue.close()

    async def _registry_read(self):
        cursor, records = await self.read_registry()
        with self.lock:
            self._check()
            old = self.registry
            if old is not None:
                before = old['cursor']
                if any(before[k] != cursor[k] for k in ('app_uuid', 'incarnation')):
                    self.invalid = True
                    for queue in self.clients:
                        queue.close()
                    self.clients.clear()
                    raise AppReplaced('restart required after app replacement')
                if cursor['rev'] <= before['rev']:
                    return
            active = {str(r['id']): r['body'] for r in records
                      if r['body']['state'] == 'active'}
            for key, span in tuple(self.spans.items()):
                row = active.get(key)
                if row is None or any(row[k] != span.row[k] for k in ('slug', 'org_uuid')):
                    del self.spans[key]
                    self._remove(key, span)
                    self._prune(key, self.runners[key])
            self.registry = copy.deepcopy(dict(type='registry_snapshot',
                epoch=self.clock.epoch, cursor=cursor, records=records))
            # Even equal bodies must publish a newer complete registry.
            self._send(self.registry)
            for key, row in active.items():
                if key not in self.spans:
                    self.spans[key] = Span(copy.deepcopy(row))
                    if key not in self.runners:
                        self.runners[key] = CoalescedRunner(
                            lambda key=key: self._org_read(key),
                            lambda exc, key=key: self._org_failed(key, exc))
                    self.runners[key].wake()

    def _remove(self, key, span):
        stamp = dict(org_id=span.row['org_id'], org_uuid=span.row['org_uuid'],
                     incarnation=None, rev=None)
        for values, kind, field in ((self.summaries, 'org_summary', 'body'),
                                    (self.notices, 'org_notices', 'notices')):
            previous = values.pop(key, None)
            identity = stamp if previous is None else {k: previous[k] for k in stamp}
            self._send(dict(type=kind, **identity, **self.clock.stamp(), **{field: None}))
        if key in self.working:
            del self.working[key]
            self._send(dict(type='app_runtime', **self.clock.stamp(), orgs={key: None}))

    def observed(self, slug, rev=None, gap=False):
        # Reconnect identity checks precede numeric revision checks upstream.
        # Do not suppress this wake by comparing with a former org's revision.
        for key, span in tuple(self.spans.items()):
            if span.row['slug'] == slug:
                self.runners[key].wake()

    async def _org_read(self, key):
        delay = self.last_read.get(key, -float('inf')) + self.interval - self.monotonic()
        if delay > 0:
            await self.sleep(delay)
        span = self.spans.get(key)
        if span is None or self.closed or self.invalid:
            return
        self.last_read[key] = self.monotonic()
        result = await self.read_org(span.row)
        with self.lock:
            if self.spans.get(key) is not span or self.closed or self.invalid:
                return
            if result['org_uuid'] != span.row['org_uuid']:
                return
            identity = {k: result[k] for k in ('org_uuid', 'incarnation', 'rev')}
            for values, kind, field in ((self.summaries, 'org_summary', 'body'),
                                        (self.notices, 'org_notices', 'notices')):
                old = values.get(key)
                if old is not None and all(old[k] == result[k]
                        for k in ('org_uuid', 'incarnation', field)):
                    continue
                frame = dict(type=kind, org_id=span.row['org_id'],
                             **identity, **self.clock.stamp(), **{field: copy.deepcopy(result[field])})
                values[key] = frame
                self._send(frame)

    def runtime(self, *, values=None, orgs=None):
        """Partial value updates; orgs is a complete supervisor working map."""
        with self.lock:
            self._check()
            changed, working = {}, {}
            for key, value in (values or {}).items():
                old = self.values.get(key)
                if old is None or old['value'] != value:
                    changed[key] = dict(**self.clock.stamp(), value=copy.deepcopy(value))
                    self.values[key] = changed[key]
            if orgs is not None:
                for key in self.spans:
                    value = orgs.get(key, {'working': 0})
                    old = self.working.get(key)
                    if old is None or old['working'] != value['working']:
                        working[key] = dict(**self.clock.stamp(), working=value['working'])
                        self.working[key] = working[key]
            if changed or working:
                self._send(dict(type='app_runtime', **self.clock.stamp(), values=changed, orgs=working))

    async def idle(self):
        await self.refresh.idle()
        await asyncio.gather(*(r.idle() for r in self.runners.values()))

    async def close(self):
        with self.lock:
            self.closed = True
            for timer in self.retries.values():
                timer.cancel()
            self.retries.clear()
            for queue in self.clients:
                queue.close()
            self.clients.clear()
        await self.refresh.close()
        await asyncio.gather(*(r.close() for r in self.runners.values()))
