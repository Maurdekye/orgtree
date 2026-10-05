"""Set-independent tree records built on the caller's committed snapshot.

The existing ledger/API producers own display rules. This adapter only selects
identities, separates org/runtime/app values and adds the record topology keys.
"""
from __future__ import annotations

import hashlib
import copy
from typing import Any

from . import agents
from .record_registry import Entity, Registry, Selection, Snapshot, WindowKind, ScopeResult
from .. import foreground_context, foreground_store, foreground_view, tree_delta


GROUPS = {
    'settings': '''slug name workspace dirs max_top_grant default_top_grant compact_at
        default_tools default_visibility default_account permission_mode default_effort
        effort_default account_fallback_default auto_resume auto_resume_compact auto_cheap_compact
        fable_limit_policy fable_filter_policy fable_filter_model cascade_hire cascade_alloc headless'''.split(),
    'tiers': ['tiers', 'models'],
    'cost': ['cost_usd_total', 'cost_usd_unknown', 'api_cost_usd_total'],
    'audit': ['audit'],
    'foreground': ['fable_lock', 'killswitch', 'archived_defaults', 'retired_total',
                   'retired_roots_total'],
    'asks': ['asks', 'asks_open', 'credit_requests'],
    'audiences': ['audiences', 'audience_requests'],
    'watchdogs': ['watchdogs'],
    'inbox_summary': ['user_inbox_count', 'urgent_unread', 'user_inbox_newest'],
    'org_inbox': ['org_inbox'],
    'net': ['net'],
    'work_summary': ['work_items_summary'],
}


def _identities(state: Snapshot, names) -> dict[str, str]:
    if not names:
        return {}
    return {name: key for key,name in state.raw.execute(
        'SELECT a.id::text,a.name FROM '
        '(SELECT DISTINCT name FROM unnest(%s::text[]) wanted(name)) selected '
        'CROSS JOIN LATERAL (SELECT id,name FROM orgtree.agents '
        'WHERE NOT tombstone AND name=selected.name OFFSET 0) a',
        (list(names),))}


def _names(state: Snapshot, ids) -> list[str]:
    if not ids:
        return []
    return [row[0] for row in state.raw.execute(
        'SELECT a.name FROM '
        '(SELECT DISTINCT id FROM unnest(%s::bigint[]) wanted(id)) selected '
        'CROSS JOIN LATERAL (SELECT name FROM orgtree.agents '
        'WHERE NOT tombstone AND id=selected.id OFFSET 0) a',
        (list(ids),))]


def members(state: Snapshot, selection: Selection) -> frozenset[str]:
    if selection.set == 'shared':
        graph = state.cache.get('tree_shared_graph')
        if graph is None:
            graph = foreground_store.select_foreground(state.raw, dict(state.stamp), piles={})
            state.cache['tree_shared_graph'] = graph
        names = graph['rows']
    else:
        names = agents.ancestors(state.raw, _names(state, selection.agents))
    return frozenset(_identities(state, names).values())


def _archived_validate(arguments):
    kind = arguments.get('kind')
    expected = {'kind'} if kind == 'archived_all' else {'kind','parent'}
    if kind not in ('archived_all','archived_under') or set(arguments) != expected:
        raise ValueError('invalid archived tree predicate')
    if kind == 'archived_under':
        parent = arguments['parent']
        if (not isinstance(parent,str) or not parent.isascii() or not parent.isdigit()
                or not 0 <= int(parent) < 2**63 or str(int(parent)) != parent):
            raise ValueError('archived parent must be a database ID, or 0 for roots')
    return dict(arguments)


