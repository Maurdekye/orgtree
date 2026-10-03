"""Native docket reads in the caller's committed org database snapshot.

Authority uses recorded names and the exact named anchor's parents. Identities
are decoded separately for the ledger's directional current-holder predicate.
Hot reads select active rows and archived attention; history is an explicit read.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
import time

from ..ledger import Org, USER
from .. import workquery
from . import codec, registry
from .mappers.docket import WORK_ITEM, WORK_ITEMS
from .mappers.records import ASKS, WORK_SCOPE_LOG

_POLICY_KEYS = frozenset(('slug', 'rev', 'kind', 'title', 'status', 'owner', 'reviewer',
    'created_by', 'participants', 'at', 'updated_at', 'docket_at', 'archived_at',
    'manual_attention', 'manual_attention_rev', 'parent', 'superseded_by'))
_POLICY = codec.Spec('work_items', tuple(f for f in WORK_ITEM.fields if f.key in _POLICY_KEYS))
_LIST = codec.Spec('work_items', tuple(f for f in WORK_ITEM.fields
    if f.key not in ('history', 'scope', 'artifacts', 'findings', 'evidence', 'acceptance',
                     'review_seat_requests')))
_ORDER = 'i.docket_order COLLATE "C"'
_ATTENTION = '(i.docket_manual OR EXISTS (SELECT 1 FROM orgtree.docket_question_links q WHERE q.item_slug=i.slug))'
_ARCHIVE = f'(NOT {_ATTENTION} AND (i.list_key=\'archive\' OR i.docket_deadline < %s))'


def _dicts(raw, sql, params=()):
    from psycopg.rows import dict_row
    with raw.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _decode(raw, main, spec):
    """Decode only these surrogate ids, including nested child positions."""
    if not main:
        return []
    ids = [r['id'] for r in main]
    layout = WORK_ITEMS.layout()
    wanted = codec.layout(spec, WORK_ITEMS.keys, WORK_ITEMS.link)
    children = {table: _dicts(raw, f'SELECT * FROM orgtree.{table} WHERE item_id=ANY(%s)', (ids,))
                for table in wanted if table != 'work_items'}
    ch = codec.Children(children, layout)
    return [codec.decode(spec, row, ch, (row['id'],)) for row in main]


@contextmanager
def read(slug, *, viewer=USER, now_ts=None):
    """One checked registry connection and one RR/RO transaction per request."""
    row = registry.lookup(slug)
    with registry.connection(slug) as raw:
        if raw.info.transaction_status != 0:
            raise RuntimeError('native docket cannot reuse a writer transaction')
        raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            yield Snapshot(raw, row[0], viewer=viewer,
                           now_ts=time.time() if now_ts is None else now_ts)
        finally:
            raw.execute('ROLLBACK')


class Snapshot:
    native = True
    schema = 'orgtree'

    def __init__(self, raw, org_id, *, viewer, now_ts):
        if not isinstance(viewer, str) or not viewer or not math.isfinite(now_ts):
            raise ValueError('viewer and finite clock are required')
        if raw.execute('SHOW transaction_isolation').fetchone()[0] != 'repeatable read' or \
                raw.execute('SHOW transaction_read_only').fetchone()[0] != 'on':
            raise ValueError('docket query requires repeatable-read read-only transaction')
        self.raw, self.org_id, self.viewer, self.now = raw, int(org_id), viewer, now_ts
        stamp = raw.execute('SELECT docket_rev,catalog_rev,view_rev,rev '
                            'FROM orgtree.org_revision WHERE singleton').fetchone()
        if stamp is None:
            raise RuntimeError('docket revision singleton missing')
        self.catalog, self.revision = [int(v) for v in stamp[:3]], int(stamp[3])
        self._main, self._questions = {}, {}

    def _access(self):
        if self.viewer == USER:
            return 'TRUE'
        # The recursive walk starts at THIS recorded anchor, never its head.
        # UNION also terminates a malformed parent cycle. Tombstones are absent.
        v = '(SELECT name FROM current_viewer)'
        return f'''(i.owner_node={v} OR i.created_by_node={v} OR i.reviewer_node={v}
          OR EXISTS(SELECT 1 FROM orgtree.work_item_participants p WHERE p.item_id=i.id AND p.value={v})
          OR EXISTS(WITH RECURSIVE up(id,parent_id,name) AS (
            SELECT id,parent_id,name FROM orgtree.agents WHERE name=i.anchor_name AND NOT tombstone
            UNION SELECT a.id,a.parent_id,a.name FROM orgtree.agents a JOIN up u ON a.id=u.parent_id
            WHERE NOT a.tombstone)
            SELECT 1 FROM up WHERE name={v} AND name<>i.anchor_name))'''

    def _prefix(self, *, cold=False):
        prefix = 'WITH RECURSIVE current_viewer(name) AS (VALUES(%s::text))'
        if not cold or self.viewer == USER:
            return prefix, '', self._access()
        # Explicit historical reads first form the viewer's readable id set
        # through role/participant indexes; unrelated historical bodies stay out.
        prefix += ''' , descendants(id,name) AS (
          SELECT id,name FROM orgtree.agents WHERE parent_id=(
            SELECT id FROM orgtree.agents WHERE name=%s AND NOT tombstone) AND NOT tombstone
          UNION SELECT a.id,a.name FROM orgtree.agents a JOIN descendants d ON a.parent_id=d.id
            WHERE NOT a.tombstone), readable(id) AS (
          SELECT id FROM orgtree.work_items WHERE owner_node=%s
          UNION SELECT id FROM orgtree.work_items WHERE created_by_node=%s
          UNION SELECT id FROM orgtree.work_items WHERE reviewer_node=%s
          UNION SELECT item_id FROM orgtree.work_item_participants WHERE value=%s
          UNION SELECT i.id FROM orgtree.work_items i JOIN descendants d ON d.name=i.anchor_name)'''
        return prefix, ' JOIN readable r ON r.id=i.id', 'TRUE'

    def _args(self, cold=False):
        return [self.viewer] * (6 if cold and self.viewer != USER else 1)

    def _rows(self, sql, params):
        main = _dicts(self.raw, sql, params)
        for r in main:
            self._main[str(r['id'])] = r
        summaries = _decode(self.raw, main, _POLICY)
        questions = self.questions_many([r['slug'] for r in summaries])
        return [workquery.Row(s, r['list_key']=='archive', questions[s['slug']], str(r['id']), b'')
                for r, s in zip(main, summaries)]

    def lookup(self, slug):
        rows = self.lookup_many([slug])
        return rows[0] if rows else None

    def lookup_many(self, slugs):
        if len(slugs)>128 or any(not isinstance(s,str) or not 0<len(s)<=256 for s in slugs):
            raise ValueError('reference lookup requires at most 128 names of 1..256 characters')
        if not slugs:
            return []
        prefix, join, access = self._prefix()
        return self._rows(prefix + f' SELECT i.* FROM orgtree.work_items i{join} '
                          f'WHERE i.slug=ANY(%s) AND {access}', self._args()+[slugs])

    def detail(self, slug):
        row = self.lookup(slug)
        return None if row is None else (self.bodies([row])[0], row.physical_archive)

    def bodies(self, rows):
        return _decode(self.raw, [self._main[r.source_key] for r in rows], WORK_ITEM)

    def list_inputs(self, rows):
        from ..workdetail import Context
        bodies = self.bodies(rows)
        ctx = Context(self)
        ctx._scope.update(self.scope_many([b['slug'] for b in bodies if b.get('scope_logged')]))
        for b in bodies:
            b.update(objective_notice=ctx._work_objective_notice(b),status_at=ctx._work_status_at(b),
                     scope_archive_summary=ctx._work_scope_archive_summary(b))
        return bodies

    def foreground(self, *, include_backlogged=False):
        prefix, join, access = self._prefix()
        prefix += ''' , candidates(id) AS (
          SELECT id FROM orgtree.work_items WHERE list_key='active'
          UNION SELECT id FROM orgtree.work_items WHERE docket_manual
          UNION SELECT i.id FROM orgtree.docket_question_links q
            JOIN orgtree.work_items i ON i.slug=q.item_slug)'''
        rows = self._rows(prefix + f' SELECT i.* FROM candidates c JOIN orgtree.work_items i ON i.id=c.id{join}'
            f' WHERE {access} AND NOT {_ARCHIVE} ORDER BY {_ORDER} DESC,i.slug COLLATE "C" DESC',
            self._args()+[self.now])
        return rows if include_backlogged else [r for r in rows
            if r.summary.get('status')!='backlogged' or r.summary.get('manual_attention') or r.questions]

    def archive(self, *, limit=50, cursor=''):
        if type(limit) is not int or not 1<=limit<=workquery.MAX_PAGE:
            raise ValueError(f'archive limit must be 1..{workquery.MAX_PAGE}')
        clock, after = self.now, None
        if cursor:
            value = workquery._decode(cursor)
            if not isinstance(value,dict) or value.get('binding') != [self.org_id,self.viewer,self.catalog,limit]:
                raise workquery.CursorReset('archive catalog or viewer changed; restart paging')
            clock, after = value.get('clock'), value.get('after')
            if type(clock) not in (int,float) or not math.isfinite(clock) or not 0<=self.now-clock<=workquery.CURSOR_SECONDS:
                raise workquery.CursorReset('archive cursor expired; restart paging')
            if not isinstance(after,list) or len(after)!=2 or any(not isinstance(v,str) for v in after):
                raise workquery.CursorReset('invalid archive position; restart paging')
        self.now = clock
        prefix, join, access = self._prefix(cold=True)
        sql = prefix + f' SELECT i.* FROM orgtree.work_items i{join} WHERE {access} AND {_ARCHIVE}'
        args = self._args(True)+[clock]
        if after is not None:
            sql += f' AND ({_ORDER},i.slug COLLATE "C") < (%s COLLATE "C",%s COLLATE "C")'
            args.extend(after)
        rows = self._rows(sql+f' ORDER BY {_ORDER} DESC,i.slug COLLATE "C" DESC LIMIT %s', args+[limit+1])
        more, rows = len(rows)>limit, rows[:limit]
        token = None
        if more:
            last = self._main[rows[-1].source_key]
            token = workquery._encode(dict(binding=[self.org_id,self.viewer,self.catalog,limit],clock=clock,
                after=[last['docket_order'],last['slug']]))
        return rows, token

    def counts(self, *, include_archived=True):
        prefix, join, access = self._prefix(cold=include_archived)
        if not include_archived:
            prefix += ''' , candidates(id) AS (
              SELECT id FROM orgtree.work_items WHERE list_key='active'
              UNION SELECT id FROM orgtree.work_items WHERE docket_manual
              UNION SELECT i.id FROM orgtree.docket_question_links q JOIN orgtree.work_items i ON i.slug=q.item_slug)'''
            join = ' JOIN candidates c ON c.id=i.id' + join
        sql = prefix + f''' SELECT count(*) FILTER (WHERE attention),
          count(*) FILTER (WHERE NOT archived AND status<>ALL(%s)),
          count(*) FILTER (WHERE archived),
          count(*) FILTER (WHERE NOT archived AND status='backlogged' AND NOT attention)
          FROM (SELECT {_ATTENTION} AS attention,{_ARCHIVE} AS archived,
            CASE WHEN i.status='waiting' THEN 'blocked' ELSE i.status END AS status
            FROM orgtree.work_items i{join} WHERE {access}) policy'''
        values = self.raw.execute(sql,self._args(include_archived)+[list(Org.WORK_UNCOUNTED),self.now]).fetchone()
        out = dict(zip(('attention','active','archived','backlogged'),map(int,values)))
        if not include_archived:
            out.pop('archived')
        return out

    def deadline_count(self):
        return int(self.raw.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='active' "
            'AND docket_deadline < %s',(self.now,)).fetchone()[0])

    def questions_many(self, slugs):
        wanted = [s for s in slugs if s not in self._questions]
        if wanted:
            for s in wanted:
                self._questions[s] = []
            rows = _dicts(self.raw, '''SELECT q.item_slug,a.* FROM orgtree.docket_question_links q
                JOIN orgtree.asks a ON a.id=q.ask_id WHERE q.item_slug=ANY(%s) AND a.status='open'
                ORDER BY a.ord''', (wanted,))
            spec = codec.Spec('asks',tuple(f for f in ASKS.fields if f.key in
                                         ('id','node','rev','at','questions')))
            for r in rows:
                ask = codec.decode(spec,r,None)
                tabs = [{'index':n,**{k:q[k] for k in ('question','header','options','multi') if k in q}}
                    for n,q in enumerate(ask.get('questions') or []) if q.get('work_item')==r['item_slug']]
                if tabs:
                    self._questions[r['item_slug']].append(dict(ask_id=ask['id'],node=ask['node'],
                        rev=int(ask.get('rev') or 1),at=ask.get('at'),tabs=tabs))
        return {s:self._questions[s] for s in slugs}

    def questions(self, slug):
        return self.questions_many([slug])[slug]

    def scope_many(self, slugs):
        found = {s:[] for s in slugs}
        for r in _dicts(self.raw, '''SELECT a.name AS item_slug,l.* FROM orgtree.agents a
            JOIN orgtree.work_scope_log l ON l.agent_id=a.id WHERE a.name=ANY(%s) ORDER BY a.name,l.idx''', (slugs,)):
            found[r['item_slug']].append(codec.decode(WORK_SCOPE_LOG,r,None))
        return found

    def identities(self, names):
        rows = _dicts(self.raw, '''WITH RECURSIVE up(id) AS (
            SELECT id FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone
            UNION SELECT a.parent_id FROM orgtree.agents a JOIN up u ON u.id=a.id WHERE a.parent_id IS NOT NULL)
            SELECT a.name,a.state,a.generation,a.lineage_born,p.name AS parent_name,a.parent,a.parent_null,a.extra
            FROM up JOIN orgtree.agents a USING(id) LEFT JOIN orgtree.agents p ON p.id=a.parent_id
            WHERE NOT a.tombstone''', (list(names),))
        out = {n:None for n in names}
        for r in rows:
            value = dict(id=r['name'],state=r['state'],generation=r['generation'],seat_id=r['lineage_born'],
                         parent=r['parent_name'] if r['parent_name'] is not None else r['parent'])
            value.update({k:v for k,v in (r['extra'] or {}).items()
                          if k in ('state','generation','seat_id','parent')})
            out[r['name']] = value
        return out


def counts_raw(raw, org_id, *, viewer, now_ts):
    return Snapshot(raw,org_id,viewer=viewer,now_ts=now_ts).counts()


def attention_raises_raw(raw, org_id, *, viewer):
    q = Snapshot(raw,org_id,viewer=viewer,now_ts=time.time())
    prefix, join, access = q._prefix()
    return [[s,int((flag or {}).get('set_rev') or 0)] for s,flag in raw.execute(prefix+
        f' SELECT i.slug,i.manual_attention FROM orgtree.work_items i{join} WHERE i.docket_manual AND {access} ORDER BY i.slug',q._args())]


def read_work_items_rows(slug, wanted):
    from .. import workrows
    wanted = tuple(dict.fromkeys(wanted))
    for s in wanted:
        workrows.slug_of({'slug':s})
    with read(slug) as q:
        ids = [r[0] for r in q.raw.execute("SELECT slug FROM orgtree.work_items WHERE list_key='active' ORDER BY ord")]
        rows = q.lookup_many([s for s in wanted if s in ids]) if len(wanted)<=128 else []
        if len(wanted)>128:
            for start in range(0,len(wanted),128):
                rows.extend(q.lookup_many([s for s in wanted[start:start+128] if s in ids]))
        return dict(revision=q.revision,work_revision=q.catalog[0],ids=ids,
                    items={b['slug']:b for b in q.bodies(rows)})
