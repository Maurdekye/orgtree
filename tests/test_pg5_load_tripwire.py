"""PG-5 load driver (tools/pg5_load.py): the DOC_LOCK tripwire measurement.

Plan decision 42 step 3 gates the fence-off on the postgres arm showing no
legacy DOC_LOCK acquisition, no save outside an org_tx and no StaleWrite
under load. pg5_load's child has no lifespan, so nothing armed the tripwire
before this change and a zero would have meant nothing. These tests prove
the child arms it and reports it: a legacy acquire PLANTED in the child's
load phase is counted exactly once at the plant's own line (nothing else in
the child is at a pg5_load.py site), and the gate refuses every way the
report can say "not zero".

The one end-to-end run uses the sqlite arm only (no database needed), 8
calls, through the tool's own parent/child isolation; its cost is the
child's startup (about two minutes here), not the 8 calls.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / "tools")]

import pg5_load  # noqa: E402
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


def _run() -> dict:
    with tempfile.TemporaryDirectory(prefix="v3-pg5-tripwire-") as tmp:
        out = Path(tmp) / "load.json"
        cmd = [sys.executable, str(REPO / "tools" / "pg5_load.py"), "--arms", "sqlite",
               "--modes", "fixed-work", "--operations", "8", "--min-free-commit-gb", "0",
               "--python", sys.executable, "--output", str(out), "--plant-legacy-doc-lock"]
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=600)
        if r.returncode:
            raise AssertionError(f"pg5_load exit {r.returncode}: {r.stdout[-2000:]} {r.stderr[-2000:]}")
        return json.loads(out.read_text(encoding="utf-8"))


def _own_sites(trip: dict) -> dict[str, int]:
    return {s: n for s, n in trip["sites"]["legacy"].items() if s.startswith("pg5_load.py:child:")}


class TripwireEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.planted = _run()

    def test_report_is_present_and_armed_in_count_mode(self) -> None:
        for report in (self.planted,):
            (arm,) = report["arms"]
            self.assertEqual(arm["store_backend"], "sqlite")
            for phase in ("setup", "load"):
                trip = arm[phase]["doc_lock_tripwire"]
                self.assertEqual(trip["mode"], "count", phase)
                self.assertIsNotNone(trip["armed_at"], phase)
                for key in ("legacy_total", "fence_total", "save_total", "exempt_total"):
                    self.assertIsInstance(trip[key], int, (phase, key))
                self.assertIsInstance(arm[phase]["stale_writes"], int, phase)
            self.assertIsInstance(arm["workloads"][0]["stale_writes"], int)
            self.assertEqual(arm["workloads"][0]["classification"], "passed",
                             arm["workloads"][0]["errors"])

    def test_a_planted_legacy_acquire_is_counted_at_its_site(self) -> None:
        trip = self.planted["arms"][0]["load"]["doc_lock_tripwire"]
        own = _own_sites(trip)
        self.assertEqual(list(own.values()), [1], f"planted acquire not counted once: {trip['sites']}")
        (site,) = own
        line = int(site.split(" <- ")[0].split(":")[2])
        src = (REPO / "tools" / "pg5_load.py").read_text(encoding="utf-8").splitlines()
        self.assertIn("with store.DOC_LOCK:", src[line - 1], site)
        self.assertGreaterEqual(trip["legacy_total"], 1)

    def test_the_setup_report_has_no_planted_site(self) -> None:
        # the plant runs after the workloads: the setup phase must not show it
        self.assertEqual(_own_sites(self.planted["arms"][0]["setup"]["doc_lock_tripwire"]), {})

    def test_the_load_report_does_not_carry_the_setup_events(self) -> None:
        # re-armed after the fixture: the load report counts load only
        arm = self.planted["arms"][0]
        self.assertGreater(arm["load"]["doc_lock_tripwire"]["armed_at"],
                           arm["setup"]["doc_lock_tripwire"]["armed_at"])

    def test_no_gate_is_claimed_without_a_postgres_arm(self) -> None:
        self.assertIsNone(self.planted["fence_off_gate"])


def _arm(**trip) -> dict:
    base = {"mode": "count", "armed_at": 1.0, "legacy_total": 0, "fence_total": 0,
            "save_total": 0, "exempt_total": 2,
            "sites": {"legacy": {}, "fence": {}, "save": {}, "exempt": {"store.py:create_org:1": 2}}}
    base.update(trip)
    return {"arm": "postgres", "transition_fence": "off",
            "load": {"doc_lock_tripwire": base, "stale_writes": 0}}


class Gate(unittest.TestCase):
    def test_zero_passes_with_exempt_sites(self) -> None:
        self.assertEqual(pg5_load._fence_off_gate(_arm()), {"passed": True, "errors": []})

    def test_every_nonzero_fails(self) -> None:
        cases = {
            "legacy": _arm(legacy_total=1, sites={"legacy": {"api.py:x:1": 1}, "fence": {},
                                                  "save": {}, "exempt": {}}),
            "save": _arm(save_total=1, sites={"legacy": {}, "fence": {},
                                              "save": {"api.py:y:2": 1}, "exempt": {}}),
            "unarmed": _arm(mode="off", armed_at=None),
        }
        stale = _arm()
        stale["load"]["stale_writes"] = 1
        cases["stale"] = stale
        fenced = _arm()
        fenced["transition_fence"] = "on"
        cases["fence on"] = fenced
        for name, arm in cases.items():
            with self.subTest(name):
                g = pg5_load._fence_off_gate(arm)
                self.assertFalse(g["passed"], name)
                self.assertTrue(g["errors"], name)


class EvidenceSpread(unittest.TestCase):
    """The ledger caps a work item at 50 evidence rows; the gating run at
    e9007a8 lost 29-30 fixed-demand calls to that cap because both modes
    shared one item. Every item must receive at most EVIDENCE_PER_ITEM."""

    def test_no_item_gets_more_than_its_share(self) -> None:
        self.assertLessEqual(pg5_load.EVIDENCE_PER_ITEM, 50)
        for operations in (8, 160, 164, 400, 2000):
            with self.subTest(operations=operations):
                per: dict[int, int] = {}
                for i, kind, _ in pg5_load._plan(operations):
                    if kind == "evidence":
                        k = pg5_load._evidence_item(i)
                        per[k] = per.get(k, 0) + 1
                self.assertEqual(sorted(per), list(range(pg5_load._items_needed(operations))))
                self.assertLessEqual(max(per.values()), pg5_load.EVIDENCE_PER_ITEM)


class LostEvidence(unittest.TestCase):
    def test_a_lost_ref_is_named_with_its_actor_status_and_item(self) -> None:
        plan = pg5_load._plan(400)                  # 100 evidence calls: 3 items
        samples = [{"id": i, "kind": k, "actor": f"worker-{a}", "status": 200, "error": None}
                   for i, k, a in plan]
        samples[166]["status"], samples[166]["error"] = 500, "HTTP 500"
        slugs = ["item-0", "item-1", "item-2"]
        msg = pg5_load._lost_evidence("t", {"t-166", "t-2"}, 100, samples, slugs)
        self.assertIn("2 of 100 refs missing (1 of them answered 200)", msg)
        self.assertIn("{'ref': 't-2', 'actor': 'worker-2', 'status': 200, 'item': 'item-0'}", msg)
        # op 166 is the 41st evidence call, so it went to the second item
        self.assertIn("{'ref': 't-166', 'actor': 'worker-6', 'status': 500, 'item': 'item-1'}", msg)
        self.assertLess(msg.index("t-2'"), msg.index("t-166'"))

    def test_a_lost_ref_with_no_sample_is_still_named(self) -> None:
        plan = pg5_load._plan(160)
        samples = [{"id": i, "kind": k, "actor": f"worker-{a}", "status": 200, "error": None}
                   for i, k, a in plan if i != 10]          # op 10 never recorded a sample
        msg = pg5_load._lost_evidence("t", {"t-10"}, 40, samples, ["item-0"])
        self.assertIn("1 of 40 refs missing (0 of them answered 200)", msg)
        self.assertIn("{'ref': 't-10', 'actor': 'worker-2', 'status': None, 'item': 'item-0', "
                      "'sample': 'no sample'}", msg)


class StaleCounter(unittest.TestCase):
    def test_every_constructed_stale_write_is_counted(self) -> None:
        class StaleWrite(Exception):
            pass

        fake = types.SimpleNamespace(StaleWrite=StaleWrite)
        seen = pg5_load._count_stale_writes(fake)
        try:
            raise fake.StaleWrite("lost the compare-and-set")
        except StaleWrite as e:
            self.assertEqual(str(e), "lost the compare-and-set")
        fake.StaleWrite("constructed, swallowed")
        self.assertEqual(seen, [2])


if __name__ == "__main__":
    unittest.main()