def _archived_members(state: Snapshot, arguments) -> frozenset[str]:
    """Own-row predicate membership plus current ancestors on this snapshot.

    No newest-K displacement: own-row state/parent OLD+NEW capture and existing
    old/new chain capture suffice for predicate entrants/leavers/ancestors.
    Rare imported field values still use the same exact agent decoder.
    """
    under = arguments['kind'] == 'archived_under'
    parent = arguments.get('parent')
    parent_name = _names(state,(parent,)) if under and parent != '0' else ['']
    if under and not parent_name:
        return frozenset()
    where = "NOT a.tombstone AND a.state='archived' AND NOT a.state_misfit"
    rare = 'a.state_misfit'
    if under:
        where += ' AND NOT a.parent_misfit'
        # Roots can reference NULL or a retained empty-name identity. Keep
        # that legacy axis, including tombstones, while using scalar probes
        # of the parent index for every physical parent identity.
        parents = ([None, *(row[0] for row in state.raw.execute(
            "SELECT id FROM orgtree.agents WHERE name=''"))]
            if parent == '0' else [int(parent)])
        names = set()
        for physical in parents:
            after = None
            while True:
                # Bounded keyset reads retain the parent/name index order even
                # when almost every retained agent belongs to this parent.
                # An equality plus name order can instead walk agents_name.
                predicate = ('a.parent_id IS NULL' if physical is None else
                    'a.parent_id>=%s::bigint AND a.parent_id<=%s::bigint')
                params = [] if physical is None else [physical,physical]
                if after is not None:
                    predicate += (' AND a.name>%s' if physical is None else
                        ' AND (a.parent_id,a.name)>(%s::bigint,%s)')
                    params.extend([after] if physical is None else [physical,after])
                page = list(state.raw.execute('SELECT a.name FROM orgtree.agents a WHERE '+
                    where+' AND '+predicate+' ORDER BY a.parent_id,a.name LIMIT 128', params))
                names.update(row[0] for row in page)
                if len(page) < 128:
                    break
                after = page[-1][0]
        rare = '(a.state_misfit OR a.parent_misfit)'
    else:
        names = {row[0] for row in state.raw.execute(
            'SELECT a.name FROM orgtree.agents a WHERE '+where)}
    for name,(_ordinal,value) in agents._hot(state.raw,rare).items():
        if value['state'] == 'archived' and (not under or value['parent'] == parent_name[0]):
            names.add(name)
    return frozenset(_identities(state,agents.ancestors(state.raw,list(names))).values())


def prepare_context(state: Snapshot, ids: frozenset[str]):
    """One pass's rebuilt IDs and formatter dependencies, never all held IDs."""
    names = _names(state, ids)
    closure = agents.ancestors(state.raw,
        agents._ref_closure(state.raw, names, 'predecessor')) if names else []
    expanded = frozenset(_identities(state, closure).values())
    context, graph = _context(state, expanded)
    state.cache['tree_pass_context'] = (expanded, context, graph)


def _context(state: Snapshot, ids: frozenset[str]):
    prepared = state.cache.get('tree_pass_context')
    if prepared is not None:
        covered, context, graph = prepared
        if not ids <= covered:
            raise RuntimeError('record pass did not plan its context dependencies')
        return context, graph
    names = _names(state, ids)
    graph = state.cache.get('tree_shared_graph')
    if graph is None or set(graph['rows']) != set(names):
        graph = foreground_store._graph(state.raw, dict(state.stamp), names)
    context = foreground_context.build(state.raw, state.slug, graph, records=True, now_ts=state.now)
    state.cache['tree_context'] = (context, graph)
    return context, graph


def detail_versions(state: Snapshot, names) -> dict[str, list]:
    """Own and predecessor-chain versions, including exact rare references.

    No catalog/revision number is hashed by itself. Missing/deleted links are
    represented by the own row's version and the exact graph metadata token.
    """
    closure = agents._ref_closure(state.raw, names, 'predecessor')
    metadata = agents._hot(state.raw, 'a.name=ANY(%s)', (closure,)) if closure else {}
    versions = dict(state.raw.execute('SELECT a.name,coalesce(v.version,0) '
        'FROM orgtree.agents a LEFT JOIN orgtree.record_detail_versions v ON v.agent_id=a.id '
        'WHERE NOT a.tombstone AND a.name=ANY(%s)', (closure,))) if closure else {}
    result = {}
    for name in names:
        chain, seen, current = [], set(), name
        while current in metadata and current not in seen:
            seen.add(current)
            chain.append([current, versions[current]])
            current = metadata[current][1]['predecessor']
        result[name] = chain
    return result


