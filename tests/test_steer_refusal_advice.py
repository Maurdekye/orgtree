"""A file-tool refusal must say what IS permitted, not just that it was refused.

Ticket `the-sandbox-refuses-to-create-files-and-folders` (2026-09-16). Both
reporting organizations found the working route by TRYING it: the CLI's refusal
names a boundary without indicating the permitted alternative. The CLI owns that
string; the PostToolUse hook is where we can attach the explanation.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

os.environ.setdefault(
    "ORGTREE_DATA", tempfile.mkdtemp(prefix="orgtree-steer-test-"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import steer


DENIED = "File is in a directory that is denied by your permission settings."
SENSITIVE = "Cannot write to this path, which is a sensitive file."


def payload(tool: str = "Write", path: str = "C:/grant/ro/notes.md",
            response: object = DENIED) -> str:
    return json.dumps({"session_id": "s", "tool_name": tool,
                       "tool_input": {"file_path": path},
                       "tool_response": response})


class RefusalAdviceTests(unittest.TestCase):
    # ── it fires, and it is specific ──────────────────────────────────────
    def test_deny_rule_refusal_is_explained(self) -> None:
        out = steer.refusal_advice(payload())
        self.assertIn("[ORGTREE — that refusal explained]", out)
        self.assertIn("C:/grant/ro/notes.md", out)

    def test_it_names_the_agents_own_writable_folder(self) -> None:
        out = steer.refusal_advice(payload())
        self.assertIn(os.getcwd(), out)
        self.assertIn("breadcrumbs.md", out)

    def test_it_states_the_permitted_alternative_not_just_the_boundary(
            self) -> None:
        out = steer.refusal_advice(payload())
        self.assertIn("orgtree_request_scope", out)
        # the shell route the reporters found by trial is named as a
        # workaround, so the next agent does not have to discover it blind
        self.assertIn("shell", out.lower())

    def test_it_invites_a_bug_report_when_the_path_is_the_agents_own(
            self) -> None:
        out = steer.refusal_advice(payload())
        self.assertIn("bug in orgtree", out)

    # ── the other gate, which is NOT a deny rule ──────────────────────────
    def test_sensitive_path_gate_gets_its_own_explanation(self) -> None:
        out = steer.refusal_advice(
            payload(path="C:/Users/x/.claude/skills/a.md", response=SENSITIVE))
        self.assertIn(".claude", out)
        self.assertIn("bypassPermissions", out)
        self.assertNotIn("READ-ONLY is for READING", out)

    def test_sensitive_gate_says_there_is_nothing_to_retry(self) -> None:
        out = steer.refusal_advice(
            payload(path="C:/Users/x/.claude/settings.json",
                    response=SENSITIVE))
        self.assertIn("nothing to retry", out)

    # ── and it stays silent the rest of the time ──────────────────────────
    def test_successful_write_says_nothing(self) -> None:
        self.assertEqual(
            steer.refusal_advice(payload(response="File created successfully")),
            "")

    def test_non_file_tool_says_nothing(self) -> None:
        self.assertEqual(steer.refusal_advice(payload(tool="Bash")), "")

    def test_unrelated_file_tool_error_says_nothing(self) -> None:
        self.assertEqual(steer.refusal_advice(
            payload(response="File has not been read yet.")), "")

    def test_malformed_payload_says_nothing(self) -> None:
        for raw in ("", "{", "[]", "null", json.dumps({"tool_name": 7})):
            self.assertEqual(steer.refusal_advice(raw), "")

    def test_structured_tool_response_is_still_searched(self) -> None:
        out = steer.refusal_advice(payload(
            response={"error": {"message": DENIED}, "ok": False}))
        self.assertIn("[ORGTREE — that refusal explained]", out)

    def test_missing_path_still_explains(self) -> None:
        raw = json.dumps({"tool_name": "Edit", "tool_response": DENIED})
        out = steer.refusal_advice(raw)
        self.assertIn("[ORGTREE — that refusal explained]", out)
        self.assertNotIn("The path was:", out)

    # ── emission shape ────────────────────────────────────────────────────
    def test_emit_is_a_valid_posttooluse_payload(self) -> None:
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            steer._emit(steer.refusal_advice(payload()))
        got = json.loads(buf.getvalue())
        self.assertEqual(got["hookSpecificOutput"]["hookEventName"],
                         "PostToolUse")
        self.assertIn("refusal explained",
                      got["hookSpecificOutput"]["additionalContext"])

    def test_emit_prints_nothing_when_there_is_nothing_to_say(self) -> None:
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            steer._emit("")
        self.assertEqual(buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
