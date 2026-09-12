"""User invariant: 'A turn cannot run while its agent is halted.'

Binding source: docs/v2-user-decisions.md, 12 September 2026. A successful
halt is a settlement boundary, not just a sent interrupt signal. Every test
uses an isolated data root and fake provider workers; no live agents run.
"""
from contextlib import ExitStack
import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-agent-halt-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import halt, ledger, store, supervisor as sup, warmpool
_real_warm_kill = warmpool.kill_node


class AgentHaltTests(unittest.TestCase):
    def setUp(self):
        self.slug = "halt-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.nid = "worker"
        self.st = sup.state(self.slug, self.nid)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "_cancel_working_cache"))
        self.stack.enter_context(patch.object(warmpool, "kill_node"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        self.stack.close()
        store._POOL.close_all(self.slug)

    def org(self):
        return store.load_org(self.slug)

    def mail(self, text="pending", kind="message"):
        with store.DOC_LOCK:
            org = self.org()
            org.post_mail(ledger.USER, self.nid, text, kind)
            store.save_org(org)

    def stop(self, **kw):
        return halt.halt(self.slug, self.nid, **kw)

    def test_idle_halt_blocks_all_direct_and_mail_admission(self):
        self.assertTrue(self.stop()["halted"])
        self.mail()
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with patch.object(sup, "_run_one_turn_recorded") as run:
            for kwargs in ({}, {"mail_ping": True}, {"command": True},
                           {"wake": False}, {"idle_only": True}):
                r = sup.send_message(self.slug, self.nid, "wake", **kwargs)
                self.assertEqual(r["deferred"], "halted")
            sup._run_turn(self.slug, self.nid, "rogue direct worker")
            sup._run_one_turn(self.slug, self.nid, "rogue direct turn")
            run.assert_not_called()
        self.assertEqual(self.org().d["mail"][self.nid], before)
        self.assertFalse(self.st["busy"])
        self.assertFalse(halt._workers.get((self.slug, self.nid)))

    def test_halt_waits_for_finalizer_and_refuses_early_unhalt(self):
        started, killed, release, finished = (threading.Event() for _ in range(4))

        class Proc:
            def poll(self):
                return 0 if killed.is_set() else None
        self.st["proc"] = Proc()

        @halt.worker
        def active(slug, nid):
            self.st["busy"] = True
            started.set()
            killed.wait(3)
            release.wait(3)  # deliberately keep accounting/finally unfinished
            self.st["busy"] = False
            finished.set()

        self.stack.enter_context(patch.object(sup, "_wd_kill_tree", side_effect=lambda p: killed.set()))
        worker = threading.Thread(target=active, args=(self.slug, self.nid))
        worker.start()
        self.assertTrue(started.wait(1))
        result = []
        stopper = threading.Thread(target=lambda: result.append(self.stop()))
        stopper.start()
        try:
            self.assertTrue(killed.wait(1))
            self.assertEqual(self.org().node(self.nid)["halt"]["phase"], "halting")
            self.assertEqual(result, [], "halt cannot report success before settlement")
            with self.assertRaisesRegex(ledger.LedgerError, "still settling"):
                halt.unhalt(self.slug, self.nid)
        finally:
            release.set()
            worker.join(2)
            stopper.join(2)
        self.assertTrue(finished.is_set())
        self.assertFalse(worker.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertTrue(result[0]["halted"])
        self.assertTrue(result[0]["settled"])

    def test_timeout_is_halting_never_success(self):
        self.st["busy"] = True
        r = self.stop(timeout=0)
        self.assertFalse(r["halted"])
        self.assertFalse(r["settled"])
        self.assertTrue(r["halting"])
        self.st["busy"] = False
        self.assertTrue(self.stop()["halted"])

    def test_slot_wait_cannot_enter_after_halt(self):
        self.st["busy"] = True
        entered = []
        self.stack.enter_context(patch.object(sup, "_turn_slots", threading.Semaphore(0)))

        @halt.worker
        def waiting(slug, nid):
            try:
                with sup._InterruptibleTurnSlot(self.st):
                    entered.append(True)
            except sup._AdmissionCancelled:
                pass
            finally:
                self.st["busy"] = False
        thread = threading.Thread(target=waiting, args=(self.slug, self.nid))
        thread.start()
        deadline = time.monotonic() + 1
        while not self.st.get("waiting") and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertTrue(self.st.get("waiting"))
        self.assertTrue(self.stop()["halted"])
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertFalse(entered)

    def test_mail_and_delivery_journal_are_not_acknowledged_while_halted(self):
        self.mail("old")
        _, tok, _ = sup._envelope(self.slug, self.nid, "mail", base_view="")
        self.st["steer"] = [{"text": "old mail", "toks": [tok]}]
        self.stop()
        self.mail("new")
        org = self.org()
        before = copy.deepcopy(org.d["delivering"])
        self.assertEqual(org.take_mail(self.nid), [])
        self.assertEqual(sup.pop_steer(self.slug, self.nid), [])
        self.assertEqual(sup.pop_steer(self.slug, self.nid, defer_commit=True), [])
        self.assertEqual(sup.claim_steer(self.slug, self.nid, "tool"), (None, []))
        self.assertEqual(sup.commit_steer(self.slug, self.nid, [{"text":"x", "toks":[tok]}]), [])
        sup._confirm_delivered(self.slug, self.nid, [tok])
        sup.scan_steer_records(self.slug, self.nid)
        sup._fold_back_undelivered(self.slug, self.nid)
        self.assertEqual(self.org().d["delivering"], before)
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1)
        with self.assertRaises(halt.Cancelled):
            sup._envelope(self.slug, self.nid, "rogue drain")

    def test_unhalt_restores_one_owner_and_retains_commands(self):
        self.st["queue"] = [{"cmd": True, "text": "/context", "view": "/context"}]
        self.stop()
        seen = []
        entered = threading.Event()
        release = threading.Event()

        @halt.worker
        def run(slug, nid, carrier):
            self.assertFalse(self.org().node(nid).get("halt"))
            seen.append(carrier)
            entered.set()
            release.wait(2)
            self.st["busy"] = False
        with patch.object(sup, "_run_turn", run):
            self.assertTrue(halt.unhalt(self.slug, self.nid)["unhalted"])
            self.assertTrue(entered.wait(1))
            self.assertFalse(halt.unhalt(self.slug, self.nid)["unhalted"])
            self.assertEqual(len(seen), 1)
            self.assertTrue(seen[0]["cmd"])
            self.assertEqual(seen[0]["text"], "/context")
            release.set()
        deadline = time.monotonic() + 1
        while halt._workers.get((self.slug, self.nid)) and time.monotonic() < deadline:
            time.sleep(.005)

    def test_restart_preserves_halt_and_mail_without_replay(self):
        self.st["queue"] = [{"text": "retained intent"}]
        self.stop()
        self.mail("arrived after halt")
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid), None)
        with patch.object(sup, "send_message") as drive, \
             patch.object(sup, "_transcript_evidence", return_value=set()):
            sup.reconcile(self.slug, active_only=False)
            drive.assert_not_called()
        self.assertEqual(self.org().node(self.nid)["halt"]["phase"], "halted")
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1)

    def test_other_wake_and_process_gates_remain_closed(self):
        self.stop()
        org = self.org()
        org.node(self.nid)["frozen"] = {"limit": True, "at": "now", "resume_texts": ["work"]}
        store.save_org(org)
        self.assertFalse(sup._auto_wake_gates_clear(org, self.nid))
        self.assertIsNone(sup._resumable(org.node(self.nid)))
        self.assertEqual(warmpool.eligible(org, self.nid), (False, "halted"))
        self.assertEqual(sup.resume_frozen(self.slug), [])
        with patch.object(sup, "_compact_split") as compact:
            sup.manual_compact(self.slug, self.nid)
            compact.assert_not_called()

    def test_provider_popped_mail_is_preserved_before_and_after_late_ack(self):
        self.mail("between pop and steer")
        _, tok, _ = sup._envelope(self.slug, self.nid, "mail", base_view="")
        self.st["steer"] = [{"text": "composed", "view": "visible", "toks": [tok]}]
        carriers = sup.pop_steer(self.slug, self.nid, defer_commit=True)
        self.assertEqual(self.st["steer"], [])
        self.assertFalse(self.st.get("steer_limbo"), "exercise the gap BEFORE limbo exists")
        self.stop()
        sup.commit_steer(self.slug, self.nid, carriers)
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)
        self.assertEqual(halt.held_tokens(self.org(), self.nid), {tok})
        self.assertTrue(self.org().d["delivering"][self.nid])
        # Release without starting a provider, then accept its delayed receipt.
        with patch.object(halt, "resume_pending", return_value={"idle": True}):
            halt.unhalt(self.slug, self.nid)
        sup.commit_steer(self.slug, self.nid, carriers)
        self.assertEqual(self.org().node(self.nid)["halt_queue"], [])
        self.assertFalse(self.org().d["delivering"].get(self.nid))

    def test_provider_callbacks_are_counted_and_cannot_run_after_success(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        @halt.callback(self.slug, self.nid)
        def callback(payload):
            calls.append(payload)
            entered.set()
            release.wait(2)

        thread = threading.Thread(target=callback, args=("first",))
        thread.start()
        self.assertTrue(entered.wait(1))
        r = self.stop(timeout=0)
        self.assertTrue(r["halting"])
        callback("late")
        self.assertEqual(calls, ["first"])
        release.set()
        thread.join(2)
        self.assertTrue(self.stop()["settled"])
        callback("later still")
        self.assertEqual(calls, ["first"])
        self.assertFalse(self.org().node(self.nid).get("halt_queue"),
                         "callback arguments are not user input to replay")

    def test_halt_racing_send_and_manual_drive_never_overlaps_a_running_turn(self):
        failures = []
        gate = threading.Barrier(13)

        @halt.worker
        def _run_turn(slug, nid, carrier):
            with store.DOC_LOCK:
                if (self.org().node(nid).get("halt") or {}).get("phase") == "halted":
                    failures.append("entered while halted")
            deadline = time.monotonic() + 2
            while not halt.requested(slug, nid) and time.monotonic() < deadline:
                time.sleep(.001)
            with store.DOC_LOCK:
                if (self.org().node(nid).get("halt") or {}).get("phase") == "halted":
                    failures.append("halt succeeded before worker ended")
            with sup._state_lock:
                self.st["busy"] = False

        def sender(i):
            gate.wait(2)
            if i % 2:
                _run_turn(self.slug, self.nid, {"text": f"direct {i}"})
            else:
                sup.send_message(self.slug, self.nid, f"/command-{i}", command=True)

        with patch.object(sup, "_run_turn", _run_turn), \
             patch.object(sup, "_native_context_hold", return_value=None):
            threads = [threading.Thread(target=sender, args=(i,)) for i in range(12)]
            for t in threads:
                t.start()
            gate.wait(2)
            self.assertTrue(self.stop()["settled"])
            for t in threads:
                t.join(2)
                self.assertFalse(t.is_alive())
        self.assertEqual(failures, [])
        self.assertFalse(self.st["busy"])
        self.assertFalse(halt._workers.get((self.slug, self.nid)))
        # Every command/direct intent was either acknowledged (none here) or retained.
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 12)

    def test_resume_frozen_race_preserves_all_replay_carriers(self):
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["frozen"] = {"limit": True, "resume_texts": ["one", "two"]}
            store.save_org(org)
        # This seam is after the first resume transaction and before dispatch.
        def stop_during_resume(st, tier):
            self.stop()
            return False
        with patch.object(sup, "_limit_cache_claude_state", side_effect=stop_during_resume), \
             patch.object(sup, "_run_turn") as run:
            sup.resume_frozen(self.slug, only=[self.nid])
            run.assert_not_called()
        self.assertFalse(self.st["busy"])
        self.assertEqual([c["text"] for c in self.org().node(self.nid)["halt_queue"]],
                         ["one", "two"])

    def test_halt_survives_retirement_rehire_compaction_and_cross_provider_switch(self):
        self.st["queue"] = [{"cmd": True, "text": "/context", "view": "/context"}]
        self.stop()
        self.mail("mail before lifecycle changes")
        for action in (lambda o: o.retire(ledger.USER, self.nid),
                       lambda o: o.rehire(ledger.USER, self.nid),
                       lambda o: o.cheap_compact(ledger.USER, self.nid),
                       lambda o: o.switch_model(ledger.USER, self.nid, "haiku")):
            with store.DOC_LOCK:
                org = self.org()
                result = action(org)
                store.save_org(org)
            self.assertEqual(self.org().node(self.nid)["halt"]["phase"], "halted")
            self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)
            self.assertTrue(self.org().d["mail"][self.nid])
            for nid, n in self.org().nodes.items():
                if nid.startswith(self.nid + "@"):
                    self.assertFalse(n.get("halt_queue"), "a bearer must not duplicate pending work")
            self.assertEqual(sup.send_message(self.slug, self.nid, "notice", wake=False)["deferred"],
                             "halted", result)

    def test_reseed_rename_and_runtime_reset_do_not_release_halt(self):
        self.st["queue"] = [{"text": "saved intent"}]
        self.stop()
        self.mail()
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["state"] = "unrecoverable"
            org.reseed(ledger.USER, self.nid, "fresh-session")
            org.rename(ledger.USER, self.nid, "renamed")
            store.save_org(org)
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid), None)
        self.nid = "renamed"
        self.st = sup.state(self.slug, self.nid)
        self.assertTrue(halt.requested(self.slug, self.nid))
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1)
        with patch.object(sup, "_run_one_turn_recorded") as run:
            sup._run_one_turn(self.slug, self.nid, "late provider callback")
            run.assert_not_called()

    def test_unhalt_respects_other_holds_and_does_not_wake_passive_mail(self):
        self.stop()
        self.mail("FYI", "notice")
        with patch.object(sup, "send_message") as send:
            self.assertEqual(halt.unhalt(self.slug, self.nid)["delivery"], {"idle": True})
            send.assert_not_called()
        self.stop()
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["frozen"] = {"limit": True, "resume_texts": ["old"]}
            halt.retain(org, self.nid, [{"cmd": True, "text": "/context"}])
            store.save_org(org)
        self.assertEqual(halt.unhalt(self.slug, self.nid)["delivery"], {"deferred": True})
        self.assertTrue(self.org().node(self.nid)["frozen"])
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid).pop("frozen")
            store.save_org(org)
            halt.restore_carriers(org, self.nid, {"text": "provider resumed"})
        self.assertEqual([c["text"] for c in self.st["queue"]], ["/context"])

    def test_automatic_checkups_and_cache_calls_do_not_mutate_mail_or_launch(self):
        self.stop()
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["last_status"] = {"state": "working", "at": "2000-01-01T00:00:00Z"}
            org.node(self.nid)["working_activity_at"] = "2000-01-01T00:00:00Z"
            store.save_org(org)
        before = copy.deepcopy(self.org().d.get("mail"))
        self.assertIsNone(sup._working_checkup_reserve(self.slug, self.nid, time.time()))
        self.assertIsNone(sup._idle_docket_reminder_reserve(self.slug, self.nid, time.time()))
        with patch.object(sup.subprocess, "Popen") as popen:
            sup._working_cache_read(self.slug, self.nid, {"cancel": threading.Event()})
            sup._launch_working_cache_read(self.slug, self.nid)
            self.assertIn("halted", sup.remote_control_start(self.slug, self.nid)["error"])
            popen.assert_not_called()
        self.assertEqual(self.org().d.get("mail"), before)
        self.assertFalse(self.org().node(self.nid).get("halt_queue"))

    def test_failed_durable_save_does_not_discard_runtime_queue(self):
        self.st["queue"] = [{"text": "keep me"}]
        with patch.object(store, "save_org", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.stop()
        self.assertEqual(self.st["queue"][0]["text"], "keep me")
        self.assertFalse(self.org().node(self.nid).get("halt"))
        self.assertFalse(self.st.get("halt_requested"))
        self.assertTrue(self.stop()["settled"])

    def test_operator_and_agent_api_authority_receipts_and_self_refusal(self):
        from orgtree import api, opreceipts, mcptool
        from fastapi import HTTPException
        request = SimpleNamespace(state=SimpleNamespace())

        def call(tool, args, actor="boss"):
            return api.agent_call(api.AgentCall(org=self.slug, node=actor, tool=tool, args=args), request)

        epoch = call(opreceipts.OP_EPOCH, {})["epoch"]
        args = {"tool": "orgtree_halt", "args": {"node": self.nid},
                "op_key": opreceipts.mint_key(), "op_epoch": epoch}
        r = call(opreceipts.OP_CALL, args)
        self.assertTrue(r["settled"])
        replay = call(opreceipts.OP_CALL, args)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["outcome"], "applied")
        self.assertTrue(replay["receipt"]["result"]["halted"])
        self.assertEqual(opreceipts.coverage("orgtree_halt", {}), opreceipts.PRE)
        with self.assertRaises(HTTPException) as e:
            call("orgtree_message", {"to": "boss", "body": "should not execute"}, actor=self.nid)
        self.assertEqual(e.exception.status_code, 409)
        self.assertTrue(api.node_unhalt(self.slug, self.nid)["unhalted"])
        for actor, target in (("boss", "boss"), (self.nid, "boss")):
            with self.assertRaises(HTTPException) as e:
                call("orgtree_halt", {"node": target}, actor=actor)
            self.assertEqual(e.exception.status_code, 422)
        self.assertTrue(api.node_halt(self.slug, self.nid)["halted"])
        self.assertTrue(call("orgtree_unhalt", {"node": self.nid})["unhalted"])
        names = {t["name"] for t in mcptool.TOOLS}
        self.assertTrue({"orgtree_interrupt", "orgtree_halt", "orgtree_unhalt"} <= names)

    def test_watchdog_event_is_recorded_but_cannot_wake_halted_owner(self):
        self.stop()
        with store.DOC_LOCK:
            org = self.org()
            dog = org.watchdog_create(self.nid, "event", "process", "pid:999999", once=True)
            store.save_org(org)
        with patch.object(sup, "_run_turn") as run, patch.object(sup, "mail_spark"):
            sup._wd_fire(self.slug, dog["id"], "event", ["fixture process exited"])
            run.assert_not_called()
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1)
        self.assertEqual(self.org().d["watchdogs"], [], "one-shot event is durably recorded once")
        self.assertTrue(self.org().node(self.nid)["halt_queue"][0]["ping"])

    def test_reserved_automatic_mail_is_not_cancelled_by_racing_halt(self):
        self.mail("already reserved checkup")
        mid = self.org().d["mail"][self.nid][0]["id"]
        self.stop()
        sup._auto_wake_cancel(self.slug, self.nid, mid)
        self.assertEqual([m["id"] for m in self.org().d["mail"][self.nid]], [mid])

    def test_concurrent_unhalt_cannot_undo_a_halt_still_killing_processes(self):
        first_done, release = threading.Event(), threading.Event()
        calls = 0
        real_cut = halt._cut

        def slow_cut(slug, nid, st):
            nonlocal calls
            calls += 1
            if calls == 1:
                first_done.set()
                release.wait(2)
            real_cut(slug, nid, st)

        results = []
        with patch.object(halt, "_cut", side_effect=slow_cut):
            thread = threading.Thread(target=lambda: results.append(self.stop()))
            thread.start()
            self.assertTrue(first_done.wait(1))
            # A second halt can finish first, but unhalt cannot reopen the
            # gate while the older request can still kill a resumed process.
            self.assertTrue(self.stop()["settled"])
            with self.assertRaisesRegex(ledger.LedgerError, "still settling"):
                halt.unhalt(self.slug, self.nid)
            release.set()
            thread.join(2)
        self.assertTrue(results[0]["settled"])

    def test_halt_waits_for_inflight_prewarm_and_reaps_it_before_success(self):
        spawning, release, reaped = (threading.Event() for _ in range(3))
        wp = SimpleNamespace(proc=SimpleNamespace(poll=lambda: 0))

        def spawn(org, nid, why):
            spawning.set()
            release.wait(2)
            return wp

        with patch.object(warmpool, "_spawn_for", side_effect=spawn), \
             patch.object(warmpool, "_kill_proc"), \
             patch.object(warmpool, "_reap", side_effect=lambda p: reaped.set()), \
             patch.object(warmpool, "_journal_exit_once"):
            thread = threading.Thread(target=warmpool._prewarm_node, args=(self.org(), self.nid, "test"))
            thread.start()
            self.assertTrue(spawning.wait(1))
            self.assertTrue(self.stop(timeout=0)["halting"])
            release.set()
            thread.join(2)
            self.assertTrue(reaped.is_set())
            self.assertTrue(self.stop()["halted"])
        self.assertNotIn((self.slug, self.nid), warmpool._pool)
        with patch.object(warmpool, "_spawn_for") as spawn:
            warmpool._prewarm_node(self.org(), self.nid, "after halt")
            spawn.assert_not_called()

    def test_active_native_provider_and_manual_compaction_are_settled(self):
        for provider in ("codex", "antigravity", "compact"):
            with self.subTest(provider=provider):
                started, closed = threading.Event(), threading.Event()

                class Proc:
                    def poll(self):
                        return 0 if closed.is_set() else None

                client = SimpleNamespace(proc=Proc(), close=closed.set)

                def compact(slug, nid):
                    if provider == "codex":
                        self.st["codex_turn"] = SimpleNamespace(client=client)
                    elif provider == "antigravity":
                        self.st["antigravity_turn"] = client
                    else:
                        self.st["halt_compact_client"] = client
                    started.set()
                    closed.wait(2)

                with patch.object(sup, "_compact_split", side_effect=compact):
                    thread = threading.Thread(target=sup.manual_compact, args=(self.slug, self.nid))
                    thread.start()
                    self.assertTrue(started.wait(1))
                    self.assertTrue(self.stop()["settled"])
                    thread.join(2)
                    self.assertFalse(thread.is_alive())
                    self.assertTrue(closed.is_set())
                self.st.pop("codex_turn", None)
                self.st.pop("antigravity_turn", None)
                self.st.pop("halt_compact_client", None)
                halt.unhalt(self.slug, self.nid)

    def test_http_controls_preserve_mail_and_defer_local_session_commands(self):
        import asyncio
        import httpx
        from orgtree import api

        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app),
                                         base_url="http://fixture") as client:
                base = f"/api/orgs/{self.slug}/nodes/{self.nid}"
                r = await client.post(base + "/halt")
                self.assertEqual(r.status_code, 200)
                self.assertTrue(r.json()["settled"])
                r = await client.post(base + "/message", json={"text": "durable user mail"})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json()["deferred"], "halted")
                r = await client.post(base + "/message", json={"text": "/context"})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json()["deferred"], "halted")
                r = await client.post(base + "/message", json={"text": "/compact"})
                self.assertEqual(r.status_code, 409)
                r = await client.post(base + "/interrupt")
                self.assertEqual(r.status_code, 200)
                self.assertFalse(r.json()["interrupted"])
                self.assertTrue(halt.requested(self.slug, self.nid))
                r = await client.post(base + "/unhalt")
                self.assertTrue(r.json()["unhalted"])

        with patch.object(halt, "resume_pending", return_value={"idle": True}), \
             patch.object(sup, "immediate_command") as immediate, \
             patch.object(sup, "_run_turn") as run, patch.object(sup, "mail_spark"):
            asyncio.run(exercise())
            immediate.assert_not_called()
            run.assert_not_called()
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1)
        self.assertTrue(any(c.get("cmd") and c["text"] == "/context"
                            for c in self.org().node(self.nid)["halt_queue"]))

    def test_halt_cancels_immediate_command_fork_and_preserves_its_input(self):
        started, closed = threading.Event(), threading.Event()

        class Proc:
            def poll(self):
                return 0 if closed.is_set() else None

            def communicate(self, **kwargs):
                started.set()
                closed.wait(2)
                return "", ""

        with patch.object(sup, "transcript_path", return_value="fixture"), \
             patch.object(sup, "_transcript_root", return_value="fixture"), \
             patch.object(sup, "_claude_fork_context", return_value=("fixture", {})), \
             patch.object(sup, "claude_model_for", return_value="fixture"), \
             patch.object(sup, "_claude_argv", return_value=["fixture"]), \
             patch.object(sup.subprocess, "Popen", return_value=Proc()) as popen, \
             patch.object(sup, "_leash"), \
             patch.object(sup, "_wd_kill_tree", side_effect=lambda p: closed.set()), \
             patch.object(sup, "live_row") as live:
            self.assertTrue(sup.immediate_command(self.slug, self.nid, "/context"))
            self.assertTrue(started.wait(1))
            self.assertTrue(self.stop()["settled"])
            self.assertTrue(closed.is_set())
            self.assertFalse(sup.immediate_command(self.slug, self.nid, "/context"))
            popen.assert_called_once()
            live.assert_not_called()
        self.assertEqual([c["text"] for c in self.org().node(self.nid)["halt_queue"]], ["/context"])

    def test_cache_slot_wait_is_cancelled_without_waiting_for_another_agent(self):
        with patch.object(sup, "_working_cache_slots", threading.Semaphore(0)), \
             patch.object(sup.subprocess, "Popen") as popen:
            thread = threading.Thread(target=sup._working_cache_read, args=(self.slug, self.nid))
            thread.start()
            deadline = time.monotonic() + 1
            while not halt._workers.get((self.slug, self.nid)) and time.monotonic() < deadline:
                time.sleep(.001)
            self.assertTrue(halt._workers.get((self.slug, self.nid)))
            self.assertTrue(self.stop()["settled"])
            thread.join(1)
            self.assertFalse(thread.is_alive())
            popen.assert_not_called()

    def test_runtime_replacement_cannot_hide_active_process_or_pending_mail(self):
        started, closed = threading.Event(), threading.Event()
        original = self.st

        class Proc:
            def poll(self):
                return 0 if closed.is_set() else None

        @halt.worker
        def active(slug, nid):
            original["busy"] = True
            original["proc"] = Proc()
            original["queue"] = [{"text": "queued before runtime replacement"}]
            started.set()
            closed.wait(2)
            original["busy"] = False

        with patch.object(sup, "_wd_kill_tree", side_effect=lambda p: closed.set()):
            thread = threading.Thread(target=active, args=(self.slug, self.nid))
            thread.start()
            self.assertTrue(started.wait(1))
            # Model/account lifecycle code may forget its provider runtime.
            with sup._state_lock:
                sup._state.pop((self.slug, self.nid))
            self.st = sup.state(self.slug, self.nid)
            self.assertIsNot(self.st, original)
            self.assertTrue(self.stop()["settled"])
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertTrue(closed.is_set())
        self.assertEqual([c["text"] for c in self.org().node(self.nid)["halt_queue"]],
                         ["queued before runtime replacement"])

    def test_a_failed_process_kill_cannot_be_reported_as_a_successful_halt(self):
        closed = threading.Event()
        self.st["proc"] = SimpleNamespace(poll=lambda: 0 if closed.is_set() else None)
        with patch.object(sup, "_wd_kill_tree"):
            r = self.stop(timeout=0)
            self.assertFalse(r["halted"])
            self.assertTrue(r["halting"])
            with self.assertRaisesRegex(ledger.LedgerError, "settling"):
                self.org().rename(ledger.USER, self.nid, "cannot-hide-running-owner")
            with self.assertRaises(ledger.LedgerError):
                halt.unhalt(self.slug, self.nid)
            closed.set()
            self.assertTrue(self.stop()["settled"])

    def test_freeze_replay_and_halt_preserve_one_identical_mail_carrier(self):
        self.mail("the original mail")
        text, tok, _ = sup._envelope(self.slug, self.nid, "handle this mail")
        source = {"text": text, "toks": [tok], "view": "the original view"}
        self.st["halt_pending_carrier"] = source
        with store.DOC_LOCK:
            org = self.org()
            frozen = {"limit": True, "resume_texts": ["truncated freeze prose"]}
            org.node(self.nid)["frozen"] = frozen
            halt.link_freeze_replay(self.slug, self.nid, frozen)
            store.save_org(org)
        self.stop()
        self.assertEqual(halt.unhalt(self.slug, self.nid)["delivery"], {"deferred": True})
        seen, complete = [], threading.Event()

        def acknowledge(slug, nid, carrier, **kwargs):
            seen.append(copy.deepcopy(carrier))
            sup._confirm_delivered(slug, nid, carrier.get("toks") or [])
            self.st["busy"] = False
            complete.set()

        with patch.object(sup, "_native_context_hold", return_value=None), \
             patch.object(sup, "_run_one_turn", side_effect=acknowledge):
            sup.resume_frozen(self.slug, only=[self.nid])
            self.assertTrue(complete.wait(2))
            deadline = time.monotonic() + 1
            while halt._workers.get((self.slug, self.nid)) and time.monotonic() < deadline:
                time.sleep(.001)
        self.assertEqual(seen, [source])
        self.assertEqual(self.st["queue"], [], "the freeze and halt must not replay two turns")
        self.assertFalse(self.org().node(self.nid).get("halt_queue"))
        self.assertFalse(self.org().d.get("delivering", {}).get(self.nid))
        self.assertFalse(self.org().d.get("mail", {}).get(self.nid))

    def test_halt_ends_an_existing_managed_remote_control_session(self):
        closed = threading.Event()
        proc = SimpleNamespace(poll=lambda: 0 if closed.is_set() else None,
                               terminate=closed.set)
        sup._remote_procs[(self.slug, self.nid)] = proc
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["remote_controlled"] = {"pid": 123}
            store.save_org(org)
        with patch.object(sup, "_wd_kill_tree", side_effect=lambda p: closed.set()):
            self.assertTrue(self.stop()["settled"])
        self.assertTrue(closed.is_set())
        self.assertFalse(self.org().node(self.nid).get("remote_controlled"))
        self.assertNotIn((self.slug, self.nid), sup._remote_procs)

    def test_halt_racing_remote_control_spawn_waits_for_its_owner(self):
        spawning, release, closed = (threading.Event() for _ in range(3))
        proc = SimpleNamespace(poll=lambda: 0 if closed.is_set() else None,
                               terminate=closed.set)

        def spawn(*args, **kwargs):
            spawning.set()
            release.wait(2)
            return proc

        results = []
        with patch.object(sup.sbx, "is_sandboxed", return_value=False), \
             patch.object(sup, "_claude_argv", return_value=["fixture"]), \
             patch.object(sup.subprocess, "Popen", side_effect=spawn), \
             patch.object(sup, "_leash"), \
             patch.object(sup, "_wd_kill_tree", side_effect=lambda p: closed.set()):
            thread = threading.Thread(target=lambda: results.append(
                sup.remote_control_start(self.slug, self.nid)))
            thread.start()
            self.assertTrue(spawning.wait(1))
            self.assertTrue(self.stop(timeout=0)["halting"])
            release.set()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertTrue(self.stop()["settled"])
        self.assertTrue(closed.is_set())
        self.assertIn("halt", results[0]["error"])

    def test_late_codex_prewarm_callback_cannot_initialize_while_halted(self):
        self.stop()
        with patch.object(warmpool, "_codex_prewarm_finish_owned") as finish:
            warmpool._codex_prewarm_finish(self.org(), self.nid, object())
            finish.assert_not_called()
        self.assertFalse(halt._workers.get((self.slug, self.nid)))

    def test_a_warm_process_removed_from_pool_still_blocks_halt_until_reaped(self):
        closed = threading.Event()
        proc = SimpleNamespace(poll=lambda: 0 if closed.is_set() else None)
        wp = SimpleNamespace(proc=proc, claimed=False,
                             alive=lambda: not closed.is_set())
        key = (self.slug, self.nid)
        warmpool._pool[key] = wp
        with patch.object(warmpool, "kill_node", _real_warm_kill), \
             patch.object(warmpool, "_kill_proc"), patch.object(warmpool, "_reap"), \
             patch.object(sup, "_wd_kill_tree"):
            r = self.stop(timeout=0)
            self.assertTrue(r["halting"])
            self.assertFalse(r["settled"])
            self.assertNotIn(key, warmpool._pool)
            self.assertEqual(warmpool._terminating[key], [proc])
            closed.set()
            self.assertTrue(self.stop()["settled"])
        self.assertNotIn(key, warmpool._terminating)

    def test_confirmed_released_command_cannot_replay_on_restart(self):
        self.st["queue"] = [{"cmd": True, "text": "/context", "view": "/context"}]
        self.stop()
        consumed = threading.Event()

        def acknowledge(slug, nid, carrier, **kwargs):
            sup._confirm_delivered(slug, nid, carrier.get("toks") or [])
            self.st["busy"] = False
            consumed.set()

        with patch.object(sup, "_run_one_turn", side_effect=acknowledge), \
             patch.object(sup, "_native_context_hold", return_value=None):
            halt.unhalt(self.slug, self.nid)
            self.assertTrue(consumed.wait(2))
            deadline = time.monotonic() + 1
            while halt._workers.get((self.slug, self.nid)) and time.monotonic() < deadline:
                time.sleep(.001)
        self.assertFalse(self.org().node(self.nid)["halt_queue"])
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid), None)
        with patch.object(sup, "send_message") as drive, \
             patch.object(sup, "_run_turn") as run, \
             patch.object(sup, "_transcript_evidence", return_value=set()):
            sup.reconcile(self.slug)
            drive.assert_not_called()
            run.assert_not_called()

    def test_halt_arriving_during_error_cleanup_suppresses_terminal_alarm(self):
        # User invariant: a turn cannot run while its agent is halted. The
        # existing worker must settle before halt succeeds, even when a late
        # exception is passing through state-audit's terminal-error handler.
        accounting, release = threading.Event(), threading.Event()

        class Recorder:
            disposition = None
            def set(self, **kwargs):
                pass
            def book(self, **kwargs):
                pass
            def error(self, error):
                pass
            def dispose(self, disposition):
                self.disposition = disposition
            def close(self):
                pass

        def charge(*args, **kwargs):
            accounting.set()
            release.wait(3)

        self.st["busy"] = True
        with patch.object(sup, "_InterruptibleTurnSlot",
                          side_effect=RuntimeError("fixture admission failure")), \
             patch.object(sup, "_charge_reported_spend", side_effect=charge), \
             patch.object(sup.turnlog, "start", return_value=Recorder()), \
             patch.object(sup, "_bump_hard_fail") as bump, \
             patch.object(sup, "_turn_abandoned") as abandon:
            worker = threading.Thread(target=sup._run_one_turn,
                                      args=(self.slug, self.nid, "pending input"))
            worker.start()
            try:
                self.assertTrue(accounting.wait(2), "exception passed its first halt check")
                result = self.stop(timeout=0)
                self.assertTrue(result["halting"])
                self.assertFalse(result["settled"])
            finally:
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertTrue(self.stop()["halted"])
            bump.assert_not_called()
            abandon.assert_not_called()
        self.assertFalse(halt._workers.get((self.slug, self.nid)))
        self.assertEqual(self.org().node(self.nid)["halt_queue"][0]["text"],
                         "pending input")

    def queue_cross_provider_switch(self):
        with store.DOC_LOCK:
            org = self.org()
            n = org.node(self.nid)
            n["model"] = "opus"
            n["frozen"] = {"limit": True, "provider": "claude",
                           "until_ts": time.time() + 3600,
                           "resume_texts": ["work before the limit"], "at": "x"}
            n["pending_switch"] = {"tier": "luna", "from": "opus",
                                   "by": "USER", "at": "x",
                                   "crossing": True, "account": None}
            store.save_org(org)

    def assert_switch_wake_held(self):
        node = self.org().node(self.nid)
        self.assertEqual(node["model"], "luna")
        self.assertIsNone(node.get("frozen"))
        self.assertNotIn("pending_switch", node)
        self.assertEqual(node["halt"]["phase"], "halted")
        wakes = [c for c in node["halt_queue"]
                 if c.get("ping_reason") == "unfrozen_by_switch"]
        self.assertEqual(len(wakes), 1)
        self.assertEqual(wakes[0]["text"], sup.UNFROZEN_BY_SWITCH_TEXT)
        self.assertFalse(sup.state(self.slug, self.nid)["busy"])
        self.assertFalse(halt._workers.get((self.slug, self.nid)))

    def test_queued_switch_at_halted_turn_boundary_retains_wake(self):
        self.queue_cross_provider_switch()
        self.st["busy"] = True
        with patch.object(sup, "_turn_slots", threading.Semaphore(0)), \
             patch.object(sup, "_run_turn") as run:
            worker = threading.Thread(target=sup._run_one_turn,
                                      args=(self.slug, self.nid, "waiting input"))
            worker.start()
            try:
                deadline = time.monotonic() + 2
                while not self.st.get("admission_waiting") and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertTrue(self.st.get("admission_waiting"))
                self.assertTrue(self.stop()["halted"])
            finally:
                self.st["admission_cancelled"] = True
                worker.join(3)
            self.assertFalse(worker.is_alive())
            run.assert_not_called()
        self.assert_switch_wake_held()

    def test_restart_queued_switch_cannot_release_halt_or_deliver_mail(self):
        self.queue_cross_provider_switch()
        self.stop()
        self.mail("queued across provider change and restart")
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid), None)
        with patch.object(sup, "_run_turn") as run, \
             patch.object(sup, "_transcript_evidence", return_value=set()), \
             patch.object(sup, "_native_context_hold", return_value=None):
            sup.reconcile(self.slug)
            run.assert_not_called()
        self.assert_switch_wake_held()
        self.assertEqual(self.org().d["mail"][self.nid], before)

    def test_assigning_missing_account_clears_only_account_park(self):
        with store.DOC_LOCK:
            org = self.org()
            node = org.node(self.nid)
            node["model"] = "opus"
            node["account"] = "missing:claude"
            node["frozen"] = {"limit": True, "cause": "account",
                              "provider": "claude", "until_ts": None, "at": "x"}
            store.save_org(org)
        self.stop()
        self.mail("unread while account is repaired")
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with patch.object(sup, "_run_turn") as run:
            result = sup.assign_account(self.slug, self.nid, "primary", actor=ledger.USER)
            run.assert_not_called()
        self.assertTrue(result["unparked"])
        node = self.org().node(self.nid)
        self.assertIsNone(node.get("frozen"))
        self.assertEqual(node["halt"]["phase"], "halted")
        self.assertEqual([c["text"] for c in node["halt_queue"]], [sup.ACCOUNT_UNPARK_TEXT])
        self.assertEqual(self.org().d["mail"][self.nid], before)
        self.assertFalse(sup.state(self.slug, self.nid)["busy"])

    def test_dead_remote_recovery_preserves_halt_and_waiting_mail(self):
        self.stop()
        self.mail("waiting after the remote driver died")
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["remote_controlled"] = {"at": "x", "pid": 123}
            store.save_org(org)
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with patch.object(sup, "_pid_provably_dead", return_value=True), \
             patch.object(sup, "remote_reap"), \
             patch.object(sup, "_run_turn") as run:
            sup._invariant_sweep_org(self.slug)
            run.assert_not_called()
        node = self.org().node(self.nid)
        self.assertIsNone(node.get("remote_controlled"))
        self.assertEqual(node["halt"]["phase"], "halted")
        self.assertEqual(len(node["halt_queue"]), 1)
        self.assertIn("Remote control ended", node["halt_queue"][0]["text"])
        self.assertEqual(self.org().d["mail"][self.nid], before)
        self.assertFalse(self.st["busy"])


if __name__ == "__main__":
    unittest.main()
