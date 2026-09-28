"""Stream identity caches survive saves that provably did not touch the node:
an unrelated save costs no PostgreSQL statement per streamed frame, and any
save that might have changed the identity (this node's row, the org
incarnation, a node insert/delete, an unjournaled bump) is re-read."""
import os
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_stream_journal_t{os.getpid()}'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

from test_prose_delta_lock import ProseDeltaBase
from orgtree import assistant_messages, ledger, orgtx, reply_events, store, tree_changes


class _Statements:
    def __init__(self):
        self.n = 0

    def __enter__(self):
        self.real = psycopg.Cursor.execute
        counter = self

        def counted(cur, *a, **k):
            counter.n += 1
            return counter.real(cur, *a, **k)
        psycopg.Cursor.execute = counted
        return self

    def __exit__(self, *exc):
        psycopg.Cursor.execute = self.real


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class StreamIdentityJournal(ProseDeltaBase):
    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    def setUp(self):
        super().setUp()
        org = store.load_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'other')
        store.save_org(org)
        self.ident()

    def ident(self):
        return (reply_events.identity(self.slug, 'agent'),
                assistant_messages.scope_ident(self.slug, 'agent'))

    def save_node(self, nid, **fields):
        with orgtx.org_tx(self.slug, nodes=[nid]) as tx:
            tx.org.d['nodes'][nid].update(fields)

    def test_unrelated_saves_cost_no_statement(self):
        before = self.ident()
        # more saves than the journal keeps: each call re-anchors the entry
        for i in range(tree_changes.MAX_HISTORY + 5):
            self.save_node('other', charter=f'unrelated {i}')
            with _Statements() as sql:
                self.assertEqual(self.ident(), before)
            self.assertEqual(sql.n, 0, f'save {i}')

    def test_own_row_change_is_reread(self):
        (_scope, generation), _ = self.ident()
        self.save_node('agent', generation=generation + 1)
        self.assertEqual(self.ident()[0][1], generation + 1)
        self.save_node('agent', session_id='sess-new')
        self.assertIn('sess-new', self.ident()[1])

    def test_org_incarnation_change_is_reread(self):
        (scope, _gen), _ = self.ident()
        with orgtx.org_tx(self.slug, sections=['reply_incarnation']) as tx:
            tx.org.d['reply_incarnation'] = 'rotated'
        (scope2, _), _ = self.ident()
        self.assertTrue(scope2.startswith('rotated:'), scope2)
        self.assertNotEqual(scope, scope2)

    def test_insert_or_unjournaled_bump_is_reread(self):
        self.ident()
        org = store.load_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'third')
        store.save_org(org)
        with _Statements() as sql:
            self.ident()
        self.assertGreater(sql.n, 0, 'a node insert must re-read')
        self.ident()
        store._bump_org_seq(self.slug)   # a bump the journal cannot describe
        with _Statements() as sql:
            self.ident()
        self.assertGreater(sql.n, 0, 'an unknown change must re-read')

    def test_journal_gap_beyond_history_is_reread(self):
        self.ident()
        for i in range(tree_changes.MAX_HISTORY + 1):
            self.save_node('other', charter=f'gap {i}')
        with _Statements() as sql:
            self.ident()
        self.assertGreater(sql.n, 0)


class UntouchedRule(unittest.TestCase):
    """`tree_changes.untouched` on a hand-built journal (no database)."""
    ROOT, SLUG = 'journal-root', 'journal-org'

    def journal(self, *changes):
        class C:
            def __init__(self, keys, updates=(), inserts=(), deletes=()):
                self.k, self.node_updates = keys, list(updates)
                self.node_inserts, self.node_deletes = list(inserts), list(deletes)

            def changed_keys(self):
                return self.k
        tree_changes.forget(self.ROOT, self.SLUG)
        self.addCleanup(tree_changes.forget, self.ROOT, self.SLUG)
        for seq, change in enumerate(changes, 1):
            tree_changes.publish(self.ROOT, self.SLUG, None if change is None else C(*change))
            tree_changes.commit(self.ROOT, self.SLUG, seq)
        return len(changes)

    def ok(self, through):
        return tree_changes.untouched(self.ROOT, self.SLUG, 0, through, 'a',
                                      reply_events.IDENTITY_KEYS)

    def test_rule(self):
        self.assertTrue(self.ok(self.journal((['nodes'], ['b']), (['mail'],))))
        self.assertFalse(self.ok(self.journal((['nodes'], ['a']))))
        self.assertFalse(self.ok(self.journal((['nodes'],))), 'whole-nodes blob write')
        self.assertFalse(self.ok(self.journal((['reply_incarnation', 'nodes'], ['b']))))
        self.assertFalse(self.ok(self.journal((['nodes'], [], ['c']))))
        self.assertFalse(self.ok(self.journal((['nodes'], [], [], ['c']))))
        # this node deleted (or any insert) in the same save as another
        # node's update: the deleted/inserted ids are not in `nodes`
        self.assertFalse(self.ok(self.journal((['nodes'], ['b'], [], ['a']))))
        self.assertFalse(self.ok(self.journal((['nodes'], ['b'], ['c']))))
        self.assertFalse(self.ok(self.journal((['mail'],), None)))
        self.assertTrue(tree_changes.untouched(self.ROOT, self.SLUG, 3, 3, 'a'))


def tearDownModule():
    if ADMIN:
        from orgtree import pgstore, transcript_records
        transcript_records.close_all()
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
