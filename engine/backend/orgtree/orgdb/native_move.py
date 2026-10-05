"""Move plans follow parent paths; ordinary descendants are never loaded.

The ledger keeps its authority, credit and notice rules. This module supplies
native path coverage, aggregate reads and the scalar/savepoint boundaries.
"""
from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable, Iterator, Mapping
from typing import Any

from ..ledger import LedgerError, Org, USER, _q, actor_kind
from . import graph


def enabled() -> bool:
    from .. import store   # noqa: PLC0415
    return store._orgdb_on()


def connection(org: Any) -> Any | None:
    """Only an actual native write document can use the current connection."""
    from .. import store   # noqa: PLC0415
    if not enabled() or not isinstance(org.d, store.LazyDoc):
        return None
    conn = (getattr(store._orgtx_local, 'pinned', None) or {}).get(org.d._slug)
    if conn is None or not getattr(conn, 'orgdb', False):
        raise LedgerError('native move requires its current planned org transaction')
    return conn.raw


class _PlanningNodes(Mapping[str, Any]):
    """One selected-name read per node in this prediction's read snapshot."""
    def __init__(self, raw: Any):
        from .compat import rows as R   # noqa: PLC0415
        self.raw, self.names, self.values = raw, R.Names(raw), {}

    def __getitem__(self, name: str) -> Any:
        if name not in self.values:
            import json   # noqa: PLC0415
            from .compat import rows as R   # noqa: PLC0415
            found = R.nodes(self.raw, [name], names=self.names)
            if not found:
                raise KeyError(name)
            self.values[name] = json.loads(found[0][1])
        return self.values[name]

    def __iter__(self) -> Iterator[str]:
        raise LedgerError('native move planning must select names, never enumerate the org')

    def __len__(self) -> int:
        raise LedgerError('native move planning must not count the whole org')


def planned_rows(slug: str, derive: Callable[[Any], Any]) -> Any:
    """Pre-lock prediction reads only selected paths, not cached_org's N rows.

    The result contains row names only. No reader or connection escapes its
    consistent snapshot; the body re-derives these names under actual locks.
    """
    from .. import store   # noqa: PLC0415
    slug = store._safe_slug(slug)

    def run(raw: Any) -> Any:
        org = Org.__new__(Org)
        org.d = {'slug': slug, 'nodes': _PlanningNodes(raw)}
        return derive(org)

    pinned = (getattr(store._orgtx_local, 'pinned', None) or {}).get(slug)
    if pinned is not None:
        if not getattr(pinned, 'orgdb', False):
            raise LedgerError('native move prediction requires its actual org database')
        return run(pinned.raw)
    with store._POOL.acquire(slug) as conn:
        if not getattr(conn, 'orgdb', False):
            raise LedgerError('native move prediction requires its actual org database')
        with conn.raw.transaction():
            conn.raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            return run(conn.raw)


def rows(org: Any, actor: str, moves: list[tuple[str, str | None]]
         ) -> tuple[set[str], set[str]]:
    """Plan every leg on a small parent overlay, without copying the document.

    This is an untrusted prediction. The same calculation runs on the locked
    document before the body; any missing early-tier row rolls back and widens.
    Later legs see earlier placements, including each canonical predecessor.
    """
    parents: dict[str, str | None] = {}
    update: set[str] = set()
    share: set[str] = set()

    def chain(start: str | None) -> list[str]:
        path: list[str] = []
        seen: set[str] = set()
        while start is not None and start != USER:
            if start in seen:
                raise LedgerError('native move planning found a parent cycle')
            seen.add(start)
            path.append(start)
            start = parents[start] if start in parents else org.node(start)['parent']
        return path

    if actor_kind(actor) not in ('user', 'system') and actor in org.nodes:
        share.update(chain(actor))
    for root, target in moves:
        target = None if target in (None, USER) else target
        update.add(root)
        try:
            node = org.node(root)
            moving = {root, *org.lineage_stack(root)}
            update.update(moving)
            old = parents[root] if root in parents else node['parent']
            old_path, new_path = chain(old), chain(target)
            new_set = set(new_path)
            common = next((name for name in old_path if name in new_set), None)
            update.update(old_path[:old_path.index(common)] if common else old_path)
            update.update(new_path[:new_path.index(common)] if common else new_path)
            if target is not None:
                update.add(target)   # serialize with child admissions even at zero cost
            covered: set[str] = set()
            for name in moving:
                # Coalesce aligned bearer paths; do not walk the same h-edge
                # suffix once per bearer. Different historical paths cost U.
                while name is not None and name != USER and name not in covered:
                    covered.add(name)
                    share.add(name)
                    name = parents[name] if name in parents else org.node(name)['parent']
            share.update(new_path)
            if moving.intersection(new_path):
                break               # the body refuses this leg before mutation
            parents.update({name: target for name in moving})
        except LedgerError:
            break                   # the body supplies the exact ordinary refusal
    return update, share - update


@dataclass(frozen=True)
class Leg:
    raw: Any
    moving: tuple[str, ...]
    stats: graph.SubtreeStats
    tokens: dict[str, tuple[int, int]]
    use_stats: bool = True


def begin(org: Any, actor: str, root: str, target: str | None) -> Leg | None:
    raw = connection(org)
    if raw is None:
        return None
    update, share = rows(org, actor, [(root, target)])
    graph.check_paths(raw, update | share, updates=update)
    tokens = {str(name): (int(agent_id), int(version)) for name, agent_id, version in raw.execute(
        'SELECT name,id,row_version FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone',
        (sorted(update),)).fetchall()}
    if set(tokens) != update:
        raise LedgerError('native move agent disappeared after its lock plan')
    return Leg(raw, (root, *org.lineage_stack(root)), graph.subtree_stats(raw, root), tokens,
               graph.clean_stats(org, raw))


def persist(leg: Leg, org: Any, target: str | None, up: list[str],
            down: list[str], cost: float) -> None:
    """CAS the planned parent/grant fields before publishing them in memory."""
    values = {name: {'parent': target} for name in leg.moving}
    if cost:
        for name in up:
            values.setdefault(name, {})['grant'] = _q(org.node(name)['grant'] - cost)
        for name in down:
            values.setdefault(name, {})['grant'] = _q(org.node(name)['grant'] + cost)
    patches = []
    for name, fields in values.items():
        changed = {key: value for key, value in fields.items() if org.node(name).get(key) != value}
        if changed:
            agent_id, version = leg.tokens[name]
            patches.append(graph.ScalarPatch(agent_id, name, version, changed))
    graph.apply_scalars(leg.raw, patches)


def composite_begin(org: Any) -> Any | None:
    """A later refused leg must also restore earlier scalar SQL and GUC state."""
    raw = connection(org)
    if raw is not None:
        raw.execute('SAVEPOINT graph_move_verb')
    return raw


def composite_end(raw: Any | None, *, failed: bool = False) -> None:
    if raw is not None:
        if failed:
            raw.execute('ROLLBACK TO SAVEPOINT graph_move_verb')
        raw.execute('RELEASE SAVEPOINT graph_move_verb')
