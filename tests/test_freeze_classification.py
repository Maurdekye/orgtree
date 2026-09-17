"""Usage-limit classification and the freeze lifecycle, on both lanes.

Two defects pull the same machinery in OPPOSITE directions, and both are
exercised here so that a later change cannot fix one by breaking the other:

  · GEMINI/ANTIGRAVITY — a freeze that fires when it should not. The wall
    message states a RELATIVE countdown and `observe_wall` is `now + duration`
    with no memory, so an unchanged countdown manufactured a new, later
    deadline every time it was seen and the agent could never get out.

  · CLAUDE — a freeze that does not fire when it should. The limit was
    recognised, but the lane-marking write that runs just before the freeze
    raised `RegistryUnreadable` in the packaged desktop app, and the raise
    skipped the freeze entirely.

The Claude cases drive the REAL turn runner (`_run_one_turn`) against a fake
CLI emitting real stream-json, so the assertions are about the seam and not
about a helper in isolation.
"""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-freeze-classify-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))
from orgtree import (accounts, antigravity_limits, ledger,  # noqa: E402
                     store, supervisor as sup, warmpool)

# The exact sentence this machine's antigravity CLI returned, verbatim, on
# five separate turns spanning thirteen hours (see `MEASURED_REPEATS`).
WALL = ("Individual quota reached. Please upgrade your subscription to "
        "increase your limits. Resets in 2h53m47s.")
WALL_SECONDS = 10427.0          # what "2h53m47s" parses to

#: The measured recurrence, read out of this machine's own failfix records for
#: `notice-toggle` (data/failfix/orgtree/notice-toggle/*.json). Every one of
#: these recorded `reset_in_s: 10427` — byte-identical. A live provider
#: countdown DECREASES; this one did not, which is what proves the sentence was
#: not being computed fresh for the turn that read it.
MEASURED_REPEATS = (
    "2026-09-16T18:54:08Z",     # the first, genuine wall
    "2026-09-16T22:16:00Z",
    "2026-09-17T01:11:09Z",
    "2026-09-17T04:06:25Z",
    "2026-09-17T07:52:27Z",     # still frozen, 13h after the first
)

# A fake Claude CLI: real stream-json on stdout, the shapes the supervisor's
# event loop actually reads. `mode` picks which turn it plays.
_CHILD = r'''
import json,sys
mode=sys.argv[1]
def emit(e):print(json.dumps(e),flush=True)
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':[]})
sys.stdin.readline()
if mode=='limit':
    # the CLI's own <synthetic> limit record, then a CLEAN-shaped result that
    # is nonetheless flagged is_error with the 429 status
    emit({'type':'assistant','message':{'id':'a','role':'assistant',
          'model':'<synthetic>','content':[{'type':'text',
          'text':"Claude AI usage limit reached|1789600000"}],
          'usage':{'output_tokens':0}}})
    emit({'type':'result','subtype':'success','is_error':True,
          'api_error_status':429,'result':'Claude AI usage limit reached|1789600000',
          'total_cost_usd':0,'usage':{'output_tokens':0}})
    sys.exit(1)
emit({'type':'assistant','message':{'id':'a','role':'assistant',
      'content':[{'type':'text','text':'working'}],'usage':{'output_tokens':1}}})
emit({'type':'result','subtype':'success','is_error':False,
      'total_cost_usd':0,'usage':{'output_tokens':1}})
'''


