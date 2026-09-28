"""Snapshot-scoped docket counts, with canonical ledger policy at write time.

SQL dirty markers make outside writers safe: until their metadata is refreshed,
readers return None and the caller uses the whole exact compatibility context.
Raw bodies remain truth; explicit reconciliation checks the derived decisions.
"""
from __future__ import annotations

from collections import Counter, OrderedDict
from collections.abc import Mapping
import json
import logging
import threading
from types import SimpleNamespace

from .ledger import Org, USER
from . import workindex, workrows

log = logging.getLogger(__name__)


class _Parents(Mapping):
    """Only touched ancestor rows; bounded cache even during migration."""
    def __init__(self, raw, schema):
        self.raw, self.schema = raw, schema
        self.cache = OrderedDict()
        self.touched = set()

    def __getitem__(self, key):
        self.touched.add(key)
        if key not in self.cache:
            row = self.raw.execute(f"SELECT val::json->'parent' FROM {self.schema}.nodes WHERE id=%s",(key,)).fetchone()
            self.cache[key] = None if row is None else {'parent': row[0]}
            if len(self.cache)>1024: self.cache.popitem(last=False)
        value = self.cache[key]
        self.cache.move_to_end(key)
        if value is None: raise KeyError(key)
        if value['parent'] is not None and not isinstance(value['parent'],str):
            raise ValueError('unknown node parent shape')
        return value

    def prefetch(self, ids):
        """Load these nodes and their parent chains in ONE statement instead of
        one read per level. Only rows found are cached; anything else is still
        read one by one on access. Does not mark anything touched."""
        ids=[i for i in ids if isinstance(i,str) and i not in self.cache]
        if not ids: return
        rows=self.raw.execute(
            f"WITH RECURSIVE up(id) AS ("
            f"SELECT id FROM {self.schema}.nodes WHERE id=ANY(%s) "
            f"UNION SELECT n.id FROM up JOIN {self.schema}.nodes c ON c.id=up.id "
            f"JOIN {self.schema}.nodes n ON json_typeof(c.val::json->'parent')='string' "
            f"AND n.id=c.val::json->>'parent') "
            f"SELECT id,val::json->'parent' FROM {self.schema}.nodes WHERE id IN (SELECT id FROM up)",
            (ids,)).fetchall()
        for key,parent in rows:
            if key not in self.cache and len(self.cache)<1024:
                self.cache[key]={'parent':parent}

    def __contains__(self,key):
        try: self[key]; return True
        except KeyError: return False

    def __iter__(self):
        raise TypeError('bounded work policy must not enumerate nodes')

    def __len__(self):
        raise TypeError('bounded work policy must not enumerate nodes')


class _Policy:
    """Reuse predicates verbatim without constructing/migrating a whole Org."""
    WORK_LEGACY_STATUSES = Org.WORK_LEGACY_STATUSES
    WORK_ARCHIVES_ITSELF = Org.WORK_ARCHIVES_ITSELF
    WORK_ARCHIVES_AT_ONCE = Org.WORK_ARCHIVES_AT_ONCE
    WORK_ARCHIVE_AFTER_S = Org.WORK_ARCHIVE_AFTER_S
    WORK_BACKLOG = Org.WORK_BACKLOG
    WORK_UNCOUNTED = Org.WORK_UNCOUNTED
    node = Org.node
    ancestors = Org.ancestors
    is_ancestor = Org.is_ancestor
    _work_actor_node = staticmethod(Org._work_actor_node)
    _work_age_s = staticmethod(Org._work_age_s)
    _work_can_manage = Org._work_can_manage
    _work_can_read = Org._work_can_read
    _work_status = Org._work_status
    _work_attention = Org._work_attention
    _work_eligible = Org._work_eligible
    _work_archived = Org._work_archived
    _work_backlogged = Org._work_backlogged
    _work_counts_active = Org._work_counts_active

    def __init__(self, nodes, questions=None):
        self.nodes = nodes
        self.questions = questions or {}

    def _work_questions(self, slug):
        return self.questions.get(slug, [])


