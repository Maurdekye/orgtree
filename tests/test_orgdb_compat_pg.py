"""The compatibility view on org databases (orgdb/compat, design §6.2 item 3).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. The legacy database t<pid>_legacy and every new
                               database (prefix t<pid>_) are created and dropped by this module.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

The storage switch (ORGTREE_STORAGE) is flipped inside this process: off, store.py runs on the
legacy database exactly as today; on, it runs on the org databases through the view. Each
"twin" is a legacy org and its copy converted into its own database the way the converter
converts (encode_document, COPY, read-back, publish), under another name.

What it proves:
  * reads: the converted copy loads through the view as exactly the document the legacy store
    loads (canonical JSON, the slug aside): a whole load, an org_tx's on-demand load, a cached
    snapshot;
  * writes: the same edits through both stores leave both with the same document, after every
    edit: settings keys (a value, a null), whole sections, nodes (update, insert, delete),
    split owner rows (a new owner, a dropped one), dict logs (append, edit in place, a dropped
    owner), list logs (append, edit), the keyed steering log, the docket (new item, edit,
    archive, reopen, also archive then reopen in one org_tx each), a key outside the registry
    (set, removed), a deferred key; one slug active and archived at commit is refused (the
    org database's one row per slug);
  * create: create_org with the switch on publishes an active org whose database loads as
    the created document; a create whose first save fails, or whose staging database cannot
    be built (review f23), leaves no registry row and no database, and the same name can be
    created at once;
  * compare-and-set: a save of a node another save changed since it loaded refuses
    (StaleWrite) and writes nothing;
  * insert races (review f21): two transactions insert the same absent doc key, or the same
    new node; the second waits for the first and gets the legacy outcome on both stores
    (DO NOTHING inserts nothing; the node insert is refused with IntegrityError), and the
    first writer's value stays. Mixed writers of an absent key of every kind (outside the
    registry, settings, split owner, docket item): an insert then an upsert ends with the
    upsert's value, an upsert then an insert keeps the upsert's, both rowcounts as legacy;
    an upsert started while an insert is paused between its absent check and its write
    waits for it (review f21's measured interleaving);
    two upserts of a section (absent, then present) leave the second value whole, never the
    two merged; an upsert outside an org_tx that locked the section waits without deadlock;
    two transactions writing settings keys queue on one fence;
  * revision: a changing save bumps the org's revision by exactly one, a no-change save not;
  * org_tx: a named write commits through the view; an unlocked write refuses and lands
    nothing; an org's row locks are its org lock and ONE DO block, in the lock plan's order;
    over two orgs, a write refused in the later org leaves the earlier one unwritten too;
  * receipts: an operation receipt made before the conversion replays after it (the work is
    not done twice), another fingerprint conflicts, a new key is recorded in tx_receipts;
  * feed: one revision feed LISTENs on every org's own database: saves arrive as
    notifications, an org created later is picked up by the next poll, a commit whose NOTIFY
    never came is found as a gap, and a failed session costs only its own org.

Run:  python tools/run-python-verification.py --timeout 1200 tests/test_orgdb_compat_pg.py
"""

import contextlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
LEGACY = f'{PREFIX}legacy'

_temp = tempfile.TemporaryDirectory(prefix='v3-orgdb-compat-', ignore_cleanup_errors=True)
DATA = Path(_temp.name) / 'data'
DATA.mkdir()
HOME = Path(_temp.name) / 'home'
HOME.mkdir()


def _with_db(url: str, db: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, '/' + db, p.query, p.fragment))


if ADMIN and RUNTIME:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as _c:
        _c.execute(f'DROP DATABASE IF EXISTS {LEGACY} WITH (FORCE)')
        _c.execute(f'CREATE DATABASE {LEGACY}')
    os.environ['ORGTREE_PG_URL'] = _with_db(RUNTIME, LEGACY)
    os.environ['ORGTREE_PG_ADMIN_CONNINFO'] = ADMIN
os.environ.update(ORGTREE_DATA=str(DATA), HOME=str(HOME), USERPROFILE=str(HOME),
                  ORGTREE_STORE='postgres', ORGTREE_ORGDB_PREFIX=PREFIX)
os.environ.pop('ORGTREE_STORAGE', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import orgtx, pgstore, store  # noqa: E402
from orgtree.orgdb import conn as dbconn, lifecycle, mappers, names, sections  # noqa: E402
from orgtree.orgdb import registry  # noqa: E402
from orgtree.orgdb.compat import sql  # noqa: E402
from orgtree.orgdb.convert import legacy, rowio, run  # noqa: E402

orgtx.TRANSITION_FENCE = False      # row-lock behaviour is what is under test
needs_pg = unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and '
                                                  'ORGTREE_TEST_PG_RUNTIME_URL: NOT RUN')
LC: list[lifecycle.Lifecycle] = []
AT = '2026-10-01T10:00:00.000Z'


def setUpModule() -> None:
    if not (ADMIN and RUNTIME):
        return
    pgstore.migrate(_with_db(ADMIN, LEGACY))
    with psycopg.connect(_with_db(ADMIN, LEGACY), autocommit=True) as c:
        c.execute(f'GRANT CONNECT, TEMP ON DATABASE {LEGACY} TO orgtree_runtime')
    lc = lifecycle.Lifecycle(ADMIN, prefix=PREFIX, build='test')
    lc.bootstrap()
    registry.use_lifecycle(lc)
    LC.append(lc)


def tearDownModule() -> None:
    if not (ADMIN and RUNTIME):
        return
    registry.close_idle()
    registry.close_registry()
    pgstore.close_idle()
    from psycopg import sql
    with dbconn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


@contextlib.contextmanager
def storage(on: bool):
    """The storage switch, flipped for this process (the org_tx backend follows it)."""
    old = os.environ.get('ORGTREE_STORAGE')
    if on:
        os.environ['ORGTREE_STORAGE'] = 'orgdb'
    else:
        os.environ.pop('ORGTREE_STORAGE', None)
    orgtx.use_backend(None)
    try:
        yield
    finally:
        if old is None:
            os.environ.pop('ORGTREE_STORAGE', None)
        else:
            os.environ['ORGTREE_STORAGE'] = old
        orgtx.use_backend(None)


def document(slug: str) -> dict:
    """The whole document today's loader gives (every lazy section materialised)."""
    return json.loads(json.dumps(store.load_org(slug).d))


def same_but_slug(a: dict, b: dict) -> list:
    a = {k: v for k, v in a.items() if k != 'slug'}
    b = {k: v for k, v in b.items() if k != 'slug'}
    return run.differences(a, b) if run.canon(a) != run.canon(b) else []


def node(nid: str, parent: str | None) -> dict:
    return {'name': nid, 'parent': parent, 'state': 'live', 'title': nid.upper(),
            'model': 'opus', 'generation': 0, 'seat_id': f'seat-{nid}', 'grant': 10,
            'created': AT, 'scope': {'permission_mode': 'acceptEdits', 'effort': 'high'},
            'cost_usd': 0.25, 'frozen': None}


def item(slug: str, title: str) -> dict:
    return {'slug': slug, 'title': title, 'kind': 'code', 'status': 'open', 'rev': 1,
            'objective': f'{title}: the problem, then the fix.', 'at': AT, 'updated_at': AT,
            'owner': {'node': 'dev', 'generation': 0, 'born': 'b-dev'},
            'participants': ['ops'], 'done_so_far': [], 'working_on_next': ['start'],
            'history': [{'at': AT, 'op': 'create', 'by': {'node': 'boss', 'generation': 0}}],
            'notification_attention_active': False, 'notification_attention_epoch': 0}


def populate(slug: str) -> None:
    """Content of every storage kind, written by today's store."""
    org = store.load_org(slug)
    d = org.d
    for nid, parent in (('boss', None), ('dev', 'boss'), ('ops', 'boss')):
        d['nodes'][nid] = node(nid, parent)
    d['asks'] = [{'id': 'q1', 'node': 'dev', 'question': 'why?', 'at': AT, 'status': 'open'}]
    d['mail'] = {'dev': [{'id': 'm1', 'from': 'boss', 'body': 'hi', 'at': AT}]}
    d['mail_log'] = {'dev': [{'id': 'm0', 'from': 'boss', 'body': 'old', 'at': AT},
                             {'id': 'm00', 'from': 'ops', 'body': 'older', 'at': AT}]}
    store.log_append(d, 'events', {'op': 'hire', 'actor': 'boss', 'at': AT,
                                   'detail': {'node': 'dev'}})
    d['work_items'] = [item('fix-the-thing', 'Fix'), item('second-item', 'Second')]
    d['watchdogs'] = [{'id': 'w1', 'owner': 'dev', 'name': 'build', 'kind': 'file',
                       'target': 'x.log', 'state': 'armed', 'at': AT}]
    d['steer_attempts'] = {'dev': {'a1': {'at': AT, 'tool_use_id': 't1', 'toks': ['k']}}}
    d['custom_key'] = {'x': 1}
    store.save_org(org)


EDITS = [
    ('settings value', lambda d: d.__setitem__('max_children', 9)),
    ('settings null', lambda d: d.__setitem__('fable_lock', None)),
    ('whole section', lambda d: d['asks'].append(
        {'id': 'q2', 'node': 'ops', 'question': 'how?', 'at': AT, 'status': 'open'})),
    ('node update', lambda d: d['nodes']['dev'].__setitem__('title', 'Developer')),
    ('node insert', lambda d: d['nodes'].__setitem__('qa', node('qa', 'dev'))),
    ('node delete', lambda d: d['nodes'].pop('ops')),
    ('split owner new', lambda d: d['mail'].__setitem__(
        'qa', [{'id': 'm2', 'from': 'dev', 'body': 'test it', 'at': AT}])),
    ('split owner dropped', lambda d: d['mail'].pop('dev')),
    ('dict log append', lambda d: d['mail_log'].setdefault('boss', []).append(
        {'id': 'm3', 'from': 'dev', 'body': 'done', 'at': AT})),
    ('dict log edit', lambda d: d['mail_log']['dev'][0].__setitem__('stale', True)),
    ('dict log owner dropped', lambda d: d['mail_log'].pop('dev')),
    ('list log append', lambda d: store.log_append(
        d, 'events', {'op': 'retire', 'actor': 'boss', 'at': AT, 'detail': {'node': 'ops'}})),
    ('list log edit', lambda d: d['events'][0].__setitem__('op', 'hired')),
    ('keyed log', lambda d: d['steer_attempts']['dev'].__setitem__(
        'a2', {'at': AT, 'tool_use_id': 't2', 'retried': True})),
    ('docket new', lambda d: d['work_items'].append(item('third-item', 'Third'))),
    ('docket edit', lambda d: d['work_items'][0].__setitem__('status', 'in_progress')),
    ('docket archive', lambda d: d.setdefault('work_items_archive', []).append(
        d['work_items'].pop(1))),
    ('docket reopen', lambda d: d['work_items'].append(d['work_items_archive'].pop())),
    ('extra key set', lambda d: d.__setitem__('custom_key', {'x': 2, 'y': [1, 2.5]})),
    ('extra key removed', lambda d: d.pop('custom_key')),
    ('deferred key', lambda d: d['watchdogs'][0].__setitem__('state', 'paused')),
]


class Twins:
    """A legacy org and its converted copy."""
    n = 0

    def __init__(self, name: str, before=None) -> None:
        Twins.n += 1
        with storage(False):
            org = store.create_org(f'{name} {Twins.n}')
            self.legacy = org.d['slug']
            populate(self.legacy)
            if before is not None:
                before(self.legacy)
            doc = document(self.legacy)
            oid = pgstore.read_marker(str(DATA / 'orgs' / f'{self.legacy}.pg'))
            with pgstore.connect() as c:
                receipts = legacy.receipts(c, oid)
                # the converter's numbering of the archive: legacy's row order (log_d.seq)
                order, how = run.usable_row_order(doc, legacy.row_order(c, oid))
        assert how == {'mail_log': 'legacy row order'}, how
        self.copy = f'{self.legacy}-c'
        doc['slug'] = self.copy
        secs = mappers.sections()
        rows, _, _ = sections.encode_document(doc, secs, ignored=mappers.ignored_keys(),
                                              row_order=order)
        lc = LC[0]
        org_id = lc.register_org(self.copy, state='converting')
        build = lc.open_build(org_id, 'convert')
        with dbconn.connect(RUNTIME, build.database, autocommit=False) as c:
            rowio.write(c, rows, order=rowio.tables(secs))
            rowio.write_receipts(c, receipts)
            c.commit()
        lc.mark_filled(build)
        lc.publish(build)

    def compare(self, test: unittest.TestCase, what: str) -> None:
        with storage(False):
            want = document(self.legacy)
        with storage(True):
            got = document(self.copy)
        test.assertEqual(same_but_slug(want, got), [], what)

    def edit(self, fn) -> None:
        for on, slug in ((False, self.legacy), (True, self.copy)):
            with storage(on):
                org = store.load_org(slug)
                fn(org.d)
                store.save_org(org)


@needs_pg
class Reads(unittest.TestCase):
    def test_converted_copy_loads_as_the_legacy_org(self) -> None:
        t = Twins('reads')
        t.compare(self, 'whole load')
        with storage(True):
            with orgtx.org_tx(t.copy, nodes=['dev']) as tx:
                self.assertEqual(tx.d['nodes']['dev']['title'], 'DEV')
                self.assertEqual([m['id'] for m in tx.d['mail_log']['dev']], ['m0', 'm00'])
                self.assertEqual([w['slug'] for w in tx.d['work_items']],
                                 ['fix-the-thing', 'second-item'])
            snap = store.cached_org(t.copy)
            self.assertEqual(sorted(snap.d['nodes']), ['boss', 'dev', 'ops'])


