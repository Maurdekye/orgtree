"""Per-home Codex usage read (multi-account D3): fake server transport, no
live provider or login. Asserts the four properties that matter — the home
is PINNED to the client, the cache is ISOLATED from the ambient board, the
client is CLOSED on every path, and failures degrade honestly (stale-on-
error with the error named)."""
import os
import tempfile
import unittest
from unittest.mock import patch


PAYLOAD = {"rateLimits": {
    "limitId": "codex", "planType": "plus",
    "primary": {"usedPercent": 41.5, "windowDurationMins": 300,
                "resetsAt": 1790000000},
    "secondary": {"usedPercent": 80.0, "windowDurationMins": 10080,
                  "resetsAt": 1790500000}}}


class FakeClient:
    instances: list["FakeClient"] = []
    fail = False

    def __init__(self, argv_head, codex_home=None, **kw):
        self.codex_home = codex_home
        self.closed = False
        FakeClient.instances.append(self)

    def initialize(self):
        if FakeClient.fail:
            raise RuntimeError("fake transport down")

    def request(self, method, params, timeout=None):
        assert method == "account/rateLimits/read"
        return dict(PAYLOAD)

    def close(self):
        self.closed = True


class CodexHomeUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-cxusage-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import codex_limits, codexrun, providers, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.cl = codex_limits
        cls.codexrun = codexrun
        cls.providers = providers

    def setUp(self):
        FakeClient.instances = []
        FakeClient.fail = False
        self.cl._home_cache.clear()
        self.home = os.path.join(self.root, "cx-home")
        os.makedirs(self.home, exist_ok=True)

    def _fetch(self, key="k1", force=False):
        with patch.object(self.codexrun, "AppServerClient", FakeClient), \
             patch.object(self.providers, "codex_path",
                          return_value=("codex.exe", "test")), \
             patch.object(self.providers, "codex_argv",
                          side_effect=lambda exe: [exe]):
            return self.cl.fetch_for_home(self.home, key, force=force)

    def test_home_pinned_normalized_and_cached(self):
        out = self._fetch()
        self.assertTrue(out["available"])
        self.assertEqual(len(out["limits"]), 2)
        self.assertEqual(out["limits"][0]["percent"], 41.5)
        self.assertIn("account", out)          # the HOME'S digest rides along
        self.assertEqual(FakeClient.instances[0].codex_home, self.home)
        self.assertTrue(FakeClient.instances[0].closed)
        # second read within TTL: served from the isolated cache, no launch
        out2 = self._fetch()
        self.assertEqual(len(FakeClient.instances), 1)
        self.assertTrue(out2["available"])

    def test_isolated_from_ambient_board(self):
        before = dict(self.cl._cache)
        self._fetch()
        self.assertEqual(dict(self.cl._cache), before)  # ambient untouched
        # and distinct cache keys are distinct boards
        self._fetch(key="k2")
        self.assertEqual(len(FakeClient.instances), 2)

    def test_failure_degrades_honestly_and_closes(self):
        FakeClient.fail = True
        out = self._fetch()
        self.assertFalse(out["available"])
        self.assertIn("fake transport down", out["error"])
        self.assertTrue(FakeClient.instances[0].closed)  # closed on failure
        # stale-on-error: prime a good board, then fail — stale served with
        # the refresh error NAMED, not silently
        FakeClient.fail = False
        self._fetch(key="k3")
        FakeClient.fail = True
        out2 = self._fetch(key="k3", force=True)
        self.assertTrue(out2["available"])   # the stale board
        self.assertIn("refresh failed", out2["error"])


if __name__ == "__main__":
    unittest.main()
