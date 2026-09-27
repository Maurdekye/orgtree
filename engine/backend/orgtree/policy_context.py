"""Read-only inputs for recurring policies; writes keep their existing doors.

The selected graph includes every live node, truthy archived freezes, and exact
ancestry/predecessors. This is deliberately separate from the display adapter:
there are no UI card windows, funding totals or archive counts here.
"""
from __future__ import annotations

import copy
import json
import time

from . import policy_candidates, store
from .ledger import Org, USER, norm_dirs, retag_legacy_spend_freeze


def org_rows():
    """Enumerate identities without rebuilding summaries on PostgreSQL."""
    if store.STORE_BACKEND == 'postgres':
        return [{'slug': slug} for slug in store.org_slugs()]
    return store.cached_list()


def candidate_ids(org):
    """Relationship rows are inputs, never additional action candidates."""
    if isinstance(org, PolicyContext):
        return org.candidate_ids
    return org.nodes


class PolicyContext:
    _read_only_projection = True
    _shared_snapshot = True
    _READ_METHODS = frozenset(('node', 'parent', 'ancestors', 'is_ancestor',
        'children_index', 'model_for', 'versions_for', 'harness_for',
        'prefer_reserve_for', 'effective_effort', 'account_fallback_for',
        'is_kiosk', 'kiosk_ceiling', '_has_audience', 'multi_holder_enabled',
        'waking_mail', '_work_actor_node', '_work_status', '_work_counts_active',
        '_work_attention', '_work_identity_state', '_work_next_recipient',
        '_work_deploy_recipient', '_work_owed_active', '_work_nonterminal_org',
        'work_org_all_blocked', 'work_idle_reminder_items', 'work_docket_reminder_items'))

    def __init__(self, settings, graph, work_rows):
        from .foreground_context import _compatible, CompatibilityRequired
        from .readonly_projection import ProjectionDoc

        nodes = copy.deepcopy(graph.nodes)
        _compatible(settings, nodes)
        if any(isinstance(row, dict) and not row.get('id')
               for rows in (settings.get('mail') or {}).values() for row in rows):
            raise CompatibilityRequired('pending mail needs legacy identity normalization')
        self.d = ProjectionDoc(copy.deepcopy(settings))
        self.d['nodes'] = nodes
        self.candidate_ids = graph.candidates
        for nid, node in nodes.items():
            node.setdefault('ui_order', float(graph.ordinals[nid]))
        # Shared pure normalization, never whole-Org migrations on a subset.
        Org._normalize_display_basics(self)
        Org._normalize_display_models(self)
        self.d['dirs'] = norm_dirs(self.d.get('dirs'))
        kiosk = self.d.get('kiosk')
        if kiosk is not None:
            kiosk.setdefault('auto_raise', False)
            cap = int(kiosk.get('credits') or 0)
            if cap and int(self.d.get('default_top_grant') or 0) >= cap:
                self.d['default_top_grant'] = 0
        for node in nodes.values():
            retag_legacy_spend_freeze(node.get('frozen'))
            if not self.d.get('fable_lock'):
                node.pop('limit_locked', None)
        self._work_rows = [copy.deepcopy(row.summary) for row in work_rows]
        self._questions = {row.summary['slug']: copy.deepcopy(row.questions) for row in work_rows}

    @property
    def nodes(self):
        return self.d['nodes']

    def __getattr__(self, name):
        if name in self._READ_METHODS:
            return vars(Org)[name].__get__(self, type(self))
        value = vars(Org).get(name)
        if name.isupper() and value is not None and not callable(value):
            return value
        raise AttributeError(name)

    def _work_active(self):
        return self._work_rows

    def _work_questions(self, slug):
        return self._questions.get(slug, [])


def _build(conn, graph, *, docket):
    from .foreground_context import CompatibilityRequired
    from . import workquery

    settings = policy_candidates.settings(conn)
    if 'audiences' not in settings:
        settings['audiences'] = [json.loads(row[0]) for row in conn.execute(
            "SELECT val FROM log_l WHERE sect='audiences' ORDER BY seq").fetchall()]
    # Only queues belonging to this selected graph, on the SAME snapshot.
    # A legacy container remains authoritative until the normal writer heals it.
    ids = list(graph.nodes)
    keys = ['mail', 'delivering']
    keys += [sect + store.SPLIT_SEP + nid for sect in ('mail', 'delivering') for nid in ids]
    blobs = {key: json.loads(value) for key, value in conn.execute(
        'SELECT key,val FROM doc WHERE key=ANY(?)', (keys,)).fetchall()}
    for sect in ('mail', 'delivering'):
        legacy = blobs.get(sect) or {}
        if not isinstance(legacy, dict):
            raise CompatibilityRequired('unknown pending queue container')
        selected = {}
        for nid in ids:
            rows = blobs.get(sect + store.SPLIT_SEP + nid, legacy.get(nid, []))
            if rows:
                selected[nid] = rows
        settings[sect] = selected
    rows = []
    if docket:
        # Reuse the indexed catalog and its health/identity checks. Only
        # physically active rows can belong to Org._work_active; terminal
        # rows omitted by foreground cannot pass _work_counts_active anyway.
        query = workquery.Snapshot(conn.raw, conn.org_id, viewer=USER, now_ts=time.time())
        rows = [row for row in query.foreground(include_backlogged=True) if not row.physical_archive]
    return PolicyContext(settings, graph, rows)


def read(slug, *, docket=False):
    """Exact fallback on old backends or unsupported normalization/catalogs."""
    try:
        from .foreground_context import CompatibilityRequired
    except ImportError:
        # The shared normalization extraction can land independently of this
        # candidate reader. Until present, do not emulate it on a partial Org.
        return store.cached_org(slug)
    from .workquery import CompatibilityRequired as WorkCompatibilityRequired
    try:
        got = policy_candidates.read(slug, lambda conn, graph: _build(conn, graph, docket=docket))
    except (CompatibilityRequired, WorkCompatibilityRequired):
        got = None
    return store.cached_org(slug) if got is None else got
