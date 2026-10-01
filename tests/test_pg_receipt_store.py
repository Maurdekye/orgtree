"""Converted custody receipts through the real store: load, standalone save,
org_tx, snapshot refresh, resident advance, purge, rename and compaction.
Runs with store.RECEIPT_ROWS patched on; production keeps it off."""
import copy
import unittest
import uuid
from unittest.mock import patch
import test_pg_receiptrows as fixture
from test_receiptrows import receipt
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
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

    def test_conversion_marks_the_org_and_an_off_switch_load_refuses(self):
        with self.raw() as raw:
            self.assertEqual(raw.execute("SELECT val FROM meta WHERE key='receipt_rows'").fetchone(),
                             ('1',))
        with patch.object(store, 'RECEIPT_ROWS', False):
            with self.assertRaisesRegex(ledger.LedgerError, 'ORGTREE_RECEIPT_ROWS'):
                store.load_org(self.slug)

    def test_an_absent_section_is_left_unconverted(self):
        org = store.create_org('receipt-absent-' + uuid.uuid4().hex[:8])
        store.save_org(org)
        with pgstore.connect() as raw:
            oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                              (org.d['slug'],)).fetchone()[0]
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{oid},public')
            self.assertIsNone(receiptstore.convert(raw, oid))
            self.assertIsNone(raw.execute("SELECT 1 FROM receipt_format").fetchone())
            self.assertIsNone(raw.execute("SELECT 1 FROM meta WHERE key='receipt_rows'").fetchone())
            raw.execute('ROLLBACK')
        # the legacy path still takes the first receipt
        org = store.load_org(org.d['slug'])
        org.d.setdefault('mail_transitions', {}).setdefault('n', {})['op'] = receipt('n', 'op', 'c')
        store.save_org(org)
        self.assertIn('op', store.load_org(org.d['slug']).d['mail_transitions']['n'])

    def test_a_marked_org_without_its_conversion_record_refuses_to_load(self):
        with self.raw() as raw:
            for table in ('receipt_carriers', 'receipts', 'receipt_owners', 'receipt_format'):
                raw.execute(f'DELETE FROM {table}')
            self.assertEqual(raw.execute("SELECT val FROM meta WHERE key='receipt_rows'").fetchone(),
                             ('1',))
        with self.assertRaisesRegex(ledger.LedgerError, 'no receipt_format record'):
            store.load_org(self.slug)
        with self.assertRaisesRegex(ledger.LedgerError, 'no receipt_format record'):
            self.full()                  # the export path, too

    def test_receipt_functions_put_pg_temp_last_and_the_old_creator_is_not_runtime_callable(self):
        with self.raw() as raw:
            for sig in ('orgtree_install_receipt_rows(bigint)',
                        'orgtree_put_receipt(bigint,text,text,text,text)',
                        'orgtree_delete_receipt(bigint,text,text,text)'):
                config = raw.execute('SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=%s::regprocedure',
                                     ('public.' + sig,)).fetchone()[0]
                self.assertIn('search_path=pg_catalog, public, pg_temp', config, sig)
            if raw.execute("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='orgtree_runtime'").fetchone() is None:
                self.skipTest('no orgtree_runtime role: EXECUTE check NOT RUN')
            old = 'public.orgtree_create_org_schema_before_receipts(bigint)'
            self.assertFalse(raw.execute("SELECT has_function_privilege('orgtree_runtime', %s, 'EXECUTE')",
                                         (old,)).fetchone()[0])
            self.assertTrue(raw.execute("SELECT has_function_privilege('orgtree_runtime', %s, 'EXECUTE')",
                                        ('public.orgtree_create_org_schema(bigint)',)).fetchone()[0])

    def sink(self):
        import importlib.util, os, sys
        from pathlib import Path
        spec = importlib.util.spec_from_file_location(
            'pgimport', Path(__file__).resolve().parents[1] / 'tools' / 'pypg' / 'pgimport.py')
        pgimport = importlib.util.module_from_spec(spec)
        sys.modules.setdefault('pgimport', pgimport)
        spec.loader.exec_module(pgimport)
        # the store's own per-module database, not the server admin URL
        return pgimport.PgSink(os.environ['ORGTREE_PG_URL'], Path(store._orgs_dir()))

    def test_reimport_carrying_the_converted_marker_is_refused_and_changes_nothing(self):
        import json
        sink = self.sink()
        try:
            rows = sink.read_org(self.slug)
            self.assertIn('receipt_rows', [r[0] for r in rows['meta']])
            rows['doc'] = sorted([*rows['doc'], ('mail_transitions', json.dumps(self.value))])
            with self.assertRaisesRegex(ValueError, 'receipt_rows'):
                sink.replace_org(self.slug, rows, {'source_fingerprint': 'receipt-marker'})
        finally:
            sink.conn.close()
        self.assertEqual(self.export(), self.value)
        self.assertIsInstance(store.load_org(self.slug).d['mail_transitions'],
                              receiptmapping.ReceiptSection)

    def test_reimport_over_a_converted_org_replaces_its_receipt_rows(self):
        import json
        sink = self.sink()
        try:
            rows = sink.read_org(self.slug)
            # an unconverted source: receipts as the doc blob, no marker
            rows['doc'] = sorted([*rows['doc'], ('mail_transitions', json.dumps(self.value))])
            rows['meta'] = [r for r in rows['meta'] if r[0] != 'receipt_rows']
            sink.replace_org(self.slug, rows, {'source_fingerprint': 'receipt-reimport'})
        finally:
            sink.conn.close()
        with self.raw() as raw:
            for table in ('receipt_format', 'receipt_owners', 'receipts', 'receipt_carriers'):
                self.assertEqual(raw.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0, table)
        org = store.load_org(self.slug)
        self.assertNotIsInstance(org.d['mail_transitions'], receiptmapping.ReceiptSection)
        self.assertEqual(org.d['mail_transitions'], self.value)
        with self.raw() as raw:          # and it converts again, not "already"
            proof = receiptstore.convert(raw, self.oid)
        self.assertNotIn('already_converted', proof)
        self.assertEqual(self.export(), self.value)

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

    def other_writer_puts(self, owner, token):
        with self.raw() as raw:
            receiptstore.put(raw, self.oid, owner, token, receipt(owner, token, token))

    def test_snapshot_view_reads_exactly_after_an_unrelated_commit(self):
        snapshot = store.cached_org(self.slug)
        self.assertTrue(snapshot.d['mail_transitions'].versioned)
        self.unrelated_save(2)
        self.other_writer_puts('empty', 'later')     # another owner changes too
        self.assertEqual(snapshot.d['mail_transitions']['z']['op'], self.value['z']['op'])
        self.assertNotIn('ghost', snapshot.d['mail_transitions'])

    def test_snapshot_view_refuses_an_owner_changed_after_it_was_taken(self):
        snapshot = store.cached_org(self.slug)
        self.other_writer_puts('z', 'later')
        with self.assertRaisesRegex(receiptmapping.StaleReceipts, 'owner changed'):
            snapshot.d['mail_transitions']['z']['op']

    def test_missing_owner_is_answered_from_the_loaded_summary(self):
        org = store.load_org(self.slug)
        with patch.object(receiptmapping, '_read', side_effect=AssertionError('query')):
            self.assertIsNone(org.d['mail_transitions'].get('ghost'))
            self.assertEqual(org.d['mail_transitions'].owner_keys(), ['z', 'empty'])

    def test_standalone_save_survives_an_unrelated_concurrent_commit(self):
        org = store.load_org(self.slug)
        org.d['mail_transitions']['z']['op']['extension']['note'] = 'after commit'
        self.other_writer_puts('empty', 'concurrent')
        store.save_org(org)
        self.assertEqual(self.export()['z']['op']['extension']['note'], 'after commit')
        self.assertEqual(store._resident_dirty(org.d), [])

    def test_standalone_save_refuses_a_concurrent_change_to_the_same_owner(self):
        org = store.load_org(self.slug)
        org.d['mail_transitions']['z']['op']['extension']['note'] = 'mine'
        self.other_writer_puts('z', 'theirs')
        with self.assertRaises(receiptmapping.StaleReceipts):
            store.save_org(org)
        self.assertEqual(store._resident_dirty(org.d), ['mail_transitions'],
                         'a refused write must stay pending')
        actual = self.export()
        self.assertIn('theirs', actual['z'])
        self.assertEqual(actual['z']['op'], self.value['z']['op'])

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
        def observed(slug_, revision, query, params, bound=None, owner_version=None):
            reads.append((query, params))
            return original(slug_, revision, query, params, bound, owner_version)
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