class CountdownAnchoringTests(unittest.TestCase):
    """The Gemini/antigravity lane: when may a stated countdown set a deadline?

    `classify_countdown` is the rule; these pin each of its answers against the
    real measured sentence rather than a synthetic one.
    """

    def test_a_first_wall_is_honoured_exactly_as_before(self):
        now = 1_000_000.0
        kind, until = antigravity_limits.classify_countdown(WALL, "", None, now)
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_FRESH)
        self.assertEqual(until, now + WALL_SECONDS)

    def test_a_different_countdown_is_this_turn_s_own_evidence(self):
        now = 1_000_000.0
        later = WALL.replace("2h53m47s", "41m3s")
        kind, until = antigravity_limits.classify_countdown(
            later, WALL, now + WALL_SECONDS, now)
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_FRESH)
        self.assertEqual(until, now + 41 * 60 + 3)

    def test_a_restated_countdown_never_moves_the_deadline_forward(self):
        # The same sentence, said again an hour into the wall it described.
        first = 1_000_000.0
        deadline = first + WALL_SECONDS
        kind, until = antigravity_limits.classify_countdown(
            WALL, WALL, deadline, first + 3600)
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_REPEAT)
        self.assertEqual(until, deadline, "a repeat must keep the ORIGINAL release time")

    def test_a_countdown_that_outlived_its_own_deadline_sets_none(self):
        first = 1_000_000.0
        deadline = first + WALL_SECONDS
        kind, until = antigravity_limits.classify_countdown(
            WALL, WALL, deadline, deadline + 1)
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_STALE)
        self.assertIsNone(until, "a stale countdown may not name a horizon")

    def test_an_absolute_reset_is_left_completely_alone(self):
        # No relative duration anywhere: the rule must not engage, so the
        # caller's existing provenance ranking stands untouched.
        absolute = "You've hit your session limit - resets 1:40pm"
        kind, until = antigravity_limits.classify_countdown(
            absolute, absolute, 1_000_000.0, 999_000.0)
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_NONE)
        self.assertIsNone(until)

    def test_the_measured_thirteen_hour_recurrence_cannot_slide_the_release(self):
        """The reported bug, replayed from the real failfix timeline.

        Before the fix each of these five observations re-anchored the SAME
        sentence to its own `now`, so the node's release time walked forward
        from 21:47 on the 16th to 10:46 on the 17th and would have kept
        walking. The release must be pinned to the FIRST wall, and once that
        release has passed a restated sentence must stop naming a horizon at
        all — which is how the agent gets out.
        """
        stamps = [time.mktime(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
                  for s in MEASURED_REPEATS]
        kind, until = antigravity_limits.classify_countdown(
            WALL, "", None, stamps[0])
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_FRESH)
        first_release = until
        prior_msg, prior_until = WALL, until
        for stamp in stamps[1:]:
            kind, until = antigravity_limits.classify_countdown(
                WALL, prior_msg, prior_until, stamp)
            if until is not None:
                self.assertLessEqual(
                    until, first_release,
                    "no restatement may push the release past the first wall")
            prior_until = until if until is not None else prior_until
        # The last four observations all sit AFTER the first release, so by
        # then the sentence is stale and names nothing.
        self.assertEqual(kind, antigravity_limits.COUNTDOWN_STALE)
        self.assertIsNone(until)