def bodies(state: Snapshot, ids: frozenset[str]) -> dict[str, Any]:
    from .. import api, supervisor
    context, graph = _context(state, ids)
    # Validate cycles/missing parents with the same foreground rule, even
    # though bodies contain no children and are independent of held sets.
    foreground_view.topology(graph)
    keys = _identities(state, graph['rows'])
    totals = agents.retired_counts(state.raw, list(graph['rows']))
    versions = detail_versions(state, graph['rows'])
    result = {}
    for name, row in graph['rows'].items():
        key = keys[name]
        if key not in ids:
            continue
        node = context.tree_node(name, descend=False, lineage=False)
        api._rederive_freeze_reset(node, {}, now_ts=state.now)
        api._stamp_wake_countdown(node)
        if node['state'] == 'archived':
            token = hashlib.sha256(tree_delta.encode(
                [api._archived_detail_rev(node), versions[name]])).hexdigest()[:32]
            api._summarise_archived(node)
            node['detail_rev'] = token
        else:
            node['resumable'] = supervisor.resumable(context.node(name)) and not context.d.get('killswitch')
            config = supervisor._auto_cheap_cfg(context, name)
            node['cheap_compact_on'] = config is not None
            node['cheap_compact_occ'] = float(config['occ']) if config else None
            count = context.node(name).get('last_turn_mcp_tool_count')
            node['last_turn_mcp_tool_count'] = count if type(count) is int else None
        node.pop('cache_forecast', None)
        node.pop('children', None)
        node.pop('lineage', None)
        meta = row['meta']
        node.update(name=name, parent_id=keys.get(meta['parent']),
            axis='lineage' if meta['state']=='archived' and meta['successor'] else 'org',
            predecessor=meta['predecessor'] or None, successor=meta['successor'] or None,
            ui_order=float(meta['order']), created=meta['created'], ord=row['ordinal'],
            retired_children_total=totals.get(name,0), lineage_count=row['lineage_count'],
            lineage_loaded=False, consultable_predecessor=row['consultable_predecessor'])
        result[key] = node
    return result


def org_members(state: Snapshot, selection: Selection) -> frozenset[str]:
    return frozenset(GROUPS) if selection.set == 'shared' else frozenset()


def org_bodies(state: Snapshot, ids: frozenset[str]) -> dict[str, Any]:
    from .. import api, net
    saved = state.cache.get('tree_context')
    context, graph = saved if saved is not None else _context(state, frozenset())
    header = context.tree_header([])
    header.pop('roots')
    header.update(headless=bool(context.d.get('headless')),
        archived_defaults=api._ARCHIVED_RUNTIME_DEFAULTS,
        net=net.status_block(context.d, include_runtime=False),
        retired_total=state.stamp['retired_axis_count'],
        retired_roots_total=agents.retired_counts(state.raw, ['']).get('',0))
    declared = [key for keys in GROUPS.values() for key in keys]
    if len(set(declared)) != len(declared) or set(header) != set(declared):
        raise RuntimeError('tree header record grouping is incomplete: '+str(set(header)^set(declared)))
    return {group: {key: header[key] for key in GROUPS[group]} for group in ids}


