"""Codex turn start drains the queued mail pointers in one turn (MAX_BATCH cap).

A pointer queued while an agent is busy names only the mail boxed when it was
sent, so without the batch drain a burst of N sends to a busy codex agent took
N turns. These drive the real `_run_turn` loop and admission around the
synthetic provider leg (`tools.scale.simulated`) and count provider starts.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

# engine log lines carry non-ASCII; a cp1252 pipe must not fail the turn
for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

_root = tempfile.TemporaryDirectory(prefix="codex-batch-drain-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_provenance  # noqa: F401
from orgtree import halt, ledger, maildrain, orgtx, store, supervisor as sup
from tools.scale.simulated import SimulatedProvider


class _Recording(SimulatedProvider):
    """The simulated leg, keeping the text each started turn was handed."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.texts = []

    def __call__(self, slug, nid, org, st, text, toks, *a, **kw):
        self.texts.append(text)
        return super().__call__(slug, nid, org, st, text, toks, *a, **kw)


class CodexBatchDrainTests(unittest.TestCase):
    model = "luna"

    def setUp(self):
        self.slug = "cbd-" + uuid.uuid4().hex[:10]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, self.model, 0, "worker")
        org.node("worker")["session_id"] = str(uuid.uuid4())
        store.save_org(org)
        self.st = sup.state(self.slug, "worker")
        self.adapter = _Recording(sup, halt, slug=self.slug, nodes=["worker"], seconds=0)
        self.patches = [patch.object(sup, "_codex_leg", self.adapter),
                        patch.object(sup, "_after_turn", self.adapter.finish),
                        patch.object(sup, "spawn_env", return_value={}),
                        patch.object(sup, "_deployment_org_gate"),
                        patch.object(sup, "_phantom_log"),
                        patch.object(sup, "_native_context_hold", return_value=None),
                        patch.object(sup, "_cancel_working_cache"),
                        patch.object(sup, "_note_working_activity"),
                        patch.object(sup, "_hold_for_deploy", return_value=True),
                        patch.object(sup.subprocess, "Popen",
                                     side_effect=FileNotFoundError("external process forbidden"))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        with sup._state_lock:
            self.st["queue"] = []
            self.st["busy"] = False
        maildrain._forget(self.slug, "worker")
        store._POOL.close_all(self.slug)

    def burst(self, n):
        """n sends to a BUSY agent, each queued the way `_admit_message` queues
        it: a pointer naming the mail boxed at its own send. Returns the bodies
        and the first pointer (the one the worker starts with)."""
        bodies, box, carriers = [], [], []
        for i in range(n):
            org = orgtx.org_read(self.slug)
            body = f"burst mail {i:03d} {uuid.uuid4().hex[:6]}"
            m = org.post_mail(ledger.USER, "worker", body)
            store.save_org(org)
            bodies.append(body)
            box.append(str(m["id"]))
            carriers.append(sup._mark_ping("(orgtree) new mail", mail_ids=list(box)))
        with sup._state_lock:
            self.st["busy"] = True
            self.st["queue"].extend(carriers[1:])
        return bodies, carriers[0]

    def assert_all_delivered_once(self, bodies):
        joined = "\n".join(self.adapter.texts)
        for b in bodies:
            self.assertEqual(joined.count(b), 1, f"{b!r} delivered {joined.count(b)} times")
        stored = orgtx.org_read(self.slug)
        self.assertFalse((stored.d.get("mail") or {}).get("worker"), "mail left in the box")
        self.assertFalse((stored.d.get("delivering") or {}).get("worker"), "batch left unconfirmed")
        self.assertFalse(self.st.get("queue"))
        self.assertFalse(self.st.get("busy"))

    def test_burst_while_busy_is_one_turn(self):
        bodies, first = self.burst(6)
        sup._run_turn(self.slug, "worker", first)
        self.assertEqual(self.adapter.snapshot()["started"], 1,
                         f"a burst of 6 queued pointers must drain in ONE codex turn "
                         f"(last_error={self.st.get('last_error')!r})")
        self.assert_all_delivered_once(bodies)

    def test_batch_cap_is_max_batch_carriers_per_turn(self):
        n = maildrain.MAX_BATCH + 7
        bodies, first = self.burst(n)
        sup._run_turn(self.slug, "worker", first)
        self.assertEqual(self.adapter.snapshot()["started"], 2)
        first_turn = self.adapter.texts[0]
        self.assertEqual(sum(b in first_turn for b in bodies), maildrain.MAX_BATCH)
        # the first MAX_BATCH in send order, never a later one ahead of them
        self.assertTrue(all(b in first_turn for b in bodies[:maildrain.MAX_BATCH]))
        self.assert_all_delivered_once(bodies)

    def test_absorption_stops_at_a_carrier_that_is_not_a_plain_pointer(self):
        bodies, first = self.burst(4)
        with sup._state_lock:
            # queue is now [p2, p3, p4]; put an authored carrier after p2
            self.st["queue"].insert(1, {"text": "authored words", "view": "authored words"})
        sup._run_turn(self.slug, "worker", first)
        started = self.adapter.snapshot()["started"]
        self.assertEqual(started, 2, "pointers + authored text: exactly two turns")
        self.assertIn(bodies[0], self.adapter.texts[0])
        self.assertIn(bodies[1], self.adapter.texts[0])
        for b in bodies[2:]:
            self.assertNotIn(b, self.adapter.texts[0],
                             "absorption must not reach past a non-pointer carrier")
        self.assertIn("authored words", self.adapter.texts[1])
        self.assert_all_delivered_once(bodies)

    def test_halt_before_the_turn_keeps_every_pointed_mail(self):
        bodies, first = self.burst(5)
        org = orgtx.org_read(self.slug)
        org.node("worker")["halt"] = {"phase": "halted"}
        store.save_org(org)
        sup._run_turn(self.slug, "worker", first)
        self.assertEqual(self.adapter.snapshot()["started"], 0)
        stored = orgtx.org_read(self.slug)
        box = [m["body"] for m in (stored.d.get("mail") or {}).get("worker") or []]
        self.assertEqual(sorted(box), sorted(bodies), "halt must leave all mail boxed")

    def test_failed_drain_after_absorbing_keeps_a_pointer_to_every_mail(self):
        """The drain fails AFTER the pointers were absorbed: every mail must
        stay boxed AND still be named by some surviving carrier (queue, the
        worker's pending slot, or the node's durable halt/inflight rows), or
        it would sit in the box with nothing to wake the agent for it."""
        bodies, first = self.burst(5)
        real_take = sup._take_delivery_mail
        armed = [True]

        def failing_take(org, nid, mail_ids=None):
            if armed[0]:
                armed[0] = False
                raise RuntimeError("injected drain failure")
            return real_take(org, nid, mail_ids)
        fired = []
        with patch.object(sup, "_take_delivery_mail", failing_take):
            try:
                sup._run_turn(self.slug, "worker", first)
            except RuntimeError as exc:
                fired.append(str(exc))
        self.assertFalse(armed[0], "the injected failure never ran")
        stored = orgtx.org_read(self.slug)
        box = {str(m["id"]): m["body"] for m in (stored.d.get("mail") or {}).get("worker") or []}
        delivered = chr(10).join(self.adapter.texts)
        named = set()
        carriers = list(self.st.get("queue") or [])
        carriers += list((self.st.get("halt_pending_carriers") or {}).values())
        n = stored.node("worker")
        carriers += list(n.get("halt_queue") or [])
        if n.get("inflight"):
            carriers.append(n["inflight"])
        for c in carriers:
            if isinstance(c, dict):
                if c.get("mail_ids") is None and c.get("ping") is not True:
                    named.update(box)          # an unrestricted carrier drains all
                named.update(str(i) for i in c.get("mail_ids") or [])
        for mid, body in box.items():
            self.assertTrue(mid in named or body in delivered,
                            f"{body!r} is boxed with no carrier naming it")
        for body in bodies:
            self.assertTrue(body in box.values() or delivered.count(body) == 1,
                            f"{body!r} lost")

    def test_queue_depth_is_recorded_at_turn_start(self):
        seen = []
        real = sup.turnlog.emit

        def spy(rec, kind, /, **fields):
            if kind == "codex_queue_at_start":
                seen.append(fields)
            return real(rec, kind, **fields)
        bodies, first = self.burst(3)
        with patch.object(sup.turnlog, "emit", spy):
            sup._run_turn(self.slug, "worker", first)
        self.assertEqual(seen, [{"depth": 2, "absorbed": 2}])


class ClaudeLaneUnchangedTests(unittest.TestCase):
    """The claude lane keeps its own result-boundary feed; admission must not
    absorb its queue. The claude spawn is forbidden here, so the turn fails
    after admission — which is exactly where absorption would have happened."""

    def test_claude_admission_never_absorbs(self):
        slug = "cbdc-" + uuid.uuid4().hex[:10]
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "haiku", 0, "worker")
        org.node("worker")["session_id"] = str(uuid.uuid4())
        ids = [str(org.post_mail(ledger.USER, "worker", f"c{i}")["id"]) for i in range(3)]
        store.save_org(org)
        st = sup.state(slug, "worker")
        calls = []
        real = sup._absorb_queued_pointers

        def spy(*a, **kw):
            calls.append(a)
            return real(*a, **kw)
        drains = []
        real_take = sup._take_delivery_mail

        def take_spy(org, nid, mail_ids=None):
            drains.append(list(mail_ids) if mail_ids is not None else None)
            return real_take(org, nid, mail_ids)
        queued = [sup._mark_ping("(orgtree) new mail", mail_ids=ids[:k]) for k in (2, 3)]
        with sup._state_lock:
            st["busy"] = True
            st["queue"].extend(queued)
        try:
            with patch.object(sup, "_absorb_queued_pointers", spy),                     patch.object(sup, "_take_delivery_mail", take_spy),                     patch.object(sup, "_native_context_hold", return_value=None), \
                    patch.object(sup, "spawn_env", return_value={}), \
                    patch.object(sup, "_deployment_org_gate"), \
                    patch.object(sup.subprocess, "Popen",
                                 side_effect=FileNotFoundError("external process forbidden")):
                sup._run_one_turn(slug, "worker",
                                  sup._mark_ping("(orgtree) new mail", mail_ids=ids[:1]))
            # the control: admission really reached the drain, with the
            # carrier's own ids only
            self.assertEqual(drains[:1], [ids[:1]], "claude turn never reached the drain")
            self.assertEqual(calls, [], "claude admission must not absorb queued pointers")
        finally:
            with sup._state_lock:
                st["queue"] = []
                st["busy"] = False
            maildrain._forget(slug, "worker")
            store._POOL.close_all(slug)


if __name__ == "__main__":
    unittest.main()
