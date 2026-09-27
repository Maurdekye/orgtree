"""Actual PostgreSQL storage controls; no production consumer switched yet."""
import copy
import contextlib
import json
import threading
import unittest
import uuid
from unittest.mock import patch
import test_pgstore as f
from test_receiptrows import receipt
from orgtree import ledger, mailruntime, pgstore, receiptrows, receiptstore, store


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('receipt-'+uuid.uuid4().hex[:10])
        self.value = {'z': {'op': receipt('z', 'op', 'carrier')}, 'empty': {}}
        org.d['mail_transitions'] = self.value
        store.save_org(org); self.slug = org.d['slug']
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (self.slug,)).fetchone()[0]

    @contextlib.contextmanager
    def raw(self, commit=True):
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
            try:
                yield raw
            except BaseException:
                raw.execute('ROLLBACK'); raise
            else:
                raw.execute('COMMIT' if commit else 'ROLLBACK')

    def test_convert_preserves_exact_rows_counts_checksum_and_empty_owner(self):
        with self.raw() as raw:
            proof = receiptstore.convert(raw, self.oid)
            self.assertEqual(proof, receiptrows.verify(receiptrows.split(json.dumps(self.value))))
            self.assertIsNone(raw.execute("SELECT val FROM doc WHERE key='mail_transitions'").fetchone())
            self.assertEqual(raw.execute('SELECT owner,nrows FROM receipt_owners ORDER BY ord').fetchall(), [('z',1),('empty',0)])
            self.assertEqual(receiptstore.read_operations(raw,'z',['op']), self.value['z'])
            self.assertTrue(receiptstore.convert(raw,self.oid)['already_converted'])

    def test_unknown_shape_and_absent_marker_do_not_look_empty(self):
        with self.raw() as raw:
            raw.execute("UPDATE doc SET val=%s WHERE key='mail_transitions'", ('{"z":null}',))
            self.assertIsNone(receiptstore.convert(raw,self.oid))
            self.assertIsNone(receiptstore.read_operations(raw,'z',['op']))
            self.assertEqual(raw.execute("SELECT val FROM doc WHERE key='mail_transitions'").fetchone()[0], '{"z":null}')
            self.assertEqual(raw.execute('SELECT count(*) FROM receipts').fetchone()[0],0)

    def test_verification_failure_rolls_back_source_rows_and_marker(self):
        original = receiptrows.verify
        calls = []
        def corrupt(converted):
            calls.append(1)
            if len(calls)==2:
                raise receiptrows.Unsupported('injected lost receipt checksum')
            return original(converted)
        with self.assertRaises(receiptrows.Unsupported):
            with self.raw() as raw, patch.object(receiptrows,'verify',side_effect=corrupt):
                receiptstore.convert(raw,self.oid)
        self.assertEqual(len(calls),2)
        with self.raw() as raw:
            self.assertEqual(raw.execute('SELECT count(*) FROM receipts').fetchone()[0],0)
            self.assertEqual(raw.execute('SELECT count(*) FROM receipt_format').fetchone()[0],0)
            self.assertEqual(json.loads(raw.execute("SELECT val FROM doc WHERE key='mail_transitions'").fetchone()[0]),self.value)
            self.assertEqual(receiptstore.convert(raw,self.oid)['receipts'],1)

    def test_targeted_put_is_idempotent_and_cas_refuses_stale(self):
        value = receipt('z','new','fresh')
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            self.assertEqual(receiptstore.put(raw,self.oid,'z','new',value),1)
            self.assertEqual(receiptstore.put(raw,self.oid,'z','new',value),1)
            self.assertEqual(raw.execute("SELECT nrows FROM receipt_owners WHERE owner='z'").fetchone()[0],2)
        changed=dict(value,outcome='reclaimed')
        with self.assertRaises(Exception):
            with self.raw() as raw:
                receiptstore.put(raw,self.oid,'z','new',changed)
        with self.raw() as raw:
            self.assertEqual(receiptstore.read_operations(raw,'z',['new']),{'new':value})
            self.assertEqual(receiptstore.put(raw,self.oid,'z','new',changed,expected=receiptrows.dumps(value)),2)
            self.assertEqual(raw.execute("SELECT count(*) FROM receipt_carriers WHERE owner='z' AND token='new'").fetchone()[0],1)

    def test_same_operation_token_in_other_owner_is_isolated(self):
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            other=receipt('other','op','carrier')
            receiptstore.put(raw,self.oid,'other','op',other)
            self.assertEqual(receiptstore.read_operations(raw,'z',['op']),self.value['z'])
            self.assertEqual(receiptstore.read_operations(raw,'other',['op']),{'op':other})
            with self.assertRaises(receiptrows.Unsupported):
                receiptstore.put(raw,self.oid,'z','op',other)

    def test_concurrent_appends_keep_every_receipt_and_exact_summary(self):
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
        errors=[]; barrier=threading.Barrier(2)
        def append(prefix):
            try:
                barrier.wait(timeout=5)
                for i in range(4):
                    token=f'{prefix}-{i}'
                    with self.raw() as raw:
                        receiptstore.put(raw,self.oid,'z',token,receipt('z',token,token))
            except BaseException as exc:
                errors.append(repr(exc))
        threads=[threading.Thread(target=append,args=(str(i),)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(10)
        self.assertFalse(any(t.is_alive() for t in threads)); self.assertEqual(errors,[])
        with self.raw() as raw:
            self.assertEqual(raw.execute("SELECT nrows FROM receipt_owners WHERE owner='z'").fetchone()[0],9)
            self.assertEqual(raw.execute("SELECT count(*) FROM receipts WHERE owner='z'").fetchone()[0],9)
            self.assertEqual(raw.execute("SELECT count(*) FROM receipt_carriers WHERE owner='z'").fetchone()[0],9)

    def test_wrong_org_conversion_and_outside_transaction_are_refused(self):
        with self.raw() as raw:
            with self.assertRaises(RuntimeError): receiptstore.convert(raw,self.oid+1000)
        with pgstore.connect() as raw:
            with self.assertRaises(RuntimeError): receiptstore.convert(raw,self.oid)


    def exported(self, raw):
        present, value=receiptstore.export(raw)
        self.assertTrue(present)
        return value

    def version(self, raw, owner):
        row=raw.execute('SELECT version FROM receipt_owners WHERE owner=%s', (owner,)).fetchone()
        return row[0] if row else None

    def test_delete_then_append_preserves_order_without_reusing_ordinal(self):
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            receiptstore.put(raw,self.oid,'z','second',receipt('z','second','two'))
            before=receiptrows.dumps(self.value['z']['op'])
            self.assertTrue(receiptstore.delete(raw,self.oid,'z','op',expected=before))
            self.assertFalse(receiptstore.delete(raw,self.oid,'z','op',expected=before))
            receiptstore.put(raw,self.oid,'z','third',receipt('z','third','three'))
            self.assertEqual(raw.execute("SELECT token,ord FROM receipts WHERE owner='z' ORDER BY ord").fetchall(), [('second',1),('third',2)])
            self.assertEqual(raw.execute("SELECT nrows,next_ord FROM receipt_owners WHERE owner='z'").fetchone(), (2,3))
            self.assertEqual(raw.execute("SELECT count(*) FROM receipt_carriers WHERE owner='z' AND token='op'").fetchone()[0],0)

    def test_stale_delete_keeps_new_receipt_and_other_owner(self):
        old=receiptrows.dumps(self.value['z']['op'])
        changed=dict(self.value['z']['op'], outcome='reclaimed')
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            receiptstore.put(raw,self.oid,'empty','op',receipt('empty','op','carrier'))
            receiptstore.put(raw,self.oid,'z','op',changed,expected=old)
        with self.assertRaises(Exception):
            with self.raw() as raw:
                receiptstore.delete(raw,self.oid,'z','op',expected=old)
        with self.raw() as raw:
            self.assertEqual(receiptstore.read_operations(raw,'z',['op']),{'op':changed})
            self.assertEqual(len(receiptstore.read_operations(raw,'empty',['op'])),1)

    def test_explicit_purge_matches_ledger_and_preserves_other_owners(self):
        legacy=store.load_org(self.slug)
        self.assertEqual(legacy._purge_deleted_seat_records({'z'})['mail_transitions'],1)
        expected=copy.deepcopy(legacy.d['mail_transitions'])
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            receiptstore.replace_owners(raw,self.oid,{'z':(self.version(raw,'z'),None)})
            self.assertEqual(self.exported(raw),expected)
            self.assertEqual(raw.execute("SELECT count(*) FROM receipt_carriers WHERE owner='z'").fetchone()[0],0)

    def test_rename_matches_ledger_owner_and_embedded_node_identity(self):
        legacy=store.load_org(self.slug)
        legacy.hire(ledger.USER,None,'haiku',0,'z')
        # Hiring quarantines stale freed-name data by design: install the same
        # source only after the seat exists so this tests an ordinary rename.
        legacy.d['mail_transitions']=copy.deepcopy(self.value)
        legacy.rename(ledger.USER,'z','renamed')
        expected=copy.deepcopy(legacy.d['mail_transitions'])
        self.assertNotIn('z',expected)
        self.assertEqual(expected['renamed']['op']['node'],'renamed')
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            receiptstore.replace_owners(raw,self.oid,{
                'z':(self.version(raw,'z'),None),
                'renamed':(None,expected['renamed'])})
            actual=self.exported(raw)
            self.assertEqual(actual,expected)
            self.assertEqual(list(actual),list(expected))

    def test_existing_compaction_keeps_protected_receipts_and_tombstones(self):
        legacy=store.load_org(self.slug)
        legacy.d['mail_transitions']['z']['held']=receipt('z','held','protected')
        store.save_org(legacy)
        original=copy.deepcopy(legacy.d['mail_transitions']['z'])
        state={'mail_confirmed':{'carrier','protected'}}
        self.assertEqual(mailruntime.compact_receipts(legacy,state,'z',keep=['held']),1)
        expected=copy.deepcopy(legacy.d['mail_transitions'])
        self.assertEqual(set(expected['z']),{'held'})
        self.assertNotIn('carrier',state['mail_confirmed'])
        self.assertIn('carrier',mailruntime.reclaimed(state,['carrier']))
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            receiptstore.delete(raw,self.oid,'z','op',expected=receiptrows.dumps(original['op']))
            self.assertEqual(self.exported(raw),expected)

    def test_old_owner_version_cannot_purge_a_recreated_owner(self):
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            old_version=self.version(raw,'z')
            receiptstore.replace_owners(raw,self.oid,{'z':(old_version,None)})
            receiptstore.put(raw,self.oid,'z','op',self.value['z']['op'])
            self.assertNotEqual(self.version(raw,'z'),old_version)
        with self.assertRaises(receiptrows.Unsupported):
            with self.raw() as raw:
                receiptstore.replace_owners(raw,self.oid,{'z':(old_version,None),'empty':(None,None)})
        with self.raw() as raw:
            self.assertEqual(self.exported(raw)['z'],self.value['z'])
            self.assertIn('empty',self.exported(raw))



    def test_export_refuses_lost_carrier_and_incorrect_count(self):
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
        for corruption in ["DELETE FROM receipt_carriers WHERE owner='z'",
                           "UPDATE receipt_owners SET nrows=99 WHERE owner='z'"]:
            with self.assertRaises(receiptrows.Unsupported):
                with self.raw() as raw:
                    raw.execute(corruption)
                    receiptstore.export(raw)
        with self.raw() as raw:
            self.assertEqual(self.exported(raw),self.value)


    def mapped(self):
        from orgtree import receiptmapping
        with self.raw() as raw:
            receiptstore.convert(raw,self.oid)
            revision=raw.execute('SELECT revision FROM public.orgs WHERE org_id=%s',(self.oid,)).fetchone()[0]
        return receiptmapping.ReceiptSection(self.slug,revision)

    def test_writer_saves_nested_edit_and_append_without_history_walk(self):
        from orgtree import receiptmapping, receiptwriter
        view=self.mapped()
        calls=[]; original=receiptmapping._read
        def observed(slug,revision,query,params):
            calls.append((query,params)); return original(slug,revision,query,params)
        with patch.object(receiptmapping,'_read',side_effect=observed):
            view['z']['op']['extension']['note']='edited'
            view['z']['new']=receipt('z','new','fresh')
            plan=receiptwriter.prepare(view)
        self.assertFalse(any('ORDER BY' in q for q,_ in calls))
        self.assertEqual(len(calls),3)
        with self.raw() as raw:
            self.assertEqual(receiptwriter.apply(raw,self.oid,plan),frozenset({'z'}))
            actual=self.exported(raw)
            self.assertEqual(actual['z']['op']['extension']['note'],'edited')
            self.assertEqual(list(actual['z']),['op','new'])
            self.assertEqual(actual['empty'],{})
        # The transaction owner has not adopted: edits remain pending.
        self.assertEqual(receiptwriter.prepare(view),plan)

    def test_writer_rollback_keeps_mapping_dirty_and_retry_exact(self):
        from orgtree import receiptwriter
        view=self.mapped(); view['z']['new']=receipt('z','new','fresh')
        plan=receiptwriter.prepare(view)
        with self.raw(commit=False) as raw:
            receiptwriter.apply(raw,self.oid,plan)
            self.assertIn('new',self.exported(raw)['z'])
        with self.raw() as raw:
            self.assertEqual(self.exported(raw),self.value)
            self.assertEqual(receiptwriter.prepare(view),plan)
            receiptwriter.apply(raw,self.oid,plan)
            self.assertIn('new',self.exported(raw)['z'])

    def test_writer_preserves_operation_and_owner_reinsert_order(self):
        from orgtree import receiptwriter
        view=self.mapped()
        view['z']['second']=receipt('z','second','two')
        value=view['z'].pop('op'); view['z']['op']=value
        plan=receiptwriter.prepare(view)
        with self.raw() as raw:
            receiptwriter.apply(raw,self.oid,plan)
            actual=self.exported(raw)
            self.assertEqual(list(actual['z']),['second','op'])
        # Fresh baseline for the separate complete-owner move.
        view=self.mapped(); value=view.pop('z'); view['z']=value
        plan=receiptwriter.prepare(view)
        with self.raw() as raw:
            receiptwriter.apply(raw,self.oid,plan)
            actual=self.exported(raw)
            self.assertEqual(list(actual),['empty','z'])
            self.assertEqual(list(actual['z']),['second','op'])

    def test_writer_empty_owner_purge_and_point_delete_remain_distinct(self):
        from orgtree import receiptwriter
        view=self.mapped(); del view['z']['op']; del view['empty']; view['newempty']={}
        plan=receiptwriter.prepare(view)
        with self.raw() as raw:
            receiptwriter.apply(raw,self.oid,plan)
            self.assertEqual(self.exported(raw),{'z':{},'newempty':{}})

    def test_writer_refuses_stale_owner_and_cross_org_plan(self):
        from orgtree import receiptmapping, receiptwriter
        view=self.mapped(); view['z']['new']=receipt('z','new','fresh')
        plan=receiptwriter.prepare(view)
        with self.raw() as raw:
            receiptstore.put(raw,self.oid,'z','other',receipt('z','other','other'))
        with self.assertRaises(receiptmapping.StaleReceipts):
            with self.raw() as raw: receiptwriter.apply(raw,self.oid,plan)
        from dataclasses import replace
        with self.assertRaises(receiptmapping.StaleReceipts):
            with self.raw() as raw: receiptwriter.apply(raw,self.oid,replace(plan,slug='wrong-org'))
        with self.raw() as raw:
            self.assertNotIn('new',self.exported(raw)['z'])
            self.assertIn('other',self.exported(raw)['z'])

    def test_writer_prepared_values_do_not_alias_later_edits(self):
        from orgtree import receiptwriter
        view=self.mapped(); value=receipt('z','new','fresh'); view['z']['new']=value
        plan=receiptwriter.prepare(view); value['extension']['note']='later'
        with self.raw() as raw:
            receiptwriter.apply(raw,self.oid,plan)
            self.assertNotEqual(self.exported(raw)['z']['new']['extension']['note'],'later')
        self.assertNotEqual(receiptwriter.prepare(view),plan)

    def test_writer_noop_does_not_enumerate_or_write_receipts(self):
        from orgtree import receiptmapping, receiptwriter
        view=self.mapped()
        with patch.object(receiptmapping,'_read',side_effect=AssertionError('unexpected read')):
            plan=receiptwriter.prepare(view)
        self.assertEqual(plan.owners,frozenset())
        with self.raw() as raw:
            with patch.object(receiptstore,'put',side_effect=AssertionError('unexpected write')):
                self.assertEqual(receiptwriter.apply(raw,self.oid,plan),frozenset())
            self.assertEqual(self.exported(raw),self.value)


if __name__=='__main__':
    unittest.main()
