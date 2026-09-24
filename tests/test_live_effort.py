"""Changing a Claude agent's effort while its turn runs.

Item support-changing-a-claude-agent-s-effort-level-m. A node's effort reaches
the CLI as `--effort` at spawn. Measured on Claude Code 2.1.280 (Opus 5.5 and
Sonnet 5), a stream-json `control_request` with subtype `apply_flag_settings`
and `settings.effortLevel` written to a running process changes the effort
from the turn's NEXT model call. These tests pin orgtree's side of that:

  §1  a running Claude turn is sent the explicit level on its stdin, through
      the real turn runner and real pipes (a fixture child stands in for the
      CLI and records what it read), and the CLI's reply is recorded
  §2  the level is always explicit and validated: clearing a node back to
      the org default sends the resolved level, never `null`
  §3  everything else is honestly "next turn": no running turn, Haiku (no
      effort), a non-Claude lane, an exited process
  §4  a process that was sent a live level is never parked for reuse, even
      when its identity hash still matches — the warm pool's own
      identity check cannot see a change that was later changed back
  §5  both doors that change effort (the ⚙ scope call and orgtree_retool)
      report the delivery, only after the level is saved
  §6  the measured CLI version is pinned, so a CLI change is a visible
      decision rather than a silent one

Every process and ledger is a local fixture; no provider is contacted.
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
from unittest.mock import Mock, patch

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-live-effort-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
os.environ["ORGTREE_TURNLOG"] = "1"

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, store, supervisor as sup, warmpool
from starlette.requests import Request

# The fixture CLI. After the prompt it says it is working, then, in `effort`
# mode, waits for one control_request, records it, answers it (success, or an
# error in `refuse` mode) and ends the turn. `plain` ends the turn at once.
# Afterwards it keeps reading stdin, as a live CLI does between turns.
_CHILD = r'''
import json,sys
from pathlib import Path
mode,marker=sys.argv[1:]
def emit(event):print(json.dumps(event),flush=True)
def result():emit({'type':'result','subtype':'success','is_error':False,'total_cost_usd':0,'usage':{'output_tokens':1}})
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':[]})
sys.stdin.readline()
emit({'type':'assistant','message':{'id':'a','role':'assistant','content':[{'type':'text','text':'working'}],'usage':{'output_tokens':1}}})
Path(marker).write_text('prompted')
if mode in ('effort','refuse'):
 for line in sys.stdin:
  ev=json.loads(line)
  if ev.get('type')=='control_request':
   with open(marker+'.requests','a') as f:f.write(line)
   rid=ev.get('request_id')
   emit({'type':'control_response','response':({'subtype':'success','request_id':rid} if mode=='effort' else {'subtype':'error','request_id':rid,'error':'fixture refused'})})
   break
result()
for line in sys.stdin:pass
'''


def eventually(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.02)
    return bool(predicate())


class LiveEffortBase(unittest.TestCase):
    seq = 0
    tier = "opus"

    def setUp(self):
        type(self).seq += 1
        self.slug = f"effort-{type(self).__name__.lower()}-{self.seq}"
        self.nid = "worker"
        self.dir = Path(_ROOT.name) / self.slug
        self.dir.mkdir()
        self.script = self.dir / "child.py"
        self.script.write_text(_CHILD, encoding="utf-8")
        self.marker = self.dir / "child.marker"
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, self.tier, 0, self.nid)
        org.node(self.nid)["session_id"] = "fixture-session"
        store.save_org(org)
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True, exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st["busy"] = True
        self.thread = None
        self.procs = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(sup, "spawn_env", return_value={
            k: v for k, v in os.environ.items()
            if k.upper() in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")}))
        self.stack.enter_context(patch.object(sup, "_leash"))
        self.stack.enter_context(patch.object(sup, "_mcp_infrastructure_fingerprint", return_value="fixture"))
        self.stack.enter_context(patch.object(sup, "_record_prompt_view"))
        self.stack.enter_context(patch.object(sup, "cli_diagnosis", return_value=None))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup.appsettings, "wait_for_mcp_tools_enabled", return_value=False))
        self.stack.enter_context(patch("orgtree.transcript_ingest.capture_safely"))

    def tearDown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
        if self.thread is not None:
            self.thread.join(5)
            self.assertFalse(self.thread.is_alive(), "fixture teardown must settle")
        for proc in self.procs:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        store._POOL.close_all(self.slug)

    def child_cmd(self, mode):
        return [sys.executable, str(self.script), mode, str(self.marker)]

    def run_turn(self, mode):
        self.thread = threading.Thread(target=lambda: sup._run_one_turn(
            self.slug, self.nid, {"cmd": True, "text": "/fixture"}), daemon=True)
        self.thread.start()
        self.assertTrue(eventually(self.marker.exists), self.st.get("last_error"))
        if mode != "plain":     # a plain turn may already have ended
            self.assertTrue(eventually(lambda: self.st.get("responding")
                                       and self.st.get("proc") is not None))

    def set_effort(self, effort, *, org_default=None):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            if org_default is not None:
                org.d["default_effort"] = org_default
            org.set_scope(ledger.USER, self.nid, effort=effort)
            store.save_org(org)
        return store.load_org(self.slug)

    def requests(self):
        path = Path(str(self.marker) + ".requests")
        return ([json.loads(l) for l in path.read_text().splitlines()]
                if path.exists() else [])


class ColdTurnTests(LiveEffortBase):
    """The real runner on a cold process (ORGTREE_WARM=0)."""

    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(warmpool, "warm_decision", return_value=(False, False)))
        self.stack.enter_context(patch.object(warmpool, "eligible", return_value=(False, "fixture")))
        popen = subprocess.Popen

        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get("stdin") == subprocess.PIPE:
                self.procs.append(p)
            return p
        self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=spawn))

    def start(self, mode):
        self.stack.enter_context(patch.object(sup, "_build_cmd", return_value=self.child_cmd(mode)))
        self.run_turn(mode)

    def settle(self):
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive(), "turn runner must reach its finally")
        self.assertFalse(self.st["responding"])

    # §1
    def test_a_running_turn_is_sent_the_new_level_and_the_reply_is_recorded(self):
        self.start("effort")
        org = self.set_effort("max")
        out = sup.send_live_effort(org, self.nid)
        self.assertEqual(out, {"delivery": "sent", "effort": "max"})
        self.settle()
        [req] = self.requests()
        self.assertEqual(req["type"], "control_request")
        self.assertTrue(req["request_id"].startswith("effort-"))
        self.assertEqual(req["request"], {"subtype": "apply_flag_settings",
                                          "settings": {"effortLevel": "max"}})
        rec = self.st["effort_live"]
        self.assertEqual((rec["effort"], rec["state"], rec["request_id"]),
                         ("max", "accepted", req["request_id"]))

    def test_a_refusing_cli_is_recorded_as_refused(self):
        self.start("refuse")
        out = sup.send_live_effort(self.set_effort("low"), self.nid)
        self.assertEqual(out["delivery"], "sent")
        self.settle()
        self.assertEqual(self.st["effort_live"]["state"], "refused")
        self.assertEqual(self.st["effort_live"]["error"], "fixture refused")

    # §2
    def test_clearing_to_the_org_default_sends_the_resolved_level_never_null(self):
        self.start("effort")
        org = self.set_effort("", org_default="low")
        self.assertEqual(org.effective_effort(self.nid), "low")
        out = sup.send_live_effort(org, self.nid)
        self.assertEqual(out, {"delivery": "sent", "effort": "low"})
        self.settle()
        [req] = self.requests()
        self.assertEqual(req["request"]["settings"], {"effortLevel": "low"})

    # §3
    def test_an_exited_process_is_next_turn(self):
        self.start("plain")
        self.settle()
        # the runner has cleared its handle; simulate the race where a
        # snapshot still holds a process that has already exited
        dead = Mock()
        dead.poll.return_value = 0
        with sup._state_lock:
            self.st["responding"], self.st["proc"] = True, dead
        try:
            out = sup.send_live_effort(self.set_effort("max"), self.nid)
        finally:
            with sup._state_lock:
                self.st["responding"], self.st["proc"] = False, None
        self.assertEqual(out["delivery"], "next_turn")
        dead.stdin.write.assert_not_called()

    def test_a_closed_pipe_is_next_turn_not_an_error(self):
        broken = Mock()
        broken.poll.return_value = None
        broken.stdin.write.side_effect = OSError(22, "Invalid argument")
        with sup._state_lock:
            self.st["responding"], self.st["proc"] = True, broken
        try:
            out = sup.send_live_effort(self.set_effort("max"), self.nid)
        finally:
            with sup._state_lock:
                self.st["responding"], self.st["proc"] = False, None
        self.assertEqual(out["delivery"], "next_turn")
        self.assertIn("could not be reached", out["reason"])
        self.assertNotIn("effort_live", self.st)


class NextTurnTests(LiveEffortBase):
    """No process is touched when there is nothing live to send to."""

    def test_no_running_turn_is_next_turn(self):
        self.st["responding"], self.st["proc"] = False, None
        out = sup.send_live_effort(self.set_effort("max"), self.nid)
        self.assertEqual(out, {"delivery": "next_turn", "effort": "max",
                               "reason": "no turn is running"})

    def _live_mock(self):
        proc = Mock()
        proc.poll.return_value = None
        self.st["responding"], self.st["proc"] = True, proc
        self.addCleanup(lambda: self.st.update(responding=False, proc=None))
        return proc

    def test_haiku_has_no_effort_to_send(self):
        proc = self._live_mock()
        org = self.set_effort("max")
        org.node(self.nid)["model"] = "haiku"
        out = sup.send_live_effort(org, self.nid)
        self.assertEqual(out["delivery"], "next_turn")
        self.assertIn("haiku", out["reason"])
        proc.stdin.write.assert_not_called()

    def test_a_non_claude_lane_is_next_turn(self):
        proc = self._live_mock()
        org = self.set_effort("max")
        for tier in ("sol", "luna", "gemini", "openrouter-anything"):
            org.node(self.nid)["model"] = tier
            out = sup.send_live_effort(org, self.nid)
            self.assertEqual(out["delivery"], "next_turn", tier)
        proc.stdin.write.assert_not_called()

    def test_every_live_tier_is_a_claude_tier(self):
        from orgtree import providers
        self.assertLessEqual(set(sup.LIVE_EFFORT_TIERS), set(providers.CLAUDE_TIERS))
        self.assertNotIn("haiku", sup.LIVE_EFFORT_TIERS)


class WarmParkTests(LiveEffortBase):
    """§4 — the real runner serving a claimed warm process.

    The pool seams are patched so the turn is served warm and the result
    boundary reports the identity as UNCHANGED: that is the case a live change
    followed by a change back produces, and the one the identity hash alone
    cannot catch. `park_back` records instead of parking."""

    def setUp(self):
        super().setUp()
        self.parked = []
        self.wp = None
        ident = {k: "fixture" for k in warmpool.IDENTITY_COMPONENTS}
        self.stack.enter_context(patch.object(warmpool, "warm_decision", return_value=(True, True)))
        self.stack.enter_context(patch.object(warmpool, "eligible", return_value=(True, "")))
        self.stack.enter_context(patch.object(warmpool, "identity_snapshot", return_value=("H", ident)))
        self.stack.enter_context(patch.object(warmpool, "boundary_check", return_value=(True, True, "")))
        self.stack.enter_context(patch.object(warmpool, "journal_admit"))

        def claim(slug, nid, want_hash, comps):
            self.wp.attach()
            return self.wp, "warm-hit"
        self.stack.enter_context(patch.object(warmpool, "claim_snapshot", side_effect=claim))

        def park(wp, *a, **k):
            self.parked.append(wp)
            return True
        self.stack.enter_context(patch.object(warmpool, "park_back", side_effect=park))

    def start(self, mode):
        cmd = self.child_cmd(mode)
        self.stack.enter_context(patch.object(sup, "_build_cmd", return_value=cmd))
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.procs.append(proc)
        self.wp = warmpool.WarmProc(self.slug, self.nid, proc, "fixture-session", "H", "env")
        self.run_turn(mode)

    def settle(self):
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive(), "turn runner must reach its finally")

    def test_control_an_untouched_warm_process_is_parked(self):
        self.start("plain")
        self.settle()
        self.assertEqual(self.parked, [self.wp])

    def test_a_process_sent_a_live_level_is_never_parked(self):
        self.start("effort")
        out = sup.send_live_effort(self.set_effort("max"), self.nid)
        self.assertEqual(out["delivery"], "sent")
        self.settle()
        self.assertEqual(self.parked, [], "a live-changed process must not be reused")
        self.assertEqual(self.wp.exit_reason, "effort-sent-live")
        self.assertEqual(len(self.requests()), 1)

    def test_the_exit_reason_is_a_classified_vocabulary_word(self):
        from orgtree import turnread
        self.assertIn("effort-sent-live", turnread.DISCARDS)
        self.assertIn("effort-sent-live", warmpool.KILL_REASON_CLASS)


class ApiDoorTests(LiveEffortBase):
    """§5 — both doors report the delivery, and only after the save."""

    def setUp(self):
        super().setUp()
        self.seen = []

        def fake(org, nid):
            # the level must already be SAVED when a running turn is sent it
            self.seen.append((nid, store.load_org(self.slug).node(nid)["scope"].get("effort")))
            return {"delivery": "sent", "effort": org.effective_effort(nid)}
        self.stack.enter_context(patch.object(sup, "send_live_effort", side_effect=fake))

    def test_the_scope_call_reports_the_delivery(self):
        req = Request({"type": "http", "headers": []})
        out = api.node_scope(self.slug, self.nid, api.Scope(effort="xhigh"), req)
        self.assertEqual(out["effort_delivery"], {"delivery": "sent", "effort": "xhigh"})
        self.assertEqual(self.seen, [(self.nid, "xhigh")])

    def test_a_scope_call_without_effort_sends_nothing(self):
        req = Request({"type": "http", "headers": []})
        out = api.node_scope(self.slug, self.nid, api.Scope(charter="x"), req)
        self.assertNotIn("effort_delivery", out)
        self.assertEqual(self.seen, [])

    def test_retool_reports_the_delivery(self):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.hire(ledger.USER, None, "opus", 0, "boss")
            org.node(self.nid)["parent"] = "boss"
            store.save_org(org)
        req = Request({"type": "http", "headers": []})
        out = api.agent_call(api.AgentCall(org=self.slug, node="boss", tool="orgtree_retool",
                                           args={"node": self.nid, "effort": "low"}), req)
        self.assertEqual(out["effort_delivery"], {"delivery": "sent", "effort": "low"})
        self.assertEqual(self.seen, [(self.nid, "low")])


class PinTests(unittest.TestCase):
    """§6"""

    def test_the_measured_cli_version_is_pinned(self):
        self.assertEqual(sup.LIVE_EFFORT_MEASURED_CLI, "2.1.280")


if __name__ == "__main__":
    unittest.main()
