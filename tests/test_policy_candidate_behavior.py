"""Pin candidate filtering before changing recurring policy read paths."""
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_policy_poll_behavior as fixture
from orgtree import ledger, store, supervisor as sup, warmpool


def org_with(nodes, **settings):
    return fixture.view(nodes, **settings)


class StopTick(BaseException):
    pass


class CandidateBehavior(unittest.TestCase):
    def test_archived_frozen_node_still_triggers_resume_bookkeeping(self):
        old = dict(state='archived', frozen={'connection': True})
        org = org_with({'old': old})
        targets = []
        class Thread:
            def __init__(self, target, **kwargs): targets.append(target)
            def start(self): pass
        with patch.object(sup, '_auto_resume_started', False), \
                patch.object(sup.threading, 'Thread', Thread), \
                patch.object(store, 'cached_list', return_value=[{'slug': 'fixture'}]), \
                patch.object(store, 'cached_org', return_value=org), \
                patch.object(sup, '_auto_resume_org') as resume, \
                patch.object(sup, '_invariant_sweep_org') as sweep:
            sup.start_auto_resume_loop()
            with patch.object(sup.time, 'sleep', side_effect=[None, StopTick]):
                with self.assertRaises(StopTick): targets[0]()
        resume.assert_called_once_with('fixture')
        sweep.assert_called_once_with('fixture')
        self.assertIsNone(sup._resumable(old))

    def test_invariant_gate_retains_nonlive_parent_but_ignores_absent_parent(self):
        cases = [({'child': {'state': 'live', 'parent': 'old'},
                   'old': {'state': 'archived'}}, True),
                 ({'child': {'state': 'live', 'parent': 'absent'}}, False),
                 ({'old': {'state': 'archived', 'frozen': {'unknown': True}}}, False),
                 ({'kid': {'state': 'live', 'frozen': {'unknown': True}}}, True)]
        for nodes, acts in cases:
            with self.subTest(nodes=nodes), \
                    patch.object(store, 'cached_org', return_value=org_with(nodes)), \
                    patch.object(sup, '_invariant_announced', set()), \
                    patch.object(sup, '_computed_tx') as tx:
                sup._invariant_sweep_org('fixture')
            self.assertEqual(tx.call_count, int(acts))

    def test_remote_driver_uncertainty_does_not_trigger_repair(self):
        nodes = {'kid': {'state': 'live', 'remote_controlled': {'pid': 123}}}
        for dead in (False, True):
            with self.subTest(dead=dead), \
                    patch.object(store, 'cached_org', return_value=org_with(nodes)), \
                    patch.object(sup, '_pid_provably_dead', return_value=dead), \
                    patch.object(sup, '_computed_tx') as tx:
                sup._invariant_sweep_org('fixture')
            self.assertEqual(tx.call_count, int(dead))

    def test_warm_keeper_allows_frozen_but_manual_start_does_not(self):
        org = org_with({'frozen': {'state': 'live', 'frozen': {'connection': True}},
                        'old': {'state': 'archived'}, 'halted': {'state': 'live', 'halt': True}})
        with patch.object(warmpool, 'node_excluded', return_value=False):
            self.assertEqual(warmpool.eligible(org, 'frozen'), (True, ''))
            self.assertEqual(warmpool._warm_eligible(org, 'frozen'), (False, 'frozen'))
            self.assertEqual(warmpool.eligible(org, 'old'), (False, 'not-live'))
            self.assertEqual(warmpool.eligible(org, 'halted'), (False, 'halted'))

    def test_warm_keeper_reaps_retired_and_deleted_org_not_frozen_live(self):
        org = org_with({'frozen': {'state': 'live', 'frozen': {'connection': True}},
                        'old': {'state': 'archived'}})
        pool = {('fixture', 'frozen'): object(), ('fixture', 'old'): object(),
                ('gone', 'node'): object()}
        with patch.object(warmpool, 'warm_enabled', return_value=True), \
                patch.object(store, 'cached_list', return_value=[{'slug': 'fixture'}]), \
                patch.object(store, 'cached_org', return_value=org), \
                patch.object(warmpool, '_pool', pool), \
                patch.object(warmpool, '_serving', {}), \
                patch.object(warmpool, '_busy', return_value=True), \
                patch.object(warmpool, 'node_excluded', return_value=False), \
                patch.object(warmpool, 'kill_node') as kill:
            warmpool._keeper_pass()
        self.assertEqual(kill.call_args_list,
                         [unittest.mock.call('gone', 'node', 'org-deleted'),
                          unittest.mock.call('fixture', 'old', 'retired')])

    def test_working_wake_rechecks_reservation_and_cancels_lost_admission(self):
        org = org_with({'live': {'state': 'live'}, 'old': {'state': 'archived'}})
        for reservation, wake_result, cancelled in [
                (None, {'accepted': True}, False),
                ('mid', {'accepted': True, 'not_idle': True}, True)]:
            with self.subTest(reservation=reservation), ExitStack() as stack:
                stack.enter_context(patch.object(store, 'cached_list', return_value=[{'slug': 'fixture'}]))
                stack.enter_context(patch.object(store, 'cached_org', return_value=org))
                stack.enter_context(patch.object(sup, '_working_cache_idle', return_value=True))
                decision = stack.enter_context(patch.object(sup, '_working_checkup_decision', return_value='checkup'))
                reserve = stack.enter_context(patch.object(sup, '_working_checkup_reserve', return_value=reservation))
                cancel = stack.enter_context(patch.object(sup, '_auto_wake_cancel'))
                spark = stack.enter_context(patch.object(sup, 'mail_spark'))
                wake = unittest.mock.Mock(return_value=wake_result)
                sup._working_checkup_pass(wake=wake, now=100, mode_enabled=True)
                decision.assert_called_once_with(org, 'live', 100)
                reserve.assert_called_once_with('fixture', 'live', 100)
                self.assertEqual(wake.call_count, int(reservation is not None))
                self.assertEqual(cancel.call_count, int(cancelled))
                spark.assert_not_called()


if __name__ == '__main__': unittest.main()
