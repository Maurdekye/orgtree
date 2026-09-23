"""P02-A4b: the listed sidecar SQLite stores' contacts (`census_contacts.SIDECARS`).

Each control proves it ran before it asserts an absence: a sidecar that is
expected to carry no contact is shown to exist, and a negative is paired with
the positive it guards. The data root is a temporary directory; nothing here
touches a real data root, the machine's mail hub, or a running engine.

⚠ WHAT THIS DOES NOT ESTABLISH. That the five sidecars are the only other
databases (the scan in test_census_sqlite_contacts pins the site list, not the
world), rows examined, IO, lock wait, or any product overhead.
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

root = tempfile.TemporaryDirectory(prefix='v3-census-sidecars-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
os.environ.pop('ORGTREE_OPERATION_CENSUS', None)
os.environ.pop('ORGTREE_STORE', None)
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402  (env must be set first)
app, *_ = load_app()

from orgtree import census, census_contacts as cc, store  # noqa: E402
from orgtree import reply_events, toolwait, transcript_records  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
OPERATOR = {'X-Orgtree-Desktop-Token': 'operator'}
ZERO = {name: 0 for name in cc.FIELDS}


def tearDownModule():
    census.set_enabled(False)
    census.reset()
    root.cleanup()


class SidecarCase(unittest.TestCase):
    def setUp(self):
        census.reset()
        census.set_enabled(True)
        self.addCleanup(lambda: (census.set_enabled(False), census.reset()))

    def attempt(self, body):
        """Run `body` as one attempt with its own tally; return the evidence
        exactly as the census publishes it."""
        tally = cc.Tally()
        token = cc.bind(tally)
        try:
            body()
        finally:
            cc.unbind(token)
        return census._contact_block(tally.seal())

    def primary(self, block):
        return {k: block[k] for k in cc.FIELDS}


# ------------------------------------------------ the factory

class FactoryTests(unittest.TestCase):

    def test_each_label_has_one_cached_observed_class(self):
        for label in cc.SIDECAR_STORES:
            with self.subTest(label=label):
                cls = cc.sidecar(label)
                self.assertTrue(issubclass(cls, cc.ObservedConnection))
                self.assertIs(cls, cc.sidecar(label))
                self.assertEqual(cls._census_label, label)
        self.assertIsNone(cc.ObservedConnection._census_label)
        self.assertEqual(len({cc.sidecar(label) for label in cc.SIDECAR_STORES}),
                         len(cc.SIDECAR_STORES))

    def test_an_undeclared_label_fails_closed(self):
        for bad in ('', 'transcript-records', 'TOOL_WAITS', 'primary', '../x', None, 3):
            with self.subTest(label=bad), self.assertRaises(ValueError):
                cc.sidecar(bad)

    def test_the_declared_sidecars_use_only_the_closed_labels(self):
        self.assertEqual({label for _, _, label in cc.SIDECARS}, set(cc.SIDECAR_STORES))
        self.assertEqual(len(cc.SIDECARS), 6)
        self.assertEqual(len(cc.SIDECAR_STORES), 5)


def _sidecar_calls(path):
    """(enclosing symbol, factory source) for every sqlite3.connect call."""
    tree = ast.parse((REPO / path).read_text(encoding='utf-8-sig'))
    found = []

    def walk(node, stack):
        for child in ast.iter_child_nodes(node):
            name = stack
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = stack + [child.name]
            if (isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
                    and child.func.attr == 'connect' and isinstance(child.func.value, ast.Name)
                    and child.func.value.id == 'sqlite3'):
                factory = [ast.unparse(k.value) for k in child.keywords if k.arg == 'factory']
                found.append(('.'.join(name), factory))
            walk(child, name)
    walk(tree, [])
    return found


class SiteGuardTests(unittest.TestCase):

    def test_every_connect_in_a_sidecar_file_passes_its_declared_label(self):
        """⚠ NO BARE CONNECT IN AN INSTRUMENTED FILE. A new call, a dropped
        `factory=` or a swapped label fails here, before any count is wrong."""
        declared = {}
        for path, symbol, label in cc.SIDECARS:
            declared[path, symbol] = label
        files = sorted({path for path, _, _ in cc.SIDECARS})
        self.assertEqual(len(files), 5)
        seen = set()
        for path in files:
            for symbol, factory in _sidecar_calls(path):
                with self.subTest(path=path, symbol=symbol):
                    self.assertIn((path, symbol), declared, 'undeclared connect in a sidecar file')
                    expected = f"census_contacts.sidecar('{declared[path, symbol]}')"
                    self.assertEqual(factory, [expected])
                    seen.add((path, symbol))
        self.assertEqual(seen, set(declared), 'declared sidecar sites that no longer connect')

    def test_the_guard_would_catch_a_bare_or_mislabelled_connect(self):
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            probe = Path(scratch) / 'probe.py'
            probe.write_text('import sqlite3\n'
                             'def a():\n    sqlite3.connect("x")\n'
                             'def b():\n    sqlite3.connect("x", factory=census_contacts.sidecar("tool_waits"))\n',
                             encoding='utf-8')
            # An absolute path: `REPO / path` then resolves to it unchanged.
            self.assertEqual(_sidecar_calls(str(probe)),
                             [('a', []), ('b', ["census_contacts.sidecar('tool_waits')"])])


# ------------------------------------------------ attribution by label

class AttributionTests(SidecarCase):

    def test_transcript_records_contacts_are_credited_to_their_label_only(self):
        def body():
            with transcript_records.database() as conn:
                conn.execute('SELECT COUNT(*) FROM transcript_sources').fetchone()
        got = self.attempt(body)
        self.assertEqual(self.primary(got), ZERO, 'a sidecar contact leaked into the primary fields')
        self.assertEqual(list(got['secondary']), ['transcript_records'])
        side = got['secondary']['transcript_records']
        self.assertEqual(side['connects'], 1)
        self.assertGreater(side['statements'], 0)
        self.assertEqual(side['kinds'].get('select'), 1)
        self.assertEqual(side['kinds'].get('commit'), 1, 'the with-block commit was not observed')
        self.assertEqual(side['hidden_steps'], 0, side)
        self.assertGreater(side['engine_steps'], 0)
        self.assertEqual((side['checkouts'], side['linked_threads']), (0, 0))

    def test_reply_events_connect_and_count_are_credited_to_reply_events(self):
        got = self.attempt(lambda: reply_events.lookup('rs-org', 'n1', 0, 'reply_x', 'scope'))
        self.assertEqual(list(got['secondary']), ['reply_events'])
        self.assertEqual(got['secondary']['reply_events']['connects'], 1)
        self.assertEqual(got['secondary']['reply_events']['hidden_steps'], 0)
        counted = self.attempt(lambda: reply_events.count('rs-org', 'n1'))
        self.assertEqual(list(counted['secondary']), ['reply_events'])
        side = counted['secondary']['reply_events']
        self.assertEqual((side['connects'], side['kinds'].get('select')), (1, 1), side)
        self.assertEqual(self.primary(counted), ZERO)

    def test_tool_waits_are_credited_to_tool_waits(self):
        got = self.attempt(lambda: toolwait._save({'id': 'op-a4b', 'state': 'running'}))
        side = got['secondary']['tool_waits']
        self.assertEqual(side['connects'], 1)
        self.assertEqual(side['kinds'].get('insert'), 1)
        self.assertEqual(side['kinds'].get('commit'), 1, 'the with-block commit was not observed')
        self.assertEqual(side['hidden_steps'], 0, side)
        self.attempt(lambda: toolwait._delete('op-a4b'))

    def test_a_with_block_rollback_is_one_observed_rollback(self):
        def body():
            with self.assertRaises(RuntimeError):
                with sqlite3.connect(str(data / 'rollback-probe.db'),
                                     factory=cc.sidecar('file_deliveries')) as conn:
                    conn.execute('CREATE TABLE IF NOT EXISTS t (x)')
                    conn.execute('INSERT INTO t VALUES (1)')
                    raise RuntimeError('abort')
        got = self.attempt(body)
        side = got['secondary']['file_deliveries']
        self.assertEqual(side['kinds'].get('rollback'), 1, side)
        self.assertNotIn('commit', side['kinds'])
        self.assertEqual(side['hidden_steps'], 0, side)

    def test_two_sidecars_in_one_attempt_stay_apart(self):
        def body():
            with transcript_records.database() as conn:
                conn.execute('SELECT 1').fetchone()
            toolwait.records()
        got = self.attempt(body)
        self.assertEqual(list(got['secondary']), ['transcript_records', 'tool_waits'])
        self.assertEqual(got['secondary']['transcript_records']['kinds'].get('select'), 1)
        self.assertEqual(self.primary(got), ZERO)

    def test_an_untouched_sidecar_is_absent_not_zero(self):
        got = self.attempt(lambda: None)
        self.assertNotIn('secondary', got)
        forged = cc.Tally()
        forged.add('connects', label='tool_waits')
        block = census._contact_block(forged.seal())
        self.assertEqual(list(block['secondary']), ['tool_waits'])

    def test_a_primary_store_contact_is_not_a_sidecar_contact(self):
        with tempfile.TemporaryDirectory(dir=root.name) as scratch:
            def body():
                conn = store._open_conn(str(Path(scratch) / 'p.db'), create=True)
                conn.close()
            got = self.attempt(body)
        self.assertNotIn('secondary', got)
        self.assertEqual(got['connects'], 1)


# ------------------------------------------------ threads

class ThreadTests(SidecarCase):

    def test_background_transcript_ingest_is_unattributed(self):
        """A thread nobody handed an attempt (as a background ingest is) is
        counted in db_unattributed and joined to no record."""
        before = cc.counters()['unattributed']

        def background():
            with transcript_records.database() as conn:
                conn.execute('SELECT 1').fetchone()

        def body():
            worker = threading.Thread(target=background)
            worker.start()
            worker.join()
        got = self.attempt(body)
        self.assertNotIn('secondary', got, 'an unhanded thread joined the attempt')
        self.assertGreater(cc.counters()['unattributed'] - before, 0,
                           'the background contacts were not counted anywhere')

    def test_an_adopting_worker_keeps_the_tool_waits_label(self):
        tally = cc.Tally()

        def worker():
            cc.adopt(tally)
            toolwait.records()
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
        got = census._contact_block(tally.seal())
        self.assertEqual(got['linked_threads'], 1)
        self.assertEqual(list(got['secondary']), ['tool_waits'])
        self.assertGreater(got['secondary']['tool_waits']['statements'], 0)


# ------------------------------------------------ privacy and off

class PrivacyTests(SidecarCase):

    def test_no_path_file_name_sql_or_identifier_reaches_the_evidence(self):
        def body():
            reply_events.lookup('secret-org-zz9', 'secret-node', 0, 'reply_secret', 'scope-secret')
            with transcript_records.database() as conn:
                conn.execute("SELECT 'zz-secret-value'").fetchone()
        got = self.attempt(body)
        text = json.dumps(got)
        for needle in ('secret', 'zz9', str(data), data.name, 'reply-events', 'transcript-records',
                       'sqlite3', 'SELECT', '.db'):
            self.assertNotIn(needle, text)
        self.assertTrue(set(got['secondary']) <= set(cc.SIDECAR_STORES))

    def test_a_forged_label_or_field_cannot_be_published(self):
        sealed = {'store': 'sqlite', **ZERO, 'kinds': {}, 'kind_failed': {},
                  'secondary': {'../etc/passwd': {'connects': 1}, 'other_store': {'connects': 1},
                                'tool_waits': {'connects': 2, 'sql': 'SELECT 1', 'path': 'C:/x',
                                               'kinds': {'select': 1, 'bogus': 5}}}}
        block = census._contact_block(sealed)
        self.assertEqual(list(block['secondary']), ['tool_waits'])
        side = block['secondary']['tool_waits']
        self.assertEqual(set(side), set(cc.FIELDS) | {'kinds', 'kind_failed'})
        self.assertEqual(side['kinds'], {'select': 1})
        self.assertEqual(side['connects'], 2)
        empty = census._contact_block({**sealed, 'secondary': {'tool_waits': {'kinds': {}}}})
        self.assertNotIn('secondary', empty, 'a sidecar with no contact must be absent')


class CaptureOffTests(unittest.TestCase):

    def test_off_observes_nothing_and_the_pragmas_still_apply(self):
        census.set_enabled(False)
        before = cc.counters()
        tally = cc.Tally()
        token = cc.bind(tally)
        try:
            with transcript_records.database() as conn:
                self.assertIsInstance(conn, cc.sidecar('transcript_records'))
                self.assertEqual(conn.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
                self.assertEqual(conn.execute('PRAGMA synchronous').fetchone()[0], 2)
            db = toolwait._db()
            try:
                self.assertIsInstance(db, cc.sidecar('tool_waits'))
                self.assertEqual(db.execute('PRAGMA synchronous').fetchone()[0], 2)
                self.assertFalse(db._census_traced)
            finally:
                db.close()
            reply_events.lookup('off-org', 'n', 0, 'x', 's')
        finally:
            cc.unbind(token)
        sealed = census._contact_block(tally.seal())
        self.assertEqual(self.primary_and_secondary(sealed), (ZERO, None))
        self.assertEqual(cc.counters(), before)

    @staticmethod
    def primary_and_secondary(block):
        return {k: block[k] for k in cc.FIELDS}, block.get('secondary')


# ------------------------------------------------ through the application

class RecordTests(SidecarCase):

    def test_an_http_attempt_publishes_its_sidecar_contacts_under_db_secondary(self):
        slug = 'sidecar-http-org'
        store.create_org(slug)
        self.addCleanup(store._POOL.close_all, slug)
        from orgtree import ledger
        with store.write_org(slug) as org:
            org.hire(ledger.USER, None, 'haiku', 0, 'probe')
            store.save_org(org)
        reply_events.lookup(slug, 'probe', 0, 'x', 's')   # make the sidecar file exist
        census.reset()
        client = TestClient(app)
        got = client.get(f'/api/orgs/{slug}/nodes/probe/reply-events', headers=OPERATOR)
        self.assertEqual(got.status_code, 200, got.text)
        body = client.get('/api/diagnostics/operation-census', headers=OPERATOR,
                          params={'n': 50}).json()
        self.assertEqual(body['schema_version'], 4)
        rows = [r for r in body['records'] if r['route'].endswith('/reply-events')]
        self.assertEqual(len(rows), 1)
        db = rows[0]['db']
        self.assertEqual(list(db['secondary']), ['reply_events'])
        self.assertEqual(db['secondary']['reply_events']['connects'], 1)
        self.assertGreater(db['statements'], 0, 'the org load is a primary contact')
        self.assertEqual(body['vocabulary']['db_secondary_store'], list(cc.SIDECAR_STORES))
        self.assertEqual(body['provenance']['measures_storage_contacts'],
                         'primary_and_listed_sidecar_sqlite_stores')
        self.assertEqual(body['contact_coverage']['secondary_stores'],
                         [{'path': p, 'symbol': s, 'label': label} for p, s, label in cc.SIDECARS])
        self.assertNotIn(slug, json.dumps(rows[0]))


if __name__ == '__main__':
    unittest.main()
