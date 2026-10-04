"""Configured scope stays stored; effective scope follows current parent edges.

An authoritative caller supplies its actual transaction's configured-row reader
and holds the ancestor locks through the action. ``effective_scope`` always
reads that chain afresh. It owns no process cache and does not acquire locks.
Display callers can memoize with ``ScopeSnapshot`` inside one consistent read
transaction. Neither an effective view nor that read memo is a storage document.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from .ledger import LedgerError, Org, PM_LEVELS, USER, VIS_LEVELS

NodeReader = Callable[[str], Mapping[str, Any]]


class ScopeError(LedgerError):
    """A missing or malformed current chain cannot confer capabilities."""


def _read(reader: NodeReader, agent_id: str) -> Mapping[str, Any]:
    try:
        node = reader(agent_id)
    except KeyError as exc:
        raise ScopeError(f"scope ancestor {agent_id!r} is missing") from exc
    if not isinstance(node, Mapping) or "parent" not in node:
        raise ScopeError(f"scope ancestor {agent_id!r} has no parent edge")
    parent = node["parent"]
    if parent is not None and (not isinstance(parent, str) or not parent):
        raise ScopeError(f"scope ancestor {agent_id!r} has an invalid parent edge")
    if not isinstance(node.get("scope"), Mapping):
        raise ScopeError(f"scope ancestor {agent_id!r} has no configured scope")
    return node


def _level(scope: Mapping[str, Any], key: str, levels: tuple[str, ...],
           default: str, agent_id: str) -> str:
    value = scope.get(key, default)
    if value not in levels:
        raise ScopeError(f"scope ancestor {agent_id!r} has invalid {key}: {value!r}")
    return value


def _intersect(node: Mapping[str, Any], parent: Mapping[str, Any] | None,
               agent_id: str) -> dict[str, Any]:
    # Keep preferences and unknown payload fields, but never mutate their source.
    configured = node["scope"]
    result = deepcopy(dict(configured))
    tools = configured.get("tools")
    if tools is not None and not isinstance(tools, Mapping):
        raise ScopeError(f"scope ancestor {agent_id!r} has invalid tools")
    result["tools"], _ = Org._clamp_tools(
        tools, None if parent is None else parent["tools"], False)
    dirs = configured.get("add_dirs", [])
    if not isinstance(dirs, (list, tuple)) or any(
            not isinstance(d, Mapping) or not isinstance(d.get("path"), str)
            or not d["path"] or d.get("mode") not in ("rw", "ro") for d in dirs):
        raise ScopeError(f"scope ancestor {agent_id!r} has invalid folder grants")
    parent_dirs = (None if parent is None else
                   {d["path"]: d["mode"] for d in parent["add_dirs"]})
    result["add_dirs"], _ = Org._clamp_dirs(deepcopy(list(dirs)), parent_dirs, False)
    for key, levels, default in (
            ("org_visibility", VIS_LEVELS, "full"),
            ("permission_mode", PM_LEVELS, "acceptEdits")):
        value = _level(configured, key, levels, default, agent_id)
        if parent is not None:
            value = levels[min(levels.index(value), levels.index(parent[key]))]
        result[key] = value
    return result


def _resolve(reader: NodeReader, agent_id: str,
             memo: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    chain: list[tuple[str, Mapping[str, Any]]] = []
    seen: set[str] = set()
    current: str | None = agent_id
    inherited: Mapping[str, Any] | None = None
    while current is not None and current != USER:
        if current in seen:
            raise ScopeError(f"scope parent cycle at {current!r}")
        seen.add(current)
        if memo is not None and current in memo:
            inherited = memo[current]
            break
        node = _read(reader, current)
        chain.append((current, node))
        current = node["parent"]
    for name, node in reversed(chain):
        inherited = _intersect(node, inherited, name)
        if memo is not None:
            memo[name] = inherited
    assert inherited is not None  # callers resolve an agent, not the USER sentinel
    return deepcopy(dict(inherited))


def effective_scope(reader: NodeReader, agent_id: str) -> dict[str, Any]:
    """Fresh configured-chain fold; caller owns current connection/path locks.

    ``reader`` must return configured values, including ``parent`` and ``scope``.
    No descendant is read. Folder/tree coverage and MCP wildcard rules are the
    existing ledger clamps; USER above a top-level agent imposes no ceiling.
    """
    if agent_id == USER or not isinstance(agent_id, str) or not agent_id:
        raise ScopeError("effective scope requires an agent identity")
    return _resolve(reader, agent_id)


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(val) for key, val in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(val) for val in value)
    return deepcopy(value)


class EffectiveAgent(Mapping[str, Any]):
    """Read-only transport input, deliberately not a dict accepted by codecs."""

    def __init__(self, configured: Mapping[str, Any], scope: Mapping[str, Any]):
        self._configured = configured
        self._scope = deepcopy(dict(scope))

    def __getitem__(self, key: str) -> Any:
        return _freeze(self._scope if key == "scope" else self._configured[key])

    def __iter__(self) -> Iterator[str]:
        return iter(self._configured)

    def __len__(self) -> int:
        return len(self._configured)

    def transport(self) -> dict[str, Any]:
        """Detached JSON/provider values; never pass these to a storage writer."""
        result = deepcopy(dict(self._configured))
        result["scope"] = deepcopy(self._scope)
        return result


@dataclass(frozen=True)
class ScopeStamp:
    org_uuid: str
    incarnation: str
    revision: int


class ScopeSnapshot:
    """Display-only memo, owned by one consistent read transaction/stamp.

    Use as a context manager *inside* the database snapshot. Closing that read
    closes this object, so a retained memo cannot serve a later transaction.
    Writes must call ``effective_scope`` with their current locked reader.
    """

    def __init__(self, reader: NodeReader, stamp: ScopeStamp):
        self.stamp = stamp
        self._reader: NodeReader | None = reader
        self._memo: dict[str, dict[str, Any]] = {}

    def _open_reader(self) -> NodeReader:
        if self._reader is None:
            raise ScopeError("the scope read snapshot is closed")
        return self._reader

    def scope(self, agent_id: str) -> dict[str, Any]:
        reader = self._open_reader()
        if agent_id == USER or not isinstance(agent_id, str) or not agent_id:
            raise ScopeError("effective scope requires an agent identity")
        return _resolve(reader, agent_id, self._memo)

    def agent(self, agent_id: str) -> EffectiveAgent:
        return EffectiveAgent(_read(self._open_reader(), agent_id), self.scope(agent_id))

    def close(self) -> None:
        self._reader = None
        self._memo.clear()

    def __enter__(self) -> ScopeSnapshot:
        self._open_reader()
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