@needs_pg
class Writes(unittest.TestCase):
    def test_same_edits_same_documents(self) -> None:
        t = Twins('writes')
        for what, fn in EDITS:
            with self.subTest(what):
                t.edit(fn)
                t.compare(self, what)

    def test_org_tx_named_write_and_unlocked_write(self) -> None:
        t = Twins('orgtx')
        with storage(True):
            with orgtx.org_tx(t.copy, nodes=['dev']) as tx:
                tx.d['nodes']['dev']['title'] = 'Locked write'
            self.assertEqual(store.load_org(t.copy).d['nodes']['dev']['title'], 'Locked write')
            with self.assertRaises(orgtx.UnlockedWrite):
                with orgtx.org_tx(t.copy, nodes=['dev']) as tx:
                    tx.d['nodes']['ops']['title'] = 'not locked'
            self.assertEqual(store.load_org(t.copy).d['nodes']['ops']['title'], 'OPS')

    def test_unread_items_removed_and_replaced_in_one_org_tx(self) -> None:
        # the docket's order lives in the item rows: removing one unread item must not move
        # another unread item's version, which the same save still compares
        t = Twins('unread items')
        with storage(False):
            org = store.load_org(t.legacy)
            org.d['work_items'].append(item('third-item', 'Third'))
            store.save_org(org)
        with storage(True):
            org = store.load_org(t.copy)
            org.d['work_items'].append(item('third-item', 'Third'))
            store.save_org(org)
        for on, slug in ((False, t.legacy), (True, t.copy)):
            with storage(on):
                with orgtx.org_tx(slug, sections=['work_items', 'asks']) as tx:
                    tx.d['work_items'].pop(1)
                    tx.d['work_items'][0] = dict(item('fix-the-thing', 'Fixed'), rev=11)
                with orgtx.org_tx(slug, sections=['work_items']) as tx:
                    tx.d['work_items'].append(item('fourth-item', 'Fourth'))
        t.compare(self, 'unread items removed, replaced, appended')
        with storage(True):
            self.assertEqual([w['slug'] for w in store.load_org(t.copy).d['work_items']],
                             ['fix-the-thing', 'third-item', 'fourth-item'])

    def test_an_item_archived_then_reopened_in_one_org_tx_each(self) -> None:
        # the reopen's save writes the active row before it deletes the archived one (found
        # by upgrade-sol: it failed on the slug's unique key until that is checked at commit)
        t = Twins('reopen')
        docket = dict(sections=['work_items'], logs=['work_items_archive'])
        for on, slug in ((False, t.legacy), (True, t.copy)):
            with storage(on):
                with orgtx.org_tx(slug, **docket) as tx:
                    it = tx.d['work_items'].pop(1)
                    it['archived_at'] = AT
                    store.log_append(tx.d, 'work_items_archive', it)
                with orgtx.org_tx(slug, **docket) as tx:
                    it = tx.d['work_items_archive'].pop(0)
                    it.pop('archived_at')
                    it.update(status='open', rev=3)
                    tx.d['work_items'].append(it)
                d = store.load_org(slug).d
                self.assertEqual([w['slug'] for w in d['work_items']], ['fix-the-thing', 'second-item'])
                self.assertEqual(d.get('work_items_archive') or [], [])
        t.compare(self, 'archived, then reopened')

    def test_one_slug_active_and_archived_at_commit_is_refused(self) -> None:
        # the org database holds one row per slug (design A.3); only the order inside a
        # save is free. Legacy stores the two lists apart, so this is the view's own rule
        t = Twins('both lists')
        with storage(True):
            with self.assertRaises(sqlite3.IntegrityError):
                with orgtx.org_tx(t.copy, sections=['work_items'], logs=['work_items_archive']) as tx:
                    store.log_append(tx.d, 'work_items_archive', dict(tx.d['work_items'][1]))
            d = store.load_org(t.copy).d
            self.assertEqual([w['slug'] for w in d['work_items']], ['fix-the-thing', 'second-item'])
            self.assertEqual(d.get('work_items_archive') or [], [])

    def test_stale_write_refuses(self) -> None:
        t = Twins('stale')
        with storage(True):
            a = store.load_org(t.copy)
            b = store.load_org(t.copy)
            a.d['nodes']['dev']['title'] = 'first'
            store.save_org(a)
            b.d['nodes']['dev']['title'] = 'second'
            with self.assertRaises(store.StaleWrite):
                store.save_org(b)
            self.assertEqual(store.load_org(t.copy).d['nodes']['dev']['title'], 'first')

    def test_revision_bumps_once_per_changing_save(self) -> None:
        t = Twins('revision')
        with storage(True):
            def rev() -> int:
                row = registry.lookup(t.copy)
                with dbconn.connect(RUNTIME, row[1]) as c:
                    return int(c.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0])
            r0 = rev()
            org = store.load_org(t.copy)
            org.d['nodes']['dev']['title'] = 'changed'
            store.save_org(org)
            self.assertEqual(rev(), r0 + 1)
            store.save_org(store.load_org(t.copy))
            self.assertEqual(rev(), r0 + 1)


@needs_pg
class LiveChildren(unittest.TestCase):
    """`store.lazy_children_index(live_only=True)` (a manager's settings save walks its
    LIVE subtree, 3-2-0-saving-a-big-manager-s-settings-must-not-l) names and decodes no
    archived child on either store, including archived rows whose unknown fields the
    converter kept in the agent's extra. The real traversals too: the save's lock plan (its
    dry run), its live subtree sweep, and a folder revoke."""

    SCOPE = {'permission_mode': 'acceptEdits', 'effort': 'high', 'org_visibility': 'full',
             'add_dirs': [{'path': 'C:/shared', 'mode': 'rw'}],
             'tools': {'bash': True, 'web': True, 'edit': True, 'subagents': True,
                       'mcp': ['alpha', 'beta']}}

    def twins(self) -> Twins:
        def before(slug: str) -> None:
            org = store.load_org(slug)
            for nid in ('boss', 'dev', 'ops'):
                org.d['nodes'][nid]['scope'] = json.loads(json.dumps(self.SCOPE))
            for i in range(16):
                n = node(f'old{i}', 'boss')
                n.update(state='archived', retained_legacy_field={'kept': i},
                         scope=json.loads(json.dumps(self.SCOPE)))
                org.d['nodes'][f'old{i}'] = n
            store.save_org(org)
        return Twins('livekids', before)

    @staticmethod
    def archived_decoded(org) -> int:
        nodes = dict.__getitem__(org.d, 'nodes')
        return sum(1 for k in dict.keys(nodes) if k.startswith('old'))

    def test_save_and_revoke_traversals_decode_no_archived_row(self) -> None:
        from orgtree import lifecycle_tx
        from orgtree.ledger import USER
        t = self.twins()
        caps = {'tools': {'bash': True, 'web': True, 'edit': True, 'subagents': True,
                          'mcp': ['alpha']}}
        for on, slug in ((False, t.legacy), (True, t.copy)):
            with self.subTest(storage=on), storage(on):
                with orgtx.org_tx(slug, nodes=['boss']):
                    pass                                    # warm: stamps the heal epoch
                live = ['boss', 'dev', 'ops']
                with orgtx.org_tx(slug, nodes=live, sections=['notices'],
                                  logs=['events', 'notice_log']) as tx:
                    upd = lifecycle_tx._scope_plan(tx.org, USER, 'boss', caps)[0]
                    self.assertEqual(upd, {'boss', 'dev', 'ops'})
                    tx.org.set_scope(USER, 'boss', **caps)
                    self.assertEqual(tx.org.scope_touched, {'dev', 'ops'})
                    res = tx.org.revoke_dir(USER, 'boss', 'C:/shared')
                    self.assertEqual(sorted(res['removed_from']), live)
                    self.assertEqual(self.archived_decoded(tx.org), 0)
                self.assertEqual(store.load_org(slug).node('old3')['scope']['tools']['mcp'],
                                 ['alpha', 'beta'])

    def test_live_children_decode_no_archived_row_with_retained_extra(self) -> None:
        t = self.twins()
        for on, slug in ((False, t.legacy), (True, t.copy)):
            with self.subTest(storage=on), storage(on):
                with orgtx.org_tx(slug, nodes=['boss']):
                    pass                                    # warm: stamps the heal epoch
                for live_only, want in ((True, ['dev', 'ops']),
                                        (False, ['dev', 'ops'] + [f'old{i}' for i in range(16)])):
                    with orgtx.org_tx(slug, nodes=['boss']) as tx:
                        nodes = dict.__getitem__(tx.org.d, 'nodes')
                        self.assertIsInstance(nodes, store.LazyNodesMap)
                        idx = store.lazy_children_index(tx.org, ['boss'], live_only=live_only)
                        self.assertIsNotNone(idx)
                        self.assertEqual(sorted(idx['boss']), sorted(want))
                        decoded = {k for k in dict.keys(nodes) if k.startswith('old')}
                        # the control (live_only False) decodes all 16: the rows are there
                        self.assertEqual(len(decoded), 0 if live_only else 16, live_only)


@needs_pg
class Receipts(unittest.TestCase):
    def test_a_receipt_made_before_conversion_replays_after_it(self) -> None:
        calls = []

        def credit(tx):
            calls.append(1)
            n = tx.d['nodes']['dev']
            n['credits'] = n.get('credits', 0) + 10
            return {'credits': n['credits']}

        def before(slug: str) -> None:
            self.assertEqual(orgtx.org_tx_call(slug, credit, nodes=['dev'], op_key='k1',
                                               fingerprint='f1'), {'credits': 10})
        t = Twins('receipts', before=before)
        with storage(True):
            self.assertEqual(orgtx.org_tx_call(t.copy, credit, nodes=['dev'], op_key='k1',
                                               fingerprint='f1'), {'credits': 10})
            self.assertEqual(len(calls), 1)                  # replayed, not run again
            self.assertEqual(store.load_org(t.copy).d['nodes']['dev']['credits'], 10)
            with self.assertRaises(orgtx.ReceiptConflict):
                orgtx.org_tx_call(t.copy, credit, nodes=['dev'], op_key='k1', fingerprint='other')
            self.assertEqual(orgtx.org_tx_call(t.copy, credit, nodes=['dev'], op_key='k2',
                                               fingerprint='f2'), {'credits': 20})
            self.assertEqual(len(calls), 2)
            row = registry.lookup(t.copy)
            with dbconn.connect(RUNTIME, row[1]) as c:
                self.assertEqual([r[0] for r in c.execute(
                    'SELECT op_key FROM orgtree.tx_receipts ORDER BY op_key').fetchall()],
                    ['k1', 'k2'])


@needs_pg
class MultiOrg(unittest.TestCase):
    """org_tx_multi over two org databases: no org commits until every org's save passed."""

    def test_a_refused_write_in_a_later_org_leaves_the_earlier_unwritten(self) -> None:
        a, b = Twins('multi a'), Twins('multi b')
        first, second = sorted((a.copy, b.copy), key=lambda s: registry.lookup(s)[0])

        def rev(slug: str) -> int:
            row = registry.lookup(slug)
            with dbconn.connect(RUNTIME, row[1]) as c:
                return int(c.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0])
        with storage(True):
            r1, r2 = rev(first), rev(second)
            with orgtx.org_tx_multi({first: dict(nodes=['dev']),
                                     second: dict(sections=['killswitch'])}) as t:
                t[first].d['nodes']['dev']['title'] = 'both'
                t[second].d['killswitch'] = {'on': True}
            self.assertEqual(store.load_org(first).d['nodes']['dev']['title'], 'both')
            self.assertEqual(store.load_org(second).d['killswitch'], {'on': True})
            self.assertEqual((rev(first), rev(second)), (r1 + 1, r2 + 1))
            # the SECOND org's write is refused after the first org's save ran: neither lands
            with self.assertRaises(orgtx.UnlockedWrite):
                with orgtx.org_tx_multi({first: dict(nodes=['dev']),
                                         second: dict(nodes=['dev'])}) as t:
                    t[first].d['nodes']['dev']['title'] = 'lost'
                    t[second].d['nodes']['ops']['title'] = 'unlocked'
            self.assertEqual(store.load_org(first).d['nodes']['dev']['title'], 'both')
            self.assertEqual(store.load_org(second).d['nodes']['ops']['title'], 'OPS')
            self.assertEqual((rev(first), rev(second)), (r1 + 1, r2 + 1))


@needs_pg
class LockBlock(unittest.TestCase):
    """test_pgstore's LockBlockOnPostgres for the org-database backend: an org's row locks are
    the org pseudo-row's lock and ONE DO block, in the lock plan's order."""

    def _recording(self):
        from unittest.mock import patch
        seen: list[str] = []
        real_checkout, real_release = registry.checkout, registry.release

        class Rec:
            def __init__(self, raw):
                object.__setattr__(self, '_raw', raw)

            def execute(self, q, *a, **k):
                seen.append(q if isinstance(q, str) else str(q))
                return self._raw.execute(q, *a, **k)

            def __getattr__(self, n):
                return getattr(self._raw, n)

        def release(raw, database):
            return real_release(getattr(raw, '_raw', raw), database)
        return seen, patch.multiple(registry, checkout=lambda *a: Rec(real_checkout(*a)),
                                      release=release)

    def test_one_org_lock_and_one_block_in_plan_order(self) -> None:
        import re
        t = Twins('lockblock')
        with storage(True):
            seen, p = self._recording()
            with p:
                with orgtx.org_tx(t.copy, nodes=['ops', 'boss'], sections=['asks', 'killswitch'],
                                  share_nodes=['dev']) as tx:
                    tx.d['nodes']['boss']['title'] = 'Boss'
            self.assertEqual(store.load_org(t.copy).d['nodes']['boss']['title'], 'Boss')
        locks = [q for q in seen if 'pg_advisory' in q]
        self.assertEqual(len(locks), 2, locks)                  # org pseudo-row + ONE block
        self.assertTrue(locks[1].startswith('DO $orgtx_'), locks[1][:40])
        before_block = seen[:seen.index(locks[1])]
        self.assertEqual([q for q in before_block if ' FOR UPDATE' in q or ' FOR SHARE' in q], [],
                         'a row lock ran before the block')
        got = [(m.group(2), 'S' if m.group(1) else 'X') for m in
               re.finditer(r"pg_advisory_xact_lock(_shared)?\(\d+, hashtext\('([^']*)'\)\)", locks[1])]
        self.assertEqual(got, [(f'node:{orgtx._ALL_NODES_KEY}', 'S'), ('node:boss', 'X'),
                               ('node:dev', 'S'), ('node:ops', 'X'),
                               ('section:asks', 'X'), ('section:killswitch', 'X')])
        # each named row's advisory lock is followed by the row's own lock (the node
        # pseudo-row has no row)
        rows = re.findall(r"PERFORM 1 FROM orgtree\.(\w+)[^;]*?(FOR UPDATE|FOR SHARE)", locks[1])
        self.assertEqual(rows, [('agents', 'FOR UPDATE'), ('agents', 'FOR SHARE'),
                                ('agents', 'FOR UPDATE'), ('org_sections', 'FOR UPDATE'),
                                ('org_sections', 'FOR UPDATE')])

    def test_a_settings_writer_plan_takes_the_settings_fence_before_any_row(self) -> None:
        # every writer of a settings key takes the one settings fence before its rows (review
        # f21). A plan that may write one takes it before ANY of its rows, the settings rows it
        # only reads included (review f24: a row first, then the fence, can deadlock with a
        # writer that holds the fence); a plan that only reads settings takes none
        import re
        from orgtree.orgdb.compat import rows as compat_rows
        t = Twins('settingsfence')
        fence_text = f"hashtext('{compat_rows.SETTINGS_FENCE}')"
        with storage(True):
            seen, p = self._recording()
            with p:
                with orgtx.org_tx(t.copy, sections=['asks', 'max_children'],
                                  share_sections=['killswitch']) as tx:
                    tx.d['max_children'] = 7
            self.assertEqual(store.load_org(t.copy).d['max_children'], 7)
            block = [q for q in seen if q.startswith('DO $orgtx_')]
            self.assertEqual(len(block), 1, seen)
            rows = [m.start() for m in re.finditer(r'PERFORM 1 FROM', block[0])]
            self.assertEqual(len(rows), 3, block[0])
            self.assertTrue(0 <= block[0].find(fence_text) < min(rows), block[0])
            self.assertEqual(block[0].count('orgdb-doc-key'), 1, block[0])
            seen, p = self._recording()
            with p:
                with orgtx.org_tx(t.copy, sections=['asks'], share_sections=['killswitch']):
                    pass
            block = [q for q in seen if q.startswith('DO $orgtx_')]
            self.assertEqual(len(block), 1, seen)
            self.assertEqual(block[0].count('orgdb-doc-key'), 0, block[0])


