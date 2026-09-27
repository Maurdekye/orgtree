"""Offline history identity/ratio and fail-closed manifest controls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "scale"))
import history_fixture as hf


def active():
    return dict(slug="history-pair", name="History pair", nodes={
        "boss": dict(id="boss", name="boss", model="haiku", state="live", parent=None, grant=10,
                     charter="active charter", session_id=None),
        "worker": dict(id="worker", name="worker", model="haiku", state="live", parent="boss", grant=0)},
        work_items=[dict(slug="current", status="open", objective="active work", owner={"node": "boss"})],
        mail={"worker": [dict(id="unread", body="must stay unread")]},
        mail_log={"worker": [dict(id="recent", body="fixed read tail", at="2026-09-27", read=True)]})


SMALL = hf.Recipe(retired_agents=2, archived_items=3, read_mail=4, old_transcripts=2,
                  payload_profile="fixed",
                  node_chars=128, item_chars=128, mail_chars=128, transcript_chars=128)


class HistoryFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="history-bundle-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = hf.prepare_base(active())

    def build(self, name="pair"):
        path = self.root / name
        manifest = hf.build_pair(self.base, path, SMALL)
        return path, manifest

    def test_identical_active_tail_and_tenfold_total_counts_and_bytes(self):
        source = active()
        frozen = hf.prepare_base(source)
        self.assertNotIn("mail_seq", source["nodes"]["boss"])
        self.assertEqual(frozen["mail"], source["mail"])
        tail = self.root / "current.jsonl"
        tail.write_text('current transcript\n', encoding="utf-8")
        path = self.root / "pair"
        manifest = hf.build_pair(frozen, path, SMALL, {"current.jsonl": tail})
        self.assertEqual(json.loads((path / "base.json").read_text()), frozen)
        self.assertEqual((path / "current-files/current.jsonl").read_bytes(), tail.read_bytes())
        checked = hf.verify_pair(path, require_complete=True)
        self.assertEqual(checked["active_sha256"], hf.digest(frozen))
        for family in hf.FAMILIES:
            for metric in ("count", "bytes"):
                fixed = manifest["baseline_history"][family][metric]
                self.assertGreaterEqual(manifest["arms"]["large"][family][metric] + fixed,
                                        10 * (manifest["arms"]["small"][family][metric] + fixed))

    def test_seed_repeats_exact_streams_and_keeps_small_prefix(self):
        first, m1 = self.build("one")
        second, m2 = self.build("two")
        self.assertEqual(m1["arms"], m2["arms"])
        self.assertEqual(m1["active_sha256"], m2["active_sha256"])
        for family in hf.FAMILIES:
            small = list(hf.read_rows(first / "small" / (family + ".jsonl")))
            from itertools import islice
            large = list(islice(hf.read_rows(second / "large" / (family + ".jsonl")), len(small)))
            self.assertEqual(small, large)

    def test_fresh_process_verifies_and_rejects_changed_active_body(self):
        path, _ = self.build()
        script = Path(hf.__file__).resolve()
        command = [sys.executable, "-I", "-B", str(script), "verify", "--output", str(path)]
        good = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(good.returncode, 0, good.stderr)
        changed = json.loads((path / "base.json").read_text())
        changed["nodes"]["boss"]["charter"] = "corrupted active input"
        (path / "base.json").write_text(hf.compact(changed))
        bad = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("active base changed", bad.stderr)

    def test_history_state_mutation_is_rejected_even_with_rehashed_stream(self):
        path, manifest = self.build()
        file = path / "large/retired_agents.jsonl"
        lines = file.read_text().splitlines()
        row = json.loads(lines[0]); row["state"] = "live"
        lines[0] = hf.compact(row)
        file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        manifest["arms"]["large"]["retired_agents"].update(bytes=file.stat().st_size, sha256=hf.sha_file(file))
        (path / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "invalid large retired_agents"):
            hf.verify_pair(path)

    def test_short_history_and_changed_current_tail_fail(self):
        path, _ = self.build()
        file = path / "large/read_mail.jsonl"
        file.write_bytes(file.read_bytes().split(b"\n", 1)[1])
        with self.assertRaises(ValueError):
            hf.verify_pair(path)
        tail = self.root / "tail"
        tail.write_text("original")
        second = self.root / "with-tail"
        hf.build_pair(self.base, second, SMALL, {"tail": tail})
        (second / "current-files/tail").write_text("changed")
        with self.assertRaisesRegex(ValueError, "tail changed"):
            hf.verify_pair(second)

    def test_partial_build_cannot_be_reused_or_verified(self):
        path = self.root / "interrupted"
        def stop(): raise RuntimeError("guard stop")
        with self.assertRaisesRegex(RuntimeError, "guard stop"):
            hf.build_pair(self.base, path, SMALL, guard=stop)
        self.assertTrue((path / "PREPARING").exists())
        self.assertFalse((path / "COMPLETE").exists())
        with self.assertRaisesRegex(ValueError, "never overwrite"):
            hf.build_pair(self.base, path, SMALL)

    def test_rejects_unsafe_paths_live_history_and_invalid_recipe(self):
        for bad in ("../escape", "/absolute", "C:/outside", "a\\b", None, "a/./b", "a//b"):
            with self.subTest(path=bad), self.assertRaises(ValueError):
                hf.safe_relative(bad)
        bad = active(); bad["nodes"]["boss"]["state"] = "archived"
        with self.assertRaises(ValueError): hf.prepare_base(bad)
        for updates in (dict(multiplier=9), dict(read_mail=True), dict(old_transcripts=3)):
            with self.subTest(recipe=updates), self.assertRaises(ValueError):
                hf.Recipe(**(hf.asdict(SMALL) | updates)).validate()

    def test_inventory_and_disk_preflight_fail_closed(self):
        from unittest.mock import patch
        path, _ = self.build()
        (path / "not-declared").write_text("unaccounted transcript")
        with self.assertRaisesRegex(ValueError, "undeclared"):
            hf.verify_pair(path)
        from collections import namedtuple
        Disk = namedtuple("Disk", "total used free")
        with patch.object(hf.shutil, "disk_usage", return_value=Disk(1000, 999, 1)):
            with self.assertRaisesRegex(ValueError, "disk reserve"):
                self.build("no-disk")
        self.assertFalse((self.root / "no-disk/COMPLETE").exists())

    def test_profile_repeats_independent_of_active_count_and_estimate_covers_small_pair(self):
        recipe = hf.Recipe()
        for family in hf.FAMILIES:
            sizes = [hf.payload_size(family, i, recipe) for i in range(100)]
            self.assertEqual(sizes, [hf.payload_size(family, i + 100, recipe) for i in range(100)])
            if family != "old_transcripts":
                self.assertGreater(max(sizes), min(sizes) * 10)
        path, manifest = self.build()
        measured = sum(x["bytes"] for arm in manifest["arms"].values() for x in arm.values())
        self.assertLess(measured, manifest["planning"]["suggested_free_disk_bytes"])


if __name__ == "__main__":
    unittest.main()
