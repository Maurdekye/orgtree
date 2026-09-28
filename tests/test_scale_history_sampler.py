"""The N1000 controller's read-only history-ingest sampler (baseline_readiness.HistorySampler)."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
from baseline_readiness import HistorySampler


class Sampler(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "transcript-records.sqlite3"
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("CREATE TABLE transcript_sources (source TEXT, lower_byte INT, upper_byte INT)")
        self.phase = "small-prime"
        self.sampler = HistorySampler(self.db, [dict(node="a", source="A", bytes=100),
                                                dict(node="b", source="B", bytes=50)],
                                      Path(self.dir.name) / "history.jsonl", time.time(), lambda: self.phase)

    def tearDown(self):
        self.dir.cleanup()

    def put(self, source, lower, upper):
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("DELETE FROM transcript_sources WHERE source=?", (source,))
            conn.execute("INSERT INTO transcript_sources VALUES (?,?,?)", (source, lower, upper))

    def test_progress_counts_only_fully_ingested_sources(self):
        self.put("A", 0, 60)
        self.put("OTHER", 0, 999)
        row = self.sampler.sample()
        self.assertEqual((row["done"], row["total"], row["bytes_done"], row["bytes_total"]), (0, 2, 60, 150))
        self.put("A", 0, 100)
        self.assertEqual(self.sampler.sample()["done"], 1)
        lines = (Path(self.dir.name) / "history.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual([json.loads(x)["done"] for x in lines], [0, 1])

    def test_summary_reports_running_during_traffic_and_finish_time(self):
        self.put("A", 0, 100)
        self.sampler.sample()
        self.phase = "small-measured"
        self.sampler.sample()
        self.put("B", 0, 50)
        summary = self.sampler.summary("small-measured")
        self.assertTrue(summary["running_during_traffic"])
        self.assertIsNotNone(summary["finished_at_s"])
        self.assertEqual(summary["last"]["done"], 2)
        self.assertEqual(summary["at_active_ready"]["done"], 1)

    def test_history_finished_before_traffic_is_not_running_during_it(self):
        self.put("A", 0, 100)
        self.put("B", 0, 50)
        self.sampler.sample()
        self.phase = "small-measured"
        summary = self.sampler.summary("small-measured")
        self.assertFalse(summary["running_during_traffic"])
        self.assertEqual(summary["finished_at_s"], summary["at_active_ready"]["t"])


if __name__ == "__main__":
    unittest.main()
