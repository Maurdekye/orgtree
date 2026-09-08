"""Claude project-memory continuity across a copy import; synthetic profiles only.

Every fixture lives below the explicit throwaway root established by
tests.test_desktop_import before any engine import. The destination Claude
profile is a temporary directory selected through CLAUDE_CONFIG_DIR, so no
live profile is read or written. No provider process starts.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from unittest.mock import patch

from tests import test_desktop_import as fixtures
from engine.backend.orgtree import desktop_import as imp, desktop_native as native, supervisor, store
from engine.backend.orgtree import desktop_native_claude_memory as memory

KEY_CONTROL = Path(__file__).resolve().parent / "fixtures" / "claude_memory_key.cjs"
# Observed on the live machine: the Claude 2.1.241 project folder for this
# working directory. Ties the port to the binary's actual placement.
LIVE_CWD = r"C:\Users\ncola_k8bx\orgtree\scratch\orgtree\feature-fable"
LIVE_KEY = "C--Users-ncola-k8bx-orgtree-scratch-orgtree-feature-fable"


class KeyPortTests(fixtures.unittest.TestCase):
    def test_live_project_folder_name_matches_port(self):
        self.assertEqual(memory.project_key(LIVE_CWD), LIVE_KEY)

    def test_port_matches_extracted_cli_function(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "node is required to run the extracted Claude key function")
        samples = [
            LIVE_CWD,
            r"C:\Users\a b\ünï\scratch",
            "/home/x/" + "y" * 300,
            r"C:\very\long\\" + "\u00e9" * 120 + "\\" + "z" * 120,
            "C:\\emoji\\\U0001F600\\" + "w" * 250,
            "",
        ]
        out = subprocess.run([node, str(KEY_CONTROL), *samples], capture_output=True,
                             text=True, encoding="utf-8", check=True).stdout.splitlines()
        self.assertEqual(len(out), len(samples))
        for sample, expected in zip(samples, out):
            self.assertEqual(memory.project_key(sample), expected, sample)
        self.assertTrue(any(len(s) > 200 for s in samples))
        self.assertNotEqual(memory.project_key(samples[2]), memory.project_key(samples[2] + "!"))

    def test_hash_wraps_like_javascript(self):
        self.assertEqual(memory._js_hash(""), 0)
        self.assertEqual(memory._js_hash("a"), 97)
        # (97 << 5) - 97 + 98 = 3105
        self.assertEqual(memory._js_hash("ab"), 3105)
        self.assertLess(memory._js_hash("x" * 40), 1 << 31)
        self.assertGreaterEqual(memory._js_hash("x" * 40), -(1 << 31))


class CheckoutRootTests(fixtures.unittest.TestCase):
    def setUp(self):
        self.root = Path(fixtures.tempfile.mkdtemp(dir=fixtures._TEST_ROOT))

    def git(self, *args, cwd):
        subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                       env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})

    def test_plain_folder_keys_on_itself_and_checkout_on_its_root(self):
        plain = self.root / "plain" / "worker"
        plain.mkdir(parents=True)
        self.assertEqual(memory.memory_root(str(plain)), str(plain))
        repo = self.root / "repo"
        (repo / "sub" / "deep").mkdir(parents=True)
        self.git("init", "-q", cwd=repo)
        self.assertEqual(memory.memory_root(str(repo / "sub" / "deep")), str(repo))

    def test_worktree_keys_on_the_main_checkout(self):
        repo = self.root / "main"
        repo.mkdir()
        self.git("init", "-q", cwd=repo)
        (repo / "f.txt").write_text("x")
        self.git("-c", "user.email=t@example", "-c", "user.name=t", "add", "f.txt", cwd=repo)
        self.git("-c", "user.email=t@example", "-c", "user.name=t", "commit", "-q", "-m", "x", cwd=repo)
        wt = self.root / "wt"
        self.git("worktree", "add", "-q", str(wt), "-b", "side", cwd=repo)
        self.assertTrue((wt / ".git").is_file())
        (wt / "nested").mkdir()
        self.assertEqual(memory.memory_root(str(wt / "nested")), str(repo))
        self.assertEqual(memory.memory_root(str(wt)), str(repo))
        # A plain gitdir file that is not a worktree pointer keys on itself.
        bogus = self.root / "bogus"
        bogus.mkdir()
        (bogus / ".git").write_text("gitdir: ../nowhere")
        self.assertEqual(memory.memory_root(str(bogus)), str(bogus))


class MemoryImportTests(fixtures.DesktopImportTests):
    def setUp(self):
        super().setUp()
        self.profile = self.root / "destination-profile"
        self.profile.mkdir()
        self.environment = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.profile)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        for key in (memory.OVERRIDE_ENV, memory.REMOTE_ENV):
            os.environ.pop(key, None)
        self.overrides = patch.object(supervisor, "env_overrides", return_value={})
        self.overrides.start(); self.addCleanup(self.overrides.stop)

    def memory_fixture(self, archived_generation=True):
        doc, path, sources = self.native_fixture()
        source_profile = Path(sources["claude_profile"])
        if archived_generation:
            old = dict(doc["nodes"]["worker"])
            sid = str(uuid.uuid4())
            old.update(session_id=sid, state="archived", archived_at="2026-09-07T19:00:00Z",
                       generation=0)
            doc["nodes"]["worker@0"] = old
            doc["nodes"]["worker"]["generation"] = 1
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            for row in rows:
                row["sessionId"] = sid
            (path.parent / f"{sid}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows),
                                                      encoding="utf-8")
            (self.source / "orgs/acme.json").write_text(json.dumps(doc), encoding="utf-8")
        key = memory.project_key(str(self.source.resolve() / "scratch/acme/worker"))
        folder = source_profile / "projects" / key / "memory"
        (folder / "logs" / "2026" / "09" / "08").mkdir(parents=True)
        (folder / "MEMORY.md").write_bytes(b"- [Patch scripts](patch.md) \xe2\x80\x94 hook\r\n")
        (folder / "patch.md").write_bytes(b"---\nname: patch\n---\nuse files\n")
        (folder / "logs" / "2026" / "09" / "08" / "abcd1234.md").write_bytes(b"log entry")
        return doc, sources, folder

    def destination(self):
        return self.profile.resolve() / "projects" / memory.project_key(
            str(self.dest.resolve() / "scratch/acme/worker")) / "memory"

    def run_native(self, sources):
        return imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                               on_imported=self.resumed.append, native_sources=sources)

    def test_memory_is_carried_under_the_destination_key_and_source_is_untouched(self):
        doc, sources, folder = self.memory_fixture()
        before_source = fixtures.fingerprint(self.source)
        before_profile = fixtures.fingerprint(Path(sources["claude_profile"]))
        target = self.destination()
        self.assertFalse(target.exists())
        result = self.run_native(sources)
        self.assertEqual(result["failed"], [])
        self.assertEqual(fixtures.fingerprint(self.source), before_source)
        self.assertEqual(fixtures.fingerprint(Path(sources["claude_profile"])), before_profile)
        self.assertEqual(fixtures.fingerprint(target), fixtures.fingerprint(folder))
        archive = self.dest / "imports/acme/memory/worker"
        self.assertEqual(fixtures.fingerprint(archive), fixtures.fingerprint(folder))
        manifest = json.loads((self.dest / "imports/acme/memory/worker.manifest.json").read_text())
        self.assertEqual(set(manifest), {"MEMORY.md", "patch.md", "logs/2026/09/08/abcd1234.md"})
        copied = self.read()
        for nid in ("worker", "worker@0"):
            meta = copied["nodes"][nid]["desktop_import"]["memory"]
            self.assertEqual(meta["status"], "ready", meta)
            self.assertEqual(Path(meta["destination"]), target)
            self.assertEqual(meta["files"], 3)
            self.assertIsNone(native.native_hold_reason(copied, nid), nid)
        self.assertFalse(any("memory" in w for w in result["imported"][0]["warnings"]))
        # Destination edits after import never reach the archive or the source.
        (target / "MEMORY.md").write_bytes(b"changed later")
        self.assertEqual(fixtures.fingerprint(archive), fixtures.fingerprint(folder))
        self.assertIsNone(native.native_hold_reason(copied, "worker"))

    def test_generations_share_the_base_spawn_cwd_of_the_engine(self):
        doc, sources, _ = self.memory_fixture()
        self.run_native(sources)
        copied = self.read()
        expected = supervisor.scratch_dir("acme", "worker@0")
        self.assertEqual(expected, supervisor.scratch_dir("acme", "worker"))
        self.assertEqual(native.spawn_cwd(self.dest.resolve(), "acme", "worker@0"), expected)
        for nid in ("worker", "worker@0"):
            node = copied["nodes"][nid]
            clone = self.dest / node["desktop_import"]["native_continuity"]["path"]
            rows = [json.loads(line) for line in clone.read_text().splitlines()]
            self.assertEqual(rows[0]["cwd"], expected, nid)
            self.assertEqual(Path(node["desktop_import"]["memory"]["destination_cwd"]), Path(expected))

    def test_absent_source_memory_is_recorded_without_a_hold(self):
        doc, path, sources = self.native_fixture()
        self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "none")
        self.assertFalse(self.destination().exists())
        self.assertIsNone(native.native_hold_reason(copied, "worker"))

    def test_different_destination_bytes_are_never_overwritten_and_hold_continuation(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        target = self.destination()
        target.mkdir(parents=True)
        (target / "MEMORY.md").write_bytes(b"pre-existing destination memory")
        before = fixtures.fingerprint(target)
        result = self.run_native(sources)
        self.assertEqual(result["failed"], [])
        self.assertEqual(fixtures.fingerprint(target), before)
        self.assertEqual(fixtures.fingerprint(self.dest / "imports/acme/memory/worker"),
                         fixtures.fingerprint(folder))
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn("different content", meta["reason"])
        self.assertTrue(any("Claude memory held" in w for w in result["imported"][0]["warnings"]))
        self.assertIn("Imported Claude memory is unavailable", native.native_hold_reason(copied, "worker"))

    def test_identical_destination_is_accepted(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        target = self.destination()
        shutil.copytree(folder, target)
        self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "ready")
        self.assertTrue(meta["identical"])
        self.assertEqual(fixtures.fingerprint(target), fixtures.fingerprint(folder))
        self.assertIsNone(native.native_hold_reason(copied, "worker"))

    def test_override_inputs_hold_rather_than_share_one_directory(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        source_profile = Path(sources["claude_profile"])
        (source_profile / "settings.json").write_text(json.dumps({"autoMemoryDirectory": "~/shared"}))
        result = self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn("Unsupported memory override at source", meta["reason"])
        self.assertIn("user settings autoMemoryDirectory", meta["reason"])
        self.assertFalse(self.destination().exists())
        self.assertIn("unavailable", native.native_hold_reason(copied, "worker"))

    def test_environment_override_holds_before_any_copy(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        with patch.dict(os.environ, {memory.OVERRIDE_ENV: str(self.root / "cowork")}):
            self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn(memory.OVERRIDE_ENV, meta["reason"])
        self.assertFalse((self.dest / "imports/acme/memory").exists())

    def test_destination_local_settings_override_holds(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        local = self.dest / "scratch/acme/worker/.claude"
        # The destination scratch does not exist before publication; the check
        # reads the source copy that will land there.
        local_source = self.source / "scratch/acme/worker/.claude"
        local_source.mkdir()
        (local_source / "settings.local.json").write_text(json.dumps({"autoMemoryDirectory": "D:/m"}))
        self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn("local settings", meta["reason"])
        self.assertTrue((local / "settings.local.json").is_file())

    def test_file_bound_holds_without_partial_staging_side_effects(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        with patch.object(memory, "MAX_MEMORY_FILES", 2):
            self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn("exceeds 2 files", meta["reason"])
        self.assertFalse(self.destination().exists())

    def test_destination_appearing_before_publication_refuses_the_import(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        target = self.destination()
        real_publish = memory.publish

        def race(doc, stage):
            target.mkdir(parents=True)
            (target / "MEMORY.md").write_bytes(b"raced in")
            return real_publish(doc, stage)

        with patch.object(memory, "publish", side_effect=race):
            with self.assertRaises(imp.ImportRefused) as ctx:
                self.run_native(sources)
        self.assertEqual(ctx.exception.status, 409)
        self.assertFalse((self.dest / "orgs/acme.db").exists())
        self.assertEqual((target / "MEMORY.md").read_bytes(), b"raced in")
        self.assertEqual(sorted(p.name for p in target.iterdir()), ["MEMORY.md"])

    def test_reparse_point_inside_memory_holds(self):
        doc, sources, folder = self.memory_fixture(archived_generation=False)
        linked = folder / "linked"
        linked.mkdir()
        real_plain = imp._plain

        def refuse_link(path):
            if Path(path) == linked:
                raise imp.ImportRefused(f"Links and reparse points are not imported: {path}")
            return real_plain(path)

        with patch.object(imp, "_plain", side_effect=refuse_link):
            self.run_native(sources)
        copied = self.read()
        meta = copied["nodes"]["worker"]["desktop_import"]["memory"]
        self.assertEqual(meta["status"], "held")
        self.assertIn("reparse", meta["reason"])


class HoldReasonTests(fixtures.unittest.TestCase):
    def test_missing_destination_after_import_holds(self):
        root = Path(fixtures.tempfile.mkdtemp(dir=fixtures._TEST_ROOT))
        doc = {"nodes": {"w": {"desktop_import": {"memory": {
            "status": "ready", "destination": str(root / "gone" / "memory")}}}}}
        self.assertIn("missing", memory.hold_reason(doc, "w"))
        (root / "gone" / "memory").mkdir(parents=True)
        self.assertIsNone(memory.hold_reason(doc, "w"))
        self.assertIsNone(memory.hold_reason({"nodes": {"w": {}}}, "w"))
        self.assertIn("unavailable", memory.hold_reason(
            {"nodes": {"w": {"desktop_import": {"memory": {"status": "held", "reason": "x"}}}}}, "w"))


if __name__ == "__main__":
    fixtures.unittest.main()
