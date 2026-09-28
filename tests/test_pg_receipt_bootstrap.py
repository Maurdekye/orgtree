"""ORGTREE_RECEIPT_ROWS bootstrap: the data-root claim converts every org to
receipt rows when the switch is on, and puts every converted org back on the
legacy blob when it is off (receiptstore.unconvert), so the format change is
not one-way. What these prove:
  * un-convert restores the EXACT blob bytes the org had before conversion,
    drops the rows, the conversion record and the meta flag, and the org then
    loads with the switch off (and on an older engine, which reads the blob);
  * receipts written while converted survive the way back;
  * convert -> un-convert -> convert round-trips;
  * the claim-time pass converts/un-converts per org under the org's
    EXCLUSIVE org_tx lock, skips an org it cannot lock (left as it was), and
    does nothing to an org already in the asked-for format;
  * the claim runs the pass.

Run:  python tools/run-python-verification.py tests/test_pg_receipt_bootstrap.py
"""
import json
import threading
import unittest
from unittest.mock import patch

import test_pg_receiptrows as fixture
from test_receiptrows import receipt
from orgtree import ledger, orgtx, pgstore, receiptmapping, receiptrows, receiptstore, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptBootstrap(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def setUp(self):
        fixture.ReceiptStorage.setUp(self)
        with self.raw() as raw:
            self.blob = raw.execute("SELECT val FROM doc WHERE key='mail_transitions'").fetchone()[0]

    def state(self):
        """(blob, marker, meta flag, owners, receipts, carriers) of this org."""
        with self.raw() as raw:
            one = lambda q: raw.execute(q).fetchone()
            return (one("SELECT val FROM doc WHERE key='mail_transitions'"),
                    one("SELECT format FROM receipt_format WHERE singleton"),
                    one("SELECT val FROM meta WHERE key='receipt_rows'"),
                    one("SELECT count(*) FROM receipt_owners")[0],
                    one("SELECT count(*) FROM receipts")[0],
                    one("SELECT count(*) FROM receipt_carriers")[0])

    def convert(self):
        with self.raw() as raw:
            self.assertIsNotNone(receiptstore.convert(raw, self.oid))

    def unconvert(self):
        with self.raw() as raw:
            return receiptstore.unconvert(raw, self.oid)

    def full(self):
        with store._POOL.acquire(self.slug) as conn:
            return store.reconstruct_full(conn)

    # -- un-convert -------------------------------------------------------
    def test_unconvert_restores_the_exact_blob_and_clears_the_rows(self):
        before = self.full()
        self.convert()
        self.assertEqual(self.state(), (None, (1,), ('1',), 2, 1, 1))
        proof = self.unconvert()
        self.assertEqual(proof, receiptrows.verify(receiptrows.split(self.blob)))
        self.assertEqual(self.state(), ((self.blob,), None, None, 0, 0, 0))
        self.assertEqual(self.full(), before)
        self.assertEqual(list(self.full()), list(before), 'key order')
        with patch.object(store, 'RECEIPT_ROWS', False):
            org = store.load_org(self.slug)          # the old path loads it again
            self.assertEqual(org.d['mail_transitions'], self.value)
            self.assertNotIsInstance(org.d['mail_transitions'], receiptmapping.ReceiptSection)

    def test_unconvert_of_an_unconverted_org_changes_nothing(self):
        self.assertIsNone(self.unconvert())
        self.assertEqual(self.state(), ((self.blob,), None, None, 0, 0, 0))

    def test_receipts_written_while_converted_survive_the_way_back(self):
        self.convert()
        with patch.object(store, 'RECEIPT_ROWS', True):
            org = store.load_org(self.slug)
            org.d['mail_transitions'].setdefault('n9', {})['op2'] = receipt('n9', 'op2', 'c2')
            store.save_org(org)
        want = {**self.value, 'n9': {'op2': receipt('n9', 'op2', 'c2')}}
        self.unconvert()
        with patch.object(store, 'RECEIPT_ROWS', False):
            self.assertEqual(store.load_org(self.slug).d['mail_transitions'], want)
        blob = self.state()[0][0]
        self.assertEqual(json.loads(blob), want)
        self.assertEqual(list(json.loads(blob)), list(want), 'owner order')

    def test_convert_unconvert_convert_round_trips(self):
        self.convert()
        self.unconvert()
        self.convert()
        self.assertEqual(self.state(), (None, (1,), ('1',), 2, 1, 1))
        with patch.object(store, 'RECEIPT_ROWS', True):
            self.assertEqual(store.load_org(self.slug).d['mail_transitions'].plain(), self.value)
        self.unconvert()
        self.assertEqual(self.state()[0], (self.blob,))

    def test_a_failed_check_rolls_the_unconversion_back(self):
        self.convert()
        real = receiptrows.dumps

        def lossy(value):                # the rebuilt blob silently loses an owner
            if isinstance(value, dict) and set(value) == {'z', 'empty'}:
                value = {'z': value['z']}
            return real(value)
        with self.assertRaises(receiptrows.Unsupported):
            with self.raw() as raw, patch.object(receiptrows, 'dumps', side_effect=lossy):
                receiptstore.unconvert(raw, self.oid)
        self.assertEqual(self.state(), (None, (1,), ('1',), 2, 1, 1))

    # -- the claim-time pass ----------------------------------------------
    def test_the_pass_converts_when_on_and_puts_back_when_off(self):
        out = store.reconcile_receipt_storage(on=True)
        self.assertEqual(out[self.slug]['converted']['receipts'], 1)
        self.assertEqual(self.state(), (None, (1,), ('1',), 2, 1, 1))
        again = store.reconcile_receipt_storage(on=True)
        self.assertNotIn(self.slug, again, 'an org already in the asked-for format is left alone')
        out = store.reconcile_receipt_storage(on=False)
        self.assertEqual(out[self.slug]['unconverted']['receipts'], 1)
        self.assertEqual(self.state(), ((self.blob,), None, None, 0, 0, 0))
        self.assertNotIn(self.slug, store.reconcile_receipt_storage(on=False))

    def test_the_pass_waits_for_no_transaction_and_skips_an_org_it_cannot_lock(self):
        held, release = threading.Event(), threading.Event()

        def hold():                      # an org_tx in flight holds the org lock shared
            with orgtx.org_tx(self.slug, nodes=[]):
                held.set()
                release.wait(30)
        t = threading.Thread(target=hold)
        t.start()
        try:
            self.assertTrue(held.wait(30))
            out = store.reconcile_receipt_storage(on=True, lock_timeout_ms=300)
            self.assertIn('skipped', out[self.slug])
            self.assertEqual(self.state(), ((self.blob,), None, None, 0, 0, 0))
        finally:
            release.set()
            t.join(30)
        out = store.reconcile_receipt_storage(on=True)
        self.assertIn('converted', out[self.slug])

    def test_the_pass_takes_the_whole_org_lock(self):
        seen = []
        real = receiptstore.convert

        def convert(raw, org_id):
            if org_id == self.oid:
                # the exclusive whole-org key is held: a shared try from
                # another session must fail while the conversion runs
                with pgstore.connect() as other:
                    other.execute('BEGIN')
                    seen.append(other.execute(
                        'SELECT pg_try_advisory_xact_lock_shared(%s, hashtext(%s))',
                        (org_id, f'org:{orgtx._ORG_KEY}')).fetchone()[0])
                    other.execute('ROLLBACK')
            return real(raw, org_id)
        with patch.object(receiptstore, 'convert', side_effect=convert):
            store.reconcile_receipt_storage(on=True)
        self.assertEqual(seen, [False])

    # -- a failure part-way through the pass (review-astra's probes, f3) ----
    CONVERTED = (None, (1,), ('1',), 2, 1, 1)

    def plain(self):
        return ((self.blob,), None, None, 0, 0, 0)

    def run_armed(self, fn_name, on, exc):
        """The pass with receiptrows.verify raising `exc` on its SECOND call
        inside receiptstore.<fn_name> for this org only — call 1 is split's
        own check, before anything is written; call 2 comes after the rows
        were written (convert) or deleted (unconvert)."""
        real_verify, real_fn = receiptrows.verify, getattr(receiptstore, fn_name)
        state = {'on': False, 'n': 0, 'fired': 0}

        def verify(x):
            if state['on']:
                state['n'] += 1
                if state['n'] >= 2:
                    state['fired'] += 1
                    raise exc
            return real_verify(x)

        def fn(raw, org_id):
            state['on'], state['n'] = org_id == self.oid, 0
            try:
                return real_fn(raw, org_id)
            finally:
                state['on'] = False
        with patch.object(receiptrows, 'verify', side_effect=verify), \
                patch.object(receiptstore, fn_name, side_effect=fn):
            out = store.reconcile_receipt_storage(on=on)
        self.assertEqual(state['fired'], 1, 'the fault never fired: this proves nothing')
        return out

    def test_unconvert_failing_after_the_deletes_leaves_the_org_converted(self):
        self.convert()
        out = self.run_armed('unconvert', False, receiptrows.Unsupported('after the deletes'))
        self.assertIn('skipped', out[self.slug])
        self.assertEqual(self.state(), self.CONVERTED)
        self.assertIn('unconverted', store.reconcile_receipt_storage(on=False)[self.slug])
        self.assertEqual(self.state(), self.plain())

    def test_convert_failing_after_the_rows_leaves_the_org_on_the_blob(self):
        out = self.run_armed('convert', True, receiptrows.Unsupported('after the row COPY'))
        self.assertIn('skipped', out[self.slug])
        self.assertEqual(self.state(), self.plain())
        self.assertIn('converted', store.reconcile_receipt_storage(on=True)[self.slug])
        self.assertEqual(self.state(), self.CONVERTED)

    def test_any_other_error_is_skipped_so_the_engine_still_starts(self):
        self.convert()
        out = self.run_armed('unconvert', False, KeyError('a shape nobody foresaw'))
        self.assertIn('skipped', out[self.slug])
        self.assertIn('KeyError', out[self.slug]['skipped'])
        self.assertEqual(self.state(), self.CONVERTED)

    def test_the_claim_runs_the_pass(self):
        calls = []
        store.release_data_root()
        try:
            with patch.object(store, 'reconcile_receipt_storage',
                              side_effect=lambda **kw: calls.append(kw)):
                store.claim_data_root()
        finally:
            store.claim_data_root()
        self.assertEqual(calls, [{}])


if __name__ == '__main__':
    unittest.main()