def _expected(policy, item, location):
    """Access set and indexed classification hints; ledger remains the oracle."""
    policy.nodes.touched.clear()
    owner = policy._work_actor_node(item.get('owner'))
    creator = policy._work_actor_node(item.get('created_by'))
    reviewer = policy._work_actor_node(item.get('reviewer'))
    participants = item.get('participants') or []
    if not isinstance(participants,list) or any(not isinstance(x,str) for x in participants):
        raise ValueError('unknown work participants shape; exact compatibility required')
    candidates = {USER, *participants, *(x for x in (owner,creator,reviewer) if x)}
    anchor = owner or creator
    if isinstance(policy.nodes,_Parents):
        policy.nodes.prefetch(sorted(candidates-{USER}))
    if anchor and anchor in policy.nodes:
        candidates.update(policy.ancestors(anchor))
    allowed = {a for a in candidates if policy._work_can_read(a,item)}
    status = policy._work_status(item)
    deadline = None
    if status in policy.WORK_ARCHIVES_AT_ONCE:
        deadline = float('-inf')
    elif status in policy.WORK_ARCHIVES_ITSELF:
        age = policy._work_age_s(item,0)
        if age is not None: deadline = -age + policy.WORK_ARCHIVE_AFTER_S
    return (location,deadline,bool(item.get('manual_attention'))),allowed,set(policy.nodes.touched)


def _questions(raw,schema):
    row = raw.execute(f"SELECT val FROM {schema}.doc WHERE key='asks'").fetchone()
    asks = json.loads(row[0]) if row else []
    source = SimpleNamespace(d={'asks':asks})
    slugs = {q.get('work_item') for a in asks if a.get('status')=='open'
             for q in a.get('questions') or [] if q.get('work_item')}
    return {slug:Org._work_questions(source,slug) for slug in slugs}


def _installed(raw,schema):
    return raw.execute('SELECT to_regclass(%s)',(schema+'.work_read_state',)).fetchone()[0] is not None


def _replace_access(raw,schema,slug,allowed):
    old = {r[0] for r in raw.execute(f'SELECT viewer FROM {schema}.work_read_access WHERE slug=%s',(slug,))}
    for viewer in old-allowed:
        raw.execute(f'DELETE FROM {schema}.work_read_access WHERE slug=%s AND viewer=%s',(slug,viewer))
        changed=raw.execute(f'UPDATE {schema}.work_read_totals SET total=total-1 WHERE viewer=%s AND total>0 RETURNING total',(viewer,)).fetchone()
        if changed is None: raise RuntimeError('docket access counter missing/underflow')
    for viewer in allowed-old:
        raw.execute(f'INSERT INTO {schema}.work_read_access VALUES(%s,%s)',(slug,viewer))
        raw.execute(f'INSERT INTO {schema}.work_read_totals VALUES(%s,1) ON CONFLICT(viewer) DO UPDATE SET total={schema}.work_read_totals.total+1',(viewer,))


def _replace_dependencies(raw,schema,slug,deps):
    """One statement: drop the rows no longer depended on, add the new ones.
    Rows kept are left alone (ON CONFLICT on the (slug,node_id) key)."""
    deps=sorted(deps)
    raw.execute(f'WITH gone AS (DELETE FROM {schema}.work_read_dependency '
                f'WHERE slug=%s AND NOT node_id=ANY(%s)) '
                f'INSERT INTO {schema}.work_read_dependency SELECT %s,unnest(%s::text[]) '
                f'ON CONFLICT DO NOTHING',(slug,deps,slug,deps))


def refresh(raw, org_id: int) -> bool:
    """Keep raw writes compatible when legacy data cannot be projected.

    SQL errors still abort the transaction. A malformed policy input disables
    indexed answers and retains dirty markers; it must not break an otherwise
    supported raw save or manufacture an empty count.
    """
    try:
        probe = _probe(raw,org_id)
        result = _refresh(raw,org_id,probe)
        if result:
            from . import worklistmeta
            # a quiet save (no access work) reuses the probe's list state;
            # after access work the list state is read again in one statement:
            # _refresh then holds the work_read_state row lock, and the probe
            # saw the list table
            quiet = probe is not None and _quiet(probe)
            worklistmeta.refresh(raw,org_id,known_pending=bool(probe[6]) if quiet else None,
                                 locked=probe is not None and not quiet)
        return result
    except (KeyError,ValueError) as exc:
        schema=f'org_{int(org_id)}'
        raw.execute(f'UPDATE {schema}.work_read_state SET ready=false WHERE singleton')
        log.error('Docket access input cannot be projected for org %s (%s); use exact compatibility path',org_id,type(exc).__name__)
        return False


_PROBE_TABLES = ('work_read_state','work_index_state','work_list_state')


