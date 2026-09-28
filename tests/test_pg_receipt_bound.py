"""Receipt views loaded inside an org_tx: disjoint concurrent commits, ending
the transaction, and same-owner races. No production consumer switched yet."""
import contextlib
import copy
import unittest
import test_pg_receiptrows as fixture
from test_receiptrows import receipt
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, receiptcommit, receiptmapping, receiptstore, receiptwriter, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptBound(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw
    exported = fixture.ReceiptStorage.exported
    mapped = fixture.ReceiptStorage.mapped

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def setUp(self):
        fixture.ReceiptStorage.setUp(self)
        self.mapped()                      # convert the org's receipts once

    @contextlib.contextmanager
    def pinned(self, *, commit=True):
        """An org_tx-shaped transaction: one pinned connection, set as the
        thread's pinned map for exactly the transaction's lifetime."""
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
            conn = pgstore.PgConn(raw, self.slug, self.oid)
            conn.pinned = True
            pinned = {self.slug: conn}
            store._orgtx_local.pinned = pinned
            try:
                yield raw, conn
            except BaseException:
                raw.execute('ROLLBACK'); raise
            else:
                raw.execute('COMMIT' if commit else 'ROLLBACK')
                if commit:
                    receiptcommit.committed([conn])
            finally:
                store._orgtx_local.pinned = None
                receiptcommit.discard([conn])

    def revision(self, raw):
        return raw.execute('SELECT revision FROM public.orgs WHERE org_id=%s',
                           (self.oid,)).fetchone()[0]

    def disjoint_commit(self):
        """Another org_tx on unrelated rows: it only advances the revision."""
        with self.raw() as raw:
            pgstore.on_save_commit(pgstore.PgConn(raw, self.slug, self.oid), True)

    def save_in(self, raw, conn, view):
        plan = receiptwriter.prepare(view)
        receiptwriter.apply(raw, self.oid, plan)
        pgstore.on_save_commit(conn, bool(plan.owners))
        adoption = receiptwriter.adoption_after_revision(conn, view, plan)
        receiptcommit.defer(conn, lambda: adoption.install(view))
        return plan

    def test_bound_view_reads_and_writes_across_disjoint_concurrent_commit(self):
        with self.pinned() as (raw, conn):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
            self.assertIsNotNone(view.bound)
            self.disjoint_commit()
            held = view['z']['op']                     # lazy read after the commit
            held['extension']['note'] = 'bound edit'
            view['empty']['fresh'] = receipt('empty', 'fresh', 'fresh')
            plan = self.save_in(raw, conn, view)
            self.assertEqual(plan.owners, frozenset({'z', 'empty'}))
        self.assertFalse(receiptwriter.prepare(view).owners, 'adoption did not run')
        self.assertIs(view['z']['op'], held)
        with self.raw() as raw:
            actual = self.exported(raw)
        self.assertEqual(actual['z']['op']['extension']['note'], 'bound edit')
        self.assertIn('fresh', actual['empty'])

    def test_unbound_view_refuses_the_same_disjoint_commit(self):
        # The control: the snapshot rule is what made in-transaction use fail.
        with self.pinned(commit=False) as (raw, conn):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw))
            self.disjoint_commit()
            with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'deferred read'):
                view['z']['op']

    def test_bound_view_refuses_lazy_read_after_its_transaction(self):
        with self.pinned(commit=False) as (raw, _):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
            self.assertEqual(view['z']['op'], self.value['z']['op'])
        with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'after its transaction'):
            view['empty'].get('anything')
        # Already exposed values stay readable without the database.
        self.assertEqual(view['z']['op'], self.value['z']['op'])

    def test_bound_view_refuses_inside_a_later_transaction(self):
        with self.pinned(commit=False) as (raw, _):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
        with self.pinned(commit=False):
            with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'after its transaction'):
                view['z']['op']

    def test_bound_write_refuses_concurrent_change_to_same_owner(self):
        with self.pinned(commit=False) as (raw, conn):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
            view['z']['op']['extension']['note'] = 'mine'
            with self.raw() as other:
                receiptstore.put(other, self.oid, 'z', 'theirs', receipt('z', 'theirs', 'theirs'))
            with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'owner changed'):
                self.save_in(raw, conn, view)
        self.assertEqual(receiptwriter.prepare(view).owners, frozenset({'z'}),
                         'a refused write must stay pending')
        with self.raw() as raw:
            actual = self.exported(raw)
        self.assertIn('theirs', actual['z'])
        self.assertEqual(actual['z']['op'], self.value['z']['op'])

    def test_bound_plan_refuses_a_different_transaction(self):
        with self.pinned(commit=False) as (raw, _):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
            view['z']['op']['extension']['note'] = 'elsewhere'
            plan = receiptwriter.prepare(view)
            with self.raw(commit=False) as other:
                with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'outside its transaction'):
                    receiptwriter.apply(other, self.oid, plan)

    def test_deepcopy_shares_the_binding_not_the_connection(self):
        with self.pinned(commit=False) as (raw, _):
            view = receiptmapping.ReceiptSection(self.slug, self.revision(raw),
                                                 receiptmapping.binding(self.slug))
            clone = copy.deepcopy(view)
            self.assertIs(clone.bound, view.bound)
            self.assertIs(clone['z'].bound, view.bound)
            self.assertEqual(clone.plain(), self.value)

    def test_binding_is_none_outside_an_org_tx(self):
        store._orgtx_local.pinned = None
        self.assertIsNone(receiptmapping.binding(self.slug))
        store._orgtx_local.pinned = {'some-other-org': object()}
        try:
            self.assertIsNone(receiptmapping.binding(self.slug))
        finally:
            store._orgtx_local.pinned = None


if __name__ == '__main__':
    unittest.main()
