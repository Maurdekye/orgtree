"""Org host lifecycle shared by HTTP reads and the socket record runner.

Workers return snapshot inputs and expensive cache forecasts. Cheap supervisor
sampling, clock stamps and publication stay on the loop after cursor validation.
The registry and revision subscribers are also extension points for B4b/c.
"""
from __future__ import annotations

import asyncio
import copy
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Mapping

from .. import profiling
from . import record_reads as Q, record_tree as tree, record_panels as panels
from . import record_mail_runtime as mail_runtime
from .record_registry import Registry, Selection, Snapshot
from .record_runtime import SupervisorOverlays, forecasts
from .record_pass import BodyPass
from .record_transport import Batch, OrgRunner, read_snapshot


REGISTRY = panels.register(tree.register(Registry()))


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
    held: frozenset[str] | None = None
    mail: Mapping[str, Mapping] | None = None
    mail_held: frozenset[str] | None = None
    forecasts: Mapping | None = None
    forecast_generations: Mapping | None = None
    forecast_overlay: Any = None


def runtime_inputs(registry: Registry, state: Snapshot, selections) -> RuntimeInputs:
    # Compute the union before building, including subscription-only archived
    # agents and ancestors. Every builder uses this snapshot's raw connection.
    held = frozenset(key for selection in selections
        for key in registry.select(state, selection).get('agent', ()))
    bodies = registry.bodies(state, 'agent', held) if held else {}
    models = registry.bodies(state, 'org', frozenset(('tiers',)))['tiers']['models']
    contexts = tree.runtime_contexts(state, held)
    return RuntimeInputs(Q.cursor(state), bodies, contexts, models,
                         tree.runtime_net_inputs(state), forecasts=forecasts(bodies, contexts))


