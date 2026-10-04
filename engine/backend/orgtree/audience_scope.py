"""Audience availability follows current placement; stored grants are retained."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .scope_chain import ScopeError


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
    return anchor in ancestors