class ProviderFreezeSeamTests(unittest.TestCase):
    """The same rule as the freeze ACTUALLY writes it, through
    `freeze_provider_limit` — the function the antigravity lane reaches."""

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f"agy-freeze-{self.seq}"
        self.nid = "worker"
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "flash", 0, self.nid)
        store.save_org(org)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.stack.enter_context(patch.object(sup, "_limit_announce"))
        self.stack.enter_context(patch.object(sup, "notify"))

    def freeze(self, *, reset_ts):
        return sup.freeze_provider_limit(
            self.slug, self.nid, WALL, reset_ts, provider="google",
            account="antigravity", resource_pool="flash",
            schedule_kind="observed-deadline")

    def frozen(self):
        return store.load_org(self.slug).node(self.nid)["frozen"]

    def test_the_first_wall_freezes_with_its_stated_deadline(self):
        now = time.time()
        self.assertTrue(self.freeze(reset_ts=now + WALL_SECONDS))
        fz = self.frozen()
        self.assertTrue(fz["limit"])
        self.assertEqual(fz["reset_src"], "provider")
        self.assertEqual(fz["schedule_kind"], "observed-deadline")
        self.assertAlmostEqual(fz["until_ts"], now + WALL_SECONDS, delta=2)

    def test_a_restated_wall_keeps_the_original_release_time(self):
        now = time.time()
        self.freeze(reset_ts=now + WALL_SECONDS)
        original = self.frozen()["until_ts"]
        # the same sentence again, an hour later, re-anchored by the caller
        # exactly as `observe_wall` would have done
        self.freeze(reset_ts=now + 3600 + WALL_SECONDS)
        self.assertEqual(self.frozen()["until_ts"], original,
                         "a restated countdown must not extend the freeze")
        self.assertTrue(self.frozen()["limit"], "it is still a limit freeze")

    def test_a_stale_wall_still_freezes_but_only_to_the_probe_floor(self):
        """The recovery path: the agent stays parked (the turn really did
        fail) but on a horizon short enough to walk out of by itself."""
        now = time.time()
        self.freeze(reset_ts=now + WALL_SECONDS)
        # jump past the release the first wall named, then restate it
        with patch.object(sup.time, "time", return_value=now + WALL_SECONDS + 60):
            self.freeze(reset_ts=now + WALL_SECONDS + 60 + WALL_SECONDS)
            fz = self.frozen()
        self.assertTrue(fz["limit"], "a failed turn on a recognised wall still freezes")
        self.assertEqual(fz["schedule_kind"], "probe")
        self.assertLessEqual(
            fz["until_ts"], now + WALL_SECONDS + 60 + sup.PROBE_FLOOR + 2,
            "a stale countdown may not park the node for another three hours")

    def test_recognition_itself_is_untouched(self):
        """The guard rail on this whole change: the broad predicate that
        decides WHAT COUNTS AS A LIMIT must keep saying yes to every one of
        these. Narrowing it is how a real wall gets missed."""
        for blob in (
                WALL,
                "Claude AI usage limit reached|1789600000",
                "You've hit your session limit - resets 1:40pm",
                "would exceed your account's rate limit",
                "You've reached your Fable 5 limit. Run /usage-credits",
                "weekly limit reached",
        ):
            self.assertTrue(sup._looks_like_usage_limit(blob), blob)
        # …and still no to a context overflow, which is not a wall
        self.assertFalse(sup._looks_like_usage_limit(
            "input length and max_tokens exceed context limit: 205000 > 200000"))


