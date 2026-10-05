"""Current capability decisions on the connection that protects the action."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar
from functools import wraps

T = TypeVar('T')


def current_inputs(fn: Callable[..., T]) -> Callable[..., T]:
    """Build dispatch inputs from a current transaction, before provider I/O.

    Runtime readers and completed admission transactions return LazyDocs too.
    Those documents must identify the org, not supply detached authority. Pure
    snapshots and already-pinned callers retain their existing behavior.
    """
    @wraps(fn)
    def wrapped(org: Any, nid: str, *args: Any, **kwargs: Any) -> T:
        from . import store
        from .orgdb import native_move
        if (native_move.enabled() and isinstance(org.d, store.LazyDoc)
                and not (getattr(store._orgtx_local, 'pinned', None) or {}).get(org.d['slug'])):
            return run(org, nid, lambda current: fn(current, nid, *args, **kwargs))
        return fn(org, nid, *args, **kwargs)
    return wrapped


@current_inputs
def current_scope(org: Any, nid: str) -> dict[str, Any]:
    """Capture scope for a launch input, including pure in-memory orgs."""
    return org.capability_scope(nid)


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
