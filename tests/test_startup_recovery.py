"""Readiness and lifetime controls remain live while writes await recovery."""
import asyncio
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

_temp = tempfile.TemporaryDirectory(prefix="orgtree-recovery-barrier-")
os.environ["ORGTREE_DATA"] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import startup


class StartupOrderingTests(unittest.TestCase):
    def test_real_startup_orders_warming_replay_then_drivers_and_stops_on_failure(self):
        from orgtree import api, store, supervisor, warmpool, net, transcript_ingest
        for broken in (False, True):
            calls = []
            def reconcile(*args, **kwargs):
                calls.append("reconcile")
                if broken:
                    raise OSError("recovery failed")
                return []
            org = SimpleNamespace(heal_plan_stamps=lambda: None)
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, {"ORGTREE_KIOSK": ""}))
                stack.enter_context(patch.object(startup, "recovery", startup.Recovery()))
                stack.enter_context(patch.object(store, "list_orgs", return_value=[{"slug": "fixture"}]))
                stack.enter_context(patch.object(store, "load_org", return_value=org))
                stack.enter_context(patch.object(api, "_prune_stage"))
                stack.enter_context(patch.object(warmpool, "start_warm_pool", side_effect=lambda: calls.append("warm")))
                stack.enter_context(patch.object(transcript_ingest, "start"))
                stack.enter_context(patch.object(net, "start_net_client", side_effect=lambda: calls.append("net")))
                stack.enter_context(patch.object(api.restart_wake, "on_backend_startup", side_effect=lambda: calls.append("wake")))
                stack.enter_context(patch.object(supervisor, "reconcile", side_effect=reconcile))
                for name in dir(supervisor):
                    if name.startswith("start_"):
                        stack.enter_context(patch.object(supervisor, name, side_effect=lambda name=name: calls.append(name)))
                if broken:
                    with self.assertRaisesRegex(OSError, "recovery failed"):
                        api._recover_startup()
                    self.assertEqual(calls, ["warm", "reconcile"], "no automatic driver may overtake failed repair")
                else:
                    api._recover_startup()
                    self.assertEqual(calls[:2], ["warm", "reconcile"])
                    self.assertIn("start_auto_resume_loop", calls)
                    self.assertIn("start_working_cache_keeper", calls)
                    self.assertIn("net", calls)
                    self.assertEqual(calls[-1], "wake")


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_unblocks_waiting_requests_without_admitting_them(self):
        release = threading.Event()
        rec = startup.Recovery()
        rec.start(lambda: release.wait(3))
        waiting = asyncio.create_task(rec.wait())
        try:
            await asyncio.sleep(0)
            self.assertTrue(rec.pending)
            self.assertFalse(waiting.done())
            await asyncio.to_thread(rec.cancel)
            with self.assertRaisesRegex(RuntimeError, "did not finish"):
                await asyncio.wait_for(waiting, 1)
        finally:
            release.set()
            await rec.task

    async def test_writes_wait_for_repair_while_reads_and_shutdown_pass(self):
        repair_entered, repair_release = threading.Event(), threading.Event()
        repaired = []
        def repair():
            repair_entered.set()
            if not repair_release.wait(5):
                raise RuntimeError("fixture repair was never released")
            repaired.append("interrupted-turn")
        rec = startup.Recovery()
        rec.start(repair)
        seen = []
        async def endpoint(scope, receive, send):
            seen.append(scope["path"])
            if scope["path"] == "/api/message":
                self.assertEqual(repaired, ["interrupted-turn"])
        barrier = startup.RecoveryBarrier(endpoint)
        async def call(path, method):
            await barrier({"type": "http", "path": path, "method": method}, None, None)
        with patch.object(startup, "recovery", rec):
            write = asyncio.create_task(call("/api/message", "POST"))
            try:
                self.assertTrue(await asyncio.to_thread(repair_entered.wait, 2))
                await call("/api/tree", "GET")
                await call("/api/desktop/shutdown", "POST")
                await asyncio.sleep(0)
                self.assertFalse(write.done(), "positive control: blocked repair must hold a write")
                self.assertEqual(seen, ["/api/tree", "/api/desktop/shutdown"])
            finally:
                repair_release.set()
                await asyncio.wait_for(write, 3)
                await rec.task
        self.assertEqual(seen[-1], "/api/message")

    async def test_failure_is_503_not_silent_success_or_permanent_wait(self):
        rec = startup.Recovery()
        def broken():
            raise OSError("repair control")
        rec.start(broken)
        await rec.task
        sent = []
        async def send(msg):
            sent.append(msg)
        async def forbidden(*args):
            self.fail("a failed recovery admitted a write")
        with patch.object(startup, "recovery", rec):
            await startup.RecoveryBarrier(forbidden)({"type": "http", "method": "POST", "path": "/mcp"}, None, send)
        self.assertEqual(sent[0]["status"], 503)
        self.assertIn(b"Startup recovery did not finish", sent[1]["body"])


if __name__ == "__main__":
    unittest.main()
