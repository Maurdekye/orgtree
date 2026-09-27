"""Small actual-PG history restore, ordinal and indexed-state controls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
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

    def tearDown(self):
        # The test module owns this one throwaway root and creates a distinct
        # org for each case. Production never removes these receipts to retry.
        for name in ("RESTORING", "RESTORE_COMPLETE", "history-restore.json"):
            (fixture.data.parent / name).unlink(missing_ok=True)
        # Every case owns this module's throwaway HOME. Do not let another
        # case's historical files become undeclared inputs to this one.
        for path in fixture.home.rglob("*"):
            if path.is_file():
                hf.regular_file(path).unlink()

    def tiny_bundle(self, folder, name):
        root = fixture.data.parent
        base = ledger.Org.create(name, dirs=[], workspace=str(root / "data/workspaces" / ledger.slugify(name)))
        base.hire(ledger.USER, None, "haiku", 0, "boss")
        base.d["mail_log"] = {"boss": [{"id": "fixed", "body": "frozen tail", "read": True}]}
        base.d["steer_attempts"] = {"boss": {"fixed-attempt": {"result": "done"}}}
        frozen = hf.prepare_base(base.d)
        bundle = Path(folder) / "pair"
        hf.build_pair(frozen, bundle, hf.Recipe(retired_agents=1, archived_items=1, read_mail=1,
                     old_transcripts=1, payload_profile="fixed", node_chars=128,
                     item_chars=128, mail_chars=128, transcript_chars=128))
        (root / "history-destination.json").write_text(json.dumps(dict(
            format=hf.FORMAT, root=str(root.resolve()), slug=base.d["slug"],
            database_sha256=hashlib.sha256(pgstore.url().encode()).hexdigest())))
        return bundle, root, frozen

    def test_creation_mutation_cannot_become_the_verified_baseline(self):
        create = store.create_org
        with tempfile.TemporaryDirectory(prefix="history-initial-corrupt-") as folder:
            bundle, root, frozen = self.tiny_bundle(folder, "History initial corruption")
            observed = []
            def corrupt(*args, prepare, **kwargs):
                def changed(org):
                    prepare(org)
                    org.nodes["boss"]["charter"] = "changed before first persisted hash"
                    observed.append(True)
                return create(*args, prepare=changed, **kwargs)
            with patch.object(store, "create_org", corrupt):
                with self.assertRaisesRegex(ValueError, "fixed records changed from frozen base"):
                    hp.restore(bundle, "small", root)
            self.assertEqual(observed, [True])
            self.assertEqual(json.loads((bundle / "base.json").read_text(encoding="utf-8")), frozen)
            self.assertFalse((root / "RESTORE_COMPLETE").exists())
            self.assertTrue((root / "RESTORING").exists())

    def test_fresh_verifier_rejects_extra_source_and_forged_active_receipt(self):
        with tempfile.TemporaryDirectory(prefix="history-extra-source-") as folder:
            bundle, root, frozen = self.tiny_bundle(folder, "History extra source")
            receipt = hp.restore(bundle, "small", root)
            extra = root / "home/.claude/projects/undeclared/extra-session.jsonl"
            extra.parent.mkdir(parents=True)
            extra.write_text('{"type":"assistant","message":{"content":"extra"}}\n')
            args = [sys.executable, "-I", "-B", hp.__file__, "verify", "--bundle", str(bundle),
                    "--root", str(root), "--arm", "small", "--result", str(root / "extra-verifier.json")]
            child = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(child.returncode, 0, child.stdout)
            self.assertIn("undeclared files", child.stderr)
            self.assertFalse((root / "extra-verifier.json").exists())
            extra.unlink()
            self.assertTrue(hp.verify_restored(bundle, "small", root, require_complete=True)["verified"])
            # Forging the writer's receipt cannot bless a changed active row.
            with store._POOL.acquire(frozen["slug"]) as conn:
                conn.use()
                value = dict(frozen["nodes"]["boss"], charter="corrupt plus forged receipt")
                conn.raw.execute("UPDATE nodes SET val=%s WHERE id='boss'", (store._dumps(value),))
                conn.raw.commit()
                conn.raw.execute("BEGIN")
                receipt["fixed_source"] = hp.source_hash(conn.raw)
                conn.raw.rollback()
            (root / "history-restore.json").write_text(json.dumps(receipt))
            (root / "RESTORE_COMPLETE").write_text(hf.sha_file(root / "history-restore.json"))
            child = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(child.returncode, 0, child.stdout)
            self.assertIn("fixed records changed from frozen base", child.stderr)
            self.assertFalse((root / "extra-verifier.json").exists())

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
        # A controller exports a persisted, reconciled source. This in-memory
        # fixture must settle the normal save-derived fields BEFORE freezing.
        from orgtree.notification_state import reconcile_attention
        reconcile_attention(base.d)
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
            self.assertTrue(child_receipt["provenance"]["import_provenance"])
            self.assertEqual(Path(child_receipt["provenance"]["repo"]).resolve(), Path(__file__).resolve().parents[1])
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
            with self.assertRaisesRegex(ValueError, "restore attempt"):
                hp.restore(bundle, "large", root)
            # This test module shares a throwaway home across two separate orgs.
            # Remove only our failed-attempt marker before the other test.
            (root / "RESTORING").unlink()

    def test_small_profile_bundle_size_and_restore_measurement(self):
        root = fixture.data.parent
        base = ledger.Org.create("History measurement", dirs=[], workspace=str(root / "data/workspaces/history-measurement"))
        base.hire(ledger.USER, None, "haiku", 0, "boss")
        base.hire(ledger.USER, "boss", "haiku", 0, "worker")
        frozen = hf.prepare_base(base.d)
        recipe = hf.Recipe(retired_agents=10, archived_items=20, read_mail=100, old_transcripts=10)
        with tempfile.TemporaryDirectory(prefix="history-small-measure-") as folder:
            bundle = Path(folder) / "pair"
            start = time.perf_counter()
            manifest = hf.build_pair(frozen, bundle, recipe)
            build_and_verify = time.perf_counter() - start
            (root / "history-destination.json").write_text(json.dumps(dict(
                format=hf.FORMAT, root=str(root.resolve()), slug=base.d["slug"],
                database_sha256=hashlib.sha256(pgstore.url().encode()).hexdigest())))
            receipt = hp.restore(bundle, "large", root)
            self.assertTrue(hp.verify_restored(bundle, "large", root, require_complete=True)["verified"])
            # Source records also pass the normal transcript record ingester.
            from orgtree import transcript_records
            transcript = next(iter(receipt["files"]))
            transcript_path = root / "home" / transcript
            stats = {"bytes_read": 0}
            transcript_records.ingest("history-fixture-test", str(transcript_path), 8, stats)
            captured, more = transcript_records.tail("history-fixture-test", 8)
            self.assertEqual(len(captured), 2)
            self.assertFalse(more)
            self.assertEqual(json.loads(captured[-1][2])["message"]["role"], "assistant")
            report = dict(source_commit=os.environ.get("ORGTREE_HISTORY_CANDIDATE"),
                          measured_live_nodes=2, recipe=hf.asdict(recipe),
                          manifest=manifest, build_including_verify_seconds=build_and_verify,
                          restore=receipt, full_history_estimate=hf.estimate(frozen),
                          limits="small serial preparation only; full estimate excludes the future N1000 active base and its current files")
            out = os.environ.get("ORGTREE_HISTORY_REPORT")
            if out:
                Path(out).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
