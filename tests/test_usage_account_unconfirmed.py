"""An account that cannot be NAMED is not an account that CHANGED.

Docket `v3-usage-board-says-account-changed-during-the-u`. The usage window
kept saying "Antigravity account changed during the usage read" although the
user never switched. Measured 2026-09-30: two overlapping `agy models`
connect probes shared one log file, and in 2 of 10 pairs the log held no
email, so the recheck named no account and that was reported as a change.

  §1 each connect probe reads its OWN log (the cause), and the latest log is
     still kept as models-probe.log
  §2 Antigravity usage: an unnamed first read or recheck is asked again, is
     never called a change, caches nothing and keeps the earlier confirmed
     board (the header glow too); a real change and a sign-out still drop it
  §3 Codex usage: the same for an unreadable auth.json namespace
  §4 an Antigravity session is not cut into a new lineage (agent restarted
     without its memory) when either side's account is unnamed
"""
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock

_root = tempfile.TemporaryDirectory(prefix="v3-usage-unconfirmed-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import (antigravity_limits, antigravity_session,  # noqa: E402
                     codex_limits, codexrun, providers)

USAGE = {
    "conversation_id": "", "status": "SUCCESS", "num_turns": 0,
    "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
              "cache_read_tokens": 0, "total_tokens": 0},
    "command": {"name": "usage", "data": {"groups": [{
        "name": "Gemini Models", "buckets": [{
            "id": "gemini-weekly", "name": "Weekly Limit Remaining",
            "window": "weekly", "remaining_fraction": 0.7,
            "reset_time": "2026-09-17T19:40:25Z"}]}]}},
}

# ── §1 the probe log ─────────────────────────────────────────────────────────

# A stand-in `agy`, shaped like the real one: it opens its --log-file, writes
# start-up lines, names the account about a second later, works another second
# and prints the registry. A second probe started 1.5 s later on the SAME file
# truncates it after the first one's account line, and names its own account
# only after the first has exited and read the file: the first reads no email.
# That is the loss measured with the real CLI (2 of 10 overlapping pairs).
FAKE_AGY = textwrap.dedent('''
    import sys, time
    args = sys.argv[1:]
    log = args[args.index("--log-file") + 1]
    who = open(sys.argv[0] + ".who", encoding="utf-8").read().strip()
    with open(log, "w", encoding="utf-8") as f:
        f.write("I0930 server.go:1574] Starting language server process\\n")
        f.flush()
        time.sleep(1.0)
        f.write("I0930 server_oauth.go:197] OAuth: authenticated successfully as "
                + who + "\\n")
        f.flush()
        time.sleep(1.0)
    print("gemini-3.8-flash\\tGemini Flash")
''')


class ProbeLogTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="agy-probe-", dir=_root.name)
        self.exe = os.path.join(self.dir, "fake_agy.py")
        Path(self.exe).write_text(FAKE_AGY, encoding="utf-8")
        Path(self.exe + ".who").write_text("user@example.test", encoding="utf-8")
        self.probe_dir = os.path.join(self.dir, "probe")
        p = mock.patch.object(providers, "antigravity_probe_dir", return_value=self.probe_dir)
        p.start()
        self.addCleanup(p.stop)

    def test_one_probe_names_its_account(self):
        out = providers._antigravity_account(self.exe)
        self.assertTrue(out["connected"])
        self.assertEqual(out["email"], "user@example.test")

    def test_overlapping_probes_each_name_the_account(self):
        results: dict[str, dict] = {}

        def probe(tag: str) -> None:
            results[tag] = providers._antigravity_account(self.exe)

        a = threading.Thread(target=probe, args=("a",))
        b = threading.Thread(target=probe, args=("b",))
        a.start()
        threading.Event().wait(1.5)
        b.start()
        a.join(30)
        b.join(30)
        for tag in ("a", "b"):
            self.assertTrue(results[tag]["connected"], tag)
            self.assertEqual(results[tag]["email"], "user@example.test",
                             f"probe {tag} lost its account line to the other probe")

    def test_the_latest_log_is_kept_as_models_probe_log_and_nothing_else_is_left(self):
        providers._antigravity_account(self.exe)
        self.assertEqual(sorted(os.listdir(self.probe_dir)), ["models-probe.log"])
        text = Path(self.probe_dir, "models-probe.log").read_text(encoding="utf-8")
        self.assertIn("user@example.test", text)


# ── §2 Antigravity usage ────────────────────────────────────────────────────

NAMED = {"installed": True, "connected": True, "path": "agy-test",
         "email": "a@example.test", "version": "1.2.0"}
UNNAMED = {**NAMED, "email": None}
OTHER = {**NAMED, "email": "b@example.test"}


