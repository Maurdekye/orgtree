"""A lazy org load is ONE round trip; a save skips reads it has no use for.

N1000 #3 landing 2 (2026-09-29): an agent tool call made three org loads of
four to eight statements each (BEGIN, the meta probe, the presence probe, the
eager doc rows, the work listing, the snapshot, COMMIT). With on-demand rows
on PostgreSQL, store._LoadOne reads all of them in one statement, and outside
org_tx without BEGIN/COMMIT (one statement is one snapshot). A save reads
MAX(ord) only when it inserts a node row, and the schema_version row only
when the document was not loaded by this code.

Actual PostgreSQL (disposable, via test_pgstore). What this proves:
  * a load outside org_tx sends exactly one statement, inside org_tx the load
    is one statement too, and the loaded document is complete (nodes on
    demand, doc keys, docket, snapshot for later fetches);
  * a load that must read more in one snapshot (a stale heal epoch) still
    runs in a transaction and gives the whole, healed document;
  * a save that adds a node puts it after every existing node (MAX(ord) is
    read), and a save that only changes a node does not read MAX(ord);
  * a save of a loaded document does not read schema_version; a created
    org still gets the row (control).

Run:  python tools/run-python-verification.py tests/test_pg_one_statement_load.py
"""
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, store
from test_work_item_rows import items


def tearDownModule():
    f.tearDownModule()


def node(nid):
    return {'id': nid, 'name': nid, 'parent': None, 'children': []}


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class OneStatementLoad(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True, LAZY_DOC_KEYS=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org('one-' + uuid.uuid4().hex[:10])
        self.slug = org.d['slug']
        for nid in ('a', 'b', 'c'):
            org.d['nodes'][nid] = node(nid)
        org.d['settings_x'] = {'v': 1}
        org.d['work_items'] = items()
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']):      # heal epoch, warm caches
            pass

    def statements(self, body):
        """Every statement `body` sends through PgConn, in order."""
        sent = []
        original = pgstore.PgConn.execute

        def execute(c, sql, params=()):
            sent.append(' '.join(str(sql).split()))
            return original(c, sql, params)
        with patch.object(pgstore.PgConn, 'execute', execute):
            result = body()
        return sent, result

    def ords(self):
        with store._POOL.acquire(self.slug) as conn:
            return dict(conn.execute('SELECT id, ord FROM nodes').fetchall())

    # -- the load ---------------------------------------------------------
    def test_a_load_outside_org_tx_is_one_statement(self):
        sent, org = self.statements(lambda: store._load_sqlite_org(self.slug, lazy_work=True))
        self.assertEqual(len(sent), 1, sent)
        self.assertIn('pg_current_snapshot', sent[0])
        self.assertTrue(org.d._load_snapshot)
        self.assertEqual(org.d['settings_x'], {'v': 1})
        self.assertEqual(sorted(w['slug'] for w in org.d['work_items']), ['one', 'two'])
        self.assertEqual(sorted(org.nodes), ['a', 'b', 'c'])        # fetched on demand

    def test_a_load_inside_org_tx_is_one_statement(self):
        def body():
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                return dict(tx.d['settings_x'])
        sent, got = self.statements(body)
        loads = [s for s in sent if 'FROM meta' in s or 'FROM log_d' in s
                 or 'strpos(key' in s or 'starts_with(key' in s]
        self.assertEqual(len(loads), 1, loads)
        self.assertEqual(got, {'v': 1})

    def test_a_stale_heal_epoch_still_loads_whole_in_a_transaction(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('UPDATE meta SET val=? WHERE key=?', ('stale', store._META_HEAL_EPOCH))
        sent, org = self.statements(lambda: store._load_sqlite_org(self.slug, lazy_work=True))
        self.assertIn('BEGIN', sent)
        self.assertTrue(any(s.startswith('SELECT id, val FROM nodes') for s in sent), sent)
        self.assertEqual(sorted(org.nodes), ['a', 'b', 'c'])
        self.assertEqual(org.d['settings_x'], {'v': 1})

    # -- the save ---------------------------------------------------------
    def test_a_new_node_goes_after_every_existing_node(self):
        with orgtx.org_tx(self.slug, nodes=['d']) as tx:
            tx.d['nodes']['d'] = node('d')
        ords = self.ords()
        self.assertEqual(len(set(ords.values())), 4, ords)
        self.assertGreater(ords['d'], max(v for k, v in ords.items() if k != 'd'))

    def test_changing_a_node_does_not_read_max_ord(self):
        def body():
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'renamed'
        sent, _ = self.statements(body)
        self.assertTrue(any(s.startswith('UPDATE nodes') for s in sent), 'control: saved')
        self.assertFalse([s for s in sent if 'MAX(ord)' in s])

    def test_a_loaded_save_does_not_read_schema_version(self):
        def body():
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'again'
        sent, _ = self.statements(body)
        self.assertFalse([s for s in sent if 'FROM meta WHERE key=' in s and 'schema' in s])
        reads = []
        real = store._meta_get

        def spy(conn, key):
            reads.append(key)
            return real(conn, key)
        with patch.object(store, '_meta_get', spy):
            body()
        self.assertNotIn('schema_version', reads)

    def test_a_created_org_still_gets_schema_version(self):
        org = store.create_org('one-new-' + uuid.uuid4().hex[:10])
        org.d['nodes']['x'] = node('x')
        store.save_org(org)
        with store._POOL.acquire(org.d['slug']) as conn:
            self.assertEqual(store._meta_get(conn, 'schema_version'), store._SCHEMA_VERSION)
        self.assertEqual(sorted(store.load_org(org.d['slug']).nodes), ['x'])


if __name__ == '__main__':
    unittest.main()
