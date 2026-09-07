"""Synthetic native fork boundaries; no real provider process in this suite."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import unittest
import uuid
from unittest.mock import patch

# This module establishes explicit throwaway storage before engine imports.
from tests import test_desktop_import as fixtures
from engine.backend.orgtree import desktop_native as native, desktop_native_codex as codex
from engine.backend.orgtree import desktop_import as imp


def records(sid: str) -> list[dict]:
    at = "2026-09-07T20:00:00.000Z"
    return [
        {"timestamp": at, "type": "session_meta", "payload": {
            "id": sid, "timestamp": at, "cwd": "source-only", "originator": "codex_cli_rs",
            "cli_version": "0.153.4", "source": "cli", "model_provider": "openai",
            "base_instructions": {"text": "Remember previous work."}}},
        {"timestamp": at, "type": "response_item", "payload": {
            "type": "message", "role": "user", "content": [{"type": "input_text", "text": "Remember violet."}]}},
        {"timestamp": at, "type": "response_item", "payload": {
            "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Violet is remembered."}]}},
    ]


class NativeCodexTests(fixtures.DesktopImportTests):
    # Reuse fixture helpers only; inherited tests remain covered by their suite.
    def codex_fixture(self):
        doc = self.fixture(sqlite=False)
        sid = str(uuid.uuid4())
        doc["nodes"]["worker"].update(session_id=sid, codex_thread=sid)
        (self.source / "orgs/acme.json").write_text(json.dumps(doc), encoding="utf-8")
        journals = self.source / "journals/projects/acme"
        (journals / f"{sid}.jsonl").write_bytes((journals / "source-session.jsonl").read_bytes())
        profile = self.source / "configured-codex-profile"
        folder = profile / "sessions/2026/09/07"
        folder.mkdir(parents=True)
        path = folder / f"rollout-2026-09-07T20-00-00-{sid}.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in records(sid)), encoding="utf-8")
        return doc, path, {"codex_profile": str(profile)}

    def test_codex_copy_independent_native_and_rendered_context(self):
        doc, path, sources = self.codex_fixture()
        before = fixtures.fingerprint(self.source)
        new_sid = str(uuid.uuid4())
        def fork(rows, old_sid, folder, cwd):
            self.assertEqual(old_sid, doc["nodes"]["worker"]["session_id"])
            self.assertIn("Violet", json.dumps(rows))
            result = copy.deepcopy(rows)
            result[0]["payload"].update(id=new_sid, cwd=cwd)
            return new_sid, "".join(json.dumps(row) + "\n" for row in result).encode()
        preview = imp.preview_import(str(self.source), sources)
        self.assertEqual(preview["organizations"][0]["native_context"][0]["status"], "available")
        with patch.object(codex, "fork_snapshot", side_effect=fork):
            imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                            on_imported=self.resumed.append, native_sources=sources)
        copied = self.read()
        worker = copied["nodes"]["worker"]
        self.assertEqual(worker["session_id"], new_sid)
        self.assertEqual(worker["codex_thread"], new_sid)
        self.assertIsNone(native.native_hold_reason(copied, "worker"))
        clone = Path(native.native_session_path(copied, "worker"))
        self.assertIn("Violet", clone.read_text())
        self.assertIsNone(native.native_path_for_session(new_sid))
        journal = self.dest / f"journals/projects/acme/{new_sid}.jsonl"
        self.assertIn("step done", journal.read_text())
        archive = self.dest / worker["desktop_import"]["history"]
        self.assertIn("step done", archive.read_text())
        clone.write_bytes(clone.read_bytes() + b'{"type":"destination-only"}\n')
        journal.write_bytes(journal.read_bytes() + b'{"type":"destination-only"}\n')
        self.assertEqual(fixtures.fingerprint(self.source), before)

    def test_codex_locator_ambiguity_identity_and_attachment_hold(self):
        doc, path, sources = self.codex_fixture()
        node = doc["nodes"]["worker"]
        duplicate = path.parent / ("second-" + path.name)
        duplicate.write_bytes(path.read_bytes())
        row = native.inspect(self.source, "acme", "worker", node, sources)
        self.assertIn("More than one", row["reason"])
        exact = {"sessions": {"acme/worker": str(path)}}
        self.assertEqual(native.inspect(self.source, "acme", "worker", node, exact)["status"], "available")
        wrong = {**node, "codex_thread": str(uuid.uuid4())}
        self.assertEqual(native.inspect(self.source, "acme", "worker", wrong, exact)["status"], "held")
        rows = records(node["session_id"])
        rows[1]["payload"]["content"].append({"type": "input_image", "image_url": "file:///source/image.png"})
        with self.assertRaisesRegex(native.NativeHeld, "attachment"):
            codex.validate(rows, node["session_id"])

    def test_codex_fork_uses_only_private_snapshot_and_no_turn(self):
        sid = str(uuid.uuid4())
        fixture = records(sid)
        factory_calls, requests, clients = [], [], []
        class Client:
            def __init__(self, argv, **kw):
                factory_calls.append(kw)
                self.profile = Path(kw["codex_home"])
                self.notifications = []
                self.closed = False
                clients.append(self)
            def initialize(self, **kw):
                pass
            def request(self, method, params, **kw):
                requests.append((method, params))
                self.path = self.profile / "fork.jsonl"
                rows = json.loads(Path(params["path"]).read_text().splitlines()[0])
                self.sid = str(uuid.uuid4())
                cloned = copy.deepcopy(fixture)
                cloned[0]["payload"].update(id=self.sid, cwd=rows["payload"]["cwd"])
                self.path.write_text("".join(json.dumps(r) + "\n" for r in cloned), encoding="utf-8")
                return {"thread": {"id": self.sid, "path": str(self.path)}}
            def close(self):
                self.closed = True
        stage = self.root / "native-stage"
        stage.mkdir()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "must-not-pass", "CLAUDE_CONFIG_DIR": "must-not-pass"}):
            new_sid, raw = codex.fork_snapshot(fixture, sid, stage, "destination-cwd",
                                             argv_head=["synthetic-loader"], client_factory=Client)
        self.assertNotEqual(new_sid, sid)
        self.assertEqual(fixture, records(sid))
        self.assertEqual([m for m, _ in requests], ["thread/fork"])
        self.assertTrue(requests[0][1]["deferGoalContinuation"])
        self.assertTrue(Path(requests[0][1]["path"]).is_relative_to(stage))
        self.assertEqual(factory_calls[0]["env_extra"]["OPENAI_API_KEY"], "")
        self.assertEqual(factory_calls[0]["env_extra"]["CLAUDE_CONFIG_DIR"], "")
        self.assertTrue(clients[0].closed)
        self.assertIn(b'"cwd":"destination-cwd"', raw)
        self.assertIn(b'"model_provider":"openai"', raw)
        self.assertIn(b"Violet", raw)

    def test_codex_fork_rejects_source_path_or_same_identity(self):
        sid = str(uuid.uuid4())
        for same in (True, False):
            folder = self.root / ("same" if same else "external")
            folder.mkdir()
            class Client:
                notifications = []
                def __init__(self, *args, **kw): pass
                def initialize(self, **kw): pass
                def request(self, *args, **kw):
                    return {"thread": {"id": sid if same else str(uuid.uuid4()), "path": str(self_outer.source / "source.jsonl")}}
                def close(self): pass
            self_outer = self
            with self.assertRaises(native.NativeHeld):
                codex.fork_snapshot(records(sid), sid, folder, "destination", argv_head=["fake"], client_factory=Client)

    def test_codex_failed_native_fork_stays_held(self):
        doc, path, sources = self.codex_fixture()
        before = fixtures.fingerprint(self.source)
        with patch.object(codex, "fork_snapshot", side_effect=native.NativeHeld("loader refused snapshot")):
            imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                            on_imported=self.resumed.append, native_sources=sources)
        copied = self.read()
        self.assertIn("loader refused", native.native_hold_reason(copied, "worker"))
        self.assertNotIn("codex_thread", copied["nodes"]["worker"])
        self.assertEqual(fixtures.fingerprint(self.source), before)

    def test_native_duplicate_holds_only_affected_identity(self):
        doc, source_path, sources = self.native_fixture()
        imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                        on_imported=self.resumed.append, native_sources=sources)
        copied = self.read()
        sid = copied["nodes"]["worker"]["session_id"]
        original = Path(native.native_session_path(copied, "worker"))
        other = self.dest / "imports/other/native/worker"
        other.mkdir(parents=True)
        (other / original.name).write_bytes(original.read_bytes())
        good_sid = str(uuid.uuid4())
        good_path = other / f"{good_sid}.jsonl"
        good_path.write_bytes(original.read_bytes())
        self.assertEqual(native.native_conflicts(), {sid})
        self.assertIsNone(native.native_session_path(copied, "worker"))
        self.assertIsNotNone(native.native_hold_reason(copied, "worker"))
        self.assertEqual(native.native_index(), {good_sid: str(good_path)})
        self.assertEqual(native.native_path_for_session(good_sid), str(good_path))
        with self.assertRaisesRegex(native.NativeHeld, "Duplicate"):
            native.native_path_for_session(sid)


# Do not rerun the inherited unrelated copy-import cases from this module.
for _name in list(fixtures.DesktopImportTests.__dict__):
    if _name.startswith("test_") and _name not in NativeCodexTests.__dict__:
        setattr(NativeCodexTests, _name, None)

if __name__ == "__main__":
    unittest.main()
