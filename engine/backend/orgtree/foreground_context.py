"""Request-local, non-persistable context for indexed foreground tree views.

The adapter deliberately does NOT inherit Org: mutators and whole-org readers
are unavailable. Display normalization is shared, while history-dependent
legacy migrations explicitly request the existing compatibility path.
"""
from __future__ import annotations

import copy
import json
import time
from typing import Any

from .ledger import Org, LedgerError, USER, EXTERN, _q, norm_dirs, retag_legacy_spend_freeze
from .readonly_projection import ProjectionDoc


class CompatibilityRequired(RuntimeError):
    """Caller must use the exact legacy view, never an incomplete projection."""


# Explicitly small settings. Adding a historical section here is not a fallback.
SETTINGS = tuple('''slug name workspace dirs max_top_grant default_top_grant compact_at
 default_tools default_visibility default_account permission_mode default_effort
 tiers models deleted_cost_usd deleted_cost_usd_unknown api_cost_usd fable_lock
 killswitch spend_frozen storage_blocked storage_frozen storage_full disk
 fable_limit_policy fable_filter_policy fable_filter_model cascade_hire cascade_alloc
 sandbox kiosk auto_resume auto_resume_compact auto_resume_last auto_cheap_compact
 account_fallback_default net_hubs net_state org_inbox_multi_holder
 external_inbox_multi_holder _migrations _actors_typed whole_grants_v1
 headless max_children max_depth created version'''.split())
CURRENT_LISTS = ('audiences', 'audience_requests', 'user_inbox', 'watchdogs', 'watchdog_tombs')


def _compatible(settings, nodes):
    if not settings.get('_actors_typed') or not settings.get('whole_grants_v1'):
        raise CompatibilityRequired('whole-org legacy normalization is required')
    migrations = settings.get('_migrations') or {}
    for key in (Org.MAIL_LOG_ID_MIGRATION, Org.STEER_VIEW_STRIP_MIGRATION,
                Org.EXTERN_MULTI_HOLDER_MIGRATION, Org.SEAT_ID_MIGRATION):
        if key not in migrations:
            raise CompatibilityRequired('legacy migration marker missing: ' + key)
    kiosk = settings.get('kiosk')
    if kiosk is not None and not kiosk.get('max_scope'):
        raise CompatibilityRequired('kiosk ceiling must be derived from the whole org')
    lock = settings.get('fable_lock') or {}
    if lock and not lock.get('no_reset') and (
            not lock.get('until_ts') or time.time() >= float(lock['until_ts'])):
        raise CompatibilityRequired('expired fable lock requires whole-org normalization')
    for nid, row in nodes.items():
        book = row.get('cache_continuity') or {}
        pred = row.get('predecessor')
        if (isinstance(book, dict) and isinstance(book.get('public'), dict)
                and isinstance(book.get('forecast'), dict) and pred
                and pred not in nodes and pred.split('@')[0] != nid.split('@')[0]):
            # _build_cmd grants a separate predecessor's scratch only when its
            # row exists. A subset cannot decide that membership for a preview.
            raise CompatibilityRequired('cache forecast needs omitted predecessor identity')
    if any(not row.get('seat_id') for row in nodes.values()):
        raise CompatibilityRequired('legacy seat identity requires whole lineage')


def valid_until(settings):
    """The earliest clock time at which _compatible would refuse these
    settings although nothing was committed: an unpinned fable lock expires,
    and only the whole-org path releases it. None when there is none."""
    lock = settings.get('fable_lock') or {}
    if lock and not lock.get('no_reset') and lock.get('until_ts'):
        return float(lock['until_ts'])
    return None


def still_valid(context):
    """May a kept context be projected again, now? (review f4: reusing it past
    a clock deadline would keep serving what a fresh build refuses.)"""
    deadline = getattr(context, 'valid_until', None)
    return deadline is None or time.time() < deadline


