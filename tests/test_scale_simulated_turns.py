"""Exercise actual admission/confirmation/finish around the synthetic provider leg."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="scale-completed-turns-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_provenance  # noqa: F401
from orgtree import halt, ledger, orgtx, store, supervisor as sup
from tools.scale.simulated import SimulatedProvider


class CompletedTurnTests(unittest.TestCase):
    def setUp(self):
        self.slug = "sim-" + uuid.uuid4().hex[:10]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "worker")
        org.node("worker")["session_id"] = str(uuid.uuid4())
        self.message = org.post_mail(ledger.USER, "worker", "scale durable-consumption canary")
        store.save_org(org)
        self.adapter = SimulatedProvider(sup, halt, slug=self.slug, nodes=["worker"], seconds=0)
        self.patches = [patch.object(sup, "_codex_leg", self.adapter),
                        patch.object(sup, "_after_turn", self.adapter.finish),
                        patch.object(sup, "spawn_env", return_value={}),
                        patch.object(sup, "_deployment_org_gate"),
                        patch.object(sup.subprocess, "Popen", side_effect=FileNotFoundError("external process forbidden"))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        store._POOL.close_all(self.slug)

    def run_turn(self):
        return sup._run_one_turn(self.slug, "worker", sup._mark_ping("scale mail", mail_ids=[self.message["id"]]))

    def test_real_turn_consumes_mail_and_commits_finish(self):
        self.run_turn()
        counters = self.adapter.snapshot()
        self.assertEqual(counters["started"], 1, "provider seam must actually execute")
        self.assertEqual(counters["completed"], 1)
        self.assertEqual(counters["booked"], 1)
        self.assertEqual(counters["failed_bookings"], 0)
        stored = orgtx.org_read(self.slug)
        self.assertFalse((stored.d.get("mail") or {}).get("worker"))
        self.assertFalse((stored.d.get("delivering") or {}).get("worker"))
        self.assertNotIn("inflight", stored.node("worker"))
        self.assertFalse(sup.state(self.slug, "worker").get("busy"))
        turns = stored.node("worker").get("turns") or []
        self.assertEqual(len(turns), 1, "real completion must book exactly one turn")
        self.assertEqual(turns[-1].get("cost_source"), "scale-simulated")
        self.assertIsNone(sup.state(self.slug, "worker").get("last_error"))

    def test_real_admission_halt_freeze_killswitch_prevent_provider_and_drain(self):
        for gate in ("halt", "frozen", "killswitch"):
            with self.subTest(gate=gate):
                org = orgtx.org_read(self.slug)
                if gate == "killswitch":
                    org.d[gate] = {"at": "fixture", "reason": "test"}
                else:
                    org.node("worker")[gate] = {"phase": "halted"} if gate == "halt" else {"cause": "test"}
                store.save_org(org)
                try:
                    self.run_turn()
                    self.assertEqual(self.adapter.snapshot()["started"], 0)
                    stored = orgtx.org_read(self.slug)
                    box = (stored.d.get("mail") or {}).get("worker") or []
                    self.assertIn(self.message["id"], [m["id"] for m in box])
                    self.assertFalse((stored.d.get("delivering") or {}).get("worker"))
                finally:
                    org = orgtx.org_read(self.slug)
                    org.d.pop("killswitch", None)
                    org.node("worker").pop("halt", None)
                    org.node("worker").pop("frozen", None)
                    store.save_org(org)

    def test_provider_cannot_accept_an_unlisted_fixture_node(self):
        org = orgtx.org_read(self.slug)
        adapter = SimulatedProvider(sup, halt, slug=self.slug, nodes=[], seconds=0)
        with self.assertRaisesRegex(RuntimeError, "outside declared fixture"):
            adapter(self.slug, "worker", org, sup.state(self.slug, "worker"), "input", [])
        self.assertEqual(adapter.snapshot()["started"], 0)


if __name__ == "__main__":
    unittest.main()
