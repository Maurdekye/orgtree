"""Synthetic adapter controls: ownership is evidence, never a node-wide busy bit."""
import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import mailownership as own, mailruntime as runtime


class RuntimeOwnershipTests(unittest.TestCase):
    def setUp(self):
        node = {'mailbox_id': 'box-a', 'generation': 2, 'session_id': 'session-a'}
        self.org = SimpleNamespace(nodes={'worker': node}, d={'delivering': {'worker': [
            {'tok': 'orphan', 'at': '2000-01-01T00:00:00Z', 'mode': 'steer',
             'mail': [{'id': 'message-a'}], 'custody': {'mailbox': 'box-a', 'generation': 2, 'session': 'session-a'}}]}})
        self.st = {'queue': [], 'busy': False}

    def verdict(self):
        facts = runtime.runtime_facts(self.st)
        result, _ = runtime.classify(self.org, 'worker', facts, now=2000000000, pump_toks=())
        return result.by_token['orphan']

    def test_unrelated_busy_does_not_own_a_batch(self):
        self.st.update(busy=True, responding=True, proc_control=object())
        self.assertTrue(self.verdict().reclaimable)

    def test_real_attempt_registration_protects_only_its_tokens(self):
        self.st.update(busy=True, lifecycle_operation_id='real-attempt')
        runtime.register(self.st, self.org, 'worker', attempt='real-attempt', toks=['other'])
        self.assertTrue(self.verdict().reclaimable)
        runtime.adopt(self.st, attempt='real-attempt', toks=['orphan'])
        self.assertFalse(self.verdict().reclaimable)
        self.assertEqual(self.verdict().owner, own.OwnerEvidence.PROVEN)

    def test_registration_without_a_readable_document_still_protects(self):
        # Admission tolerates an unreadable document; the identity it records
        # is then unproven, which must protect and never permit.
        self.st.update(busy=True, lifecycle_operation_id='real-attempt')
        record = runtime.register(self.st, None, 'worker', attempt='real-attempt',
                                  toks=['orphan'])
        self.assertIsInstance(record['mailbox'], own.Gap)
        self.assertFalse(self.verdict().reclaimable)

    def test_session_handover_does_not_relabel_the_live_registration(self):
        self.st.update(busy=True, lifecycle_operation_id='real-attempt')
        runtime.register(self.st, self.org, 'worker', attempt='real-attempt', toks=['orphan'])
        self.org.nodes['worker']['session_id'] = 'new-session'
        self.assertFalse(self.verdict().reclaimable)
        self.assertEqual(self.verdict().owner, own.OwnerEvidence.PROVEN)

    def test_old_completion_does_not_release_a_new_attempt(self):
        self.st.update(busy=True, lifecycle_operation_id='new-attempt')
        runtime.register(self.st, self.org, 'worker', attempt='new-attempt', toks=['orphan'])
        runtime.release(self.st, attempt='old-attempt')
        self.assertFalse(self.verdict().reclaimable)

    def test_missing_identity_is_not_minted_by_inspection(self):
        self.org.nodes['worker'].pop('mailbox_id')
        before = copy.deepcopy(self.org)
        self.assertFalse(self.verdict().reclaimable)
        self.assertEqual(vars(self.org), vars(before))

    def test_unsupported_source_collections_protect(self):
        for key in ('queue', 'steer', 'steer_limbo', 'mail_custody', 'mail_confirmed'):
            for bad in (None, False, 0, '', {}, 'unreadable'):
                with self.subTest(key=key, bad=bad):
                    self.st = {key: bad}
                    self.assertFalse(self.verdict().reclaimable)

    def test_unsupported_token_membership_is_not_an_empty_set(self):
        for key in ('queue', 'steer'):
            for bad in (None, False, 0, '', {}, ['valid', 17]):
                with self.subTest(key=key, bad=bad):
                    self.st = {key: [{'toks': bad}]}
                    self.assertFalse(self.verdict().reclaimable)

    def test_empty_and_unrelated_collections_protect_nothing(self):
        for toks in ([], (), ['another-token']):
            with self.subTest(toks=toks):
                self.st = {'queue': [{'toks': toks}]}
                self.assertTrue(self.verdict().reclaimable)

    def test_idle_but_deliverable_carrier_still_owns_its_batch(self):
        self.st['queue'] = [{'toks': ['orphan']}]
        self.assertFalse(self.verdict().reclaimable)

    def test_snapshot_copies_nested_tokens_and_claims(self):
        carrier = {'toks': ['orphan'], 'claim': {'delivery_id': 'delivery'}}
        self.st['queue'] = [carrier]
        facts = runtime.runtime_facts(self.st)
        carrier['toks'].clear()
        carrier['claim'].clear()
        result, _ = runtime.classify(self.org, 'worker', facts, now=2000000000, pump_toks=())
        self.assertFalse(result.by_token['orphan'].reclaimable)
        self.assertIn(own.Reason.CLAIM_HELD, result.by_token['orphan'].reasons)

    def test_unversioned_claim_and_tokenless_lease_remain_protected(self):
        self.st['queue'] = [{'claim': {'delivery_id': 'legacy'}}]
        self.assertFalse(self.verdict().reclaimable)
        self.st['queue'] = []
        self.org.nodes['worker']['drive_lease'] = True
        self.assertFalse(self.verdict().reclaimable)

    def test_retained_carriers_survive_empty_runtime_after_restart(self):
        for source in ('halt_queue', 'native_held_carriers'):
            with self.subTest(source=source):
                self.org.nodes['worker'][source] = [{'toks': ['orphan'], 'text': 'retained'}]
                self.assertFalse(self.verdict().reclaimable)
                self.org.nodes['worker'].pop(source)

    def test_unsupported_retention_is_not_silently_discarded(self):
        for source in ('halt_queue', 'native_held_carriers'):
            for bad in (None, False, {}, [{'toks': None}]):
                with self.subTest(source=source, bad=bad):
                    self.org.nodes['worker'][source] = bad
                    self.assertFalse(self.verdict().reclaimable)
                    self.org.nodes['worker'].pop(source)

    def test_manual_unconfirmed_row_survives_empty_runtime(self):
        self.org.d['delivering']['worker'][0]['mode'] = 'manual_fetch'
        self.assertFalse(self.verdict().reclaimable)

    def test_custody_requires_proven_mailbox_and_generation(self):
        row = self.org.d['delivering']['worker'][0]
        for stamp in (None, {}, False, {'mailbox': 'other', 'generation': 2, 'session': 'session-a'},
                      {'mailbox': 'box-a', 'generation': 3, 'session': 'session-a'},
                      {'mailbox': 'box-a', 'generation': True, 'session': 'session-a'}):
            with self.subTest(stamp=stamp):
                row['custody'] = stamp
                self.assertFalse(self.verdict().reclaimable)
                safe, refused = runtime.revalidate(self.org, 'worker', ['orphan'])
                self.assertFalse(safe)
                self.assertIn('orphan', refused)

    def test_incomplete_collection_contract_is_refused(self):
        facts = runtime.runtime_facts(self.st)
        facts['sources'].remove('limbo')
        with self.assertRaises(runtime.IncompleteEvidence):
            runtime.snapshot(self.org, 'worker', facts, now=2000000000, pump_toks=())


if __name__ == '__main__':
    unittest.main()
