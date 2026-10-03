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
from ..work_ui import FIELDS
from . import codec, registry
from .mappers.docket import WORK_ITEM, WORK_ITEMS
from .mappers.records import ASKS, WORK_SCOPE_LOG

_POLICY_KEYS = frozenset(('slug', 'rev', 'kind', 'title', 'status', 'owner', 'reviewer',
    'created_by', 'participants', 'at', 'updated_at', 'docket_at', 'archived_at',
    'manual_attention', 'manual_attention_rev', 'parent', 'superseded_by'))
_POLICY = codec.Spec('work_items', tuple(f for f in WORK_ITEM.fields if f.key in _POLICY_KEYS))
_LIST = codec.Spec('work_items', tuple(f for f in WORK_ITEM.fields if f.key in FIELDS or
    f.key in ('scope_seq','scope_guard','scope_logged')))


def name_key(value):
    """ASCII key in Python Unicode order, including NUL and lone surrogates.

    Fixed-width code points preserve prefix ordering. The original string
    stays unchanged; only this derived key crosses PostgreSQL's text boundary.
    """
    return ''.join(f'{ord(c):06x}' for c in value)


def write_fields(record):
    """Pure write-time policy header; decode returns the original record.

    Conversion and compat saves use this same function. The canonical parser
    sees the original timestamp, even if the codec also stores a typed date.
    PostgreSQL never reparses a retained misfit value.
    """
    from ..ledger import Org
    stamp = str(record.get('docket_at') or record.get('updated_at') or '')
    status = record.get('status')
    deadline = None
    if status in Org.WORK_ARCHIVES_AT_ONCE:
        deadline = float('-inf')
    elif status in Org.WORK_ARCHIVES_ITSELF:
        age = Org._work_age_s(record,0)
        if age is not None:
            deadline = Org.WORK_ARCHIVE_AFTER_S-age
    owner = Org._work_actor_node(record.get('owner'))
    creator = Org._work_actor_node(record.get('created_by'))
    reviewer = Org._work_actor_node(record.get('reviewer'))
    return dict(docket_order=name_key(stamp),docket_deadline=deadline,
                docket_manual=bool(record.get('manual_attention')),
                docket_owner_key=None if owner is None else name_key(owner),
                docket_creator_key=None if creator is None else name_key(creator),
                docket_reviewer_key=None if reviewer is None else name_key(reviewer),
                docket_anchor_key=None if not (owner or creator) else name_key(owner or creator))


def _columns(spec):
    fields = [c for c,_ in codec.layout(spec,WORK_ITEMS.keys,WORK_ITEMS.link)['work_items']['columns']]
    extra = 'docket_policy_extra' if spec is _POLICY else 'docket_list_extra'
    columns = ['i.'+codec.quote(c) for c in ('id','list_key','ord','docket_order',*fields)]
    columns.append('i.'+extra+' AS extra')
    if spec is _LIST:
        columns.append('i.docket_scope_meta')
    return ','.join(columns)


_POLICY_COLUMNS = _columns(_POLICY)
_STATUS_CHANGE = '''h.kind IS DISTINCT FROM 'folded' AND (h.op IN ('accept','reopen','supersede')
    OR (h.op='update' AND json_typeof(h.changes)='object' AND h.changes->'status' IS NOT NULL)
    OR (h.op='dismiss_attention' AND coalesce(h."from"::text,'null')<>'"blocked"'))
    AND (h.at IS NOT NULL OR orgtree.docket_truth(h.extra->'at'))'''
