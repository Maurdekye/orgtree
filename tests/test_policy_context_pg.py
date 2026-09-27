"""Policy projections retain normalized decisions without unrelated history."""
import json
import unittest
from unittest.mock import patch

import test_policy_candidates_pg as fixture
from orgtree import policy_context, store, supervisor, warmpool

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class PolicyInputs(unittest.TestCase):
    setUpClass = fixture.CandidateReads.__dict__['setUpClass']
    setUp = fixture.CandidateReads.setUp
    query = fixture.CandidateReads.query

    def projected(self, **kw):
        with patch.object(store, 'cached_org', side_effect=AssertionError('full history fallback')):
            return policy_context.read(self.slug, **kw)

    def test_normalized_identity_settings_and_policy_decisions_match_full_org(self):
        full = store.load_org(self.slug)
        projected = self.projected()
        self.assertEqual(projected.nodes, full.nodes)
        self.assertEqual(warmpool._org_fingerprint(projected), warmpool._org_fingerprint(full))
        self.assertEqual(warmpool._seat_fingerprint(projected, 'worker', 'test'),
                         warmpool._seat_fingerprint(full, 'worker', 'test'))
        for method in ('model_for', 'versions_for', 'harness_for', 'prefer_reserve_for',
                       'effective_effort', 'account_fallback_for'):
            self.assertEqual(getattr(projected, method)('worker'), getattr(full, method)('worker'))
        self.assertEqual(supervisor._working_checkup_decision(projected, 'worker', 100),
                         supervisor._working_checkup_decision(full, 'worker', 100))
        self.assertEqual(warmpool.eligible(projected, 'worker'), warmpool.eligible(full, 'worker'))

    def test_settings_and_graph_do_not_materialize_unrelated_archived_bodies(self):
        seed = dict(store.load_org(self.slug).node('worker'), state='archived')
        for i in range(20):
            self.query('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)',
                       ('history-' + str(i), 100+i, json.dumps(seed)))
        got = self.projected()
        self.assertEqual(set(got.nodes), {'worker'})
        self.assertEqual(got.candidate_ids, ('worker',))
        with self.assertRaises(Exception): store.save_org(got)

    def test_docket_reminder_decision_matches_full_catalog(self):
        full = store.load_org(self.slug)
        got = self.projected(docket=True)
        self.assertEqual(got.work_org_all_blocked(), full.work_org_all_blocked())
        self.assertEqual(got.work_idle_reminder_items('worker'), full.work_idle_reminder_items('worker'))

    def test_unknown_normalization_state_uses_exact_full_fallback(self):
        self.query("DELETE FROM doc WHERE key='_migrations'")
        sentinel = object()
        with patch.object(store, 'cached_org', return_value=sentinel) as old:
            self.assertIs(policy_context.read(self.slug), sentinel)
        old.assert_called_once_with(self.slug)


if __name__ == '__main__': unittest.main()