class AntigravityUsageTests(unittest.TestCase):
    def setUp(self):
        antigravity_limits.invalidate()
        prior = providers._antigravity_status_cache
        providers._antigravity_status_cache = None
        self.addCleanup(setattr, providers, "_antigravity_status_cache", prior)

    def fetch(self, statuses):
        with mock.patch.object(providers, "antigravity_status", side_effect=statuses) as st, \
             mock.patch.object(antigravity_limits, "_run_status", return_value=None), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=USAGE):
            out = antigravity_limits.fetch(force=True)
        return out, st.call_count

    def test_an_unnamed_recheck_is_not_called_an_account_change(self):
        good, _ = self.fetch([NAMED, NAMED])
        self.assertTrue(good["available"])
        out, calls = self.fetch([NAMED, UNNAMED, UNNAMED])
        self.assertEqual(calls, 3, "the unnamed recheck was not asked a second time")
        self.assertFalse(out["available"])
        self.assertNotIn("changed", out["error"])
        self.assertIn("could not confirm the account", out["error"])
        # the earlier confirmed board is not thrown away
        self.assertTrue(antigravity_limits.peek()["available"])

    def test_an_unnamed_recheck_that_names_the_account_on_retry_is_served_and_cached(self):
        out, calls = self.fetch([NAMED, UNNAMED, NAMED])
        self.assertEqual(calls, 3)
        self.assertTrue(out["available"])
        self.assertNotIn("error", out)
        self.assertTrue(antigravity_limits.peek()["available"])

    def test_a_real_change_is_still_refused_and_not_cached(self):
        out, _ = self.fetch([NAMED, OTHER])
        self.assertFalse(out["available"])
        self.assertIn("changed during", out["error"])
        self.assertFalse(antigravity_limits.peek()["available"])

    # review-sol (8f28c87): the FIRST read can be unnamed too

    def test_an_unnamed_first_read_is_not_called_a_change_and_reads_nothing(self):
        self.fetch([NAMED, NAMED])
        with mock.patch.object(providers, "antigravity_status",
                               side_effect=[UNNAMED, UNNAMED]) as st, \
             mock.patch.object(antigravity_limits, "_run_status", return_value=None), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=USAGE) as usage:
            out = antigravity_limits.fetch(force=True)
        self.assertEqual(st.call_count, 2, "the unnamed first read was not asked a second time")
        self.assertEqual(usage.call_count, 0, "usage was read for an account nobody could name")
        self.assertFalse(out["available"])
        self.assertNotIn("changed", out["error"])
        self.assertIn("could not confirm which account", out["error"])
        self.assertTrue(antigravity_limits.peek()["available"],
                        "an unnamed read dropped the confirmed board")

    def test_an_unnamed_first_read_named_on_retry_reads_normally(self):
        out, calls = self.fetch([UNNAMED, NAMED, NAMED])
        self.assertEqual(calls, 3)
        self.assertTrue(out["available"])
        self.assertNotIn("error", out)

    def test_signing_out_still_drops_the_board(self):
        self.fetch([NAMED, NAMED])
        signed_out = {**NAMED, "connected": False, "email": None}
        out, _ = self.fetch([signed_out])
        self.assertIn("not signed in", out["error"])
        self.assertFalse(antigravity_limits.peek()["available"])

    def test_the_header_glow_keeps_the_board_when_another_surface_saw_an_unnamed_status(self):
        self.fetch([NAMED, NAMED])
        providers._antigravity_status_cache = (time.time(), dict(UNNAMED))
        self.assertTrue(antigravity_limits.peek()["available"],
                        "peek dropped the board on an unnamed status")
        # control: a signed-out status seen elsewhere still drops it
        providers._antigravity_status_cache = (
            time.time(), {**NAMED, "connected": False, "email": None})
        self.assertFalse(antigravity_limits.peek()["available"])


# ── §3 Codex usage ──────────────────────────────────────────────────────────

class FakeClient:
    def __init__(self, argv_head, codex_home=None, **kw):
        pass

    def initialize(self):
        pass

    def request(self, method, params, timeout=None):
        return {"rateLimits": {
            "limitId": "codex", "planType": "plus",
            "primary": {"usedPercent": 41.5, "windowDurationMins": 300,
                        "resetsAt": 1790000000}}}

    def close(self):
        pass


A = "codex-chatgpt:aaaa"
B = "codex-chatgpt:bbbb"


