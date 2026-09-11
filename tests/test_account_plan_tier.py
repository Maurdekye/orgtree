"""A registered Claude Code account's subscription tier.

The user's report: the primary usage section reads `Claude Code · <email>` with
`Claude max` under it, while a second signed-in account reads `Claude ·
claude-0 · <email>` with no tier at all. The tier half was a backend gap —
`limits._plan` reads the HOST credentials store, which describes whoever is
signed in ambiently and says nothing about another profile, so
`GET /api/accounts/{id}/usage` had no `plan` to send. The label half is in the
renderer (App.tsx REGISTRY_PROVIDER_NAME).

⚠ THE POINT IS NOT "SHOW A TIER". It is "show the tier the provider actually
reported, and nothing when it reported none". The CLI writes
`subscriptionType: … ?? null`, so a real login can genuinely carry no tier, and
every test below that asserts a tier appears is paired with one asserting it
stays absent.

No CLI, no network, no live credentials — every credentials file here is a
fixture written into a temp directory.
"""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest


class ProfilePlanTests(unittest.TestCase):
    """`limits.profile_plan` on its own."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix='orgtree-plan-')
        os.environ['ORGTREE_DATA'] = cls.root
        from engine.backend.orgtree import limits, store
        bound = Path(store.DATA_ROOT).resolve()
        live = (Path.home() / 'orgtree').resolve()
        if bound == live or live in bound.parents:
            raise AssertionError(f'REFUSING: store bound to live {bound}')
        cls.limits = limits

    def _profile(self, oauth):
        d = Path(tempfile.mkdtemp(prefix='prof-', dir=self.root))
        if oauth is not None:
            (d / '.credentials.json').write_text(
                json.dumps({'claudeAiOauth': oauth}), encoding='utf-8')
        return str(d)

    def test_a_recorded_tier_is_returned(self):
        self.assertEqual(self.limits.profile_plan(
            self._profile({'accessToken': 'x', 'subscriptionType': 'max'})), 'max')

    def test_a_different_tier_is_not_flattened_to_max(self):
        """POSITIVE CONTROL for the test above: it must report what it read,
        not a constant that happens to match the screenshot."""
        self.assertEqual(self.limits.profile_plan(
            self._profile({'accessToken': 'x', 'subscriptionType': 'pro'})), 'pro')

    def test_a_null_tier_reads_as_unknown(self):
        """⚠ The CLI really does write `subscriptionType: null`. Unknown must
        stay empty so the panel shows no tier line at all."""
        self.assertEqual(self.limits.profile_plan(
            self._profile({'accessToken': 'x', 'subscriptionType': None})), '')

    def test_an_absent_field_reads_as_unknown(self):
        self.assertEqual(self.limits.profile_plan(
            self._profile({'accessToken': 'x'})), '')

    def test_a_profile_with_no_credentials_file_reads_as_unknown(self):
        self.assertEqual(self.limits.profile_plan(self._profile(None)), '')

    def test_unparseable_credentials_read_as_unknown(self):
        d = Path(tempfile.mkdtemp(prefix='bad-', dir=self.root))
        (d / '.credentials.json').write_text('{not json', encoding='utf-8')
        self.assertEqual(self.limits.profile_plan(str(d)), '')

    def test_it_reads_the_rows_own_file_and_never_the_ambient_one(self):
        """⚠ THE DEFECT ITSELF. `_plan` reads the host store; if profile_plan
        fell back to it, every secondary row would inherit the primary's tier
        and look correct while describing the wrong account."""
        host = Path(tempfile.mkdtemp(prefix='host-', dir=self.root)) / '.credentials.json'
        host.write_text(json.dumps(
            {'claudeAiOauth': {'subscriptionType': 'max'}}), encoding='utf-8')
        original = self.limits.subproxy.CREDS
        self.limits.subproxy.CREDS = str(host)
        try:
            self.assertEqual(self.limits._plan(), 'max')          # host says max…
            other = self._profile({'accessToken': 'x', 'subscriptionType': 'pro'})
            self.assertEqual(self.limits.profile_plan(other), 'pro')   # …row says pro
            self.assertEqual(self.limits.profile_plan(self._profile(None)), '')
        finally:
            self.limits.subproxy.CREDS = original


class AccountUsagePlanRouteTests(unittest.TestCase):
    """…and the same thing at GET /api/accounts/{id}/usage, where the renderer
    reads it."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix='orgtree-plan-route-')
        os.environ['ORGTREE_DATA'] = cls.root
        from engine.backend.orgtree import api, limits, registry, store
        bound = Path(store.DATA_ROOT).resolve()
        live = (Path.home() / 'orgtree').resolve()
        if bound == live or live in bound.parents:
            raise AssertionError(f'REFUSING: store bound to live {bound}')
        cls.api, cls.limits, cls.registry = api, limits, registry

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _row(self, subscription):
        AccountUsagePlanRouteTests._seq += 1
        d = Path(self.root) / f'acct-{self._seq}'
        d.mkdir(parents=True, exist_ok=True)
        oauth = {'accessToken': 'at', 'refreshToken': 'rt',
                 'expiresAt': 9_999_999_999_000}
        if subscription is not None:
            oauth['subscriptionType'] = subscription
        (d / '.credentials.json').write_text(
            json.dumps({'claudeAiOauth': oauth}), encoding='utf-8')
        return self.registry.create_account(
            'claude', 'claude-0', {'kind': 'managed', 'path': str(d)})

    def _usage(self, subscription):
        row = self._row(subscription)
        original = self.limits.fetch_for_token
        self.limits.fetch_for_token = lambda *a, **k: {
            'available': True, 'limits': [
                {'group': 'g', 'kind': 'session', 'percent': 12.0,
                 'resets_at': None, 'is_active': False, 'model': None}]}
        try:
            return asyncio.run(self.api.accounts_usage(row['id']))
        finally:
            self.limits.fetch_for_token = original

    def test_a_secondary_row_now_carries_its_tier(self):
        out = self._usage('max')
        self.assertTrue(out['available'])
        self.assertEqual(out['plan'], 'max')

    def test_the_tier_is_the_rows_own(self):
        self.assertEqual(self._usage('pro')['plan'], 'pro')

    def test_an_unreported_tier_is_omitted_not_invented(self):
        """⚠ POSITIVE CONTROL for the two above, and acceptance condition 3.
        Absent, not '' and not a guess — the panel hides the line on absent,
        and a default here would print a tier the provider never gave."""
        self.assertNotIn('plan', self._usage(None))

    def test_a_null_tier_is_omitted_too(self):
        self.assertNotIn('plan', self._usage(None))

    def test_the_usage_bars_still_come_through(self):
        """The tier must not have displaced the readout it sits above."""
        out = self._usage('max')
        self.assertEqual(len(out['limits']), 1)
        self.assertEqual(out['provider'], 'claude')
        self.assertIn('standing', out)


if __name__ == '__main__':
    unittest.main()
