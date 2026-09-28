"""Exact single-item wire views without loading the organization's history.

This is deliberately not an Org: it cannot be saved or mutated. It borrows an
explicit set of pure ledger projection methods, with snapshot-scoped inputs.
Unsupported legacy layouts require the complete compatibility reader.
"""
from __future__ import annotations

from collections import OrderedDict
from collections.abc import Mapping
import json
import os
import time

from .ledger import Org, USER, LedgerError
from . import workquery


_NODE_IDENTITY = ("jsonb_build_object('id',id,'parent',val::jsonb->'parent',"
                  "'state',val::jsonb->'state','generation',val::jsonb->'generation',"
                  "'seat_id',val::jsonb->'seat_id')")


class _Nodes(Mapping):
    def __init__(self, query):
        self.query = query
        self.cache = OrderedDict()
        # rows read ahead for a whole list (`prefetch`); unchecked until used
        self.ahead = {}

    def prefetch(self, ids):
        """The identities of `ids` and every ancestor of them, in ONE read.

        docket-foreground-list-runs-565-sql-statements-p: a list used to read
        each actor's row on first touch (one statement per distinct actor).
        An id without a row is remembered as absent, exactly as a single read
        would. A row is only checked when it is used, so a prefetched row the
        view never touches cannot turn the list into a compatibility read."""
        want = sorted({i for i in ids if isinstance(i, str)} - self.ahead.keys() - self.cache.keys())
        if not want:
            return
        rows = self.query.raw.execute(
            f"WITH RECURSIVE up(id) AS (SELECT unnest(%s::text[]) UNION "
            f"SELECT n.val::jsonb->>'parent' FROM {self.query.schema}.nodes n JOIN up ON n.id=up.id "
            f"WHERE jsonb_typeof(n.val::jsonb->'parent')='string') "
            f"SELECT up.id,(SELECT {_NODE_IDENTITY} FROM {self.query.schema}.nodes WHERE id=up.id) FROM up",
            (want,)).fetchall()
        for key, value in rows:
            self.ahead.setdefault(key, value)

    def __getitem__(self, key):
        if key not in self.cache:
            if key in self.ahead:
                value = self.ahead[key]
            else:
                row = self.query.raw.execute(
                    f"SELECT {_NODE_IDENTITY} FROM {self.query.schema}.nodes WHERE id=%s",
                    (key,)).fetchone()
                value = row[0] if row else None
            # Org's constructor can normalize old rows; this reader cannot.
            if value is not None and (not value.get('state') or not value.get('seat_id')):
                raise workquery.CompatibilityRequired('node identity requires normalization')
            self.cache[key] = value
            if len(self.cache) > 128:
                self.cache.popitem(last=False)
        self.cache.move_to_end(key)
        value = self.cache[key]
        if value is None:
            raise KeyError(key)
        return value

    def __iter__(self):
        raise TypeError('single-item view must not enumerate nodes')

    def __len__(self):
        raise TypeError('single-item view must not enumerate nodes')


