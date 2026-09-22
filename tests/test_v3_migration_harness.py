"""Synthetic migration conservation, negative controls, and real child exits.

Run: python -m unittest discover -s tests -p test_v3_migration_harness.py -v
These tests never import or start the Orgtree backend.
"""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from tools.migration_harness.fixtures import create_fixture, document
from tools.migration_harness.formats import LEDGER_DDL, SIDECAR_DDL
from tools.migration_harness.harness import EnvelopeAdapter, Rehearsal, exclusive
from tools.migration_harness.legacy import Refused, decode, encode, manifest, plain_tree, read_source

REPO = Path(__file__).resolve().parents[1]
IMPORT_STOPS = ("planned", "backup-file", "backed-up", "prepared", "staged", "published", "complete")


class Interrupted(RuntimeError):
    pass


def stop_at(event):
    def checkpoint(actual):
        if actual == event:
            raise Interrupted(event)
    return checkpoint


class MigrationHarnessTests(unittest.TestCase):
    def fixture(self, scenario="ordinary"):
        directory = tempfile.TemporaryDirectory(prefix="orgtree-migration-test-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        create_fixture(root, scenario)
        return root

    def edit_doc(self, root, mutate):
        path = root / "source/orgs/alpha.json"
        doc = decode(path.read_bytes())
        mutate(doc)
        path.write_bytes(encode(doc))

    def test_scenarios_round_trip_exact_bytes_and_readable_records(self):
        for scenario in ("ordinary", "sqlite", "partial", "large"):
            with self.subTest(scenario=scenario):
                root = self.fixture(scenario)
                original = plain_tree(root / "source")
                logical = read_source(root / "source")
                harness = Rehearsal(root)
                receipt = harness.migrate()
                receipt_bytes = (root / "receipt.json").read_bytes()
                target = plain_tree(root / "target")
                self.assertEqual(harness.migrate(), receipt)
                self.assertEqual((root / "receipt.json").read_bytes(), receipt_bytes)
                self.assertEqual(plain_tree(root / "target"), target)
                self.assertEqual(EnvelopeAdapter().read(root / "target"), logical)
                self.assertEqual(receipt["plan"]["source_manifest"], manifest(original))
                self.assertFalse(receipt["plan"]["activation_allowed"])
                self.assertEqual(receipt["plan"]["mapping_status"], "preserved_unmapped")
                rolled = harness.rollback()
                self.assertEqual(harness.rollback(), rolled)
                self.assertEqual(plain_tree(root / "restored"), original)
                self.assertEqual(read_source(root / "restored"), logical)
                self.assertEqual(plain_tree(root / "source"), original)
                with self.assertRaisesRegex(Refused, "already restored"):
                    harness.migrate()

    def test_sqlite_reader_matches_the_original_prewrite_document(self):
        root = self.fixture("sqlite")
        expected = document("alpha")
        logical = read_source(root / "source")
        self.assertEqual(logical["orgs"]["alpha"]["document"], expected)
        self.assertEqual(logical["orgs"]["alpha"]["key_order"], list(expected))
        self.assertEqual(logical["orgs"]["alpha"]["node_order"], list(expected["nodes"]))
        sidecars = logical["sidecars"]
        pending = sidecars["file-deliveries.db"]["deliveries"]["rows"][0]
        self.assertIsNone(pending[2])
        results = [decode(row[1]) for row in sidecars["tool-waits.db"]["operations"]["rows"]]
        self.assertEqual({row["state"] for row in results}, {"running", "completed"})
        self.assertTrue(all(row["published"] is False for row in results))
        self.assertEqual(sidecars["reply-events.sqlite3"]["events"]["rows"][0],
                         ["alpha", "agent-1", 0, "original-reply-id", "Immutable invented quote", "original-reply-scope"])

    def test_inventory_is_anchored_to_known_fixture_cardinality(self):
        root = self.fixture("large")
        count = read_source(root / "source")["inventory"]
        self.assertEqual(count["organizations"], 2)
        self.assertEqual(count["agents"], 1000)
        self.assertEqual(count["mail"], 6)
        self.assertEqual(count["docket"], 4)
        self.assertEqual(count["docket_history"], 8)
        self.assertEqual(count["transcript_jsonl_records"], 1000)
        self.assertEqual(count["transcript_records"], 1)
        self.assertEqual(count["sidecar_rows"]["tool-waits.db"], {"operations": 2, "dead_letters": 1})
        self.assertEqual(len(count["sidecar_rows"]["transcript-records.sqlite3"]), 15)
        self.assertTrue(all(n == 1 for n in count["sidecar_rows"]["transcript-records.sqlite3"].values()))

    def test_partial_upgrade_preserves_old_identity_and_eager_logs(self):
        root = self.fixture("partial")
        bundle = read_source(root / "source")
        self.assertEqual(len(bundle["legacy_backups"]), 1)
        for entry in bundle["orgs"].values():
            doc = entry["document"]
            self.assertNotIn("seat_id", doc["nodes"]["agent-0"])
            self.assertEqual(doc["work_items"][0]["id"], "w00000001")
            self.assertNotIn("slug", doc["work_items"][0])
            self.assertEqual(doc["steer_attempts"]["agent-1"], {"original-attempt-key": {"resolved": False}})
            self.assertEqual(doc["mail_log"]["agent-0"], [])

    def test_exception_interruption_at_every_import_boundary_retries_or_restores(self):
        for stop in IMPORT_STOPS:
            for resume in ("migrate", "rollback"):
                with self.subTest(stop=stop, resume=resume):
                    root = self.fixture("sqlite")
                    original = plain_tree(root / "source")
                    with self.assertRaises(Interrupted):
                        Rehearsal(root, checkpoint=stop_at(stop)).migrate()
                    self.assertEqual(plain_tree(root / "source"), original)
                    harness = Rehearsal(root)
                    if resume == "migrate":
                        harness.migrate()
                    harness.rollback()
                    self.assertEqual(plain_tree(root / "restored"), original)

    def child_exit(self, root, event, action):
        script = """
import os, sys
from pathlib import Path
from tools.migration_harness.harness import Rehearsal
root, event, action = sys.argv[1:]
def checkpoint(actual):
    if actual == event:
        os._exit(73)
getattr(Rehearsal(Path(root), checkpoint=checkpoint), action)()
raise SystemExit(74)
"""
        run = subprocess.run([sys.executable, "-c", script, str(root), event, action],
                             cwd=REPO, capture_output=True, timeout=30)
        self.assertEqual(run.returncode, 73, run.stderr.decode(errors="replace"))

    def test_real_process_exit_at_every_import_boundary(self):
        for stop in IMPORT_STOPS:
            with self.subTest(stop=stop):
                root = self.fixture("partial")
                original = plain_tree(root / "source")
                self.child_exit(root, stop, "migrate")
                harness = Rehearsal(root)
                receipt = harness.migrate()
                self.assertEqual(harness.migrate(), receipt)
                harness.rollback()
                self.assertEqual(plain_tree(root / "source"), original)
                self.assertEqual(plain_tree(root / "restored"), original)

    def test_real_process_exit_during_rollback(self):
        for stop in ("restore-file", "restored"):
            with self.subTest(stop=stop):
                root = self.fixture()
                original = plain_tree(root / "source")
                Rehearsal(root).migrate()
                self.child_exit(root, stop, "rollback")
                Rehearsal(root).rollback()
                self.assertEqual(plain_tree(root / "restored"), original)

    def test_backup_recovers_when_original_source_is_missing(self):
        root = self.fixture()
        original = plain_tree(root / "source")
        harness = Rehearsal(root)
        harness.migrate()
        # This directory was created exclusively by fixture(); never a live path.
        source = root / "source"
        self.assertEqual(source.resolve().parent, root.resolve())
        shutil.rmtree(source)
        harness.rollback()
        self.assertEqual(plain_tree(root / "restored"), original)
        self.assertFalse(source.exists())

    def test_retry_refuses_changed_source_key_or_adapter(self):
        for mutation in ("source", "key", "adapter"):
            with self.subTest(mutation=mutation):
                root = self.fixture()
                harness = Rehearsal(root)
                harness.migrate()
                before = (root / "receipt.json").read_bytes()
                if mutation == "source":
                    self.edit_doc(root, lambda d: d.update(name="changed"))
                if mutation == "adapter":
                    class Changed(EnvelopeAdapter):
                        version = 2
                    harness = Rehearsal(root, Changed())
                with self.assertRaises(Refused):
                    harness.migrate("different-key" if mutation == "key" else "synthetic-import-1")
                self.assertEqual((root / "receipt.json").read_bytes(), before)

    def test_corrupt_backup_target_receipt_and_plan_fail_closed(self):
        for target in ("backup/app-settings.json", "target/envelope.json", "receipt.json", "plan.json"):
            with self.subTest(target=target):
                root = self.fixture()
                harness = Rehearsal(root)
                harness.migrate()
                original = plain_tree(root / "source")
                (root / target).write_bytes(b"corrupt")
                with self.assertRaises(Refused):
                    harness.migrate()
                with self.assertRaises(Refused):
                    harness.rollback()
                self.assertEqual(plain_tree(root / "source"), original)

    def test_missing_verified_backup_is_not_silently_recreated(self):
        root = self.fixture()
        harness = Rehearsal(root)
        harness.migrate()
        (root / "backup/app-settings.json").unlink()
        with self.assertRaisesRegex(Refused, "backup missing or changed"):
            harness.migrate()
        with self.assertRaisesRegex(Refused, "backup missing or changed"):
            harness.rollback()

    def test_acknowledged_post_import_state_refuses_old_backup_rollback(self):
        root = self.fixture()
        harness = Rehearsal(root)
        harness.migrate()
        with self.assertRaisesRegex(Refused, "current acknowledged"):
            harness.rollback(acknowledged_writes=True)
        (root / "acknowledged-writes.json").write_bytes(b"{}")
        with self.assertRaisesRegex(Refused, "current acknowledged"):
            harness.rollback()
        self.assertFalse((root / "restored").exists())

    def test_changed_candidate_cannot_be_rolled_back_as_no_loss(self):
        root = self.fixture()
        harness = Rehearsal(root)
        harness.migrate()
        path = root / "target/envelope.json"
        value = decode(path.read_bytes())
        value["bundle"]["orgs"]["alpha"]["document"]["events"].append({"acknowledged": True})
        path.write_bytes(encode(value))
        with self.assertRaises(Refused):
            harness.rollback()
        self.assertFalse((root / "restored").exists())

    def test_lossy_adapters_fail_even_when_counts_match(self):
        mutations = {
            "node_identity": lambda b: b["orgs"]["alpha"]["document"]["nodes"]["agent-1"].update(seat_id="new-seat"),
            "mail_key": lambda b: b["orgs"]["alpha"]["document"]["mail"]["agent-1"][0].update(id="new-key"),
            "scope_history": lambda b: b["orgs"]["alpha"]["document"]["work_items"][0]["scope"].clear(),
            "transcript_receipt": lambda b: b["sidecars"]["transcript-records.sqlite3"]["assistant_receipts"]["rows"].clear(),
            "opaque_file_receipt": lambda b: b["sidecars"]["file-deliveries.db"]["deliveries"]["rows"][0].__setitem__(0, "regenerated"),
            "content_bytes": lambda b: b["files"].__setitem__("content/alpha/agent-1/attachment.bin", "bG9zcw=="),
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                root = self.fixture()
                original = plain_tree(root / "source")
                class Lossy(EnvelopeAdapter):
                    def build(self, bundle, staging):
                        mutate(bundle)
                        super().build(bundle, staging)
                with self.assertRaisesRegex(Refused, "lost/changed"):
                    Rehearsal(root, Lossy()).migrate()
                self.assertFalse((root / "target").exists())
                self.assertEqual(decode((root / "receipt.json").read_bytes())["state"], "prepared")
                self.assertEqual(plain_tree(root / "source"), original)

    def test_dynamic_fields_preserved_but_never_qualify_activation(self):
        root = self.fixture()
        extension = {"future": [{"opaque": [None, 0, False, ""]}]}
        self.edit_doc(root, lambda d: d.update(synthetic_unknown_extension=extension))
        receipt = Rehearsal(root).migrate()
        doc = EnvelopeAdapter().read(root / "target")["orgs"]["alpha"]["document"]
        self.assertEqual(doc["synthetic_unknown_extension"], extension)
        self.assertFalse(receipt["plan"]["activation_allowed"])
        self.assertEqual(receipt["plan"]["mapping_status"], "preserved_unmapped")

    def test_malformed_records_fail_before_backup(self):
        mutations = {
            "missing_nodes": lambda d: d.pop("nodes"),
            "bad_node": lambda d: d["nodes"].update({"agent-0": 1}),
            "parent_missing": lambda d: d["nodes"]["agent-1"].update(parent="missing"),
            "parent_cycle": lambda d: d["nodes"]["agent-0"].update(parent="agent-1"),
            "orphan_mail": lambda d: d["mail"].update(missing=[]),
            "duplicate_item": lambda d: d["work_items_archive"].append(d["work_items"][0]),
            "unsupported_version": lambda d: d.update(version=99),
        }
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                root = self.fixture()
                self.edit_doc(root, mutate)
                with self.assertRaises(Refused):
                    Rehearsal(root).migrate()
                self.assertFalse((root / "plan.json").exists())
                self.assertFalse((root / "backup").exists())

    def test_bad_json_is_not_accepted_or_normalized(self):
        for body in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}', b'\xff', b'{"nodes":'):
            with self.subTest(body=body):
                root = self.fixture()
                (root / "source/orgs/alpha.json").write_bytes(body)
                with self.assertRaises(Refused):
                    Rehearsal(root).migrate()
                self.assertFalse((root / "backup").exists())

    def test_unknown_and_unclosed_source_files_refuse(self):
        for name in ("unclassified.bin", "orgs/alpha.db-wal", "transcript-records.sqlite3-wal"):
            with self.subTest(name=name):
                root = self.fixture()
                (root / "source" / name).write_bytes(b"must not drop")
                with self.assertRaises(Refused):
                    Rehearsal(root).migrate()
                self.assertFalse((root / "backup").exists())
        root = self.fixture()
        (root / "source/transcripts/alpha/agent-1/session.jsonl").write_bytes(b'{"partial":')
        with self.assertRaisesRegex(Refused, "incomplete transcript"):
            Rehearsal(root).migrate()

    def test_sqlite_missing_rows_metadata_unknown_tables_and_ambiguity_refuse(self):
        changes = [
            "UPDATE meta SET val='99' WHERE key='schema_version'",
            "DELETE FROM meta WHERE key='key_order'",
            "DELETE FROM meta WHERE key='owners:mail_log'",
            "CREATE TABLE unclassified (body TEXT)",
            "UPDATE log_d SET owner='missing' WHERE sect='mail_log'",
            "UPDATE log_l SET sect='future' WHERE sect='events'",
            "INSERT INTO doc VALUES ('events','[]')",
            "UPDATE nodes SET ord=0",
        ]
        for sql in changes:
            with self.subTest(sql=sql):
                root = self.fixture("sqlite")
                with sqlite3.connect(root / "source/orgs/alpha.db") as conn:
                    conn.execute(sql)
                with self.assertRaises(Refused):
                    Rehearsal(root).migrate()
                self.assertFalse((root / "backup").exists())
        root = self.fixture()
        with sqlite3.connect(root / "source/tool-waits.db") as conn:
            conn.execute("CREATE TABLE future_state (body TEXT)")
        with self.assertRaisesRegex(Refused, "unsupported sidecar"):
            Rehearsal(root).migrate()

    def test_duplicate_org_representations_refuse(self):
        root = self.fixture("sqlite")
        (root / "source/orgs/alpha.json").write_bytes(encode(document("alpha")))
        with self.assertRaisesRegex(Refused, "duplicate org"):
            Rehearsal(root).migrate()

    def test_backup_source_race_is_detected(self):
        root = self.fixture()
        fired = False
        def checkpoint(event):
            nonlocal fired
            if event == "backup-file" and not fired:
                fired = True
                self.edit_doc(root, lambda d: d.update(name="changed after preflight"))
        with self.assertRaisesRegex(Refused, "changed while backing up"):
            Rehearsal(root, checkpoint=checkpoint).migrate()
        self.assertFalse((root / "target").exists())
        self.assertFalse((root / "receipt.json").exists())

    def test_partial_atomic_backup_file_is_recovered(self):
        root = self.fixture()
        with self.assertRaises(Interrupted):
            Rehearsal(root, checkpoint=stop_at("planned")).migrate()
        (root / "backup").mkdir()
        (root / "backup/app-settings.json.part").write_bytes(b"half")
        Rehearsal(root).migrate()
        self.assertEqual(plain_tree(root / "backup"), plain_tree(root / "source"))

    def test_single_writer_lock_refuses_overlap(self):
        root = self.fixture()
        harness = Rehearsal(root)
        with exclusive(root):
            with self.assertRaisesRegex(Refused, "already running"):
                harness.migrate()
        self.assertFalse((root / "plan.json").exists())
        harness.migrate()

    def test_hardlinked_payload_is_refused(self):
        root = self.fixture()
        original = root / "source/app-settings.json"
        os.link(original, root / "source/hardlink.json")
        with self.assertRaisesRegex(Refused, "nonordinary"):
            Rehearsal(root)

    def test_symlink_payload_is_refused_when_platform_allows_it(self):
        root = self.fixture()
        try:
            (root / "source/link").symlink_to(root / "source/app-settings.json")
        except OSError as exc:
            self.skipTest(f"symlink creation unavailable: {exc.winerror if os.name == 'nt' else exc.errno}")
        with self.assertRaisesRegex(Refused, "linked"):
            Rehearsal(root)

    def test_reparse_attribute_refuses_junction_without_following_it(self):
        root = self.fixture()
        original = Path.lstat
        def marked(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if path == root / "source":
                return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=0x400)
            return value
        with patch.object(Path, "lstat", marked):
            with self.assertRaisesRegex(Refused, "linked"):
                Rehearsal(root)

    def test_unmarked_root_has_no_writes(self):
        root = self.fixture()
        (root / "synthetic.json").unlink()
        before = plain_tree(root)
        with self.assertRaisesRegex(Refused, "synthetic fixture"):
            Rehearsal(root)
        self.assertEqual(plain_tree(root), before)

    def test_cli_structured_report_and_no_live_backend_import(self):
        for scenario, expected in (("ordinary", 0), ("interrupted", 0), ("malformed", 1)):
            with self.subTest(scenario=scenario):
                env = dict(os.environ, ORGTREE_DATA="intentionally-not-a-fixture")
                run = subprocess.run([sys.executable, "-m", "tools.migration_harness", "--scenario", scenario],
                                     cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(run.returncode, expected, run.stderr)
                report = json.loads(run.stdout)
                self.assertEqual(report["version"], 1)
                self.assertTrue(report["synthetic"])
                self.assertFalse(report["activation_allowed"])
                self.assertIn("native_schema_import", report["not_exercised"])
                if expected == 0:
                    self.assertEqual(report["receipt"]["state"], "complete")
                    self.assertEqual(report["rollback_receipt"]["state"], "restored")
                if scenario == "interrupted":
                    self.assertEqual(report["fault"], "python_exception_after_publish")
        self.assertFalse(any(name.startswith("engine.backend.orgtree") for name in sys.modules))

    def test_frozen_legacy_ddl_matches_source_without_importing_backend(self):
        base = REPO / "engine/backend/orgtree"
        tree = ast.parse((base / "store.py").read_text(encoding="utf-8"))
        ddl = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "_DDL" for t in n.targets))
        self.assertEqual(ddl, LEDGER_DDL)
        for filename, db in (("transcript_records.py", "transcript-records.sqlite3"),
                             ("reply_events.py", "reply-events.sqlite3"),
                             ("filedelivery.py", "file-deliveries.db"), ("toolwait.py", "tool-waits.db")):
            tree = ast.parse((base / filename).read_text(encoding="utf-8"))
            ddl = [n.value.strip().rstrip(";") + ";" for n in ast.walk(tree)
                   if isinstance(n, ast.Constant) and isinstance(n.value, str)
                   and n.value.lstrip().startswith("CREATE TABLE")]
            self.assertEqual("\n".join(ddl), SIDECAR_DDL[db])


if __name__ == "__main__":
    unittest.main()
