"""Snapshot-local body planning: select first, build once, copy on emission."""
from __future__ import annotations

import copy
from dataclasses import dataclass

from . import record_tree as tree


@dataclass(frozen=True)
class BodyRef:
    entity: str
    key: str


class BodyPass:
    """Only the current worker owns this planner and its un-emitted references.

    Capture/membership logic runs unchanged. Bodies are materialized after all
    frame and runtime consumers have declared their needs in this snapshot.
    The emitted copies never alias each other or the builder's retained data.
    """
    def __init__(self, registry, state):
        self.registry, self.state = registry, state
        self.scopes, self.windows = registry.scopes, registry.windows
        self.wanted = {}
        self.built = None

    def select(self, state, selection):
        if state is not self.state:
            raise ValueError('record pass crossed a snapshot')
        return self.registry.select(state, selection)

    def bodies(self, state, entity, ids):
        if state is not self.state or self.built is not None:
            raise ValueError('record pass must plan before building on its snapshot')
        self.wanted.setdefault(entity, set()).update(ids)
        return {key: BodyRef(entity, key) for key in ids}

    def build(self):
        if self.built is not None:
            raise ValueError('record pass already built')
        agent = self.registry.entities.get('agent')
        if agent is not None and agent.bodies is tree.bodies:
            tree.prepare_context(self.state, frozenset(self.wanted.get('agent', ())))
        self.built = {}
        for entity, ids in sorted(self.wanted.items()):
            rows = self.registry.bodies(self.state, entity, frozenset(ids))
            if set(rows) != ids:
                raise RuntimeError('record membership/body snapshot disagrees: '+entity)
            self.built[entity] = rows

    def emit(self, value):
        if self.built is None:
            raise ValueError('record pass must build before emitting')
        if isinstance(value, BodyRef):
            return copy.deepcopy(self.built[value.entity][value.key])
        if isinstance(value, dict):
            return {key: self.emit(item) for key,item in value.items()}
        if isinstance(value, list):
            return [self.emit(item) for item in value]
        if isinstance(value, tuple):
            return tuple(self.emit(item) for item in value)
        return copy.deepcopy(value)
