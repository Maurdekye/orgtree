"""Common record body/membership interface for the tree and panel extensions.

All selection and body construction uses the caller's snapshot connection.
Registration happens at import/startup, never in response to client input.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping


@dataclass(frozen=True)
class Snapshot:
    raw: Any
    slug: str
    stamp: Mapping[str, Any]
    now: float
    cache: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)


@dataclass(frozen=True)
class Selection:
    """A declared set: shared, or one socket subscription generation."""
    set: str = 'shared'
    agents: tuple[str, ...] = ()
    windows: tuple[Mapping[str, Any], ...] = ()


Members = Callable[[Snapshot, Selection], frozenset[str]]
Bodies = Callable[[Snapshot, frozenset[str]], Mapping[str, Any]]


@dataclass(frozen=True)
class Entity:
    name: str
    members: Members
    bodies: Bodies


@dataclass(frozen=True)
class WindowKind:
    """Validate arguments and select its partition on the SAME snapshot.

    ``entity`` returns the capture entity (e.g. agent_history:42); ``members``
    selects current entry IDs. Its rank declaration lives in record_derivations.
    """
    name: str
    validate: Callable[[Mapping[str, Any]], Mapping[str, Any]]
    entity: Callable[[Snapshot, Mapping[str, Any]], str]
    members: Callable[[Snapshot, Mapping[str, Any]], frozenset[str]]
    bodies: Bodies


@dataclass(frozen=True)
class ScopeResult:
    """Read-side invalidation: named bodies and complete replacement sets."""
    touched: frozenset[tuple[str, str]] = frozenset()
    replacements: frozenset[str] = frozenset()


ScopeReader = Callable[[Snapshot, frozenset[str], Mapping[str, Mapping[str, frozenset[str]]]], ScopeResult]


class Registry:
    def __init__(self):
        self.entities: dict[str, Entity] = {}
        self.windows: dict[str, WindowKind] = {}
        self.scopes: dict[str, ScopeReader] = {}

    def register_scope(self, kind: str, reader: ScopeReader) -> None:
        """Register a scope deliberately deferred past the commit flush.

        Readers receive current memberships, never client prior-member IDs,
        and use this same snapshot for ancestry and replacement decisions.
        """
        if not kind.isascii() or not kind.isidentifier() or kind in self.scopes:
            raise ValueError('invalid or duplicate read-side scope: '+kind)
        self.scopes[kind] = reader

    def register(self, entity: Entity) -> None:
        if entity.name in self.entities or entity.name in self.windows:
            raise ValueError(f'duplicate record entity: {entity.name}')
        self.entities[entity.name] = entity

    def register_window(self, window: WindowKind) -> None:
        if window.name in self.windows or window.name in self.entities:
            raise ValueError(f'duplicate record window: {window.name}')
        self.windows[window.name] = window

    def select(self, snapshot: Snapshot, selection: Selection) -> dict[str, frozenset[str]]:
        result = {name: entity.members(snapshot, selection)
                  for name, entity in self.entities.items()}
        for arguments in selection.windows:
            kind = arguments.get('kind')
            if kind not in self.windows:
                raise ValueError(f'unknown record window: {kind!r}')
            window = self.windows[kind]
            checked = window.validate(arguments)
            entity = window.entity(snapshot, checked)
            result[entity] = result.get(entity, frozenset()) | window.members(snapshot, checked)
        return result

    def bodies(self, snapshot: Snapshot, entity: str, ids: frozenset[str]) -> Mapping[str, Any]:
        builder = self.entities.get(entity)
        if builder is not None:
            return builder.bodies(snapshot, ids)
        window = self.windows.get(entity.partition(':')[0])
        if window is None:
            raise ValueError(f'unknown record entity: {entity!r}')
        return window.bodies(snapshot, ids)
