"""Read-only inputs for periodic policies, without unrelated node history.

Actions keep their existing locked write/revalidation paths. PostgreSQL reads
settings and watchdog owners in one statement; other backends and legacy node
blobs retain the shared Org path. This deliberately does not filter owner state:
retired owners must still pause their dogs, and live frozen owners still run.
"""
import json
import sqlite3

from . import store
from .ledger import Org, norm_dirs, norm_tools


class _View:
    _shared_snapshot = True
    node = Org.node
    _watchdog = Org._watchdog

    def __init__(self, doc):
        self.d = doc
        self.nodes = doc['nodes']


def _read(slug, watchdogs):
    if store.STORE_BACKEND != 'postgres':
        return None
    keys = ('nodes', 'kiosk', 'sandbox', 'storage_blocked')
    if watchdogs:
        keys += ('watchdogs', 'workspace', 'disk')

    def body(conn):
        sql = ('WITH settings AS MATERIALIZED (SELECT key,val FROM doc WHERE key IN ('
               + ','.join('?' for _ in keys) + ')) '
               'SELECT 0 AS kind,key,val FROM settings')
        if watchdogs:
            # Owner IDs originate from the SAME statement snapshot as settings.
            # A scope revoke or owner retirement cannot tear across two SELECTs.
            sql += (" UNION ALL SELECT 1,n.id,json_extract(n.val,'$.state','$.scope','$.account') "
                    "FROM (SELECT DISTINCT dog->>'owner' AS owner "
                    "FROM settings s CROSS JOIN LATERAL json_array_elements("
                    "CASE WHEN json_typeof(s.val::json)='array' THEN s.val::json "
                    "ELSE '[]'::json END) dog WHERE s.key='watchdogs') needed "
                    "CROSS JOIN LATERAL (SELECT id,val FROM nodes "
                    "WHERE id=needed.owner LIMIT 1) n")
        rows = conn.execute(sql, keys).fetchall()
        doc = {'slug': slug, 'nodes': {}}
        for kind, key, raw in rows:
            if kind == 0:
                if key == 'nodes':
                    return None
                doc[key] = json.loads(raw)
            else:
                state, scope, account = json.loads(raw)
                if not isinstance(state, str) or not isinstance(scope, dict):
                    return None  # let Org handle legacy/unknown node shapes
                # Use the ledger's existing legacy scope normalization, on only
                # this selected owner. No full Org/load hooks or identity mint.
                scope['add_dirs'] = norm_dirs(scope.get('add_dirs'))
                scope['tools'] = norm_tools(scope.get('tools',
                    {'bash': scope.get('bash', True), 'mcp': []}))
                doc['nodes'][key] = {'state': state, 'scope': scope, 'account': account}
        if watchdogs and doc.get('watchdogs') is not None and not isinstance(doc['watchdogs'], list):
            return None
        return _View(doc)
    return store._bounded_read(slug, body)


def watchdog_org(slug):
    return _read(slug, True) or store.cached_org(slug)


def storage_org(slug):
    return _read(slug, False) or store.cached_org(slug)


def poll_orgs(reader):
    """Retain cached_list's per-org refusal isolation during enumeration."""
    from .ledger import LedgerError
    for slug in store.org_slugs():
        try:
            org = reader(slug)
        except (LedgerError, sqlite3.Error, ValueError, OSError):
            continue
        yield slug, org
