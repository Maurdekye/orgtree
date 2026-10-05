"""Org host lifecycle shared by HTTP reads and the socket record runner.

Workers return snapshot inputs only. All supervisor sampling, clock stamps and
publication happen synchronously on the event loop after cursor validation.
The registry and revision subscribers are also extension points for B4b/c.
"""
from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass, replace
from typing import Any, Callable, Mapping

from . import record_reads as Q, record_tree as tree
from .record_registry import Registry, Selection, Snapshot
from .record_runtime import SupervisorOverlays
from .record_transport import Batch, OrgRunner, read_snapshot


REGISTRY = tree.register(Registry())


class RevisionSubscribers:
    """Event-loop callbacks for every observed local/foreign/gap revision.

    A failing subscriber never strands another subscriber or the org runner.
    Register at startup; the returned function removes that exact callback.
    The listener thread schedules ``observed`` on the host event loop.
    """
    def __init__(self, error: Callable[[Exception], None]):
        self.callbacks: list[Callable[[str, int, bool], None]] = []
        self.error = error

    def subscribe(self, callback):
        if callback in self.callbacks:
            raise ValueError('revision subscriber already registered')
        self.callbacks.append(callback)
        def remove():
            if callback in self.callbacks:
                self.callbacks.remove(callback)
        return remove

    def observed(self, slug, rev, gap):
        for callback in tuple(self.callbacks):
            try:
                callback(slug, rev, gap)
            except Exception as exc:
                self.error(exc)


@dataclass(frozen=True)
class RuntimeInputs:
    cursor: Q.Cursor
    bodies: Mapping[str, Mapping]
    contexts: Mapping[str, Any]
    models: Mapping
    net: Mapping | None = None
    complete: bool = True


def runtime_inputs(registry: Registry, state: Snapshot, selections) -> RuntimeInputs:
    # Compute the union before building, including subscription-only archived
    # agents and ancestors. Every builder uses this snapshot's raw connection.
    held = frozenset(key for selection in selections
        for key in registry.select(state, selection).get('agent', ()))
    bodies = registry.bodies(state, 'agent', held) if held else {}
    models = registry.bodies(state, 'org', frozenset(('tiers',)))['tiers']['models']
    return RuntimeInputs(Q.cursor(state), bodies, tree.runtime_contexts(state, held), models,
                         tree.runtime_net_inputs(state))


