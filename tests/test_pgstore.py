"""PG-0: ORGTREE_STORE=postgres behind the seam, and org_tx on PostgreSQL.

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL  a superuser URL; the test creates and drops its
                             own database `orgtree_pg0_t<pid>` on that server
  ORGTREE_TEST_PYDEPS        (optional) a folder holding psycopg, until the
                             packaged runtime carries it
Without the URL every test SKIPS — a skip is not a pass.

What it proves:
  * migrations: 0001 applies once, a re-run is a no-op, an edited applied
    file and an unknown applied migration both refuse (MigrationDrift);
  * the seam: create/save/load round-trips small sections, nodes and a lazy
    log; a delete moves the marker to the trash and the org is gone;
  * every changing save bumps orgs.revision by one and NOTIFYs
    org_rev '<slug>:<revision>'; a no-change save does neither;
  * org_tx: named writes commit, an unlocked write refuses and nothing lands,
    FOR UPDATE blocks the same row and not another, FOR SHARE admits sharers
    and blocks a writer, 4 racing incrementers lose nothing, a receipt
    replays, and RT6: a connection lost after COMMIT, retried with the same
    op_key, has exactly one outcome.

Run:  python tools/run-python-verification.py tests/test_pgstore.py
"""

import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DEPS = os.environ.get('ORGTREE_TEST_PYDEPS', '').strip()
#: optional: the engine's non-superuser role on the same server (PG-1's
#: `orgtree_runtime`), to prove the grants migration
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
if DEPS:
    sys.path.insert(0, DEPS)

_temp = tempfile.TemporaryDirectory(prefix='v3-pgstore-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
DBNAME = f'orgtree_pg0_t{os.getpid()}'


def _with_db(url: str, db: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, '/' + db, p.query, p.fragment))


if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS {DBNAME}')
        c.execute(f'CREATE DATABASE {DBNAME}')
    os.environ['ORGTREE_PG_URL'] = _with_db(ADMIN, DBNAME)

os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='postgres')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, pgstore, store  # noqa: E402

# These suites prove ROW-lock behaviour, which the transition fence (every
# org_tx behind DOC_LOCK, plan decision 19) would serialize away; the fence
# has its own tests, which turn it back on.
orgtx.TRANSITION_FENCE = False


def tearDownModule() -> None:
    if ADMIN:
        import psycopg
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS {DBNAME} WITH (FORCE)')


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in ('a', 'b', 'c'):
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    org.d['killswitch'] = {'on': False}
    org.d['settings_x'] = {'v': 0}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _node(slug: str, nid: str) -> dict:
    return store.load_org(slug).d['nodes'][nid]