def _t(s: int) -> str:
    return f'2026-10-01T10:00:0{s}.000Z'


#: the Sent tail statement store._mail_tails runs, as written there (the view answers its text)
SENT_TAIL_SQL = ("WITH tail AS MATERIALIZED (SELECT seq,sent_at,owner_pos FROM mail_sent "
                 "WHERE sender=? ORDER BY sent_at DESC,owner_pos DESC,seq DESC LIMIT ?) "
                 "SELECT l.owner,l.val FROM tail CROSS JOIN LATERAL "
                 "(SELECT owner,val FROM log_d WHERE seq=tail.seq LIMIT 1) l "
                 "ORDER BY tail.sent_at DESC,tail.owner_pos DESC,tail.seq DESC")


def windows_fixture(slug: str) -> None:
    """Content for the bounded window readers (piece A6): equal timestamps across owners and
    inside one owner, a timestamp in another text form, records whose `at` is null or absent,
    a detail that is not an object, a sender that is null, a document id presented twice and
    an eviction sharing its `at` with a document. Round 2 (the windows read through org
    migration 0008's kept columns): a node, a sender and detail fields of another shape (a
    number, an object), more `at` text forms, and the two owner-tail logs."""
    def mail(mid: str, frm, at: str) -> dict:
        return {'id': mid, 'from': frm, 'body': f'body {mid}', 'at': at}
    org = store.load_org(slug)
    d = org.d
    d['mail_log'] = {
        'ops': [mail('a1', 'dev', _t(1)), mail('a2', 'boss', _t(2)), mail('a3', 'dev', _t(2)),
                mail('a4', 7, _t(3)), mail('a5', 'dev', '2026-10-01T10:00:02Z')],
        'dev': [mail('b1', 'boss', _t(2)), mail('b2', 'ops', _t(3)), mail('b3', 'boss', _t(2))],
        'boss': [mail('c1', 'dev', _t(2)), mail('c2', 'dev', '2026-10-01T10:00:02Z')],
    }
    d['user_mail_log'] = [mail('u1', 'dev', _t(1)), mail('u2', 'ops', _t(2)),
                          mail('u3', 'dev', _t(2)), mail('u4', None, _t(2)),
                          mail('u5', 7, _t(1)), mail('u6', 'dev', '2026-10-01T10:00:02Z')]
    d['user_inbox'] = [mail('i1', 'dev', _t(3))]
    for op, actor, detail, at in (
            ('hire', 'boss', {'node': 'dev'}, _t(1)), ('mail', 'ops', {'to': 'dev'}, _t(2)),
            ('grant', 'boss', {'grantee': 'dev'}, _t(2)), ('mail', 'dev', {'to': 'ops'}, _t(3)),
            ('reply', 'ops', {'from': 'dev'}, _t(2)), ('noise', 'ops', {'node': 'ops'}, _t(3)),
            ('weird', 'dev', 'a detail that is text', None), ('null at', 'dev', {}, 'NULL'),
            # `at` of another shape, ordered by its legacy jsonb text (review A6 f2): the
            # non-ASCII one sorts first, which an ASCII-escaped rendering would reverse
            ('accent', 'dev', {}, ['é']), ('ascii', 'dev', {}, ['z']),
            ('object at', 'dev', {}, {'zz': 1, 'a': 'é'}),
            ('numeric actor', 7, {'node': 'ops'}, _t(2)),       # matched as the text '7'
            ('numeric node', 'ops', {'node': 7}, _t(3)),
            ('float recipient', 'ops', {'to': 7.0}, _t(1)),      # the text '7.0', not '7'
            ('object node', 'ops', {'node': {'b': 1, 'a': 'é'}}, _t(2)),  # its jsonb text
            ('every role', 'boss', {'node': 'dev', 'to': 'dev', 'grantee': 'ops', 'from': 'boss'},
             '2026-10-01T10:00:03Z'),
            ('present_evicted', 'dev', {'id': 'd0', 'title': 'Old', 'format': 'html'}, _t(2))):
        e = {'op': op, 'actor': actor, 'detail': detail}
        if at == 'NULL':
            e['at'] = None
        elif at is not None:
            e['at'] = at
        store.log_append(d, 'events', e)
    d['notice_log'] = [{'node': 'dev', 'at': _t(1), 'text': 'n1'},
                       {'node': 'dev', 'at': _t(2), 'text': 'n2'},
                       {'node': 'ops', 'at': _t(2), 'text': 'n3'},
                       {'node': 'dev', 'at': _t(2), 'text': 'n4'},
                       {'node': 7, 'at': _t(3), 'text': 'n5'},
                       {'node': 'dev', 'at': '2026-10-01T10:00:02Z', 'text': 'n6'},
                       {'node': 'dev', 'at': ['z'], 'text': 'n7'},
                       {'node': 'dev', 'text': 'n8'}]
    # the owner tails order a non-string `at` as '' (store._at_of), unlike the windows
    d['steered_log'] = {'dev': [
        {'at': _t(2), 'level': 'a'}, {'at': '2026-10-01T10:00:02Z', 'level': 'b'},
        {'at': ['x'], 'level': 'c'}, {'level': 'd'}, {'at': 'yesterday', 'level': 'e'},
        {'at': _t(2), 'level': 'f'}, {'at': _t(1), 'level': 'g'}]}
    d['turn_error_log'] = {'dev': [{'at': _t(1), 'text': 'e1'}, {'at': None, 'text': 'e2'},
                                   {'at': _t(3), 'text': 'e3'}, {'at': 5, 'text': 'e4'}]}
    d['documents'] = [
        {'id': 'd1', 'node': 'dev', 'title': 'One', 'body': 'one', 'at': _t(1), 'format': 'markdown'},
        {'id': 'd2', 'node': 'ops', 'title': 'Two', 'body': '<p>2</p>', 'at': _t(2), 'format': 'html',
         'bytes': 10},
        {'id': 'd3', 'node': 'dev', 'title': 'Three', 'body': 'three', 'at': _t(2), 'format': 'markdown'},
        {'id': 'd1', 'node': 'ops', 'title': 'One again', 'body': 'again', 'at': _t(3),
         'format': 'markdown'}]
    store.save_org(org)


def first_rows_rewritten(slug: str) -> None:
    """windows_fixture, then ops' archive rows written again at the storage level (deleted and
    inserted, as a legacy rewrite does): ops keeps its place in the document's recipient order
    (legacy's meta owner list), but its first archive row (MIN(log_d.seq)) is now after dev's
    and boss's, and that row is what legacy's Sent tail ranks recipients by. On the live copy,
    612 recipient pairs of one org disagree like this (A6 round 2 review)."""
    windows_fixture(slug)
    oid = int(pgstore.read_marker(str(DATA / 'orgs' / f'{slug}.pg')))
    with pgstore.connect() as c:
        c.execute(f"WITH gone AS (DELETE FROM org_{oid}.log_d WHERE sect = 'mail_log' "
                  "AND owner = 'ops' RETURNING seq, sect, owner, at, val) "
                  f"INSERT INTO org_{oid}.log_d (sect, owner, at, val) "
                  "SELECT sect, owner, at, val FROM gone ORDER BY seq")


