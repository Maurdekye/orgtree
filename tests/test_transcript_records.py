"""Actual SQLite transactions and indexed, incremental transcript ingestion."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

fixture = tempfile.TemporaryDirectory(prefix="orgtree-transcript-records-")
os.environ["ORGTREE_DATA"] = str(Path(fixture.name) / "data")
Path(os.environ["ORGTREE_DATA"]).mkdir()
os.environ["ORGTREE_V2_TOKEN"] = "transcript-records-test-only"
from engine.launch import load_app
load_app()
from orgtree import transcript_records as records


class RecordsTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(fixture.name) / (self._testMethodName + ".jsonl")
        self.source = self._testMethodName

    def write(self, count, mode="w", start=0):
        with self.path.open(mode, encoding="utf8") as stream:
            for n in range(start, start + count):
                stream.write(json.dumps({"text": str(n)}) + "\n")

    def ingest(self, count=8):
        stats = {"bytes_read": 0}
        records.ingest(self.source, str(self.path), count, stats)
        return stats

    def texts(self, count=8):
        return [json.loads(row[2])["text"] for row in records.tail(self.source, count)[0]]

    def test_lazily_backfills_without_reordering_existing_occurrences(self):
        self.write(20000)
        stats = self.ingest()
        self.assertLess(stats["bytes_read"], self.path.stat().st_size)
        old = records.tail(self.source, 8)[0]
        self.assertEqual(self.texts(), [str(n) for n in range(19992, 20000)])
        self.ingest(30)
        self.assertEqual(records.tail(self.source, 30)[0][-8:], old)
        self.assertEqual(len(records.tail(self.source, 30)[0]), 30)
        self.assertTrue(records.tail(self.source, 30)[1])

    def test_deletion_and_rotation_preserve_committed_history(self):
        self.write(4)
        self.ingest()
        self.path.unlink()
        self.ingest()
        self.assertEqual(self.texts(), ["0", "1", "2", "3"])
        self.write(1, start=40)
        self.ingest()
        self.assertEqual(self.texts(), ["0", "1", "2", "3", "40"])

    def test_append_and_torn_record_retry_are_exactly_once(self):
        self.write(4)
        self.ingest()
        with self.path.open("ab") as stream:
            stream.write(b'{"text": "4"')
        self.ingest()
        self.assertEqual(len(self.texts()), 4)
        with self.path.open("ab") as stream:
            stream.write(b'}\n')
        self.ingest()
        self.ingest()
        self.assertEqual(self.texts(), ["0", "1", "2", "3", "4"])

    def test_transaction_failure_rolls_back_rows_and_cursor(self):
        self.write(4)
        self.ingest()
        self.write(2, "a", 4)
        original = records._insert
        def fail(conn, *args):
            original(conn, *args)
            raise RuntimeError("simulated interruption before cursor commit")
        with patch.object(records, "_insert", side_effect=fail):
            with self.assertRaises(RuntimeError):
                self.ingest()
        self.assertEqual(self.texts(), ["0", "1", "2", "3"])
        self.ingest()
        self.assertEqual(self.texts(), ["0", "1", "2", "3", "4", "5"])

    def test_application_owned_records_need_no_jsonl_file(self):
        records.append(self.source, [{"text": "same"}, {"text": "same"}])
        self.assertFalse(self.path.exists())
        rows, more = records.tail(self.source, 8)
        self.assertFalse(more)
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0][:2], rows[1][:2])

    def test_owned_writer_survives_missing_mirror_and_backfills_legacy(self):
        self.write(60)
        source = records.journal_source('org', self.source)
        records.append_owned('org', self.source, self.path, [{"text": "new"}])
        records.ingest(source, str(self.path), 100, {"bytes_read": 0})
        rows, more = records.tail(source, 100)
        self.assertEqual([json.loads(row[2])["text"] for row in rows], [str(i) for i in range(60)] + ['new'])
        self.assertFalse(more)
        self.path.unlink()
        records.append_owned('org', self.source, self.path, [{"text": "after deletion"}])
        rows, more = records.tail(source, 100)
        self.assertEqual(len(rows), 62)
        self.assertEqual(json.loads(rows[-1][2])["text"], "after deletion")

    def test_order_handles_are_stable_on_prepend_and_insert(self):
        first = [{"event_id": str(n)} for n in [2, 4]]
        records.order(self.source, first)
        before = {row['event_id']: row['seq'] for row in first}
        expanded = [{"event_id": str(n)} for n in range(6)]
        records.order(self.source, expanded)
        self.assertEqual([row['seq'] for row in expanded], sorted(row['seq'] for row in expanded))
        self.assertEqual({row['event_id']: row['seq'] for row in expanded if row['event_id'] in before}, before)


if __name__ == "__main__":
    unittest.main()
