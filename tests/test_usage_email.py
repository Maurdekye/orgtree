"""Show the Claude account email in usage -- limits._identity() reads the
same account-identity metadata accounts.live_identity()/the providers
panel already trust, never the credentials store `_plan()` reads.

Also covers root's follow-up review of 3b4c589: limits.fetch()'s
STALE-ON-ERROR path used to answer for whoever was cached, not whoever is
signed in NOW -- after a sign-in as a different account, a cooldown or a
transient error could still hand back the PREVIOUS account's email and
usage. `fetch()` now stamps its cache with the account it was fetched
for and refuses to serve a stale readout stamped for someone else. Pure
unit tests: no CLI, no network, no real credentials touched.
"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error

_root = tempfile.TemporaryDirectory(prefix='v2-usage-email-')
os.environ['ORGTREE_DATA'] = _root.name
assert not Path(_root.name).resolve().is_relative_to((Path.home() / 'orgtree').resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import accounts, limits, subproxy   # noqa: E402


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='usage-email-case-'))
        self.config = self.tmp / 'claude.json'
        self._orig_config = accounts.LIVE_CONFIG
        accounts.LIVE_CONFIG = str(self.config)

    def tearDown(self):
        accounts.LIVE_CONFIG = self._orig_config

    def test_signed_in_identity_is_read(self):
        self.config.write_text(json.dumps({'oauthAccount': {
            'accountUuid': 'uuid-1', 'emailAddress': 'person@example.invalid'}}))
        identity = limits._identity()
        self.assertEqual(identity['uuid'], 'uuid-1')
        self.assertEqual(identity['email'], 'person@example.invalid')

    def test_missing_config_reads_as_empty_not_an_error(self):
        identity = limits._identity()
        self.assertEqual(identity['uuid'], '')
        self.assertEqual(identity['email'], '')

    def test_signed_out_config_reads_as_empty(self):
        self.config.write_text(json.dumps({}))
        identity = limits._identity()
        self.assertEqual(identity['uuid'], '')
        self.assertEqual(identity['email'], '')

    def test_malformed_config_reads_as_empty_not_a_crash(self):
        self.config.write_text('not json')
        identity = limits._identity()
        self.assertEqual(identity['uuid'], '')
        self.assertEqual(identity['email'], '')


def _http_error(code):
    return urllib.error.HTTPError('https://example.invalid/usage', code, 'reason', {}, io.BytesIO(b''))


class FetchAccountScopingTests(unittest.TestCase):
    """root's follow-up review of 3b4c589: a cache written for one account
    must never be served -- fresh OR stale -- once a different account is
    signed in."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='usage-scoping-case-'))
        self.config = self.tmp / 'claude.json'
        self._orig_config = accounts.LIVE_CONFIG
        accounts.LIVE_CONFIG = str(self.config)
        self._orig_available = subproxy.available
        self._orig_token = subproxy.get_access_token
        # ⚠ coordinator review: a successful fetch's `plan` field reads
        # subproxy.CREDS (`_plan()`) — left pointing at the real
        # ~/.claude/.credentials.json, a case here that reaches the success
        # branch reads a real file on whatever machine runs this suite.
        # Never written to, but this module's tests must not depend on
        # what happens to exist there, and pointing it at a path inside
        # this test's OWN throwaway tmpdir (never created) makes `_plan()`
        # take its documented empty-on-missing-file path instead.
        self._orig_creds = subproxy.CREDS
        subproxy.CREDS = str(self.tmp / 'not-a-real-credentials-file.json')
        self._orig_urlopen = limits.urllib.request.urlopen
        self._orig_cache = dict(limits._cache)
        self._orig_cooldown = dict(limits._cooldown)
        subproxy.available = lambda: True
        subproxy.get_access_token = lambda: 'fixture-token'
        limits._cache.clear()
        limits._cache.update(at=0.0, data=None)
        limits._cooldown.clear()

    def tearDown(self):
        subproxy.available = self._orig_available
        subproxy.get_access_token = self._orig_token
        subproxy.CREDS = self._orig_creds
        limits.urllib.request.urlopen = self._orig_urlopen
        accounts.LIVE_CONFIG = self._orig_config
        limits._cache.clear()
        limits._cache.update(self._orig_cache)
        limits._cooldown.clear()
        limits._cooldown.update(self._orig_cooldown)

    def _sign_in_as(self, uuid, email):
        self.config.write_text(json.dumps({'oauthAccount': {
            'accountUuid': uuid, 'emailAddress': email}}))

    def _succeed_once(self):
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{}'
        limits.urllib.request.urlopen = lambda *a, **kw: _Resp()

    def _fail_with(self, err):
        def _urlopen(*a, **kw):
            raise err
        limits.urllib.request.urlopen = _urlopen

    def test_successful_fetch_carries_the_signed_in_email(self):
        self._sign_in_as('uuid-a', 'a@example.invalid')
        self._succeed_once()
        out = limits.fetch(force=True)
        self.assertTrue(out['available'])
        self.assertEqual(out['email'], 'a@example.invalid')

    def test_stale_data_still_serves_for_the_SAME_account_on_a_transient_error(self):
        # the intentional, pre-existing behaviour this fix must not break:
        # a blip must still show the last good bars for the SAME account.
        self._sign_in_as('uuid-a', 'a@example.invalid')
        self._succeed_once()
        limits.fetch(force=True)
        self._fail_with(_http_error(500))
        out = limits.fetch(force=True)
        self.assertTrue(out['available'], 'a transient error for the SAME account must still serve stale data')
        self.assertEqual(out['email'], 'a@example.invalid')

    def test_a_different_signed_in_account_never_sees_the_previous_accounts_stale_data(self):
        self._sign_in_as('uuid-a', 'a@example.invalid')
        self._succeed_once()
        first = limits.fetch(force=True)
        self.assertEqual(first['email'], 'a@example.invalid')
        # switch accounts, then hit a transient error — the OLD account's
        # cached readout must not be handed back under the NEW identity
        self._sign_in_as('uuid-b', 'b@example.invalid')
        self._fail_with(_http_error(500))
        out = limits.fetch(force=True)
        self.assertNotEqual(out.get('email'), 'a@example.invalid',
                             'served account A\'s stale email under account B\'s identity')
        self.assertFalse(out.get('available', True),
                          'a different account with no fresh data of its own must not report available')

    def test_a_different_signed_in_account_is_not_served_stale_data_during_a_cooldown(self):
        self._sign_in_as('uuid-a', 'a@example.invalid')
        self._succeed_once()
        limits.fetch(force=True)
        # open a rate-limit cooldown the way a real 429 would
        limits._note_rate_limit(limits.HOST_COOLDOWN_KEY, 60.0, __import__('time').time())
        self._sign_in_as('uuid-b', 'b@example.invalid')
        out = limits.fetch(force=True)
        self.assertNotEqual(out.get('email'), 'a@example.invalid',
                             'served account A\'s stale email under account B\'s identity during cooldown')

    def test_force_false_does_not_serve_a_still_fresh_cache_across_an_account_switch(self):
        # coordinator review: every case above drives fetch(force=True) —
        # the ORDINARY (non-forced) call path has its own separate
        # account check (`_fresh_enough`, not `_stale_for_this_account`),
        # and nothing here had exercised it. A cache written moments ago
        # for account A is still well within CACHE_TTL when B signs in
        # right after — force=False must not treat that as "fresh enough"
        # just because the clock says so.
        self._sign_in_as('uuid-a', 'a@example.invalid')
        self._succeed_once()
        first = limits.fetch(force=True)
        self.assertEqual(first['email'], 'a@example.invalid')
        self._sign_in_as('uuid-b', 'b@example.invalid')
        self._succeed_once()
        out = limits.fetch(force=False)
        self.assertEqual(out['email'], 'b@example.invalid',
                          'an ordinary (non-forced) fetch served account A\'s still-fresh cache under account B\'s identity')


if __name__ == '__main__':
    unittest.main()