def _probe(raw, org_id: int):
    """What every save's refresh decides on, in TWO statements instead of six.

    First whether the three read-model tables exist -- asked on every save,
    never cached, so tables installed while the engine runs are seen by the
    next save -- then the three singleton states in one join:
    (index format, index valid, initialized, questions_dirty, ready,
    access dirty exists, list pending). None when a table or a singleton row
    is missing: the separate checks then decide, exactly as before."""
    schema=f'org_{int(org_id)}'
    names=[f'{schema}.{t}' for t in _PROBE_TABLES]
    if None in raw.execute('SELECT to_regclass(%s),to_regclass(%s),to_regclass(%s)',names).fetchone():
        return None
    return raw.execute(
        f'SELECT i.format,i.valid,s.initialized,s.questions_dirty,s.ready,'
        f'EXISTS(SELECT 1 FROM {schema}.work_read_dirty),'
        f'NOT l.initialized OR EXISTS(SELECT 1 FROM {schema}.work_list_dirty) '
        f'FROM {schema}.work_index_state i,{schema}.work_read_state s,{schema}.work_list_state l '
        f'WHERE i.singleton AND s.singleton AND l.singleton').fetchone()


def _quiet(probe) -> bool:
    """The save left access metadata alone: _refresh returns without writing."""
    return bool(probe[2]) and not probe[3] and not probe[5]


def _refresh(raw, org_id: int, probe=None) -> bool:
    """Called inside the writer's transaction, after raw rows and before commit.

    The SQL marker's state-row lock serializes work/topology/ask writers before
    dependency selection. No commit or connection ownership is taken here.
    External writers that omit this call leave dirty markers: readers fall back.
    """
    schema=f'org_{int(org_id)}'
    if probe is not None:
        if not workindex.ready_row(probe[:2]): return False
        state=probe[2:6]
    else:
        if not _installed(raw,schema) or not workindex.ready(raw,org_id): return False
        state=raw.execute(f'SELECT initialized,questions_dirty,ready,EXISTS(SELECT 1 FROM {schema}.work_read_dirty) FROM {schema}.work_read_state WHERE singleton').fetchone()
    if state is None: return False
    if state[0] and not state[1] and not state[3]:
        return bool(state[2])  # unrelated saves must not write/lock this row
    if raw.execute(f"SELECT 1 FROM {schema}.doc WHERE key IN ('nodes','work_items_archive')").fetchone(): return False
    state=raw.execute(f'SELECT initialized,questions_dirty FROM {schema}.work_read_state WHERE singleton FOR UPDATE').fetchone()
    if state is None: return False
    header=raw.execute(f"SELECT val FROM {schema}.doc WHERE key='work_items'").fetchone()
    ids=[r[0] for r in raw.execute(f"SELECT slug FROM {schema}.work_index WHERE location='active'")]
    expected_header=json.loads(workrows.header(ids))
    actual_header=json.loads(header[0]) if header else expected_header if not ids else None
    if (not isinstance(actual_header,dict) or set(actual_header)!=set(expected_header)
        or actual_header.get('format')!=expected_header['format']
        or sorted(actual_header.get('ids') or [])!=sorted(ids)):
        raw.execute(f'UPDATE {schema}.work_read_state SET ready=false WHERE singleton')
        log.error('Docket header mismatch for org %s; use exact compatibility path',org_id)
        return False
    if state[1]:
        questions=_questions(raw,schema)
        raw.execute(f'DELETE FROM {schema}.work_read_questions')
        for slug,entries in questions.items():
            raw.execute(f'INSERT INTO {schema}.work_read_questions VALUES(%s,%s::jsonb)',(slug,json.dumps(entries)))
    policy=_Policy(_Parents(raw,schema))
    # Cursor streams dirty identities; pending cardinality is the changed work,
    # except the explicit first migration/bootstrap, where it is the raw set.
    dirty=[r[0] for r in raw.execute(f'SELECT slug FROM {schema}.work_read_dirty ORDER BY slug')]
    for slug in dirty:
        row=raw.execute(f'SELECT location,summary FROM {schema}.work_index WHERE slug=%s',(slug,)).fetchone()
        if row:
            values,allowed,deps=_expected(policy,row[1],row[0])
            _replace_access(raw,schema,slug,allowed)
            raw.execute(f'INSERT INTO {schema}.work_read_policy VALUES(%s,%s,%s,%s) ON CONFLICT(slug) DO UPDATE SET location=excluded.location,deadline=excluded.deadline,manual=excluded.manual',(slug,*values))
            _replace_dependencies(raw,schema,slug,deps)
        else:
            _replace_access(raw,schema,slug,set())
            raw.execute(f'DELETE FROM {schema}.work_read_policy WHERE slug=%s',(slug,))
            raw.execute(f'DELETE FROM {schema}.work_read_dependency WHERE slug=%s',(slug,))
    # The processed dirty markers go in the same statement that clears the
    # questions flag. If an item above raised, none of them is cleared.
    raw.execute(f'WITH done AS (DELETE FROM {schema}.work_read_dirty WHERE slug=ANY(%s)) '
                f'UPDATE {schema}.work_read_state SET questions_dirty=false WHERE singleton',(dirty,))
    if not state[0]:
        # Raw-row reconciliation is mandatory before the first usable answer.
        valid=reconcile(raw,org_id)
        raw.execute(f'UPDATE {schema}.work_read_state SET initialized=true WHERE singleton')
        return valid
    return True


