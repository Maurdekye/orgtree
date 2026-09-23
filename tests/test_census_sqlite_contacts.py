"""P02-A3: actual SQLite contacts on the primary store path (`census_contacts`).

Every control here is instrumented in the way `test_operation_census` insists
on: a negative control first proves it ran — the statement it expects to be
invisible really executed, the refusal it expects to be pre-storage really
refused — before it asserts that nothing was counted. An absence asserted in a
window where nothing happened proves nothing.

⚠ WHAT THIS SUITE DOES NOT ESTABLISH. It proves that the contacts the primary
store makes through `store._open_conn` connections are observed, attributed
and classified, and that the listed ways evidence can be lost are counted
rather than silent. It does not prove complete storage coverage — the
`UNINSTRUMENTED` sites, PostgreSQL, the Rust engine and other processes are
outside it by construction — and it measures no overhead, rows, IO or lock
wait. It never touches a real data root or the machine's mail hub: the data
root is a temporary directory and every database is created inside it.
"""
import ast
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v3-census-contacts-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
# ⚠ NOT set. Capture must be provably OFF at import, so the default is
# measured rather than assumed; every positive test turns it on itself.
os.environ.pop('ORGTREE_OPERATION_CENSUS', None)
os.environ.pop('ORGTREE_STORE', None)
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402  (env must be set first)
app, *_ = load_app()

from orgtree import census, census_contacts as cc, store  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
OPERATOR = {'X-Orgtree-Desktop-Token': 'operator'}
IMPORT_DEFAULT_ENABLED = census.enabled()
_orgs_created: list[str] = []
_SECRET = 'zz-secret-7f3a9c'


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


def _make_org(slug: str):
    store.create_org(slug)
    _orgs_created.append(slug)


class ContactCase(unittest.TestCase):
    """A fresh census window with capture ON, a scratch database directory,
    and helpers to run code inside one attempt's tally."""

    def setUp(self):
        census.reset()
        census.set_enabled(True)
        self.dir = tempfile.TemporaryDirectory(prefix='contacts-', dir=root.name)
        # Cleanups run last-registered first: connections must close before
        # Windows will let the directory holding their files go.
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(self._off)
        self._open = []

    def _off(self):
        for conn in self._open:
            try:
                conn.close()
            except Exception:
                pass
        census.set_enabled(False)
        census.reset()

    def db(self, name='t.db', create=True):
        conn = store._open_conn(str(Path(self.dir.name) / name), create=create)
        self._open.append(conn)
        return conn

    def attempt(self, body):
        """Run `body` as one attempt with its own tally; return the sealed
        evidence exactly as the census would publish it."""
        tally = cc.Tally()
        token = cc.bind(tally)
        try:
            body()
        finally:
            cc.unbind(token)
        return census._contact_block(tally.seal())

    def counters(self):
        return cc.counters()


# ------------------------------------------------ the boundary itself

