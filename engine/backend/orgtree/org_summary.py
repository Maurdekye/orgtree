"""Per-org listing summaries in a single committed snapshot.

Only active funding rows are materialized. Admin normalization uses shared
pure helpers; incompatible legacy documents keep the existing complete reader.
"""
import copy
import json
import sqlite3

from . import foreground_store, org_listing, store
from .foreground_context import CompatibilityRequired, _compatible
from .ledger import Org
from .readonly_projection import ProjectionDoc

_ADMIN_KEYS = tuple('''slug name created net_identity tiers models deleted_cost_usd
 workspace _actors_typed whole_grants_v1
 _migrations fable_lock nodes'''.split())


class _AdminSummary:
    _read_only_projection = True
    node = Org.node

    def __init__(self, settings, nodes, cost):
        # Listing does not use prompt/cache predecessor identity. Only the
        # settings migrations affect this projection's normalization.
        _compatible(settings, {})
        self.d = ProjectionDoc(copy.deepcopy(settings))
        self.d['nodes'] = copy.deepcopy(nodes)
        Org._normalize_display_basics(self)
        Org._normalize_display_models(self)
        self._cost = cost

    @property
    def nodes(self):
        return self.d['nodes']

    def cost_total(self):
        # Deliberately identical to the tree header's decimal-total display.
        return round(float(self._cost) + float(self.d.get('deleted_cost_usd') or 0.0), 4)


def _live_count(raw):
    """Active nodes whose state is 'live', from node_index metadata alone (one
    row, no node document read). node_index stores coalesce(state, 'live');
    every node-creating path sets `state` (coordinator ruling on
    org-list-api-orgs-reads-grow-with-agent-count), so this equals counting
    `state == 'live'` over the node documents."""
    return int(raw.execute(
        "SELECT count(*) FROM node_index i WHERE i.meta->>'state'='live'").fetchone()[0])


def _read(slug):
    def snapshot(raw, stamp):
        # A pre-row-store node blob has no validated native count projection.
        if raw.execute("SELECT 1 FROM doc WHERE key='nodes'").fetchone():
            raise CompatibilityRequired('legacy node blob')
        if raw.execute('SELECT 1 FROM nodes WHERE public.orgtree_summary_cost_exception(val) LIMIT 1').fetchone():
            raise CompatibilityRequired('legacy cost conversion is required')
        settings = {key: json.loads(value) for key, value in raw.execute(
            'SELECT key,val FROM doc WHERE key=ANY(%s)', (list(_ADMIN_KEYS),)).fetchall()}
        if settings.get('slug') != slug:
            raise CompatibilityRequired('organization identity changed')
        # The listing row needs no node documents: `live` is one count.
        # Reading every active node's document made each poll grow with the
        # org (org-list-api-orgs-reads-grow-with-agent-count).
        row = store._summary_row(slug, dict(settings, nodes={}))
        row['nodes'] = stamp['node_count']
        row['live'] = _live_count(raw)
        context = _AdminSummary(settings, {}, stamp['cost'])
        return row, context
    return foreground_store.read_snapshot(slug, snapshot)


def admin_rows():
    if not org_listing._native():
        return store.list_orgs_with_docs()
    rows = []
    for slug in store.org_slugs():
        try:
            rows.append(_read(slug))
        except foreground_store.OrgNotFound:
            continue
        except (CompatibilityRequired, sqlite3.Error):
            # Only this legacy organization takes the compatibility path.
            # Read the raw summary before Org normalization, as _scan_orgs does.
            try:
                doc = store._bounded_read(slug, lambda conn: store._load_lazy(conn, slug))
                row = store._summary_row(slug, doc)
            except (store.LedgerError, sqlite3.Error, ValueError, OSError):
                continue
            rows.append((row, Org(doc)))
    return rows
