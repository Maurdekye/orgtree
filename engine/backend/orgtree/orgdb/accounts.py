"""Runtime account rows, with one database and one commit per mutation.

The converter's codecs keep sparse/legacy values exact. Runtime writes target
only the locked account and changed metadata; the rollback JSON is never read.
"""
from __future__ import annotations

import contextlib
import copy
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterator

from . import codec, conn, names
from .convert import accounts as shape


@contextlib.contextmanager
def connection(org: str | None = None) -> Iterator[Any]:
    if org is not None:
        from . import registry
        with registry.connection(org) as raw:
            yield raw
    else:
        # A fresh runtime connection: no body or ambiguous commit is retried.
        with conn.connect(conn.runtime_base(), names.app(),
                          application_name='orgtree-accounts') as raw:
            yield raw


def _specs(org: str | None) -> tuple[Any, ...]:
    return ((shape.ORG_ACCOUNT, shape.ORG_MARK, shape.ORG_SPEND,
             shape.ORG_ALIAS, shape.ORG_AUDIT) if org is not None else
            (shape.ACCOUNT, shape.MARK, shape.SPEND, shape.ALIAS, shape.AUDIT))


def _rows(raw: Any, table: str, where: str = '', params: tuple = ()) -> list[dict]:
    from psycopg.rows import dict_row
    with raw.cursor(row_factory=dict_row) as cur:
        return list(cur.execute(f'SELECT * FROM orgtree.{table} {where}', params).fetchall())


def _read(raw: Any, org: str | None, account_id: str | None = None,
          *, metadata_only: bool = False) -> dict:
    account, mark, spend, alias, audit = _specs(org)
    rows = {}
    for spec in (account, mark, spend):
        key = 'id' if spec is account else 'account_id'
        where, params = ('WHERE FALSE', ()) if metadata_only else (
            (f'WHERE {key} = %s', (account_id,)) if account_id is not None else ('', ()))
        rows[spec.table] = _rows(raw, spec.table, where, params)
    for spec in (alias, audit):
        rows[spec.table] = _rows(raw, spec.table)
    if org is not None:
        return {'version': 1, 'id_counters': {}, 'tint_counters': {},
                **shape.decode_org_accounts(rows)}
    rows[shape.COUNTER.table] = _rows(raw, shape.COUNTER.table)
    rows[shape.KEYS_TABLE] = _rows(raw, shape.KEYS_TABLE)
    cols = shape.SETTINGS_COLUMNS
    found = raw.execute('SELECT ' + ', '.join(cols) + ' FROM orgtree.app_settings').fetchone()
    rows['app_settings'] = [dict(zip(cols, found))] if found else []
    doc = shape.decode_registry(rows)
    # An empty, newly provisioned registry behaves like an absent JSON file.
    from ..registry import _blank
    result = {**_blank(), **doc}
    if not isinstance(result['accounts'], list):
        result['accounts'] = []
    for field in ('aliases', 'id_counters', 'tint_counters'):
        if not isinstance(result[field], dict):
            result[field] = {}
    return result


def _part(org: str | None) -> dict:
    with connection(org) as raw, raw.transaction():
        raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return _read(raw, org)


def _active() -> list[str]:
    from . import registry
    return [slug for slug, *_ in registry.active()]


def _sources(org: str | None) -> Iterator[str | None]:
    if org is not None:
        yield org
    yield None
    if org is None:
        yield from _active()


def _org_part(org: str) -> dict:
    from .registry import OrgUnavailable
    try:
        return _part(org)
    except OrgUnavailable:
        return {'accounts': [], 'aliases': {}, 'mark_audit': []}


def load(org: str | None = None) -> dict:
    doc = _part(None)
    slugs = _active() if org is None else [org]
    if slugs:
        with ThreadPoolExecutor(max_workers=min(8, len(slugs))) as pool:
            parts = list(pool.map(_org_part, slugs))
        for part in parts:
            doc['accounts'].extend(part['accounts'])
            for alias, target in part['aliases'].items():
                doc['aliases'].setdefault(alias, target)
            if part['mark_audit']:
                doc.setdefault('mark_audit', []).extend(part['mark_audit'])
    return doc


def _find_in(account_id: str, org: str | None) -> dict | None:
    account, mark, spend, alias, _ = _specs(org)
    with connection(org) as raw, raw.transaction():
        raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        found = raw.execute(f'SELECT account_id FROM orgtree.{alias.table} WHERE alias = %s',
                            (account_id,)).fetchone()
        resolved = found[0] if found else account_id
        rows = {account.table: _rows(raw, account.table, 'WHERE id = %s', (resolved,)),
                mark.table: _rows(raw, mark.table, 'WHERE account_id = %s', (resolved,)),
                spend.table: _rows(raw, spend.table, 'WHERE account_id = %s', (resolved,))}
        decoded = shape._decode_accounts(account, mark, spend, rows)
        return decoded[0] if decoded else None