class ForegroundContext:
    _read_only_projection = True
    # Only composed display/query methods, never mutation or persistence methods.
    _READ_METHODS = frozenset(('node', 'parent', 'ancestors', 'is_ancestor',
        'children_index', 'model_for', 'versions_for', 'harness_for', 'prefer_reserve_for', 'effective_effort', 'node_ask', '_scope_item_label', '_tomb_expired',
        'seat_cost', 'free', 'is_kiosk', 'kiosk_ceiling', '_has_audience', 'multi_holder_enabled', '_boot_at', 'account_fallback_for'))

    def __init__(self, *, settings, graph, funding, windows, inbox, work_counts, reuse=None):
        if work_counts is None:
            raise CompatibilityRequired('coherent work counts unavailable')
        # `reuse`: nodes an earlier context of THE SAME settings already
        # normalized (foreground-tree F3b-2). Normalization is idempotent, so
        # re-running it below over them changes nothing; only the others are
        # copied from the graph and normalized for the first time.
        reuse = reuse or {}
        nodes = {nid: reuse[nid] if nid in reuse else copy.deepcopy(row['node'])
                 for nid, row in graph['rows'].items()}
        _compatible(settings, nodes)
        if any(not row.get('id') for row in settings.get('user_inbox', [])):
            raise CompatibilityRequired('legacy user mail identifiers require normalization')
        if any(isinstance(row, dict) and not row.get('id')
               for rows in (settings.get('mail') or {}).values() for row in rows):
            raise CompatibilityRequired('legacy pending mail identifiers require normalization')
        self.d = ProjectionDoc(copy.deepcopy(settings))
        self.d['nodes'] = nodes
        for nid, node in nodes.items():
            node.setdefault('ui_order', float(graph['rows'][nid]['ordinal']))
        # These helpers perform local normalization only, with no event/migration
        # side effects and no history scans. Never call Org.__init__ here.
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
        self.d.update(copy.deepcopy(windows['asks']))
        self.d['documents'] = [dict(copy.deepcopy(d), node=nid) for nid, docs in windows['documents'].items() for d in docs]
        self.d['org_inbox'] = copy.deepcopy(inbox['entries'])
        self._inbox = copy.deepcopy(inbox)
        self._document_counts = dict(windows['document_counts'])
        self._work_counts = dict(work_counts)
        self._stamp = copy.deepcopy(graph['stamp'])
        self._funding = {r['id']: dict(r) for r in funding}
        self._committed = {}
        for row in funding:
            tier = {'gpt-6-sol': 'sol', 'gpt-6-luna': 'luna'}.get(row['model'], row['model'])
            if row.get('grant') is None or tier not in self.d['tiers']:
                raise CompatibilityRequired('funding metadata requires legacy normalization')
            parent = row['parent'] or None
            self._committed.setdefault(parent, []).append(self.d['tiers'][tier] + row['grant'])
        self._committed = {key: _q(sum(values)) for key, values in self._committed.items()}

    @property
    def nodes(self):
        return self.d['nodes']

    def __getattr__(self, name):
        if name in self._READ_METHODS:
            descriptor = vars(Org)[name]
            return descriptor.__get__(self, type(self))
        # Constants used by shared display routines; no callable escapes.
        value = vars(Org).get(name)
        if name.isupper() and value is not None and not callable(value):
            return value
        raise AttributeError(name)

    def committed(self, nid, index=None):
        return self._committed.get(nid, 0.0)

    def audit(self):
        live = [(nid, n) for nid, n in self._funding.items() if n['state'] == 'live']
        problems = [f'{nid} free={free:g}' for nid, n in live
                    if (free := _q(n['grant'] - self.committed(nid))) < 0]
        return {'live_nodes': len(live), 'top_level_holds': self.committed(None),
                'no_overdraft': not problems, 'problems': problems}

    def cost_total(self):
        return round(float(self._stamp['cost']) + float(self.d.get('deleted_cost_usd') or 0.0), 4)

    def work_counts(self):
        return dict(self._work_counts)

    def extern_holders(self):
        from types import SimpleNamespace
        view = SimpleNamespace(d=self.d, nodes=self._funding,
                               multi_holder_enabled=self.multi_holder_enabled)
        return Org.extern_holders(view)

    def tree_node(self, nid, *, children_index=None, descend=False, lineage=False):
        if descend or lineage:
            raise ValueError('foreground node projection cannot traverse unselected history')
        result = Org.tree_node(self, nid, children_index=children_index if children_index is not None else {},
                               descend=False, lineage=False)
        result['documents_count'] = self._document_counts.get(nid, 0)
        return result

    def tree_header(self, roots):
        result = Org.tree_header(self, roots)
        result['cost_usd_unknown'] = bool(self.d.get('deleted_cost_usd_unknown') or self._stamp['cost_unknown'])
        result['org_inbox'].update(copy.deepcopy(self._inbox))
        return result


