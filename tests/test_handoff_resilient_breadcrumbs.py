import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from engine.backend.orgtree import breadcrumbs, handoff


class BreadcrumbPersistenceTests(unittest.TestCase):
    def test_utf16_without_bom_is_appended_without_rewriting_existing_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "breadcrumbs.md"
            original = "- old note\n".encode("utf-16-le")
            p.write_bytes(original)
            result = breadcrumbs.append_note(str(p), "- new note")
            self.assertTrue(result["ok"])
            self.assertEqual(result["encoding"], "utf-16-le")
            self.assertEqual(p.read_bytes()[:len(original)], original)
            self.assertEqual(p.read_bytes().decode("utf-16-le"),
                             "- old note\n- new note")

    def test_bom_encoded_files_keep_one_bom_at_the_start(self):
        for encoding, bom in (("utf-8-sig", b"\xef\xbb\xbf"),
                              ("utf-16-le", b"\xff\xfe"),
                              ("utf-16-be", b"\xfe\xff")):
            with self.subTest(encoding=encoding), tempfile.TemporaryDirectory() as d:
                p = Path(d) / "breadcrumbs.md"
                payload_encoding = "utf-8" if encoding == "utf-8-sig" else encoding
                original = bom + "- old note\n".encode(payload_encoding)
                p.write_bytes(original)
                result = breadcrumbs.append_note(str(p), "- new note")
                self.assertTrue(result["ok"])
                self.assertEqual(p.read_bytes()[:len(original)], original)
                self.assertEqual(p.read_bytes().count(bom), 1)
                decoded = p.read_bytes()[len(bom):].decode(payload_encoding)
                self.assertEqual(decoded, "- old note\n- new note")

    def test_malformed_existing_bytes_are_reported_and_left_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "breadcrumbs.md"
            original = b"\xff\xfe\x00\xd8"
            p.write_bytes(original)
            result = breadcrumbs.append_note(str(p), "new")
            self.assertFalse(result["ok"])
            self.assertEqual(result["availability"], "unreadable")
            self.assertEqual(p.read_bytes(), original)

    def test_empty_note_does_not_make_missing_file_appear_readable(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "breadcrumbs.md"
            result = breadcrumbs.append_note(str(p), "")
            self.assertTrue(result["ok"])
            self.assertEqual(result["availability"], "missing")
            self.assertFalse(p.exists())


class HandoffBoundaryFactsTests(unittest.TestCase):
    def test_missing_breadcrumbs_and_provenance_are_explicit_and_reproducible(self):
        with tempfile.TemporaryDirectory() as d:
            line = json.dumps({"type": "user", "message": {"role": "user",
                "content": "continue"}}, ensure_ascii=False) + "\n"
            node = {"charter": "role", "team_charter": "team", "parent": None,
                    "grant": 0, "last_status": {"status": "working",
                    "summary": "doing"}, "scope": {"add_dirs": [], "tools": {}},
                    "last_approvals": [{"tool": "fileChange"}],
                    "last_denials": [{"tool": "commandExecution"}]}
            provenance = {"worktree": {"checkout": d, "commit": None,
                         "state": "unresolved", "dirty_count": 0},
                         "verification": [], "authorized_docket":
                         [{"slug": "work", "status": "in_progress"}],
                         "cache": {"status": "unknown"}}
            art = handoff.capture(nid="agent", node=node, lines=[line],
                                  views_all={}, mailbox=[], mooted_ask=None,
                                  grants=[d], boundary={"reason": "test"},
                                  scratch=d, provenance=provenance)
            self.assertEqual(art["v"], handoff.V)
            self.assertEqual(art["inputs"]["breadcrumbs"]["availability"], "missing")
            self.assertEqual(art["inputs"]["breadcrumbs"]["path"], "breadcrumbs.md")
            self.assertEqual(art["record"]["provenance"], provenance)
            self.assertEqual(handoff.verify(art, [line]), [])
            rendered = handoff.render_md(art)
            self.assertIn("breadcrumbs.md missing", rendered)
            self.assertIn("Permission approvals observed", rendered)
            self.assertIn("Authorized docket facts", rendered)

    def test_denied_breadcrumbs_do_not_abort_capture(self):
        with tempfile.TemporaryDirectory() as d, patch(
                "engine.backend.orgtree.breadcrumbs.read",
                return_value={"path": "breadcrumbs.md", "availability": "denied",
                              "bytes": None, "sha256": None, "encoding": None,
                              "detail": "permission denied", "text": "",
                              "replacements": 0, "had_bom": False}):
            node = {"scope": {"add_dirs": [], "tools": {}}}
            art = handoff.capture(nid="agent", node=node, lines=[], views_all={},
                                  mailbox=[], mooted_ask=None, grants=[d],
                                  boundary={"reason": "test"}, scratch=d)
            self.assertEqual(art["inputs"]["breadcrumbs"]["availability"], "denied")
            self.assertEqual(handoff.verify(art, []), [])


if __name__ == "__main__":
    unittest.main()
