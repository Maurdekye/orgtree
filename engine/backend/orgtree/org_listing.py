"""Read-only organization discovery; never returns node or secret fields.

PostgreSQL reads four metadata keys, in one snapshot per organization. Legacy
backends and pending JSON imports keep the established listing path. This is
not an authority context and must not be used to authorize writes.
"""
import json
import os
import sqlite3

from . import store
from .ledger import LedgerError


class _CompatibilityRequired(Exception):
    pass


def _legacy_rows():
    return [{key: row[key] for key in ('slug', 'name', 'kiosk', 'net_slug')}
            for row in store.list_orgs()]


def _native():
    if store.STORE_BACKEND != 'postgres':
        return False
    # list_orgs imports an old JSON org before enumerating row-store markers.
    # Keep that compatibility behavior rather than silently hiding an import.
    return not any(name.endswith('.json') and
                   not os.path.exists(store._db_path(name[:-5]))
                   for name in os.listdir(store._orgs_dir()))


def _metadata(slug):
    def body(conn):
        rows = conn.execute(
            "SELECT key,CASE key "
            "WHEN 'kiosk' THEN CASE WHEN val::jsonb='null'::jsonb THEN 'false' ELSE 'true' END "
            "WHEN 'net_identity' THEN coalesce((val::jsonb->'slug')::text,'null') "
            "ELSE val END,jsonb_typeof(val::jsonb) "
            "FROM doc WHERE key IN ('slug','name','kiosk','net_identity')").fetchall()
        doc = {}
        for key, value, kind in rows:
            if key == 'net_identity' and kind not in ('object', 'null'):
                raise _CompatibilityRequired()
            doc[key] = json.loads(value)
        if doc.get('slug', slug) != slug:
            raise _CompatibilityRequired()
        # Explicit allowlist: no token, credentials, node counts or admin
        # settings are available to discovery's callers, even accidentally.
        return {'slug': doc.get('slug', slug), 'name': doc.get('name', slug),
                'kiosk': doc.get('kiosk', False), 'net_slug': doc.get('net_identity')}
    return store._bounded_read(slug, body)


def discovery_rows():
    if not _native():
        rows = _legacy_rows()
    else:
        rows = []
        try:
            for slug in store.org_slugs():
                try:
                    rows.append(_metadata(slug))
                except (LedgerError, sqlite3.Error, ValueError, OSError):
                    continue  # same per-org unreadable/deleted isolation as _scan_orgs
        except _CompatibilityRequired:
            rows = _legacy_rows()
    return [row for row in rows if not row['kiosk']]


def local_candidates(name):
    """Exact local destination lookup; sealed kiosks appear nonexistent."""
    if _native():
        try:
            row = _metadata(name)
            return [name] if not row['kiosk'] else []
        except (LedgerError, sqlite3.Error, ValueError, OSError):
            return []
        except _CompatibilityRequired:
            pass
    # Retain the legacy second read and exception semantics for non-native
    # documents, rather than constructing a partially normalized Org.
    out = []
    for row in store.list_orgs():
        if row.get('slug') == name:
            try:
                if store.load_org(name).d.get('kiosk') is None:
                    out.append(name)
            except LedgerError:
                continue
    return out
