"""Fixture-only checks for W14's aggregate and live timing controls."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from fastapi import HTTPException

# Keep this module fixture-only and independent of a live installation.  The
# production data root is never imported or opened by this test process.
_root = tempfile.TemporaryDirectory(prefix="w14-diagnostics-")
_data = Path(_root.name) / "data"
_home = Path(_root.name) / "home"
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN="operator",
                  ORGTREE_PROFILE_TIMING="0")
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

from orgtree.diagnostics import aggregate_document


class AggregateFixtureTests(unittest.TestCase):
    def test_counts_and_utf8_sizes_are_exact_without_returning_rows(self):
        fixture = {
            "nodes": {"a": {"state": "live"}, "b": {"state": "archived"}},
            "events": [{"kind": "status", "text": "h\u00e9"}, {"kind": "save"}],
            "mail_log": {"a": [{"body": "private"}]},
            "prompt": "must never be traversed",
            "credential": "secret-token",
        }
        before = copy.deepcopy(fixture)
        got = aggregate_document(fixture, ("nodes", "events"))
        expected_nodes = sum(
            len(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            for row in fixture["nodes"].values())
        expected_events = sum(
            len(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            for row in fixture["events"])
        self.assertEqual(got, {
            "collections": {
                "nodes": {"rows": 2, "bytes": expected_nodes},
                "events": {"rows": 2, "bytes": expected_events},
            },
            "totals": {"rows": 4, "bytes": expected_nodes + expected_events},
        })
        self.assertEqual(fixture, before)
        wire = json.dumps(got)
        self.assertNotIn("private", wire)
        self.assertNotIn("secret-token", wire)
        self.assertNotIn("must never", wire)

    def test_unknown_collection_is_refused(self):
        with self.assertRaises(ValueError):
            aggregate_document({}, ("prompt",))


class DiagnosticsAuthorizationTests(unittest.TestCase):
    def test_public_and_bridge_scopes_are_not_operator_authority(self):
        from orgtree.diagnostics import _operator_only

        for key in ("public_slug", "bridge_slug"):
            request = type("Request", (), {"scope": {"state": {key: "org"}}})()
            with self.assertRaises(HTTPException) as caught:
                _operator_only(request)  # type: ignore[arg-type]
            self.assertEqual(caught.exception.status_code, 403)


class LiveTimingControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from engine.launch import load_app
        cls.app, *_ = load_app()
        cls.client = TestClient(cls.app)
        from orgtree import store
        cls.store = store

    @classmethod
    def tearDownClass(cls):
        cls.store._POOL.close_all("w14-live")
        _root.cleanup()

    def setUp(self):
        self.store.create_org("w14-live")

    def tearDown(self):
        self.store.delete_org("w14-live")

    def test_toggle_changes_capture_without_restart(self):
        headers = {"X-Orgtree-Desktop-Token": "operator"}
        before = self.client.get("/api/desktop/identity", headers=headers).json()
        self.assertFalse(self.client.get("/api/diagnostics/timing", headers=headers).json()["enabled"])
        self.assertEqual(self.client.post("/api/diagnostics/timing",
                                          json={"enabled": True}, headers=headers).json(),
                         {"enabled": True})
        self.client.get("/api/orgs/w14-live", headers=headers)
        captured = self.client.get("/api/diagnostics/timing", headers=headers).json()
        self.assertTrue(captured["enabled"])
        self.assertTrue(any(row["route"] == "/api/orgs/{slug}" for row in captured["records"]))
        self.assertEqual(self.client.post("/api/diagnostics/timing",
                                          json={"enabled": False}, headers=headers).json(),
                         {"enabled": False})
        newest = captured["newest_seq"]
        self.client.get("/api/orgs/w14-live", headers=headers)
        after = self.client.get("/api/diagnostics/timing", headers=headers).json()
        self.assertFalse(after["enabled"])
        self.assertEqual(after["newest_seq"], newest)
        self.assertEqual(self.client.get("/api/desktop/identity", headers=headers).json(), before)

    def test_aggregate_endpoint_is_read_only_and_metadata_only(self):
        headers = {"X-Orgtree-Desktop-Token": "operator"}
        path = self.store._db_path("w14-live")
        before = Path(path).read_bytes()
        got = self.client.get("/api/orgs/w14-live/diagnostics/aggregates",
                              params={"collections": "nodes,events"}, headers=headers)
        self.assertEqual(got.status_code, 200, got.text)
        body = got.json()
        self.assertEqual(body["org"], "w14-live")
        self.assertEqual(body["collections"]["nodes"]["rows"], 0)
        alias = self.client.get("/api/diagnostics/aggregates",
                                params={"org": "w14-live", "collections": "nodes"},
                                headers=headers)
        self.assertEqual(alias.status_code, 200, alias.text)
        self.assertEqual(alias.json()["org"], "w14-live")
        self.assertEqual(Path(path).read_bytes(), before)

    def test_diagnostics_requires_desktop_token(self):
        refused = self.client.get("/api/orgs/w14-live/diagnostics/aggregates")
        self.assertEqual(refused.status_code, 401)


if __name__ == "__main__":
    unittest.main()