def subtree_members(state: Snapshot, roots: frozenset[str], held) -> ScopeResult:
    """Walk UP from held agents, never down from a moved root at COMMIT.

    UNION terminates even for a damaged cycle. Every query and body builder
    uses R's explicit snapshot. A replacement removes departed ancestors
    without receiving or retaining the client's old membership.
    """
    if any(not key.isascii() or not key.isdigit() or not 0 < int(key) < 2**63
           or str(int(key)) != key for key in roots):
        raise ValueError('invalid subtree root')
    ids = frozenset(key for entities in held.values() for key in entities.get('agent', ()))
    if not ids or not roots:
        return ScopeResult()
    walked = state.raw.execute(
        'WITH RECURSIVE chain(held_id,id,parent_id,parent_misfit,tombstone) AS ('
        'SELECT a.id,a.id,a.parent_id,a.parent_misfit,a.tombstone FROM orgtree.agents a '
        'WHERE NOT a.tombstone AND a.id=ANY(%s::bigint[]) UNION '
        'SELECT c.held_id,a.id,a.parent_id,a.parent_misfit,a.tombstone FROM chain c '
        'JOIN orgtree.agents a ON a.id=c.parent_id WHERE NOT c.tombstone) '
        'SELECT held_id::text,bool_or(id=ANY(%s::bigint[])),bool_or(parent_misfit) '
        'FROM chain GROUP BY held_id', (sorted(ids),sorted(roots))).fetchall()
    affected = {key for key,matched,_rare in walked if matched}
    rare = [key for key,matched,misfit in walked if misfit and not matched]
    if rare:
        # A preserved scalar/container parent may name an existing agent even
        # with no typed parent_id (False -> "false", for example). Reuse the
        # native tree's exact, cycle-safe closure only for selected rare paths.
        # Normal trees still use one batched upward query, never a root's children.
        # Include a deleted parent's retained name so its live children still
        # receive bodies and a replacement after the ancestor disappears.
        root_names = frozenset(row[0] for row in state.raw.execute(
            'SELECT name FROM orgtree.agents WHERE id=ANY(%s::bigint[])',(sorted(roots),)))
        for key,name in state.raw.execute(
                'SELECT id::text,name FROM orgtree.agents WHERE NOT tombstone '
                'AND id=ANY(%s::bigint[])', (rare,)):
            closure = agents.ancestors(state.raw, [name])
            matched = bool(root_names.intersection(closure))
            if not matched and closure:
                metadata = agents._hot(state.raw,'a.name=ANY(%s)',(closure,))
                matched = any(value['parent'] in root_names for _ord,value in metadata.values())
            if matched:
                affected.add(key)
    return ScopeResult(frozenset(('agent',key) for key in affected),
        frozenset(name for name,entities in held.items()
                  if name != 'shared' and affected.intersection(entities.get('agent', ()))))


def register(registry: Registry) -> Registry:
    registry.register(Entity('agent', members, bodies))
    registry.register(Entity('org', org_members, org_bodies))
    registry.register_scope('subtree', subtree_members)
    for kind in ('archived_all','archived_under'):
        # The window selects existing agent records, not a second entity/body.
        registry.register_window(WindowKind(kind,_archived_validate,
            lambda _state,_arguments:'agent',_archived_members,bodies))
    return registry


def runtime_contexts(state: Snapshot, ids: frozenset[str]) -> dict[str, Any]:
    """Retain runtime inputs from the SAME snapshot as these agent bodies.

    Cache forecasting can inspect a predecessor outside the held set. Load
    that chain and its parents on this connection, never a full Org reload.
    Membership remains the requested IDs; these are only formatter inputs.
    """
    if not ids:
        return {}
    if 'tree_pass_context' in state.cache:
        context, _graph = _context(state, ids)
        return {key: context for key in ids}
    names = _names(state, ids)
    closure = agents.ancestors(state.raw,
        agents._ref_closure(state.raw, names, 'predecessor'))
    all_ids = frozenset(_identities(state, closure).values())
    context, _graph = _context(state, all_ids)
    return {key: context for key in ids}


def runtime_net_inputs(state: Snapshot) -> dict:
    """Keep only configuration needed to sample live hubs after this read.

    Spool payloads and identity secrets never enter the retained overlay.
    Queues/stuck counts remain in the revisioned org net body.
    """
    saved = state.cache.get('tree_context')
    context, _graph = saved if saved is not None else _context(state, frozenset())
    return dict(slug=context.d['slug'],
        net_identity={'slug': (context.d.get('net_identity') or {}).get('slug')},
        net_hubs=[{key: copy.deepcopy(hub[key]) for key in ('id','address','enabled','name') if key in hub}
                  for hub in context.d.get('net_hubs') or []],
        net_state={hid: {key: copy.deepcopy(cell[key]) for key in ('address','registered_at') if key in cell}
                   for hid,cell in (context.d.get('net_state') or {}).items()})
