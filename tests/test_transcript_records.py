"""Actual SQLite transactions and indexed, incremental transcript ingestion."""
import contextlib
import json
import os
import sqlite3
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

    # ------------------------------------------ F1: durable recovery spool
    def test_sqlite_outage_spools_durably_and_a_read_replays_exactly_once(self):
        source = records.journal_source('org', self.source)
        with patch.object(records, 'database',
                          side_effect=sqlite3.OperationalError('locked')):
            records.append_owned('org', self.source, self.path,
                                 [{"text": "held 1"}, {"text": "held 2"}])
        spool = records._spool_path()
        self.assertTrue(spool.is_file() and spool.stat().st_size > 0,
                        'control: the outage really spooled the batch')
        rows, _ = records.tail(source, 8)      # any read drains the spool
        self.assertEqual([json.loads(r[2])['text'] for r in rows],
                         ['held 1', 'held 2'])
        self.assertFalse(spool.exists(), 'a full replay retires the spool')
        self.assertEqual(len(records.tail(source, 8)[0]), 2,
                         'replay is exactly once')

    def test_replay_is_idempotent_when_truncation_fails_midway(self):
        source = records.journal_source('org', self.source)
        with patch.object(records, 'database',
                          side_effect=sqlite3.OperationalError('down')):
            records.append_owned('org', self.source, self.path, [{"text": "once"}])
        # the first replay commits but cannot remove the spool file — the
        # crash window between commit and truncation
        with patch.object(Path, 'unlink', side_effect=OSError('busy')):
            records.tail(source, 8)
        self.assertTrue(records._spool_path().is_file(),
                        'control: the spool survived the failed truncation')
        rows, _ = records.tail(source, 8)      # second replay, then retire
        self.assertEqual([json.loads(r[2])['text'] for r in rows], ['once'],
                         'the committed-id ledger stops a double commit')
        self.assertFalse(records._spool_path().exists())

    def test_recovered_records_precede_records_written_after_recovery(self):
        source = records.journal_source('org', self.source)
        with patch.object(records, 'database',
                          side_effect=sqlite3.OperationalError('down')):
            records.append_owned('org', self.source, self.path, [{"text": "early"}])
        records.append_owned('org', self.source, self.path, [{"text": "late"}])
        rows, _ = records.tail(source, 8)
        self.assertEqual([json.loads(r[2])['text'] for r in rows],
                         ['early', 'late'],
                         'the spool drains before anything newer commits')

    # ------------------------------- F7: boundary anchors against rewrites
    def test_same_prefix_rewrite_is_a_replacement_not_a_torn_seam(self):
        self.write(6)
        self.ingest()
        old_size = self.path.stat().st_size
        # rewrite IN PLACE: first record identical, size grows, tail differs —
        # invisible to the size/first-line checks alone
        kept_first = json.dumps({"text": "0"})
        rewritten = [kept_first] + [
            json.dumps({"text": f"rewritten {n} with extra padding"})
            for n in range(1, 6)]
        self.path.write_text("\n".join(rewritten) + "\n", encoding="utf8")
        self.assertGreater(self.path.stat().st_size, old_size,
                           'control: not detectable as a shrink')
        self.ingest()
        committed = records.tail(self.source, 50)[0]
        for _, _, body in committed:
            json.loads(body)   # a torn seam row would fail to parse
        self.assertEqual(
            [json.loads(r[2])["text"] for r in committed][-6:],
            ["0"] + [f"rewritten {n} with extra padding" for n in range(1, 6)],
            'the rewrite is a new incarnation, resumed from nowhere mid-record')

    # -------------------------------- F9: rank precision never collides
    def test_precision_exhaustion_renumbers_instead_of_colliding(self):
        seed = [{"event_id": "A"}, {"event_id": "B"}]
        records.order(self.source, seed)
        epochs = {records.order(self.source, seed)}
        prev = "B"
        for n in range(80):   # halves the same gap until floats run out
            trio = [{"event_id": "A"}, {"event_id": f"n{n}"}, {"event_id": prev}]
            epochs.add(records.order(self.source, trio))
            self.assertLess(trio[0]["seq"], trio[1]["seq"])
            self.assertLess(trio[1]["seq"], trio[2]["seq"])
            prev = f"n{n}"
        self.assertGreater(len(epochs), 1,
                           'control: a renumber actually ran (epoch moved)')
        everyone = [{"event_id": e} for e in
                    ["A"] + [f"n{n}" for n in range(79, -1, -1)] + ["B"]]
        records.order(self.source, everyone)
        seqs = [row["seq"] for row in everyone]
        self.assertEqual(seqs, sorted(seqs), 'relative order survives renumbering')
        self.assertEqual(len(set(seqs)), len(seqs), 'no two rows share a rank')

    # ------------------------------------ F6: no writer lock on no-op reads
    def _write_forbidden(self):
        original = records.database
        outer = self

        class ReadOnly:
            def __init__(self, conn):
                self._conn = conn

            def execute(self, sql, *args):
                outer.assertFalse(str(sql).strip().upper().startswith('BEGIN IMMEDIATE'),
                                  f'writer lock taken on a no-op read: {sql}')
                return self._conn.execute(sql, *args)

            def __getattr__(self, name):
                return getattr(self._conn, name)

        @contextlib.contextmanager
        def guarded():
            with original() as conn:
                yield ReadOnly(conn)
        return patch.object(records, 'database', guarded)

    def test_steady_state_ingest_and_order_take_no_writer_lock(self):
        self.write(4)
        self.ingest()
        rows = [{"event_id": "a"}, {"event_id": "b"}]
        records.order(self.source, rows)
        with self._write_forbidden():
            self.ingest()                      # unchanged file: read-only
            again = [{"event_id": "a"}, {"event_id": "b"}]
            records.order(self.source, again)  # all known: read-only
            records.tail(self.source, 8)
        self.assertEqual([r['seq'] for r in again], [r['seq'] for r in rows])

    # ----------------------- rename safety: journals keyed past the slug
    def test_org_rename_does_not_orphan_owned_journals(self):
        records.append_owned('old-name', self.source, self.path, [{"text": "kept"}])
        renamed = records.journal_source('new-name', self.source)
        self.assertEqual(renamed, records.journal_source('old-name', self.source),
                         'both slugs resolve to the journal FIRST committed')
        records.append_owned('new-name', self.source, self.path, [{"text": "after"}])
        rows, _ = records.tail(renamed, 8)
        self.assertEqual([json.loads(r[2])['text'] for r in rows],
                         ['kept', 'after'], 'one journal, not two')

    # --------------------------- durable prompt-view capture and matching
    def test_prompt_views_index_idempotently_and_prefer_corrections(self):
        source = records.views_source('org', 'sid')
        view = {"sha256": "d1", "at": "2026-09-10T12:00:00Z", "visible": "shown"}
        records.append_prompt_view(source, view)
        records.append_prompt_view(source, view)     # same row: once
        self.assertEqual(len(records.prompt_views_for(source, "d1")), 1)
        sidecar = Path(fixture.name) / (self._testMethodName + '.views.jsonl')
        sidecar.write_text(json.dumps(view) + "\n"
                           + json.dumps({**view, "at": "2026-09-10T12:05:00Z",
                                         "visible": "second"}) + "\n",
                           encoding="utf8")
        records.ingest_prompt_views(source, str(sidecar))
        records.ingest_prompt_views(source, str(sidecar))   # unchanged: no dupes
        self.assertEqual([v["visible"] for v in records.prompt_views_for(source, "d1")],
                         ["shown", "second"])
        # a rewritten sidecar re-imports; the correction wins per occurrence,
        # while rows pruned from the file stay durably indexed
        sidecar.write_text(json.dumps({**view, "visible": "corrected"}) + "\n",
                           encoding="utf8")
        records.ingest_prompt_views(source, str(sidecar))
        got = [v["visible"] for v in records.prompt_views_for(source, "d1")]
        self.assertEqual(got, ["corrected", "second"])


if __name__ == "__main__":
    unittest.main()
