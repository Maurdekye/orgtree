"""Native rewind publication against synthetic profiles only; retain fixtures."""
import json
from pathlib import Path
import uuid
from unittest.mock import patch
import os

from tests import test_desktop_import as fixtures
from engine.backend.orgtree import desktop_import as imp, desktop_native as native, supervisor


class NativeRewindTests(fixtures.DesktopImportTests):
    def setUp(self):
        super().setUp()
        self.profile = self.root / "destination-profile"
        self.profile.mkdir()
        self.environment = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.profile)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.overrides = patch.object(supervisor, "env_overrides", return_value={})
        self.overrides.start(); self.addCleanup(self.overrides.stop)

    def rewind_fixture(self, same_profile=False, deleted=False):
        doc, oldpath, _ = self.native_fixture()
        source_profile = self.profile if same_profile else self.root / "source-profile"
        path = source_profile / "projects/project" / oldpath.name
        path.parent.mkdir(parents=True)
        rows = [json.loads(line) for line in oldpath.read_text().splitlines()]
        tracked = {}
        for index in range(2):
            name = None if deleted else f"{index:016x}@v1"
            tracked[str(self.source / f"scratch/acme/worker/file{index}.txt")] = {
                "backupFileName": name, "version": 1, "backupTime": "2026-09-07T20:00:00Z",
                "realParentDir": str(self.source / "scratch/acme/worker")}
            if name:
                backup = source_profile / "file-history" / oldpath.stem / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                backup.write_bytes(f"original native rewind bytes {index}".encode())
        rows.append({"type": "file-history-snapshot", "messageId": rows[0]["uuid"],
                     "snapshot": {"messageId": rows[0]["uuid"], "trackedFileBackups": tracked,
                                  "timestamp": "2026-09-07T20:00:00Z"}, "isSnapshotUpdate": False})
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        (source_profile / "settings.json").write_bytes(b'{"synthetic":"existing settings"}')
        (source_profile / "auth.json").write_bytes(b'{"synthetic":"never copy this sentinel"}')
        return doc, path, {"claude_profile": str(source_profile)}, source_profile

    def run_native(self, sources):
        return imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                               on_imported=self.resumed.append, native_sources=sources)

    def test_same_profile_adds_only_new_sid_preserving_every_existing_byte(self):
        doc, path, sources, profile = self.rewind_fixture(same_profile=True)
        existing = fixtures.fingerprint(profile)
        original_root = fixtures.fingerprint(self.source)
        self.run_native(sources)
        copied = self.read(); node = copied["nodes"]["worker"]
        sid = node["session_id"]
        rewind = node["desktop_import"]["native_continuity"]["rewind"]
        self.assertNotEqual(sid, path.stem)
        self.assertEqual(rewind["profile"], str(profile))
        self.assertIsNone(native.native_hold_reason(copied, "worker"))
        for name in rewind["files"]:
            self.assertEqual((profile / "file-history" / sid / name).read_bytes(),
                             (profile / "file-history" / path.stem / name).read_bytes())
        after = fixtures.fingerprint(profile)
        self.assertTrue(all(after[key] == value for key, value in existing.items()))
        self.assertEqual(set(after) - set(existing), {str(Path("file-history") / sid / name) for name in rewind["files"]})
        self.assertEqual(fixtures.fingerprint(self.source), original_root)
        clone = Path(native.native_session_path(copied, "worker"))
        tracked = json.loads(clone.read_text().splitlines()[-1])["snapshot"]["trackedFileBackups"]
        self.assertTrue(all(Path(key).is_relative_to(self.dest) for key in tracked))
        self.assertTrue(all(Path(value["realParentDir"]).is_relative_to(self.dest) for value in tracked.values()))
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / "different-profile")}):
            self.assertIn("different destination profile", native.native_hold_reason(copied, "worker"))

    def test_destination_override_selected_without_auth_or_settings_copy(self):
        doc, path, sources, source_profile = self.rewind_fixture()
        selected = self.root / "selected-profile"
        with patch.object(supervisor, "env_overrides", return_value={"CLAUDE_CONFIG_DIR": str(selected)}), \
             patch.object(supervisor, "spawn_env", side_effect=AssertionError("auth resolver forbidden")):
            self.run_native(sources)
            copied = self.read()
            self.assertIsNone(native.native_hold_reason(copied, "worker"))
        sid = copied["nodes"]["worker"]["session_id"]
        self.assertTrue((selected / "file-history" / sid / "0000000000000000@v1").is_file())
        self.assertFalse((selected / "auth.json").exists())
        self.assertFalse((selected / "settings.json").exists())
        self.assertFalse((self.profile / "file-history").exists())

    def test_existing_destination_sid_refuses_without_overwrite(self):
        doc, path, sources, source_profile = self.rewind_fixture()
        sid = uuid.uuid4()
        target = self.profile / "file-history" / str(sid)
        target.mkdir(parents=True)
        (target / "0000000000000000@v1").write_bytes(b"existing unrelated backup")
        existing = fixtures.fingerprint(self.profile)
        with patch.object(native.uuid, "uuid4", return_value=sid):
            with self.assertRaisesRegex(imp.ImportRefused, "already exists"):
                self.run_native(sources)
        self.assertEqual(fixtures.fingerprint(self.profile), existing)
        self.assertFalse((self.dest / "orgs/acme.db").exists())

    def test_publication_failure_never_publishes_org_or_changes_old_profile_bytes(self):
        doc, path, sources, profile = self.rewind_fixture(same_profile=True)
        existing = fixtures.fingerprint(profile)
        original_root = fixtures.fingerprint(self.source)
        copy_file = imp._copy_file
        writes = []
        def fail_second(source, target):
            if target.is_relative_to(profile / "file-history"):
                writes.append(target)
                if len(writes) == 2:
                    raise OSError("synthetic destination publication failure")
            return copy_file(source, target)
        with patch.object(imp, "_copy_file", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.run_native(sources)
        self.assertEqual(len(writes), 2, "failure control actually reached native publication")
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertEqual(self.resumed, [])
        after = fixtures.fingerprint(profile)
        self.assertTrue(all(after[key] == value for key, value in existing.items()))
        self.assertTrue(writes[0].is_file(), "only the partial NEW session folder is retained")
        self.assertEqual(fixtures.fingerprint(self.source), original_root)

    def test_deleted_file_snapshot_remaps_without_creating_profile_artifacts(self):
        doc, path, sources, profile = self.rewind_fixture(deleted=True)
        self.run_native(sources)
        copied = self.read()
        clone = Path(native.native_session_path(copied, "worker"))
        tracked = json.loads(clone.read_text().splitlines()[-1])["snapshot"]["trackedFileBackups"]
        self.assertTrue(all(Path(key).is_relative_to(self.dest) for key in tracked))
        self.assertTrue(all(value["backupFileName"] is None for value in tracked.values()))
        self.assertFalse((self.profile / "file-history").exists())

    def test_source_profile_rewind_target_or_missing_backup_is_held(self):
        doc, path, sources, profile = self.rewind_fixture()
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        tracked = rows[-1]["snapshot"]["trackedFileBackups"]
        first = next(iter(tracked))
        tracked[str(profile / "settings.json")] = tracked.pop(first)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        inspection = native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)
        self.assertIn("source provider profile", inspection["reason"])
        tracked[first] = tracked.pop(str(profile / "settings.json"))
        tracked[first]["backupFileName"] = "ffffffffffffffff@v1"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        self.assertIn("missing", native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["reason"])
        self.assertFalse((self.profile / "file-history").exists())


for _name in list(fixtures.DesktopImportTests.__dict__):
    if _name.startswith("test_") and _name not in NativeRewindTests.__dict__:
        setattr(NativeRewindTests, _name, None)