def build(raw, slug: str, graph: dict, *, header: bool = True,
          viewer: str = USER, now_ts: float | None = None,
          reuse: dict | None = None, reuse_settings: str | None = None) -> ForegroundContext:
    """Consume the graph's still-open committed snapshot; never open another.

    ``reuse`` hands over nodes an earlier context normalized; they are used
    only when this snapshot's settings still equal ``reuse_settings`` (that
    context's ``settings_key``), otherwise every node is copied and normalized.
    """
    from . import foreground_store, store, tree_delta
    check = raw.execute("SELECT current_setting('transaction_isolation'), "
                        "current_setting('transaction_read_only'), revision FROM public.orgs "
                        "WHERE org_id=%s", (graph['stamp']['org_id'],)).fetchone()
    if check != ('repeatable read', 'on', graph['stamp']['org_revision']):
        raise CompatibilityRequired('graph/context must share one committed read-only snapshot')
    ids = list(graph['rows'])
    owner_sections = ('mail', 'delivering')
    keys = list(SETTINGS + CURRENT_LISTS + owner_sections)
    keys += [sect + store.SPLIT_SEP + nid for sect in owner_sections for nid in ids]
    blobs = {key: json.loads(val) for key, val in raw.execute(
        'SELECT key,val FROM doc WHERE key=ANY(%s)', (keys,)).fetchall()}
    if blobs.get('slug') != slug:
        raise CompatibilityRequired('organization identity changed')
    for sect in CURRENT_LISTS:
        if sect not in blobs:
            blobs[sect] = [json.loads(row[0]) for row in raw.execute(
                'SELECT val FROM log_l WHERE sect=%s ORDER BY seq', (sect,)).fetchall()]
    for sect in owner_sections:
        legacy = blobs.get(sect) or {}
        selected = {}
        for nid in ids:
            key = sect + store.SPLIT_SEP + nid
            rows = blobs.pop(key, legacy.get(nid, []))
            if rows:
                selected[nid] = rows
        blobs[sect] = selected
    try:
        from . import workread
    except ImportError as exc:
        raise CompatibilityRequired('indexed work count reader is not installed') from exc
    counts = workread.counts_raw(raw, graph['stamp']['org_id'], viewer=viewer,
                                now_ts=time.time() if now_ts is None else now_ts)
    # Node normalization reads these settings: a context whose nodes are
    # reused is only equivalent to a fresh one under the same settings.
    settings_key = tree_delta.encode({key: blobs.get(key) for key in SETTINGS})
    if reuse_settings != settings_key:
        reuse = None
    context = ForegroundContext(settings=blobs, graph=graph,
        funding=foreground_store.read_funding(raw),
        windows=foreground_store.read_card_windows(raw, ids, header=header),
        inbox=foreground_store.read_org_inbox_window(raw), work_counts=counts, reuse=reuse)
    context.settings_key = settings_key
    context.valid_until = valid_until(blobs)
    return context
