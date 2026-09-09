"""The `reauth_required` signal each provider's usage fetch adds (D-231
expansion) — a structured field the usage-panel button keys off, never a
loose string match against `error`. `reauth_evidence` names WHICH fact
produced it: root's review ruling that a MEASURED 403/401 (Claude) and a
locally-observed "installed but not connected" (Codex/Antigravity) are
DISTINCT auth states and must never be flattened into one undifferentiated
boolean, since a person acting on the flag needs to know which kind of
evidence they are looking at. Pure unit tests: no CLI, no network, no
credentials touched.
"""
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error

_root = tempfile.TemporaryDirectory(prefix='v2-reauth-signal-')
os.environ['ORGTREE_DATA'] = _root.name
assert not Path(_root.name).resolve().is_relative_to((Path.home() / 'orgtree').resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import antigravity_limits, codex_limits, limits, providers, subproxy   # noqa: E402


def _http_error(code, headers=None, body=b''):
    return urllib.error.HTTPError(
        'https://example.invalid/usage', code, 'reason',
        headers or {}, io.BytesIO(body))


class ClaudeReauthSignalTests(unittest.TestCase):
    def test_genuine_401_is_a_credential_rejection(self):
        self.assertTrue(limits._is_credential_rejection(_http_error(401)))

    def test_genuine_403_with_no_throttle_evidence_is_a_credential_rejection(self):
        self.assertTrue(limits._is_credential_rejection(_http_error(403)))

    def test_other_http_errors_are_not(self):
        for code in (429, 500, 502):
            self.assertFalse(limits._is_credential_rejection(_http_error(code)),
                              f'status {code} must not read as a credential rejection')

    def test_non_http_errors_are_not(self):
        self.assertFalse(limits._is_credential_rejection(OSError('offline')))

    def test_throttled_403_is_a_throttle_not_a_credential_rejection(self):
        # POSITIVE CONTROL for the discrimination limits.py already makes:
        # a 403 carrying rate-limit evidence must stay a throttle, never
        # flip into "you need to sign in again".
        err = _http_error(403, headers={'Retry-After': '30'})
        self.assertIsNotNone(limits._throttle_window(err, 0.0))
        # and _is_credential_rejection does not itself know about throttle
        # evidence — it is `fetch`'s job to check `_throttle_window` FIRST
        # and never reach the credential-rejection branch for this case.
        # (see fetch()'s except block: `rl` short-circuits before `out`.)


class ClaudeFetchReauthEvidenceTests(unittest.TestCase):
    """Drives limits.fetch() through its REAL error path (not just the
    _is_credential_rejection helper in isolation) to prove the wiring
    actually sets reauth_evidence — trusting a one-line dict literal by
    inspection alone has been wrong twice already this session."""

    def setUp(self):
        self._orig_available = subproxy.available
        self._orig_token = subproxy.get_access_token
        # ⚠ coordinator review: a successful fetch's `plan` field reads the
        # real ~/.claude/.credentials.json (`_plan()`) unless this is
        # stubbed — this class's warm-cache test drives a real success
        # branch, and nothing here needs that file to exist to prove what
        # it's proving.
        self._orig_creds = subproxy.CREDS
        subproxy.CREDS = os.path.join(_root.name, 'not-a-real-credentials-file.json')
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
        limits._cache.clear()
        limits._cache.update(self._orig_cache)
        limits._cooldown.clear()
        limits._cooldown.update(self._orig_cooldown)

    def _raise(self, err):
        def _urlopen(*a, **kw):
            raise err
        limits.urllib.request.urlopen = _urlopen

    def test_genuine_403_sets_measured_403_evidence(self):
        self._raise(_http_error(403))
        out = limits.fetch(force=True)
        self.assertFalse(out['available'])
        self.assertTrue(out.get('reauth_required'))
        self.assertEqual(out.get('reauth_evidence'), 'measured_403')

    def test_throttled_403_sets_no_reauth_evidence(self):
        self._raise(_http_error(403, headers={'Retry-After': '30'}))
        out = limits.fetch(force=True)
        self.assertNotIn('reauth_required', out)
        self.assertNotIn('reauth_evidence', out)

    def test_unrelated_error_sets_no_reauth_evidence(self):
        self._raise(_http_error(500))
        out = limits.fetch(force=True)
        self.assertNotIn('reauth_required', out)
        self.assertNotIn('reauth_evidence', out)

    def test_a_warm_same_account_cache_does_not_mask_a_new_403(self):
        # coordinator review: `_stale_for_this_account` exists so a network
        # BLIP still shows the last good bars for the SAME account -- but a
        # credential rejection is not a blip. Serving the old "you're fine"
        # cache instead of surfacing reauth_required would hide the sign-in
        # button behind however long the warm cache takes to age out, even
        # though the CLI login has already actually failed.
        orig_identity = limits._identity
        limits._identity = lambda: {'uuid': 'warm-acct', 'email': 'warm@example.invalid'}
        self.addCleanup(lambda: setattr(limits, '_identity', orig_identity))

        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{}'
        limits.urllib.request.urlopen = lambda *a, **kw: _Resp()
        first = limits.fetch(force=True)
        self.assertTrue(first['available'], 'setup: the warm cache must actually be healthy first')

        self._raise(_http_error(403))
        out = limits.fetch(force=True)
        self.assertFalse(out['available'],
                          'a warm same-account cache masked a genuine 403 instead of surfacing it')
        self.assertTrue(out.get('reauth_required'))
        self.assertEqual(out.get('reauth_evidence'), 'measured_403')


class CodexReauthSignalTests(unittest.TestCase):
    def setUp(self):
        self._orig_status = providers.codex_status
        self._orig_cache = dict(codex_limits._cache)
        codex_limits._cache.update(at=0.0, data=None, complete_at=0.0, account=None)

    def tearDown(self):
        providers.codex_status = self._orig_status
        codex_limits._cache.clear()
        codex_limits._cache.update(self._orig_cache)

    def test_not_signed_in_sets_reauth_required_with_not_connected_evidence(self):
        providers.codex_status = lambda **kw: {
            'installed': True, 'connected': False, 'kind': None}
        out = codex_limits.fetch(force=True)
        self.assertFalse(out['available'])
        self.assertTrue(out.get('reauth_required'))
        # DISTINCT from Claude's 'measured_403' — this is a local file
        # read, never a server-measured rejection.
        self.assertEqual(out.get('reauth_evidence'), 'not_connected')

    def test_not_installed_does_not_set_reauth_required(self):
        # missing-CLI must never look like "please sign in again"
        providers.codex_status = lambda **kw: {'installed': False}
        out = codex_limits.fetch(force=True)
        self.assertFalse(out['available'])
        self.assertNotIn('reauth_required', out)
        self.assertNotIn('reauth_evidence', out)


class AntigravityReauthSignalTests(unittest.TestCase):
    def setUp(self):
        self._orig_status = providers.antigravity_status

    def tearDown(self):
        providers.antigravity_status = self._orig_status

    def test_not_signed_in_sets_reauth_required_with_not_connected_evidence(self):
        providers.antigravity_status = lambda **kw: {
            'installed': True, 'connected': False}
        out = antigravity_limits.fetch()
        self.assertFalse(out['available'])
        self.assertTrue(out.get('reauth_required'))
        self.assertEqual(out.get('reauth_evidence'), 'not_connected')

    def test_not_installed_does_not_set_reauth_required(self):
        providers.antigravity_status = lambda **kw: {'installed': False}
        out = antigravity_limits.fetch()
        self.assertFalse(out['available'])
        self.assertNotIn('reauth_required', out)
        self.assertNotIn('reauth_evidence', out)


if __name__ == '__main__':
    unittest.main()
