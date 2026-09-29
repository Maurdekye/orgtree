"""Bounded operator attention projection across organizations; no providers."""
import hashlib
import json
import os
import sys
import threading
from . import pgfeed, store, tree_changes
from .ledger import LedgerError

#: ORGTREE_NOTICES_RUNTIME_VIEW (ON by default; 0/false/off/no turns it off):
#: on PostgreSQL each org is read through a runtime view (on-demand rows) and
#: frozen agents through one query, instead of a whole load of every org on
#: every poll (the desk polls this every 5 s; N1000 item
#: desk-chat-read-and-other-request-paths-still-loa).
_RUNTIME_VIEWS = store._switch_on(os.environ.get("ORGTREE_NOTICES_RUNTIME_VIEW"))
#: ORGTREE_NOTICES_CACHE (ON by default; 0/false/off/no turns it off), with the
#: runtime views: an org's notices are kept with the change-journal position
#: they were built at, and a poll rebuilds only the part whose inputs the
#: journal cannot prove untouched. At N1000 a poll read ~367 KB to answer 73
#: bytes (N1000 read shortcuts). A commit this process did not make is caught
#: exactly as the org tree catches it (committed revision vs. the feed), and
#: any doubt -- unknown, pruned or structural journal rows -- rebuilds.
_CACHE_ON = store._switch_on(os.environ.get("ORGTREE_NOTICES_CACHE"))
#: Doc keys the ATTENTION part reads (besides the node rows of open asks).
_DOC_KEYS = frozenset({'asks', 'user_inbox', 'work_items', 'documents',
                       'slug', 'name', 'created'})
_cache_lock = threading.Lock()
#: (root, slug) -> {'rev', 'seq', 'attention', 'ask_nodes', 'frozen'}
_cache = {}


def _orgs():
    if _RUNTIME_VIEWS and store.STORE_BACKEND == "postgres":
        for slug in store.org_slugs():
            try:
                org = store.load_runtime_org(slug)
            except LedgerError:
                continue          # deleted between the listing and the read
            except Exception as e:                           # noqa: BLE001
                # one unreadable org must not blank every org's notices
                store._log(f"notifications: {slug!r} skipped: {type(e).__name__}: {e}")
                continue
            yield org
        return
    for _, org in store.list_orgs_with_docs():
        yield org

# Terminal outcomes are actionable even when they were not authored as urgent
# mail.  Keep this classification structural: changing the rendered prose
# must not turn a failure into an FYI.
_TERMINAL_VARIANTS = frozenset({
    'runtime.turn_failed_terminal',
    'runtime.background_task_stopped',
    'runtime.subagent_died',
})


def _terminal_failure(mail):
    event = mail.get('ev') if isinstance(mail, dict) else None
    if not isinstance(event, dict):
        return False
    if event.get('variant') in _TERMINAL_VARIANTS:
        return True
    # A stalled report carries the terminal/repeated distinction as data; a
    # terminal stall is actionable even when the sender did not set urgent.
    return (event.get('variant') == 'runtime.report_stalled'
            and event.get('cause') == 'terminal')


def _adder(rows, slug, created):
    def add(key, kind, title, body, agent=None, item=None, source_id=None, generation=None):
        identity = f"{slug}:{created}:{key}"
        rows.append({'id':hashlib.sha256(identity.encode()).hexdigest(), 'org':slug,
                     'kind':kind, 'title':str(title)[:200], 'body':str(body or '')[:500],
                     **({'source_id':str(source_id)} if source_id is not None else {}),
                     **({'generation':generation} if generation is not None else {}),
                     **({'agent':str(agent)} if agent else {}), **({'item':str(item)} if item else {})})
    return add


