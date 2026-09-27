"""Coherent, non-persistable inputs for foreground warm identity checks.

This is not a turn-state/chart or authorization context. Only the requested
seat, its parents and immediate predecessor are present. Unsupported legacy
normalization and first-turn docket splices use the exact full reader.
"""
from __future__ import annotations

import copy
import json
from . import store
from .foreground_context import CompatibilityRequired, SETTINGS, _compatible
from .ledger import Org, USER, EXTERN, norm_dirs, retag_legacy_spend_freeze
from .readonly_projection import ProjectionDoc


class IdentityContext:
    _read_only_projection = True
    _READ_METHODS = frozenset(('node', 'parent', 'ancestors', 'is_ancestor',
        'model_for', 'versions_for', 'harness_for', 'prefer_reserve_for',
        'effective_effort', 'is_kiosk', 'kiosk_ceiling', '_has_audience',
        'account_fallback_for'))

    def __init__(self, settings, rows, nid):
        nodes = {key: copy.deepcopy(value) for key, _ordinal, value in rows}
        _compatible(settings, nodes)
        node = nodes.get(nid)
        if node and node.get('cheap_compacted'):
            # Breadcrumb recovery can render authorized docket facts. That
            # surface needs the separate indexed work-access context first.
            raise CompatibilityRequired('first-turn docket splice requires full context')
        if any(n.get('parent') and n['parent'] not in nodes for n in nodes.values()):
            raise CompatibilityRequired('missing ancestor in identity snapshot')
        self.d = ProjectionDoc(copy.deepcopy(settings))
        self.d['nodes'] = nodes
        for key, ordinal, _value in rows:
            nodes[key].setdefault('ui_order', float(ordinal))
        Org._normalize_display_basics(self)
        Org._normalize_display_models(self)
        self.d['dirs'] = norm_dirs(self.d.get('dirs'))
        kiosk = self.d.get('kiosk')
        if kiosk is not None:
            kiosk.setdefault('auto_raise', False)
            cap = int(kiosk.get('credits') or 0)
            if cap and int(self.d.get('default_top_grant') or 0) >= cap:
                self.d['default_top_grant'] = 0
        for n in nodes.values():
            retag_legacy_spend_freeze(n.get('frozen'))
            if not self.d.get('fable_lock'):
                n.pop('limit_locked', None)

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


def _read(raw, slug, nid):
    settings = {key: json.loads(value) for key, value in raw.execute(
        'SELECT key,val FROM doc WHERE key=ANY(%s)', (list(SETTINGS),)).fetchall()}
    if settings.get('slug') != slug:
        raise CompatibilityRequired('organization identity changed')
    if raw.execute("SELECT EXISTS(SELECT 1 FROM doc WHERE key='audiences')").fetchone()[0]:
        raise CompatibilityRequired('legacy audience document')
    # Identity only asks for USER and EXTERN audiences. Do not decode other
    # grants or any audience-request/history bodies.
    settings['audiences'] = [dict(grantee=nid, grantor=grantor)
        for grantor, in raw.execute(
            "SELECT DISTINCT val::jsonb->>'grantor' FROM log_l "
            "WHERE sect='audiences' AND val::jsonb->>'grantee'=%s "
            "AND val::jsonb->>'grantor'=ANY(%s)", (nid, [USER, EXTERN])).fetchall()]
    rows = raw.execute(
        "WITH RECURSIVE wanted(id,parent) AS ("
        "SELECT id,meta->>'parent' FROM node_index WHERE id=%s OR id=("
        "SELECT val::jsonb->>'predecessor' FROM nodes WHERE id=%s) UNION "
        "SELECT p.id,p.meta->>'parent' FROM node_index p JOIN wanted c ON p.id=c.parent) "
        "SELECT n.id,n.ord,n.val FROM wanted w JOIN nodes n ON n.id=w.id ORDER BY n.ord,n.id",
        (nid, nid)).fetchall()
    return IdentityContext(settings, [(key, ordinal, json.loads(value))
                                     for key, ordinal, value in rows], nid)


def load(slug: str, nid: str):
    """Fresh committed snapshot; no cache, writes or provider launches."""
    if store.STORE_BACKEND == 'postgres':
        from .foreground_store import _snapshot
        try:
            with _snapshot(slug) as (raw, _stamp):
                return _read(raw, slug, nid)
        except CompatibilityRequired:
            pass
    return store.load_org(slug)
