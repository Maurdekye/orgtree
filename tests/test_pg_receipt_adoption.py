"""Actual receipt baseline adoption: retained aliases, rollback and commit races."""
import unittest
import test_pg_receiptrows as fixture
from test_receiptrows import receipt
from orgtree import pgstore, receiptcommit, receiptmapping, receiptstore, receiptwriter


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptAdoption(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw
    exported = fixture.ReceiptStorage.exported
    version = fixture.ReceiptStorage.version
    mapped = fixture.ReceiptStorage.mapped

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def setUp(self):
        fixture.ReceiptStorage.setUp(self)
        self.view = self.mapped()

    def save(self, *, commit=True, before_revision=None, before_capture=None, force_revision=False):
        plan = receiptwriter.prepare(self.view)
        conn = None
        try:
            # Like PgBackend: adopt on the still-open connection right after
            # its server COMMIT. A closed connection is not IDLE and is refused.
            with pgstore.connect() as raw:
                raw.execute('BEGIN')
                raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
                try:
                    conn = pgstore.PgConn(raw, self.slug, self.oid)
                    receiptwriter.apply(raw, self.oid, plan)
                    if before_revision:
                        before_revision()
                    pgstore.on_save_commit(conn, bool(plan.owners) or force_revision)
                    if before_capture:
                        before_capture()
                    adoption = receiptwriter.adoption_after_revision(conn, self.view, plan)
                    receiptcommit.defer(conn, lambda: adoption.install(self.view))
                except BaseException:
                    raw.execute('ROLLBACK'); raise
                raw.execute('COMMIT' if commit else 'ROLLBACK')
                if commit:
                    receiptcommit.committed([conn])
        finally:
            if conn is not None:
                receiptcommit.discard([conn])
        return plan

    def test_held_nested_reference_remains_attached_and_next_save_finds_edit(self):
        held = self.view['z']['op']
        held['extension']['note'] = 'first'
        old_revision = self.view.revision
        self.save()
        self.assertIs(self.view['z']['op'], held)
        self.assertEqual(self.view.revision, old_revision + 1)
        self.assertFalse(receiptwriter.prepare(self.view).owners)
        held['extension']['note'] = 'second'
        self.assertEqual(receiptwriter.prepare(self.view).owners, frozenset({'z'}))
        self.save()
        with self.raw() as raw:
            self.assertEqual(self.exported(raw)['z']['op']['extension']['note'], 'second')
        self.assertIs(self.view['z']['op'], held)

    def test_plain_owner_alias_direct_deletion_and_insertion_are_not_lost(self):
        held = {'first': receipt('new', 'first', 'one')}
        self.view['new'] = held
        self.save()
        self.assertIs(self.view['new'], held)
        self.assertFalse(receiptwriter.prepare(self.view).owners)
        del held['first']
        held['second'] = receipt('new', 'second', 'two')
        self.save()
        with self.raw() as raw:
            self.assertEqual(self.exported(raw)['new'], held)
            self.assertEqual(list(self.exported(raw)['new']), ['second'])
        self.assertIs(self.view['new'], held)

    def test_rollback_keeps_all_baselines_and_allows_exact_retry(self):
        self.view['z']['new'] = receipt('z', 'new', 'new')
        del self.view['empty']
        before = receiptwriter.prepare(self.view)
        self.save(commit=False)
        self.assertEqual(receiptwriter.prepare(self.view), before)
        with self.raw() as raw:
            self.assertEqual(self.exported(raw), self.value)
        self.save()
        self.assertFalse(receiptwriter.prepare(self.view).owners)
        self.assertNotIn('empty', self.view)
        self.assertEqual(len(self.view['z']), 2)

    def test_edit_after_prepare_refuses_before_commit_and_keeps_edit_pending(self):
        held = self.view['z']['op']
        held['extension']['note'] = 'prepared'
        with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'changed before commit'):
            self.save(before_capture=lambda: held['extension'].__setitem__('note', 'later'))
        self.assertEqual(held['extension']['note'], 'later')
        self.assertTrue(receiptwriter.prepare(self.view).owners)
        with self.raw() as raw:
            self.assertEqual(self.exported(raw), self.value)

    def test_disjoint_owner_commit_cannot_retag_stale_cached_data(self):
        # Cache a second owner before the other writer changes it.
        self.assertEqual(len(self.view['empty']), 0)
        self.view['z']['new'] = receipt('z', 'new', 'new')
        before = receiptwriter.prepare(self.view)
        def other_commit():
            with self.raw() as raw:
                conn = pgstore.PgConn(raw, self.slug, self.oid)
                receiptstore.put(raw, self.oid, 'empty', 'other', receipt('empty', 'other', 'other'))
                pgstore.on_save_commit(conn, True)
        with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'intervening commit'):
            self.save(before_revision=other_commit)
        self.assertEqual(receiptwriter.prepare(self.view), before)
        with self.raw() as raw:
            actual = self.exported(raw)
            self.assertEqual(actual['z'], self.value['z'])
            self.assertIn('other', actual['empty'])

    def test_owner_move_adopts_existing_mapping_without_detaching_receipts(self):
        held_owner = self.view.pop('z')
        held_receipt = held_owner['op']
        self.view['z'] = held_owner
        self.save()
        self.assertIs(self.view['z'], held_owner)
        self.assertIs(held_owner['op'], held_receipt)
        self.assertFalse(receiptwriter.prepare(self.view).owners)
        held_receipt['extension']['note'] = 'after move'
        self.save()
        with self.raw() as raw:
            actual = self.exported(raw)
            self.assertEqual(list(actual), ['empty', 'z'])
            self.assertEqual(actual['z']['op']['extension']['note'], 'after move')

    def test_noop_and_other_doc_revision_keep_deferred_receipts_readable(self):
        old_revision = self.view.revision
        self.save()
        self.assertEqual(self.view.revision, old_revision)
        self.save(force_revision=True)
        self.assertEqual(self.view.revision, old_revision + 1)
        self.assertEqual(self.view['z']['op'], self.value['z']['op'])


if __name__ == '__main__':
    unittest.main()
