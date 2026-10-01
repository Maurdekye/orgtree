"""Actual policy consumers, projected decisions and locked race controls."""
from contextlib import ExitStack
import copy
import json
import unittest
from unittest.mock import patch

import test_policy_context_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, policy_context, store, supervisor as sup, warmpool

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class PolicyLoops(fixture.PolicyInputs):
    def test_nonempty_docket_and_audience_match_full_decisions(self):
        org = store.load_org(self.slug)
        org.work_create('worker', 'Action due', 'An actionable task', kind='non-code')
        org.work_create('worker', 'Blocked task', 'Blocked task', kind='non-code',
                        status='blocked', blocked_reason='external reply')
        org.d['audiences'].append({'grantee': 'worker', 'grantor': ledger.EXTERN})
        org.node('worker').update(last_status={'status': 'working'}, working_activity_at='2020-01-01T00:00:00+00:00')
        store.save_org(org)
        full, got = store.load_org(self.slug), self.projected(docket=True)
        self.assertTrue(got._has_audience('worker', ledger.EXTERN))
        for method in ('work_idle_reminder_items', 'work_docket_reminder_items'):
            self.assertEqual(getattr(got, method)('worker'), getattr(full, method)('worker'))
            self.assertTrue(getattr(got, method)('worker'))
        self.assertEqual(got.work_org_all_blocked(), full.work_org_all_blocked())
        self.assertEqual(sup._working_checkup_decision(got, 'worker', 1900000000), 'checkup')
        self.assertEqual(sup._working_checkup_decision(got, 'worker', 1900000000),
                         sup._working_checkup_decision(full, 'worker', 1900000000))
        self.assertEqual(sup.identity_prompt(got, 'worker'), sup.identity_prompt(full, 'worker'))

    def test_retirement_after_projection_prevents_actual_locked_reservation(self):
        org = store.load_org(self.slug)
        org.work_create('worker', 'Action due', 'An actionable task', kind='non-code')
        org.node('worker').update(last_status={'status': 'working'}, working_activity_at='2020-01-01T00:00:00+00:00')
        store.save_org(org)
        real = sup._working_checkup_reserve
        calls = []
        def retire_then_reserve(slug, nid, now):
            calls.append(nid)
            self.query("UPDATE nodes SET val=jsonb_set(val::jsonb,'{state}','\"archived\"')::text WHERE id=?", (nid,))
            return real(slug, nid, now)
        with patch.object(store, 'org_slugs', return_value=[self.slug]), \
                patch.object(store, 'cached_org', side_effect=AssertionError('full history fallback')), \
                patch.object(sup, '_working_cache_idle', return_value=True), \
                patch.object(sup, '_working_checkup_reserve', side_effect=retire_then_reserve), \
                patch.object(sup, 'mail_spark') as spark:
            wake = unittest.mock.Mock(return_value={'accepted': True})
            sup._working_checkup_pass(wake=wake, now=1900000000, mode_enabled=True)
        self.assertEqual(calls, ['worker'])
        wake.assert_not_called()
        spark.assert_not_called()
        self.assertFalse(store.load_org(self.slug).waking_mail('worker'))

    def test_full_keeper_enumeration_reaps_and_visits_frozen_live_seat(self):
        org = store.load_org(self.slug)
        org.node('worker')['frozen'] = {'connection': True}
        org.nodes['retired'] = dict(copy.deepcopy(org.node('worker')), state='archived', frozen=None)
        store.save_org(org)
        with patch.object(store, 'org_slugs', return_value=[self.slug]), \
                patch.object(store, 'cached_org', side_effect=AssertionError('full history fallback')), \
                patch.object(warmpool, 'warm_enabled', return_value=True), \
                patch.object(warmpool, '_pool', {(self.slug, 'retired'): object(), ('gone', 'x'): object()}), \
                patch.object(warmpool, '_serving', {}), \
                patch.object(warmpool, '_busy', return_value=True) as busy, \
                patch.object(warmpool, 'node_excluded', return_value=False), \
                patch.object(warmpool, 'kill_node') as kill:
            warmpool._keeper_pass()
        busy.assert_called_once_with(self.slug, 'worker')
        self.assertEqual(kill.call_args_list, [unittest.mock.call('gone', 'x', 'org-deleted'),
                         unittest.mock.call(self.slug, 'retired', 'retired')])

    def test_projection_preserves_archived_freeze_and_current_invariant_input(self):
        org = store.load_org(self.slug)
        org.nodes['retired'] = dict(copy.deepcopy(org.node('worker')), state='archived',
                                   frozen={'connection': True})
        org.node('worker')['parent'] = 'retired'
        store.save_org(org)
        got = self.projected()
        self.assertIn('retired', got.candidate_ids)
        self.assertTrue(got.nodes['retired']['frozen'])
        with patch.object(store, 'cached_org', side_effect=AssertionError('full history fallback')), \
                patch.object(sup, '_invariant_announced', set()), \
                patch.object(sup, '_computed_tx') as transaction:
            sup._invariant_sweep_org(self.slug)
        transaction.assert_called_once()

    def test_cold_warm_identity_does_not_reload_full_org(self):
        org = store.load_org(self.slug)
        org.node('worker')['model'] = 'opus'
        store.save_org(org)
        full, got = store.load_org(self.slug), self.projected()
        with patch.object(store, 'load_org', side_effect=AssertionError('whole Org read')), \
                patch.object(store, 'load_runtime_org', side_effect=AssertionError('whole runtime read')), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole cached read')):
            projected = warmpool.identity_snapshot(got, 'worker', env={}, overrides={})
            expected = warmpool.identity_snapshot(full, 'worker', env={}, overrides={})
        self.assertEqual(projected, expected)

    def test_archived_freeze_still_receives_locked_deadline_bookkeeping(self):
        from orgtree import account_fallback
        org = store.load_org(self.slug)
        org.nodes['retired'] = dict(copy.deepcopy(org.node('worker')), state='archived',
                                   frozen={'connection': True})
        store.save_org(org)
        with patch.object(store, 'cached_org', side_effect=AssertionError('full history fallback')), \
                patch.object(sup, 'commit_node_wake') as stamp, \
                patch.object(sup, 'auto_resume_ready', return_value=set()), \
                patch.object(account_fallback, 'candidates', return_value={}):
            self.assertTrue(sup._auto_resume_org(self.slug, now=1900000000))
        # halt's normal exit also recomputes deadlines without an explicit
        # clock. Pin this loop's deliberate timestamped bookkeeping call.
        timed = [call for call in stamp.call_args_list if len(call.args)==2]
        self.assertEqual(len(timed), 1)
        self.assertEqual(timed[0].args[1], 1900000000)
        self.assertEqual(timed[0].args[0]['state'], 'archived')
        self.assertEqual(timed[0].args[0]['frozen'], {'connection': True})


if __name__ == '__main__': unittest.main()