class BoundaryTests(ContactCase):

    def test_the_primary_factory_returns_the_observed_class(self):
        """The whole claim rests on this: the connections the store uses are
        the observer's class. If `factory=` is dropped from `_open_conn`, every
        other test in this file can only see contacts it made itself."""
        conn = self.db()
        self.assertIsInstance(conn, cc.ObservedConnection)
        with store._POOL.acquire('does-not-matter-here', create=True) as pooled:
            self.assertIsInstance(pooled, cc.ObservedConnection)
        store._POOL.close_all('does-not-matter-here')

    def test_minting_a_database_is_observed_statement_by_statement(self):
        """The create path runs four PRAGMAs and the schema script. Each is
        one API attempt; SQLite's own trace callback proves they reached the
        engine; and nothing ran around the boundary."""
        got = self.attempt(lambda: self.db())
        self.assertEqual(got['store'], 'sqlite')
        self.assertEqual(got['connects'], 1)
        self.assertEqual(got['connect_failed'], 0)
        self.assertEqual(got['kinds'], {'pragma': 4, 'ddl': 1}, got)
        self.assertEqual(got['statements'], 5)
        self.assertEqual(got['statement_failed'], 0)
        self.assertGreaterEqual(got['engine_steps'], 5,
                                'the trace cross-check never fired, so it '
                                'could not have caught a hidden access')
        self.assertEqual(got['hidden_steps'], 0)

    def test_every_statement_api_is_counted_exactly_once(self):
        """⚠ THE DOUBLE-COUNT CONTROL. On 3.10 `Connection.execute` calls
        `self.cursor().execute`; on 3.12+ it does not. The observer redefines
        the connection methods to go through the cursor on both, so each API
        call must be exactly one attempt on whichever interpreter runs this."""
        conn = self.db()

        def body():
            conn.execute('CREATE TABLE t(a)')
            conn.executemany('INSERT INTO t VALUES (?)', [(1,), (2,), (3,)])
            conn.executescript('INSERT INTO t VALUES (4); INSERT INTO t VALUES (5);')
            cur = conn.cursor()
            cur.execute('SELECT count(*) FROM t')
            self.assertEqual(cur.fetchone()[0], 5)
            conn.execute('BEGIN')
            conn.commit()

        got = self.attempt(body)
        self.assertEqual(got['kinds'], {'select': 1, 'insert': 2, 'begin': 1,
                                        'commit': 1, 'ddl': 1}, got)
        self.assertEqual(got['statements'], 6)
        # create, 3 executemany rows, 2 script statements, select, begin,
        # commit — the engine saw more steps than there were API attempts,
        # which is the documented reason the two are separate fields.
        self.assertGreaterEqual(got['engine_steps'], 9)
        self.assertEqual(got['hidden_steps'], 0)

    def test_a_pooled_checkout_is_a_checkout_and_reuse_is_not_a_connect(self):
        slug = 'contacts-pool-org'
        _make_org(slug)
        store._POOL.close_all(slug)

        def use():
            with store._POOL.acquire(slug) as conn:
                conn.execute('SELECT 1').fetchone()

        first = self.attempt(use)
        second = self.attempt(use)
        self.assertEqual((first['checkouts'], first['connects']), (1, 1), first)
        self.assertEqual((second['checkouts'], second['connects']), (1, 0), second)
        self.assertEqual(second['kinds'], {'select': 1})

    def test_a_real_store_workload_reaches_sqlite_only_through_the_boundary(self):
        """⚠ THE HIDDEN-ACCESS CONTROL ON THE PRIMARY PATH. A real create,
        load, write/save and history read, all on one tally: the workload must
        demonstrably have reached the engine, and SQLite must have run no
        statement on these connections outside an observed call. Scoped to
        what this workload exercises; it is not a proof about paths it does
        not run."""
        slug = 'contacts-workload-org'
        from orgtree import ledger

        def body():
            _make_org(slug)
            store._POOL.close_all(slug)
            store.load_org(slug)
            with store.write_org(slug) as org:
                org.hire(ledger.USER, None, 'haiku', 0, 'probe')
                store.save_org(org)
            store.load_org(slug)

        before = self.counters()
        got = self.attempt(body)
        after = self.counters()
        self.assertGreater(got['statements'], 0, got)
        self.assertGreater(got['engine_steps'], 0, got)
        self.assertGreater(got['kinds'].get('commit', 0), 0,
                           'the save never committed, so this workload did '
                           'not exercise the write path: ' + json.dumps(got))
        self.assertEqual(got['hidden_steps'], 0, got)
        self.assertEqual(after['hidden_unattributed'], before['hidden_unattributed'])
        self.assertEqual(got['kind_failed'], {}, got)


# ------------------------------------------------ outcomes that must not lie

