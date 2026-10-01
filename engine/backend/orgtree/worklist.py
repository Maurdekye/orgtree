"""Opt-in foreground docket views and bounded archive/reference reads.

The legacy full-list contract is unchanged. All selected rows, static metadata,
authority, actor identities and counts belong to one committed snapshot.
"""
from __future__ import annotations

import hashlib
import json
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
        # read ahead for a whole list by `prime`; a miss reads one row as before
        self._listed = {}
        self._questions = {}
        self._pointers = {}

    def prime(self, rows):
        """Read what `light` needs for every row in a few statements.

        docket-foreground-list-runs-565-sql-statements-p: at N1000 the list ran
        565 statements per request -- per item its list summary, its questions
        three times (`_work_view`, `_work_attention`, `_work_archived`), each
        pointer target and each actor's node row. Now: one summary read, the
        questions the row was selected with (same snapshot, same table), one
        lookup for every pointer and one read for every actor and ancestor."""
        rows = list(rows)
        if not rows:
            return
        for row in rows:
            self._questions[row.summary['slug']] = row.questions
        slugs = [row.summary['slug'] for row in rows if row.summary['slug'] not in self._listed]
        if slugs:
            for slug, digest, payload in self.query.raw.execute(
                    f'SELECT slug,body_sha256,payload FROM {self.query.schema}.work_list_summary '
                    f'WHERE slug=ANY(%s)', (slugs,)):
                self._listed[slug] = (digest, payload)
        items = [self._listed[row.summary['slug']][1] for row in rows
                 if row.summary['slug'] in self._listed]
        names = set()
        actors = {self.query.viewer}
        for item in items:
            for key in ('parent', 'superseded_by'):
                names.add(item.get(key))
            names.update(item.get('dependencies') or [])
            _actors(item, actors)
        names = sorted(n for n in names if isinstance(n, str) and 0 < len(n) <= 256
                       and n not in self._pointers)
        for start in range(0, len(names), 128):
            chunk = names[start:start + 128]
            found = {row.summary['slug']: row.summary for row in self.query.lookup_many(chunk)}
            for name in chunk:
                self._pointers[name] = found.get(name)
        self.nodes.prefetch(actors)

    def _work_pointer_target(self, slug):
        if slug in self._pointers:
            return self._pointers[slug]
        return super()._work_pointer_target(slug)

    def _work_questions(self, slug):
        if slug in self._questions:
            return self._questions[slug]
        return super()._work_questions(slug)

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
        record = self._listed.get(row.summary['slug']) or self.query.raw.execute(
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


def _actors(value, out):
    """Every node id an item names (actor refs and participants), wherever it
    sits: a superset of what the view reads, so one read covers it."""
    if isinstance(value, dict):
        node = value.get('node')
        if isinstance(node, str):
            out.add(node)
        for key, inner in value.items():
            if key == 'participants' and isinstance(inner, list):
                out.update(x for x in inner if isinstance(x, str))
            elif isinstance(inner, (dict, list)):
                _actors(inner, out)
    elif isinstance(value, list):
        for inner in value:
            _actors(inner, out)


def reference(row):
    return {k: row.get(k) for k in
            ('slug', 'title', 'parent', 'archived', 'status', 'rev', 'view_revision')}


def _read(slug, viewer, build, now_ts, context=Context):
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
                ctx = context(query)
                if viewer != USER:
                    ctx._require_live(viewer)
                return build(ctx, slug)
            finally:
                conn.raw.execute('ROLLBACK')
    except workquery.CompatibilityRequired:
        return None


#: Per engine process: a restart (possibly a new build with a different row
#: projection) never answers 304 to a validator issued by an older process.
_ETAG_EPOCH = os.urandom(8).hex()


def etag(ctx, org_slug, backlogged):
    """Validator for the plain foreground (archive_limit=0) from counters only.

    The body is a function of the snapshot and the clock. Every source write
    it reads bumps one of the three catalog revisions in the SAME transaction
    (work_index_state: item bodies and location; work_read_state: access,
    questions, node parents; work_list_state: derived list fields, node
    identity, asks/release/identity docs). The clock only moves an item when it
    crosses its archive deadline (`deadline < now`, the exact complement of the
    candidate query), so the number of passed active deadlines covers it.
    Counts and rows are NOT read here: that is the whole point of the 304.
    """
    q = ctx.query
    passed = q.raw.execute(
        f"SELECT count(*) FROM {q.schema}.work_read_policy "
        "WHERE location='active' AND deadline < %s", (q.now,)).fetchone()[0]
    return _etag(org_slug, q.org_id, q.viewer, backlogged, q.catalog, passed)


def _etag(org_slug, org_id, viewer, backlogged, catalog, passed):
    return '"f' + work_ui._hash([_ETAG_EPOCH, FORMAT, org_slug, int(org_id), viewer,
                                 bool(backlogged), [int(c) for c in catalog],
                                 int(passed)]) + '"'


def foreground_unchanged(slug, *, backlogged=False, since='', now_ts=None):
    """True only when `since` is the plain foreground's CURRENT validator, read
    in ONE statement (one snapshot) instead of the ~17 of the full conditional
    path: the same health gates Snapshot and Context check, the same three
    catalog revisions and the same passed-deadline count, hashed by the same
    `_etag`. Anything else -- a gate closed, a table missing, any error --
    is False, and the caller runs the full path, which decides exactly as
    before (N1000 read shortcuts: 82% of desk docket polls were 304s that
    still paid the whole snapshot setup)."""
    since = since.strip()
    if not since.startswith('"f') or store.STORE_BACKEND != 'postgres':
        return False
    try:
        slug = store._safe_slug(slug)
        if not os.path.exists(store._db_path(slug)):
            return False
        now = time.time() if now_ts is None else now_ts
        with store._POOL.acquire(slug) as conn:
            if conn.in_transaction:
                return False
            conn.use()
            s = f'org_{int(conn.org_id)}'
            row = conn.raw.execute(
                f"SELECT EXISTS(SELECT 1 FROM {s}.meta WHERE key='schema_version'), "
                f"i.format='orgtree.work-index/v1' AND i.valid, i.revision, "
                f"r.ready AND r.initialized AND NOT r.questions_dirty "
                f"AND r.format='orgtree.work-access/v1' "
                f"AND NOT EXISTS(SELECT 1 FROM {s}.work_read_dirty), r.revision, "
                f"l.initialized AND l.ready AND l.format=%s "
                f"AND NOT EXISTS(SELECT 1 FROM {s}.work_list_dirty), l.revision, "
                # a scalar subquery, not EXISTS: EXISTS drops ORDER BY/LIMIT and
                # with them the partial index (a seq scan of every summary)
                f"(SELECT 1 FROM {s}.work_index WHERE {workquery._UNSUPPORTED_ROW}) IS NULL, "
                f"NOT EXISTS(SELECT 1 FROM {s}.doc WHERE key IN ('nodes','work_scope_log') LIMIT 1), "
                f"(SELECT count(*) FROM {s}.work_read_policy "
                f"WHERE location='active' AND deadline < %s) "
                f"FROM {s}.work_index_state i, {s}.work_read_state r, {s}.work_list_state l "
                f"WHERE i.singleton AND r.singleton AND l.singleton",
                (worklistmeta.FORMAT, now)).fetchone()
            org_id = int(conn.org_id)
    except Exception:                                            # noqa: BLE001
        return False      # the full path reports it, exactly as before
    if not row or not all(row[k] for k in (0, 1, 3, 5, 7, 8)):
        return False
    return since == _etag(slug, org_id, USER, backlogged, [row[2], row[4], row[6]], row[9])


def foreground_conditional(slug, viewer=USER, *, backlogged=False, since='', now_ts=None):
    """(etag, body) for the plain foreground, or (etag, None) when `since`
    already names this version; None requests whole-route compatibility.

    The validator and the body share one snapshot, so a body is never labelled
    with a newer version than it shows. On a match nothing is selected,
    counted or projected."""
    def build(ctx, org_slug):
        tag = etag(ctx, org_slug, backlogged)
        if since == tag:
            return tag, None
        return tag, _foreground_body(ctx, org_slug, viewer, backlogged, 0)
    return _read(slug, viewer, build, now_ts)


def foreground(slug, viewer=USER, *, backlogged=False, archive_limit=0, now_ts=None):
    if type(archive_limit) is not int or not 0 <= archive_limit <= workquery.MAX_PAGE:
        raise ValueError(f'archive_limit must be 0..{workquery.MAX_PAGE}')
    def build(ctx, org_slug):
        return _foreground_body(ctx, org_slug, viewer, backlogged, archive_limit)
    return _read(slug, viewer, build, now_ts)


def _foreground_body(ctx, org_slug, viewer, backlogged, archive_limit):
    q = ctx.query
    counts = workread.counts_raw(q.raw, q.org_id, viewer=viewer, now_ts=q.now)
    if counts is None:
        raise workquery.CompatibilityRequired('docket counts unavailable')
    body = dict(format=FORMAT, counts=counts, now=q.now, items=[], references=[], attention=[])
    if backlogged:
        body['backlogged'] = []
    selected = q.foreground(include_backlogged=backlogged)
    ctx.prime(selected)
    for raw in selected:
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
        ctx.prime(rows)
        body['archived'] = [ctx.light(row, org_slug) for row in rows]
        body['references'].extend(reference(row) for row in body['archived'])
        body['next_cursor'] = following
        body['catalog'] = q.catalog
    # The revision also keys on-demand historical references in mounted
    # views. Remote archive-only edits must invalidate positive/negative
    # lookups even when active rows and counts are unchanged. Hash the
    # same-snapshot catalog without returning hidden rows or raw counters.
    body['revision'] = work_ui._hash([
        {k: v for k, v in body.items() if k != 'now'}, q.catalog])
    return body


def archive(slug, viewer=USER, *, limit=50, cursor='', now_ts=None):
    def build(ctx, org_slug):
        rows, following = ctx.query.archive(limit=limit, cursor=cursor)
        ctx.prime(rows)
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


def lookup_many(slug, viewer, names, *, now_ts=None):
    def build(ctx, org_slug):
        rows = ctx.query.lookup_many(names)
        ctx.prime(rows)
        return dict(format=FORMAT, references=[reference(ctx.light(row, org_slug))
            for row in rows], catalog=ctx.query.catalog)
    return _read(slug, viewer, build, now_ts)


class AgentContext(workdetail.Context):
    """The agent's `orgtree_work list`: rows chosen by the index, rendered from
    their whole bodies by the ledger's own view and list assembly.

    agent-orgtree-work-list-still-reads-the-whole-or: the tool served the list
    from `store.cached_org`, which refreshes the shared org snapshot after
    every save and walks every item (N1000: server p50 1203 ms). The light list
    payload cannot stand in for a body here: `candidate` needs `delivery`, and
    `omitted_fields` names `review_packets_newest_same_as` when the newest
    packet is folded. So only the readable rows are decoded, in one statement
    per location."""
    WORK_BACKLOG = Org.WORK_BACKLOG
    WORK_UNCOUNTED = Org.WORK_UNCOUNTED
    _work_backlogged = Org._work_backlogged
    _work_hoist_shared = staticmethod(Org._work_hoist_shared)
    _work_list_payload = Org._work_list_payload

    def __init__(self, query):
        super().__init__(query)
        self._questions = {}
        self._pointers = {}

    def _work_pointer_target(self, slug):
        if slug in self._pointers:
            return self._pointers[slug]
        return super()._work_pointer_target(slug)

    def _work_questions(self, slug):
        if slug in self._questions:
            return self._questions[slug]
        return super()._work_questions(slug)

    def work_counts(self, now_ts=None):
        # USER is never served here (`agent_list` returns None for it)
        raise TypeError('agent list does not serve the whole-org counts')

    def bodies(self, rows):
        """Every row's exact body, checked against the index stamp."""
        q = self.query
        found = {}
        active = [row.source_key for row in rows if not row.physical_archive]
        if active:
            for key, val in q.raw.execute(
                    f'SELECT key,val FROM {q.schema}.doc WHERE key=ANY(%s)', (active,)):
                found[(False, key)] = val
        archived = [int(row.source_key) for row in rows if row.physical_archive]
        if archived:
            for seq, val in q.raw.execute(
                    f"SELECT seq,val FROM {q.schema}.log_l WHERE sect='work_items_archive' "
                    f'AND seq=ANY(%s)', (archived,)):
                found[(True, str(seq))] = val
        out = []
        for row in rows:
            val = found.get((row.physical_archive, str(row.source_key)))
            if val is None or hashlib.sha256(val.encode()).digest() != row.body_sha256:
                raise workquery.CompatibilityRequired('docket body/index mismatch')
            body = json.loads(val)
            if body.get('slug') != row.summary['slug']:
                raise workquery.CompatibilityRequired('docket body identity mismatch')
            out.append(body)
        return out

    def prime(self, rows, bodies):
        """What `_work_view` reads beside the body, for every row at once:
        questions (selected with the row), scope history, pointer targets and
        actor identities. A miss still reads one row, as in `workdetail`."""
        q = self.query
        for row in rows:
            self._questions[row.summary['slug']] = row.questions
        logged = {b['slug']: int(b.get('scope_logged') or 0) for b in bodies
                  if int(b.get('scope_logged') or 0) and b['slug'] not in self._scope}
        if logged:
            scope = {slug: [] for slug in logged}
            for owner, val in q.raw.execute(
                    f"SELECT owner,val FROM {q.schema}.log_d WHERE sect='work_scope_log' "
                    f'AND owner=ANY(%s) ORDER BY owner,seq', (sorted(logged),)):
                scope[owner].append(json.loads(val))
            for slug, count in logged.items():
                if len(scope[slug]) != count:
                    raise workquery.CompatibilityRequired('scope history count mismatch')
                self._scope[slug] = scope[slug]
        names = set()
        actors = {q.viewer}
        for body in bodies:
            names.update((body.get('parent'), body.get('superseded_by')))
            names.update(body.get('dependencies') or [])
            for row in body.get('history') or []:
                if isinstance(row, dict):
                    for key in Org._WORK_HIST_POINTERS.get(str(row.get('op') or ''), ()):
                        names.add(row.get(key))
            _actors(body, actors)
        names = sorted(n for n in names if isinstance(n, str) and 0 < len(n) <= 256
                       and n not in self._pointers)
        for start in range(0, len(names), 128):
            chunk = names[start:start + 128]
            found = {row.summary['slug']: row.summary for row in q.lookup_many(chunk)}
            for name in chunk:
                self._pointers[name] = found.get(name)
        self.nodes.prefetch(actors)


def agent_list(slug, viewer, *, include_archived=False, include_backlogged=False,
               compact=False, projection=None, fields=None, now_ts=None):
    """`Org.work_list` for an agent viewer from the docket index, or None
    requesting the exact whole-org reader (not PostgreSQL, an index that is
    dirty or unavailable, the operator as viewer, or any disagreement between
    the index's archive hint and the ledger's own classification)."""
    if viewer == USER:
        return None

    def build(ctx, org_slug):
        q = ctx.query
        sel = ctx._work_fields_arg(fields)
        proj = projection or ('compact' if compact else 'full')
        total = q.raw.execute(f'SELECT total FROM {q.schema}.work_read_totals WHERE viewer=%s',
                              (viewer,)).fetchone()
        total = int(total[0]) if total else 0
        # every readable row the index does not call archived: the main list,
        # the backlog, and archived rows held out of the archive by attention
        shown = q.foreground(include_backlogged=True)
        if len(shown) > total:
            raise workquery.CompatibilityRequired('docket foreground exceeds readable total')
        hidden = []
        if include_archived:
            cursor = ''
            while True:
                page, cursor = q.archive(limit=workquery.MAX_PAGE, cursor=cursor)
                hidden.extend(page)
                if not cursor:
                    break
            if len(shown) + len(hidden) != total:
                raise workquery.CompatibilityRequired('docket archive does not add up')
        rows = shown + hidden
        bodies = ctx.bodies(rows)
        ctx.prime(rows, bodies)
        items, arch, back = [], [], []
        for n, (row, body) in enumerate(zip(rows, bodies)):
            view = ctx._work_view(body, row.physical_archive, viewer, q.now,
                                  scope_archive=False)
            if view['archived'] != (n >= len(shown)):
                raise workquery.CompatibilityRequired('docket archive hint disagrees')
            if view['archived']:
                arch.append(view)
            elif ctx._work_backlogged(body):
                back.append(view)
            else:
                items.append(view)
        return ctx._work_list_payload(
            viewer, items, arch, back, total - len(shown), q.now,
            include_archived=include_archived, include_backlogged=include_backlogged,
            compact=compact, proj=proj, sel=sel)
    return _read(slug, viewer, build, now_ts, AgentContext)
