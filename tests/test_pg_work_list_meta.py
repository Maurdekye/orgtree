"""Actual-PG list metadata; raw ledger projection remains the oracle."""
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as fixture
from orgtree import store, pgstore, workread, worklistmeta, workrows


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Metadata(unittest.TestCase):
    setUp = fixture.Counts.setUp
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    item = fixture.Counts.item
    refresh = fixture.Counts.refresh

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def read(self, slug='one'):
        return self.c.execute(f'SELECT payload FROM {self.s}.work_list_summary WHERE slug=%s', (slug,)).fetchone()[0]

    def test_static_fields_equal_raw_ledger_with_scope_and_legacy_history(self):
        item = self.item(scope_logged=2, scope_rolled=1,
                         scope=[{'seq':3,'at':'2023','kind':'decision'}],
                         history=[{'op':'update','at':'2020','changes':{'status':{}}}])
        item.pop('status_at', None)
        self.add(item)
        for seq in (1,2):
            self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                           (json.dumps({'seq':seq,'at':str(seq),'kind':'decision'}),))
        self.refresh()
        org = store.load_org(self.slug)
        raw = org._work_find('one')[0]
        payload = self.read()
        self.assertEqual(payload['objective_notice'], org._work_objective_notice(raw))
        self.assertEqual(payload['scope_archive_summary'], org._work_scope_archive_summary(raw))
        self.assertEqual(payload['status_at'], org._work_status_at(raw))
        self.assertEqual(payload['status_at'], '2020')
        self.assertNotIn('history', payload)
        self.assertNotIn('scope', payload)
        self.assertTrue(worklistmeta.ready(self.c,self.oid))

    def test_scope_only_external_change_is_dirty_and_refreshed(self):
        self.add(self.item(scope_logged=1, scope_rolled=1))
        self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                       (json.dumps({'seq':1,'at':'old'}),))
        self.refresh()
        self.c.execute(f"UPDATE {self.s}.log_d SET val=%s WHERE sect='work_scope_log' AND owner='one'",
                       (json.dumps({'seq':1,'at':'new'}),))
        self.assertFalse(worklistmeta.ready(self.c,self.oid))
        # The access fast path is clean; list refresh must still run.
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_read_dirty').fetchone())
        self.refresh()
        self.assertEqual(self.read()['scope_archive_summary']['first_at'],'new')
        self.assertTrue(worklistmeta.ready(self.c,self.oid))

    def test_small_and_tenfold_history_refresh_decodes_only_changed_body(self):
        sizes=[]
        for total in (20,200):
            start = 0 if total==20 else 20
            for i in range(start,total):
                self.add(self.item('old-'+str(i),status='done',evidence=[{'note':'x'*1000}]),True)
            self.add(self.item()); self.refresh()
            self.add(self.item(title='changed'))
            original=worklistmeta._body
            with patch.object(worklistmeta,'_body',wraps=original) as body:
                self.refresh()
                self.assertEqual(body.call_count,1)
            sizes.append(len(json.dumps(self.read())))
            with patch.object(worklistmeta,'_body',side_effect=AssertionError('history read on clean save')):
                self.refresh()
        self.assertEqual(sizes[0],sizes[1])

    def test_archive_reopen_delete_and_rollback_preserve_metadata(self):
        self.add(self.item()); self.refresh(); before=self.read()
        with self.assertRaisesRegex(RuntimeError,'rollback'):
            with self.c.transaction():
                self.add(self.item(title='uncommitted')); self.refresh()
                raise RuntimeError('rollback')
        self.assertEqual(self.read(),before)
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.add(self.item(status='done'),True); self.refresh()
        self.assertEqual(self.read()['status'],'done')
        self.c.execute(f"DELETE FROM {self.s}.log_l WHERE sect='work_items_archive'")
        self.add(self.item()); self.refresh()
        self.assertEqual(self.read()['status'],'open')
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.refresh()
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_summary').fetchone())

    def test_reconciliation_catches_payload_hash_and_extra_rows(self):
        self.add(self.item()); self.refresh()
        for sql in (f"UPDATE {self.s}.work_list_summary SET payload='{{}}'",
                    f"UPDATE {self.s}.work_list_summary SET body_sha256='wrong'::bytea",
                    f"INSERT INTO {self.s}.work_list_summary VALUES('ghost','wrong'::bytea,'{{}}')"):
            with self.c.transaction(force_rollback=True):
                self.c.execute(sql)
                with self.assertLogs('orgtree.worklistmeta',level='ERROR'):
                    self.assertFalse(worklistmeta.reconcile(self.c,self.oid))
                self.assertFalse(worklistmeta.ready(self.c,self.oid))

    def test_malformed_scope_fails_closed_without_losing_raw_save(self):
        self.add(self.item(scope_logged=1))
        with self.assertLogs('orgtree.worklistmeta',level='ERROR'):
            self.refresh()
        self.assertFalse(worklistmeta.ready(self.c,self.oid))
        self.assertTrue(self.c.execute(f'SELECT 1 FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone())
        self.assertTrue(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_identity_stamp_excludes_status_text_but_includes_current_mint(self):
        self.add(self.item()); self.refresh()
        def rev():
            return self.c.execute(f'SELECT revision FROM {self.s}.work_list_state').fetchone()[0]
        before=rev()
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{status}}','\"working\"')::text WHERE id='a'")
        self.assertEqual(rev(),before)
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{seat_id}}','\"new-mint\"')::text WHERE id='a'")
        self.assertGreater(rev(),before)
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_bootstrap_initializes_and_refreshes_scope_only_pending(self):
        self.add(self.item())
        with self.c.transaction(): workread.bootstrap(self.c)
        self.assertTrue(worklistmeta.ready(self.c,self.oid))
        self.c.execute(f"UPDATE {self.s}.work_list_summary SET payload='{{}}'")
        self.c.execute(f"INSERT INTO {self.s}.work_list_dirty VALUES('one')")
        with self.c.transaction(): workread.bootstrap(self.c)
        self.assertEqual(self.read()['slug'],'one')


if __name__ == '__main__':
    unittest.main()