class OutcomeTests(ContactCase):

    def test_a_refused_open_is_a_failed_contact_not_a_missing_one(self):
        """`?mode=rw` on a deleted database raises inside sqlite. That is a
        real attempt that failed, with no statement after it."""
        missing = Path(self.dir.name) / 'gone.db'

        def body():
            with self.assertRaises(sqlite3.OperationalError):
                store._open_conn(str(missing), create=False)

        got = self.attempt(body)
        self.assertFalse(missing.exists(), 'the refused open created the file')
        self.assertEqual((got['connects'], got['connect_failed']), (1, 1), got)
        self.assertEqual((got['statements'], got['engine_steps']), (0, 0), got)

    def test_a_statement_refused_at_prepare_is_attempted_but_never_executed(self):
        conn = self.db()

        def body():
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute('SELEC nothing')

        got = self.attempt(body)
        self.assertEqual((got['statements'], got['statement_failed']), (1, 1), got)
        self.assertEqual(got['kind_failed'], {'other': 1})
        self.assertEqual(got['engine_steps'], 0,
                         'a statement SQLite refused to prepare was counted '
                         'as having reached the engine')

    def test_a_rolled_back_write_reads_as_rolled_back_not_committed(self):
        conn = self.db()
        conn.execute('CREATE TABLE t(a)')

        def body():
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('INSERT INTO t VALUES (1)')
            conn.execute('ROLLBACK')

        got = self.attempt(body)
        # ⚠ The statements ran as written: the row is really gone. An
        # observer that altered or swallowed the ROLLBACK would leave it.
        self.assertEqual(conn.execute('SELECT count(*) FROM t').fetchone()[0], 0)
        self.assertEqual(got['kinds'], {'begin': 1, 'insert': 1, 'rollback': 1})
        self.assertNotIn('commit', got['kinds'])
        self.assertEqual(got['statement_failed'], 0)

    def test_a_busy_refusal_is_counted_as_failed_and_busy(self):
        """Deterministic contention: one connection holds the write lock and
        the other asks for it with a zero busy timeout."""
        holder = self.db('busy.db')
        holder.execute('CREATE TABLE t(a)')
        other = self.db('busy.db', create=False)
        other.execute('PRAGMA busy_timeout=0')
        holder.execute('BEGIN IMMEDIATE')
        try:
            def body():
                with self.assertRaises(sqlite3.OperationalError):
                    other.execute('BEGIN IMMEDIATE')

            got = self.attempt(body)
        finally:
            holder.execute('ROLLBACK')
        self.assertEqual(got['statement_busy'], 1, got)
        self.assertEqual(got['statement_failed'], 1, got)
        self.assertEqual(got['kind_failed'], {'begin': 1})

    def test_a_failed_statement_is_still_raised_to_the_caller(self):
        """A census may never change the operation it measures: the exact
        exception class the unobserved connection raises is what the caller
        gets, integrity errors included."""
        conn = self.db()
        conn.execute('CREATE TABLE u(a UNIQUE)')
        conn.execute('INSERT INTO u VALUES (1)')

        def body():
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute('INSERT INTO u VALUES (1)')

        got = self.attempt(body)
        self.assertEqual(got['kind_failed'], {'insert': 1})
        self.assertEqual(got['statement_busy'], 0)


# ------------------------------------------------ evidence that cannot be joined

