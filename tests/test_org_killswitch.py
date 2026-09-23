"""User redesign 2026-09-13 (docket make-the-killswitch-halt-the-whole-org).

The killswitch is a persistent ORG-LEVEL latch, separate from per-agent halt:
latching stops every current turn and closes every admission source as one
coordinated operation (the latch commits BEFORE the sweep); while latched no
mail, queued work, checkup, retry, restart recovery, warm spawn or tool call
may start an agent; releasing clears ONLY the org state, leaves every
individual halt exactly as it stood, and starts nothing. Isolated data root
and fake workers; no live agents run.
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

_root = tempfile.TemporaryDirectory(prefix="orgtree-org-killswitch-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, store, supervisor as sup, warmpool


class OrgKillswitchTests(unittest.TestCase):
    def setUp(self):
        self.slug = "kill-" + str(time.time_ns())
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

    def latch(self):
        return halt.killswitch_latch(self.slug)

    def events(self, op):
        return [e for e in self.org().d.get("events", []) if e.get("op") == op]

    def test_latch_is_persistent_audited_idempotent_and_clears_queues(self):
        self.st["queue"] = [{"text": "queued before the stop"}]
        self.st["steer"] = [{"text": "steer before the stop"}]
        r = self.latch()
        self.assertTrue(r["latched"])
        self.assertFalse(r["already_latched"])
        self.assertEqual(r["interrupted"], [], "an idle org has no turns to stop")
        rec = self.org().d["killswitch"]
        self.assertEqual(rec["by"], ledger.USER)
        self.assertTrue(rec["at"])
        self.assertEqual(self.st["queue"], [])
        self.assertEqual(self.st["steer"], [])
        self.assertEqual(len(self.events("killswitch")), 1)
        again = self.latch()
        self.assertTrue(again["already_latched"])
        self.assertEqual(len(self.events("killswitch")), 1,
                         "a re-press must not double the audit or re-stamp the latch")
        self.assertEqual(self.org().d["killswitch"], rec)

    def test_latch_commits_before_the_sweep(self):
        seen = []
        real = sup.interrupt_all

        def probe(slug, **kw):
            seen.append(bool(store.load_org(slug).d.get("killswitch")))
            return real(slug, **kw)

        with patch.object(sup, "interrupt_all", side_effect=probe):
            self.latch()
        self.assertEqual(seen, [True],
                         "the latch must be durable before any agent is interrupted")

    def test_latch_blocks_every_admission_source_without_touching_halt(self):
        self.latch()
        self.mail()
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with patch.object(sup, "_run_one_turn_recorded") as run:
            for kwargs in ({}, {"mail_ping": True}, {"command": True},
                           {"wake": False}, {"idle_only": True}):
                r = sup.send_message(self.slug, self.nid, "wake", **kwargs)
                self.assertEqual(r["deferred"], "killswitch")
                self.assertTrue(r["halted"], "a latched org is effectively halted")
                self.assertFalse(r["halting"], "a bare latch has nothing to settle")
            sup._run_turn(self.slug, self.nid, "rogue direct worker")
            sup._run_one_turn(self.slug, self.nid, "rogue direct turn")
            run.assert_not_called()
        self.assertEqual(self.org().d["mail"][self.nid], before)
        self.assertIsNone(self.org().node(self.nid).get("halt"),
                          "the latch must never set the per-agent flag")
        self.assertFalse(self.st["busy"])
        self.assertFalse(halt._workers.get((self.slug, self.nid)))
        with self.assertRaisesRegex(halt.Cancelled, "killswitch"):
            halt.check(self.slug, self.nid)
        self.assertEqual(warmpool.eligible(self.org(), self.nid),
                         (False, "killswitch"))

    def test_direct_turn_attempt_during_latch_retains_its_carrier(self):
        self.latch()
        sup._run_turn(self.slug, self.nid, {"text": "direct intent"})
        self.assertEqual([c["text"] for c in self.org().node(self.nid)["halt_queue"]],
                         ["direct intent"])
        self.assertFalse(self.st["busy"])

    def test_frozen_replay_is_preserved_not_started_while_latched(self):
        with store.DOC_LOCK:
            org = self.org()
            org.node(self.nid)["frozen"] = {"limit": True,
                                            "resume_texts": ["work"], "at": "x"}
            store.save_org(org)
        self.latch()
        with patch.object(sup, "_run_turn") as run:
            self.assertEqual(sup.resume_frozen(self.slug), [])
            run.assert_not_called()
        self.assertTrue(self.org().node(self.nid)["frozen"],
                        "the freeze record must survive for a resume AFTER release")

    def test_release_clears_only_org_state_and_starts_nothing(self):
        # worker individually halted BEFORE the latch; boss only latched
        self.assertTrue(halt.halt(self.slug, self.nid)["halted"])
        self.latch()
        # a command sent to the un-halted boss during the latch is retained
        r = sup.send_message(self.slug, "boss", "/context", command=True)
        self.assertEqual(r["deferred"], "killswitch")
        boss_st = sup.state(self.slug, "boss")
        with patch.object(sup, "_run_turn") as run, \
             patch.object(sup, "send_message") as send:
            out = halt.killswitch_release(self.slug)
            run.assert_not_called()
            send.assert_not_called()
        self.assertTrue(out["released"])
        self.assertIn("boss", out["merged"])
        self.assertIsNone(self.org().d.get("killswitch"))
        self.assertEqual(len(self.events("killswitch_release")), 1)
        # the individual halt is exactly as it stood
        self.assertEqual(self.org().node(self.nid)["halt"]["phase"], "halted")
        self.assertEqual(halt.blocked(self.slug, self.nid), "halt")
        # boss: eligible again, retained command merged but NOT running
        self.assertEqual([c["text"] for c in boss_st["queue"]], ["/context"])
        self.assertFalse(boss_st["busy"])
        self.assertIsNone(halt.blocked(self.slug, "boss"))
        self.assertFalse(halt.killswitch_release(self.slug)["released"])

    def test_unhalt_during_latch_clears_flag_but_stays_blocked(self):
        halt.halt(self.slug, self.nid)
        self.latch()
        r = halt.unhalt(self.slug, self.nid)
        self.assertTrue(r["unhalted"])
        self.assertTrue(r["delivery"]["deferred"],
                        "no merge while the org is still latched")
        self.assertIsNone(self.org().node(self.nid).get("halt"))
        self.assertEqual(halt.blocked(self.slug, self.nid), "killswitch")
        self.assertEqual(sup.send_message(self.slug, self.nid, "x")["deferred"],
                         "killswitch")

    def test_restart_recovery_neither_releases_nor_drives_a_latched_org(self):
        self.latch()
        sup.send_message(self.slug, self.nid, "/context", command=True)  # retained
        self.mail("waited across restart")
        before = copy.deepcopy(self.org().d["mail"][self.nid])
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid), None)
        with patch.object(sup, "_run_turn") as run, \
             patch.object(sup, "_run_one_turn_recorded") as rec, \
             patch.object(sup, "_transcript_evidence", return_value=set()):
            sup.reconcile(self.slug, active_only=False)
            run.assert_not_called()
            rec.assert_not_called()
        self.assertTrue(self.org().d["killswitch"], "the latch survives restart")
        self.assertEqual(self.org().d["mail"][self.nid], before)
        self.assertEqual(len(self.org().node(self.nid)["halt_queue"]), 1)

    def test_watchdogs_pause_on_latch_and_stay_paused_after_release(self):
        with store.DOC_LOCK:
            org = self.org()
            dog = org.watchdog_create(self.nid, "event", "process", "pid:999999")
            store.save_org(org)
        r = self.latch()
        self.assertIn(dog["id"], [d["id"] for d in r["watchdogs_paused"]])
        state_after_latch = copy.deepcopy(self.org().d["watchdogs"])
        halt.killswitch_release(self.slug)
        self.assertEqual(self.org().d["watchdogs"], state_after_latch,
                         "release must not resume any dog — per-dog manual "
                         "resume stays the only exit (2026-09-04 ruling)")

    def test_latch_racing_immediate_command_suppresses_output_and_retains_carrier(self):
        # Review finding 2026-09-13: immediate_command's ENTRY is
        # delivery-gated, but its async completion used to test only the
        # per-agent flag — a killswitch latched mid-fork let a stopped org
        # publish a fresh sticky output row. The completion now asks the
        # unified predicate: no post-latch output, carrier retained durably.
        def fork_proc(events):
            started, closed = events

            class Proc:
                def poll(self):
                    return 0 if closed.is_set() else None

                def communicate(self, **kwargs):
                    started.set()
                    closed.wait(2)
                    return "", ""

                def kill(self):
                    closed.set()
            return Proc()

        def patches(proc, live):
            stack = ExitStack()
            for target, value in (("transcript_path", "fixture"),
                                  ("_transcript_root", "fixture"),
                                  ("claude_model_for", "fixture")):
                stack.enter_context(patch.object(sup, target, return_value=value))
            stack.enter_context(patch.object(sup, "_claude_fork_context",
                                             return_value=("fixture", {})))
            stack.enter_context(patch.object(sup, "_claude_argv",
                                             return_value=["fixture"]))
            stack.enter_context(patch.object(sup.subprocess, "Popen",
                                             return_value=proc))
            stack.enter_context(patch.object(sup, "_leash"))
            stack.enter_context(patch.object(sup, "_wd_kill_tree",
                                             side_effect=lambda p: None))
            stack.enter_context(patch.object(sup, "live_row", live))
            return stack

        def settle():
            deadline = time.monotonic() + 2
            while halt._workers.get((self.slug, self.nid)) \
                    and time.monotonic() < deadline:
                time.sleep(.005)

        from unittest.mock import MagicMock
        started, closed = threading.Event(), threading.Event()
        live = MagicMock()
        with patches(fork_proc((started, closed)), live):
            self.assertTrue(sup.immediate_command(self.slug, self.nid, "/context"))
            self.assertTrue(started.wait(1))
            self.latch()          # races the in-flight fork
            closed.set()          # the fork finishes AFTER the latch
            settle()
            live.assert_not_called()
        self.assertEqual([c["text"] for c in self.org().node(self.nid)["halt_queue"]],
                         ["/context"],
                         "the command's carrier survives for after the release")
        # CONTROL: after release the same command publishes normally — the
        # gate is the latch, not a new hold on immediate commands (and the
        # kiosk hard-freeze path, which never latches, keeps this behavior).
        halt.killswitch_release(self.slug)
        started2, closed2 = threading.Event(), threading.Event()
        live2 = MagicMock()
        with patches(fork_proc((started2, closed2)), live2):
            self.assertTrue(sup.immediate_command(self.slug, self.nid, "/context"))
            self.assertTrue(started2.wait(1))
            closed2.set()
            settle()
            self.assertEqual(live2.call_count, 1,
                             "an un-latched org publishes the output row")

    def test_agent_tools_are_refused_while_latched(self):
        from orgtree import api
        from fastapi import HTTPException
        request = SimpleNamespace(state=SimpleNamespace())
        self.latch()
        with self.assertRaises(HTTPException) as e:
            api.agent_call(api.AgentCall(org=self.slug, node=self.nid,
                                         tool="orgtree_message",
                                         args={"to": "boss", "body": "no"}),
                           request)
        self.assertEqual(e.exception.status_code, 409)
        self.assertIn("killswitch", str(e.exception.detail))

    def test_http_routes_latch_block_release_and_tree_projection(self):
        import asyncio
        import httpx
        from orgtree import api

        async def exercise():
            transport = httpx.ASGITransport(app=api.app)
            async with httpx.AsyncClient(transport=transport,
                                         base_url="http://fixture") as client:
                r = await client.post(f"/api/orgs/{self.slug}/killswitch")
                self.assertEqual(r.status_code, 200)
                body = r.json()
                self.assertTrue(body["latched"])
                self.assertIn("interrupted", body)
                r = await client.get(f"/api/orgs/{self.slug}")
                payload = r.json()
                self.assertTrue(payload["killswitch"]["at"])
                self.assertEqual(payload["killswitch"]["by"], ledger.USER)
                r = await client.post(f"/api/orgs/{self.slug}/resume")
                self.assertEqual(r.status_code, 409)
                self.assertIn("killswitch", r.json()["detail"])
                base = f"/api/orgs/{self.slug}/nodes/{self.nid}"
                r = await client.post(base + "/message",
                                      json={"text": "durable user mail"})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json()["deferred"], "killswitch")
                r = await client.post(base + "/message", json={"text": "/compact"})
                self.assertEqual(r.status_code, 409)
                self.assertIn("killswitch", r.json()["detail"])
                r = await client.post(f"/api/orgs/{self.slug}/killswitch/release")
                self.assertTrue(r.json()["released"])
                r = await client.get(f"/api/orgs/{self.slug}")
                self.assertIsNone(r.json()["killswitch"])
                r = await client.post(f"/api/orgs/{self.slug}/killswitch/release")
                self.assertFalse(r.json()["released"])

        with patch.object(sup, "_run_turn") as run, patch.object(sup, "mail_spark"):
            asyncio.run(exercise())
            run.assert_not_called()
        self.assertEqual(len(self.org().d["mail"][self.nid]), 1,
                         "mail sent during the latch stays safe and unread")


if __name__ == "__main__":
    unittest.main()