def _attention(org):
    """Questions, mail, work attention and documents: rows and the node ids
    of open asks (whose node state decides whether the ask shows)."""
    rows, ask_nodes = [], set()
    add = _adder(rows, org.d['slug'], org.d.get('created'))
    for ask in org.d.get('asks') or []:
        if ask.get('status') != 'open':
            continue          # (no node row fetched for a closed ask)
        ask_nodes.add(str(ask.get('node')))
        node = (org.d.get('nodes') or {}).get(ask.get('node'))
        if node and node.get('state') == 'live':
            add('ask:'+str(ask.get('id')), 'question', 'Question from '+str(ask.get('node')),
                ask.get('question') or next((q.get('question') for q in ask.get('questions',[]) if q.get('question')), 'A question needs your answer.'), ask.get('node'), source_id=ask.get('id'))
    for mail in org.d.get('user_inbox') or []:
        kind = ('terminal-failure' if _terminal_failure(mail) else
                'urgent-mail' if mail.get('urgent') else 'routine')
        add('mail:'+str(mail.get('id')), kind,
            'Message from '+str(mail.get('from') or org.d.get('name')),
            (mail.get('urgent_reason') if mail.get('urgent') else None) or mail.get('body') or mail.get('text') or 'Open the message in Orgtree.',
            mail.get('from'), source_id=mail.get('id'))
    for item in org.d.get('work_items') or []:
        attention = item.get('manual_attention')
        # An open attached question already has its own question notice.
        # Keep the ticket-level notice for independent/manual attention,
        # including when both causes are present.
        if attention:
            owner = item.get('owner') or {}
            epoch = item.get('notification_attention_epoch', (attention or {}).get('set_rev') or 1)
            add('work:'+str(item.get('slug'))+':'+str(epoch),
                'work-attention',item.get('title'),(attention or {}).get('reason') or 'An attached question needs your answer.',owner.get('node'),item.get('slug'))
    for doc in org.d.get('documents') or []:
        add('document:'+str(doc.get('id')), 'document', doc.get('title') or 'New presented document',
            'Presented by '+str(doc.get('node')), doc.get('node'), source_id=doc.get('id'))
    return rows, ask_nodes


def _frozen(org):
    return _frozen_rows(org.d['slug'], org.d.get('created'), store.frozen_live_nodes(org))


def _frozen_rows(slug, created, nodes):
    rows = []
    add = _adder(rows, slug, created)
    for nid, node in nodes:
        frozen = node.get('frozen')
        if node.get('state') == 'live' and frozen:
            generation = int(node.get('generation') or 0)
            add(f"frozen:{nid}:{generation}:{frozen.get('at')}", 'agent-frozen',
                'Agent frozen: '+nid, 'Open the agent to see its current state.', nid, generation=generation)
    return rows


#: store.frozen_live_nodes' own candidate filter, qualified for a raw read
_FROZEN_CANDIDATES = (
    "SELECT id, val FROM {s}.nodes WHERE strpos(val, %s) > 0 "
    "AND jsonb_typeof((val::jsonb)->'frozen') IS NOT NULL "
    "AND jsonb_typeof((val::jsonb)->'frozen') <> 'null' "
    "AND coalesce((val::jsonb)->>'state', 'live') = 'live' ORDER BY ord")


def _raw(slug, fn):
    """fn(raw, schema) on an autocommit pool connection (each statement its own
    snapshot); None when the org is gone. Reads only: no transaction opened."""
    slug = store._safe_slug(slug)
    store._ensure_migrated(slug)
    if not os.path.exists(store._db_path(slug)):
        return None
    with store._POOL.acquire(slug) as conn:
        if conn.in_transaction:
            raise RuntimeError('notifications cannot reuse a writer transaction')
        conn.use()
        return fn(conn.raw, f'org_{int(conn.org_id)}', int(conn.org_id))


def _probe(slug):
    """(committed revision, heal-clean) in ONE statement. Heal-clean = the org's
    heal epoch stamp is this code's: a node row decoded now needs no heal, so
    plain JSON of a row is what an on-demand load would decode."""
    def read(raw, s, org_id):
        row = raw.execute(f"SELECT o.revision, (SELECT val FROM {s}.meta WHERE key=%s) "
                          f"FROM public.orgs o WHERE o.org_id=%s",
                          (store._META_HEAL_EPOCH, org_id)).fetchone()
        return None if row is None else (int(row[0]), row[1] is not None and row[1] == store.heal_epoch())
    return _raw(slug, read)