class LossAccountingTests(ContactCase):

    def test_a_statement_around_the_boundary_is_a_hidden_step(self):
        """⚠ THE FALSIFICATION CONTROL. A bare `sqlite3.Cursor` on an observed
        connection bypasses every observed method. The statement must really
        run (positive half) and must show up as hidden, not as a statement."""
        conn = self.db()

        def body():
            row = sqlite3.Cursor(conn).execute('SELECT 42').fetchone()
            self.assertEqual(row, (42,), 'the bypassing statement never ran')

        got = self.attempt(body)
        self.assertEqual(got['hidden_steps'], 1, got)
        self.assertEqual(got['statements'], 0, got)

        before = self.counters()['hidden_unattributed']
        sqlite3.Cursor(conn).execute('SELECT 43').fetchone()
        self.assertEqual(self.counters()['hidden_unattributed'], before + 1)

    def test_a_caller_supplied_cursor_class_is_hidden_not_observed(self):
        conn = self.db()
        got = self.attempt(
            lambda: conn.cursor(sqlite3.Cursor).execute('SELECT 1').fetchone())
        self.assertEqual((got['statements'], got['hidden_steps']), (0, 1), got)

    def test_a_contact_with_no_attempt_bound_is_unattributed(self):
        conn = self.db()
        before = self.counters()['unattributed']
        conn.execute('SELECT 1').fetchone()
        after = self.counters()['unattributed']
        # the statement and its engine step, both counted and neither lost
        self.assertEqual(after - before, 2)

    def test_a_contact_after_the_record_is_built_is_late(self):
        conn = self.db()
        tally = cc.Tally()
        token = cc.bind(tally)
        try:
            conn.execute('SELECT 1').fetchone()
            sealed = census._contact_block(tally.seal())
            before = self.counters()['late']
            conn.execute('SELECT 2').fetchone()
        finally:
            cc.unbind(token)
        self.assertEqual(self.counters()['late'] - before, 2)
        self.assertEqual(census._contact_block(tally.seal()), sealed,
                         'a sealed tally changed after its record was built')

    def test_a_handed_thread_is_linked_and_an_unhanded_one_is_not(self):
        """The managed-tool worker shape: `toolwait` hands the attempt's tally
        to its thread with `adopt`. A thread that is not handed it must not
        silently borrow somebody else's attempt."""
        conn = self.db('threads.db')
        conn.execute('CREATE TABLE t(a)')
        path = str(Path(self.dir.name) / 'threads.db')
        before = self.counters()['unattributed']
        tally = cc.Tally()
        done = []

        def handed():
            cc.adopt(tally)
            own = store._open_conn(path)
            own.execute('INSERT INTO t VALUES (1)')
            own.close()
            done.append('handed')

        def unhanded():
            own = store._open_conn(path)
            own.execute('INSERT INTO t VALUES (2)')
            own.close()
            done.append('unhanded')

        for target in (handed, unhanded):
            thread = threading.Thread(target=target)
            thread.start()
            thread.join(10)
        self.assertEqual(sorted(done), ['handed', 'unhanded'])
        got = census._contact_block(tally.seal())
        self.assertEqual(got['linked_threads'], 1)
        self.assertEqual(got['kinds'], {'pragma': 2, 'insert': 1}, got)
        # connect + 2 pragmas + insert + their engine steps
        self.assertGreaterEqual(self.counters()['unattributed'] - before, 4)

    def test_adopting_a_sealed_tally_is_late_not_linked(self):
        tally = cc.Tally()
        tally.seal()
        before = self.counters()['late']
        cc.adopt(tally)
        self.assertEqual(self.counters()['late'], before + 1)
        self.assertEqual(census._contact_block(tally.seal())['linked_threads'], 0)

    def test_the_observers_own_contact_is_self_recursion_not_the_operations(self):
        """⚠ DIAGNOSTIC SELF-RECURSION. If the observer's bookkeeping ever
        reaches SQLite, that contact is the instrument's: it must run, must
        not be credited to the attempt, must be counted, and must not
        recurse."""
        conn = self.db()
        side = self.db('side.db')
        real = cc.kind_of
        seen = []

        def meddling(sql):
            seen.append(side.execute('SELECT 7').fetchone())
            return real(sql)

        cc.kind_of = meddling
        try:
            got = self.attempt(lambda: conn.execute('SELECT 1').fetchone())
        finally:
            cc.kind_of = real
        self.assertEqual(seen, [(7,)], 'the recursive contact never ran')
        self.assertEqual(self.counters()['self_recursion'], 1)
        self.assertEqual(got['statements'], 1, got)
        self.assertEqual(got['kinds'], {'select': 1})

    def test_reading_the_census_makes_no_storage_contact(self):
        conn = self.db()
        conn.execute('SELECT 1')     # a window with contacts in it to read
        got = self.attempt(lambda: census.snapshot())
        self.assertEqual({k: v for k, v in got.items() if k in cc.FIELDS},
                         {name: 0 for name in cc.FIELDS})


# ------------------------------------------------ privacy

