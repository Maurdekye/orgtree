"""Flat foreground wire projection, using the existing display field producers.

This module does not load an Org or query storage. Its input graph and context
must come from one committed snapshot; the API still owns runtime annotation
and public scrubbing. Only selected identities enter the returned flat map.
"""
from __future__ import annotations

import hashlib
from typing import Any, Callable

from . import tree_delta
from .ledger import LedgerError

FORMAT = 'orgtree.foreground-tree/v1'


def catalog(graph: dict) -> str:
    stamp = graph['stamp']
    return f"{stamp['org_id']}:{stamp['catalog_revision']}"


def topology(graph: dict) -> tuple[list[str], dict[str, list[str]]]:
    """Validate all ancestor chains, including explicitly selected off-axis rows."""
    rows = graph['rows']
    if graph.get('missing_ancestors'):
        raise LedgerError('foreground ancestor is missing')
    complete: set[str] = set()
    for nid in rows:
        path: set[str] = set()
        current = nid
        while current and current not in complete:
            if current in path:
                raise LedgerError('foreground ancestor cycle')
            if current not in rows:
                raise LedgerError('foreground ancestor is missing')
            path.add(current)
            current = rows[current]['meta']['parent']
        complete.update(path)
    children: dict[str, list[str]] = {nid: [] for nid in rows}
    children[''] = []
    for nid, row in rows.items():
        meta = row['meta']
        if not (meta['state'] == 'archived' and meta['successor']):
            children[meta['parent']].append(nid)
    for ids in children.values():
        ids.sort(key=lambda nid: (rows[nid]['meta']['order'], rows[nid]['meta']['created'],
                                  rows[nid]['ordinal'], nid))
    return children.pop(''), children


def prepare(context: Any, graph: dict, *, detail_token: Callable[[dict], str],
            sync_rev: int, primed_restart: Any = None) -> dict:
    """Build rows once, without descendant/lineage walks or historical bodies.

    The old archived detail hash also covers lineage. Since lineage is loaded
    on demand here, add its committed catalog dependency to the local detail
    hash. This token is opaque and conservative: a catalog change may evict a
    detail even when that node's own omitted fields stayed unchanged.
    """
    roots, children = topology(graph)
    index = context.children_index()
    entries, extra = [], {}
    version = catalog(graph)
    for nid, row in graph['rows'].items():
        node = context.tree_node(nid, children_index=index, descend=False, lineage=False)
        meta = row['meta']
        extra[nid] = {
            'parent': meta['parent'] or None,
            'axis': 'lineage' if meta['state'] == 'archived' and meta['successor'] else 'org',
            'predecessor': meta['predecessor'] or None,
            'successor': meta['successor'] or None,
            'children': children[nid],
            'hidden_retired_children': graph['hidden_retired_children'].get(nid, 0),
            'lineage_count': row['lineage_count'],
            'lineage_loaded': False,
            'consultable_predecessor': row['consultable_predecessor'],
        }
        if node['state'] == 'archived':
            extra[nid]['detail_rev'] = hashlib.sha256(
                tree_delta.encode([version, detail_token(node)])).hexdigest()[:32]
        entries.append(node)
    tree = context.tree_header(entries)
    tree['sync_rev'] = sync_rev
    tree['org_rev'] = graph['stamp']['org_revision']
    tree['primed_restart'] = primed_restart
    return {'tree': tree, 'roots': roots, 'extra': extra, 'graph': graph}


def finish(prepared: dict, annotated: dict, *, kind: str = 'snapshot',
           requested: str | None = None) -> dict:
    """Pack already annotated/scrubbed rows; never restore omitted private data."""
    graph = prepared['graph']
    nodes = {}
    for node in annotated['roots']:
        nid = node['id']
        if nid in nodes or nid not in prepared['extra']:
            raise LedgerError('foreground projection identities disagree')
        nodes[nid] = {**node, **prepared['extra'][nid]}
        nodes[nid].pop('lineage', None)
    if nodes.keys() != prepared['extra'].keys():
        raise LedgerError('foreground projection lost an identity')
    result = {'format': FORMAT, 'kind': kind, 'catalog_revision': catalog(graph),
              'org_rev': annotated['org_rev'], 'sync_rev': annotated['sync_rev'],
              'nodes': nodes}
    if kind == 'snapshot':
        header = {key: value for key, value in annotated.items()
                  if key not in ('roots', 'sync_rev', 'org_rev')}
        header['hidden_retired_roots'] = graph['hidden_retired_children'].get('', 0)
        header['retired_total'] = graph['stamp']['retired_axis_count']
        result.update(header=header, roots=prepared['roots'],
                      missing_requested=graph.get('missing', []))
    elif kind == 'page':
        result.update(matches=graph['matches'], next_cursor=graph['next_cursor'])
    elif kind == 'lookup':
        path: list[str] = []
        current = requested
        while current in nodes:
            path.append(current)
            current = nodes[current]['parent']
        result.update(requested=requested, found=requested in nodes, path=list(reversed(path)))
    else:
        raise ValueError('unknown foreground representation')
    return result


def revision(view: dict) -> str:
    return hashlib.sha256(tree_delta.encode({k: v for k, v in view.items()
        if k not in ('org_rev', 'sync_rev', 'revision')})).hexdigest()[:32]


def _changed(before: dict, after: dict) -> dict:
    change = tree_delta.changed(before, after)
    return {'set': change['set'], 'unset': change['remove']}


def delta(before: dict, after: dict, base: str, token: str) -> dict:
    old, new = before['nodes'], after['nodes']
    return {'format': FORMAT, 'kind': 'delta', 'base': base, 'revision': token,
            'org_rev': after['org_rev'], 'sync_rev': after['sync_rev'],
            'catalog_revision': after['catalog_revision'], 'roots': after['roots'],
            'missing_requested': after['missing_requested'],
            'header': _changed(before['header'], after['header']),
            'nodes': {nid: _changed(old.get(nid, {}), node) for nid, node in new.items()
                      if not tree_delta.equal(old.get(nid), node)},
            'removed': [nid for nid in old if nid not in new]}
