"""Real launcher, 500 nodes / 20k entries, and a sweep held past readiness.

This is a startup-budget backstop; the deterministic walk budget lives beside
it. Its positive control reinstates the old synchronous lifespan ordering.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt", "INERT: real guardian/readiness budget requires Windows")
class StartupReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import fastapi, uvicorn  # missing dependencies must fail the CI backstop
        cls.temp = tempfile.TemporaryDirectory(prefix="orgtree-startup-live-shape-")
        cls.root = Path(cls.temp.name).resolve() / "data"
        cls.root.mkdir()
        cls.profile = cls.root.parent / "home"
        (cls.root / "synthetic-startup-root").write_text("test fixture")
        (cls.profile / ".claude/projects").mkdir(parents=True)
        (cls.root / "ui/assets").mkdir(parents=True)
        (cls.root / "ui/index.html").write_text("<!doctype html><title>fixture</title>")
        cls.env = {**os.environ, "ORGTREE_DATA": str(cls.root), "HOME": str(cls.profile),
                   "USERPROFILE": str(cls.profile), "ORGTREE_V2_TOKEN": "ab" * 32,
                   "ORGTREE_V2_UI_DIR": str(cls.root / "ui"), "PYTHONUNBUFFERED": "1",
                   "ORGTREE_V2_PARENT_PID": str(os.getpid())}
        for name in ("ORGTREE_PORT", "ORGTREE_V2_PORT", "ORGTREE_ACCOUNTS_CUTOVER", "ORGTREE_BASE", "ORGTREE_KIOSK"):
            cls.env.pop(name, None)
        result = subprocess.run([sys.executable, "tests/startup_engine_probe.py", "seed"], cwd=REPO,
                                env=cls.env, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def launch(self, mode):
        for name in ("repair-entered", "repair-completed", "release-repair"):
            (self.root / name).unlink(missing_ok=True)
        self.log = (self.root / "launcher-test.log").open("wb")
        child = subprocess.Popen([sys.executable, "tests/startup_engine_probe.py", mode], cwd=REPO,
                                 env=self.env, stdout=subprocess.PIPE, stderr=self.log)
        self.addCleanup(self.stop, child)
        self.lines = queue.Queue()
        def read():
            for line in child.stdout:
                self.lines.put(line.decode("utf-8", "replace"))
            self.lines.put("")
        threading.Thread(target=read, daemon=True).start()
        return child

    def ready(self, budget):
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                return None
            if not line:
                self.fail((self.root / "launcher-test.log").read_text(errors="replace")[-4000:])
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and value.get("type") == "ready":
                return value
        return None

    def wait_file(self, name, budget=10):
        deadline = time.monotonic() + budget
        while not (self.root / name).exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.root / name).exists(), name)

    def stop(self, child):
        (self.root / "release-repair").write_text("release")
        from engine.service_host import failed_start_cleanup
        try:
            self.assertTrue(failed_start_cleanup(child, self.root), "fixture tree must release before cleanup")
        finally:
            child.stdout.close()
            self.log.close()

    def test_ready_inside_budget_while_repair_is_blocked_and_writes_wait(self):
        started = time.monotonic()
        child = self.launch("background")
        ready = self.ready(15)
        self.assertIsNotNone(ready, "ready must not wait for the deliberately blocked fleet sweep")
        elapsed = time.monotonic() - started
        self.wait_file("repair-entered")
        self.assertFalse((self.root / "repair-completed").exists())
        self.assertEqual(ready["pid"], child.pid)
        self.assertEqual(Path(ready["dataRootId"]).resolve(), self.root)
        base = f"http://127.0.0.1:{ready['port']}"
        request = urllib.request.Request(base + "/api/desktop/identity", headers={"X-Orgtree-Desktop-Token": "ab" * 32})
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertEqual(json.load(response)["pid"], child.pid)
        request = urllib.request.Request(base + "/api/desktop/status", headers={"X-Orgtree-Desktop-Token": "ab" * 32})
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertFalse(json.load(response)["idle"], "pending recovery cannot authorize idle maintenance")
        def write():
            req = urllib.request.Request(base + "/api/startup-control", data=b"", method="POST",
                                         headers={"X-Orgtree-Desktop-Token": "ab" * 32})
            try:
                urllib.request.urlopen(req, timeout=15).close()
            except urllib.error.HTTPError as exc:
                return exc.code
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(write)
            try:
                time.sleep(0.2)
                self.assertFalse(pending.done(), "API writes may not overtake repair")
            finally:
                (self.root / "release-repair").write_text("release")
            self.assertIn(pending.result(15), (404, 405))
        self.wait_file("repair-completed")
        self.assertEqual((self.root / "repair-completed").read_text(), "1")
        print(f"real 500-node/20k-entry engine ready: {elapsed:.3f}s while sweep held; repair: one imports walk", flush=True)

    def test_positive_control_old_lifespan_order_misses_budget(self):
        self.launch("synchronous-control")
        self.wait_file("repair-entered")
        self.assertIsNone(self.ready(2), "control must detect readiness blocked by a fleet sweep")
        (self.root / "release-repair").write_text("release")
        self.assertIsNotNone(self.ready(15), "control must also recognize a genuine ready line")
        self.wait_file("repair-completed")


if __name__ == "__main__":
    unittest.main()