class PrivacyTests(ContactCase):

    def test_no_sql_parameter_path_or_value_reaches_the_evidence(self):
        """The positive half first: the secret is really in the SQL text, the
        bound parameter, the stored row and the database file name, and the
        statements really ran. Then it must be absent from everything the
        census publishes."""
        conn = self.db(f'{_SECRET}.db')
        conn.execute(f'CREATE TABLE "{_SECRET}"(v)')

        def body():
            conn.execute(f'INSERT INTO "{_SECRET}" VALUES (?)', (_SECRET,))
            conn.execute(f"SELECT '{_SECRET}' FROM \"{_SECRET}\"").fetchall()
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute(f'SELECT {_SECRET}_missing FROM "{_SECRET}"')

        got = self.attempt(body)
        self.assertEqual(conn.execute(f'SELECT v FROM "{_SECRET}"').fetchone(),
                         (_SECRET,))
        self.assertEqual(got['statements'], 3)
        published = json.dumps([got, census.snapshot(), self.counters()])
        self.assertNotIn(_SECRET, published)
        self.assertLessEqual(set(got), set(cc.FIELDS) | {'store', 'kinds', 'kind_failed'})
        self.assertLessEqual(set(got['kinds']) | set(got['kind_failed']), set(cc.KINDS))
        for name in cc.FIELDS:
            self.assertIs(type(got[name]), int)

    def test_the_first_keyword_is_the_only_thing_read(self):
        cases = {
            '  -- note\n/* x */ select 1': 'select',
            'WITH a AS (SELECT 1) SELECT * FROM a': 'with',
            'insert or replace into t values(1)': 'insert',
            'REPLACE INTO t VALUES (1)': 'replace',
            'end': 'commit', 'VACUUM': 'maintenance', 'drop table t': 'ddl',
            'values (1)': 'select', '': 'other', '/* unterminated': 'other',
            f'{_SECRET} t': 'other', None: 'other', b'select 1': 'other',
        }
        for sql, kind in cases.items():
            self.assertEqual(cc.kind_of(sql), kind, repr(sql))

    def test_a_forged_tally_cannot_publish_an_unlisted_name(self):
        block = census._contact_block({
            'store': _SECRET, 'statements': float('nan'), 'connects': -4,
            'checkouts': True, _SECRET: 9,
            'kinds': {_SECRET: 3, 'select': 2.0, 'insert': 'x'},
            'kind_failed': [1]})
        self.assertNotIn(_SECRET, json.dumps(block))
        self.assertEqual(block['store'], 'unknown')
        self.assertEqual(block['statements'], 0)
        self.assertEqual(block['connects'], 0)
        self.assertEqual(block['checkouts'], 0)
        self.assertEqual(block['kinds'], {'select': 2})
        self.assertEqual(block['kind_failed'], {})


# ------------------------------------------------ capture off

class CaptureOffTests(unittest.TestCase):

    def test_capture_is_off_at_import_and_off_observes_nothing(self):
        """⚠ THE DEFAULT, MEASURED. This module imported with the variable
        unset, so this is the live default and not a fixture's opinion."""
        self.assertFalse(IMPORT_DEFAULT_ENABLED)
        census.set_enabled(False)
        census.reset()
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            conn = store._open_conn(str(Path(scratch) / 'off.db'), create=True)
            try:
                self.assertFalse(conn._census_traced,
                                 'a trace callback was installed with capture off')
                conn.execute('CREATE TABLE t(a)')
                conn.execute('INSERT INTO t VALUES (1)')
                sqlite3.Cursor(conn).execute('SELECT 1')
                self.assertEqual(conn.execute('SELECT count(*) FROM t').fetchone(), (1,))
            finally:
                conn.close()
        self.assertEqual(cc.counters(), {name: 0 for name in cc.COUNTER_NAMES})
        token = census.bind()
        try:
            self.assertIsNone(cc.current(), 'an attempt got a tally with capture off')
        finally:
            census.unbind(token)

    def test_switching_off_removes_a_trace_left_by_an_enabled_window(self):
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            census.set_enabled(True)
            try:
                conn = store._open_conn(str(Path(scratch) / 'flip.db'), create=True)
                self.assertTrue(conn._census_traced)
            finally:
                census.set_enabled(False)
            census.reset()
            try:
                conn.execute('SELECT 1')
                self.assertFalse(conn._census_traced)
                sqlite3.Cursor(conn).execute('SELECT 1')
            finally:
                conn.close()
        self.assertEqual(cc.counters(), {name: 0 for name in cc.COUNTER_NAMES})


