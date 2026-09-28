"""Receipt adoption runs after the actual PostgreSQL commit, never a save tail."""
import json
import unittest
import uuid
from unittest.mock import patch
import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, receiptcommit, store


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReceiptCommit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        self.slugs = [f._fresh_org('receipt-commit-'+uuid.uuid4().hex[:10]) for _ in range(2)]
        self.specs = {slug: dict(nodes=['a']) for slug in self.slugs}
        self.events = []
        self.conns = []

    def durable_names(self):
        # A different server connection cannot see the writer's uncommitted rows.
        with pgstore.connect() as raw:
            values = []
            for slug in self.slugs:
                oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (slug,)).fetchone()[0]
                row = raw.execute(f"SELECT val FROM org_{oid}.nodes WHERE id='a'").fetchone()
                values.append(json.loads(row[0])['name'])
            return values

    def queue(self, slug, callback=None):
        conn = store._orgtx_local.pinned[slug]
        self.conns.append(conn)
        receiptcommit.defer(conn, callback or (lambda: self.events.append((slug, self.durable_names()))))

    def test_two_org_callbacks_observe_both_committed_writes(self):
        original = orgtx._billed_save
        saves = []
        def save(*args, **kwargs):
            original(*args, **kwargs)
            saves.append(1)
            self.assertEqual(self.events, [], 'adoption escaped an intermediate save')
        with patch.object(orgtx, '_billed_save', side_effect=save):
            with orgtx.org_tx_multi(self.specs) as txs:
                for slug in self.slugs:
                    txs[slug].org.node('a')['name'] = 'committed'
                    self.queue(slug)
        self.assertEqual(len(saves), 2)
        self.assertEqual(self.events, [(s, ['committed', 'committed']) for s in self.slugs])
        receiptcommit.committed(self.conns)
        self.assertEqual(len(self.events), 2, 'adoption replayed')

    def test_last_save_failure_discards_both_pending_adoptions(self):
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx_multi(self.specs) as txs:
                for slug in self.slugs:
                    txs[slug].org.node('a')['name'] = 'rolled-back'
                    self.queue(slug)
                txs[self.slugs[-1]].org.node('b')['name'] = 'unlocked'
        self.assertEqual(self.durable_names(), ['a', 'a'])
        self.assertEqual(self.events, [])
        self.assertTrue(all(c._receipt_adoptions == [] for c in self.conns))
        receiptcommit.committed(self.conns)
        self.assertEqual(self.events, [])

    def test_body_failure_discards_pending_adoption(self):
        with self.assertRaisesRegex(ValueError, 'body refused'):
            with orgtx.org_tx(self.slugs[0], nodes=['a']) as tx:
                self.queue(self.slugs[0])
                tx.org.node('a')['name'] = 'rolled-back'
                raise ValueError('body refused')
        self.assertEqual(self.durable_names(), ['a', 'a'])
        self.assertEqual(self.events, [])
        self.assertEqual(self.conns[0]._receipt_adoptions, [])

    def test_after_commit_fault_and_receipt_replay_do_not_lose_or_repeat_adoption(self):
        slug = self.slugs[0]
        def fault(point, tx):
            if point == 'after_commit':
                self.assertEqual(len(self.events), 1)
                raise FileNotFoundError('simulated lost commit reply')
        with patch.object(orgtx, '_pause', side_effect=fault):
            with self.assertRaises(FileNotFoundError):
                with orgtx.org_tx(slug, nodes=['a'], op_key='commit-test', fingerprint='same') as tx:
                    tx.org.node('a')['name'] = 'durable'
                    tx.result = {'saved': True}
                    self.queue(slug)
        self.assertEqual(self.durable_names(), ['durable', 'a'])
        with orgtx.org_tx(slug, nodes=['a'], op_key='commit-test', fingerprint='same') as tx:
            self.assertTrue(tx.replayed)
            self.assertEqual(tx.result, {'saved': True})
            # Even an erroneous caller queueing on a replay must not adopt it.
            self.queue(slug)
        self.assertEqual(len(self.events), 1)
        self.assertTrue(all(c._receipt_adoptions == [] for c in self.conns))

    def test_callback_error_runs_remaining_callbacks_without_rolling_back_commit(self):
        def failing():
            self.events.append('failed callback')
            raise ValueError('adoption failed')
        with self.assertRaisesRegex(ValueError, 'adoption failed'):
            with orgtx.org_tx_multi(self.specs) as txs:
                for slug in self.slugs:
                    txs[slug].org.node('a')['name'] = 'durable'
                self.queue(self.slugs[0], failing)
                self.queue(self.slugs[1])
        self.assertEqual(self.durable_names(), ['durable', 'durable'])
        self.assertEqual(self.events, ['failed callback', (self.slugs[1], ['durable', 'durable'])])
        self.assertTrue(all(c._receipt_adoptions == [] for c in self.conns))

    def test_premature_adoption_is_refused_without_consuming_pending_edits(self):
        with orgtx.org_tx(self.slugs[0], nodes=['a']):
            self.queue(self.slugs[0])
            with self.assertRaisesRegex(RuntimeError, 'before server commit'):
                receiptcommit.committed(self.conns)
            self.assertEqual(len(self.conns[0]._receipt_adoptions), 1)
            self.assertEqual(self.events, [])
        self.assertEqual(len(self.events), 1)


if __name__ == '__main__':
    unittest.main()
