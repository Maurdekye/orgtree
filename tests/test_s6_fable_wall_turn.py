"""S6: a Fable-tier wall hit by a REAL turn freezes the agent on its own row,
then escalates org-wide in a separate transaction after that commit.

Drives the real turn runner (`_run_one_turn`) against a fake CLI that emits
the captured Fable message ("You've reached your Fable 5 limit…", the
2026-08-07 capture `_looks_like_fable_tier_limit` keys on), the same harness
test_freeze_classification uses for the Claude lane. Before S6 the freeze and
`fable_limit_hit` shared one whole-document save under DOC_LOCK; now:

  * the agent is frozen and every live Fable node is limit-locked, as before;
  * `_fable_limit_escalate` is called exactly once, with NO transaction open,
    and the agent's freeze is already committed when it runs;
  * the negative control: a non-Fable agent hitting an ordinary session limit
    freezes but never escalates.
"""
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-s6-fable-wall-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

import import_provenance  # noqa: F401,E402

from orgtree import (accounts, ledger, orgtx, store,  # noqa: E402
                     supervisor as sup, warmpool)

_FABLE = ("You've reached your Fable 5 limit. Run /usage-credits to continue "
          "or switch models with /model.")
_SESSION = "Claude AI usage limit reached|1789600000"

_CHILD = r'''
import json,sys
text=sys.argv[1]
def emit(e):print(json.dumps(e),flush=True)
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':[]})
sys.stdin.readline()
emit({'type':'assistant','message':{'id':'a','role':'assistant',
      'model':'<synthetic>','content':[{'type':'text','text':text}],
      'usage':{'output_tokens':0}}})
emit({'type':'result','subtype':'success','is_error':True,
      'api_error_status':429,'result':text,
      'total_cost_usd':0,'usage':{'output_tokens':0}})
sys.exit(1)
'''


class FableWallTurn(unittest.TestCase):

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f"s6-fable-wall-{self.seq}"
        self.nid = "worker"
        self.dir = Path(_ROOT.name) / self.slug
        self.dir.mkdir(exist_ok=True)
        self.script = self.dir / "child.py"
        self.script.write_text(_CHILD, encoding="utf-8")
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "opus", 0, self.nid)
        org.hire(ledger.USER, None, "opus", 0, "buddy")
        org.node(self.nid)["session_id"] = "fixture-session"
        store.save_org(org)
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True,
                                                         exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st["busy"] = True
        self.procs = []
        self.calls = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        e = self.stack.enter_context
        e(patch.object(sup, "spawn_env", return_value={
            k: v for k, v in os.environ.items()
            if k.upper() in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")}))
        e(patch.object(sup, "_leash"))
        e(patch.object(sup, "_mcp_infrastructure_fingerprint",
                       return_value="fixture"))
        e(patch.object(sup, "_record_prompt_view"))
        e(patch.object(sup, "cli_diagnosis", return_value=None))
        e(patch.object(sup, "_limit_announce"))
        e(patch.object(sup, "notify"))
        e(patch.object(warmpool, "poke"))
        e(patch.object(warmpool, "warm_decision", return_value=(False, False)))
        e(patch.object(warmpool, "eligible", return_value=(False, "fixture")))
        e(patch.object(sup.appsettings, "wait_for_mcp_tools_enabled",
                       return_value=False))
        e(patch("orgtree.transcript_ingest.capture_safely"))
        e(patch.object(accounts, "record_limit", return_value=True))
        real = sup._fable_limit_escalate

        def spy(slug, nid, blob, until_ts):
            self.calls.append((orgtx.current_tx(slug),
                               store.load_org(slug).node(nid).get("frozen")))
            return real(slug, nid, blob, until_ts)
        e(patch.object(sup, "_fable_limit_escalate", spy))
        popen = subprocess.Popen

        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get("stdin") == subprocess.PIPE:
                self.procs.append(p)
            return p
        e(patch.object(subprocess, "Popen", side_effect=spawn))

    def tearDown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def fable(self, *nids):
        org = store.load_org(self.slug)
        for n in nids:
            org.node(n)["model"] = "fable"
        store.save_org(org)

    def drive(self, text):
        cmd = [sys.executable, str(self.script), text]
        self.stack.enter_context(patch.object(sup, "_build_cmd",
                                              return_value=cmd))
        thread = threading.Thread(
            target=lambda: sup._run_one_turn(self.slug, self.nid, "hello"),
            daemon=True)
        thread.start()
        thread.join(60)
        self.assertFalse(thread.is_alive(), "the turn runner must settle")

    def test_a_fable_wall_freezes_then_escalates_after_the_commit(self):
        self.fable(self.nid, "buddy")
        self.drive(_FABLE)
        org = store.load_org(self.slug)
        self.assertTrue((org.node(self.nid).get("frozen") or {}).get("limit"))
        self.assertTrue(org.d.get("fable_lock"), "the org-wide lock is set")
        self.assertTrue(org.node("buddy").get("limit_locked"))
        self.assertEqual(len(self.calls), 1, self.calls)
        tx_open, frozen_then = self.calls[0]
        self.assertIsNone(tx_open, "escalated inside the freeze transaction")
        self.assertIsNotNone(frozen_then,
                             "escalated before the freeze committed")

    def test_an_ordinary_limit_never_escalates(self):
        self.drive(_SESSION)
        org = store.load_org(self.slug)
        self.assertTrue((org.node(self.nid).get("frozen") or {}).get("limit"))
        self.assertEqual(self.calls, [])
        self.assertFalse(org.d.get("fable_lock"))


if __name__ == "__main__":
    unittest.main()
