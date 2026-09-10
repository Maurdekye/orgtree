"""`/api/providers?force=true` actually punches through codex_status's and
antigravity_status's own 60s caches (redteam-opus A3, measured against a
real Codex sign-in: the app's post-login verification read the pre-login
cached snapshot and reported failure for a login that had actually
succeeded). This drives providers.providers_payload()/api._providers_payload()
directly with instrumented stand-ins rather than trusting the one-line
`force=force` edits by inspection -- that trust has been wrong before this
session. Pure unit test: no CLI, no network, no credentials touched.
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

_root = tempfile.TemporaryDirectory(prefix='v2-providers-force-')
os.environ['ORGTREE_DATA'] = _root.name
assert not Path(_root.name).resolve().is_relative_to((Path.home() / 'orgtree').resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import api, providers   # noqa: E402


class ProvidersPayloadForceTests(unittest.TestCase):
    """Direct on providers.providers_payload -- the function redteam-opus
    named specifically."""

    def setUp(self):
        self._orig_codex_status = providers.codex_status
        self._orig_antigravity_status = providers.antigravity_status
        self.codex_calls = []
        self.antigravity_calls = []
        providers.codex_status = lambda force=False: (
            self.codex_calls.append(force),
            {'installed': True, 'connected': False, 'kind': None})[1]
        providers.antigravity_status = lambda force=False: (
            self.antigravity_calls.append(force),
            {'installed': True, 'connected': False})[1]

    def tearDown(self):
        providers.codex_status = self._orig_codex_status
        providers.antigravity_status = self._orig_antigravity_status

    def test_slow_provider_probes_overlap(self):
        both_started = threading.Barrier(2, timeout=2)
        def codex(force=False):
            both_started.wait()
            return {'installed': True, 'connected': False}
        def google(force=False):
            both_started.wait()
            return {'installed': True, 'connected': False}
        providers.codex_status = codex
        providers.antigravity_status = google
        payload = providers.providers_payload({'installed': True, 'connected': True})
        self.assertEqual([p['id'] for p in payload['providers']][:3],
                         ['claude', 'openai', 'google'])

    def test_force_true_reaches_codex_status(self):
        providers.providers_payload({'installed': True, 'connected': True}, force=True)
        self.assertIn(True, self.codex_calls,
                       f'codex_status was never called with force=True: {self.codex_calls}')

    def test_force_true_reaches_antigravity_status(self):
        providers.providers_payload({'installed': True, 'connected': True}, force=True)
        self.assertIn(True, self.antigravity_calls,
                       f'antigravity_status was never called with force=True: {self.antigravity_calls}')

    def test_default_force_is_false(self):
        # the ordinary panel poll must NOT force a fresh read every time —
        # that would defeat the cache's whole purpose (rate-limiting a
        # `--version` subprocess / a network probe on every poll).
        providers.providers_payload({'installed': True, 'connected': True})
        self.assertEqual(self.codex_calls, [False])
        self.assertEqual(self.antigravity_calls, [False])

    def test_force_provider_openai_forces_only_codex(self):
        # coordinator review, measured: a Claude login's verification loop
        # used to force a real Antigravity CLI probe (measured up to ~45s)
        # as a side effect. Naming the provider must narrow the punch-
        # through to just that one.
        providers.providers_payload({'installed': True, 'connected': True},
                                     force=True, force_provider='openai')
        self.assertEqual(self.codex_calls, [True])
        self.assertEqual(self.antigravity_calls, [False],
                          'antigravity must not be forced when only codex was named')

    def test_force_provider_google_forces_only_antigravity(self):
        providers.providers_payload({'installed': True, 'connected': True},
                                     force=True, force_provider='google')
        self.assertEqual(self.codex_calls, [False],
                          'codex must not be forced when only antigravity was named')
        self.assertEqual(self.antigravity_calls, [True])

    def test_no_force_provider_named_forces_both_unchanged(self):
        # the pre-existing blanket behaviour, preserved for any caller that
        # still means "refresh the whole document".
        providers.providers_payload({'installed': True, 'connected': True}, force=True)
        self.assertEqual(self.codex_calls, [True])
        self.assertEqual(self.antigravity_calls, [True])


class ApiProvidersForceTests(unittest.TestCase):
    """Through the actual /api/providers route handler, end to end."""

    def setUp(self):
        self._orig_claude_install_state = api.supervisor.claude_install_state
        self._orig_codex_status = api.providers.codex_status
        self._orig_antigravity_status = api.providers.antigravity_status
        self.claude_calls = []
        self.codex_calls = []
        self.antigravity_calls = []
        api.supervisor.claude_install_state = lambda force=False: (
            self.claude_calls.append(force),
            {'installed': False, 'path': None, 'source': ''})[1]
        api.providers.codex_status = lambda force=False: (
            self.codex_calls.append(force),
            {'installed': False})[1]
        # ⚠ MUST be mocked, not left real: an unmocked antigravity_status()
        # on a machine with the real CLI installed spawns an actual `agy
        # models` subprocess (up to a 45s timeout) — measured, this made
        # the test suite take 41s instead of under a second. Not a
        # credential/auth risk (read-only connectivity probe), but it is
        # neither a "pure unit test" nor fast, and it obscures what THIS
        # test is actually checking.
        api.providers.antigravity_status = lambda force=False: (
            self.antigravity_calls.append(force),
            {'installed': False})[1]

    def tearDown(self):
        api.supervisor.claude_install_state = self._orig_claude_install_state
        api.providers.codex_status = self._orig_codex_status
        api.providers.antigravity_status = self._orig_antigravity_status

    def test_providers_info_force_query_param_reaches_claude_install_state(self):
        import asyncio
        asyncio.run(api.providers_info(force=True))
        self.assertIn(True, self.claude_calls)
        self.assertIn(True, self.codex_calls)
        self.assertIn(True, self.antigravity_calls)

    def test_providers_info_default_does_not_force(self):
        import asyncio
        asyncio.run(api.providers_info())
        self.assertEqual(self.claude_calls, [False])
        self.assertEqual(self.codex_calls, [False])
        self.assertEqual(self.antigravity_calls, [False])

    def test_providers_info_force_provider_claude_forces_only_claude(self):
        import asyncio
        asyncio.run(api.providers_info(force=True, force_provider='claude'))
        self.assertEqual(self.claude_calls, [True])
        self.assertEqual(self.codex_calls, [False],
                          'codex must not be forced when only claude was named')
        self.assertEqual(self.antigravity_calls, [False],
                          'antigravity must not be forced when only claude was named')

    def test_providers_info_force_provider_openai_forces_only_codex(self):
        import asyncio
        asyncio.run(api.providers_info(force=True, force_provider='openai'))
        self.assertEqual(self.claude_calls, [False])
        self.assertEqual(self.codex_calls, [True])
        self.assertEqual(self.antigravity_calls, [False])

    def test_unrecognized_force_provider_is_rejected_not_silently_forceless(self):
        # redteam-opus, measured on 2bf84b7: every predicate downstream is
        # `force_provider is None or force_provider == "<name>"`, which is
        # False for an unrecognized name -- the docstring claimed that case
        # "keeps forcing both, unchanged", but the code actually forced
        # NOTHING, silently. `force_provider=codex` (the door's own trap:
        # Codex's id here is "openai", never "codex") must fail loudly at
        # the HTTP boundary instead of reaching the handler and forcing
        # zero providers. Goes through the real ASGI app -- calling
        # `api.providers_info(...)` directly bypasses FastAPI's own
        # request-parameter validation entirely.
        from fastapi.testclient import TestClient
        client = TestClient(api.app)
        response = client.get('/api/providers', params={
            'force': 'true', 'force_provider': 'codex'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.claude_calls, [],
                          'the handler must never run for a rejected query param')
        self.assertEqual(self.codex_calls, [])
        self.assertEqual(self.antigravity_calls, [])


if __name__ == '__main__':
    unittest.main()
