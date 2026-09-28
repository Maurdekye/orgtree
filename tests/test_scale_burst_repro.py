"""The burst repro's default memory series (tools/scale/burst_repro.engine_series)."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
from burst_repro import engine_series


class EngineSeries(unittest.TestCase):
    def test_series_splits_at_the_burst_and_reports_the_peak(self):
        rows = [dict(at=90.0, engine_private=0, free_commit_gib=30.0),
                dict(at=99.0, engine_private=1_400 * 2**20, free_commit_gib=30.0),
                dict(at=100.5, engine_private=3_800 * 2**20, free_commit_gib=28.0),
                dict(at=102.0, engine_private=5_600 * 2**20, free_commit_gib=27.5)]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "guard.jsonl"
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            out = engine_series(path, burst_start=100.0)
        self.assertEqual(out["engine_mb_before_burst"], 1400)
        self.assertEqual(out["engine_mb_peak_burst"], 5600)
        self.assertEqual([s["t"] for s in out["engine_series"]], [0.5, 2.0])

    def test_no_samples_during_the_burst(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "guard.jsonl"
            path.write_text(json.dumps(dict(at=1.0, engine_private=5, free_commit_gib=9.0)) + "\n", encoding="utf-8")
            out = engine_series(path, burst_start=100.0)
        self.assertIsNone(out["engine_mb_peak_burst"])
        self.assertEqual(out["engine_series"], [])


if __name__ == "__main__":
    unittest.main()
