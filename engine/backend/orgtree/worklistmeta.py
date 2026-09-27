"""Maintained list inputs, never a viewer-specific or authoritative work item.

History is read only for a changed item or explicit reconciliation. The future
list reader must still apply the canonical identity, authority and clock policy.
"""
from __future__ import annotations

import hashlib
import json
import logging

from .ledger import Org

log = logging.getLogger(__name__)
FORMAT = 'orgtree.work-list/v1'


class _Static:
    WORK_SCOPE_MAX = Org.WORK_SCOPE_MAX
    _work_scope_all = Org._work_scope_all
    _work_scope_live_n = Org._work_scope_live_n
    _work_scope_rolled = Org._work_scope_rolled
    _work_scope_arch = Org._work_scope_arch
    _work_scope_archive_summary = Org._work_scope_archive_summary
    _work_objective_notice = Org._work_objective_notice
    _work_status_at = Org._work_status_at

    def __init__(self, raw, schema):
        self.raw, self.schema = raw, schema

    def _work_scope_log_rows(self, item):
        count = int(item.get('scope_logged') or 0)
        rows = [json.loads(r[0]) for r in self.raw.execute(
            f"SELECT val FROM {self.schema}.log_d WHERE sect='work_scope_log' AND owner=%s ORDER BY seq",
            (item['slug'],))]
        if len(rows) != count:
            raise ValueError('scope history count mismatch')
        return rows

    def derive(self, body):
        item = json.loads(body)
        # Evaluate scope once. The ledger methods otherwise ask for it twice.
        rows = self._work_scope_log_rows(item)
        self._work_scope_log_rows = lambda _: rows
        try:
            return dict(objective_notice=self._work_objective_notice(item),
                        status_at=self._work_status_at(item),
                        scope_archive_summary=self._work_scope_archive_summary(item))
        finally:
            del self._work_scope_log_rows


def installed(raw, schema):
    return raw.execute('SELECT to_regclass(%s)', (schema+'.work_list_state',)).fetchone()[0] is not None


def pending(raw, org_id):
    schema = f'org_{int(org_id)}'
    if not installed(raw, schema):
        return False
    row = raw.execute(f'SELECT NOT initialized OR EXISTS(SELECT 1 FROM {schema}.work_list_dirty) '
                      f'FROM {schema}.work_list_state WHERE singleton').fetchone()
    return bool(row and row[0])


def ready(raw, org_id):
    schema = f'org_{int(org_id)}'
    if not installed(raw, schema):
        return False
    row = raw.execute(f'SELECT initialized AND ready AND format=%s AND '
                      f'NOT EXISTS(SELECT 1 FROM {schema}.work_list_dirty) '
                      f'FROM {schema}.work_list_state WHERE singleton', (FORMAT,)).fetchone()
    return bool(row and row[0])


def _body(raw, schema, location, key):
    if location == 'active':
        row = raw.execute(f'SELECT val FROM {schema}.doc WHERE key=%s', (key,)).fetchone()
    else:
        row = raw.execute(f"SELECT val FROM {schema}.log_l WHERE sect='work_items_archive' AND seq=%s", (int(key),)).fetchone()
    if row is None:
        raise ValueError('missing indexed body')
    return row[0]


def refresh(raw, org_id):
    """Same writer transaction; SQL errors abort, unsupported data disables reads."""
    schema = f'org_{int(org_id)}'
    if not pending(raw, org_id):
        return
    # Same lock and ordering as access metadata: every relevant writer takes
    # this before recording dirties. Never erase a concurrent invalidation.
    raw.execute(f'SELECT singleton FROM {schema}.work_read_state WHERE singleton FOR UPDATE')
    state = raw.execute(f'SELECT initialized FROM {schema}.work_list_state WHERE singleton').fetchone()
    try:
        if raw.execute(f"SELECT 1 FROM {schema}.doc WHERE key='work_scope_log'").fetchone():
            raise ValueError('legacy scope blob requires exact reader')
        for (slug,) in raw.execute(f'SELECT slug FROM {schema}.work_list_dirty ORDER BY slug').fetchall():
            row = raw.execute(f'SELECT location,source_key,body_sha256,summary FROM {schema}.work_index WHERE slug=%s', (slug,)).fetchone()
            if row is None:
                raw.execute(f'DELETE FROM {schema}.work_list_summary WHERE slug=%s', (slug,))
            else:
                location, key, digest, summary = row
                body = _body(raw, schema, location, key)
                if hashlib.sha256(body.encode()).digest() != bytes(digest):
                    raise ValueError('body hash mismatch')
                payload = {**summary, **_Static(raw, schema).derive(body)}
                raw.execute(f'INSERT INTO {schema}.work_list_summary VALUES(%s,%s,%s::jsonb) '
                            'ON CONFLICT(slug) DO UPDATE SET body_sha256=excluded.body_sha256,payload=excluded.payload',
                            (slug, digest, json.dumps(payload)))
            raw.execute(f'DELETE FROM {schema}.work_list_dirty WHERE slug=%s', (slug,))
        if not state[0]:
            valid = reconcile(raw, org_id)
            raw.execute(f'UPDATE {schema}.work_list_state SET initialized=true,ready=%s WHERE singleton', (valid,))
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raw.execute(f'UPDATE {schema}.work_list_state SET ready=false WHERE singleton')
        log.error('Docket list inputs unsupported for org %s (%s); exact reader required', org_id, type(exc).__name__)


def reconcile(raw, org_id):
    """Recompute under the shared writer fence; mismatch fails loud and closed.

    Do not request source-table locks here. A writer can already hold a table's
    RowExclusive lock while its AFTER trigger waits for this state row. Taking
    SHARE after that row would deadlock with it. Relevant raw writers cannot
    commit past the state-row fence, and MVCC reads their previous committed
    values without waiting on their uncommitted source rows.
    """
    schema = f'org_{int(org_id)}'
    with raw.transaction():
        raw.execute(f'SELECT singleton FROM {schema}.work_read_state WHERE singleton FOR UPDATE')
        valid = bool(raw.execute('SELECT public.orgtree_check_work_index(%s)', (org_id,)).fetchone()[0])
        count = 0
        query = f"""WITH source AS (
            SELECT val FROM {schema}.doc WHERE starts_with(key,'work_items'||chr(31))
            UNION ALL SELECT val FROM {schema}.log_l WHERE sect='work_items_archive')
            SELECT source.val,public.orgtree_work_summary(source.val),m.body_sha256,m.payload
            FROM source LEFT JOIN {schema}.work_list_summary m ON m.slug=source.val::json->>'slug'"""
        with raw.cursor(name=f'work_list_reconcile_{org_id}') as cursor:
            cursor.execute(query)
            for body, summary, digest, payload in cursor:
                count += 1
                valid &= (digest is not None and bytes(digest) == hashlib.sha256(body.encode()).digest()
                          and payload == {**summary, **_Static(raw, schema).derive(body)})
        valid &= raw.execute(f'SELECT count(*) FROM {schema}.work_list_summary').fetchone()[0] == count
        valid &= not raw.execute(f'SELECT 1 FROM {schema}.work_list_dirty LIMIT 1').fetchone()
        valid &= not raw.execute(f"SELECT 1 FROM {schema}.doc WHERE key='work_scope_log'").fetchone()
        raw.execute(f'UPDATE {schema}.work_list_state SET ready=%s WHERE singleton', (bool(valid),))
        if not valid:
            log.error('Docket list reconciliation mismatch for org %s; exact reader required', org_id)
        return bool(valid)
