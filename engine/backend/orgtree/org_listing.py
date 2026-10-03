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
    return [{key: row[key] for key in ('slug', 'name', 'net_slug')}
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
    from .orgdb import enabled
    if enabled():
        return _orgdb_metadata(slug)

    def body(conn):
        rows = conn.execute(
            "SELECT key,CASE key "
            "WHEN 'net_identity' THEN coalesce((val::jsonb->'slug')::text,'null') "
            "ELSE val END,jsonb_typeof(val::jsonb) "
            "FROM doc WHERE key IN ('slug','name','net_identity')").fetchall()
        doc = {}
        for key, value, kind in rows:
            if key == 'net_identity' and kind not in ('object', 'null'):
                raise _CompatibilityRequired()
            doc[key] = json.loads(value)
        return _public(slug, doc)
    return store._bounded_read(slug, body)


def _orgdb_metadata(slug):
    """The same three keys with the storage switch on, from the org's own database in one
    read-only snapshot: the compatibility view serves no SQL of discovery's own (A7b, G2-C2).
    A database that goes away while it is read (trashed, fenced) is unreadable, as a vanished
    file is for the legacy reader."""
    import psycopg
    from .orgdb import reader_rows, registry
    try:
        with registry.connection(slug) as raw, raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            doc = reader_rows.read_sections(raw, ['slug', 'name', 'net_identity'])
    except psycopg.Error as e:
        raise sqlite3.OperationalError(f'org {slug!r} is unreadable: {e}') from e
    identity = doc.pop('net_identity', None)
    if identity is not None and not isinstance(identity, dict):
        raise _CompatibilityRequired()
    if identity is not None:
        doc['net_identity'] = identity.get('slug')
    return _public(slug, doc)


def _public(slug, doc):
    """Discovery's answer from the slug, name and net_identity's slug (``doc``)."""
    if doc.get('slug', slug) != slug:
        raise _CompatibilityRequired()
    # Explicit allowlist: no token, credentials, node counts or admin
    # settings are available to discovery's callers, even accidentally.
    return {'slug': doc.get('slug', slug), 'name': doc.get('name', slug),
            'net_slug': doc.get('net_identity')}


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
    return rows


def local_candidates(name):
    """Exact local destination lookup."""
    if _native():
        try:
            _metadata(name)
            return [name]
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
                store.load_org(name)
                out.append(name)
            except LedgerError:
                continue
    return out
