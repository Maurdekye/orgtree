"""Real pipes and the real turn runner: cold stderr pressure and launcher death.

Every process and ledger is a local fixture. No provider/auth/home is inherited.
The Windows wrapper reproduces the npm .cmd launcher in the hire-tool incident.
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

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-pipe-lifecycle-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
os.environ["ORGTREE_TURNLOG"] = "1"
from orgtree import ledger, store, supervisor as sup, warmpool

_CHILD = r'''
import json,os,sys,time
from pathlib import Path
mode,marker=sys.argv[1:]
def emit(event):print(json.dumps(event),flush=True)
def result():emit({'type':'result','subtype':'success','is_error':False,'total_cost_usd':0,'usage':{'output_tokens':1}})
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':['mcp__orgtree__orgtree_status']})
sys.stdin.readline()
Path(marker).write_text(str(os.getpid()))
emit({'type':'assistant','message':{'id':'a','role':'assistant','content':[{'type':'text','text':'working'}],'usage':{'output_tokens':1}}})
emit({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'test','content':'tests 8, pass 8, fail 0'}]}})
if mode=='flood':
 sys.stderr.write('diagnostic\n'*100000);sys.stderr.flush()
 emit({'type':'assistant','message':{'id':'b','role':'assistant','content':[{'type':'text','text':'after stderr'}],'usage':{'output_tokens':1}}})
 result()
 for line in sys.stdin:pass
elif mode=='interrupt':
 for line in sys.stdin:
  if json.loads(line).get('type')=='control_request':result();break
 for line in sys.stdin:pass
else:
 while True:time.sleep(1)
'''


def eventually(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.02)
    return bool(predicate())


def windows_alive(pid):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        kernel.CloseHandle(handle)


class ClaudePipeLifecycleTests(unittest.TestCase):
    seq = 0

    def setUp(self):
        self.assertEqual(Path(store.DATA_ROOT), Path(_ROOT.name))
        type(self).seq += 1
        self.slug = f"pipe-{self.seq}"
        self.nid = "worker"
        self.dir = Path(_ROOT.name) / self.slug
        self.dir.mkdir()
        self.script = self.dir / "child.py"
        self.script.write_text(_CHILD, encoding="utf-8")
        self.marker = self.dir / "child.pid"
        org = store.create_org(self.slug)
        # An isolated fully formed ledger node; it has no account binding.
        org.hire(ledger.USER, None, "opus", 0, self.nid)
        org.node(self.nid)["session_id"] = "fixture-session"
        store.save_org(org)
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True, exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st["busy"] = True
        self.follow = []
        self.thread = None
        self.procs = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(sup, "spawn_env", return_value={
            k:v for k,v in os.environ.items()
            if k.upper() in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")
        }))
        self.stack.enter_context(patch.object(sup, "_leash"))
        self.stack.enter_context(patch.object(sup, "_mcp_infrastructure_fingerprint", return_value="fixture"))
        self.stack.enter_context(patch.object(sup, "_record_prompt_view"))
        self.stack.enter_context(patch.object(sup, "cli_diagnosis", return_value=None))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(warmpool, "warm_decision", return_value=(False, False)))
        self.stack.enter_context(patch.object(warmpool, "eligible", return_value=(False, "fixture")))
        self.stack.enter_context(patch.object(sup.appsettings, "wait_for_mcp_tools_enabled", return_value=False))
        self.stack.enter_context(patch("orgtree.transcript_ingest.capture_safely"))
        popen = subprocess.Popen
        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get("stdin") == subprocess.PIPE:
                self.procs.append(p)
            return p
        self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=spawn))

    def tearDown(self):
        # On the pre-fix arm the wrapper is already dead, so taskkill /T on
        # that PID cannot find the surviving fixture child. Reap our OWN child.
        if self.marker.exists():
            pid = int(self.marker.read_text())
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                               capture_output=True, timeout=5,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                try:os.kill(pid, 9)
                except ProcessLookupError:pass
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

    def start(self, mode, *, wrapped=False):
        cmd = [sys.executable, str(self.script), mode, str(self.marker)]
        if wrapped:
            cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", *cmd]
        self.stack.enter_context(patch.object(sup, "_build_cmd", return_value=cmd))
        self.thread = threading.Thread(target=lambda: self.follow.append(
            sup._run_one_turn(self.slug, self.nid, {"cmd": True, "text": "/fixture"})), daemon=True)
        self.thread.start()
        self.assertTrue(eventually(self.marker.exists), self.st.get("last_error"))

    def assert_settled(self, timeout=3):
        self.thread.join(timeout)
        self.assertFalse(self.thread.is_alive(), "turn runner must reach its finally")
        self.assertFalse(self.st["responding"])
        self.assertIsNone(self.st["proc"])
        self.assertFalse(list((Path(_ROOT.name)/"turnlog"/self.slug/self.nid).glob("*.partial.json")),
                         "outer turn recorder must finalize")
        records = list((Path(_ROOT.name)/"turnlog"/self.slug/self.nid).glob("*.json"))
        self.assertEqual(len(records), 1, "one finalized record must replace the stub")
        self.record = json.loads(records[0].read_text(encoding="utf-8"))

    def test_cold_stderr_pressure_cannot_stop_stdout_or_turn_settlement(self):
        self.start("flood")
        self.assert_settled()
        self.assertIsNone(self.st.get("last_error"))
        self.assertFalse(self.st["busy"])

    @unittest.skipUnless(os.name == "nt", "the incident used a Windows command wrapper")
    def test_idle_watchdog_ends_launcher_and_child_then_returns_queued_mail(self):
        self.stack.enter_context(patch.object(sup, "TURN_IDLE", .2))
        self.start("silent", wrapped=True)
        pending = {"text": "queued followup"}
        self.st["queue"].append(pending)
        self.assert_settled(timeout=7)
        self.assertEqual(self.follow, [pending])
        self.assertTrue(self.st["busy"], "queued successor still owns the turn slot handoff")
        self.assertIn("idle watchdog", self.st["last_error"])
        self.assertEqual(self.record["outcome"], "killed")
        self.assertIsNotNone(self.procs[0].poll())
        self.assertTrue(eventually(lambda: not windows_alive(int(self.marker.read_text()))),
                        "the watchdog must terminate the CLI child as well as the launcher")

    def test_readiness_wait_also_drains_stderr_before_the_first_prompt(self):
        # Emit more than a pipeful before init. The readiness gate must be
        # able to see init without waiting for the child to finish the turn.
        self.script.write_text(_CHILD.replace(
            "emit({'type':'system'", "sys.stderr.write('startup diagnostic\\n'*20000);sys.stderr.flush()\n"
            "emit({'type':'system'", 1), encoding="utf-8")
        self.stack.enter_context(patch.object(sup.appsettings,
            "wait_for_mcp_tools_enabled", return_value=True))
        self.start("flood")
        self.assert_settled()
        self.assertIsNone(self.st.get("last_error"))

    @unittest.skipUnless(os.name == "nt", "Windows inherited-pipe cleanup")
    def test_expiry_releases_reader_even_when_a_child_keeps_the_pipe_open(self):
        self.stack.enter_context(patch.object(sup, "TURN_IDLE", .2))
        # Simulate failed tree cleanup: only the shell dies. The reader must
        # still return and report timeout, independently of pipe EOF.
        self.stack.enter_context(patch.object(sup, "_wd_kill_tree",
                                              side_effect=lambda p: p.kill()))
        self.start("silent", wrapped=True)
        self.assert_settled(timeout=7)
        self.assertIn("idle watchdog", self.st["last_error"])
        self.assertEqual(self.record["outcome"], "killed")
        self.assertFalse(self.st["busy"])

    def test_interrupt_does_not_claim_success_for_an_exited_launcher(self):
        proc = Mock()
        proc.poll.return_value = 1
        self.st.update(proc=proc, responding=True)
        result = sup.interrupt_turn(self.slug, self.nid)
        self.assertFalse(result["interrupted"])
        self.assertIn("exited", result["reason"])
        proc.stdin.write.assert_not_called()
        self.assertNotIn("interrupted", self.st)
        self.st.update(proc=None, responding=False, busy=False)

    def test_cold_stderr_is_bounded_and_journal_failure_cannot_stop_drain(self):
        self.script.write_text(
            "import sys;sys.stderr.write('x'*1000000+'tail-marker');sys.stderr.flush()",
            encoding="utf-8")
        proc = subprocess.Popen([sys.executable, str(self.script)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8")
        self.procs.append(proc)
        with patch.object(warmpool, "journal_cache_break_lines", side_effect=OSError("fixture")):
            drain = warmpool.ColdStderr(proc, self.slug, self.nid, "fixture")
            proc.wait(timeout=3)
            text = drain.text()
        self.assertTrue(text.endswith("tail-marker"))
        self.assertLessEqual(len(text), 65536)
        self.assertFalse(drain.thread.is_alive())

    def test_cold_cache_warning_is_observed_before_process_exit(self):
        self.script.write_text(
            "import sys,time;sys.stderr.write('[PROMPT CACHE BREAK] fixture-warning\\n');"
            "sys.stderr.flush();time.sleep(30)", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, str(self.script)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8")
        self.procs.append(proc)
        with patch.object(warmpool, "_journal") as journal:
            drain = warmpool.ColdStderr(proc, self.slug, self.nid, "fixture")
            self.assertTrue(eventually(lambda: journal.call_count == 1))
            self.assertIsNone(proc.poll())
            self.assertEqual(journal.call_args.args, ("cache-break",))
            self.assertIn("fixture-warning", str(journal.call_args.kwargs))
            proc.kill()
            proc.wait(timeout=3)
            self.assertIn("fixture-warning", drain.text())

    def test_archive_interrupt_waits_for_real_settlement(self):
        self.start("interrupt")
        warnings = sup.interrupt_before_archive(
            self.slug, store.load_org(self.slug), self.nid, timeout=3)
        self.assertEqual(warnings, [])
        self.assert_settled()
        self.assertFalse(self.st["busy"])

    def test_warm_output_consumer_can_stop_without_pipe_eof(self):
        import queue
        wp = object.__new__(warmpool.WarmProc)
        wp.lines = queue.Queue()
        wp.lines.put("buffered event")
        wp.lines.put(None)
        self.assertEqual(list(wp.lines_iter()), ["buffered event"])
        wp.lines = queue.Queue()
        stop = threading.Event()
        got = []
        thread = threading.Thread(target=lambda: got.extend(wp.lines_iter(stop=stop)))
        thread.start()
        stop.set()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(got, [])

    def test_graceful_interrupt_still_yields_a_turn_boundary(self):
        self.start("interrupt")
        self.assertEqual(sup.interrupt_turn(self.slug, self.nid), {"interrupted": True})
        self.assert_settled()
        self.assertIsNone(self.st.get("last_error"))
        self.assertFalse(self.st["busy"])


if __name__ == "__main__":
    unittest.main()
