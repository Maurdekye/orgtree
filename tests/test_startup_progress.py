"""Boot-host progress and failed-start cleanup use the same wire rules."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from engine.startup_progress import parse_progress

REPO = Path(__file__).resolve().parents[1]


class ProgressTests(unittest.TestCase):
    def test_only_advancing_matching_checkpoints_buy_time(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            good = dict(type="startup-progress", protocol=1, pid=123, dataRootId=str(root), sequence=2, phase="api-loaded")
            self.assertEqual(parse_progress(json.dumps(good), 123, root, 1), 2)
            for change in [dict(sequence=1), dict(sequence=True), dict(sequence="2"), dict(pid=1), dict(protocol=3),
                           dict(type="log"), dict(dataRootId="."), dict(dataRootId=str(root / "elsewhere")), dict(phase="")]:
                self.assertEqual(parse_progress(json.dumps({**good, **change}), 123, root, 1), 1)
            self.assertEqual(parse_progress("busy", 123, root, 1), 1)


@unittest.skipUnless(os.name == "nt", "INERT: boot host's guardian requires Windows")
class BootStartupTests(unittest.TestCase):
    def run_host(self, mode):
        with tempfile.TemporaryDirectory(prefix="orgtree-boot-progress-") as temp:
            folder = Path(temp).resolve()
            root = folder / "data"
            root.mkdir()
            (folder / "ui").mkdir()
            (folder / "ui/index.html").write_text("<!doctype html>")
            launcher = folder / "launch.py"
            launcher.write_text(f'''
import os,sys,time,json
from pathlib import Path
sys.path.insert(0,{str(REPO)!r})
from engine.process_lifetime import arm_process_lifetime
from engine.startup_progress import StartupProgress
root=Path(os.environ['ORGTREE_DATA'])
guardian=arm_process_lifetime(root,parent_pid=int(os.environ['ORGTREE_V2_PARENT_PID']))
progress=StartupProgress(root)
progress.report('lifetime-owned')
mode={mode!r}
if mode == 'progress':
    for i in range(4):
        time.sleep(.7)
        progress.report('stage-completed')
elif mode == 'duplicate':
    for i in range(20):
        time.sleep(.25)
        print(json.dumps(dict(type='startup-progress',protocol=1,pid=os.getpid(),dataRootId=str(root),sequence=1,phase='repeat')),flush=True)
else:
    time.sleep(60)
print(json.dumps(dict(type='ready',protocol=1,pid=os.getpid(),dataRootId=str(root),port=23002,guardianPid=guardian)),flush=True)
time.sleep(.8)
''', encoding="utf-8")
            env = {**os.environ, "ORGTREE_DATA": str(root), "ORGTREE_V2_DATA": str(root), "ORGTREE_V2_UI_DIR": str(folder / "ui")}
            script = f"from engine import service_host as h;h.__file__={str(folder / 'service_host.py')!r};h.READY_TIMEOUT=2;raise SystemExit(h.main())"
            started = time.monotonic()
            result = subprocess.run([sys.executable, "-c", script], cwd=REPO, env=env, capture_output=True, text=True, timeout=25)
            self.assertTrue((root / ".desktop-engine.lock").exists(), "positive control: the engine really armed its guardian; " + result.stderr)
            # A second process must be able to acquire the real same root lock
            # immediately after the host's failure return (no retry delay).
            from engine.process_lifetime import RootLock
            if mode != "progress":
                lock = RootLock(root)
                lock.close()
            else:
                # Normal host exit retains its prior guardian cleanup semantics.
                deadline = time.monotonic() + 5
                while True:
                    try:
                        lock = RootLock(root)
                        lock.close()
                        break
                    except RuntimeError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(.05)
            self.assertFalse((root / "engine-attach.json").exists())
            return result, time.monotonic() - started

    def test_progress_allows_boot_beyond_fixed_deadline(self):
        result, elapsed = self.run_host("progress")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("engine ready", result.stderr)
        self.assertGreater(elapsed, 2)

    def test_silence_and_duplicate_progress_fail_with_proven_release(self):
        for mode in ("silent", "duplicate"):
            with self.subTest(mode=mode):
                result, elapsed = self.run_host(mode)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("did not become ready in time", result.stderr)
                self.assertNotIn("release could not be verified", result.stderr)
                self.assertLess(elapsed, 8)


if __name__ == "__main__":
    unittest.main()