class OrgHost:
    """One org runner and retained runtime input revision, owned by one loop.

    ``worker`` is synchronous and owns one RR/read-only snapshot. The optional
    injection is for measured race controls. A gap fences already-running
    reads; a replacement retires its old identity, even at a lower revision.
    HTTP copies sample current memory AFTER adopting acceptable inputs. An
    older same-identity HTTP body may return, but never replaces newer inputs.
    """
    def __init__(self, slug, error, *, registry=REGISTRY, worker=None,
                 overlay_factory=mail_runtime.MailboxOverlays):
        self.slug, self.registry, self.error = slug, registry, error
        self.worker = worker or self._worker
        self._default_worker = worker is None
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
        self._mail_timer = None
        self._forecast_pending = set()
        self._forecast_task = None
        self._forecast_timers = {}
        self._forecast_periodic = None
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

    def _worker(self, kind, after, requests, selections, *, previous=None, previous_mail=frozenset()):
        with profiling.stage('record_assembly_ms'), Q.snapshot(self.slug) as state:
            plan = BodyPass(self.registry, state)
            if kind == 'batch':
                frame = read_snapshot(plan, state, after, requests, defer_bodies=True)
                active = {token:request for token,request in requests.items()
                          if frame.changes[token]['type'] != 'record_reset'}
                if not active:
                    return frame, RuntimeInputs(Q.cursor(state), {}, {}, {}, complete=False)
                selections = self._selections(active)
            elif kind == 'baseline':
                frame = Q.baseline(plan, state)
            else:
                frame = Q.catchup(plan, state, after,
                                 selections=(Selection(), *requests))
                if frame['type'] == 'record_reset':
                    return frame, RuntimeInputs(Q.cursor(state), {}, {}, {}, complete=False)

            # A HTTP caller's cursor need not equal the retained overlay's.
            # Derive runtime invalidation from the latter, on this snapshot.
            held = frozenset(key for selection in selections
                for key in plan.select(state, selection).get('agent', ()))
            mail_held = frozenset(entity.partition(':')[2] for selection in selections
                for entity in plan.select(state, selection) if entity.startswith('agent_mail:')) & held
            current = Q.cursor(state)
            previous_cursor, previous_ids = previous or (None, frozenset())
            dirty = set(held - previous_ids)
            mail_dirty = set(mail_held - previous_mail)
            if previous_cursor is None or self._identity(previous_cursor) != self._identity(current):
                dirty.update(held)
                mail_dirty.update(mail_held)
            else:
                # Subscription generations are socket-local; give this private
                # union unique set labels without changing any emitted set.
                runtime_selections = (Selection(), *(Selection('sub:'+str(i+1), s.agents, s.windows)
                    for i,s in enumerate(selections) if s.set != 'shared'))
                runtime_frame = Q.catchup(plan, state, previous_cursor, selections=runtime_selections)
                if runtime_frame['type'] == 'record_reset':
                    dirty.update(held)
                    mail_dirty.update(mail_held)
                else:
                    dirty.update(row['id'] for row in runtime_frame['upserts'] if row['entity']=='agent')
                    dirty.update(row['id'] for replacement in runtime_frame.get('replacements', ())
                        for row in replacement['records'] if row['entity']=='agent')
                    mail_rows = [*runtime_frame['upserts'], *runtime_frame['tombstones'],
                        *(row for replacement in runtime_frame.get('replacements', ())
                          for row in replacement['records'])]
                    mail_dirty.update(row['entity'].partition(':')[2] for row in mail_rows
                                      if row['entity'].startswith('agent_mail:'))
            dirty.intersection_update(held)
            mail_dirty.update(dirty & mail_held)  # lease/name changes also affect stages
            mail_dirty.intersection_update(mail_held)
            body_refs = plan.bodies(state, 'agent', frozenset(dirty)) if dirty else {}
            tier_ref = plan.bodies(state, 'org', frozenset(('tiers',)))['tiers']
            plan.build()
            bodies = plan.emit(body_refs)
            contexts = tree.runtime_contexts(state, frozenset(dirty))
            inputs = RuntimeInputs(current, bodies,
                contexts, plan.emit(tier_ref)['models'],
                tree.runtime_net_inputs(state), held=held,
                mail=mail_runtime.inputs(state, mail_dirty), mail_held=mail_held)
            if kind == 'batch':
                frame = replace(frame, changes=plan.emit(frame.changes), answers={
                    token: tuple(page for answer in answers
                        for page in Q.subscription_pages(plan.emit(answer)))
                    for token,answers in frame.answers.items()})
            else:
                frame = plan.emit(frame)
        # No database transaction is held during filesystem/process-spec work.
        with profiling.stage('record_forecast_ms'):
            return frame, replace(inputs, forecasts=forecasts(bodies, contexts))

    async def _read(self, kind, after=None, requests=None, extra=()):
        waiting = time.perf_counter()
        async with self._read_lock:
            profiling.add('record_host_wait_ms', (time.perf_counter() - waiting) * 1000)
            while not self.closed:
                fence = self.fence
                selections = self._selections(requests if kind == 'batch' else None, extra)
                retained = (self.input_cursor, frozenset(self.overlay._bodies) if self.overlay else frozenset())
                forecast_overlay = self.overlay
                generations = dict(getattr(self.overlay, '_fgen', {}))
                frame, inputs = await profiling.record_worker('record_worker_ms', self.worker, kind, after,
                    requests if kind == 'batch' else extra, selections,
                    **({'previous': retained,
                        'previous_mail': frozenset(getattr(self.overlay, '_mail', {}))}
                       if self._default_worker else {}))
                if self.closed:
                    raise RuntimeError('record host closed')
                if fence != self.fence or self._identity(inputs.cursor) in self.retired:
                    continue
                return frame, replace(inputs, forecast_generations=generations,
                                      forecast_overlay=forecast_overlay)
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
            self._cancel_mail_timer()
            self._clear_forecast_timers()
            self._forecast_pending.clear()
            self.overlay = None
        if self.overlay is None:
            self.overlay = self.overlay_factory(*self._identity(inputs.cursor))
        self.input_cursor = inputs.cursor
        self.overlay.net.adopt(inputs.net)
        models_changed = (current is None or self._identity(current) != self._identity(inputs.cursor)
                          or self.persisted_models != inputs.models)
        self.persisted_models = copy.deepcopy(dict(inputs.models))
        changed = (self.overlay.catalog_changed(self.persisted_models, self.favourites)
                   if models_changed else {})
        removed = set(self.overlay._bodies) - set(inputs.bodies if inputs.held is None else inputs.held)
        if inputs.mail is not None:
            mail_removed = set(self.overlay._mail) - set(inputs.mail_held or ())
            changed.update(self.overlay.adopt_mail(inputs.mail, removed=mail_removed))
        stale = set()
        if isinstance(self.overlay, SupervisorOverlays):
            for key, value in (inputs.forecasts or {}).items():
                captured = (inputs.forecast_generations or {}).get(key, 0)
                if inputs.forecast_overlay is self.overlay and self.overlay._fgen.get(key, 0) != captured:
                    stale.add(key)
                else:
                    self.overlay._forecasts[key] = copy.deepcopy(value)
            for key in removed:
                timer = self._forecast_timers.pop(key, None)
                if timer is not None:
                    timer.cancel()
                self._forecast_pending.discard(key)
        changed.update(self.overlay.adopt(inputs.bodies, inputs.contexts, removed=removed))
        if isinstance(self.overlay, SupervisorOverlays):
            self.overlay.turn_edges({body['id'] for body in inputs.bodies.values()})
            for key in inputs.bodies:
                self._forecast_expiry(key)
            # Snapshot forecasts already cover changed bodies. Models can also
            # affect a held agent not included in this partial body refresh.
            stale.update(set(self.overlay._bodies) - set(inputs.bodies) if models_changed else ())
            stale.update(set(inputs.bodies) - set(inputs.forecasts or {}))
            self._mark_forecasts(stale)
            self._arm_forecast_periodic()
        return {key: value for key,value in changed.items() if key not in removed}

    async def http(self, *, after=None, selections=()):
        kind = 'baseline' if after is None else 'changes'
        frame, inputs = await self._read(kind, after, extra=selections)
        if frame['type'] == 'record_reset':
            return frame
        with profiling.stage('record_publish_ms'):
            changed = self._adopt(inputs)
            # HTTP declarations can outlive the socket subscription while _read
            # awaits its worker. Keep only currently subscribed mailbox overlays.
            changed.update(self._trim_mail())
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
            changed = self._adopt(inputs)
            changed.update(self._trim_mail())
            self._partial(changed)  # existing sockets only
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
        self._partial(self._trim_mail())

    def unsubscribe(self, token, generation):
        self.runner.unsubscribe(token, generation)
        self._partial(self._trim_mail())

    def _trim_mail(self):
        if not isinstance(self.overlay, mail_runtime.MailboxOverlays):
            return {}
        held = {str(window['agent']) for client in self.runner.clients.values()
                for selection in client.selections.values() for window in selection.windows
                if window.get('kind') == 'agent_mail'}
        return self.overlay.adopt_mail({}, removed=set(self.overlay._mail)-held)

    async def _load_batch(self, after, requests):
        batch, inputs = await self._read('batch', after, requests)
        changed = self._adopt(inputs)
        return replace(batch, runtime=changed)

    def _published(self, batch: Batch):
        # Record bodies/answers have been queued first, including new pins.
        # A socket can unsubscribe while the worker reads. Do not retain those
        # old mailbox inputs or publish their stages after that set was dropped.
        cleared = self._trim_mail()
        self._schedule_mail()
        if any(batch.answers.values()) and self.overlay is not None:
            frame = self.overlay.full()
            for token,send in list(self.sends.items()):
                self._offer(token, send, frame)
        else:
            self._partial({**(batch.runtime or {}), **cleared})

    def _partial(self, values):
        self._schedule_mail()
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

    def _cancel_mail_timer(self):
        if self._mail_timer is not None:
            self._mail_timer.cancel()
            self._mail_timer = None

    def _schedule_mail(self):
        self._cancel_mail_timer()
        overlay = self.overlay
        if self.closed or not isinstance(overlay, mail_runtime.MailboxOverlays):
            return
        now = time.time()
        deadline = overlay.next_deadline()
        if deadline is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # synchronous injected controls have no host loop
            return

        def expired():
            if self.closed or self.overlay is not overlay or self._mail_timer is not handle:
                return
            self._mail_timer = None
            overlay.expired_through = max(overlay.expired_through, time.time())
            # Retained inputs only: no org read, revision or renderer polling.
            changed = self._trim_mail()
            changed.update(overlay._refresh(set(overlay._mail).intersection(overlay._bodies)))
            self._partial(changed)

        handle = loop.call_later(max(0, deadline-now), expired)
        self._mail_timer = handle

    def _offer(self, token, send, frame):
        if not send(frame):
            client = self.runner.clients.get(token)
            if client is not None:
                self.runner._reset(client)

    def transition(self, names=None):
        if self.overlay is not None:
            self._partial(self.overlay.transition(names))
            if names is not None and isinstance(self.overlay, SupervisorOverlays):
                self._mark_forecasts(self.overlay.turn_edges(names))

    def _mark_forecasts(self, keys):
        if self.closed or not isinstance(self.overlay, SupervisorOverlays):
            return
        for key in keys:
            body = self.overlay._bodies.get(key)
            if body is not None and body.get('state') != 'archived':
                self.overlay._fgen[key] = self.overlay._fgen.get(key, 0) + 1
                self._forecast_pending.add(key)
        if self._forecast_pending and self._forecast_task is None:
            self._forecast_task = asyncio.create_task(self._refresh_forecasts())

    async def _refresh_forecasts(self):
        try:
            while self._forecast_pending and not self.closed:
                overlay = self.overlay
                keys = self._forecast_pending
                self._forecast_pending = set()
                generations = {key: overlay._fgen[key] for key in keys if key in overlay._bodies}
                bodies = {key: overlay._bodies[key] for key in generations}
                contexts = {key: overlay._contexts[key] for key in generations}
                try:
                    values = await asyncio.to_thread(forecasts, bodies, contexts)
                except Exception as exc:
                    self.error(exc)
                    continue
                if self.closed or self.overlay is not overlay:
                    continue
                accepted = [key for key in values if key in overlay._bodies
                            and overlay._fgen[key] == generations[key]]
                for key in accepted:
                    overlay._forecasts[key] = copy.deepcopy(values[key])
                    self._forecast_expiry(key)
                # All live fields and stamps are still sampled on this loop.
                self._partial(overlay._refresh(accepted))
        finally:
            self._forecast_task = None

    def _forecast_expiry(self, key):
        from .. import cachecontinuity
        timer = self._forecast_timers.pop(key, None)
        if timer is not None:
            timer.cancel()
        value = self.overlay._forecasts.get(key) or {}
        expiry = cachecontinuity.epoch(value.get('expires_at'))
        if value.get('state') == 'compatible_observed' and expiry is not None:
            self._forecast_timers[key] = asyncio.get_running_loop().call_later(
                max(0, expiry - time.time()), self._mark_forecasts, (key,))

    def _arm_forecast_periodic(self):
        active = self.overlay is not None and any(
            body.get('state') != 'archived' for body in self.overlay._bodies.values())
        if not active and self._forecast_periodic is not None:
            self._forecast_periodic.cancel()
            self._forecast_periodic = None
        if active and self._forecast_periodic is None and not self.closed:
            self._forecast_periodic = asyncio.get_running_loop().call_later(60, self._forecast_files_changed)

    def _forecast_files_changed(self):
        self._forecast_periodic = None
        if not self.closed and self.overlay is not None:
            # Startup file edits have no org revision. Never inspect files on
            # the loop; coalesce their slow check with other forecast marks.
            self._mark_forecasts(tuple(self.overlay._bodies))
            self._arm_forecast_periodic()

    def _clear_forecast_timers(self):
        for timer in self._forecast_timers.values():
            timer.cancel()
        self._forecast_timers.clear()
        if self._forecast_periodic is not None:
            self._forecast_periodic.cancel()
            self._forecast_periodic = None

    def catalog_changed(self, favourites):
        self.favourites = copy.deepcopy(dict(favourites))
        if self.overlay is not None:
            self._partial(self.overlay.catalog_changed(self.persisted_models, self.favourites))
            self._mark_forecasts(self.overlay._bodies)

    def observed(self, _slug, _rev, gap):
        if gap:
            self.fence += 1
        self.runner.wake()

    async def close(self):
        self.closed = True
        self._cancel_mail_timer()
        self.fence += 1
        self.sends.clear()
        self.joining.clear()
        self._clear_forecast_timers()
        self._forecast_pending.clear()
        if self._forecast_task is not None:
            task, self._forecast_task = self._forecast_task, None
            task.cancel()
            # Cancellation fences the result, not the worker's completion.
            await asyncio.gather(task, return_exceptions=True)
        await self.runner.close()
