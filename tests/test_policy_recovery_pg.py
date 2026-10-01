"""Compacted warm identities retain the complete authorized recovery prompt."""
import unittest
from unittest.mock import patch

import test_policy_context_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import breadcrumbs, policy_context, store, supervisor, warmpool

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class PolicyRecovery(unittest.TestCase):
    setUpClass = fixture.PolicyInputs.__dict__['setUpClass']
    setUp = fixture.PolicyInputs.setUp

    def test_missing_and_empty_breadcrumbs_keep_authorized_identity_facts(self):
        org = store.load_org(self.slug)
        org.work_create('worker', 'Recovery fact', 'Must remain in recovery prompt', kind='non-code')
        org.node('worker').update(cheap_compacted=True, model='opus')
        store.save_org(org)
        full = store.load_org(self.slug)
        for docket in (False, True):
            with self.subTest(docket=docket):
                # Return a real complete Org, not a sentinel: the old candidate
                # omits authorized facts and changes the full warm identity.
                with patch.object(store, 'cached_org', return_value=full) as fallback:
                    got = policy_context.read(self.slug, docket=docket)
                for availability in ('unavailable', 'readable'):
                    with self.subTest(availability=availability), patch.object(
                            breadcrumbs, 'read', return_value={'availability': availability,
                            'detail': 'controlled missing', 'text': ''}):
                        expected = supervisor.identity_prompt(full, 'worker')
                        actual = supervisor.identity_prompt(got, 'worker')
                        self.assertIn('Recovery fact', expected)
                        self.assertEqual(actual, expected)
                        self.assertEqual(
                            warmpool.identity_snapshot(got, 'worker', env={}, overrides={}),
                            warmpool.identity_snapshot(full, 'worker', env={}, overrides={}))
                fallback.assert_called_once_with(self.slug)

    def test_completed_recovery_returns_to_bounded_reader(self):
        org = store.load_org(self.slug)
        org.node('worker')['cheap_compacted'] = False
        store.save_org(org)
        with patch.object(store, 'cached_org', side_effect=AssertionError('full fallback')):
            self.assertIsInstance(policy_context.read(self.slug), policy_context.PolicyContext)


if __name__ == '__main__': unittest.main()
