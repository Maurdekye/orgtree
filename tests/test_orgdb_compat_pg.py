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
            with pgstore.connect() as c:
                receipts = legacy.receipts(c, pgstore.read_marker(
                    str(DATA / 'orgs' / f'{self.legacy}.pg')))
        self.copy = f'{self.legacy}-c'
        doc['slug'] = self.copy
        secs = mappers.sections()
        rows, _, _ = sections.encode_document(doc, secs, ignored=mappers.ignored_keys())
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
                with orgtx.org_tx(t.copy, nodes=nodes, sections=['max_children']) as tx:
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


if __name__ == '__main__':
    unittest.main()
