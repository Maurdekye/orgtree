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


def refresh(raw, org_id: int) -> bool:
    """Keep raw writes compatible when legacy data cannot be projected.

    SQL errors still abort the transaction. A malformed policy input disables
    indexed answers and retains dirty markers; it must not break an otherwise
    supported raw save or manufacture an empty count.
    """
    try:
        return _refresh(raw,org_id)
    except (KeyError,ValueError) as exc:
        schema=f'org_{int(org_id)}'
        raw.execute(f'UPDATE {schema}.work_read_state SET ready=false WHERE singleton')
        log.error('Docket access input cannot be projected for org %s (%s); use exact compatibility path',org_id,type(exc).__name__)
        return False


def _refresh(raw, org_id: int) -> bool:
    """Called inside the writer's transaction, after raw rows and before commit.

    The SQL marker's state-row lock serializes work/topology/ask writers before
    dependency selection. No commit or connection ownership is taken here.
    External writers that omit this call leave dirty markers: readers fall back.
    """
    schema=f'org_{int(org_id)}'
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
            raw.execute(f'DELETE FROM {schema}.work_read_dependency WHERE slug=%s',(slug,))
            for node in deps:
                raw.execute(f'INSERT INTO {schema}.work_read_dependency VALUES(%s,%s)',(slug,node))
        else:
            _replace_access(raw,schema,slug,set())
            raw.execute(f'DELETE FROM {schema}.work_read_policy WHERE slug=%s',(slug,))
            raw.execute(f'DELETE FROM {schema}.work_read_dependency WHERE slug=%s',(slug,))
        raw.execute(f'DELETE FROM {schema}.work_read_dirty WHERE slug=%s',(slug,))
    raw.execute(f'UPDATE {schema}.work_read_state SET questions_dirty=false WHERE singleton')
    if not state[0]:
        # Raw-row reconciliation is mandatory before the first usable answer.
        valid=reconcile(raw,org_id)
        raw.execute(f'UPDATE {schema}.work_read_state SET initialized=true WHERE singleton')
        return valid
    return True


def reconcile(raw, org_id: int) -> bool:
    """Explicit migration/test control. Recompute from raw bodies, not index.

    Nested callers retain source-table locks until their transaction ends. A mismatch emits
    ERROR and keeps readiness false; no read performs this full-history scan.
    """
    schema=f'org_{int(org_id)}'
    with raw.transaction():
        raw.execute(f'LOCK TABLE {schema}.doc,{schema}.nodes,{schema}.log_l IN SHARE MODE')
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
        if state[0] and not state[1] and not state[2]: continue
        with raw.transaction():
            raw.execute(f'LOCK TABLE {schema}.doc,{schema}.nodes,{schema}.log_l IN SHARE MODE')
            refresh(raw,org_id)


def counts_raw(raw, org_id: int, *, viewer: str, now_ts: float) -> dict[str,int] | None:
    """Exact viewer counts in caller's existing repeatable-read snapshot.

    None is explicit whole-context fallback; never unfiltered totals or zeros.
    The physical index counts are deliberately not the viewer's toolbar counts.
    """
    schema=f'org_{int(org_id)}'
    if not _installed(raw,schema) or not workindex.ready(raw,org_id): return None
    state=raw.execute(f"SELECT ready AND initialized AND NOT questions_dirty AND format='orgtree.work-access/v1' AND NOT EXISTS(SELECT 1 FROM {schema}.work_read_dirty LIMIT 1) FROM {schema}.work_read_state WHERE singleton").fetchone()
    if not state or not state[0]: return None
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