class OrgHost:
    """One org runner and retained runtime input revision, owned by one loop.

    ``worker`` is synchronous and owns one RR/read-only snapshot. The optional
    injection is for measured race controls. A gap fences already-running
    reads; a replacement retires its old identity, even at a lower revision.
    HTTP copies sample current memory AFTER adopting acceptable inputs. An
    older same-identity HTTP body may return, but never replaces newer inputs.
    """
    def __init__(self, slug, error, *, registry=REGISTRY, worker=None,
                 overlay_factory=SupervisorOverlays):
        self.slug, self.registry, self.error = slug, registry, error
        self.worker = worker or self._worker
        self.overlay_factory = overlay_factory
        self.overlay = None
        self.input_cursor = None
        self.retired: set[tuple[str, str]] = set()
        self.fence = 0
        self.closed = False
        self.sends: dict[Any, Callable[[dict], bool]] = {}
        self.joining: dict[Any, object] = {}
        self.favourites: dict = {}
        self.persisted_models: dict = {}
        self._read_lock = asyncio.Lock()
        self.runner = OrgRunner(self._load_batch, error, registry=registry,
                                published=self._published)

    @staticmethod
    def _identity(cursor):
        return cursor.org_uuid, cursor.incarnation

    def _selections(self, requests=None, extra=()):
        # Generations are socket-local: two sockets may both use sub:1 with
        # different declarations. Union their memberships, not their labels.
        selections = [Selection(), *extra]
        if requests is not None:
            selections.extend(s for r in requests.values() for s in r.selections)
        else:
            selections.extend(s for c in self.runner.clients.values()
                              for s in c.selections.values())
        return tuple(selections)

    def _worker(self, kind, after, requests, selections):
        with Q.snapshot(self.slug) as state:
            if kind == 'batch':
                frame = read_snapshot(self.registry, state, after, requests)
                active = {token:request for token,request in requests.items()
                          if frame.changes[token]['type'] != 'record_reset'}
                if not active:
                    return frame, RuntimeInputs(Q.cursor(state), {}, {}, {}, complete=False)
                # A reset ends this client's held sets. Do not rebuild their
                # runtime bodies after the catch-up deliberately stopped work.
                selections = self._selections(active)
            elif kind == 'baseline':
                frame = Q.baseline(self.registry, state)
            else:
                frame = Q.catchup(self.registry, state, after,
                                 selections=(Selection(), *requests))
                if frame['type'] == 'record_reset':
                    return frame, RuntimeInputs(Q.cursor(state), {}, {}, {}, complete=False)
            inputs = runtime_inputs(self.registry, state, selections)
            return frame, inputs

    async def _read(self, kind, after=None, requests=None, extra=()):
        async with self._read_lock:
            while not self.closed:
                fence = self.fence
                selections = self._selections(requests if kind == 'batch' else None, extra)
                frame, inputs = await asyncio.to_thread(self.worker, kind, after,
                    requests if kind == 'batch' else extra, selections)
                if self.closed:
                    raise RuntimeError('record host closed')
                if fence != self.fence or self._identity(inputs.cursor) in self.retired:
                    continue
                return frame, inputs
        raise RuntimeError('record host closed')

    def _adopt(self, inputs):
        if not inputs.complete:
            return {}
        current = self.input_cursor
        if current is not None and self._identity(current) == self._identity(inputs.cursor):
            if inputs.cursor.rev < current.rev:
                return {}
        elif current is not None:
            self.retired.add(self._identity(current))
            self.overlay = None
        if self.overlay is None:
            self.overlay = self.overlay_factory(*self._identity(inputs.cursor))
        self.input_cursor = inputs.cursor
        self.overlay.net.adopt(inputs.net)
        self.persisted_models = copy.deepcopy(dict(inputs.models))
        changed = self.overlay.catalog_changed(self.persisted_models, self.favourites)
        removed = set(self.overlay._bodies) - set(inputs.bodies)
        changed.update(self.overlay.adopt(inputs.bodies, inputs.contexts, removed=removed))
        return {key: value for key,value in changed.items() if key not in removed}

    async def http(self, *, after=None, selections=()):
        kind = 'baseline' if after is None else 'changes'
        frame, inputs = await self._read(kind, after, extra=selections)
        if frame['type'] == 'record_reset':
            return frame
        changed = self._adopt(inputs)
        self._partial(changed)
        # No await between input adoption, current-memory sampling and copy
        # stamp: a worker cannot mint a late stamp around an old live value.
        self._partial(self.overlay.transition())
        return {**frame, 'runtime': self.overlay.full()}

    async def join(self, token, send, send_pages=None):
        if token in self.sends or token in self.joining or self.closed:
            raise ValueError('invalid record socket join')
        lease = self.joining[token] = object()
        try:
            _frame, inputs = await self._read('baseline')
            if self.joining.get(token) is not lease:
                return False
            self._partial(self._adopt(inputs))  # existing sockets only
            self._partial(self.overlay.transition())
            if self.closed or not send(self.overlay.full()):
                return False
            # The first queued runtime frame establishes the epoch. Only now
            # can transitions or the runner publish to the new socket.
            self.sends[token] = send
            self.runner.join(token, send, send_pages)
            return True
        finally:
            if self.joining.get(token) is lease:
                self.joining.pop(token)

    def leave(self, token):
        self.sends.pop(token, None)
        self.joining.pop(token, None)
        self.runner.leave(token)

    async def _load_batch(self, after, requests):
        batch, inputs = await self._read('batch', after, requests)
        changed = self._adopt(inputs)
        return replace(batch, runtime=changed)

    def _published(self, batch: Batch):
        # Record bodies/answers have been queued first, including new pins.
        if any(batch.answers.values()) and self.overlay is not None:
            frame = self.overlay.full()
            for token,send in list(self.sends.items()):
                self._offer(token, send, frame)
        else:
            self._partial(batch.runtime or {})

    def _partial(self, values):
        if self.overlay is None:
            return
        net = self.overlay.net.refresh()
        if not values and net is None:
            return
        frame = dict(type='agent_runtime', full=False, **self.overlay.identity,
                     **self.overlay.clock.stamp(), agents=copy.deepcopy(values),
                     **({'net': net} if net is not None else {}))
        for token, send in list(self.sends.items()):
            self._offer(token, send, frame)

    def _offer(self, token, send, frame):
        if not send(frame):
            client = self.runner.clients.get(token)
            if client is not None:
                self.runner._reset(client)

    def transition(self, names=None):
        if self.overlay is not None:
            self._partial(self.overlay.transition(names))

    def catalog_changed(self, favourites):
        self.favourites = copy.deepcopy(dict(favourites))
        if self.overlay is not None:
            self._partial(self.overlay.catalog_changed(self.persisted_models, self.favourites))

    def observed(self, _slug, _rev, gap):
        if gap:
            self.fence += 1
        self.runner.wake()

    async def close(self):
        self.closed = True
        self.fence += 1
        self.sends.clear()
        self.joining.clear()
        await self.runner.close()
