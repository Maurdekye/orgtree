"""Opt-in foreground docket views and bounded archive/reference reads.

The legacy full-list contract is unchanged. All selected rows, static metadata,
authority, actor identities and counts belong to one committed snapshot.
"""
from __future__ import annotations

import os
import time

from . import refs, store, workdetail, worklistmeta, workquery, workread, work_ui
from .ledger import USER, Org, LedgerError

FORMAT = 'orgtree.work-foreground/v1'


class Context(workdetail.Context):
    """Only FIELDS below are a public view; omitted history is never a detail."""
    WORK_BACKLOG = Org.WORK_BACKLOG
    _work_backlogged = Org._work_backlogged

    def __init__(self, query):
        super().__init__(query)
        if not worklistmeta.ready(query.raw, query.org_id):
            raise workquery.CompatibilityRequired('docket list metadata unavailable')
        # Scope/actor-only changes must reset paging too, even if access and
        # body revisions stayed the same. The query signs this extended catalog.
        revision = query.raw.execute(
            f'SELECT revision FROM {query.schema}.work_list_state WHERE singleton').fetchone()[0]
        query.catalog = [*query.catalog, int(revision)]

    def _work_scope_view(self, item, folded):
        # Not part of the desktop list contract. The retained summary is below;
        # full history remains available from the existing one-item GET.
        return []

    def _work_objective_notice(self, item):
        return item['objective_notice']

    def _work_status_at(self, item):
        return item['status_at']

    def _work_scope_archive_summary(self, item):
        return item['scope_archive_summary']

    def light(self, row, org_slug):
        record = self.query.raw.execute(
            f'SELECT body_sha256,payload FROM {self.query.schema}.work_list_summary WHERE slug=%s',
            (row.summary['slug'],)).fetchone()
        if not record or bytes(record[0]) != row.body_sha256:
            raise workquery.CompatibilityRequired('docket list body stamp mismatch')
        item = record[1]
        if item.get('slug') != row.summary['slug'] or not all(
                key in item for key in ('objective_notice', 'status_at', 'scope_archive_summary')):
            raise workquery.CompatibilityRequired('docket list payload incomplete')
        full = self._work_view(item, row.physical_archive, self.query.viewer,
                               self.query.now, scope_archive=False)
        result = {k: v for k, v in full.items() if k in work_ui.FIELDS}
        result['ref'] = refs.item(org_slug, item['slug'])
        result['view'] = 'list'
        result['view_revision'] = work_ui._hash(result)
        return result


def reference(row):
    return {k: row.get(k) for k in
            ('slug', 'title', 'parent', 'archived', 'status', 'rev', 'view_revision')}


def _read(slug, viewer, build, now_ts):
    """None requests whole-route compatibility, never a partially empty view."""
    if store.STORE_BACKEND != 'postgres':
        return None
    slug = store._safe_slug(slug)
    store._ensure_migrated(slug)
    if not os.path.exists(store._db_path(slug)):
        raise LedgerError(f'no such org: {slug!r}')
    try:
        with store._POOL.acquire(slug) as conn:
            if conn.in_transaction:
                raise RuntimeError('docket list cannot reuse a writer transaction')
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
                return build(ctx, slug)
            finally:
                conn.raw.execute('ROLLBACK')
    except workquery.CompatibilityRequired:
        return None


def foreground(slug, viewer=USER, *, backlogged=False, archive_limit=0, now_ts=None):
    if type(archive_limit) is not int or not 0 <= archive_limit <= workquery.MAX_PAGE:
        raise ValueError(f'archive_limit must be 0..{workquery.MAX_PAGE}')
    def build(ctx, org_slug):
        q = ctx.query
        counts = workread.counts_raw(q.raw, q.org_id, viewer=viewer, now_ts=q.now)
        if counts is None:
            raise workquery.CompatibilityRequired('docket counts unavailable')
        body = dict(format=FORMAT, counts=counts, now=q.now, items=[], references=[], attention=[])
        if backlogged:
            body['backlogged'] = []
        for raw in q.foreground(include_backlogged=backlogged):
            row = ctx.light(raw, org_slug)
            group = 'backlogged' if ctx._work_backlogged(raw.summary) else 'items'
            body[group].append(row)
            body['references'].append(reference(row))
            if row.get('manual_attention'):
                body['attention'].append(row)
        if archive_limit:
            # The first archive page and foreground must share BOTH snapshot
            # and classification clock. A separately fetched first page can
            # silently omit or duplicate an item archived between requests.
            rows, following = q.archive(limit=archive_limit)
            body['archived'] = [ctx.light(row, org_slug) for row in rows]
            body['references'].extend(reference(row) for row in body['archived'])
            body['next_cursor'] = following
            body['catalog'] = q.catalog
        body['revision'] = work_ui._hash({k: v for k, v in body.items() if k != 'now'})
        return body
    return _read(slug, viewer, build, now_ts)


def archive(slug, viewer=USER, *, limit=50, cursor='', now_ts=None):
    def build(ctx, org_slug):
        rows, following = ctx.query.archive(limit=limit, cursor=cursor)
        rows = [ctx.light(row, org_slug) for row in rows]
        return dict(format=FORMAT, archived=rows, references=[reference(row) for row in rows],
                    next_cursor=following, catalog=ctx.query.catalog)
    return _read(slug, viewer, build, now_ts)


def lookup(slug, viewer, wid, *, now_ts=None):
    def build(ctx, org_slug):
        row = ctx.query.lookup(wid)
        # An unreadable title-derived name is indistinguishable from absence.
        return dict(format=FORMAT, found=row is not None,
                    reference=reference(ctx.light(row, org_slug)) if row else None)
    return _read(slug, viewer, build, now_ts)
