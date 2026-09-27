"""Actual PostgreSQL storage controls; no production consumer switched yet."""
import contextlib
import json
import threading
import unittest
import uuid
from unittest.mock import patch
import test_pgstore as f
from test_receiptrows import receipt
from orgtree import pgstore, receiptrows, receiptstore, store


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


if __name__=='__main__':
    unittest.main()