def _rev(slug: str) -> int:
    with pgstore.connect() as c:
        return int(c.execute('SELECT revision FROM orgs WHERE slug=%s', (slug,)).fetchone()[0])


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class Migrations(unittest.TestCase):
    def test_applies_once_and_refuses_drift(self) -> None:
        res = pgstore.migrate(os.environ['ORGTREE_PG_URL'])     # conninfo form (PG-1)
        self.assertEqual(Path(res['folder']), pgstore.MIGRATIONS_DIR.resolve())
        self.assertIn('0002_runtime_grants.sql', res['current'])
        with pgstore.connect() as c:
            self.assertEqual(pgstore.migrate(c)['applied'], [])
            self.assertEqual({r[0] for r in c.execute(
                'SELECT name FROM schema_migrations').fetchall()}, set(res['current']))
            d = Path(tempfile.mkdtemp(dir=_temp.name))
            shutil.copy(pgstore.MIGRATIONS_DIR / '0001_base.sql', d / '0001_base.sql')
            (d / '0001_base.sql').write_bytes((d / '0001_base.sql').read_bytes() + b'\n-- edit\n')
            with self.assertRaises(pgstore.MigrationDrift):
                pgstore.migrate(c, d)
            (d / '0001_base.sql').unlink()
            with self.assertRaises(pgstore.MigrationDrift):
                pgstore.migrate(c, d)            # the db has ones this dir lacks

    @unittest.skipUnless(RUNTIME, 'ORGTREE_TEST_PG_RUNTIME_URL not set: NOT RUN')
    def test_engine_role_can_create_write_and_org_tx(self) -> None:
        with pgstore.connect() as c:
            pgstore.migrate(c)
            c.execute(f'GRANT CONNECT, TEMP ON DATABASE {DBNAME} TO orgtree_runtime')
        store.claim_data_root()
        old = os.environ['ORGTREE_PG_URL']
        os.environ['ORGTREE_PG_URL'] = _with_db(RUNTIME, DBNAME)
        try:
            with pgstore.connect() as c:
                self.assertEqual(c.execute('SELECT current_user').fetchone()[0], 'orgtree_runtime')
                with self.assertRaises(Exception):
                    c.execute('CREATE TABLE public.nope (x int)')
            slug = _fresh_org('runtime-role')          # schema via SECURITY DEFINER
            with orgtx.org_tx(slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'rt'
            self.assertEqual(_node(slug, 'a')['name'], 'rt')
        finally:
            os.environ['ORGTREE_PG_URL'] = old

    def test_json_extract(self) -> None:
        with pgstore.connect() as c:
            pgstore.migrate(c)
            one = c.execute("SELECT json_extract('{\"a\":{\"b\":\"x\"},\"n\":3}', '$.a.b')").fetchone()[0]
            many = c.execute("SELECT json_extract('{\"a\":1,\"b\":\"y\"}', '$.a', '$.b')").fetchone()[0]
        self.assertEqual(one, 'x')
        self.assertEqual(many.replace(' ', ''), '[1,"y"]')


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class Seam(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        store.claim_data_root()          # migrates

    def test_round_trip_and_delete(self) -> None:
        slug = _fresh_org('seam-rt')
        org = store.load_org(slug)
        store.log_append(org.d, 'events', {'kind': 'hello', 'at': '2026-09-25T00:00:00Z'})
        org.d['nodes']['b']['name'] = 'Bee'
        store.save_org(org)
        again = store.load_org(slug)
        self.assertEqual(again.d['nodes']['b']['name'], 'Bee')
        self.assertEqual(again.d['settings_x'], {'v': 0})
        self.assertIn('hello', [e.get('kind') for e in again.d['events']])
        self.assertTrue(os.path.exists(store.org_path(slug)))
        self.assertTrue(store.org_path(slug).endswith('.pg'))
        self.assertIn(slug, [o['slug'] for o in store.list_orgs()])
        store.delete_org(slug)
        self.assertNotIn(slug, [o['slug'] for o in store.list_orgs()])
        with self.assertRaises(Exception):
            store.load_org(slug)
        # the name is free again, and a new org under it starts empty
        slug2 = _fresh_org('seam-rt')
        self.assertEqual(slug2, slug)
        self.assertEqual(_node(slug, 'b')['name'], 'b')

    def _pg(self, sql: str, *args):
        with psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True) as c:
            return c.execute(sql, args).fetchall()

    def test_create_is_atomic_marker_after_commit(self) -> None:
        from unittest.mock import patch
        schemas_before = {r[0] for r in self._pg(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'org_%%'")}
        real = store._write_doc

        def boom(*a, **k):
            real(*a, **k)
            raise RuntimeError('crash after the rows, before COMMIT')
        with patch.object(store, '_write_doc', boom):
            with self.assertRaises(Exception):
                store.create_org('atomic-one')
        self.assertFalse(os.path.exists(store.org_path('atomic-one')), 'no marker')
        self.assertEqual(self._pg("SELECT count(*) FROM orgs WHERE slug = %s", 'atomic-one')[0][0], 0)
        schemas_after = {r[0] for r in self._pg(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'org_%%'")}
        self.assertEqual(schemas_after, schemas_before, 'no half-made schema')
        slug = _fresh_org('atomic-one')                   # and the name still works
        self.assertEqual(_node(slug, 'a')['name'], 'a')

    def test_claim_retires_a_live_row_without_a_marker(self) -> None:
        slug = _fresh_org('unmarked-one')
        os.remove(store.org_path(slug))                    # the marker is lost
        retired = pgstore.retire_unmarked(os.path.join(str(data), 'orgs'))
        self.assertIn(slug, retired)
        self.assertEqual(self._pg("SELECT count(*) FROM orgs WHERE slug = %s AND deleted_at IS NULL",
                                  slug)[0][0], 0)
        again = _fresh_org('unmarked-one')                 # the name is free, and empty
        self.assertEqual(_node(again, 'a')['name'], 'a')

    def test_many_orgs_share_a_bounded_connection_pool(self) -> None:
        slugs = [_fresh_org(f'pool-{i}') for i in range(30)]
        for s in slugs:
            store.load_org(s).d['events']            # a lazy read, too
        with psycopg.connect(ADMIN, autocommit=True) as c:
            n = c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname = %s',
                          (DBNAME,)).fetchone()[0]
        self.assertLessEqual(n, pgstore._IDLE_CAP + 2, f'{n} server connections for 30 orgs')

    def test_revision_and_notify(self) -> None:
        slug = _fresh_org('seam-rev')
        listen = psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True)
        try:
            listen.execute('LISTEN org_rev')
            r0 = _rev(slug)
            org = store.load_org(slug)
            org.d['nodes']['a']['name'] = 'A'
            store.save_org(org)
            store.save_org(store.load_org(slug))          # no change
            self.assertEqual(_rev(slug), r0 + 1)
            got = [n.payload for n in listen.notifies(timeout=2, stop_after=1)]
            self.assertEqual(got, [f'{slug}:{r0 + 1}'])
            self.assertEqual(list(listen.notifies(timeout=0.5)), [])
        finally:
            listen.close()


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class OrgTxOnPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        store.claim_data_root()
        orgtx.use_backend(orgtx.PgBackend())

    def setUp(self) -> None:
        self.slug = _fresh_org(f'pg-{self._testMethodName}'[:60])

    def test_named_write_commits_unlocked_refused(self) -> None:
        r0 = _rev(self.slug)
        with orgtx.org_tx(self.slug, nodes=['a'], sections=['killswitch']) as tx:
            tx.d['nodes']['a']['name'] = 'A'
            tx.d['killswitch']['on'] = True
        self.assertEqual(tx.revision, r0 + 1)
        self.assertEqual(_node(self.slug, 'a')['name'], 'A')
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'AA'
                tx.d['nodes']['b']['name'] = 'BB'
        self.assertEqual(_node(self.slug, 'a')['name'], 'A')
        self.assertEqual(_node(self.slug, 'b')['name'], 'b')
        self.assertEqual(_rev(self.slug), r0 + 1)

    def _hold(self, entered, release, **names):
        def run():
            with orgtx.org_tx(self.slug, **names):
                entered.set()
                release.wait(10)
        t = threading.Thread(target=run)
        t.start()
        self.assertTrue(entered.wait(10))
        return t

    def _try(self, **names) -> str:
        try:
            with orgtx.org_tx(self.slug, lock_timeout=0.3, **names):
                return 'got'
        except orgtx.LockTimeout:
            return 'blocked'

    def test_update_and_share_blocking(self) -> None:
        e, r = threading.Event(), threading.Event()
        t = self._hold(e, r, nodes=['a'], share_sections=['killswitch'])
        try:
            self.assertEqual(self._try(nodes=['a']), 'blocked')
            self.assertEqual(self._try(nodes=['b']), 'got')
            self.assertEqual(self._try(share_sections=['killswitch']), 'got')
            self.assertEqual(self._try(sections=['killswitch']), 'blocked')
            self.assertEqual(self._try(nodes=['zz-new']), 'got')     # a missing row
        finally:
            r.set()
            t.join()
        self.assertEqual(self._try(nodes=['a'], sections=['killswitch']), 'got')

    def test_all_nodes_excludes_node_writers_and_creators(self) -> None:
        e, r = threading.Event(), threading.Event()
        t = self._hold(e, r, nodes=orgtx.ALL)
        try:
            self.assertEqual(self._try(nodes=['b']), 'blocked')
            self.assertEqual(self._try(nodes=['brand-new']), 'blocked')
            self.assertEqual(self._try(sections=['killswitch']), 'got')
        finally:
            r.set()
            t.join()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
            for n in tx.d['nodes'].values():
                n['swept'] = True
        self.assertTrue(all(_node(self.slug, x).get('swept') for x in ('a', 'b', 'c')))

    def test_multi_org_is_one_atomic_transaction(self) -> None:
        other = _fresh_org(f'pg2-{self._testMethodName}'[:60])
        r0a, r0b = _rev(self.slug), _rev(other)
        listen = psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True)
        try:
            listen.execute('LISTEN org_rev')
            with orgtx.org_tx_multi({self.slug: dict(nodes=['a']),
                                     other: dict(sections=['killswitch'])}) as t:
                t[self.slug].d['nodes']['a']['name'] = 'mA'
                t[other].d['killswitch']['on'] = True
            got = sorted(n.payload for n in listen.notifies(timeout=2, stop_after=2))
        finally:
            listen.close()
        self.assertEqual(got, sorted([f'{self.slug}:{r0a + 1}', f'{other}:{r0b + 1}']))
        self.assertEqual(_node(self.slug, 'a')['name'], 'mA')
        self.assertTrue(store.load_org(other).d['killswitch']['on'])
        # atomic: an unlocked write in the SECOND org leaves the first unwritten
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx_multi({self.slug: dict(nodes=['a']),
                                     other: dict(nodes=['a'])}) as t:
                t[self.slug].d['nodes']['a']['name'] = 'lost'
                t[other].d['nodes']['b']['name'] = 'unlocked'
        self.assertEqual(_node(self.slug, 'a')['name'], 'mA')
        self.assertEqual(_node(other, 'b')['name'], 'b')
        self.assertEqual((_rev(self.slug), _rev(other)), (r0a + 1, r0b + 1))

    # ---- review 42d445a (native-design-review): B1-B3, N1, N2 -------------

    def _seed_mail(self) -> None:
        org = store.load_org(self.slug)
        org.d.setdefault('mail_log', {})['a'] = [{'id': 'm1', 'body': 'one'}, {'id': 'm2', 'body': 'two'}]
        store.save_org(org)

    def _mail_ids(self) -> list:
        return [m['id'] for m in store.load_org(self.slug).d['mail_log'].get('a', [])]

    def test_b1_owner_log_lock_edits_and_blocks(self) -> None:
        self._seed_mail()
        with orgtx.org_tx(self.slug, logs=[('mail_log', 'a')]) as tx:
            tx.d['mail_log']['a'][0]['body'] = 'edited'
        self.assertEqual(store.load_org(self.slug).d['mail_log']['a'][0]['body'], 'edited')
        e, r = threading.Event(), threading.Event()
        t = self._hold(e, r, logs=[('mail_log', 'a')])
        try:
            self.assertEqual(self._try(logs=[('mail_log', 'a')]), 'blocked')
            self.assertEqual(self._try(logs=[('mail_log', 'b')]), 'got')
        finally:
            r.set()
            t.join()

    def test_b2_stale_legacy_save_cannot_drop_or_overwrite_log_rows(self) -> None:
        self._seed_mail()
        legacy = store.load_org(self.slug)
        seen = list(legacy.d['mail_log']['a'])          # the owner is READ (a baseline)
        legacy.d['mail_log']['a'] = seen[:1]            # then replaced
        # (a replace of an owner never read has no baseline and stays a blind
        # overwrite, as on SQLite: a documented limit of the compare-and-set)
        with orgtx.org_tx(self.slug, logs=['mail_log']) as tx:
            tx.d['mail_log']['a'].append({'id': 'm-tx', 'body': 'tx'})
        with self.assertRaises(store.StaleWrite):
            store.save_org(legacy)
        self.assertEqual(self._mail_ids(), ['m1', 'm2', 'm-tx'])
        # an in-place edit racing an org_tx edit of the same row
        legacy = store.load_org(self.slug)
        legacy.d['mail_log']['a'][0]['body'] = 'legacy'
        with orgtx.org_tx(self.slug, logs=[('mail_log', 'a')]) as tx:
            tx.d['mail_log']['a'][0]['body'] = 'tx-edit'
        with self.assertRaises(store.StaleWrite):
            store.save_org(legacy)
        self.assertEqual(store.load_org(self.slug).d['mail_log']['a'][0]['body'], 'tx-edit')
        # control: a legacy incremental APPEND keeps both rows and saves
        legacy = store.load_org(self.slug)
        legacy.d['mail_log']['a'].append({'id': 'm-legacy'})
        with orgtx.org_tx(self.slug, logs=['mail_log']) as tx:
            tx.d['mail_log']['a'].append({'id': 'm-tx2'})
        store.save_org(legacy)
        self.assertEqual(sorted(self._mail_ids()[-2:]), ['m-legacy', 'm-tx2'])

    def test_b3_lock_timeout_does_not_leak_into_later_saves(self) -> None:
        with orgtx.org_tx(self.slug, nodes=['c'], lock_timeout=0.3):
            pass                                    # returns its connection
        e, r = threading.Event(), threading.Event()
        t = self._hold(e, r, nodes=['a'])
        threading.Timer(1.5, r.set).start()
        try:
            legacy = store.load_org(self.slug)
            legacy.d['nodes']['a']['name'] = 'after-wait'
            t0 = time.monotonic()
            store.save_org(legacy)                  # waits for the holder, then saves
            waited = time.monotonic() - t0
        finally:
            r.set()
            t.join()
        self.assertGreater(waited, 1.0)
        self.assertEqual(_node(self.slug, 'a')['name'], 'after-wait')

    def test_p2_legacy_writer_waits_on_the_row_then_refuses(self) -> None:
        os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
        paused, go = threading.Event(), threading.Event()

        def hook(point, tx):
            if point == 'before_commit' and tx.slug == self.slug:
                paused.set()
                go.wait(10)
        errs: list = []

        def body():
            try:
                with orgtx.org_tx(self.slug, nodes=['b']) as tx:
                    tx.d['nodes']['b']['name'] = 'from-tx'
            except BaseException as ex:            # noqa: BLE001
                errs.append(ex)
        legacy = store.load_org(self.slug)
        legacy.d['nodes']['b']['name'] = 'from-legacy'
        orgtx.set_pause_hook(hook)
        try:
            t = threading.Thread(target=body)
            t.start()
            self.assertTrue(paused.wait(10))
            out: list = []

            def save():
                try:
                    store.save_org(legacy)
                    out.append('saved')
                except store.StaleWrite:
                    out.append('stale')
            s = threading.Thread(target=save)
            s.start()
            s.join(0.5)
            self.assertTrue(s.is_alive(), 'the legacy UPDATE must wait on the row lock')
            go.set()
            t.join(10)
            s.join(10)
        finally:
            go.set()
            orgtx.set_pause_hook(None)
            os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS')
        self.assertEqual(errs, [])
        self.assertEqual(out, ['stale'])
        self.assertEqual(_node(self.slug, 'b')['name'], 'from-tx')

    def test_same_new_node_id_creators_exclude_each_other(self) -> None:
        e, r = threading.Event(), threading.Event()
        t = self._hold(e, r, nodes=['new-x'])
        try:
            self.assertEqual(self._try(nodes=['new-x']), 'blocked')
        finally:
            r.set()
            t.join()

    def test_n1_same_op_key_in_flight_waits_then_replays(self) -> None:
        entered, release = threading.Event(), threading.Event()

        def first():
            with orgtx.org_tx(self.slug, logs=['events'], op_key='n1', fingerprint='f') as tx:
                entered.set()
                release.wait(10)
                tx.append('events', {'kind': 'n1'})
                tx.result = {'done': 1}
        t = threading.Thread(target=first)
        t.start()
        self.assertTrue(entered.wait(10))
        threading.Timer(0.5, release.set).start()
        with orgtx.org_tx(self.slug, logs=['events'], op_key='n1', fingerprint='f') as tx2:
            replayed, result = tx2.replayed, tx2.result
            if not tx2.replayed:
                tx2.append('events', {'kind': 'n1'})
        t.join(10)
        self.assertEqual((replayed, result), (True, {'done': 1}))
        kinds = [e.get('kind') for e in store.load_org(self.slug).d['events']]
        self.assertEqual(kinds.count('n1'), 1)

    def test_pg_errors_map_to_orgtx_errors(self) -> None:
        class E(Exception):
            def __init__(self, st): self.sqlstate = st
        self.assertIsInstance(orgtx._pg_error(E('40P01')), orgtx.DeadlockDetected)
        self.assertIsInstance(orgtx._pg_error(E('40001')), orgtx.SerializationFailure)
        self.assertIsInstance(orgtx._pg_error(E('55P03')), orgtx.LockTimeout)

    def test_racing_increments_are_not_lost(self) -> None:
        errs: list[BaseException] = []

        def bump():
            try:
                for _ in range(5):
                    with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                        n = tx.d['nodes']['a']
                        n['n'] = n.get('n', 0) + 1
            except BaseException as e:           # noqa: BLE001
                errs.append(e)
        ts = [threading.Thread(target=bump) for _ in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(120)
        self.assertEqual(errs, [])
        self.assertEqual(_node(self.slug, 'a')['n'], 20)

    def test_legacy_save_cannot_overwrite_an_org_tx_commit(self) -> None:
        legacy = store.load_org(self.slug)            # baselines taken now
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['name'] = 'from-tx'
        legacy.d['nodes']['a']['name'] = 'from-legacy'
        legacy.d['nodes']['b']['name'] = 'also-legacy'
        with self.assertRaises(store.StaleWrite):
            store.save_org(legacy)
        self.assertEqual(_node(self.slug, 'a')['name'], 'from-tx')
        self.assertEqual(_node(self.slug, 'b')['name'], 'b')     # rolled back whole
        other = store.load_org(self.slug)
        other.d['nodes']['b']['name'] = 'fresh'
        store.save_org(other)                                    # fresh baseline: fine
        self.assertEqual(_node(self.slug, 'b')['name'], 'fresh')

    def test_rt6_lost_commit_retry_has_one_outcome(self) -> None:
        os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
        lost = {'armed': True}

        def cut(point, tx):
            if point == 'after_commit' and lost['armed']:
                lost['armed'] = False
                raise ConnectionError('connection lost after COMMIT')

        def credit(tx):
            n = tx.d['nodes']['c']
            n['credits'] = n.get('credits', 0) + 10
            return {'credits': n['credits']}
        try:
            orgtx.set_pause_hook(cut)
            with self.assertRaises(ConnectionError):
                orgtx.org_tx_call(self.slug, credit, nodes=['c'], op_key='rt6', fingerprint='f1')
            out = orgtx.org_tx_call(self.slug, credit, nodes=['c'], op_key='rt6', fingerprint='f1')
        finally:
            orgtx.set_pause_hook(None)
            os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS')
        self.assertEqual(out, {'credits': 10})
        self.assertEqual(_node(self.slug, 'c')['credits'], 10)
        with self.assertRaises(orgtx.ReceiptConflict):
            orgtx.org_tx_call(self.slug, credit, nodes=['c'], op_key='rt6', fingerprint='other')


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class TransitionFence(unittest.TestCase):
    # plan decision 19: (a) an unconverted DOC_LOCK load->save cycle racing an
    # org_tx on the same row loses nothing with the fence ON, and loses the
    # update (or raises StaleWrite) with it OFF; (b) a DOC_LOCK holder may
    # call org_tx (re-entry, no deadlock)

    @classmethod
    def setUpClass(cls) -> None:
        store.claim_data_root()

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.PgBackend())
        self.slug = _fresh_org(f'fence-{self._testMethodName}'[:60])
        with orgtx.org_tx(self.slug, nodes=['a']):
            pass                                  # heal before racing

    def tearDown(self) -> None:
        orgtx.TRANSITION_FENCE = False

    def _race(self, fence: bool) -> tuple:
        orgtx.TRANSITION_FENCE = fence
        loaded, go = threading.Event(), threading.Event()
        stale: list = []

        def legacy() -> None:
            try:
                with store.DOC_LOCK:
                    org = store.load_org(self.slug)
                    node = org.d['nodes']['a']            # the baseline is read
                    loaded.set()
                    go.wait(10)
                    node['legacy'] = 1
                    store.save_org(org)
            except store.StaleWrite as e:
                stale.append(e)

        def converted() -> None:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['tx'] = 1
        lt = threading.Thread(target=legacy)
        lt.start()
        self.assertTrue(loaded.wait(10))
        ct = threading.Thread(target=converted)
        ct.start()
        ct.join(1.0)
        tx_done_early = not ct.is_alive()
        go.set()
        lt.join(10)
        ct.join(10)
        node = _node(self.slug, 'a')
        return tx_done_early, node.get('legacy'), node.get('tx'), bool(stale)

    def test_a_fence_on_loses_nothing(self) -> None:
        early, legacy, tx, stale = self._race(True)
        self.assertFalse(early, 'the org_tx must wait for the DOC_LOCK holder')
        self.assertEqual((legacy, tx, stale), (1, 1, False))

    def test_a_fence_off_loses_the_update_or_refuses(self) -> None:
        early, legacy, tx, stale = self._race(False)
        self.assertTrue(early, 'without the fence the org_tx does not wait')
        self.assertFalse(legacy == 1 and tx == 1, 'both writes survived: no race was exercised')
        self.assertTrue(stale or legacy is None or tx is None)

    def test_a2_org_tx_holds_the_fence_until_commit(self) -> None:
        orgtx.TRANSITION_FENCE = True
        inside, release = threading.Event(), threading.Event()
        got_lock = threading.Event()

        def converted() -> None:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                inside.set()
                release.wait(10)
                tx.d['nodes']['a']['tx2'] = 1

        def legacy() -> None:
            with store.DOC_LOCK:
                got_lock.set()
        ct = threading.Thread(target=converted)
        ct.start()
        self.assertTrue(inside.wait(10))
        lt = threading.Thread(target=legacy)
        lt.start()
        self.assertFalse(got_lock.wait(0.5), 'a DOC_LOCK cycle ran inside an open org_tx')
        release.set()
        ct.join(10)
        lt.join(10)
        self.assertTrue(got_lock.is_set())
        self.assertEqual(_node(self.slug, 'a').get('tx2'), 1)

    def test_b_doc_lock_holder_reenters(self) -> None:
        orgtx.TRANSITION_FENCE = True
        done: list = []

        def run() -> None:
            with store.DOC_LOCK:
                with orgtx.org_tx(self.slug, nodes=['b']) as tx:
                    tx.d['nodes']['b']['name'] = 'reentered'
                done.append(1)
        t = threading.Thread(target=run)
        t.start()
        t.join(10)
        self.assertFalse(t.is_alive(), 'deadlocked')
        self.assertEqual(done, [1])
        self.assertEqual(_node(self.slug, 'b')['name'], 'reentered')


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PG0bPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        store.claim_data_root()

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.PgBackend())
        self.slug = _fresh_org(f'pg0b-{self._testMethodName}'[:60])

    def _row(self, key: str):
        with pgstore.connect() as c:
            oid = c.execute('SELECT org_id FROM orgs WHERE slug=%s', (self.slug,)).fetchone()[0]
            r = c.execute(f'SELECT val FROM org_{oid}.doc WHERE key=%s', (key,)).fetchone()
        return None if r is None else r[0]

    def test_incremental_delete_is_compare_and_set(self) -> None:
        org = store.load_org(self.slug)
        org.d.setdefault('mail_log', {})['a'] = [{'id': 'm1'}, {'id': 'm2'}]
        store.save_org(org)
        legacy = store.load_org(self.slug)
        legacy.d['mail_log']['a'].pop()            # an incremental delete of m2
        with orgtx.org_tx(self.slug, logs=[('mail_log', 'a')]) as tx:
            tx.d['mail_log']['a'][1]['body'] = 'edited-by-tx'
        with self.assertRaises(store.StaleWrite):
            store.save_org(legacy)
        self.assertEqual(store.load_org(self.slug).d['mail_log']['a'][1].get('body'), 'edited-by-tx')

    def test_receipt_only_commit_bumps_revision_and_notifies(self) -> None:
        r0 = _rev(self.slug)
        listen = psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True)
        try:
            listen.execute('LISTEN org_rev')
            with orgtx.org_tx(self.slug, nodes=['a'], op_key='only-receipt', fingerprint='f') as tx:
                tx.result = {'ok': True}           # no row changes
            got = [n.payload for n in listen.notifies(timeout=2, stop_after=1)]
        finally:
            listen.close()
        self.assertEqual(_rev(self.slug), r0 + 1)
        self.assertEqual(got, [f'{self.slug}:{r0 + 1}'])

    def test_killswitch_row_present_null_after_release_and_backfilled(self) -> None:
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d['killswitch'] = {'on': True}
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d.pop('killswitch')
        self.assertEqual(self._row('killswitch'), 'null')
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d['killswitch'] = None
        self.assertEqual(self._row('killswitch'), 'null')
        with pgstore.connect() as c:                # an org from before the rule
            oid = c.execute('SELECT org_id FROM orgs WHERE slug=%s', (self.slug,)).fetchone()[0]
            c.execute(f"DELETE FROM org_{oid}.doc WHERE key='killswitch'")
        self.assertIsNone(self._row('killswitch'))
        self.assertGreaterEqual(pgstore.backfill_always_rows(store.ALWAYS_ROWS), 1)
        self.assertEqual(self._row('killswitch'), 'null')

    def test_share_on_present_killswitch_blocks_the_latch(self) -> None:
        entered, release = threading.Event(), threading.Event()

        def door() -> None:
            with orgtx.org_tx(self.slug, share_sections=['killswitch']):
                entered.set()
                release.wait(10)
        t = threading.Thread(target=door)
        t.start()
        self.assertTrue(entered.wait(10))
        try:
            with self.assertRaises(orgtx.LockTimeout):
                with orgtx.org_tx(self.slug, sections=['killswitch'], lock_timeout=0.3):
                    pass
        finally:
            release.set()
            t.join()

    def test_mixed_replay_is_refused(self) -> None:
        other = _fresh_org(f'pg0b-o-{self._testMethodName}'[:60])
        with orgtx.org_tx(self.slug, nodes=['a'], op_key='mk1', fingerprint='f'):
            pass
        with self.assertRaises(orgtx.MixedReplay):
            with orgtx.org_tx_multi({self.slug: dict(nodes=['a'], op_key='mk1', fingerprint='f'),
                                     other: dict(nodes=['b'], op_key='mk2', fingerprint='f')}) as t:
                t[other].d['nodes']['b']['name'] = 'x'
        self.assertEqual(_node(other, 'b')['name'], 'b')


if __name__ == '__main__':
    unittest.main()
