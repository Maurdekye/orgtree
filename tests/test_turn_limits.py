"""The two per-turn limits are app settings: defaults, validation, env override, off."""
import os
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="turn-limits-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="turn-limits-tests")
os.environ.pop("ORGTREE_TURN_TIMEOUT", None)
os.environ.pop("ORGTREE_TURN_IDLE", None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
app, *_ = load_app()
from fastapi.testclient import TestClient
from orgtree import appsettings, supervisor as sup

HEADERS = {"X-Orgtree-Desktop-Token": "turn-limits-tests"}
URL = "/api/app-settings/runtime"


class TurnLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(appsettings.set_turn_timeout_s, appsettings.turn_timeout_s())
        self.addCleanup(appsettings.set_turn_idle_s, appsettings.turn_idle_s())
        for target in ("TURN_TIMEOUT", "TURN_IDLE"):
            p = patch.object(sup, target, None); p.start(); self.addCleanup(p.stop)

    def test_defaults_are_24_hours_and_10_minutes(self):
        body = self.client.get(URL, headers=HEADERS).json()
        self.assertEqual(body["turn_timeout_s"], 86400)
        self.assertEqual(body["turn_idle_s"], 600)
        self.assertEqual(sup.turn_timeout(), 86400)
        self.assertEqual(sup.turn_idle(), 600)

    def test_put_roundtrip_and_next_turn_reads_it(self):
        r = self.client.put(URL, headers=HEADERS, json={"turn_timeout_s": 7200, "turn_idle_s": 90})
        self.assertEqual(r.status_code, 200, r.text)
        body = self.client.get(URL, headers=HEADERS).json()
        self.assertEqual((body["turn_timeout_s"], body["turn_idle_s"]), (7200, 90))
        self.assertEqual((sup.turn_timeout(), sup.turn_idle()), (7200, 90))

    def test_zero_means_off_for_each_limit_independently(self):
        self.client.put(URL, headers=HEADERS, json={"turn_timeout_s": 0})
        self.assertIsNone(sup.turn_timeout())
        self.assertEqual(sup.turn_idle(), 600)
        self.client.put(URL, headers=HEADERS, json={"turn_timeout_s": 3600, "turn_idle_s": 0})
        self.assertIsNone(sup.turn_idle())
        self.assertEqual(sup.turn_timeout(), 3600)

    def test_bad_values_are_refused_and_change_nothing(self):
        self.client.put(URL, headers=HEADERS, json={"turn_timeout_s": 1000, "turn_idle_s": 100})
        for bad in (-1, 31536001, 1.5, "abc"):
            for key in ("turn_timeout_s", "turn_idle_s"):
                r = self.client.put(URL, headers=HEADERS, json={key: bad})
                self.assertIn(r.status_code, (400, 422), (key, bad, r.text))
        body = self.client.get(URL, headers=HEADERS).json()
        self.assertEqual((body["turn_timeout_s"], body["turn_idle_s"]), (1000, 100))

    def test_env_override_beats_setting_and_zero_env_is_off(self):
        appsettings.set_turn_timeout_s(1000)
        appsettings.set_turn_idle_s(100)
        with patch.object(sup, "TURN_TIMEOUT", 5), patch.object(sup, "TURN_IDLE", 0):
            self.assertEqual(sup.turn_timeout(), 5)
            self.assertIsNone(sup.turn_idle())


if __name__ == "__main__":
    unittest.main()