def find(account_id: str, org: str | None = None) -> dict:
    from ..registry import UnknownAccount
    from .registry import OrgUnavailable
    for source in _sources(org):
        try:
            row = _find_in(account_id, source)
        except OrgUnavailable:
            continue
        if row is not None:
            return row
    raise UnknownAccount(account_id)


def resolve_alias(account_id: str, org: str | None = None) -> str:
    from .registry import OrgUnavailable
    for source in _sources(org):
        try:
            with connection(source) as raw:
                alias = _specs(source)[3]
                found = raw.execute(f'SELECT account_id FROM orgtree.{alias.table} WHERE alias = %s',
                                    (account_id,)).fetchone()
        except OrgUnavailable:
            continue
        if found:
            return str(found[0])
    return account_id


def _upsert(raw: Any, table: str, row: dict, keys: tuple[str, ...]) -> None:
    cols = list(row)
    changed = [c for c in cols if c not in keys and c != 'ord']
    updates = ', '.join(f'{codec.quoted([c])} = EXCLUDED.{codec.quoted([c])}' for c in changed)
    if table in ('accounts', 'org_accounts'):
        updates += f', row_version = orgtree.{table}.row_version + 1'
    raw.execute(f'INSERT INTO orgtree.{table} ({codec.quoted(cols)}) VALUES '
                f"({', '.join(['%s'] * len(cols))}) ON CONFLICT ({codec.quoted(keys)}) "
                + ('DO UPDATE SET ' + updates if updates else 'DO NOTHING'), tuple(row[c] for c in cols))


def _persist_account(raw: Any, org: str | None, before: dict, after: dict) -> None:
    account, mark, spend, _, _ = _specs(org)
    old = {r['id']: r for r in before['accounts']}
    new = {r['id']: r for r in after['accounts']}
    for rid in old.keys() - new.keys():
        raw.execute(f'DELETE FROM orgtree.{account.table} WHERE id = %s', (rid,))
    for rid, row in new.items():
        if row == old.get(rid):
            continue
        if shape.restricted_to(row) != org:
            raise ValueError('account scope must match its transaction database')
        found = raw.execute(f'SELECT ord FROM orgtree.{account.table} WHERE id = %s', (rid,)).fetchone()
        ord_ = found[0] if found else raw.execute(
            f'SELECT COALESCE(MAX(ord), -1) + 1 FROM orgtree.{account.table}').fetchone()[0]
        encoded: dict[str, list] = {}
        shape._encode_account(account, mark, spend, row, ord_, encoded)
        _upsert(raw, account.table, encoded[account.table][0], ('id',))
        # These child rows belong only to the account locked by this transaction.
        wanted = {r['pool'] for r in encoded.get(mark.table, [])}
        existing = raw.execute(f'SELECT pool FROM orgtree.{mark.table} WHERE account_id = %s',
                               (rid,)).fetchall()
        for (pool,) in existing:
            if pool not in wanted:
                raw.execute(f'DELETE FROM orgtree.{mark.table} WHERE account_id = %s AND pool = %s',
                            (rid, pool))
        for rec in encoded.get(mark.table, []):
            _upsert(raw, mark.table, rec, ('account_id', 'pool'))
        spent = encoded.get(spend.table, [])
        if spent:
            _upsert(raw, spend.table, spent[0], ('account_id',))
        else:
            raw.execute(f'DELETE FROM orgtree.{spend.table} WHERE account_id = %s', (rid,))


