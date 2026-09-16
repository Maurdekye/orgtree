"""A Codex agent whose rollout has moved since its path was recorded must still
wake. Wire-only: no app server, no provider, no model turn.

The refusal texts asserted here are the Codex CLI's own. They were read out of
codex.exe 0.153.4 and, for `failed to resolve rollout path`, reproduced against
the real binary by moving a staged rollout and resuming with the old path
(2026-09-16). The `stale path` wording is quoted from the same binary; it also
matches the `coordinator-astra` report that opened this defect.
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from engine.backend.orgtree import codexrun, desktop_import, desktop_native
from engine.backend.orgtree.codexrun import (
    CodexRequestError, CodexResumeUnresolved, CodexTurn)

#: the CLI's own words, verbatim in shape
STALE = ("cannot resume paginated thread 01a09efb-4cb7-7d41-906c-57a880e906ea "
         "with stale path: requested C:\\imports\\a.jsonl, current "
         "C:\\Users\\x\\.codex\\sessions\\2026\\09\\14\\rollout-x.jsonl; "
         "omit path and resume by thread id")
MISSING = ("failed to resolve rollout path `C:\\imports\\a.jsonl`: "
           "file does not exist")


class Client:
    """Records every request; answers `thread/resume` from a script and stops
    the turn before `turn/start` so no model work is ever attempted."""

    def __init__(self, resume_results):
        self.resume_results = list(resume_results)
        self.calls = []

    def bind(self, **kwargs): pass
    def initialize(self): pass
    def close(self): pass

    def request(self, method, params, **kwargs):
        self.calls.append((method, params))
        if method != "thread/resume":
            raise RuntimeError("stop before turn/start")
        outcome = self.resume_results.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    @property
    def resume_calls(self):
        return [p for m, p in self.calls if m == "thread/resume"]


def turn_for(client, resume_path="C:\\imports\\a.jsonl", **kw):
    return CodexTurn([], cwd="C:\\work", model="m", effort=None,
                     thread_id="01a09efb-4cb7-7d41-906c-57a880e906ea",
                     resume_path=resume_path, client=client, **kw)


def refusal(message):
    return CodexRequestError("thread/resume", -32600, message)


OK = {"thread": {"id": "01a09efb-4cb7-7d41-906c-57a880e906ea"}}


class MovedRolloutResumeTests(unittest.TestCase):

    def test_stale_path_refusal_is_retried_by_thread_id_and_the_wake_survives(self):
        """The reported failure. Before this change the refusal propagated and
        the agent could never take another turn."""
        client = Client([refusal(STALE), OK])
        with self.assertRaisesRegex(RuntimeError, "stop before turn/start"):
            turn_for(client).start("hello")
        first, second = client.resume_calls
        self.assertEqual(first["path"], "C:\\imports\\a.jsonl")
        self.assertEqual(first["cwd"], "C:\\work")
        # the server's own remedy: omit the path, resume by thread id
        self.assertNotIn("path", second)
        self.assertNotIn("cwd", second)
        self.assertEqual(second["threadId"],
                         "01a09efb-4cb7-7d41-906c-57a880e906ea")
        # the retry still carries the identity/permission fields
        self.assertEqual(second["model"], "m")
        self.assertIn("sandbox", second)
        self.assertIn("developerInstructions", second)

    def test_unresolvable_rollout_path_refusal_is_retried_the_same_way(self):
        client = Client([refusal(MISSING), OK])
        with self.assertRaisesRegex(RuntimeError, "stop before turn/start"):
            turn_for(client).start("hello")
        self.assertEqual(len(client.resume_calls), 2)
        self.assertNotIn("path", client.resume_calls[1])

    def test_a_refusal_that_is_not_about_the_path_is_not_retried(self):
        """Retrying a genuine miss would be pointless work on every one."""
        client = Client([refusal("thread is archived. Run `codex unarchive`")])
        with self.assertRaises(CodexRequestError) as caught:
            turn_for(client).start("hello")
        self.assertIn("archived", str(caught.exception))
        self.assertEqual(len(client.resume_calls), 1)

    def test_no_recorded_path_means_no_retry_ladder(self):
        client = Client([refusal("no rollout found for thread id abc")])
        with self.assertRaises(CodexRequestError):
            turn_for(client, resume_path=None).start("hello")
        self.assertEqual(len(client.resume_calls), 1)

    def test_a_resume_that_cannot_be_resolved_says_what_it_looked_for_and_where(self):
        client = Client([refusal(STALE),
                         refusal("no rollout found for thread id "
                                 "01a09efb-4cb7-7d41-906c-57a880e906ea")])
        with self.assertRaises(CodexResumeUnresolved) as caught:
            turn_for(client, codex_home="C:\\codex-home").start("hello")
        text = str(caught.exception)
        self.assertIn("01a09efb-4cb7-7d41-906c-57a880e906ea", text)  # which thread
        self.assertIn("C:\\imports\\a.jsonl", text)                  # what path
        self.assertIn("C:\\codex-home", text)                        # where searched
        self.assertIn("stale path", text)                  # why the path failed
        self.assertIn("no rollout found", text)            # why by-id failed too

    def test_a_working_recorded_path_costs_no_extra_request(self):
        client = Client([OK])
        with self.assertRaisesRegex(RuntimeError, "stop before turn/start"):
            turn_for(client).start("hello")
        self.assertEqual(len(client.resume_calls), 1)
        self.assertEqual(client.resume_calls[0]["path"], "C:\\imports\\a.jsonl")


class RefusalClassifierTests(unittest.TestCase):

    def test_path_refusals_are_recognised_and_others_are_not(self):
        self.assertTrue(codexrun.is_resume_path_refusal(STALE))
        self.assertTrue(codexrun.is_resume_path_refusal(MISSING))
        self.assertFalse(codexrun.is_resume_path_refusal(
            "no rollout found for thread id abc"))
        self.assertFalse(codexrun.is_resume_path_refusal("thread is archived"))
        self.assertFalse(codexrun.is_resume_path_refusal(None))


SID = "01a08225-192c-74d3-95ca-59b48be8959f"


class RelocatedRolloutTests(unittest.TestCase):
    """`native_session_path` must find a rollout that moved inside the imports
    tree, instead of returning None — which makes the seat HELD, and a held
    seat refuses both turns and mail delivery."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # .resolve() because Windows hands back an 8.3 short name here and the
        # code under test resolves its root before joining.
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(self.tmp.cleanup)
        stub = type("Store", (), {"DATA_ROOT": str(self.root)})
        patcher = patch.object(desktop_import, "_store", lambda: stub)
        patcher.start()
        self.addCleanup(patcher.stop)

    def org(self):
        # provider is derived from the TIER (desktop_native.provider_for), so
        # the node has to carry a real codex tier for the hold reasons to line up.
        return {"slug": "lab", "nodes": {"seat": {
            "session_id": SID, "model": "astra",
            "desktop_import": {"native_continuity": {
                "status": "ready", "provider": "codex", "session_id": SID,
                "storage_node": "seat",
                "path": str(Path("imports") / "lab" / "native" / "seat" / f"{SID}.jsonl"),
            }}}}}

    def place(self, node_dir):
        target = self.root / "imports" / "lab" / "native" / node_dir / f"{SID}.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('{"type":"session_meta"}\n', encoding="utf-8")
        return target

    def test_the_recorded_location_is_used_when_the_file_is_there(self):
        expected = self.place("seat")
        self.assertEqual(desktop_native.native_session_path(self.org(), "seat"),
                         str(expected))

    def test_a_rollout_that_moved_inside_the_imports_tree_is_found_by_session_id(self):
        moved = self.place("seat-renamed")          # recorded folder no longer exists
        self.assertEqual(desktop_native.native_session_path(self.org(), "seat"),
                         str(moved))

    def test_a_rollout_that_is_genuinely_gone_still_reports_unavailable(self):
        self.assertIsNone(desktop_native.native_session_path(self.org(), "seat"))
        self.assertEqual(
            desktop_native.native_hold_reason(self.org(), "seat"),
            "Imported native session identity or independent file is unavailable")

    def test_two_files_answering_to_one_session_id_are_refused_not_guessed(self):
        self.place("seat-a")
        self.place("seat-b")
        self.assertIsNone(desktop_native.native_session_path(self.org(), "seat"))


if __name__ == "__main__":
    unittest.main()
