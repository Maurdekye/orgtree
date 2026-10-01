"""A hung engine is ended and replaced; a slow one is left alone; a stall leaves its stacks.

Item v3-orgtree-froze-and-crashed-around-09-40-09-50z: on 2026-09-30 the live
engine stopped answering for ten minutes while its process stayed alive and
kept the root lock, so nothing could attach or start another engine. The boot
host now watches the engine's liveness route (engine/service_host.py) and the
engine dumps every thread's stack when it stalls (engine/stall_watch.py).

The host runs are the REAL host against a stub launch.py that arms the REAL
guardian and root lock (the tests/test_startup_progress.py pattern), so
"release proven" and "never two engines" are measured on the real lock.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import child_python  # a child Python imports THIS checkout's engine (tests/child_python.py)

from engine import service_host, stall_watch
from engine.service_host import EXIT_ENGINE_HUNG, LivenessWatch

REPO = Path(__file__).resolve().parents[1]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class LivenessWatchTests(unittest.TestCase):
    def watch(self, results):
        clock = Clock()
        answers = iter(results)
        return clock, LivenessWatch(lambda: next(answers), interval=1, deadline=300,
                                    min_failures=3, clock=clock)

    def test_hung_needs_both_the_silence_and_the_failed_probes(self):
        clock, watch = self.watch([None, "timeout", "timeout", "timeout", "timeout"])
        self.assertTrue(watch.check_once())
        for _ in range(3):
            watch.check_once()
        clock.now += 299
        self.assertFalse(watch.hung(), "three failures inside the deadline are contention")
        clock.now += 1
        self.assertTrue(watch.hung())
        self.assertEqual(watch.last_error, "timeout")

    def test_a_long_silence_with_too_few_failures_is_not_hung(self):
        clock, watch = self.watch(["timeout", "timeout"])
        watch.check_once(); watch.check_once()
        clock.now += 10_000
        self.assertFalse(watch.hung())

    def test_one_answer_resets_the_watch(self):
        clock, watch = self.watch(["timeout"] * 3 + [None])
        for _ in range(3):
            watch.check_once()
        clock.now += 400
        self.assertTrue(watch.hung())
        self.assertTrue(watch.check_once())
        self.assertFalse(watch.hung())
        self.assertEqual((watch.failures, watch.last_error), (0, None))

    def test_the_silence_is_counted_from_the_last_answer(self):
        clock, watch = self.watch([None] + ["timeout"] * 3)
        clock.now += 10_000
        self.assertTrue(watch.check_once())
        for _ in range(3):
            watch.check_once()
        clock.now += 299
        self.assertFalse(watch.hung(), "an engine that answered 299 s ago is not hung")
        self.assertEqual(watch.silent_for(), 299)
        clock.now += 1
        self.assertTrue(watch.hung())


class ProbeTests(unittest.TestCase):
    def serve(self, body, delay=0.0):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path != "/api/desktop/alive" or self.headers.get("X-Orgtree-Desktop-Token") != "tok":
                    self.send_response(401); self.end_headers(); return
                time.sleep(delay)
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_probe_accepts_only_the_engine_itself(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            port = self.serve({"protocol": 1, "pid": 42, "dataRootId": str(root)})
            self.assertIsNone(service_host.probe_engine(port, "tok", root, 42, 5))
            self.assertIsNotNone(service_host.probe_engine(port, "tok", root, 43, 5), "another pid")
            self.assertIsNotNone(service_host.probe_engine(port, "tok", root / "x", 42, 5), "another root")
            self.assertIsNotNone(service_host.probe_engine(port, "bad", root, 42, 5), "token refused")

    def test_a_probe_that_outlives_its_timeout_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            port = self.serve({"protocol": 1, "pid": 42, "dataRootId": str(root)}, delay=2.0)
            began = time.monotonic()
            self.assertIsNotNone(service_host.probe_engine(port, "tok", root, 42, 0.5))
            self.assertLess(time.monotonic() - began, 1.8)


class HostLoopTests(unittest.TestCase):
    def test_a_hung_engine_is_restarted_until_the_limit(self):
        with mock.patch.object(service_host, "HUNG_RESTART_LIMIT", 2), \
                mock.patch.object(service_host, "main", side_effect=[EXIT_ENGINE_HUNG] * 5) as run:
            self.assertEqual(service_host.run_host(), EXIT_ENGINE_HUNG)
        self.assertEqual(run.call_count, 3)

    def test_any_other_exit_ends_the_host(self):
        for code in (0, 1, 3, service_host.EXIT_ROOT_OWNED):
            with mock.patch.object(service_host, "main", side_effect=[EXIT_ENGINE_HUNG, code]) as run:
                self.assertEqual(service_host.run_host(), code)
            self.assertEqual(run.call_count, 2)

    def test_an_unproven_release_never_starts_another_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            watch = LivenessWatch(lambda: "timeout")
            with mock.patch.object(service_host, "failed_start_cleanup", return_value=False):
                code = service_host.end_hung_engine(mock.Mock(pid=4242), root, watch)
            self.assertEqual(code, 1, "only a proven release may return the restart code")
            events = [json.loads(line) for line in (root / service_host.LIVENESS_LOG).read_text().splitlines()]
            self.assertEqual([e["event"] for e in events], ["hung", "killed"])
            self.assertIs(events[1]["released"], False)


STUB = '''
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, {repo!r})
from engine.process_lifetime import arm_process_lifetime
root = Path(os.environ["ORGTREE_DATA"])
token = os.environ["ORGTREE_V2_TOKEN"]
guardian = arm_process_lifetime(root, parent_pid=int(os.environ["ORGTREE_V2_PARENT_PID"]))
with (root / "starts.txt").open("a") as f:
    f.write(f"{{os.getpid()}}\\n")
answers, delay, exit_after = {answers}, {delay}, {exit_after}
served = [0]
mutex = threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if self.headers.get("X-Orgtree-Desktop-Token") != token:
            self.send_response(401); self.end_headers(); return
        with mutex:
            served[0] += 1
            n = served[0]
        if n > answers:
            time.sleep(3600)  # HUNG: alive, holding the lock, never answering
        time.sleep(delay)
        raw = json.dumps(dict(protocol=1, pid=os.getpid(), dataRootId=str(root))).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps(dict(type="ready", protocol=1, pid=os.getpid(), dataRootId=str(root),
                      port=server.server_address[1], guardianPid=guardian)), flush=True)
if exit_after:
    time.sleep(exit_after)
    os._exit(3)
time.sleep(3600)
'''


def _alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


@unittest.skipUnless(os.name == "nt", "INERT: boot host's guardian requires Windows")
class HungEngineTests(unittest.TestCase):
    def run_host(self, *, answers, delay, exit_after, timeout, limit):
        temp = tempfile.TemporaryDirectory(prefix="orgtree-liveness-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name).resolve()
        root = folder / "data"
        root.mkdir()
        (folder / "ui").mkdir()
        (folder / "ui/index.html").write_text("<!doctype html>")
        (folder / "launch.py").write_text(STUB.format(repo=str(REPO), answers=answers, delay=delay,
                                                      exit_after=exit_after), encoding="utf-8")
        env = {**os.environ, "ORGTREE_V2_DATA": str(root), "ORGTREE_V2_UI_DIR": str(folder / "ui")}
        script = (f"from engine import service_host as h;h.__file__={str(folder / 'service_host.py')!r};"
                  f"h.LIVENESS_INTERVAL=.1;h.LIVENESS_PROBE_TIMEOUT={timeout};h.LIVENESS_DEADLINE=1.0;"
                  f"h.LIVENESS_MIN_FAILURES=2;h.HUNG_RESTART_LIMIT={limit};raise SystemExit(h.run_host())")
        result = subprocess.run(child_python.argv("-c", script, checkout=REPO), cwd=REPO, env=env,
                                capture_output=True, text=True, timeout=120)
        starts = [int(p) for p in (root / "starts.txt").read_text().split()]
        log = root / service_host.LIVENESS_LOG
        events = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return root, result, starts, events

    def test_a_hung_engine_is_killed_released_and_replaced(self):
        root, result, starts, events = self.run_host(answers=2, delay=0, exit_after=0, timeout=0.5, limit=1)
        self.assertEqual(result.returncode, EXIT_ENGINE_HUNG, result.stderr[-3000:])
        self.assertEqual(len(starts), 2, "the host started a fresh engine after the first hang, once")
        self.assertIn("starting a fresh engine after a hung one", result.stderr)
        self.assertEqual([e["event"] for e in events], ["hung", "killed", "hung", "killed"])
        self.assertEqual([e["enginePid"] for e in events], [starts[0], starts[0], starts[1], starts[1]])
        self.assertTrue(all(e["released"] is True for e in events if e["event"] == "killed"))
        self.assertTrue(all(e["failedProbes"] >= 2 and e["silentSeconds"] >= 1.0
                            for e in events if e["event"] == "hung"))
        for pid in starts:
            self.assertFalse(_alive(pid), f"hung engine {pid} is still running")
        # The real root lock is free the moment the host returns.
        from engine.process_lifetime import RootLock
        RootLock(root).close()
        self.assertFalse((root / service_host.DESCRIPTOR).exists())

    def test_a_slow_engine_that_still_answers_is_left_alone(self):
        # Every answer takes 0.3 s against a 2 s probe timeout, for three
        # times the 1 s deadline; then the engine exits 3 on its own.
        root, result, starts, events = self.run_host(answers=10_000, delay=0.3, exit_after=3.0,
                                                     timeout=2.0, limit=1)
        self.assertEqual(result.returncode, 3, result.stderr[-3000:])
        self.assertEqual(len(starts), 1)
        self.assertEqual(events, [], "an answering engine was declared hung")


class StallWatchTests(unittest.TestCase):
    def test_an_answered_probe_leaves_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / stall_watch.DUMP
            watch = stall_watch.StallWatch(path, lambda: True, stall_after=5)
            try:
                self.assertTrue(watch.check_once())
                self.assertTrue(watch.check_once())
            finally:
                watch._stream.close()
            self.assertEqual(path.stat().st_size, 0)

    def test_a_stall_writes_every_threads_stack(self):
        def stuck_in_the_probe() -> bool:
            time.sleep(1.5)
            return True
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / stall_watch.DUMP
            watch = stall_watch.StallWatch(path, stuck_in_the_probe, stall_after=0.4)
            try:
                self.assertTrue(watch.check_once() is False)
            finally:
                watch._stream.close()
            text = path.read_text(encoding="utf-8", errors="replace")
        self.assertIn("did not answer its liveness route within 0.4s", text)
        self.assertIn("stuck_in_the_probe", text, "the dump names the frame that was stuck")
        self.assertIn("--- thread MainThread", text, "threads are named")
        self.assertIn("most recent call last", text)
        self.assertIn("the probe answered after", text)

    def test_stall_dumps_while_other_threads_start_and_end(self):
        # Review F1 (f295f57): faulthandler's timed dump walks other threads
        # without the GIL and segfaulted a process like this one. The dump
        # must survive thread churn, and every stall must leave its stacks.
        # Run in a child so a crash is a failed exit code, not a dead runner.
        script = (
            "import threading, time, tempfile\n"
            "from pathlib import Path\n"
            "from engine import stall_watch\n"
            "stop = threading.Event()\n"
            "def churn():\n"
            "    while not stop.is_set():\n"
            "        t = threading.Thread(target=lambda: time.sleep(0.001)); t.start(); t.join()\n"
            "workers = [threading.Thread(target=churn, name=f'churn-{i}') for i in range(6)]\n"
            "[w.start() for w in workers]\n"
            "def slow():\n"
            "    time.sleep(0.03)\n"
            "    return True\n"
            "with tempfile.TemporaryDirectory() as temp:\n"
            "    path = Path(temp) / stall_watch.DUMP\n"
            "    watch = stall_watch.StallWatch(path, slow, stall_after=0.01)\n"
            "    results = [watch.check_once() for _ in range(150)]\n"
            "    stop.set(); [w.join() for w in workers]\n"
            "    watch._stream.close()\n"
            "    text = path.read_text(encoding='utf-8')\n"
            "print('stalls', results.count(False), 'dumps', text.count('every thread'),\n"
            "      'churn', text.count('--- thread churn-'))\n"
        )
        done = subprocess.run(child_python.argv("-c", script, checkout=REPO), cwd=REPO,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        words = done.stdout.split()
        stalls, dumps, churn = int(words[1]), int(words[3]), int(words[5])
        self.assertEqual(stalls, 150, "every probe outlived the stall deadline")
        self.assertEqual(dumps, 150, "every stall wrote its dump")
        self.assertGreaterEqual(churn, 150 * 6, "the busy threads are in every dump")

    def test_a_big_dump_file_rotates_at_start(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / stall_watch.DUMP
            path.parent.mkdir(parents=True)
            path.write_bytes(b"x" * (stall_watch.MAX_BYTES + 1))
            watch = stall_watch.StallWatch(path, lambda: True)
            watch._stream.close()
            self.assertEqual(path.stat().st_size, 0)
            self.assertEqual(path.with_name(path.name + ".1").stat().st_size, stall_watch.MAX_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
