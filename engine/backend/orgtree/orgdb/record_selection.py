"""One-shot UI name/search resolution; bodies still arrive on record sets."""
from __future__ import annotations

from . import agents, record_reads as Q, record_tree as T


def arguments(args):
    if not isinstance(args, dict) or set(args)-{'names', 'search'}:
        raise ValueError('invalid record selection')
    names, search = args.get('names', []), args.get('search')
    if (not isinstance(names, list) or len(names) > Q.MAX_AGENTS**2
            or any(not isinstance(name, str) or not name or len(name) > 256 for name in names)):
        raise ValueError('invalid selection names')
    if search is not None:
        if not isinstance(search, dict) or set(search)-{'query', 'state'}:
            raise ValueError('invalid selection search')
        query, state = search.get('query'), search.get('state')
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 256:
            raise ValueError('search needs 1 to 256 characters')
        if state not in (None, 'live', 'archived', 'unrecoverable'):
            raise ValueError('unknown state filter')
        search = dict(query=query.strip().lower(), state=state)
    return tuple(dict.fromkeys(names)), search


def resolve(slug, names, search):
    # All search pages and the final mapping share ONE read-only snapshot.
    # Search is a one-shot selection, never a live predicate subscription.
    with Q.snapshot(slug) as state:
        found, after = [], None
        if search is not None:
            while True:
                page = agents.search_page(state.raw, search['query'], search['state'], after, 1000)
                found.extend(name for name, in page)
                if len(page) < 1000:
                    break
                after = page[-1][0]
        mapped = T._identities(state, (*names, *found))
        return dict(cursor=Q.cursor(state).wire(),
                    names={name:mapped[name] for name in names if name in mapped},
                    missing=[name for name in names if name not in mapped],
                    matches=[mapped[name] for name in found])
