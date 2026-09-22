"""Missing UI coverage, arbitrary crashes and orphaned descendants cannot pass."""
from __future__ import annotations

import copy
import ctypes
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from v3_qualification import ui, runner

SOURCE = {"head":"a"*40,"status":""}


def payload(mode):
    checks = [{"id":name,"ok":name not in ui.FAILURES[mode]} for name in ui.ROSTERS[mode]]
    return {"mode":mode,"checks":checks,"summary":{"assertions":len(checks),
        "failing":sum(not c["ok"] for c in checks)},"limits":ui.PROBE_LIMITS}


def validate(receipt, mode="baseline", **overrides):
    arguments = dict(source={**SOURCE,"mode":mode,"entry":"apps/desktop/renderer/src/main.tsx"},
        http={"requests":["GET /api/orgs"],"unexpected":[]},mode=mode,
        exit_code=0 if mode == "baseline" else 1,expected_source=SOURCE)
    arguments.update(overrides)
    return ui.probe_errors(receipt,**arguments)


class UiReceiptTests(unittest.TestCase):
    def test_declared_baseline_and_four_discriminating_controls(self):
        self.assertEqual(len(ui.BASELINE),57)
        for mode in ui.ROSTERS:
            with self.subTest(mode=mode):
                self.assertEqual(validate(payload(mode),mode),[])

    def test_empty_missing_duplicate_unknown_or_nonboolean_check_fails(self):
        good = payload("baseline")
        for checks in ([],good["checks"][:-1],good["checks"]+[good["checks"][0]],
                       [{"id":"invented","ok":True},*good["checks"][1:]],
                       [{"id":good["checks"][0]["id"],"ok":1},*good["checks"][1:]]):
            self.assertTrue(validate({**good,"checks":checks}))

    def test_crashes_unrelated_failures_and_missing_mechanism_are_not_controls(self):
        for mode in list(ui.ROSTERS)[1:]:
            good = payload(mode)
            self.assertTrue(validate(good,mode,exit_code=2))
            self.assertTrue(validate(good,mode,exit_code=None))
            changed = copy.deepcopy(good)
            # A missing expected failure or a new unrelated failure both refuse.
            changed["checks"][0]["ok"] = not changed["checks"][0]["ok"]
            self.assertTrue(validate(changed,mode))
            self.assertTrue(validate({**good,"checks":[*good["checks"],{"id":"fatal","ok":False}]},mode))
            self.assertTrue(validate({**good,"checks":[{**c,"ok":True} for c in good["checks"]]},mode))

    def test_false_summary_source_or_http_and_promoted_boundaries_fail(self):
        good = payload("baseline")
        for value in ({"assertions":0,"failing":0},{"assertions":57,"failing":False},None):
            self.assertTrue(validate({**good,"summary":value}))
        self.assertTrue(validate({**good,"limits":[]}))
        self.assertTrue(validate({**good,"mode":"no-bus"}))
        self.assertTrue(validate(good,source={**SOURCE,"head":"b"*40}))
        self.assertTrue(validate(good,http={"requests":[],"unexpected":[]}))
        self.assertTrue(validate(good,http={"requests":["GET /api/live"],"unexpected":["GET /api/live"]}))

    def test_source_status_preserves_spaces_and_newlines(self):
        source = {**SOURCE,"status":" M example.py\n?? added.py\n"}
        receipt = {**source,"mode":"baseline","entry":"apps/desktop/renderer/src/main.tsx"}
        self.assertEqual(validate(payload("baseline"),source=receipt,expected_source=source),[])
        self.assertTrue(validate(payload("baseline"),source=receipt,
                                 expected_source={**source,"status":source["status"].strip()}))

    def test_oversized_or_linked_receipts_are_refused(self):
        with tempfile.TemporaryDirectory() as name:
            file = Path(name)/"result.json"
            file.write_bytes(b" "*2_000_001)
            with self.assertRaises(ValueError): ui.read_json(file)
            file.write_text("{}")
            with patch.object(Path,"is_symlink",return_value=True):
                with self.assertRaises(ValueError): ui.read_json(file)

    @unittest.skipUnless(os.name == "nt", "Windows-only UI adapter")
    def test_adapter_requires_positive_baseline_before_accepting_controls(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            def run(repo, interpreter, command, env, directory, timeout):
                mode = command[-1]
                run = Path(command[-2])/(mode+"-synthetic")
                run.mkdir(parents=True)
                receipt = payload(mode)
                if mode == "baseline": receipt["checks"].pop()
                for file,value in (("result.json",receipt),("source.json",{**SOURCE,"mode":mode,
                    "entry":"apps/desktop/renderer/src/main.tsx"}),("http.json",{"requests":["GET /api/orgs"],"unexpected":[]})):
                    (run/file).write_text(json.dumps(value))
                return {"tree_cleanup_completed":True,"errors":[],"exit_code":0 if mode == "baseline" else 1}
            with patch.object(ui,"run_owned",side_effect=run), patch.object(ui.shutil,"which",return_value="node"), \
                    patch.object(ui.subprocess,"check_output",side_effect=[SOURCE["head"],SOURCE["status"]]):
                rows,controls,errors = ui.run_ui(Path.cwd(),root,sys.executable,{},10)
            self.assertEqual(len(controls),4)
            self.assertEqual(rows[0]["classification"],"failed")
            self.assertTrue(errors)
            self.assertTrue(all(c["detected"] and not c["baseline_passed"] and c["classification"] == "failed" for c in controls))


def alive(pid):
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32",use_last_error=True)
    k.OpenProcess.argtypes = [w.DWORD,w.BOOL,w.DWORD]
    k.OpenProcess.restype = w.HANDLE
    k.WaitForSingleObject.argtypes = [w.HANDLE,w.DWORD]
    k.CloseHandle.argtypes = [w.HANDLE]
    handle = k.OpenProcess(0x00100000,False,pid)
    if not handle: return False
    try: return k.WaitForSingleObject(handle,0) == 258
    finally: k.CloseHandle(handle)


@unittest.skipUnless(os.name == "nt", "Windows process ownership")
class UiProcessTests(unittest.TestCase):
    def exercise(self, timeout):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="orgtree-ui-ownership-test-") as name:
            root = Path(name)
            for directory in ("home","data","temp"): (root/directory).mkdir()
            leaf = "import time; time.sleep(90)"
            child = "import subprocess,sys,json,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',sys.argv[2]]);Path(sys.argv[1]).write_text(json.dumps([__import__('os').getpid(),p.pid]));time.sleep(90)"
            command = root/"command.py"
            command.write_text("""import subprocess,sys,time
from pathlib import Path
subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1],sys.argv[3]])
deadline=time.monotonic()+5
while not Path(sys.argv[1]).exists() and time.monotonic()<deadline: time.sleep(.01)
if not Path(sys.argv[1]).exists(): raise SystemExit(8)
if sys.argv[4]=='timeout': time.sleep(90)
""")
            result = ui.run_owned(repo,sys.executable,[sys.executable,"-B",str(command),str(root/"pids.json"),
                child,leaf,"timeout" if timeout else "exit"],runner.child_env(root),root,5)
            self.assertTrue(result["tree_cleanup_completed"],result)
            self.assertEqual(result["timed_out"],timeout,result)
            self.assertTrue((root/"pids.json").is_file(),result)
            self.assertTrue(all(not alive(pid) for pid in json.loads((root/"pids.json").read_text())))
            self.assertFalse(alive(result["launcher_pid"]))
            if not timeout: self.assertEqual(result["exit_code"],0,result)

    def test_timeout_removes_real_child_and_grandchild(self): self.exercise(True)

    def test_successful_launcher_exit_also_removes_orphans(self): self.exercise(False)

    def test_failed_ownership_never_starts_command(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            command = [sys.executable,"-c","from pathlib import Path;import sys;Path(sys.argv[1]).touch()",str(root/"ran")]
            module = SimpleNamespace(WindowsTree=lambda *args: (_ for _ in ()).throw(RuntimeError("assignment refused")))
            spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with patch.object(ui.importlib.util,"spec_from_file_location",return_value=spec), \
                    patch.object(ui.importlib.util,"module_from_spec",return_value=module):
                result = ui.run_owned(repo,sys.executable,command,dict(os.environ),root,5)
            self.assertIn("assignment refused",str(result["errors"]))
            self.assertTrue(result["tree_cleanup_completed"])
            self.assertFalse((root/"ran").exists())
            self.assertFalse(alive(result["launcher_pid"]))


if __name__ == "__main__": unittest.main()
