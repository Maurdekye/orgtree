"""Opt-in tiny end-to-end control; never creates the N1000 fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

import import_provenance  # noqa: F401

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO.parent.parent


@unittest.skipUnless(os.environ.get("ORGTREE_CONTROLLER_CONTROL") == "1", "explicit small controller control required")
class ControllerSmoke(unittest.TestCase):
    def test_two_history_arms_use_frozen_source_and_equal_demand(self):
        root = Path("C:/Temp") / ("scale-ui-history-control-" + uuid.uuid4().hex)
        packet = REPO / ".scale-results" / os.environ["ORGTREE_CONTROLLER_LABEL"]
        packet.mkdir(parents=True, exist_ok=True)
        (packet / "root.json").write_text(json.dumps({"root": str(root)}), encoding="utf-8")
        with (packet / "controller.log").open("w", encoding="utf-8") as log:
            run = subprocess.run([sys.executable, "-I", "-B", str(REPO / "tools/scale/baseline.py"),
                "--small-control", "--root", str(root),
                "--custodian", str(MAIN / "artifacts/p03-tools/pg-custodian-e4f3c8f.exe"),
                "--pg-bin", str(MAIN / "artifacts/p03-postgresql/18.6-4/bin")],
                stdout=log, stderr=subprocess.STDOUT, timeout=420)
        result = json.loads((root / "result.json").read_text(encoding="utf-8")) if (root / "result.json").exists() else {}
        self.assertEqual(run.returncode, 0, (packet / "controller.log").read_text(encoding="utf-8"))
        self.assertTrue(result["complete"], result.get("error"))
        self.assertTrue(result["cleanup"]["children_exited"])
        self.assertTrue(result["cleanup"]["pg_stopped"])
        self.assertEqual(result["cleanup"]["errors"], [])
        self.assertEqual(result["small"]["config"]["plans"], result["large"]["config"]["plans"])
        for arm in ("small", "large"):
            summary = result[arm]
            self.assertTrue(summary["workload_completed_without_errors_or_overload"])
            self.assertGreater(summary["write_oracle"]["checked"], 0)
            self.assertEqual(summary["write_oracle"]["failed"], 0)
            self.assertGreater(summary["activity_after"]["provider"]["booked"], 0)
            self.assertEqual(summary["measurement"]["begin_s"], 3)
            self.assertEqual(summary["measurement"]["end_s"], 11)
            primer = json.loads((root / f"receipts/{arm}-prime.json").read_text(encoding="utf-8"))
            self.assertEqual(primer["writes"], {"acknowledged": 10, "checked": 10, "failed": 0})
            self.assertTrue((root / f"receipts/{arm}-verify.json").is_file())
            readiness = json.loads((root / f"receipts/{arm}-readiness.json").read_text(encoding="utf-8"))
            self.assertTrue(readiness["verified"])
            self.assertEqual(readiness["sources"], 12 if arm == "small" else 30)
            counters = [json.loads(line) for line in (root / f"receipts/{arm}/sql-counts.jsonl").read_text().splitlines()]
            self.assertTrue(any(row["rows"] > 0 for row in counters))
            self.assertTrue(any(row["write_parameter_bytes"] > 0 for row in counters))
            self.assertFalse(any(row["unsupported_operations"] for row in counters))


if __name__ == "__main__":
    unittest.main()