class Context:
    # Explicit pure-method allowlist. Keep the ledger as the sole authority
    # and wire policy; do not inherit its constructor or mutation/save surface.
    WORK_ARCHIVES_AT_ONCE = Org.WORK_ARCHIVES_AT_ONCE
    WORK_ARCHIVES_ITSELF = Org.WORK_ARCHIVES_ITSELF
    WORK_ARCHIVE_AFTER_S = Org.WORK_ARCHIVE_AFTER_S
    WORK_DISPOSITIONS = Org.WORK_DISPOSITIONS
    WORK_LEGACY_STATUSES = Org.WORK_LEGACY_STATUSES
    WORK_PROJECTIONS = Org.WORK_PROJECTIONS
    WORK_SCOPE_MAX = Org.WORK_SCOPE_MAX
    WORK_SUMMARY_FIELDS = Org.WORK_SUMMARY_FIELDS
    _WORK_HIST_POINTERS = Org._WORK_HIST_POINTERS
    _WORK_OLD_ID = Org._WORK_OLD_ID
    _WORK_SAME_AS_HOW = Org._WORK_SAME_AS_HOW
    _require_live = Org._require_live
    _work_acceptance_view = Org._work_acceptance_view
    _work_actor_node = staticmethod(Org._work_actor_node)
    _work_actor_view = Org._work_actor_view
    _work_age_s = staticmethod(Org._work_age_s)
    _work_archived = Org._work_archived
    _work_artifacts_view = Org._work_artifacts_view
    _work_attention = Org._work_attention
    _work_blocked_reason = Org._work_blocked_reason
    _work_can_manage = Org._work_can_manage
    _work_can_read = Org._work_can_read
    _work_compact_view = staticmethod(Org._work_compact_view)
    _work_delivery_view = Org._work_delivery_view
    _work_deploy_recipient = Org._work_deploy_recipient
    _work_eligible = Org._work_eligible
    _work_fields_arg = staticmethod(Org._work_fields_arg)
    _work_fold_dup = staticmethod(Org._work_fold_dup)
    _work_get_for = Org._work_get_for
    _work_grant_live = staticmethod(Org._work_grant_live)
    _work_header_first = staticmethod(Org._work_header_first)
    _work_history_view = Org._work_history_view
    _work_holders = Org._work_holders
    _work_identity_state = Org._work_identity_state
    _work_legacy_status = Org._work_legacy_status
    _work_next_recipient = Org._work_next_recipient
    _work_node_reply_state = Org._work_node_reply_state
    _work_objective_notice = Org._work_objective_notice
    _work_owner_state = Org._work_owner_state
    _work_packets_view = Org._work_packets_view
    _work_pointer_visible = Org._work_pointer_visible
    _work_project = Org._work_project
    _work_reply_recipients = Org._work_reply_recipients
    _work_scope_all = Org._work_scope_all
    _work_scope_arch = Org._work_scope_arch
    _work_scope_archive_summary = Org._work_scope_archive_summary
    _work_scope_live = Org._work_scope_live
    _work_scope_live_n = Org._work_scope_live_n
    _work_scope_rolled = Org._work_scope_rolled
    _work_scope_view = Org._work_scope_view
    _work_select = staticmethod(Org._work_select)
    _work_status = Org._work_status
    _work_status_at = Org._work_status_at
    _work_view = Org._work_view
    ancestors = Org.ancestors
    is_ancestor = Org.is_ancestor
    node = Org.node
    work_findings_summary = Org.work_findings_summary
    work_get = Org.work_get

    def __init__(self, query):
        self.query = query
        self.nodes = _Nodes(query)
        self._scope = {}
        if query.raw.execute(f"SELECT 1 FROM {query.schema}.doc WHERE key IN ('nodes','work_scope_log') LIMIT 1").fetchone():
            raise workquery.CompatibilityRequired('single-item inputs still stored as legacy blobs')

    def _work_find(self, slug):
        result = self.query.detail(slug)
        if result is None:
            raise LedgerError('no readable work item')
        return result

    def _work_pointer_target(self, slug):
        row = self.query.lookup(str(slug))
        return row.summary if row else None

    def _work_questions(self, slug):
        row = self.query.raw.execute(f'SELECT questions FROM {self.query.schema}.work_read_questions WHERE slug=%s', (slug,)).fetchone()
        return row[0] if row else []

    def _work_scope_log_rows(self, item, *, create=False):
        if create:
            raise TypeError('read-only work detail cannot create scope history')
        count = int(item.get('scope_logged') or 0)
        if not count:
            return []
        slug = str(item.get('slug') or '')
        if slug not in self._scope:
            rows = self.query.raw.execute(f"SELECT val FROM {self.query.schema}.log_d WHERE sect='work_scope_log' AND owner=%s ORDER BY seq", (slug,))
            self._scope[slug] = [json.loads(row[0]) for row in rows]
            if len(self._scope[slug]) != count:
                raise workquery.CompatibilityRequired('scope history count mismatch')
        return self._scope[slug]


def get(slug, viewer, wid, *, compact=False, projection=None, fields=None, now_ts=None):
    """Public wire item, or None requesting the entire exact legacy path.

    Ledger errors (including missing/unreadable) remain errors, never a fallback
    that scans all history to establish absence. No writer transaction is reused.
    """
    from . import store
    if store.STORE_BACKEND != 'postgres':
        return None
    slug = store._safe_slug(slug)
    store._ensure_migrated(slug)
    if not os.path.exists(store._db_path(slug)):
        raise LedgerError(f'no such org: {slug!r}')
    try:
        with store._POOL.acquire(slug) as conn:
            if conn.in_transaction:
                raise RuntimeError('work detail cannot reuse a writer transaction')
            conn.use()
            conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                if conn.raw.execute("SELECT 1 FROM meta WHERE key='schema_version'").fetchone() is None:
                    raise LedgerError('not an intact orgtree database (no schema_version row)')
                query = workquery.Snapshot(conn.raw, conn.org_id, viewer=viewer,
                    now_ts=time.time() if now_ts is None else now_ts)
                ctx = Context(query)
                if viewer != USER:
                    ctx._require_live(viewer)
                return ctx.work_get(viewer, wid, now_ts=query.now, compact=compact,
                                    projection=projection, fields=fields)
            finally:
                conn.raw.execute('ROLLBACK')
    except workquery.CompatibilityRequired:
        return None