def reconcile(raw, org_id: int) -> bool:
    """Explicit migration/test control. Recompute from raw bodies, not index.

    The same state-row fence used by every relevant raw writer prevents a
    concurrent source commit. Do not upgrade to source-table locks after taking
    it: a writer can hold RowExclusive while its AFTER trigger waits on us.
    A mismatch emits ERROR and keeps readiness false; ordinary reads never scan.
    """
    schema=f'org_{int(org_id)}'
    with raw.transaction():
        raw.execute(f'SELECT singleton FROM {schema}.work_read_state WHERE singleton FOR UPDATE')
        return _reconcile_locked(raw,org_id)


def _reconcile_locked(raw,org_id):
    schema=f'org_{int(org_id)}'; policy=_Policy(_Parents(raw,schema)); totals=Counter()
    valid=bool(raw.execute('SELECT public.orgtree_check_work_index(%s)',(org_id,)).fetchone()[0])
    # One streaming join; no per-body network read or whole-history Python list.
    query=f"""WITH source AS (
      SELECT 'active'::text location,val FROM {schema}.doc WHERE starts_with(key,'work_items'||chr(31))
      UNION ALL SELECT 'archive',val FROM {schema}.log_l WHERE sect='work_items_archive')
      SELECT source.location,source.val,p.location,p.deadline,p.manual,
        ARRAY(SELECT viewer FROM {schema}.work_read_access a WHERE a.slug=source.val::json->>'slug' ORDER BY viewer),
        ARRAY(SELECT node_id FROM {schema}.work_read_dependency d WHERE d.slug=source.val::json->>'slug' ORDER BY node_id)
      FROM source LEFT JOIN {schema}.work_read_policy p ON p.slug=source.val::json->>'slug'"""
    count=0; dependency_count=0
    with raw.cursor(name=f'work_access_reconcile_{org_id}') as cursor:
        cursor.execute(query)
        for location,body,stored_location,deadline,manual,access,deps in cursor:
            item=json.loads(body); expected,allowed,parents=_expected(policy,item,location)
            valid &= expected==(stored_location,deadline,manual) and allowed==set(access) and parents==set(deps)
            totals.update(allowed); count+=1; dependency_count+=len(parents)
    actual=dict(raw.execute(f'SELECT viewer,total FROM {schema}.work_read_totals WHERE total<>0').fetchall())
    questions=_questions(raw,schema)
    actual_questions=dict(raw.execute(f'SELECT slug,questions FROM {schema}.work_read_questions').fetchall())
    valid &= actual==dict(totals) and questions==actual_questions
    valid &= raw.execute(f'SELECT count(*) FROM {schema}.work_read_policy').fetchone()[0]==count
    valid &= raw.execute(f'SELECT count(*) FROM {schema}.work_read_access').fetchone()[0]==sum(totals.values())
    valid &= raw.execute(f'SELECT count(*) FROM {schema}.work_read_dependency').fetchone()[0]==dependency_count
    valid &= not raw.execute(f'SELECT 1 FROM {schema}.work_read_dirty LIMIT 1').fetchone()
    raw.execute(f'UPDATE {schema}.work_read_state SET ready=%s WHERE singleton',(bool(valid),))
    if not valid: log.error('Docket access reconciliation mismatch for org %s; use exact compatibility path',org_id)
    return bool(valid)


def bootstrap(raw) -> None:
    """One-time post-migration build; future startups skip initialized schemas."""
    for (org_id,) in raw.execute('SELECT org_id FROM public.orgs WHERE deleted_at IS NULL').fetchall():
        schema=f'org_{int(org_id)}'
        if not _installed(raw,schema): continue
        state=raw.execute(f'SELECT initialized,questions_dirty,EXISTS(SELECT 1 FROM {schema}.work_read_dirty) FROM {schema}.work_read_state WHERE singleton').fetchone()
        from . import worklistmeta
        if state[0] and not state[1] and not state[2] and not worklistmeta.pending(raw,org_id): continue
        with raw.transaction():
            raw.execute(f'SELECT singleton FROM {schema}.work_read_state WHERE singleton FOR UPDATE')
            refresh(raw,org_id)