def _persist_metadata(raw: Any, org: str | None, before: dict, after: dict) -> None:
    _, _, _, alias, audit = _specs(org)
    for name in before['aliases'].keys() - after['aliases'].keys():
        raw.execute(f'DELETE FROM orgtree.{alias.table} WHERE alias = %s', (name,))
    for name, target in after['aliases'].items():
        if target == before['aliases'].get(name):
            continue
        if org is None and isinstance(target, str):
            from ..registry import UnknownAccount
            try:
                scope = find(target).get('origin_org')
            except UnknownAccount:
                scope = None
            if scope:
                raise ValueError('restricted aliases require their org transaction')
        found = raw.execute(f'SELECT ord FROM orgtree.{alias.table} WHERE alias = %s', (name,)).fetchone()
        ord_ = found[0] if found else raw.execute(
            f'SELECT COALESCE(MAX(ord), -1) + 1 FROM orgtree.{alias.table}').fetchone()[0]
        out: dict[str, list] = {}
        codec.encode(alias, {'account_id': target}, {'alias': name, 'ord': ord_}, out)
        _upsert(raw, alias.table, out[alias.table][0], ('alias',))
    old_audit = before.get('mark_audit')
    old_audit = old_audit if isinstance(old_audit, list) else []
    new_audit = after.get('mark_audit')
    new_audit = new_audit if isinstance(new_audit, list) else []
    if old_audit != new_audit:
        # Keep ords monotonic: append and trim only expired audit entries.
        keep = len(old_audit)
        while keep and old_audit[-keep:] != new_audit[:keep]:
            keep -= 1
        ords = [r[0] for r in raw.execute(f'SELECT ord FROM orgtree.{audit.table} ORDER BY ord').fetchall()]
        start = max(ords, default=-1) + 1
        for ord_ in ords[:len(ords) - keep]:
            raw.execute(f'DELETE FROM orgtree.{audit.table} WHERE ord = %s', (ord_,))
        for i, entry in enumerate(new_audit[keep:]):
            out = {}
            codec.encode(audit, entry, {'ord': start + i}, out)
            _upsert(raw, audit.table, out[audit.table][0], ('ord',))
    if org is not None:
        return
    encoded, _, _ = shape.encode_registry(after)
    keys = {r['key']: r for r in _rows(raw, shape.KEYS_TABLE)}
    known_keys = set(keys)
    for rec in encoded[shape.KEYS_TABLE]:
        key = rec['key']
        if key in keys and key in before and after[key] == before[key]:
            continue
        rec['ord'] = keys[key]['ord'] if key in keys else max(
            (r['ord'] for r in keys.values()), default=-1) + 1
        _upsert(raw, shape.KEYS_TABLE, rec, ('key',))
        keys[key] = rec
    for provider in set(after['id_counters']) | set(after['tint_counters']):
        if (after['id_counters'].get(provider) == before['id_counters'].get(provider)
                and after['tint_counters'].get(provider) == before['tint_counters'].get(provider)):
            continue
        rec = next(r for r in encoded[shape.COUNTER.table] if r['provider'] == provider)
        _upsert(raw, shape.COUNTER.table, rec, ('provider',))
    settings = encoded['app_settings'][0]
    changed = [c for k in ('version', *shape.EPOCHS)
               if after.get(k) != before.get(k) or k not in known_keys
               for c in (["accounts_version"] if k == 'version' else [shape.EPOCHS[k], shape.EPOCHS[k] + '_text'])]
    if changed:
        raw.execute('UPDATE orgtree.app_settings SET ' + ', '.join(c + ' = %s' for c in changed)
                    + ', row_version = row_version + 1', tuple(settings[c] for c in changed))


@contextlib.contextmanager
def transaction(account_id: str | None = None, *, provider: str | None = None,
                org: str | None = None) -> Iterator[dict]:
    from ..registry import UnknownAccount
    target = None
    if account_id is not None:
        try:
            target = find(account_id, org)
        except UnknownAccount:
            target = None
        org = str(target['origin_org']) if target and target.get('origin_org') else None
    with connection(org) as raw:
        with raw.transaction():
            # Serializes ord allocation and audit append/trim, before account locks.
            raw.execute('SELECT 1 FROM orgtree.' + ('org_settings' if org else 'app_settings') + ' FOR UPDATE')
            rid = target['id'] if target else account_id
            if rid is not None:
                table = _specs(org)[0].table
                raw.execute(f'SELECT id FROM orgtree.{table} WHERE id = %s FOR UPDATE', (rid,))
            if provider is not None:
                raw.execute('INSERT INTO orgtree.account_counters(provider) VALUES (%s) ON CONFLICT DO NOTHING', (provider,))
                raw.execute('SELECT provider FROM orgtree.account_counters WHERE provider = %s FOR UPDATE', (provider,))
            from ..registry import _MutationDocument
            doc = _MutationDocument(_read(raw, org, rid, metadata_only=rid is None))
            if target and account_id != rid:
                doc['aliases'][account_id] = rid
            before = copy.deepcopy(doc)
            yield doc
            from ..accounts import _reject_secrets
            _reject_secrets(doc)
            if doc.write_requested or doc != before:
                _persist_account(raw, org, before, doc)
                _persist_metadata(raw, org, before, doc)
        # Commit finished before invalidation. Never repeat the body on failure.
        from ..registry import availability_changed
        if doc.write_requested or doc != before:
            availability_changed('account registry written')


def allocate(provider: str) -> tuple[int, int]:
    with transaction(provider=provider) as doc:
        n = int(doc['id_counters'].get(provider, 0)) + 1
        t = int(doc['tint_counters'].get(provider, 0)) + 1
        doc['id_counters'][provider], doc['tint_counters'][provider] = n, t
    return n, t