_ORDER = 'i.docket_order COLLATE "C"'
_ATTENTION = '(i.docket_manual OR EXISTS (SELECT 1 FROM orgtree.docket_question_links q WHERE q.item_slug=i.slug))'
_ARCHIVE = f'(NOT {_ATTENTION} AND (i.list_key=\'archive\' OR coalesce(i.docket_deadline < %s,false)))'


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
        stamp = raw.execute('SELECT r.docket_rev,r.catalog_rev,r.view_rev,r.rev,i.incarnation '
                            'FROM orgtree.org_revision r CROSS JOIN orgtree.org_identity i '
                            'WHERE r.singleton AND i.singleton').fetchone()
        if stamp is None:
            raise RuntimeError('docket revision singleton missing')
        self.catalog, self.revision = [int(v) for v in stamp[:3]], int(stamp[3])
        self.incarnation = str(stamp[4])
        self._main, self._questions = {}, {}

    def _access(self):
        if self.viewer == USER:
            return 'TRUE'
        # The recursive walk starts at THIS recorded anchor, never its head.
        # UNION also terminates a malformed parent cycle. Tombstones are absent.
        v, k = '(SELECT name FROM current_viewer)', '(SELECT key FROM current_viewer)'
        return f'''(i.docket_owner_key={k} OR i.docket_creator_key={k} OR i.docket_reviewer_key={k}
          OR EXISTS(SELECT 1 FROM orgtree.work_item_participants p WHERE p.item_id=i.id AND p.value={v})
          OR EXISTS(WITH RECURSIVE up(id,parent_id,name) AS (
            SELECT id,parent_id,name FROM orgtree.agents WHERE orgtree.docket_key(name)=i.docket_anchor_key AND NOT tombstone
            UNION SELECT a.id,a.parent_id,a.name FROM up u CROSS JOIN LATERAL (
              SELECT id,parent_id,name FROM orgtree.agents WHERE id=u.parent_id AND NOT tombstone OFFSET 0) a)
            SELECT 1 FROM up WHERE name={v} AND orgtree.docket_key(name)<>i.docket_anchor_key))'''

    def _prefix(self, *, cold=False):
        prefix = 'WITH RECURSIVE current_viewer(name,key) AS (VALUES(%s::text,%s::text))'
        if not cold or self.viewer == USER:
            return prefix, '', self._access()
        # Explicit historical reads first form the viewer's readable id set
        # through role/participant indexes; unrelated historical bodies stay out.
        prefix += ''' , descendants(id,name) AS (
          SELECT id,name FROM orgtree.agents WHERE parent_id=(
            SELECT id FROM orgtree.agents WHERE name=(SELECT name FROM current_viewer) AND NOT tombstone) AND NOT tombstone
          UNION SELECT a.id,a.name FROM descendants d CROSS JOIN LATERAL (
            SELECT id,name FROM orgtree.agents WHERE parent_id=d.id AND NOT tombstone OFFSET 0) a), readable(id) AS (
          SELECT id FROM orgtree.work_items WHERE docket_owner_key=(SELECT key FROM current_viewer)
          UNION SELECT id FROM orgtree.work_items WHERE docket_creator_key=(SELECT key FROM current_viewer)
          UNION SELECT id FROM orgtree.work_items WHERE docket_reviewer_key=(SELECT key FROM current_viewer)
          UNION SELECT item_id FROM orgtree.work_item_participants WHERE value=(SELECT name FROM current_viewer)
          UNION SELECT i.id FROM descendants d CROSS JOIN LATERAL (
            SELECT id FROM orgtree.work_items WHERE docket_anchor_key=orgtree.docket_key(d.name) OFFSET 0) i)'''
        return prefix, ' JOIN readable r ON r.id=i.id', 'TRUE'

    def _args(self, cold=False):
        return [self.viewer,name_key(self.viewer)]

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
        return self._rows(prefix + f' SELECT {_POLICY_COLUMNS} FROM orgtree.work_items i{join} '
                          f'WHERE i.slug=ANY(%s) AND {access}', self._args()+[slugs])

    def detail(self, slug):
        row = self.lookup(slug)
        return None if row is None else (self.bodies([row])[0], row.physical_archive)

    def bodies(self, rows):
        if not rows:
            return []
        main = {str(r['id']):r for r in _dicts(self.raw,
            'SELECT * FROM orgtree.work_items WHERE id=ANY(%s)',([int(r.source_key) for r in rows],))}
        return _decode(self.raw,[main[r.source_key] for r in rows],WORK_ITEM)

    def list_inputs(self, rows):
        """List fields plus bounded scope endpoints and the last status change.

        No authored scope/history/evidence bodies. Spilled scope positions are
        direct index lookups, so an older rolled prefix adds no rows to this read.
        """
        from ..workdetail import Context
        if not rows:
            return []
        ids = [int(r.source_key) for r in rows]
        main = {r['id']:r for r in _dicts(self.raw,
            f'SELECT {_columns(_LIST)} FROM orgtree.work_items i WHERE i.id=ANY(%s)',(ids,))}
        bodies = _decode(self.raw,[main[n] for n in ids],_LIST)
        counts = dict(self.raw.execute('SELECT item_id,count(*) FROM orgtree.work_item_scope '
            'WHERE item_id=ANY(%s) GROUP BY item_id',(ids,)))
        ctx, targets, endpoints = Context(self), {'log':[],'inline':[]}, {}
        for row,b in zip(rows,bodies):
            n = int(row.source_key)
            meta = main[n]['docket_scope_meta']
            legacy_n = int(meta['archive_count'])
            inline_n = int(meta['inline_count'] if meta['inline_count'] is not None else counts.get(n,0))
            logged = int(b.get('scope_logged') or 0)
            rolled = int(b.get('scope_rolled') or 0)+legacy_n
            size = min(rolled,legacy_n+logged+inline_n)
            endpoints[b['slug']] = dict(count=size,first_seq=None,last_seq=None,first_at=None,last_at=None)
            for which,pos in (('first',0),('last',size-1)) if size else ():
                if pos<legacy_n:
                    self._endpoint(endpoints[b['slug']],which,meta[which])
                elif pos<legacy_n+logged:
                    targets['log'].append((b['slug'],which,pos-legacy_n,n))
                else:
                    targets['inline'].append((b['slug'],which,pos-legacy_n-logged,n))
            b['objective_notice'] = ctx._work_objective_notice({**b,'scope':range(inline_n),
                                                              'scope_archive':range(legacy_n)})
            b['status_at'] = b.get('status_at') or str(b.get('at') or '')
        for kind,wanted in targets.items():
            if not wanted:
                continue
            values = ','.join(['(%s::text,%s::text,%s::int,%s::bigint)']*len(wanted))
            params = [v for group in wanted for v in group]
            source = ('JOIN orgtree.agents a ON a.name=w.slug JOIN orgtree.work_scope_log l '
                      'ON l.agent_id=a.id AND l.idx=w.position' if kind=='log' else
                      'JOIN orgtree.work_item_scope l ON l.item_id=w.item_id AND l.pos=w.position')
            for r in _dicts(self.raw,f'''WITH wanted(slug,which,position,item_id) AS (VALUES {values})
                SELECT w.slug,w.which,l.seq,l.at,l.at_text,l.extra->'seq' AS extra_seq,
                l.extra->'at' AS extra_at FROM wanted w {source}''',params):
                self._endpoint(endpoints[r['slug']],r['which'],self._scope_header(r))
        unstamped = [n for n in ids if not main[n].get('status_at') and not
                     (main[n].get('extra') or {}).get('status_at')]
        if unstamped:
            by_id = dict(zip(ids,bodies))
            for r in _dicts(self.raw,f'''WITH wanted(item_id) AS (SELECT unnest(%s::bigint[]))
                SELECT w.item_id,h.at,h.at_text,h.extra->'at' AS extra_at FROM wanted w
                JOIN LATERAL (SELECT h.at,h.at_text,h.extra FROM orgtree.work_item_history h
                  WHERE h.item_id=w.item_id AND {_STATUS_CHANGE} ORDER BY h.pos DESC LIMIT 1) h ON true''',(unstamped,)):
                by_id[r['item_id']]['status_at'] = str(self._scope_header(r).get('at'))
        for b in bodies:
            b['scope_archive_summary'] = endpoints[b['slug']]
        return bodies

    @staticmethod
    def _scope_header(row):
        return dict(seq=row.get('extra_seq') if row.get('extra_seq') is not None else row.get('seq'),
                    at=row['extra_at'] if row.get('extra_at') is not None else
                    codec.from_column('ts',row['at'],row.get('at_text')) if row.get('at') is not None else None)

    @staticmethod
    def _endpoint(summary,which,row):
        summary[which+'_seq'] = int(row.get('seq') or 0)
        summary[which+'_at'] = row.get('at')

    def foreground(self, *, include_backlogged=False):
        prefix, join, access = self._prefix()
        prefix += ''' , candidates(id) AS (
          SELECT id FROM orgtree.work_items WHERE list_key='active'
          UNION SELECT id FROM orgtree.work_items WHERE docket_manual
          UNION SELECT i.id FROM orgtree.docket_question_links q
            JOIN orgtree.work_items i ON i.slug=q.item_slug)'''
        rows = self._rows(prefix + f' SELECT {_POLICY_COLUMNS} FROM candidates c JOIN orgtree.work_items i ON i.id=c.id{join}'
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
            if not isinstance(value,dict) or value.get('binding') != [self.org_id,self.viewer,self.catalog,limit,self.incarnation]:
                raise workquery.CursorReset('archive catalog or viewer changed; restart paging')
            clock, after = value.get('clock'), value.get('after')
            if type(clock) not in (int,float) or not math.isfinite(clock) or not 0<=self.now-clock<=workquery.CURSOR_SECONDS:
                raise workquery.CursorReset('archive cursor expired; restart paging')
            if not isinstance(after,list) or len(after)!=2 or any(not isinstance(v,str) for v in after):
                raise workquery.CursorReset('invalid archive position; restart paging')
        self.now = clock
        prefix, join, access = self._prefix(cold=True)
        sql = prefix + f' SELECT {_POLICY_COLUMNS} FROM orgtree.work_items i{join} WHERE {access} AND {_ARCHIVE}'
        args = self._args(True)+[clock]
        if after is not None:
            sql += f' AND ({_ORDER},i.slug COLLATE "C") < (%s COLLATE "C",%s COLLATE "C")'
            args.extend(after)
        rows = self._rows(sql+f' ORDER BY {_ORDER} DESC,i.slug COLLATE "C" DESC LIMIT %s', args+[limit+1])
        more, rows = len(rows)>limit, rows[:limit]
        token = None
        if more:
            last = self._main[rows[-1].source_key]
            token = workquery._encode(dict(binding=[self.org_id,self.viewer,self.catalog,limit,self.incarnation],clock=clock,
                after=[last['docket_order'],last['slug']]))
        return rows, token

    def counts(self, *, include_archived=True):
        cold = include_archived and self.viewer != USER
        prefix, join, access = self._prefix(cold=cold)
        if not cold:
            prefix += ''' , candidates(id) AS (
              SELECT id FROM orgtree.work_items WHERE list_key='active'
              UNION SELECT id FROM orgtree.work_items WHERE docket_manual
              UNION SELECT i.id FROM orgtree.docket_question_links q JOIN orgtree.work_items i ON i.slug=q.item_slug)'''
            join = ' JOIN candidates c ON c.id=i.id' + join
        archived = 'count(*) FILTER (WHERE archived)'
        if self.viewer == USER and include_archived:
            archived += " + (SELECT n FROM orgtree.docket_counters WHERE kind='archive') - count(*) FILTER (WHERE attention AND physical_archive)"
        sql = prefix + f''' SELECT count(*) FILTER (WHERE attention),
          count(*) FILTER (WHERE NOT archived AND status<>ALL(%s)),
          {archived},
          count(*) FILTER (WHERE NOT archived AND status='backlogged' AND NOT attention)
          FROM (SELECT {_ATTENTION} AS attention,{_ARCHIVE} AS archived,
            CASE WHEN i.status='waiting' THEN 'blocked' ELSE coalesce(i.status,'') END AS status,
            i.list_key='archive' AS physical_archive
            FROM orgtree.work_items i{join} WHERE {access}) policy'''
        values = self.raw.execute(sql,self._args(cold)+[list(Org.WORK_UNCOUNTED),self.now]).fetchone()
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
        rows = _dicts(self.raw, '''WITH RECURSIVE wanted(name) AS (SELECT unnest(%s::text[])), up(id) AS (
            SELECT a.id FROM wanted w CROSS JOIN LATERAL (
              SELECT id FROM orgtree.agents WHERE name=w.name AND NOT tombstone OFFSET 0) a
            UNION SELECT a.parent_id FROM up u CROSS JOIN LATERAL (
              SELECT parent_id FROM orgtree.agents WHERE id=u.id AND parent_id IS NOT NULL OFFSET 0) a)
            SELECT a.name,a.state,a.generation,a.lineage_born,p.name AS parent_name,a.parent,a.parent_null,a.extra
            FROM up u CROSS JOIN LATERAL (SELECT * FROM orgtree.agents WHERE id=u.id AND NOT tombstone OFFSET 0) a
            LEFT JOIN LATERAL (SELECT name FROM orgtree.agents WHERE id=a.parent_id OFFSET 0) p ON true''', (list(names),))
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