class CodexUsageTests(unittest.TestCase):
    def setUp(self):
        codex_limits.invalidate()
        self.addCleanup(codex_limits.invalidate)

    def fetch(self, namespaces, connected=True):
        status = {"installed": True, "connected": connected, "kind": "chatgpt"}
        with mock.patch.object(codex_limits, "account_namespace", side_effect=namespaces) as ns, \
             mock.patch.object(providers, "codex_status", return_value=status), \
             mock.patch.object(providers, "codex_path", return_value=("codex.exe", "test")), \
             mock.patch.object(providers, "codex_argv", side_effect=lambda exe: [exe]), \
             mock.patch.object(codexrun, "AppServerClient", side_effect=FakeClient) as client:
            out = codex_limits.fetch(force=True)
        self.clients = client.call_count
        return out, ns.call_count

    # review-sol (8f28c87): the FIRST read can be unnamed too

    def test_an_unnamed_first_read_is_not_called_a_change_and_reads_nothing(self):
        self.fetch([A, A, A])
        self.assertTrue(self.cached())
        out, calls = self.fetch(["unobserved", "unobserved"])
        self.assertEqual(calls, 2, "the unnamed first read was not asked a second time")
        self.assertEqual(self.clients, 0, "usage was read for an account nobody could name")
        self.assertNotIn("changed", out["error"])
        self.assertIn("could not confirm which account", out["error"])
        self.assertTrue(self.cached(), "an unnamed read dropped the confirmed board")
        self.assertEqual(codex_limits._refused["race"], 0)

    def test_an_unnamed_first_read_named_on_retry_reads_normally(self):
        out, calls = self.fetch(["unobserved", A, A, A])
        self.assertEqual(calls, 4)
        self.assertNotIn("error", out)
        self.assertTrue(self.cached())

    def test_signing_out_still_drops_the_board(self):
        self.fetch([A, A, A])
        out, _ = self.fetch(["unobserved", "unobserved"], connected=False)
        self.assertIn("not signed in", out["error"])
        self.assertFalse(self.cached())

    def cached(self):
        return codex_limits._cache.get("data") is not None

    def test_an_unreadable_namespace_is_not_called_an_account_change(self):
        # entry, before, after, and the one retry of the unnamed side
        out, calls = self.fetch([A, A, "unobserved", "unobserved"])
        self.assertEqual(calls, 4, "the unnamed side was not asked a second time")
        self.assertNotIn("changed", out.get("error", ""))
        self.assertIn("could not confirm the account", out["error"])
        self.assertFalse(self.cached())
        self.assertEqual(codex_limits._refused["unconfirmed"], 1)
        self.assertEqual(codex_limits._refused["race"], 0)

    def test_an_unreadable_namespace_that_reads_on_retry_is_cached(self):
        out, calls = self.fetch([A, A, "codex-account-unobserved", A])
        self.assertEqual(calls, 4)
        self.assertNotIn("error", out)
        self.assertTrue(self.cached())

    def test_a_real_change_is_still_refused(self):
        out, _ = self.fetch([A, A, B])
        self.assertIn("changed during", out["error"])
        self.assertFalse(self.cached())
        self.assertEqual(codex_limits._refused["race"], 1)


# ── §4 Antigravity session lineage ──────────────────────────────────────────

class _Org:
    def __init__(self, node):
        self._node = node
        self.d = {"slug": "no-such-org"}

    def node(self, nid):
        return self._node


class LineageTests(unittest.TestCase):
    NAMED_NS = "antigravity-oauth:1234"

    def cut(self, previous, now):
        org = _Org({"antigravity_account": previous, "generation": 1})
        spec = {"conversation_id": "conv-1", "account": now}
        # nothing past the guard may run: a cut would need a real org
        with mock.patch("orgtree.orgtx.org_read",
                        side_effect=AssertionError("the session was cut")):
            return antigravity_session.prepare_lineage(org, "agent", spec)

    def test_an_unnamed_account_now_does_not_cut_the_session(self):
        for now in sorted(antigravity_session.UNOBSERVED_ACCOUNTS):
            self.assertFalse(self.cut(self.NAMED_NS, now), now)

    def test_an_unnamed_stored_account_does_not_cut_the_session(self):
        for before in sorted(antigravity_session.UNOBSERVED_ACCOUNTS):
            self.assertFalse(self.cut(before, self.NAMED_NS), before)

    def test_a_move_to_an_api_key_row_still_cuts_it_even_from_an_unnamed_account(self):
        for before in sorted(antigravity_session.UNOBSERVED_ACCOUNTS):
            with self.assertRaisesRegex(AssertionError, "the session was cut"):
                self.cut(before, "google-key-row-1")

    def test_two_different_named_accounts_still_cut_it(self):
        with self.assertRaisesRegex(AssertionError, "the session was cut"):
            self.cut(self.NAMED_NS, "antigravity-oauth:5678")


if __name__ == "__main__":
    unittest.main()
