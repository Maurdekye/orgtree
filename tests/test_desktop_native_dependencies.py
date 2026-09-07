"""Actual copied native tool-output bytes and reference boundaries."""
import json
from pathlib import Path
import uuid

from tests import test_desktop_import as fixtures
from engine.backend.orgtree import desktop_native as native, desktop_import as imp
from engine.backend.orgtree.desktop_native_claude_dependencies import copy_outputs


class NativeDependencyTests(fixtures.DesktopImportTests):
    def output_fixture(self):
        doc, path, sources = self.native_fixture()
        sid = doc["nodes"]["worker"]["session_id"]
        output = path.parent / sid / "tool-results/tool-1.txt"
        output.parent.mkdir(parents=True)
        output.write_bytes(b"The complete native tool output is violet.\n" * 100)
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[1]["message"]["content"].append({"type": "tool_use", "id": "tool-1", "name": "Bash", "input": {"command": "synthetic-command"}})
        rows.append({"type": "user", "uuid": str(uuid.uuid4()), "parentUuid": rows[-1]["uuid"],
                     "timestamp": "2026-09-07T20:00:02Z", "sessionId": sid,
                     "toolUseResult": {"persistedOutputPath": str(output), "persistedOutputSize": output.stat().st_size},
                     "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tool-1",
                        "content": "<persisted-output>\nFull output saved to: " + str(output) + "\nPreview: violet.\n</persisted-output>\nKeep regex \\d+ intact."}]}})
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return doc, path, sources, rows, output

    def test_complete_tool_output_copied_and_native_references_rebound(self):
        doc, path, sources, rows, output = self.output_fixture()
        before = fixtures.fingerprint(self.source)
        self.assertEqual(native.inspect(self.source, "acme", "worker", doc["nodes"]["worker"], sources)["status"], "available")
        imp.copy_import(str(self.source), ["acme"], acknowledge_duplicate_work=True,
                        on_imported=self.resumed.append, native_sources=sources)
        copied = self.read()
        worker = copied["nodes"]["worker"]
        clone = Path(native.native_session_path(copied, "worker"))
        result = [json.loads(line) for line in clone.read_text().splitlines()]
        referenced = Path(result[-1]["toolUseResult"]["persistedOutputPath"])
        self.assertTrue(referenced.is_relative_to(self.dest))
        self.assertEqual(referenced.read_bytes(), output.read_bytes())
        content = result[-1]["message"]["content"][0]["content"]
        self.assertIn(str(referenced), content)
        self.assertIn(r"\d+", content)
        self.assertNotIn(str(output), content)
        self.assertEqual(result[-1]["uuid"], rows[-1]["uuid"])
        referenced.write_bytes(b"destination changed")
        self.assertEqual(fixtures.fingerprint(self.source), before)

    def test_mixed_valid_and_missing_reference_does_not_become_ready(self):
        doc, path, sources, rows, output = self.output_fixture()
        rows[-1]["message"]["content"][0]["content"] += "\nAlso C:/unrelated/tool-results/missing.txt\n"
        with self.assertRaisesRegex(native.NativeHeld, "mixes"):
            copy_outputs(path, path.stem, rows, self.dest)
        rows[-1]["toolUseResult"]["persistedOutputPath"] = str(output) + ".secret"
        with self.assertRaisesRegex(native.NativeHeld, "missing"):
            copy_outputs(path, path.stem, rows, self.dest)

    def test_unknown_or_nested_native_sidecar_stays_held(self):
        doc, path, sources, rows, output = self.output_fixture()
        (output.parent / "nested").mkdir()
        with self.assertRaisesRegex(native.NativeHeld, "Nested"):
            copy_outputs(path, path.stem, rows, self.dest)


for _name in list(fixtures.DesktopImportTests.__dict__):
    if _name.startswith("test_") and _name not in NativeDependencyTests.__dict__:
        setattr(NativeDependencyTests, _name, None)
