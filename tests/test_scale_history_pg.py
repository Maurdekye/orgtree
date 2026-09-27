"""Small actual-PG history restore, ordinal and indexed-state controls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test_pgstore as fixture
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "scale"))
import history_fixture as hf
import history_pg as hp
from orgtree import foreground_store, ledger, pgstore, store, workread


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, "disposable PG required: NOT RUN")
class HistoryStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_restore_and_independent_source_validation_with_analyzed_indexes(self):
        root = fixture.data.parent
        slug = "history-storage"
        # The one intended run-root is fixed before source creation. Paired
        # engines restore into it sequentially, never rewrite active path text.
        base = ledger.Org.create("History storage", dirs=[], workspace=str(root / "data/workspaces" / slug))
        base.hire(ledger.USER, None, "haiku", 0, "boss")
        base.d["mail_log"] = {"boss": [dict(id="recent", at="2026-09-27", body="read tail", read=True)]}
        base.d["mail"] = {"boss": [dict(id="unread", body="fixed pending") ]}
        base.work_create("boss", title="Active work", objective="Keep this body unchanged", owner="boss")
        frozen = hf.prepare_base(base.d)
        recipe = hf.Recipe(retired_agents=2, archived_items=2, read_mail=2, old_transcripts=2,
                           payload_profile="fixed",
                           node_chars=128, item_chars=128, mail_chars=128, transcript_chars=128)
        with tempfile.TemporaryDirectory(prefix="history-pg-bundle-") as folder:
            bundle = Path(folder) / "pair"
            hf.build_pair(frozen, bundle, recipe)
            # fixture.py already owns this temporary data/home tree and DB.
            (root / "history-destination.json").write_text(json.dumps(dict(
                format=hf.FORMAT, root=str(root.resolve()), slug=slug,
                database_sha256=hashlib.sha256(pgstore.url().encode()).hexdigest())))
            receipt = hp.restore(bundle, "large", root)
            self.assertTrue(hp.verify_restored(bundle, "large", root, require_complete=True)["verified"])
            child_result = root / "fresh-verifier.json"
            child = subprocess.run([sys.executable, "-I", "-B", hp.__file__, "verify", "--bundle", str(bundle),
                                    "--root", str(root), "--arm", "large", "--result", str(child_result)],
                                   capture_output=True, text=True, timeout=30)
            self.assertEqual(child.returncode, 0, child.stderr)
            child_receipt = json.loads(child_result.read_text())
            self.assertTrue(child_receipt["verified"])
            self.assertTrue(child_receipt["import_provenance"])
            self.assertEqual(receipt["statistics"]["statistics_state"], "analyzed_after_seed")
            self.assertIn(receipt["cold_statistics"]["statistics_state"],
                          ("fresh_unanalyzed", "seeded_before_explicit_analyze"))
            self.assertTrue(receipt["statistics"]["tables"])
            self.assertTrue(all(x[1] >= 0 for x in receipt["statistics"]["estimates"]))
            self.assertEqual(set(foreground_store.read_foreground(slug)["rows"]), {"boss"})
            loaded = store.load_org(slug)
            self.assertEqual(loaded.nodes["boss"], frozen["nodes"]["boss"])
            self.assertEqual(loaded.d["mail"]["boss"], frozen["mail"]["boss"])
            self.assertEqual(loaded.d["mail_log"]["boss"][-1]["id"], "recent")
            self.assertEqual(loaded.mail_seq_state("boss")["base"], hf.MAIL_FLOOR)
            missing = next(iter(receipt["files"]))
            original = (root / "history-restore.json").read_bytes()
            altered = copy.deepcopy(receipt)
            altered["files"].pop(missing)
            (root / "history-restore.json").write_text(json.dumps(altered))
            with self.assertRaisesRegex(ValueError, "file inventory"):
                hp.verify_restored(bundle, "large", root)
            (root / "history-restore.json").write_bytes(original)
            with store._POOL.acquire(slug) as conn:
                conn.use()
                oid = conn.raw.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (slug,)).fetchone()[0]
                self.assertTrue(workread.reconcile(conn.raw, oid))
                self.assertEqual(workread.counts_raw(conn.raw, oid, viewer=ledger.USER, now_ts=1800000000)["active"], 1)
                value = json.loads(conn.raw.execute("SELECT val FROM nodes WHERE id='boss'").fetchone()[0])
                value["charter"] = "intentional corruption"
                conn.raw.execute("UPDATE nodes SET val=%s WHERE id='boss'", (store._dumps(value),))
                conn.raw.commit()
            with self.assertRaisesRegex(ValueError, "fixed records changed"):
                hp.verify_restored(bundle, "large", root)

    def test_interrupted_history_copy_rolls_back_and_has_no_completion(self):
        root = fixture.data.parent
        base = ledger.Org.create("History interrupted", dirs=[], workspace=str(root / "data/workspaces/history-interrupted"))
        base.hire(ledger.USER, None, "haiku", 0, "boss")
        frozen = hf.prepare_base(base.d)
        recipe = hf.Recipe(retired_agents=2, archived_items=2, read_mail=2, old_transcripts=2,
                           payload_profile="fixed", node_chars=128, item_chars=128, mail_chars=128, transcript_chars=128)
        with tempfile.TemporaryDirectory(prefix="history-rollback-") as folder:
            bundle = Path(folder) / "pair"
            hf.build_pair(frozen, bundle, recipe)
            (root / "history-destination.json").write_text(json.dumps(dict(
                format=hf.FORMAT, root=str(root.resolve()), slug=base.d["slug"],
                database_sha256=hashlib.sha256(pgstore.url().encode()).hexdigest())))
            calls = 0
            def stop():
                nonlocal calls
                calls += 1
                if calls == 3:  # start, node COPY, then archived-item COPY
                    raise RuntimeError("injected copy interruption")
            # Receipt names are root-scoped; use this test before the successful
            # restore and never regard a partial transaction as a complete arm.
            with self.assertRaisesRegex(RuntimeError, "injected copy"):
                hp.restore(bundle, "large", root, guard=stop)
            self.assertFalse((root / "RESTORE_COMPLETE").exists())
            with store._POOL.acquire(base.d["slug"]) as conn:
                conn.use()
                self.assertEqual(conn.raw.execute("SELECT count(*) FROM nodes WHERE id LIKE 'hist-%'").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