@needs_pg
class WindowReads(unittest.TestCase):
    """Piece A6: the bounded window readers (a node's inbox tails, its history, the
    presentations gallery, one presentation) answer with the switch on, from the org database,
    exactly as they answer on the legacy store; before, the view declined them and every
    window loaded the whole org."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.t = Twins('windows', before=windows_fixture)

    def both(self, fn):
        with storage(False):
            want = fn(self.t.legacy)
        with storage(True):
            got = fn(self.t.copy)
        return want, got

    def test_inbox_tails(self) -> None:
        for nid in ('dev', 'boss', 'ops'):
            for keep, slack in ((1, 0), (2, 1), (50, 40)):
                with self.subTest(nid=nid, keep=keep):
                    want, got = self.both(lambda s: store.read_node_inbox(s, nid, keep=keep, slack=slack))
                    self.assertIsNotNone(want)
                    self.assertIsNotNone(got, 'the window fell back to a whole-org load')
                    self.assertEqual(want, got)

    def test_history_rows(self) -> None:
        for nid in ('dev', 'ops', 'boss', 'nobody', '7', '7.0', '{"a": "é", "b": 1}'):
            for cap in (1, 3, 100):
                with self.subTest(nid=nid, cap=cap):
                    want, got = self.both(lambda s: store.read_node_history_rows(s, nid, cap))
                    self.assertIsNotNone(want)
                    self.assertIsNotNone(got, 'the history fell back to a whole-org load')
                    self.assertEqual(want, got)

    def test_gallery_and_one_document(self) -> None:
        want, got = self.both(store.read_document_gallery)
        self.assertEqual(want, got)
        # the eviction shares its `at` with two documents: the events-position path ran
        self.assertEqual(sorted(r['id'] for r in got if r['evicted']), ['d0'])
        with storage(True):
            self.assertIsNotNone(store._pg_document_gallery(self.t.copy),
                                 'the gallery fell back to a whole-org load')
        for did in ('d1', 'd2', 'd3', 'd0', 'missing'):
            with self.subTest(did=did):
                want, got = self.both(lambda s: store.read_document(s, did))
                self.assertIsNot(got, store.DOCUMENT_READ_FALLBACK)
                self.assertEqual(want, got)

    def test_sent_tail_ties_follow_each_recipients_first_row(self) -> None:
        # review A6: rows appended after the conversion interleave by id across recipients, so
        # with equal timestamps the legacy key (the recipient's first archive row, then the
        # row) and a plain row order disagree; this tail tells them apart
        t = Twins('senttie', before=windows_fixture)
        def mail(mid: str) -> dict:
            return {'id': mid, 'from': 'dev', 'body': f'body {mid}', 'at': _t(5)}
        t.edit(lambda d: d['mail_log']['ops'].append(mail('x1')))
        t.edit(lambda d: d['mail_log']['boss'].append(mail('x2')))
        t.edit(lambda d: d['mail_log']['ops'].append(mail('x3')))
        for keep, slack in ((1, 0), (2, 1)):
            with self.subTest(keep=keep):
                with storage(False):
                    want = store.read_node_inbox(t.legacy, 'dev', keep=keep, slack=slack)
                with storage(True):
                    got = store.read_node_inbox(t.copy, 'dev', keep=keep, slack=slack)
                self.assertIsNotNone(got)
                self.assertEqual(want, got)
                self.assertIn('x2', [m['id'] for m in got[4]])
        # round 2: the Sent statement itself with caps smaller than the tie group, so the
        # index's newest rows alone (by `at` text, then row) would pick x3 where the legacy key
        # picks x2 (boss's first archive row is after ops')
        for cap in (1, 2, 3, 4):
            with self.subTest(cap=cap):
                want, got = [], []
                for on, slug, out in ((False, t.legacy, want), (True, t.copy, got)):
                    with storage(on):
                        out.extend(store._bounded_read(slug, lambda conn: [
                            (o, json.loads(v)['id']) for o, v in
                            conn.execute(SENT_TAIL_SQL, ('dev', cap)).fetchall()]))
                self.assertEqual(want, got)
                self.assertEqual(got[0], ('boss', 'x2'))
        # removing ops' early rows moves ops' first archive row after boss's, so the tie order
        # flips: legacy repairs that owner's keys (mail_sent.owner_pos), and the view finds the
        # new key when it reads. The store re-inserts rows it repositions, so the rows kept (x1,
        # x3) must be removed around at the storage level, in both stores, for the key to be
        # what decides the order
        with storage(False):
            oid = int(pgstore.read_marker(str(DATA / 'orgs' / f'{t.legacy}.pg')))
            with pgstore.connect() as c:
                c.execute(f"DELETE FROM org_{oid}.log_d WHERE sect = 'mail_log' AND owner = 'ops' "
                          "AND (val::jsonb ->> 'id') LIKE 'a%'")
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1]) as c:
            c.execute("DELETE FROM orgtree.mail_log WHERE public_id LIKE 'a%' AND agent_id = "
                      "(SELECT id FROM orgtree.agents WHERE name = 'ops' AND NOT tombstone)")
        for cap in (1, 2, 3, 4):
            with self.subTest(cap=cap, after='first rows removed'):
                want, got = [], []
                for on, slug, out in ((False, t.legacy, want), (True, t.copy, got)):
                    with storage(on):
                        out.extend(store._bounded_read(slug, lambda conn: [
                            (o, json.loads(v)['id']) for o, v in
                            conn.execute(SENT_TAIL_SQL, ('dev', cap)).fetchall()]))
                self.assertEqual(want, got)
                self.assertEqual(got[0], ('ops', 'x3'))

    def test_converted_recipients_rank_by_their_legacy_first_row(self) -> None:
        # A6 round 2 review: the converter numbers the archive by legacy's row order, so a
        # recipient's first row id ranks as its MIN(log_d.seq) does, not as its place in the
        # document; dev's mail at one `at` to ops (a3, a5) and to boss (c1, c2) tells them apart
        t = Twins('firstrows', before=first_rows_rewritten)
        with storage(False):
            self.assertEqual(list(document(t.legacy)['mail_log']), ['ops', 'dev', 'boss'])
            oid = int(pgstore.read_marker(str(DATA / 'orgs' / f'{t.legacy}.pg')))
            with pgstore.connect() as c:
                want = [o for (o,) in c.execute(
                    f"SELECT owner FROM org_{oid}.log_d WHERE sect = 'mail_log' "
                    "GROUP BY owner ORDER BY min(seq)").fetchall()]
        self.assertEqual(want, ['dev', 'boss', 'ops'])
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1]) as c:
            got = [n for (n,) in c.execute(
                "SELECT a.name FROM orgtree.mail_log m JOIN orgtree.agents a ON a.id = m.agent_id "
                "GROUP BY a.name ORDER BY min(m.id)").fetchall()]
        self.assertEqual(got, want)
        for cap in (1, 2, 3, 4, 10):
            with self.subTest(cap=cap):
                tails = []
                for on, slug in ((False, t.legacy), (True, t.copy)):
                    with storage(on):
                        tails.append(store._bounded_read(slug, lambda conn: [
                            (o, json.loads(v)['id']) for o, v in
                            conn.execute(SENT_TAIL_SQL, ('dev', cap)).fetchall()]))
                self.assertEqual(tails[0], tails[1])
        for keep, slack in ((1, 0), (2, 1), (50, 40)):
            with self.subTest(keep=keep):
                with storage(False):
                    want_inbox = store.read_node_inbox(t.legacy, 'dev', keep=keep, slack=slack)
                with storage(True):
                    got_inbox = store.read_node_inbox(t.copy, 'dev', keep=keep, slack=slack)
                self.assertEqual(want_inbox, got_inbox)

    def test_the_gallery_never_reads_a_body(self) -> None:
        # review A6 f1: the gallery is metadata; no statement it runs may select the body
        # column (equal answers alone cannot show that the bodies travelled)
        got: list = []
        seen = recorded(lambda: got.append(store.read_document_gallery(self.t.copy)))
        rows = got[0]
        self.assertTrue(rows)
        documents = [q for q in seen if 'orgtree.documents' in q]
        self.assertTrue(documents, seen)
        for q in documents:
            self.assertNotIn('"body"', q)
            self.assertNotIn('SELECT *', q)

    def test_sent_tails_of_a_sender_of_another_shape(self) -> None:
        # a sender stored as the number 7 is the text '7' (the json_extract rule) in the Sent tail
        # and the user mail log alike; read_node_inbox wants an existing node, so the tails are
        # read through the same store function it uses
        for keep, slack in ((1, 0), (2, 1), (50, 40)):
            with self.subTest(keep=keep):
                want, got = self.both(lambda s: store._bounded_read(
                    s, lambda conn: store._mail_tails(conn, '7', keep, slack)))
                self.assertIsNotNone(got)
                self.assertEqual(want, got)
                self.assertIn('a4', [m['id'] for m in got[3]], got)   # (box, delivering, delivered, sent)

    def test_owner_tails(self) -> None:
        for sect in ('steered_log', 'turn_error_log'):
            for limit in (1, 2, 3, 50):
                with self.subTest(sect=sect, limit=limit):
                    want, got = self.both(
                        lambda s: store.log_owner_tail(store.load_org(s).d, sect, 'dev', limit))
                    self.assertIsNotNone(want)
                    self.assertIsNotNone(got, 'the tail fell back to a whole-section read')
                    self.assertEqual(want, got)

    def test_events_page(self) -> None:
        for kw in ({'last': 0}, {'last': 1}, {'last': 3}, {'last': 1000}, {'since': 0},
                   {'since': 2}, {'since': -2}, {'since': 1000}):
            with self.subTest(**kw):
                want, got = self.both(lambda s: store.read_events_page(s, **kw))
                self.assertIsNotNone(want)
                self.assertIsNotNone(got, 'the events page fell back to a whole-org load')
                self.assertEqual(want, got)

    def test_no_window_statement_selects_by_json(self) -> None:
        # round 2: what a window returns is decided by kept columns and their indexes, never by
        # a JSON predicate (umbrella acceptance 7), and every window statement on a log is
        # bounded: by LIMIT, by ids it already chose, by one exact key and `at` text, or as an
        # EXISTS probe (the org's load, outside the windows, is not what is checked here)
        logs = ('events', 'event_refs', 'notice_log', 'mail_log', 'user_mail_log',
                'steer_records', 'agent_turn_errors')
        with storage(True):
            loaded = store.load_org(self.t.copy).d
        calls = {'inbox': lambda s: store.read_node_inbox(s, 'dev', keep=2, slack=1),
                 'history': lambda s: store.read_node_history_rows(s, 'dev', 3),
                 'events': lambda s: store.read_events_page(s, last=3),
                 'events since': lambda s: store.read_events_page(s, since=2),
                 'steered': lambda s: store.log_owner_tail(loaded, 'steered_log', 'dev', 2)}
        for name, fn in calls.items():
            with self.subTest(name):
                seen = recorded(lambda: fn(self.t.copy))
                mine = [q for q in seen if re.search(r'\borgtree\.(%s)\b' % '|'.join(logs), q)]
                self.assertTrue(mine, seen)
                for q in mine:
                    where = re.split(r'\bWHERE\b', q, maxsplit=1, flags=re.I)[1:]
                    self.assertFalse(where and re.search(r'->|#>|::jsonb?\b', where[0]), q)
                    self.assertTrue(re.search(r'\bLIMIT\b|= ANY\(|win_at = %s|\bEXISTS\b', q), q)


@needs_pg
class EventsCount(unittest.TestCase):
    """Round 2: the number of events is kept at commit (org migration 0008), so the events page
    never counts them; a reader sees its own transaction's events, and a savepoint rolled back
    takes its events out of the count."""

    def test_the_count_follows_commits_savepoints_and_deletes(self) -> None:
        t = Twins('evcount', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with dbconn.connect(RUNTIME, db, autocommit=False) as c:
            count = lambda: int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0])
            before = sql._events_total(c)
            self.assertEqual(before, count())
            nxt = int(c.execute('SELECT max(ord) + 1 FROM orgtree.events').fetchone()[0])
            c.execute("INSERT INTO orgtree.events (ord, op, actor) VALUES (%s, 'x', 'dev')", (nxt,))
            self.assertEqual(sql._events_total(c), before + 1)
            c.execute('SAVEPOINT s')
            c.execute("INSERT INTO orgtree.events (ord, op, actor) VALUES (%s, 'y', 'dev')",
                      (nxt + 1,))
            self.assertEqual(sql._events_total(c), before + 2)
            c.execute('ROLLBACK TO SAVEPOINT s')
            self.assertEqual(sql._events_total(c), before + 1)
            c.commit()
            self.assertEqual(sql._events_total(c), count())
            c.execute("DELETE FROM orgtree.events WHERE ord = %s", (nxt,))
            c.commit()
            self.assertEqual(sql._events_total(c), count())
            self.assertEqual(sql._events_total(c), before)
        # writes through the view keep it, and the page agrees with the legacy twin
        t.edit(lambda d: store.log_append(d, 'events', {'op': 'later', 'actor': 'boss',
                                                        'detail': {'to': 'dev'}, 'at': _t(4)}))
        with dbconn.connect(RUNTIME, db) as c:
            self.assertEqual(sql._events_total(c),
                             int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0]))
        with storage(False):
            want = store.read_events_page(t.legacy, last=2)
        with storage(True):
            got = store.read_events_page(t.copy, last=2)
        self.assertEqual(want, got)

    def test_forced_checks_do_not_lose_a_statement(self) -> None:
        # a caller forcing deferred checks (SET CONSTRAINTS ALL IMMEDIATE) before a write: the
        # count's flush stays deferred, so that statement's events are counted at commit
        t = Twins('evforced', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with dbconn.connect(RUNTIME, db, autocommit=False) as c:
            nxt = int(c.execute('SELECT max(ord) + 1 FROM orgtree.events').fetchone()[0])
            for k in range(2):
                c.execute('SET CONSTRAINTS ALL IMMEDIATE')
                c.execute("INSERT INTO orgtree.events (ord, op, actor) VALUES (%s, 'forced', 'dev')",
                          (nxt + k,))
            c.commit()
            self.assertEqual(sql._events_total(c),
                             int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0]))
            c.execute('SET CONSTRAINTS ALL IMMEDIATE')
            c.execute("DELETE FROM orgtree.events WHERE op = 'forced'")
            c.commit()
            self.assertEqual(sql._events_total(c),
                             int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0]))

    def test_event_refs_follow_the_events(self) -> None:
        # the link table holds exactly each event's participants, after the conversion's COPY
        # and after writes through the view
        t = Twins('evrefs', before=windows_fixture)
        t.edit(lambda d: store.log_append(d, 'events', {'op': 'later', 'actor': 'ops',
                                                        'detail': {'grantee': 'boss'}, 'at': _t(4)}))
        db = registry.lookup(t.copy)[1]
        with dbconn.connect(ADMIN, db) as c:
            kept = sorted(c.execute('SELECT event_id, ref, win_at FROM orgtree.event_refs').fetchall())
            again = sorted(c.execute(
                'SELECT e.id, r, e.win_at FROM orgtree.events e CROSS JOIN LATERAL '
                'unnest(orgtree.event_refs_of(e.actor, e.detail, e.extra)) AS r').fetchall())
        self.assertEqual(kept, again)
        newest = max(e for e, _, _ in kept)
        self.assertEqual({r for e, r, _ in kept if e == newest}, {'ops', 'boss'})   # actor, grantee


@needs_pg
class OwnerKeys(unittest.TestCase):
    """The Sent tail's recipient key is the smallest id among the recipient's mail_log rows, as
    legacy's mail_sent.owner_pos is its MIN(log_d.seq) (ids follow legacy's seqs). Round 4 (review
    A6 f7-f9: keeping it on every row deadlocked three ways): no column keeps it and no trigger
    writes for it; the reader finds it for the rows it orders. So the Sent tail stays right
    however the archive is written (rows inserted in any order, a row moved to another owner in
    place, deleted, rewritten, by several transactions at once), and a writer locks only the rows
    its own statements write. Each case compares the Sent statement, at every cap, with the order
    computed here from every row, and with legacy where legacy can hold the same rows. The
    concurrency cases overlap the statements themselves, not only their COMMITs."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.t = Twins('ownerkeys', before=windows_fixture)
        cls.db = registry.lookup(cls.t.copy)[1]

    def connect(self, autocommit: bool = True, db: 'str | None' = None):
        return dbconn.connect(ADMIN, db or self.db, autocommit=autocommit)

    def sent(self, slug: str, sender: str, cap: int) -> list:
        """The view's answer to the Sent statement: (recipient, entry id, else its body)."""
        with storage(True):
            return store._bounded_read(slug, lambda conn: [
                (o, json.loads(v).get('id') or json.loads(v).get('body')) for o, v in
                conn.execute(SENT_TAIL_SQL, (sender, cap)).fetchall()])

    def assert_sent(self, t: 'Twins | None' = None,
                    senders: tuple = ('dev', 'boss', 'ops')) -> None:
        """Every sender's Sent tail, at every cap, is the order of all its rows: `at` text (byte
        order, as its "C" collation compares), then the recipient's smallest id, then the row,
        all descending."""
        t = t or self.t
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1]) as c:
            rows = c.execute(
                "SELECT m.win_from, m.win_at, min(m.id) OVER (PARTITION BY m.agent_id), m.id, "
                "a.name, coalesce(m.public_id, m.body) FROM orgtree.mail_log m "
                "JOIN orgtree.agents a ON a.id = m.agent_id").fetchall()
        for sender in senders:
            mine = sorted((r for r in rows if r[0] == sender),
                          key=lambda r: (r[1].encode('utf-8'), r[2], r[3]), reverse=True)
            want = [(r[4], r[5]) for r in mine]
            self.assertTrue(want, sender)
            for cap in range(1, len(want) + 4):
                with self.subTest(sender=sender, cap=cap):
                    self.assertEqual(self.sent(t.copy, sender, cap), want[:cap])

    def agent(self, c, name: str) -> int:
        return int(c.execute("SELECT id FROM orgtree.agents WHERE name = %s AND NOT tombstone",
                             (name,)).fetchone()[0])

    def new_agent(self, c, name: str) -> int:
        return int(c.execute("INSERT INTO orgtree.agents (name) VALUES (%s) RETURNING id",
                             (name,)).fetchone()[0])

    def test_a_row_moved_in_place_keeps_the_legacy_key(self) -> None:
        # review f3's case, in both stores at the storage level: ops' first archive row a1 moves
        # to boss (legacy: UPDATE log_d SET owner, which its mail_sent trigger keeps; here: agent_id
        # and a position after boss's rows). boss's first row is now a1, ops' is a2, and dev's Sent
        # tail breaks its ties between boss and ops by that
        t = Twins('movein', before=windows_fixture)
        with storage(False):
            oid = int(pgstore.read_marker(str(DATA / 'orgs' / f'{t.legacy}.pg')))
            with pgstore.connect() as c:
                c.execute(f"UPDATE org_{oid}.log_d SET owner = 'boss' WHERE sect = 'mail_log' "
                          "AND owner = 'ops' AND (val::jsonb ->> 'id') = 'a1'")
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1]) as c:
            boss = self.agent(c, 'boss')
            self.assertEqual(c.execute("UPDATE orgtree.mail_log SET agent_id = %s, idx = 100 "
                                       "WHERE public_id = 'a1'", (boss,)).rowcount, 1)
        self.assert_sent(t)
        for cap in (1, 2, 3, 4, 10):
            with self.subTest(cap=cap):
                tails = []
                for on, slug in ((False, t.legacy), (True, t.copy)):
                    with storage(on):
                        tails.append(store._bounded_read(slug, lambda conn: [
                            (o, json.loads(v)['id']) for o, v in
                            conn.execute(SENT_TAIL_SQL, ('dev', cap)).fetchall()]))
                self.assertEqual(tails[0], tails[1])

    def test_rows_inserted_in_any_order_keep_the_smallest_id(self) -> None:
        # a position need not follow ids: a row placed first with a new (largest) id leaves its
        # recipient's key alone; a row placed last with an id below every other lowers it. ops and
        # boss each get a row at one newest `at`, a tie only the key orders
        t = Twins('anyorder', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(autocommit=False, db=db) as c:
            ops, boss = self.agent(c, 'ops'), self.agent(c, 'boss')
            for owner, body in ((ops, 'tie ops'), (boss, 'tie boss')):
                c.execute("INSERT INTO orgtree.mail_log (agent_id, idx, \"from\", body, at) "
                          "VALUES (%s, -1, 'dev', %s, %s::timestamptz)", (owner, body, self.LATE))
            c.commit()
            self.assert_sent(t)
            # boss's rows were converted after ops', so its key is the larger: boss first
            self.assertEqual(self.sent(t.copy, 'dev', 2), [('boss', 'tie boss'), ('ops', 'tie ops')])
            low = int(c.execute('SELECT min(id) FROM orgtree.mail_log').fetchone()[0]) - 1
            c.execute("INSERT INTO orgtree.mail_log (id, agent_id, idx, \"from\", body) "
                      "OVERRIDING SYSTEM VALUE VALUES (%s, %s, 1000, 'dev', 'placed last')",
                      (low, boss))
            c.commit()
        self.assert_sent(t)
        self.assertEqual(self.sent(t.copy, 'dev', 2), [('ops', 'tie ops'), ('boss', 'tie boss')])

    def test_forced_checks_change_nothing(self) -> None:
        # a caller forcing deferred checks before it removes an owner's first row: nothing about
        # the key waits for commit, so every Sent tail stays right
        t = Twins('ownforced', before=windows_fixture)
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1], autocommit=False) as c:
            ops = self.agent(c, 'ops')
            c.execute('SET CONSTRAINTS ALL IMMEDIATE')
            c.execute('DELETE FROM orgtree.mail_log WHERE id = (SELECT min(id) FROM orgtree.mail_log '
                      'WHERE agent_id = %s)', (ops,))
            c.commit()
        self.assert_sent(t)

    def test_a_row_moved_by_delete_and_append_keeps_both_keys(self) -> None:
        t = Twins('moveappend', before=windows_fixture)
        with self.connect(autocommit=False, db=registry.lookup(t.copy)[1]) as c:
            ops, boss = self.agent(c, 'ops'), self.agent(c, 'boss')
            first = int(c.execute("SELECT id FROM orgtree.mail_log WHERE agent_id = %s "
                                  "ORDER BY idx LIMIT 1", (ops,)).fetchone()[0])
            c.execute('DELETE FROM orgtree.mail_log WHERE id = %s', (first,))
            # an append takes the next id as its position (compat rows.log_insert)
            nxt = int(c.execute("SELECT nextval(pg_get_serial_sequence('orgtree.mail_log', 'id'))"
                                ).fetchone()[0])
            c.execute("INSERT INTO orgtree.mail_log (id, agent_id, idx, \"from\", body) "
                      "OVERRIDING SYSTEM VALUE VALUES (%s, %s, %s, 'dev', 'moved')",
                      (nxt, boss, nxt))
            c.commit()
        self.assert_sent(t)

    #: a row the concurrent writers write: public id c<id>, sent by dev, newer than the fixture's
    LATE = '2099-01-01T00:00:00.000Z'
    APPEND = ('INSERT INTO orgtree.mail_log (id, agent_id, idx, public_id, "from", body, at) '
              "OVERRIDING SYSTEM VALUE VALUES (%s, %s, %s, %s, 'dev', 'first', %s::timestamptz) "
              'RETURNING id')

    def appended(self, rid: int, owner: int) -> tuple:
        return (rid, owner, rid, f'c{rid}', self.LATE)

    def first_appends(self, owner: int, ids: tuple[int, int], first_commits: bool = True,
                      db: 'str | None' = None) -> None:
        """Two transactions each insert a first row of ``owner`` (ids and positions ``ids``)
        before either ends. The second never waits for the first (no row both write keeps a
        key): with a lock timeout, a wait would fail it."""
        a, b = self.connect(autocommit=False, db=db), self.connect(autocommit=False, db=db)
        try:
            a.execute(self.APPEND, self.appended(ids[0], owner))
            b.execute("SET LOCAL lock_timeout = '5s'")
            b.execute(self.APPEND, self.appended(ids[1], owner))
            if first_commits:
                a.commit()
            else:
                a.rollback()
            b.commit()
        finally:
            a.close()
            b.close()

    def test_concurrent_first_appends_keep_the_legacy_order(self) -> None:
        # review f4: two transactions append an owner's first rows at once. A recipient whose first
        # row lies between the two ids would show a split key in dev's Sent tail, which is checked
        # against legacy holding the same rows in the same order
        t = Twins('firstappends', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(db=db) as c:
            top = int(c.execute('SELECT max(id) FROM orgtree.mail_log').fetchone()[0])
            aid = {n: self.new_agent(c, n) for n in
                   ('fresh-one', 'fresh-mid', 'fresh-two', 'fresh-mid2', 'fresh-three')}
            for name, rid in (('fresh-mid', top + 1005), ('fresh-mid2', top + 2005)):
                c.execute(self.APPEND, self.appended(rid, aid[name]))
        self.first_appends(aid['fresh-one'], (top + 1000, top + 1010), db=db)  # first is first
        self.first_appends(aid['fresh-two'], (top + 2010, top + 2000), db=db)  # second is first
        self.first_appends(aid['fresh-three'], (top + 3000, top + 3001), first_commits=False,
                           db=db)
        self.assert_sent(t, senders=('dev',))
        # legacy gets the same committed rows one save each, in id order, so its seqs (and so
        # each recipient's MIN(seq)) follow the ids
        kept = sorted([(top + 1000, 'fresh-one'), (top + 1005, 'fresh-mid'),
                       (top + 1010, 'fresh-one'), (top + 2000, 'fresh-two'),
                       (top + 2005, 'fresh-mid2'), (top + 2010, 'fresh-two'),
                       (top + 3001, 'fresh-three')])
        with storage(False):
            for rid, owner in kept:
                org = store.load_org(t.legacy)
                org.d['mail_log'].setdefault(owner, []).append(
                    {'id': f'c{rid}', 'from': 'dev', 'body': 'first', 'at': self.LATE})
                store.save_org(org)
        # one tie group: recipients by their first row (newest first), then rows
        head = [('fresh-three', f'c{top + 3001}'), ('fresh-mid2', f'c{top + 2005}'),
                ('fresh-two', f'c{top + 2010}'), ('fresh-two', f'c{top + 2000}'),
                ('fresh-mid', f'c{top + 1005}'), ('fresh-one', f'c{top + 1010}'),
                ('fresh-one', f'c{top + 1000}')]
        for cap in (1, 2, 3, 4, 5, 6, 7, 10):
            with self.subTest(cap=cap):
                tails = []
                for on, slug in ((False, t.legacy), (True, t.copy)):
                    with storage(on):
                        tails.append(store._bounded_read(slug, lambda conn: [
                            (o, json.loads(v)['id']) for o, v in
                            conn.execute(SENT_TAIL_SQL, ('dev', cap)).fetchall()]))
                self.assertEqual(tails[0], tails[1])
                self.assertEqual(tails[1][:len(head)], head[:cap])

    def test_rewriting_a_row_touches_no_other_row(self) -> None:
        # the view rewrites a row by deleting it and inserting it again with its id; nothing is
        # kept per owner, so none of the owner's other rows is written, whether the row rewritten
        # is the owner's first or not
        for i, pid in ((1, 'a2'), (0, 'a1')):
            with self.subTest(rewritten=pid):
                t = Twins(f'rewrite{i}', before=windows_fixture)
                db = registry.lookup(t.copy)[1]

                def others() -> list:
                    with dbconn.connect(ADMIN, db) as c:
                        return c.execute(
                            "SELECT m.id, m.xmin::text FROM orgtree.mail_log m JOIN orgtree.agents a "
                            "ON a.id = m.agent_id WHERE a.name = 'ops' AND m.public_id <> %s "
                            "ORDER BY m.id", (pid,)).fetchall()
                before = others()
                t.edit(lambda d: d['mail_log']['ops'][i].__setitem__('stale', True))
                self.assertEqual(others(), before)
                t.compare(self, 'after the rewrite')
                self.assert_sent(t)

    def test_a_tie_at_the_tails_edge_is_ordered_recipient_by_recipient(self) -> None:
        # the rows tied at the cap's edge run past it: they are walked recipient by recipient,
        # the latest first row first, each by row. Three recipients' rows interleave by id at one
        # `at`, with newer rows above the tie and older ones below; every cap is compared with the
        # order of all rows, and the walk is what answered a cap inside the tie
        t = Twins('edgetie', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(db=db) as c:
            top = int(c.execute('SELECT max(id) FROM orgtree.mail_log').fetchone()[0])
            r = [self.new_agent(c, f'tie-r{k}') for k in range(3)]
            # each recipient's first row is old, in the opposite order of their agent ids, so the
            # keys order r0, r1, r2 (latest first row first) while the index holds r2, r1, r0 first
            for k in range(3):
                c.execute(self.APPEND, (top + 12 - k, r[k], 0, f'old{k}', '2001-01-01T00:00:00.000Z'))
            for j in range(9):                  # the tie: ids interleave across recipients
                c.execute(self.APPEND, (top + 100 + j, r[j % 3], 10 + j, f't{j}', self.LATE))
            for j in range(2):                  # newer than the tie
                c.execute(self.APPEND, (top + 200 + j, r[0], 30 + j, f'n{j}', '2099-06-01T00:00:00.000Z'))
        self.assert_sent(t, senders=('dev',))
        walked = recorded(lambda: self.sent(t.copy, 'dev', 5))
        self.assertTrue(any('WITH RECURSIVE' in q for q in walked), walked)
        self.assertEqual([m for _, m in self.sent(t.copy, 'dev', 5)], ['n1', 'n0', 't6', 't3', 't0'])
        self.assertEqual([m for _, m in self.sent(t.copy, 'dev', 8)],
                         ['n1', 'n0', 't6', 't3', 't0', 't7', 't4', 't1'])

    def test_the_sent_tail_reads_the_same_rows_however_large_the_tie(self) -> None:
        # umbrella acceptance 7, as jobs-sol's guard measures it (every captured statement replayed
        # with EXPLAIN ANALYZE; rows examined at table and index nodes): a tie at the edge that grows
        # tenfold, all of one sender to one recipient at one `at`, costs the same reads
        t = Twins('flattie', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(db=db) as c:
            r = self.new_agent(c, 'flat-r')
            c.execute("INSERT INTO orgtree.mail_log (agent_id, idx, \"from\", body, at) "
                      "VALUES (%s, 0, 'flat', 'newest', '2099-06-01T00:00:00Z')", (r,))

        def grow(to: int) -> None:
            with self.connect(db=db) as c:
                have = int(c.execute("SELECT count(*) FROM orgtree.mail_log WHERE \"from\" = 'flat'"
                                     ).fetchone()[0]) - 1
                c.execute("INSERT INTO orgtree.mail_log (agent_id, idx, \"from\", body, at) "
                          "SELECT %s, 1 + g, 'flat', 'tie ' || g, %s::timestamptz "
                          "FROM generate_series(%s, %s - 1) g", (r, self.LATE, have, to))
                c.execute('ANALYZE orgtree.mail_log')

        def examined(cap: int) -> tuple[int, int]:
            seen = recorded_with_params(lambda: self.sent(t.copy, 'flat', cap))
            mine = [(q, p) for q, p in seen if 'orgtree.mail_log' in q
                    and re.match(r'\s*(SELECT|WITH)\b', q, re.I)]
            self.assertTrue(mine, seen)
            total = 0
            with dbconn.connect(RUNTIME, db) as c:
                for q, p in mine:
                    plan = c.execute('EXPLAIN (ANALYZE, FORMAT JSON) ' + q, p).fetchone()[0][0]['Plan']
                    total += plan_examined(plan)
            return len(mine), total
        grow(300)
        small = {cap: examined(cap) for cap in (1, 5, 19)}
        grow(3000)
        large = {cap: examined(cap) for cap in (1, 5, 19)}
        self.assertEqual(small, large)
        self.assertEqual([m for _, m in self.sent(t.copy, 'flat', 3)], ['newest', 'tie 2999', 'tie 2998'])

    def test_a_save_and_a_native_mail_writer_with_its_event_both_commit(self) -> None:
        # review f7 (a 40P01 deadlock on b339c20): save A, through the production view connection,
        # writes an owner's archive and then bumps the revision (on_save_commit takes the revision
        # row before COMMIT). Native writer B, in a thread, runs its whole transaction on the same
        # owner: its own archive write, an audit event, COMMIT; its COMMIT counts the event into
        # the revision row, so it waits for A. Then A commits. Both must commit, for a first row
        # deleted, moved or inserted by A, and an append, a delete or a move by B
        t = Twins('saverace', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(db=db) as c:
            top = int(c.execute('SELECT max(id) FROM orgtree.mail_log').fetchone()[0])
            owners = {}
            for k in range(1, 6):
                owners[k] = (self.new_agent(c, f'race-x{k}'), self.new_agent(c, f'race-y{k}'))
                for j in range(3):          # x<k>'s rows: ids top+100k+j, positions j
                    c.execute(self.APPEND, (top + 100 * k + j, owners[k][0], j, f'r{k}{j}',
                                            self.LATE))
        first = lambda k: top + 100 * k
        append = ("INSERT INTO orgtree.mail_log (agent_id, idx, \"from\", body, at) "
                  "VALUES (%s, %s, 'dev', %s, %s::timestamptz)")
        cases = [
            ('A deletes the first row, B appends',
             ('DELETE FROM orgtree.mail_log WHERE id = %s', (first(1),)),
             (append, (owners[1][0], 50, 'b append 1', self.LATE))),
            ('A moves the first row away, B appends',
             ('UPDATE orgtree.mail_log SET agent_id = %s, idx = 60 WHERE id = %s',
              (owners[2][1], first(2))),
             (append, (owners[2][0], 50, 'b append 2', self.LATE))),
            ('A inserts a first row, B appends',
             (append, (owners[3][1], 0, 'a first 3', self.LATE)),
             (append, (owners[3][1], 50, 'b append 3', self.LATE))),
            ('A deletes the first row, B deletes another',
             ('DELETE FROM orgtree.mail_log WHERE id = %s', (first(4),)),
             ('DELETE FROM orgtree.mail_log WHERE id = %s', (first(4) + 1,))),
            ('A deletes the first row, B moves another away',
             ('DELETE FROM orgtree.mail_log WHERE id = %s', (first(5),)),
             ('UPDATE orgtree.mail_log SET agent_id = %s, idx = 70 WHERE id = %s',
              (owners[5][1], first(5) + 2)))]
        for name, (a_sql, a_args), (b_sql, b_args) in cases:
            with self.subTest(case=name):
                out: dict = {}
                with storage(True):
                    with store._POOL.acquire(t.copy) as a:
                        a.execute('BEGIN IMMEDIATE')
                        a.raw.execute(a_sql, a_args)
                        a.on_save_commit(True)

                        def native() -> None:
                            try:
                                with dbconn.connect(RUNTIME, db, autocommit=False) as b:
                                    b.execute("SET LOCAL lock_timeout = '30s'")
                                    b.execute(b_sql, b_args)
                                    nxt = int(b.execute('SELECT max(ord) + 1 FROM orgtree.events'
                                                        ).fetchone()[0])
                                    b.execute("INSERT INTO orgtree.events (ord, op, actor, detail) "
                                              "VALUES (%s, 'audit', 'dev', %s::json)",
                                              (nxt, json.dumps({'to': 'ops'})))
                                    b.commit()
                                out['b'] = 'committed'
                            except BaseException as e:      # noqa: BLE001  the outcome under test
                                out['b'] = e
                        th = threading.Thread(target=native)
                        th.start()
                        # B finishes, or waits on the server for the revision row A holds
                        wait_for(lambda: 'b' in out or lock_waiters(db) > 0)
                        a.execute('COMMIT')
                        out['a'] = 'committed'
                    th.join(60)
                self.assertFalse(th.is_alive(), 'the native writer never finished')
                self.assertEqual(out, {'a': 'committed', 'b': 'committed'})
        self.assert_sent(t, senders=('dev',))
        with dbconn.connect(RUNTIME, db) as c:
            self.assertEqual(sql._events_total(c),
                             int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0]))
            self.assertEqual(int(c.execute("SELECT count(*) FROM orgtree.events WHERE op = 'audit'"
                                           ).fetchone()[0]), len(cases))

    def test_a_first_row_removal_and_an_edit_then_removal_of_another_row_both_commit(self) -> None:
        # review f8 (a 40P01 deadlock on 4afea43, whose statement-end repair rewrote the owner's
        # other rows under the owner's lock): B edits the body of the owner's second row and keeps
        # that row's lock; A, in a thread, deletes the owner's first row while B is open; then B
        # deletes the row it edited, while A's statement runs or waits. A's removal writes no
        # other row, so it never waits for B's row, and neither waits for a key: both commit
        t = Twins('f8race', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        with self.connect(db=db) as c:
            top = int(c.execute('SELECT max(id) FROM orgtree.mail_log').fetchone()[0])
            x = self.new_agent(c, 'f8-owner')
            for j in range(3):
                c.execute(self.APPEND, (top + 1 + j, x, j, f'f8-{j}', self.LATE))
        out: dict = {}
        with dbconn.connect(RUNTIME, db, autocommit=False) as b:
            b.execute("SET LOCAL lock_timeout = '20s'")
            b.execute("UPDATE orgtree.mail_log SET body = 'edited' WHERE id = %s", (top + 2,))

            def writer_a() -> None:
                try:
                    with dbconn.connect(RUNTIME, db, autocommit=False) as a:
                        a.execute("SET LOCAL lock_timeout = '20s'")
                        a.execute('DELETE FROM orgtree.mail_log WHERE id = %s', (top + 1,))
                        out['a deleted'] = True
                        # A stays open until B has removed its row too: the two overlap
                        wait_for(lambda: 'b' in out, timeout=30)
                        a.commit()
                    out['a'] = 'committed'
                except BaseException as e:      # noqa: BLE001  the outcome under test
                    out['a'] = e
            th = threading.Thread(target=writer_a)
            th.start()
            # A's removal finishes, or waits on the server for a lock B holds
            self.assertTrue(wait_for(lambda: 'a' in out or 'a deleted' in out or lock_waiters(db) > 0))
            try:
                b.execute('DELETE FROM orgtree.mail_log WHERE id = %s', (top + 2,))
                b.commit()
                out['b'] = 'committed'
            except BaseException as e:          # noqa: BLE001  the outcome under test
                out['b'] = e
            th.join(60)
            self.assertFalse(th.is_alive(), 'writer A never finished')
        out.pop('a deleted', None)
        self.assertEqual(out, {'a': 'committed', 'b': 'committed'})
        with self.connect(db=db) as c:
            self.assertEqual([p for (p,) in c.execute(
                'SELECT public_id FROM orgtree.mail_log WHERE agent_id = %s ORDER BY id', (x,))],
                ['f8-2'])
        self.assert_sent(t, senders=('dev',))

    def test_a_forced_event_check_then_a_mail_removal_and_an_audited_append_both_commit(self) -> None:
        # review f9 (a 40P01 deadlock on 4afea43): A appends an event and forces the deferred
        # checks, so its events count flush takes the revision row now; B, in a thread, appends
        # mail to ops with its audit event and commits, waiting at COMMIT for A's revision row; A
        # then removes ops' first mail row. No mail write takes a lock for the key, so A's removal
        # does not wait for B's append: A commits, then B
        t = Twins('f9race', before=windows_fixture)
        db = registry.lookup(t.copy)[1]
        out: dict = {}
        with dbconn.connect(RUNTIME, db, autocommit=False) as a:
            a.execute("SET LOCAL lock_timeout = '20s'")
            ops = self.agent(a, 'ops')
            nxt = int(a.execute('SELECT max(ord) + 1 FROM orgtree.events').fetchone()[0])
            a.execute("INSERT INTO orgtree.events (ord, op, actor) VALUES (%s, 'forced', 'dev')", (nxt,))
            a.execute('SET CONSTRAINTS ALL IMMEDIATE')

            def writer_b() -> None:
                try:
                    with dbconn.connect(RUNTIME, db, autocommit=False) as b:
                        b.execute("SET LOCAL lock_timeout = '20s'")
                        b.execute("INSERT INTO orgtree.mail_log (agent_id, idx, \"from\", body, at) "
                                  "VALUES (%s, 500, 'dev', 'b append', %s::timestamptz)",
                                  (ops, self.LATE))
                        b.execute("INSERT INTO orgtree.events (ord, op, actor, detail) "
                                  "VALUES (%s, 'audit', 'dev', %s::json)",
                                  (nxt + 1, json.dumps({'to': 'ops'})))
                        b.commit()
                    out['b'] = 'committed'
                except BaseException as e:      # noqa: BLE001  the outcome under test
                    out['b'] = e
            th = threading.Thread(target=writer_b)
            th.start()
            # B's COMMIT waits on the server for the revision row A holds
            self.assertTrue(wait_for(lambda: 'b' in out or lock_waiters(db) > 0))
            try:
                a.execute('DELETE FROM orgtree.mail_log WHERE id = (SELECT min(id) '
                          'FROM orgtree.mail_log WHERE agent_id = %s)', (ops,))
                a.commit()
                out['a'] = 'committed'
            except BaseException as e:          # noqa: BLE001  the outcome under test
                out['a'] = e
            th.join(60)
            self.assertFalse(th.is_alive(), 'writer B never finished')
        self.assertEqual(out, {'a': 'committed', 'b': 'committed'})
        self.assert_sent(t, senders=('dev',))
        with dbconn.connect(RUNTIME, db) as c:
            self.assertEqual(sql._events_total(c),
                             int(c.execute('SELECT count(*) FROM orgtree.events').fetchone()[0]))


@needs_pg
class NulValues(unittest.TestCase):
    """A \\u0000 anywhere in a JSON value makes every json and jsonb operator of PostgreSQL fail,
    even one reading another key. The kept keys of org migration 0008 never read such a value raw,
    so writing it succeeds, where a kept column computed from it would fail the write. (Legacy
    cannot store such mail at all, and cannot read history past such an event: its statements
    cast every record to jsonb. So these answers are checked against the records themselves.)"""

    def test_a_legacy_source_holding_a_nul_converts(self) -> None:
        # review f5: U+0000 in fields no key selects by (an event's detail.message, a notice's
        # text); the conversion's COPY writes them, since the key functions never cast them raw,
        # and the converted org loads exactly as its source
        def nul_source(slug: str) -> None:
            windows_fixture(slug)
            org = store.load_org(slug)
            store.log_append(org.d, 'events', {'op': 'nul-detail', 'actor': 'dev', 'at': _t(5),
                                               'detail': {'node': 'dev', 'message': 'kept\x00text'}})
            store.log_append(org.d, 'notice_log', {'node': 'dev', 'at': _t(5), 'text': 'kept\x00text'})
            store.log_append(org.d, 'events', {'op': 'cut-detail', 'actor': 'dev', 'at': _t(5),
                                               'detail': {'node': 'dev', 'message': 'cut \ud83d'}})
            store.log_append(org.d, 'notice_log', {'node': 'dev', 'at': _t(5), 'text': 'cut \ud83d'})
            store.save_org(org)
        t = Twins('nulsource', before=nul_source)
        t.compare(self, 'a source holding U+0000')
        with storage(True):
            events, notices = store.read_node_history_rows(t.copy, 'dev', 100)
        self.assertIn({'op': 'nul-detail', 'actor': 'dev', 'at': _t(5),
                       'detail': {'node': 'dev', 'message': 'kept\x00text'}}, events)
        self.assertIn({'node': 'dev', 'at': _t(5), 'text': 'kept\x00text'}, notices)
        self.assertIn({'op': 'cut-detail', 'actor': 'dev', 'at': _t(5),
                       'detail': {'node': 'dev', 'message': 'cut \ud83d'}}, events)
        self.assertIn({'node': 'dev', 'at': _t(5), 'text': 'cut \ud83d'}, notices)

    def test_records_holding_a_nul_are_written_and_read(self) -> None:
        t = Twins('nul', before=windows_fixture)
        nul = 'a\x00b'
        cut = 'cut \ud83d'           # half of a UTF-16 pair: text cut inside an emoji
        records = {
            'events': [{'op': 'nul detail', 'actor': 'dev', 'detail': {'to': 'ops', 'note': nul},
                        'at': _t(6)},
                       {'op': 'cut detail', 'actor': 'dev', 'detail': {'to': 'ops', 'note': cut},
                        'at': _t(6)},
                       {'op': 'cut actor', 'actor': cut, 'detail': {'node': 'ops'}, 'at': _t(7)},
                       {'op': 'nul actor', 'actor': nul, 'detail': {'node': 'ops'}, 'at': _t(7)},
                       {'op': 'nul at', 'actor': 'ops', 'detail': {}, 'at': nul}],
            'mail': [{'id': 'z1', 'from': 'dev', 'body': nul, 'at': _t(6)},
                     {'id': 'z3', 'from': 'dev', 'body': cut, 'at': _t(6)},
                     {'id': 'z2', 'from': nul, 'body': 'x', 'at': _t(7)}],
            'notice': [{'node': 'ops', 'at': _t(6), 'text': nul}, {'node': nul, 'at': _t(7)}]}
        with storage(True):
            org = store.load_org(t.copy)
            for e in records['events']:
                store.log_append(org.d, 'events', e)
            for m in records['mail']:
                org.d['mail_log']['ops'].append(m)
            for n in records['notice']:
                store.log_append(org.d, 'notice_log', n)
            store.save_org(org)
            events, notices = store.read_node_history_rows(t.copy, 'ops', 100)
            self.assertEqual([e for e in events if e.get('op', '').startswith(('nul', 'cut'))],
                             records['events'])
            self.assertEqual([n for n in notices if n.get('at') == _t(6)], records['notice'][:1])
            # (leased, box, delivering, delivered tail, sent tail)
            delivered = store.read_node_inbox(t.copy, 'ops', keep=50, slack=0)[3]
            self.assertEqual([m for m in delivered if m['id'] in ('z1', 'z2', 'z3')],
                             records['mail'])
            sent = store.read_node_inbox(t.copy, 'dev', keep=50, slack=0)[4]
            self.assertLessEqual({'z1', 'z3'}, {m['id'] for m in sent})
        with dbconn.connect(ADMIN, registry.lookup(t.copy)[1]) as c:
            refs = {op: sorted(r for (r,) in c.execute(
                'SELECT ref FROM orgtree.event_refs r JOIN orgtree.events e ON e.id = r.event_id '
                'WHERE e.op = %s', (op,)).fetchall())
                for op in ('nul detail', 'nul actor', 'nul at', 'cut detail', 'cut actor')}
            # each NUL of a key reads as U+FFFD: a text no node has, so it matches no window
            self.assertEqual(refs, {'nul detail': ['dev', 'ops'], 'nul actor': ['a\ufffdb', 'ops'],
                                    'nul at': ['ops'], 'cut detail': ['dev', 'ops'],
                                    'cut actor': ['cut \ufffd', 'ops']})
            self.assertEqual(c.execute("SELECT win_at FROM orgtree.events WHERE op = 'nul at'"
                                       ).fetchone()[0], 'a\ufffdb')


def recorded(fn) -> list:
    """The statements ``fn`` runs on the org databases' pooled runtime connections."""
    from unittest.mock import patch
    seen: list = []
    real_checkout, real_release = registry.checkout, registry.release

    class Cur:
        def __init__(self, cur):
            self._cur = cur

        def __enter__(self):
            self._cur.__enter__()
            return self

        def __exit__(self, *exc):
            return self._cur.__exit__(*exc)

        def execute(self, q, *a, **k):
            seen.append(str(q))
            return self._cur.execute(q, *a, **k)

        def __getattr__(self, n):
            return getattr(self._cur, n)

    class Rec:
        def __init__(self, raw):
            object.__setattr__(self, '_raw', raw)

        def execute(self, q, *a, **k):
            seen.append(str(q))
            return self._raw.execute(q, *a, **k)

        def cursor(self, *a, **k):
            return Cur(self._raw.cursor(*a, **k))

        def __getattr__(self, n):
            return getattr(self._raw, n)

    def release(raw, database):
        return real_release(getattr(raw, '_raw', raw), database)
    registry.close_idle()
    with storage(True), patch.multiple(registry, checkout=lambda *a: Rec(real_checkout(*a)),
                                       release=release):
        fn()
    return seen


def wait_for(cond, timeout: float = 15.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return bool(cond())


def lock_waiters(database: str) -> int:
    """Sessions of ``database`` waiting on a lock now."""
    with dbconn.connect(ADMIN, 'postgres') as c:
        return int(c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname = %s "
                             "AND wait_event_type = 'Lock'", (database,)).fetchone()[0])


def recorded_with_params(fn) -> list:
    """(statement, parameters) of each statement ``fn`` runs on the org databases' pooled runtime
    connections, as jobs-sol's hot-path guard captures them to replay."""
    from unittest.mock import patch
    seen: list = []
    real_checkout, real_release = registry.checkout, registry.release

    class Rec:
        def __init__(self, raw):
            object.__setattr__(self, '_raw', raw)

        def execute(self, q, params=None, **k):
            seen.append((str(q), params))
            return self._raw.execute(q, params, **k)

        def __getattr__(self, n):
            return getattr(self._raw, n)

    def release(raw, database):
        return real_release(getattr(raw, '_raw', raw), database)
    registry.close_idle()
    with storage(True), patch.multiple(registry, checkout=lambda *a: Rec(real_checkout(*a)),
                                       release=release):
        fn()
    return seen


def plan_examined(plan: dict) -> int:
    """Rows a plan examined at its table and index nodes, rejected rows and repeated probes
    included (jobs-sol's guard, tests/test_orgdb_hot_paths_pg.py: ``examined``)."""
    def nodes(p):
        yield p
        for child in p.get('Plans', ()):
            yield from nodes(child)
    return sum((n.get('Actual Rows', 0) + n.get('Rows Removed by Filter', 0)
                + n.get('Rows Removed by Index Recheck', 0)) * n.get('Actual Loops', 0)
               for n in nodes(plan) if 'Relation Name' in n)


@needs_pg
class InsertRaces(unittest.TestCase):
    """Review f21: two transactions write the same doc key, at least one of them creating it,
    or insert the same new node. The first holds its transaction open until the second is
    seen waiting on the server; then it commits. Both stores must give the legacy outcome:
    the same rowcounts and the same final value."""

    def race(self, on: bool, slug: str, database: str, statement: str,
             first: tuple, second: tuple, second_statement: str | None = None) -> tuple:
        """(first's rowcount, second's rowcount or the exception it raised)."""
        out: dict = {}
        with storage(on):
            with store._POOL.acquire(slug) as a:
                a.execute('BEGIN IMMEDIATE')
                out['first'] = a.execute(statement, first).rowcount

                def other() -> None:
                    try:
                        with store._POOL.acquire(slug) as b:
                            b.execute('BEGIN IMMEDIATE')
                            try:
                                out['second'] = b.execute(second_statement or statement,
                                                          second).rowcount
                                b.execute('COMMIT')
                            except BaseException:
                                b.execute('ROLLBACK')
                                raise
                    except BaseException as e:       # noqa: BLE001  the outcome under test
                        out['second'] = e
                t = threading.Thread(target=other)
                t.start()
                waited = wait_for(lambda: lock_waiters(database) > 0)
                a.execute('COMMIT')
            t.join(60)
            self.assertFalse(t.is_alive(), 'the second insert never finished')
            self.assertTrue(waited, 'the second insert never waited for the first')
        return out['first'], out['second']

    def databases(self, t: 'Twins') -> list:
        return [(False, t.legacy, LEGACY), (True, t.copy, registry.lookup(t.copy)[1])]

    def test_an_absent_key_inserted_twice_keeps_do_nothing_and_the_first_value(self) -> None:
        t = Twins('insertrace')
        statement = 'INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
        for on, slug, database in self.databases(t):
            with self.subTest(storage='orgdb' if on else 'legacy'):
                got = self.race(on, slug, database, statement,
                                ('race_key', json.dumps({'by': 'first'})),
                                ('race_key', json.dumps({'by': 'second'})))
                self.assertEqual(got, (1, 0))
                with storage(on):
                    self.assertEqual(store.load_org(slug).d['race_key'], {'by': 'first'})

    def test_a_new_node_inserted_twice_refuses_the_second_and_keeps_the_first(self) -> None:
        t = Twins('noderace')
        statement = 'INSERT INTO nodes(id, ord, val) VALUES(?,?,?)'
        mine = {**node('racer', 'boss'), 'title': 'FIRST'}
        theirs = {**node('racer', 'boss'), 'title': 'SECOND'}
        for on, slug, database in self.databases(t):
            with self.subTest(storage='orgdb' if on else 'legacy'):
                first, second = self.race(on, slug, database, statement,
                                          ('racer', 99, json.dumps(mine)),
                                          ('racer', 99, json.dumps(theirs)))
                self.assertEqual(first, 1)
                self.assertIsInstance(second, sqlite3.IntegrityError)
                with storage(on):
                    self.assertEqual(store.load_org(slug).d['nodes']['racer']['title'], 'FIRST')

    INSERT = 'INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
    UPSERT = 'INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val'

    def value(self, on: bool, slug: str, key: str):
        """The doc row of ``key`` as the store answers it (None when absent)."""
        with storage(on):
            with store._POOL.acquire(slug) as c:
                row = c.execute('SELECT val FROM doc WHERE key=?', (key,)).fetchone()
        return None if row is None else json.loads(row[0])

    def absent_keys(self, t: 'Twins', tag: str) -> list:
        """(kind, key, first value, second value) for one key of each kind, absent in both
        stores: a key outside the registry, a settings key, a split owner row, a docket item."""
        from orgtree.orgdb.compat import rows as compat_rows
        sep = compat_rows.SEP
        settings = [k for k in ('cred_warned_at', 'desktop_import', 'headless', 'chain_notices',
                                'api_fallback_since', 'op_receipts_meta')
                    if all(self.value(on, slug, k) is None for on, slug, _ in self.databases(t))]
        self.assertGreaterEqual(len(settings), 2, 'no absent settings keys to race on')
        setting = settings[0] if tag == 'a' else settings[1]
        owner = 'ops' if tag == 'a' else 'boss'
        out = [('plain', f'race_{tag}', {'by': 'first'}, {'by': 'second'}),
               ('settings', setting, {'by': 'first'}, {'by': 'second'}),
               ('owner', f'mail{sep}{owner}', [{'id': 'r1', 'from': 'dev', 'body': 'first', 'at': AT}],
                [{'id': 'r2', 'from': 'dev', 'body': 'second', 'at': AT}]),
               ('item', f'work_items{sep}race-{tag}', item(f'race-{tag}', 'First'),
                item(f'race-{tag}', 'Second'))]
        for on, slug, _ in self.databases(t):
            for kind, key, _, _ in out:
                self.assertIsNone(self.value(on, slug, key), (kind, key))
        return out

    def test_an_insert_then_an_upsert_of_an_absent_key_ends_with_the_upserts_value(self) -> None:
        # review f21 (r2): the insert decided "absent" under its fence, the upsert did not take
        # it, committed in between, and the insert then overwrote it
        t = Twins('mixedrace')
        keys = self.absent_keys(t, 'a')
        for on, slug, database in self.databases(t):
            for kind, key, first, second in keys:
                with self.subTest(storage='orgdb' if on else 'legacy', kind=kind):
                    got = self.race(on, slug, database, self.INSERT,
                                    (key, json.dumps(first)), (key, json.dumps(second)),
                                    second_statement=self.UPSERT)
                    self.assertEqual(got, (1, 1))
                    self.assertEqual(self.value(on, slug, key), second)

    def test_an_upsert_then_an_insert_of_an_absent_key_keeps_the_upserts_value(self) -> None:
        t = Twins('mixedrace2')
        keys = self.absent_keys(t, 'b')
        for on, slug, database in self.databases(t):
            for kind, key, first, second in keys:
                with self.subTest(storage='orgdb' if on else 'legacy', kind=kind):
                    got = self.race(on, slug, database, self.UPSERT,
                                    (key, json.dumps(first)), (key, json.dumps(second)),
                                    second_statement=self.INSERT)
                    self.assertEqual(got, (1, 0))
                    self.assertEqual(self.value(on, slug, key), first)

    def test_an_upsert_cannot_commit_between_an_inserts_absent_check_and_its_write(self) -> None:
        # review f21's measured interleaving, made deterministic: the insert that does
        # nothing on conflict is paused right after it found the key absent; an upsert of
        # the key then starts. Fenced, the upsert waits for the insert and replaces its
        # value (the legacy outcome); unfenced it committed in the gap and the insert then
        # overwrote it
        from unittest.mock import patch
        from orgtree.orgdb.compat import rows as compat_rows
        t = Twins('reviewrace')
        key, first, second = 'race_review', {'by': 'insert'}, {'by': 'upsert'}
        database = registry.lookup(t.copy)[1]
        original = compat_rows.doc_get
        gate, decided = threading.Event(), threading.Event()
        out: dict = {}

        def paused(c, k, **kw):
            got = original(c, k, **kw)
            if k == key and got is None and threading.current_thread().name == 'inserter':
                decided.set()
                gate.wait(30)
            return got

        def writer(name: str, statement: str, value: dict) -> None:
            try:
                with store._POOL.acquire(t.copy) as c:
                    c.execute('BEGIN IMMEDIATE')
                    try:
                        out[name] = c.execute(statement, (key, json.dumps(value))).rowcount
                        c.execute('COMMIT')
                    except BaseException:
                        c.execute('ROLLBACK')
                        raise
                out[name + '_committed'] = True
            except BaseException as e:       # noqa: BLE001  the outcome under test
                out[name] = e
        with storage(True), patch.object(compat_rows, 'doc_get', paused):
            ins = threading.Thread(target=writer, name='inserter', args=('insert', self.INSERT, first))
            ins.start()
            self.assertTrue(decided.wait(30), 'the insert never reached its absent decision')
            up = threading.Thread(target=writer, name='upserter', args=('upsert', self.UPSERT, second))
            up.start()
            wait_for(lambda: out.get('upsert_committed') or lock_waiters(database) > 0)
            gate.set()
            ins.join(60)
            up.join(60)
            self.assertFalse(ins.is_alive() or up.is_alive(), out)
        self.assertEqual((out['insert'], out['upsert']), (1, 1))
        self.assertEqual(self.value(True, t.copy, key), second)

    def test_two_upserts_of_a_section_leave_the_second_value_whole(self) -> None:
        # without a fence both upserts of an absent section wrote their records and neither
        # removed the other's: the section came back holding both values merged
        t = Twins('upsertrace')
        key = next((k for k in ('credit_requests', 'scope_requests')
                    if all(self.value(on, slug, k) is None for on, slug, _ in self.databases(t))),
                   'credit_requests')
        req = lambda rid, n: {'id': rid, 'node': 'dev', 'old': n, 'new': n + 1, 'at': AT,  # noqa: E731
                              'status': 'pending'}
        rounds = [([req('c1', 1), req('c2', 2)], [req('c3', 3)]),        # absent, then present
                  ([req('c4', 4)], [req('c5', 5), req('c6', 6)])]
        for on, slug, database in self.databases(t):
            for n, (first, second) in enumerate(rounds):
                with self.subTest(storage='orgdb' if on else 'legacy', round=n):
                    got = self.race(on, slug, database, self.UPSERT,
                                    (key, json.dumps(first)), (key, json.dumps(second)))
                    self.assertEqual(got, (1, 1))
                    self.assertEqual(self.value(on, slug, key), second)
                    with storage(on):
                        self.assertEqual(store.load_org(slug).d[key], second)

    def test_an_upsert_waits_for_an_org_tx_that_locked_the_section_without_deadlock(self) -> None:
        # an org_tx locks the section's row first; an upsert outside it used to delete the
        # section's records and then wait for that row, while the org_tx's save waited for
        # those records: a deadlock. It now waits at the row, holding nothing
        t = Twins('planrace')
        theirs = [{'id': 'q9', 'node': 'ops', 'question': 'theirs?', 'at': AT, 'status': 'open'}]
        for on, slug, database in self.databases(t):
            with self.subTest(storage='orgdb' if on else 'legacy'):
                out: dict = {}
                with storage(on):
                    with orgtx.org_tx(slug, sections=['asks']) as tx:
                        def other() -> None:
                            try:
                                with store._POOL.acquire(slug) as b:
                                    b.execute('BEGIN IMMEDIATE')
                                    try:
                                        out['rows'] = b.execute(
                                            self.UPSERT, ('asks', json.dumps(theirs))).rowcount
                                        b.execute('COMMIT')
                                    except BaseException:
                                        b.execute('ROLLBACK')
                                        raise
                            except BaseException as e:       # noqa: BLE001  the outcome under test
                                out['rows'] = e
                        th = threading.Thread(target=other)
                        th.start()
                        self.assertTrue(wait_for(lambda: lock_waiters(database) > 0),
                                        'the upsert never waited for the org_tx')
                        tx.d['asks'].append({'id': 'q8', 'node': 'dev', 'question': 'mine?',
                                             'at': AT, 'status': 'open'})
                    th.join(60)
                    self.assertFalse(th.is_alive(), 'the upsert never finished')
                    self.assertEqual(out['rows'], 1)
                    self.assertEqual(store.load_org(slug).d['asks'], theirs)

    def test_a_settings_upsert_waits_for_a_whole_org_tx_without_deadlock(self) -> None:
        # review f24: a whole-org transaction locks every row, the seeded settings key's
        # included; a settings upsert outside it took the settings fence and then waited for
        # that row, while the whole transaction's save then needed the fence: PostgreSQL
        # 40P01. The whole transaction now takes the fence before any row. (The switch-on
        # store only: a legacy whole transaction holds no doc rows, so there is no wait.)
        t = Twins('wholerace')
        database = registry.lookup(t.copy)[1]
        out: dict = {}
        with storage(True):
            org = store.load_org(t.copy)
            org.d['max_children'] = 3                          # seeded: its row exists
            store.save_org(org)
            with orgtx.org_tx(t.copy, whole=True) as tx:
                def other() -> None:
                    try:
                        with store._POOL.acquire(t.copy) as b:
                            b.execute('BEGIN IMMEDIATE')
                            try:
                                out['rows'] = b.execute(self.UPSERT,
                                                        ('max_children', json.dumps(5))).rowcount
                                b.execute('COMMIT')
                            except BaseException:
                                b.execute('ROLLBACK')
                                raise
                    except BaseException as e:       # noqa: BLE001  the outcome under test
                        out['rows'] = e
                th = threading.Thread(target=other)
                th.start()
                self.assertTrue(wait_for(lambda: lock_waiters(database) > 0),
                                'the upsert never waited for the whole-org transaction')
                tx.d['max_children'] = 7
            th.join(60)
            self.assertFalse(th.is_alive(), 'the upsert never finished')
            self.assertEqual(out['rows'], 1)
            self.assertEqual(store.load_org(t.copy).d['max_children'], 5)

    def test_a_settings_writer_over_all_nodes_and_a_named_one_both_commit(self) -> None:
        # review f24 (ALL plans, settingstx.whole_org_tx's path): a transaction over ALL nodes
        # locked node:* and every agent row before its block took the settings fence; a
        # named-node settings writer took the fence in its block, then waited for node:*: a
        # deadlock. The ALL transaction is paused right after its early locks (before its
        # block), the named one starts in that gap; both must commit
        from unittest.mock import patch
        from orgtree.orgdb.compat import tx as compat_tx
        t = Twins('allrace')
        database = registry.lookup(t.copy)[1]
        real = compat_tx._lock_rows
        paused, release = threading.Event(), threading.Event()
        out: dict = {}

        def slow(*a, **k):
            if threading.current_thread().name == 'all-nodes':
                paused.set()
                release.wait(30)
            return real(*a, **k)

        def body(name: str, value: int, nodes) -> None:
            try:
                # retries=0: org_tx would retry a deadlock's victim and hide the deadlock
                with orgtx.org_tx(t.copy, nodes=nodes, sections=['max_children'],
                                  retries=0) as tx:
                    tx.d['max_children'] = value
                out[name] = 'committed'
            except BaseException as e:       # noqa: BLE001  the outcome under test
                out[name] = e
        with storage(True):
            org = store.load_org(t.copy)
            org.d['max_children'] = 3                          # seeded
            store.save_org(org)
            with patch.object(compat_tx, '_lock_rows', slow):
                a = threading.Thread(target=body, name='all-nodes', args=('all', 7, orgtx.ALL))
                a.start()
                try:
                    self.assertTrue(paused.wait(30), 'the ALL transaction never took its early locks')
                    b = threading.Thread(target=body, name='named', args=('named', 5, ['dev']))
                    b.start()
                    self.assertTrue(wait_for(lambda: lock_waiters(database) > 0),
                                    'the named transaction never waited')
                finally:
                    release.set()
                    a.join(60)
                b.join(60)
            self.assertEqual(out, {'all': 'committed', 'named': 'committed'})
            self.assertEqual(store.load_org(t.copy).d['max_children'], 5)

    def test_settings_writers_share_one_fence(self) -> None:
        # every settings key is one row: one transaction writing settings A then B, and
        # another writing B, must queue whole, not each hold a key the other needs
        t = Twins('settingsrace')
        a_key, b_key = [k for k in ('cred_warned_at', 'desktop_import', 'headless')
                        if self.value(True, t.copy, k) is None][:2]
        out: dict = {}
        with storage(True):
            with store._POOL.acquire(t.copy) as a:
                a.execute('BEGIN IMMEDIATE')
                a.execute(self.UPSERT, (a_key, json.dumps('a1')))

                def other() -> None:
                    try:
                        with store._POOL.acquire(t.copy) as b:
                            b.execute('BEGIN IMMEDIATE')
                            try:
                                out['b'] = b.execute(self.UPSERT, (b_key, json.dumps('b2'))).rowcount
                                b.execute('COMMIT')
                            except BaseException:
                                b.execute('ROLLBACK')
                                raise
                    except BaseException as e:       # noqa: BLE001  the outcome under test
                        out['b'] = e
                th = threading.Thread(target=other)
                th.start()
                self.assertTrue(wait_for(lambda: lock_waiters(registry.lookup(t.copy)[1]) > 0))
                a.execute(self.UPSERT, (b_key, json.dumps('b1')))
                a.execute('COMMIT')
            th.join(60)
            self.assertFalse(th.is_alive())
        self.assertEqual(out['b'], 1)
        self.assertEqual(self.value(True, t.copy, a_key), 'a1')
        self.assertEqual(self.value(True, t.copy, b_key), 'b2')


@needs_pg
class Feed(unittest.TestCase):
    """pgfeed.orgdb_conn: the revision feed LISTENs on every org's own database."""

    def test_each_org_database_feeds_the_one_feed(self) -> None:
        from orgtree import pgfeed
        a, b = Twins('feed a'), Twins('feed b')
        calls: list = []
        sessions: list = []

        def connect():
            s = pgfeed.orgdb_conn()
            sessions.append(s)
            return s
        with storage(True):
            feed = pgfeed.RevisionFeed(connect, lambda s, v, g: calls.append((s, v, g)),
                                       poll_s=0.3, retry_s=0.05)
            feed.start()
            self.addCleanup(feed.stop)
            self.assertTrue(wait_for(lambda: feed.last_seen(a.copy) is not None
                                     and feed.last_seen(b.copy) is not None), 'no catch-up')

            def rename(slug: str, title: str) -> None:
                org = store.load_org(slug)
                org.d['nodes']['dev']['title'] = title
                store.save_org(org)
            # a save in each org arrives as a notification from that org's database
            for t in (a, b):
                r = feed.last_seen(t.copy)
                rename(t.copy, 'fed')
                self.assertTrue(wait_for(lambda: (t.copy, r + 1, False) in calls), calls)
            self.assertGreaterEqual(feed.stats.notifications, 2)
            # an org created after the start is listened to from the next poll on
            org = store.create_org('Fed Later')
            later = org.d['slug']
            self.assertTrue(wait_for(lambda: feed.last_seen(later) is not None), 'never polled')
            r = feed.last_seen(later)
            n = feed.stats.notifications
            org = store.load_org(later)
            org.d['nodes']['x'] = {'name': 'x', 'parent': None}
            store.save_org(org)
            self.assertTrue(wait_for(lambda: (later, r + 1, False) in calls), calls)
            self.assertGreater(feed.stats.notifications, n)
            # a commit whose NOTIFY never came (another session) is found by the poll: a gap
            row = registry.lookup(a.copy)
            with dbconn.connect(RUNTIME, row[1]) as c:
                rev = int(c.execute('UPDATE orgtree.org_revision SET rev = rev + 1 '
                                    'RETURNING rev').fetchone()[0])
            self.assertTrue(wait_for(lambda: (a.copy, rev, True) in calls), calls)
            # one org's session failing costs only that org: b's listener is terminated
            s = sessions[-1]
            pid = s.c[b.copy][1].info.backend_pid
            with dbconn.connect(ADMIN, 'postgres') as c:
                self.assertTrue(c.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
            ra, rb = feed.last_seen(a.copy), feed.last_seen(b.copy)
            rename(a.copy, 'still fed')
            self.assertTrue(wait_for(lambda: (a.copy, ra + 1, False) in calls), calls)
            self.assertTrue(wait_for(lambda: any(b.copy in e for e in s.errors)), s.errors)
            self.assertTrue(wait_for(lambda: b.copy in s.c and s.c[b.copy][1].info.backend_pid != pid),
                            'b was not listened to again')
            rename(b.copy, 'fed again')
            self.assertTrue(wait_for(lambda: feed.last_seen(b.copy) == rb + 1), calls)
            self.assertEqual(feed.stats.reconnects, 0)        # the feed itself never dropped


@needs_pg
class Create(unittest.TestCase):
    def test_create_publishes_an_active_org(self) -> None:
        with storage(True):
            org = store.create_org('Born Here')
            slug = org.d['slug']
            want = json.loads(json.dumps(org.d))
            row = registry.lookup(slug)
            self.assertIsNotNone(row)
            self.assertEqual(row[2], 'active')
            self.assertEqual(row[1], names.org(row[0], PREFIX))
            self.assertEqual(run.differences(want, document(slug)), [])
            self.assertIn(slug, store.org_slugs())
            populate(slug)
            got = document(slug)
            self.assertEqual(sorted(got['nodes']), ['boss', 'dev', 'ops'])
            with self.assertRaises(store.LedgerError):
                store.create_org('Born Here')

    def test_failed_first_save_leaves_nothing(self) -> None:
        with storage(True):
            def poison(org) -> None:
                org.d['compact_at'] = float('nan')     # no column can hold it (ShapeError)
            with self.assertRaises(Exception):
                store.create_org('Never Born', prepare=poison)
            self.assertIsNone(registry.lookup('never-born'))
            with dbconn.connect(ADMIN, 'postgres') as c:
                left = [r[0] for r in c.execute(
                    "SELECT datname FROM pg_database WHERE datname LIKE %s",
                    (PREFIX + 'stage%',)).fetchall()]
            self.assertEqual(left, [])

    def stages_left(self) -> list:
        with dbconn.connect(ADMIN, 'postgres') as c:
            return [r[0] for r in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                                            (PREFIX + 'stage%',)).fetchall()]

    def test_a_staging_build_failure_leaves_nothing_and_the_name_is_free(self) -> None:
        # review f23: the error comes BEFORE begin_create returns its Build
        from unittest.mock import patch
        with storage(True):
            with patch.object(lifecycle.Lifecycle, '_migrate_org_db',
                              side_effect=RuntimeError('planted build failure')):
                with self.assertRaisesRegex(RuntimeError, 'planted build failure'):
                    store.create_org('Failure Before First Save')
            self.assertIsNone(registry.lookup('failure-before-first-save'))
            self.assertEqual(self.stages_left(), [])
            org = store.create_org('Failure Before First Save')       # the name is free at once
            self.assertEqual(org.d['slug'], 'failure-before-first-save')
            self.assertEqual(registry.lookup('failure-before-first-save')[2], 'active')
            self.assertEqual(self.stages_left(), [])


@needs_pg
class Delete(unittest.TestCase):
    """Piece A3: store.delete_org with the switch on is the org lifecycle's trash."""

    def test_delete_trashes_the_org_moves_its_folder_and_frees_the_name(self) -> None:
        from orgtree.ledger import LedgerError
        with storage(True):
            slug = store.create_org('Delete Me').d['slug']
            ws = Path(store.workspace_dir(slug))
            (ws / 'note.txt').write_text('mine', encoding='utf-8')
            org_id = registry.lookup(slug)[0]
            store.delete_org(slug)
            self.assertIsNone(registry.lookup(slug))            # trashed rows are set aside
            with self.assertRaises(LedgerError):
                store.load_org(slug)
            row = LC[0].row(org_id)
            self.assertEqual((row['state'], names.kind(row['database'], PREFIX)), ('trashed', 'trash'))
            keep = Path(LC[0].trash_folder(str(DATA / 'deleted'), slug, row['database'], org_id))
            self.assertEqual((keep / 'workspace' / 'note.txt').read_text(encoding='utf-8'), 'mine')
            self.assertFalse(ws.exists())
            again = store.create_org('Delete Me')               # the name is free: another org
            self.assertEqual(again.d['slug'], slug)
            self.assertNotEqual(registry.lookup(slug)[0], org_id)
            with self.assertRaises(LedgerError):
                store.delete_org('no-such-org')

    def test_a_delete_asked_again_while_one_runs_is_refused(self) -> None:
        # review A3 f1: the org is closing while the first delete moves its folders; the same
        # delete asked again (which skips org_exclusive for a closing org) is refused, as a
        # LockTimeout the route answers 409, and the first completes
        from unittest.mock import patch
        original = lifecycle.Lifecycle._move_once
        moving, release = threading.Event(), threading.Event()
        out: dict = {}

        def slow(src: str, dst: str) -> None:
            if threading.current_thread().name == 'deleter':
                moving.set()
                release.wait(30)
            original(src, dst)
        with storage(True), patch.object(lifecycle.Lifecycle, '_move_once', staticmethod(slow)):
            slug = store.create_org('Twice Deleted').d['slug']

            def first() -> None:
                try:
                    store.delete_org(slug)
                    out['first'] = 'done'
                except BaseException as e:       # noqa: BLE001  the outcome under test
                    out['first'] = e
            th = threading.Thread(target=first, name='deleter')
            th.start()
            try:
                self.assertTrue(moving.wait(30), 'the first delete never reached its folders')
                self.assertEqual(registry.lookup(slug)[2], 'closing')
                with self.assertRaises(orgtx.LockTimeout):
                    store.delete_org(slug)
            finally:
                release.set()
                th.join(60)
            self.assertEqual(out['first'], 'done')
            self.assertIsNone(registry.lookup(slug))

    def test_an_org_tx_in_flight_holds_the_delete_off(self) -> None:
        # as the legacy delete: it waits for an org_tx in flight; past the lock timeout it is
        # refused (the API answers 409) and nothing has moved
        from unittest.mock import patch
        with storage(True):
            slug = store.create_org('Busy Org').d['slug']
            entered, done = threading.Event(), threading.Event()

            def holder() -> None:
                with orgtx.org_tx(slug, sections=['asks']):
                    entered.set()
                    done.wait(30)
            th = threading.Thread(target=holder)
            th.start()
            try:
                self.assertTrue(entered.wait(30))
                with patch.object(orgtx, 'DEFAULT_LOCK_TIMEOUT_S', 0.5):
                    with self.assertRaises(orgtx.LockTimeout):
                        store.delete_org(slug)
                self.assertEqual(registry.lookup(slug)[2], 'active')
                self.assertIsNone(LC[0].row(registry.lookup(slug)[0])['op_kind'])
            finally:
                done.set()
                th.join(60)
            store.delete_org(slug)
            self.assertIsNone(registry.lookup(slug))


if __name__ == '__main__':
    unittest.main()
