"""Host-owned ordering and derived agent values for the record overlay.

There is one clock per host, shared with the app feed. Org record bodies are
inputs, not mutated here. A catalog/favourites signal recomputes values using
the retained bodies, without checking out a database connection or writing a
revision. Callers discard reads from a replaced org before supplying bodies.
"""
from __future__ import annotations

import copy
import threading
import uuid
from typing import Any, Mapping


class HostClock:
    def __init__(self):
        self.epoch = str(uuid.uuid4())
        self._seq = 0
        self._lock = threading.Lock()

    def stamp(self) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            return dict(epoch=self.epoch, seq=self._seq)


# Importing this module never starts a listener, timer or database writer.
# Both org and app frames draw from this exact instance during a host run.
HOST_CLOCK = HostClock()

NET_FIELDS = frozenset(('id', 'address', 'name', 'connected', 'hidden', 'last_ok', 'error', 'roster'))


class NetOverlay:
    """Live hub values from retained, scrubbed snapshot configuration."""
    def __init__(self, clock):
        self.clock = clock
        self.inputs = None
        self.value = None

    def adopt(self, inputs):
        self.inputs = copy.deepcopy(inputs)

    def refresh(self):
        if self.inputs is None:
            return None
        from .. import net
        block = net.status_block(self.inputs)
        fields = dict(hubs=[{key: copy.deepcopy(hub[key]) for key in NET_FIELDS}
                            for hub in block['hubs']])
        if self.value is not None and self.value['hubs'] == fields['hubs']:
            return None
        self.value = {**self.clock.stamp(), **fields}
        return copy.deepcopy(self.value)

    def full(self, stamp):
        return {**copy.deepcopy(self.value), **stamp} if self.value is not None else None

# Account display metadata is deliberately absent: B4b owns its app frames.
# Persisted fields that the shared formatter also touches stay in bodies.
AGENT_FIELDS = frozenset('''busy waiting queued_for_slot responding phase ran_as
    codex_route queued proc_warm proc_live proc_relaunch proc_relaunch_reason
    proc_paused proc_control_enabled proc_control_action proc_control_reason
    mcp_tool_count mcp_tool_count_provider mcp_tool_count_source mcp_tool_count_reason
    mcp_readiness_waiting mcp_readiness_state mcp_readiness_reason
    tasks bg_tasks last_error activity cache_forecast'''.split())


def add_only(persisted: Mapping, favourites: Mapping) -> dict:
    """The org's own catalog row wins, even when it is deselected in the app."""
    return {**favourites, **persisted}


def agent_fields(body: Mapping, models: Mapping, *, boot_at: str) -> dict:
    from .. import ledger, supervisor
    return dict(ask_linger_visible=ledger._ask_linger_visible(body.get('ask'), boot_at),
                context_window=supervisor.context_window(body, models))


class AgentOverlays:
    """One org identity's retained inputs and ordered derived agent values.

    An identity replacement gets a NEW instance, sharing the host clock.
    ``update`` supplies changed bodies and explicit removals after catch-up.
    ``catalog_changed`` is B4b's signal after publishing new favourites or
    refreshing the model catalog. It recomputes every retained agent.
    ``full`` stamps the copy as well as each value, for delayed-copy removal.
    All methods run on the host event-loop thread; only the clock is shared
    with other threads. Returned values own their nested data.
    """
    def __init__(self, org_uuid: str, incarnation: str, *, clock: HostClock = HOST_CLOCK):
        self.identity = dict(org_uuid=org_uuid, incarnation=incarnation)
        self.clock = clock
        from ..ledger import Org
        self.boot_at = Org._boot_at()
        self._bodies: dict[str, dict] = {}
        self._models: dict = {}
        self._values: dict[str, dict] = {}
        self.net = NetOverlay(clock)

    def _refresh(self, ids) -> dict[str, dict]:
        changed = {}
        for key in ids:
            fields = self._fields(key)
            old = self._values.get(key)
            if old is None or {k:v for k,v in old.items() if k not in ('epoch','seq')} != fields:
                value = {**self.clock.stamp(), **fields}
                self._values[key] = value
                changed[key] = copy.deepcopy(value)
        return changed

    def _fields(self, key):
        return agent_fields(self._bodies[key], self._models, boot_at=self.boot_at)

    def update(self, bodies: Mapping[str, Mapping], *, removed=()) -> dict:
        for key in removed:
            self._bodies.pop(key, None)
            self._values.pop(key, None)
        self._bodies.update({key: copy.deepcopy(dict(body)) for key,body in bodies.items()})
        return self._refresh(bodies)

    def catalog_changed(self, persisted_models: Mapping, favourite_models: Mapping) -> dict:
        self._models = add_only(persisted_models, favourite_models)
        return self._refresh(self._bodies)

    def full(self) -> dict:
        self.net.refresh()
        stamp = self.clock.stamp()
        return dict(type='agent_runtime', full=True, **self.identity, **stamp,
                    **({'net': self.net.full(stamp)} if self.net.value is not None else {}),
                    agents={key: {**copy.deepcopy(value), **stamp}
                            for key,value in self._values.items()})


class SupervisorOverlays(AgentOverlays):
    """Runtime projection from retained snapshot inputs, without org reloads.

    ``adopt`` replaces inputs for just the changed/added held agents. Each
    context is a non-persistable foreground context built on the snapshot
    connection. It can safely outlive that read transaction. A transition
    reprojects retained inputs through the legacy formatter; no database or
    account-registry read is needed. Full copies use the base class clock.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._contexts: dict[str, Any] = {}

    def adopt(self, bodies: Mapping[str, Mapping], contexts: Mapping[str, Any], *, removed=()):
        if set(bodies) != set(contexts):
            raise ValueError('every agent body needs its snapshot context')
        removed = tuple(removed)
        for key in removed:
            self._contexts.pop(key, None)
        self._contexts.update(contexts)
        return self.update(bodies, removed=removed)

    def _fields(self, key):
        from .. import api
        body = self._bodies[key]
        if body.get('state') == 'archived':
            fields = {name: copy.deepcopy(api._ARCHIVED_RUNTIME_DEFAULTS.get(name))
                      for name in AGENT_FIELDS}
            # New runtime fields omitted by old summary defaults have their
            # same inactive values, never a stale process's retained state.
            fields.update(queued_for_slot=None, proc_control_enabled=False,
                          proc_control_action=None, proc_control_reason=None,
                          mcp_tool_count_provider=None)
        else:
            node = copy.deepcopy(body)
            api._annotate_agent_runtime(self._contexts[key], node)
            fields = {name: node[name] for name in AGENT_FIELDS}
        return {**fields, **super()._fields(key)}

    def transition(self, names=None):
        keys = [key for key,body in self._bodies.items()
                if names is None or body['id'] in names]
        return self._refresh(keys)
