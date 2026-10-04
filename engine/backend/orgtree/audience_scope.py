"""Audience availability follows current placement; stored grants are retained."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .scope_chain import ScopeError


def read_paths(raw, grants):
    """Selected audience identities/parents from the caller's one read snapshot.

    Foreground funding omits archived nodes, so it cannot decide an anchored
    grant's availability. Read metadata for only the grants' upward closure;
    no historical bodies or audience section is opened by this helper.
    """
    from .orgdb import agents   # noqa: PLC0415
    from .ledger import USER, EXTERN   # noqa: PLC0415
    roots = {name for grant in grants for name in (
        grant['grantee'], grant['grantor'],
        grant.get('delegated_by') or grant['grantor'])
        if isinstance(name, str) and name not in (USER, EXTERN)}
    names = agents.ancestors(raw, sorted(roots)) if roots else []
    rows = (raw.execute('SELECT a.name,p.name,a.parent_misfit,a.extra '
                        'FROM orgtree.agents a LEFT JOIN orgtree.agents p ON p.id=a.parent_id '
                        'WHERE NOT a.tombstone AND a.name=ANY(%s)', (names,)).fetchall()
            if names else ())
    return {name: extra.get('parent') if misfit else parent
            for name, parent, misfit, extra in rows}


def available(grant: Mapping[str, Any], exists: Callable[[str], bool],
              parent: Callable[[str], str | None], *, user: str, extern: str) -> bool:
    """The exact sweep predicate, evaluated on use instead of deleting a grant.

    USER grants keep their existing unconditional exception. An EXTERN grant
    is unanchored only when delegated_by is absent, not when it is merely null.
    """
    grantor, grantee = grant['grantor'], grant['grantee']
    if grantor == user:
        return True
    if not exists(grantee):
        return False
    anchor = grant.get('delegated_by') or grantor
    if grantor == extern:
        if 'delegated_by' not in grant:
            return True
    elif not exists(grantor):
        return False
    elif anchor == user:
        return True
    if not exists(anchor):
        return False
    # Validate the complete selected chain, including cycles past the anchor.
    seen = {grantee}
    ancestors: set[str] = set()
    current = parent(grantee)
    while current is not None:
        if current in seen:
            raise ScopeError('cyclic audience authority chain')
        if not exists(current):
            raise ScopeError('missing audience authority ancestor')
        seen.add(current)
        ancestors.add(current)
        current = parent(current)
    return anchor in ancestors or (grantor == extern and anchor == grantee)
