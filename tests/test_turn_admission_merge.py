"""S1 admission: common path is one transaction; compaction precedes drain."""
import unittest
from unittest.mock import patch
import test_pg3e_admission_tx as fixture
from orgtree import halt, ledger, store, supervisor as sup


class MergeTests(fixture.DrainTxTests):
    def forecast(self):
        return ({}, None, {'state': 'expired_known_entry', 'reason': 'fixture'}, None, None)

    def test_s1_common_path_has_one_admission_transaction(self):
        plans = []
        real = sup._admission_rows
        def rows(slug, nid, *, compact=False):
            plans.append(compact)
            return real(slug, nid, compact=compact)
        with patch.object(sup, '_admission_rows', side_effect=rows), \
             patch.object(sup, '_turn_forecast', return_value=self.forecast()), \
             patch.object(sup, '_auto_cheap_cfg', return_value=None):
            self.admit()
        self.assertEqual(self.reached, 1)
        self.assertEqual(plans, [False])
        self.assertNotIn(self.mail_id, self.at_sentinel['box'])

    def test_s1_ready_compaction_commits_before_drain_and_only_once(self):
        plans, at_drain, ready_calls = [], [], []
        real_rows, real_take = sup._admission_rows, sup._take_delivery_mail
        before = store.load_org(self.slug).node('worker')['session_id']
        def rows(slug, nid, *, compact=False):
            plans.append(compact)
            return real_rows(slug, nid, compact=compact)
        def ready(*args):
            ready_calls.append(True)
            if len(ready_calls) > 2:
                raise RuntimeError('guard control: attempted repeated compaction')
            return True
        def drain(org, nid, *args):
            persisted = store._load_sqlite_org(self.slug)
            at_drain.append(persisted.node(nid)['session_id'])
            return real_take(org, nid, *args)
        with patch.object(sup, '_admission_rows', side_effect=rows), \
             patch.object(sup, '_turn_forecast', side_effect=lambda *a: self.forecast()), \
             patch.object(sup, '_auto_cheap_cfg', return_value={'occ': .25}), \
             patch.object(sup, '_auto_cheap_ready', side_effect=ready), \
             patch.object(sup, 'export_predecessor_transcript'), \
             patch.object(sup, '_take_delivery_mail', side_effect=drain):
            self.admit()
        self.assertEqual(self.reached, 1, 'no committed drain after compaction')
        self.assertEqual(plans, [False, True, False])
        self.assertEqual(len(ready_calls), 2)
        self.assertEqual(len(at_drain), 1)
        self.assertNotEqual(at_drain[0], before, 'drain preceded compaction commit')
        self.assertEqual(len([n for n in store.load_org(self.slug).nodes.values()
                              if n.get('successor') == 'worker']), 1)

    def test_s1_forecast_failure_still_drains(self):
        with patch.object(sup, '_cache_forecast_now', side_effect=ValueError('no evidence')):
            self.admit()
        self.assertEqual(self.reached, 1)
        self.assertNotIn(self.mail_id, self.at_sentinel['box'])

    def test_s1_locked_gates_precede_forecast_and_drain(self):
        for gate in ('halt', 'frozen', 'killswitch'):
            with self.subTest(gate=gate):
                real = sup._admission_rows
                def rows(slug, nid, *, compact=False):
                    args = {'sections': [halt.KILLSWITCH]} if gate == 'killswitch' else {'nodes': [nid]}
                    with halt.txn(slug, **args) as tx:
                        if gate == 'killswitch':
                            tx.org.d[halt.KILLSWITCH] = {'reason': 'test'}
                        else:
                            tx.org.node(nid)[gate] = {'phase': 'halting', 'limit': True}
                    return real(slug, nid, compact=compact)
                with patch.object(sup, '_admission_rows', side_effect=rows), \
                     patch.object(sup, '_turn_forecast', return_value=self.forecast()) as forecast, \
                     patch.object(sup, '_take_delivery_mail') as drain:
                    self.admit()
                self.assertFalse(forecast.called, 'forecast ran before locked gate')
                self.assertFalse(drain.called, 'drain ran after locked gate refusal')
                with halt.txn(self.slug, nodes=['worker'], sections=[halt.KILLSWITCH]) as tx:
                    tx.org.node('worker').pop('halt', None)
                    tx.org.node('worker').pop('frozen', None)
                    tx.org.d.pop(halt.KILLSWITCH, None)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MergeTests(n) for n in loader.getTestCaseNames(MergeTests)
                              if n.startswith('test_s1_'))


if __name__ == '__main__':
    unittest.main()