# ------------------------------------------------ through the application

class AttemptRecordTests(unittest.TestCase):

    def setUp(self):
        census.reset()
        census.set_enabled(True)
        self.client = TestClient(app)
        self.addCleanup(lambda: (census.set_enabled(False), census.reset()))

    def read(self):
        got = self.client.get('/api/diagnostics/operation-census',
                              headers=OPERATOR, params={'n': 500})
        self.assertEqual(got.status_code, 200, got.text)
        body = got.json()
        self.assertEqual(body['schema_version'], 4)
        return body

    def only(self, body, route, status):
        rows = [r for r in body['records']
                if r['route'] == route and r['status'] == status]
        self.assertEqual(len(rows), 1, json.dumps(body['records'])[:2000])
        return rows[0]

    def test_a_request_that_reads_the_store_carries_its_contacts(self):
        slug = 'contacts-http-org'
        _make_org(slug)
        store._POOL.close_all(slug)
        got = self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only(self.read(), '/api/orgs/{slug}', 200)
        db = row['db']
        self.assertEqual(db['store'], 'sqlite')
        self.assertGreater(db['statements'], 0, db)
        self.assertGreater(db['checkouts'], 0, db)
        self.assertGreater(db['engine_steps'], 0, db)
        self.assertEqual(db['hidden_steps'], 0, db)
        self.assertNotIn(slug, json.dumps(row))

    def test_a_pre_storage_refusal_carries_zero_contacts(self):
        """⚠ A REFUSAL IS NOT A CONTACT. A body that fails validation is
        refused before any handler runs; its record must say it was observed
        (a `db` block is present) and that nothing reached the store."""
        got = self.client.post('/api/agent', headers=OPERATOR,
                               content=b'{not json', )
        self.assertEqual(got.status_code, 422, got.text)
        row = self.only(self.read(), '/api/agent', 422)
        self.assertIn('db', row, 'the refusal was not observed at all')
        self.assertEqual({k: row['db'][k] for k in cc.FIELDS},
                         {name: 0 for name in cc.FIELDS}, row)

    def test_a_missing_org_is_refused_before_any_sqlite_contact(self):
        """Measured, not assumed: an unknown org is refused by a file-system
        existence check, which is not a SQLite contact, so the honest record
        is zero contacts — the same slug-shaped route that carries contacts in
        the 200 case above. A refused OPEN (the store did try) is the other
        shape, and `test_a_refused_open_is_a_failed_contact_not_a_missing_one`
        pins that one at the connection."""
        got = self.client.get('/api/orgs/contacts-no-such-org', headers=OPERATOR)
        self.assertEqual(got.status_code, 404, got.text)
        row = self.only(self.read(), '/api/orgs/{slug}', 404)
        self.assertEqual({k: row['db'][k] for k in cc.FIELDS},
                         {name: 0 for name in cc.FIELDS}, row)

    def test_a_managed_tools_worker_contacts_join_its_attempt(self):
        """`toolwait.invoke` runs a managed tool on its own thread, which
        does not inherit the request's context. It hands the attempt's tally
        over explicitly; without that, every primary-store contact of a
        hire, retire or staff would be unattributed. This call finishes
        inside the wait, so all of its contacts belong to this record."""
        from orgtree import ledger
        slug = 'contacts-managed-org'
        _make_org(slug)
        with store.write_org(slug) as org:
            org.hire(ledger.USER, None, 'haiku', 0, 'probe')
            store.save_org(org)
        got = self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': 'probe', 'tool': 'orgtree_watchdog',
            'args': {'action': 'list'}})
        self.assertEqual(got.status_code, 200, got.text)
        self.assertNotEqual(got.json().get('state'), 'running',
                            'the call yielded, so this is not the joined case')
        rows = [r for r in self.read()['records']
                if r.get('tool') == 'orgtree_watchdog']
        self.assertEqual(len(rows), 1)
        db = rows[0]['db']
        self.assertTrue(rows[0]['terminal'])
        self.assertEqual(db['linked_threads'], 1, db)
        self.assertGreater(db['statements'], 0, db)

    def test_the_census_read_door_is_not_a_record_and_the_snapshot_says_what_it_covers(self):
        body = self.read()
        body = self.read()
        self.assertFalse([r for r in body['records']
                          if r['route'] == '/api/diagnostics/operation-census'])
        cov = body['contact_coverage']
        self.assertFalse(cov['complete'])
        self.assertEqual(cov['instrumented'],
                         [{'path': 'engine/backend/orgtree/store.py',
                           'symbol': '_open_conn'}])
        self.assertTrue(cov['uninstrumented'])
        self.assertEqual([row['path'] for row in cov['other_processes']],
                         [p for p, _ in cc.OTHER_PROCESSES])
        for name in cc.COUNTER_NAMES:
            self.assertIn('db_' + name, body['counters'])
        self.assertIn('db_unbound', body['counters'])
        self.assertEqual(body['provenance']['measures_storage_contacts'],
                         'primary_and_listed_sidecar_sqlite_stores')
        self.assertTrue(any('rows examined' in limit for limit in body['limits']))

    def test_an_attempt_that_began_with_capture_off_has_no_db_block(self):
        record, bumps = census._build('GET', '/api/orgs/{slug}', 200, 1.0, 1.0,
                                      0, 1, {}, {})
        self.assertNotIn('db', record)
        self.assertIn('db_unbound', bumps)


