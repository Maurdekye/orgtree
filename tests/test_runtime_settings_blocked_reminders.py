"""The blocked-docket-reminder option is reachable over the runtime settings API.

The behaviour of the option lives in test_blocked_docket_reminder_gate.py. This
file covers the WIRING the user actually touches: that the choice is reported,
that it can be written on its own, that writing it disturbs no neighbouring
durable value, and that it satisfies the endpoint's "one runtime setting is
required" guard by itself. A correct rule behind an unreachable switch is not
a delivered option.
"""
import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix="v2-runtime-settings-")
_data = Path(_root.name) / "data"
_data.mkdir()
_home = Path(_root.name) / "home"
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN="operator")
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                  # noqa: E402
app, *_ = load_app()
from orgtree import appsettings                                     # noqa: E402

HEADERS = {"X-Orgtree-Desktop-Token": "operator"}
KEY = "blocked_docket_reminders_enabled"
PATH = "/api/app-settings/runtime"


def tearDownModule():
    _root.cleanup()


class RuntimeSettingsBlockedRemindersTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        settings = appsettings.path()
        if os.path.exists(settings):
            os.remove(settings)

    def get(self):
        r = self.client.get(PATH, headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def put(self, body):
        return self.client.put(PATH, json=body, headers=HEADERS)

    def test_the_choice_is_reported_and_defaults_off(self):
        body = self.get()
        self.assertIn(KEY, body,
                      "the option must be readable, or the settings panel has "
                      "nothing to render its state from")
        self.assertIs(body[KEY], False,
                      "the user asked for this off until its long-term "
                      "implications are known")

    def test_it_can_be_written_on_its_own_and_round_trips(self):
        r = self.put({KEY: True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(r.json()[KEY], True, "the response echoes the new state")
        self.assertIs(self.get()[KEY], True, "and it is durable")
        self.assertTrue(appsettings.blocked_docket_reminders_enabled(),
                        "the settings record agrees with the endpoint")
        self.assertIs(self.put({KEY: False}).json()[KEY], False,
                      "an explicit false is preserved, not treated as absent")
        self.assertIs(self.get()[KEY], False)

    def test_writing_it_disturbs_no_neighbouring_choice(self):
        """The endpoint updates ONE runtime choice without touching the others,
        so this key must not rewrite a durable value the user never touched."""
        self.assertEqual(self.put({"working_checkups_enabled": False}).status_code, 200)
        self.assertEqual(self.put({"wait_for_mcp_tools_enabled": True}).status_code, 200)
        self.assertEqual(self.put({KEY: True}).status_code, 200)
        after = self.get()
        self.assertIs(after["working_checkups_enabled"], False)
        self.assertIs(after["wait_for_mcp_tools_enabled"], True)
        self.assertIs(after[KEY], True)
        self.assertTrue(appsettings.wait_for_mcp_tools_enabled())
        self.assertFalse(appsettings.working_checkups_enabled())

    def test_it_satisfies_the_one_setting_required_guard_by_itself(self):
        """The guard 422s an empty body. This key alone must clear it, or the
        toggle would be unusable without sending a second unrelated setting."""
        self.assertEqual(self.put({}).status_code, 422)
        self.assertEqual(self.put({KEY: True}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
