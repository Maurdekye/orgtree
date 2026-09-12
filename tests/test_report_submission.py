"""W21: one audience-preserving report submission path.

The endpoint is exercised with real per-agent tokens.  A direct user-audience
holder gets a document and a superior delivery receipt; a nested agent without
that audience gets only a forwarding mail.  W08 named artifacts are cited by
identity without granting or disclosing their stored file.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix="v2-w21-report-")
_data = Path(_root.name) / "data"; _data.mkdir()
_home = Path(_root.name) / "home"; _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN="operator")
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from orgtree import agentauth, ledger, store, supervisor  # noqa: E402

_created: list[str] = []


def tearDownModule() -> None:
    for slug in _created:
        store._POOL.close_all(slug)
    _root.cleanup()


class ReportSubmissionTests(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        type(self).seq += 1
        org = store.create_org(f"w21-fixture-{self.seq}")
        self.slug = str(org.d["slug"]); _created.append(self.slug)
        org.hire(ledger.USER, None, "haiku", 0, "top")
        org.hire(ledger.USER, None, "haiku", 0, "boss")
        # The user creates the nested fixture seat; ordinary agent hires need
        # a full explicit scope/charter and are not relevant to this test.
        org.hire(ledger.USER, "boss", "haiku", 0, "worker")
        store.save_org(org)
        self.client = TestClient(app)
        self.tokens = {n: agentauth.child_env(self.slug, n)["ORGTREE_AGENT_TOKEN"]
                       for n in ("top", "boss", "worker")}

    def call(self, node: str, tool: str = "orgtree_submit_report",
             **args: object) -> tuple[int, dict]:
        r = self.client.post("/api/agent", json={
            "org": self.slug, "node": node, "tool": tool, "args": args},
            headers={"X-Orgtree-Agent-Token": self.tokens[node]})
        return r.status_code, r.json()

    def test_direct_holder_gets_one_presentation_and_receipt(self) -> None:
        code, result = self.call("top", title="A report", body="Findings")
        self.assertEqual(code, 200, result)
        self.assertTrue(result["submitted"])
        self.assertFalse(result["forwarded"])
        self.assertEqual(result["presentation"]["immutable"], True)
        self.assertTrue(result["presentation"]["ref"].startswith("@doc:"))
        self.assertEqual(result["ref"], result["presentation"]["ref"])
        self.assertEqual(result["mail"]["recipient"], "@user")
        self.assertTrue(result["delivery_receipt"]["accepted"])
        self.assertFalse(result["delivery_receipt"]["read"])
        org = store.load_org(self.slug)
        self.assertEqual(len(org.d.get("documents") or []), 1)
        self.assertEqual(len(org.d.get("user_inbox") or []), 1)

    def test_without_user_audience_only_forwards_to_superior(self) -> None:
        code, result = self.call("worker", title="Private report", body="Details")
        self.assertEqual(code, 200, result)
        self.assertTrue(result["forwarded"])
        self.assertIsNone(result["presentation"])
        self.assertTrue(result["ref"].startswith("@mail:"))
        self.assertEqual(result["mail"]["recipient"], "boss")
        self.assertIn("REPORT FORWARDING ACTION",
                      (store.load_org(self.slug).d.get("mail") or {})
                      .get("boss", [])[-1]["body"])
        org = store.load_org(self.slug)
        self.assertEqual(org.d.get("documents") or [], [])
        self.assertIn("No user presentation was created",
                      (org.d.get("mail") or {}).get("boss", [])[-1]["body"])

    def test_user_audience_allows_presentation_but_does_not_change_superior_mail(self) -> None:
        org = store.load_org(self.slug)
        org.audience_grant(ledger.USER, "worker", "user")
        store.save_org(org)
        code, result = self.call("worker", title="Authorized report", body="Details")
        self.assertEqual(code, 200, result)
        self.assertFalse(result["forwarded"])
        self.assertTrue(result["presentation"]["ref"].startswith("@doc:"))
        self.assertEqual(result["mail"]["recipient"], "boss")
        self.assertEqual(len(store.load_org(self.slug).d.get("documents") or []), 1)

    def test_named_artifact_citation_never_grants_access_or_discloses_path(self) -> None:
        org = store.load_org(self.slug)
        item = org.work_create("boss", "Evidence", "evidence", owner="boss")
        wid = str(item["slug"])
        org.work_participants("boss", wid, add=["worker"])
        store.save_org(org)
        source = Path(supervisor.scratch_dir(self.slug, "boss")) / "secret-probe.py"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("secret", encoding="utf-8")
        code, artifact = self.call("boss", "orgtree_work", action="artifact",
                                   slug=wid, path=str(source), scope="named")
        self.assertEqual(code, 200, artifact)
        aid = artifact["artifact"]["id"]

        code, refused = self.call("worker", title="Cited", body="Details",
                                  artifacts=[{"work_item": wid, "artifact": aid}])
        self.assertEqual(code, 422, refused)
        self.assertEqual(len(store.load_org(self.slug).d.get("documents") or []), 0)
        self.assertNotIn("secret-probe.py", str(refused))

        self.call("boss", "orgtree_work", action="grant", slug=wid,
                  artifact=aid, to="worker")
        code, result = self.call("worker", title="Cited", body="Details",
                                 artifacts=[{"work_item": wid, "artifact": aid}])
        self.assertEqual(code, 200, result)
        self.assertEqual(result["artifacts"][0]["artifact"], aid)
        self.assertNotIn("name", result["artifacts"][0])
        self.assertNotIn("path", result["artifacts"][0])
        self.assertNotIn("secret-probe.py",
                         (store.load_org(self.slug).d.get("mail") or {})
                         .get("boss", [])[-1]["body"])


if __name__ == "__main__":
    unittest.main()