class ClaudeTurnSeamTests(unittest.TestCase):
    """The Claude lane, through the REAL turn runner and a real child process."""

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f"claude-freeze-{self.seq}"
        self.nid = "worker"
        self.dir = Path(_ROOT.name) / self.slug
        self.dir.mkdir(exist_ok=True)
        self.script = self.dir / "child.py"
        self.script.write_text(_CHILD, encoding="utf-8")
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "opus", 0, self.nid)
        org.node(self.nid)["session_id"] = "fixture-session"
        store.save_org(org)
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True, exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st["busy"] = True
        self.procs = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.stack.enter_context(patch.object(sup, "spawn_env", return_value={
            k: v for k, v in os.environ.items()
            if k.upper() in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")}))
        self.stack.enter_context(patch.object(sup, "_leash"))
        self.stack.enter_context(patch.object(
            sup, "_mcp_infrastructure_fingerprint", return_value="fixture"))
        self.stack.enter_context(patch.object(sup, "_record_prompt_view"))
        self.stack.enter_context(patch.object(sup, "cli_diagnosis", return_value=None))
        self.stack.enter_context(patch.object(sup, "_limit_announce"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(
            warmpool, "warm_decision", return_value=(False, False)))
        self.stack.enter_context(patch.object(
            warmpool, "eligible", return_value=(False, "fixture")))
        self.stack.enter_context(patch.object(
            sup.appsettings, "wait_for_mcp_tools_enabled", return_value=False))
        self.stack.enter_context(patch("orgtree.transcript_ingest.capture_safely"))
        popen = subprocess.Popen

        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get("stdin") == subprocess.PIPE:
                self.procs.append(p)
            return p
        self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=spawn))

    def tearDown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def drive(self, mode):
        cmd = [sys.executable, str(self.script), mode]
        self.stack.enter_context(patch.object(sup, "_build_cmd", return_value=cmd))
        out = []
        thread = threading.Thread(
            target=lambda: out.append(
                sup._run_one_turn(self.slug, self.nid, "hello")), daemon=True)
        thread.start()
        thread.join(60)
        self.assertFalse(thread.is_alive(), "the turn runner must settle")
        return out

    def frozen(self):
        return store.load_org(self.slug).node(self.nid).get("frozen")

    def test_a_session_limit_freezes_the_agent_and_holds_its_work(self):
        """The property the whole second item exists for.

        The lane mark is stubbed to SUCCEED here, deliberately: this arm is
        about the ordinary path, and it must not depend on whether the machine
        running the suite happens to have `ORGTREE_DESKTOP_MANAGED` set (an
        agent spawned by the desktop engine inherits it, a bare dev checkout
        does not). The failing-mark arm is the next test, which forces it.
        """
        with patch.object(accounts, "record_limit", return_value=True):
            self.drive("limit")
        fz = self.frozen()
        self.assertIsNotNone(fz, "a recognised session limit must write a freeze record")
        self.assertTrue(fz.get("limit"))
        self.assertIsNotNone(fz.get("until_ts"), "the freeze must name when the limit lifts")
        self.assertTrue(fz.get("resume_texts"), "the interrupted work must be held for replay")
        self.assertIn("hello", " ".join(fz["resume_texts"]))

    def test_a_failed_lane_mark_cannot_cancel_the_freeze(self):
        """THE REGRESSION. In the packaged desktop app `accounts.save` raises
        `RegistryUnreadable`, so `accounts.record_limit` — called by the
        lane-MARKING step that runs immediately before the freeze — threw. The
        raise escaped the marking block and took the freeze with it, leaving
        the node live, unfrozen, with nothing held and a stale `last_status`,
        and the failure was then reported as a bad account binding.

        The mark is an optimisation; the freeze is the safety.
        """
        with patch.object(accounts, "record_limit", side_effect=accounts.RegistryUnreadable(
                "Multi-account registry writes are unavailable in desktop MVP")):
            self.drive("limit")
        fz = self.frozen()
        self.assertIsNotNone(
            fz, "a registry write failure must not cancel the freeze")
        self.assertTrue(fz.get("limit"))
        self.assertIsNotNone(fz.get("until_ts"))
        self.assertTrue(fz.get("resume_texts"), "the work must still be held")

    def test_a_clean_turn_freezes_nothing(self):
        """The negative control: nothing about this change may park a healthy
        turn. Without this, every assertion above passes on a build that
        freezes unconditionally."""
        self.drive("ok")
        self.assertIsNone(self.frozen(), "a successful turn must not be frozen")

    def test_a_limit_seen_on_an_earlier_turn_does_not_freeze_a_later_one(self):
        """"A replayed usage-limit message from an old turn."

        On this lane the protection is that the captured limit text is
        TURN-SCOPED: `synth_limit_txt` is re-initialised inside the per-turn
        body, so evidence from turn N cannot reach turn N+1. That property is
        what makes the Claude lane immune to the replay this item reports, and
        it is worth pinning: hoisting that local out of the loop, or caching it
        on the warm process, would silently re-introduce exactly the bug —
        an agent frozen for a wall it hit yesterday.
        """
        with patch.object(accounts, "record_limit", return_value=True):
            self.drive("limit")
        self.assertIsNotNone(self.frozen(), "turn 1 hit a real wall")
        # clear the freeze and run a HEALTHY turn on the same node/session
        org = store.load_org(self.slug)
        org.node(self.nid).pop("frozen", None)
        store.save_org(org)
        self.st["busy"] = True
        self.drive("ok")
        self.assertIsNone(
            self.frozen(),
            "the previous turn's limit message must not freeze this turn")


if __name__ == "__main__":
    unittest.main()