# ------------------------------------------------ coverage is stated, not assumed

#: The bundled mail hub is a separately versioned git submodule and a
#: separate process. It is absent from checkouts that did not initialise it, so
#: scanning it would make this guard's answer depend on the checkout (review
#: finding F1 on 1adce5a). It is excluded from the tree scan and declared in
#: `census_contacts.OTHER_PROCESSES`, which has its own tests below.
HUB = 'engine/mailhub/'


def _connect_sites(repo=None, base='engine', exclude=(HUB,)):
    """Every `sqlite3.connect` call under `base`, by file and enclosing
    symbol, including `import sqlite3 as x` and `from sqlite3 import connect`
    spellings. Paths starting with an `exclude` prefix are skipped."""
    repo = REPO if repo is None else repo
    found = set()
    for path in sorted((repo / base).rglob('*.py')):
        rel = path.relative_to(repo).as_posix()
        if '/runtime/' in '/' + rel or 'site-packages' in rel:
            continue
        if rel.startswith(tuple(exclude)):
            continue
        tree = ast.parse(path.read_text(encoding='utf-8-sig'))
        modules, functions = {'sqlite3'}, set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == 'sqlite3':
                        modules.add(alias.asname or 'sqlite3')
            elif isinstance(node, ast.ImportFrom) and node.module == 'sqlite3':
                for alias in node.names:
                    if alias.name == 'connect':
                        functions.add(alias.asname or 'connect')

        def visit(node, stack):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    visit(child, stack + [child.name])
                    continue
                if isinstance(child, ast.Call):
                    fn = child.func
                    hit = (isinstance(fn, ast.Attribute) and fn.attr == 'connect'
                           and isinstance(fn.value, ast.Name) and fn.value.id in modules) \
                        or (isinstance(fn, ast.Name) and fn.id in functions)
                    if hit:
                        found.add((rel, '.'.join(stack) or '<module>'))
                visit(child, stack)

        visit(tree, [])
    return found


def _hub_sites(repo=None):
    """The bundled hub's PRODUCT connect sites: the submodule minus its own
    tests, which open throwaway databases and are not the product store."""
    return _connect_sites(repo, base=HUB.rstrip('/'), exclude=(HUB + 'tests/',))