def _frozen_direct(slug, created):
    """The frozen part in ONE statement, without loading the org: the few
    candidate rows are decoded as an on-demand load would (heal-clean only)."""
    rows = _raw(slug, lambda raw, s, _id: raw.execute(
        _FROZEN_CANDIDATES.format(s=s), ('"frozen"',)).fetchall())
    if rows is None:
        return None
    return _frozen_rows(slug, created, [(str(i), json.loads(v)) for i, v in rows])


def _cached_org_rows(slug):
    """This org's rows, rebuilding only what the journal cannot prove
    unchanged since the cached build; None when the org cannot be read."""
    key = (str(store.DATA_ROOT), slug)
    with _cache_lock:
        entry = _cache.get(key)
    try:
        probe = _probe(slug)
    except LedgerError:
        return None
    if probe is None:
        return None
    committed, heal_clean = probe
    if entry is not None:
        api = sys.modules.get(__package__ + '.api')
        if not pgfeed.snapshot_changes_published(getattr(api, '_REV_FEED', None), slug,
                                                 entry['rev'], committed):
            # newer than the delivered feed/local evidence: unknown, so the
            # journal below refuses to vouch for this range (as the tree does)
            store.external_change(slug)
    # read BEFORE building: a commit after this point moves it again, so the
    # next poll rebuilds rather than trusting rows older than their stamp
    seq = store.org_seq(slug)
    attention = frozen = None
    created = entry['created'] if entry is not None else None
    if entry is not None:
        detail = tree_changes.since_detail(store.DATA_ROOT, slug, entry['seq'], seq)
        if detail is not None and not detail['structural'] and not detail['blob_nodes']:
            if not (detail['keys'] & _DOC_KEYS or detail['nodes'] & entry['ask_nodes']):
                attention = entry['attention'], entry['ask_nodes']
            if not detail['nodes']:
                frozen = entry['frozen']
    if attention is not None and frozen is None and heal_clean:
        # only agents' rows moved (the usual case under load): the frozen
        # part alone, in one statement, no org load
        frozen = _frozen_direct(slug, created)
        if frozen is None:
            return None
    if attention is None or frozen is None:
        try:
            org = store.load_runtime_org(slug)
        except LedgerError:
            return None
        created = org.d.get('created')
        if attention is None:
            attention = _attention(org)
        if frozen is None:
            frozen = _frozen(org)
    with _cache_lock:
        _cache[key] = {'rev': committed, 'seq': seq, 'attention': attention[0],
                       'ask_nodes': attention[1], 'frozen': frozen, 'created': created}
    return attention[0] + frozen


def _all_rows():
    if not (_CACHE_ON and _RUNTIME_VIEWS and store.STORE_BACKEND == "postgres"):
        rows = []
        for org in _orgs():
            rows += _attention(org)[0] + _frozen(org)
        return rows
    rows, listed = [], set()
    for slug in store.org_slugs():
        listed.add((str(store.DATA_ROOT), slug))
        try:
            found = _cached_org_rows(slug)
        except Exception as e:                               # noqa: BLE001
            # one unreadable org must not blank every org's notices
            store._log(f"notifications: {slug!r} skipped: {type(e).__name__}: {e}")
            found = None
        if found is None:
            with _cache_lock:
                _cache.pop((str(store.DATA_ROOT), slug), None)
            continue
        rows += found
    with _cache_lock:
        for key in [k for k in _cache if k[0] == str(store.DATA_ROOT) and k not in listed]:
            del _cache[key]           # deleted or renamed orgs
    return rows


def notices(limit=200, offset=0):
    rows = _all_rows()
    priority = {'question':0,'terminal-failure':1,'urgent-mail':2,
                'work-attention':3,'routine':4,'document':5,'agent-frozen':6}
    rows.sort(key=lambda row:(priority[row['kind']],row['org'],row['id']))
    offset = max(0, offset)
    end = offset + max(1, limit)
    return {'notices':rows[offset:end], 'total':len(rows), 'truncated':len(rows)>end,
            'next_offset':end if len(rows)>end else None,
            # The full, small identity list permits cleanup even when a resolved
            # alert was on a different page. Content stays paged and bounded.
            'active':[{'org':r['org'], 'id':r['id']} for r in rows]}
