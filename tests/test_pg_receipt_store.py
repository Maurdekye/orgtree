"""Converted custody receipts through the real store: load, standalone save,
org_tx, snapshot refresh, resident advance, purge, rename and compaction.
Runs with store.RECEIPT_ROWS patched on; production keeps it off."""
import copy
import unittest
import uuid
from unittest.mock import patch
import test_pg_receiptrows as fixture
from test_receiptrows import receipt
from orgtree import (ledger, mailruntime, orgtx, pgstore, receiptmapping, receiptstore,
                     store)


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptStore(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw
    exported = fixture.ReceiptStorage.exported

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def setUp(self):
        switch = patch.object(store, 'RECEIPT_ROWS', True)
        switch.start()
        self.addCleanup(switch.stop)
        fixture.ReceiptStorage.setUp(self)
        self.order = list(self.full())
        self.convert()

    def convert(self):
        with self.raw() as raw:
            self.assertIsNotNone(receiptstore.convert(raw, self.oid))

    def full(self):
        with store._POOL.acquire(self.slug) as conn:
            return store.reconstruct_full(conn)

    def export(self):
        with self.raw() as raw:
            return self.exported(raw)

    def disjoint_commit(self):
        with self.raw() as raw:
            pgstore.on_save_commit(pgstore.PgConn(raw, self.slug, self.oid), True)

    def unrelated_save(self, value):
        org = store.load_org(self.slug)
        org.d['receipt_probe'] = {'value': value}
        store.save_org(org)

    # -- load / export ----------------------------------------------------
    def test_load_gives_row_backed_section_with_same_content_and_key_order(self):
        org = store.load_org(self.slug)
        section = org.d['mail_transitions']
        self.assertIsInstance(section, receiptmapping.ReceiptSection)
        self.assertIsNone(section.bound, 'a load outside org_tx must not bind')
        self.assertEqual(section.plain(), self.value)
        full = self.full()
        self.assertEqual(list(full), self.order)
        self.assertEqual(full['mail_transitions'], self.value)

    # -- standalone save --------------------------------------------------
    def test_standalone_save_writes_changed_rows_and_adopts_for_the_next_save(self):
        org = store.load_org(self.slug)
        held = org.d['mail_transitions']['z']['op']
        held['extension']['note'] = 'first'
        org.d['mail_transitions']['z']['new'] = receipt('z', 'new', 'fresh')
        store.save_org(org)
        self.assertEqual(store._resident_dirty(org.d), [], 'adoption did not run')
        held['extension']['note'] = 'second'
        self.assertEqual(store._resident_dirty(org.d), ['mail_transitions'])
        store.save_org(org)
        actual = self.export()
        self.assertEqual(actual['z']['op']['extension']['note'], 'second')
        self.assertIn('new', actual['z'])
        self.assertEqual(store.load_org(self.slug).d['mail_transitions'].plain(), actual)

    def test_unsaved_nested_edit_is_reported_dirty(self):
        org = store.load_org(self.slug)
        self.assertEqual(store._resident_dirty(org.d), [])
        org.d['mail_transitions']['z']['op']['extension']['note'] = 'unsaved'
        self.assertEqual(store._resident_dirty(org.d), ['mail_transitions'])

    # -- org_tx -----------------------------------------------------------
    def test_org_tx_view_is_bound_and_survives_a_disjoint_commit(self):
        with orgtx.org_tx(self.slug, sections=['mail_transitions']) as tx:
            section = tx.org.d['mail_transitions']
            self.assertIsNotNone(section.bound)
            self.disjoint_commit()
            section['empty']['added'] = receipt('empty', 'added', 'added')
            section['z']['op']['extension']['note'] = 'in tx'
        actual = self.export()
        self.assertIn('added', actual['empty'])
        self.assertEqual(actual['z']['op']['extension']['note'], 'in tx')

    def test_org_tx_receipt_write_needs_the_exclusive_section_lock(self):
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, share_sections=['mail_transitions']) as tx:
                tx.org.d['mail_transitions']['z']['op']['extension']['note'] = 'unlocked'
        self.assertEqual(self.export(), self.value)

    # -- snapshot cache ---------------------------------------------------
    def test_snapshot_refresh_keeps_receipts_after_an_unrelated_save(self):
        first = store.cached_org(self.slug)
        self.assertEqual(first.d['mail_transitions']['z']['op'], self.value['z']['op'])
        self.unrelated_save(1)
        # the incremental refresh must carry the section, not a full reload
        with patch.object(store, '_load_pinned', side_effect=AssertionError('full reload')):
            second = store.cached_org(self.slug)
        self.assertIsNot(second, first)
        self.assertIn('mail_transitions', second.d)
        self.assertEqual(second.d['mail_transitions'].plain(), self.value)
        self.assertEqual(second.d._key_order, first.d._key_order + ['receipt_probe'])

    def test_snapshot_refresh_sees_a_receipt_save(self):
        store.cached_org(self.slug)
        org = store.load_org(self.slug)
        org.d['mail_transitions']['empty']['seen'] = receipt('empty', 'seen', 'seen')
        store.save_org(org)
        with patch.object(store, '_load_pinned', side_effect=AssertionError('full reload')):
            refreshed = store.cached_org(self.slug)
        self.assertIn('seen', refreshed.d['mail_transitions']['empty'])

    def test_snapshot_view_refuses_a_lazy_read_after_a_later_commit(self):
        snapshot = store.cached_org(self.slug)
        self.unrelated_save(2)
        with self.assertRaises(receiptmapping.StaleReceipts):
            snapshot.d['mail_transitions']['empty']

    # -- resident ---------------------------------------------------------
    def test_resident_advance_retags_a_clean_view(self):
        resident, _ = store._load_pinned(self.slug, resident=True)
        self.unrelated_save(3)
        self.assertTrue(store._advance_resident(self.slug, resident.d))
        self.assertEqual(resident.d['mail_transitions']['z']['op'], self.value['z']['op'])

    def test_resident_advance_refuses_pending_receipt_edits(self):
        resident, _ = store._load_pinned(self.slug, resident=True)
        resident.d['mail_transitions']['z']['op']['extension']['note'] = 'pending'
        self.unrelated_save(4)
        self.assertFalse(store._advance_resident(self.slug, resident.d))

    # -- refusals ---------------------------------------------------------
    def test_wholesale_replacement_and_removal_are_refused(self):
        org = store.load_org(self.slug)
        org.d['mail_transitions'] = {'z': {}}
        with self.assertRaises(ledger.LedgerError):
            store.save_org(org)
        org = store.load_org(self.slug)
        org.d.pop('mail_transitions')
        with self.assertRaises(ledger.LedgerError):
            store.save_org(org)
        self.assertEqual(self.export(), self.value)

    # -- ledger semantics on the row-backed section -------------------------
    def test_purge_deletes_the_owner_rows(self):
        org = store.load_org(self.slug)
        self.assertEqual(org._purge_deleted_seat_records({'z'})['mail_transitions'], 1)
        store.save_org(org)
        self.assertEqual(self.export(), {'empty': {}})

    def test_compaction_drops_settled_receipts_and_keeps_protected_ones(self):
        org = store.load_org(self.slug)
        org.d['mail_transitions']['z']['held'] = receipt('z', 'held', 'protected')
        store.save_org(org)
        state = {'mail_confirmed': {'carrier', 'protected'}}
        self.assertEqual(mailruntime.compact_receipts(org, state, 'z', keep=['held']), 1)
        store.save_org(org)
        self.assertEqual(set(self.export()['z']), {'held'})
        self.assertIn('carrier', mailruntime.reclaimed(state, ['carrier']))


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptStoreRename(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw
    exported = fixture.ReceiptStorage.exported

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def test_rename_moves_owner_and_embedded_node_without_walking_history(self):
        switch = patch.object(store, 'RECEIPT_ROWS', True)
        switch.start()
        self.addCleanup(switch.stop)
        org = store.create_org('receipt-rename-' + uuid.uuid4().hex[:8])
        slug = org.d['slug']
        org.hire(ledger.USER, None, 'haiku', 0, 'z')
        value = {'z': {'op': receipt('z', 'op', 'carrier')},
                 'other': {'op': receipt('other', 'op', 'other')}}
        org.d['mail_transitions'] = copy.deepcopy(value)
        store.save_org(org)
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                   (slug,)).fetchone()[0]
        self.slug = slug
        with self.raw() as raw:
            receiptstore.convert(raw, self.oid)
        org = store.load_org(slug)
        reads = []
        original = receiptmapping._read
        def observed(slug_, revision, query, params, bound=None):
            reads.append((query, params))
            return original(slug_, revision, query, params, bound)
        with patch.object(receiptmapping, '_read', side_effect=observed):
            org.rename(ledger.USER, 'z', 'renamed')
        walked = [p for q, p in reads if 'ORDER BY ord' in q and p]
        self.assertNotIn(('other',), walked, 'rename materialised an unrelated owner')
        store.save_org(org)
        with self.raw() as raw:
            actual = self.exported(raw)
        self.assertNotIn('z', actual)
        self.assertEqual(actual['renamed']['op']['node'], 'renamed')
        self.assertEqual(actual['other'], value['other'])


if __name__ == '__main__':
    unittest.main()