#: COUNTS CACHE (N1000 engprof run 2, 2026-09-28: counts_raw was 28% of
#: foreground-tree/children, the largest engine-CPU route). A clean answer
#: depends only on the derived work_read_* rows, work_index and the clock.
#: Every write that can change those rows fires orgtree_work_access_dirty,
#: which bumps work_read_state.revision in the writer's transaction; a
#: refresh that only settles dirty markers changes no clean answer, because
#: dirty states are never cached. The key also names the database and the
#: server's start, so an org id reused by another database or cluster never
#: meets an old entry. The clock only
#: moves an item when it passes its policy deadline (`_work_eligible`:
#: strictly older than the hour), so an entry serves while
#: computed_at <= now < next deadline - _DEADLINE_MARGIN_S. Only clean
#: answers (ready, not dirty) are stored; a None is never cached.
_COUNTS_MAX = 4096
_DEADLINE_MARGIN_S = 1.0
_counts_cache: OrderedDict = OrderedDict()
_counts_lock = threading.Lock()


def _counts_get(key, stamp, now_ts):
    with _counts_lock:
        hit = _counts_cache.get(key)
        if hit is None or hit[0] != stamp or not (hit[1] <= now_ts < hit[2]):
            return None
        _counts_cache.move_to_end(key)
        return dict(hit[3])


def _counts_put(key, stamp, now_ts, until, result):
    with _counts_lock:
        _counts_cache[key] = (stamp, now_ts, until, dict(result))
        _counts_cache.move_to_end(key)
        while len(_counts_cache) > _COUNTS_MAX:
            _counts_cache.popitem(last=False)


def counts_raw(raw, org_id: int, *, viewer: str, now_ts: float) -> dict[str,int] | None:
    """Exact viewer counts in caller's existing repeatable-read snapshot.

    None is explicit whole-context fallback; never unfiltered totals or zeros.
    The physical index counts are deliberately not the viewer's toolbar counts.
    Clean answers are reused for the same docket revision (see _counts_cache).
    """
    schema=f'org_{int(org_id)}'
    if not _installed(raw,schema) or not workindex.ready(raw,org_id): return None
    state=raw.execute(f"SELECT ready AND initialized AND NOT questions_dirty AND format='orgtree.work-access/v1' AND NOT EXISTS(SELECT 1 FROM {schema}.work_read_dirty LIMIT 1), revision, current_database(), pg_postmaster_start_time()::text FROM {schema}.work_read_state WHERE singleton").fetchone()
    if not state or not state[0]: return None
    key=(state[2],state[3],int(org_id),viewer)
    stamp=int(state[1])
    cached=_counts_get(key,stamp,now_ts)
    if cached is not None: return cached
    result=_counts_compute(raw,org_id,schema,viewer,now_ts)
    if result is not None:
        nxt=raw.execute(f"SELECT min(deadline) FROM {schema}.work_read_policy WHERE location='active' AND deadline >= %s",(now_ts,)).fetchone()[0]
        until=float('inf') if nxt is None else float(nxt)-_DEADLINE_MARGIN_S
        if until>now_ts: _counts_put(key,stamp,now_ts,until,result)
    return result


def _counts_compute(raw, org_id, schema, viewer, now_ts):
    total=raw.execute(f'SELECT total FROM {schema}.work_read_totals WHERE viewer=%s',(viewer,)).fetchone()
    total=int(total[0]) if total else 0
    candidates=f"""WITH candidates AS (
      SELECT slug FROM {schema}.work_read_policy WHERE location='active' AND deadline IS NULL
      UNION SELECT slug FROM {schema}.work_read_policy WHERE location='active' AND deadline >= %s
      UNION SELECT slug FROM {schema}.work_read_policy WHERE manual
      UNION SELECT slug FROM {schema}.work_read_questions)
      SELECT i.summary,i.location,q.questions FROM candidates c
      JOIN {schema}.work_read_access a ON a.slug=c.slug AND a.viewer=%s
      JOIN {schema}.work_index i ON i.slug=c.slug
      LEFT JOIN {schema}.work_read_questions q ON q.slug=c.slug"""
    result={'active':0,'attention':0,'archived':0,'backlogged':0}; foreground=0
    policy=_Policy(None)
    for item,location,questions in raw.execute(candidates,(now_ts,viewer)):
        policy.questions={item['slug']:questions or []}
        if policy._work_attention(item): result['attention']+=1
        if not policy._work_archived(item,location=='archive',now_ts):
            foreground+=1
            if policy._work_backlogged(item): result['backlogged']+=1
            elif policy._work_counts_active(item): result['active']+=1
    if foreground>total:
        log.error('Docket count mismatch for org %s; foreground exceeds readable total',org_id)
        return None
    result['archived']=total-foreground
    return result
