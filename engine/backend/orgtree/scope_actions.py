"""Current capability decisions on the connection that protects the action."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar('T')


def run(org: Any, nid: str, action: Callable[[Any], T]) -> T:
    """Hold current ancestor paths through a bounded capability action.

    Cached documents identify the org only. Resolve the scope before entering
    the action, so a plan miss widens before any filesystem effect. A caller
    already in an org transaction keeps its existing locks and commit owner.
    Legacy storage keeps its existing document and configured-scope behavior.
    """
    from .orgdb import native_move
    if not native_move.enabled():
        return action(org)
    from . import pgdoor

    def decided(current: Any) -> T:
        current.capability_scope(nid)
        return action(current)

    slug = org.d['slug']
    active = pgdoor.current(slug)
    if active is not None:
        return decided(active.org)
    return pgdoor.run(slug, pgdoor.TxSpec(share_nodes=(nid,)),
                      lambda tx: decided(tx.org))