class CoverageDeclarationTests(unittest.TestCase):

    def test_every_connection_site_is_either_instrumented_or_listed(self):
        """⚠ A NEW DATABASE PATH CANNOT APPEAR SILENTLY. Both directions: an
        unlisted site fails, and a listed site that no longer exists fails, so
        the published gap list cannot go stale in either way. The answer is
        the same whether or not the `engine/mailhub` submodule is checked out,
        because that subtree is excluded here and pinned below."""
        sites = _connect_sites()
        self.assertIn(('engine/backend/orgtree/store.py', '_open_conn'), sites,
                      'the scanner did not find the one site it must find')
        self.assertFalse([s for s in sites if s[0].startswith(HUB)])
        sidecars = {(path, symbol) for path, symbol, _ in cc.SIDECARS}
        declared = set(cc.INSTRUMENTED) | set(cc.UNINSTRUMENTED) | sidecars
        self.assertEqual(len(declared), len(cc.INSTRUMENTED) + len(cc.UNINSTRUMENTED) + len(cc.SIDECARS))
        self.assertEqual(sorted(sites - declared), [], 'unlisted SQLite connection sites')
        self.assertEqual(sorted(declared - sites), [], 'listed sites that do not exist')

    def test_the_hub_exclusion_is_a_submodule_and_exactly_that_subtree(self):
        """The exclusion is justified only while `engine/mailhub` is a
        submodule: vendored into this repository it would be ordinary engine
        source and must be scanned like the rest. And the prefix must not
        swallow a sibling such as `engine/mailhub_runtime.py`."""
        gitmodules = (REPO / '.gitmodules').read_text(encoding='utf-8')
        self.assertIn('path = ' + HUB.rstrip('/'), gitmodules)
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            fake = Path(scratch)
            files = (('engine/mailhub/mailhub/db.py', 'def connect():\n    sqlite3.connect("h")\n'),
                     ('engine/mailhub/tests/test_x.py', 'def t():\n    sqlite3.connect("t")\n'),
                     ('engine/mailhub_runtime.py', 'def m():\n    sqlite3.connect("m")\n'))
            for rel, body in files:
                (fake / rel).parent.mkdir(parents=True, exist_ok=True)
                (fake / rel).write_text('import sqlite3\n' + body, encoding='utf-8')
            self.assertEqual(_connect_sites(fake), {('engine/mailhub_runtime.py', 'm')})
            self.assertEqual(_hub_sites(fake), {('engine/mailhub/mailhub/db.py', 'connect')})

    def test_the_bundled_hub_store_is_published_as_unobserved(self):
        """Declared whether or not the submodule is present: the payload an
        agent reads names the hub's own SQLite store as a process this census
        does not observe."""
        cov = cc.coverage()
        self.assertEqual(
            cov['other_processes'],
            [{'path': 'engine/mailhub/mailhub/db.py', 'symbol': 'connect', 'process': 'mailhub'},
             {'path': 'engine/mailhub/hubtool.py', 'symbol': '_db', 'process': 'mailhub'}])
        self.assertFalse(cov['complete'])
        self.assertTrue(any('mail hub' in limit for limit in cc.LIMITS))

    def test_the_hub_declaration_matches_the_submodule_source(self):
        """When the pinned submodule IS checked out, the declaration must be
        exactly its product connect sites. When it is not, this says so as a
        visible skip rather than passing on nothing."""
        if not (REPO / HUB / 'mailhub' / 'db.py').is_file():
            self.skipTest('engine/mailhub submodule not checked out; hub sites '
                          'are declared but cannot be compared to source here')
        self.assertEqual(_hub_sites(), set(cc.OTHER_PROCESSES))

    def test_the_scanner_would_catch_an_aliased_connect(self):
        """The negative control on the scanner itself."""
        tree = ast.parse('import sqlite3 as q\ndef f():\n    q.connect("x")\n')
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            fake = Path(scratch) / 'engine' / 'probe.py'
            fake.parent.mkdir()
            fake.write_text(ast.unparse(tree), encoding='utf-8')
            self.assertEqual(_connect_sites(Path(scratch)), {('engine/probe.py', 'f')})

    def test_the_primary_factory_passes_the_observed_class(self):
        tree = ast.parse((REPO / 'engine/backend/orgtree/store.py')
                         .read_text(encoding='utf-8-sig'))
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef) and n.name == '_open_conn')
        calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute) and n.func.attr == 'connect']
        self.assertEqual(len(calls), 1)
        factory = [k.value for k in calls[0].keywords if k.arg == 'factory']
        self.assertEqual([ast.unparse(v) for v in factory],
                         ['census_contacts.ObservedConnection'])


if __name__ == '__main__':
    unittest.main()
