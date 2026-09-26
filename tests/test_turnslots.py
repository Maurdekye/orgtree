"""The machine-wide turn-slot queue is FAIR (user ruling 2026-09-26).

FIFO within an org, round-robin across orgs, a live-editable limit, no
polling, and no slot lost to a cancelled waiter. The ordering checks are also
run against two deliberately broken schedulers (LIFO, and a single FIFO that
ignores orgs) and must catch both — a fairness test that has never failed may
be asserting nothing.
"""
import os
import tempfile
import threading
import time
import unittest

_ROOT = tempfile.TemporaryDirectory(prefix="v3-turnslots-")
os.environ["ORGTREE_DATA"] = _ROOT.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import turnslots  # noqa: E402

WAIT_S = 10


# ── deliberately broken schedulers (mutants) ─────────────────────────────
class LifoSlots(turnslots.FairSlots):
    """Mutant: newest waiter first."""

    def _dispatch(self):
        while self._held < self._limit:
            org = self._next_org()
            if org is None:
                return
            t = self._queues[org].pop()          # LIFO
            t.granted = True
            self._held += 1
            self._last_org = org


class OrgBlindSlots(turnslots.FairSlots):
    """Mutant: one global FIFO, orgs ignored."""

    def acquire(self, org, *a, **kw):
        return super().acquire("*", *a, **kw)


# ── harness ───────────────────────────────────────────────────────────────
def admission_order(slots, first_org, waiters):
    """Hold the only slot as `first_org`, queue `waiters` [(org, label)] in
    exactly that arrival order, then release one at a time and return the
    order in which the waiters were admitted."""
    slots.set_limit(1)
    slots.acquire(first_org)
    order, gates, threads = [], {}, []
    lock = threading.Lock()

    def run(org, label):
        slots.acquire(org)
        with lock:
            order.append(label)
        gates[label].wait(WAIT_S)
        slots.release()

    for n, (org, label) in enumerate(waiters, start=1):
        gates[label] = threading.Event()
        th = threading.Thread(target=run, args=(org, label), daemon=True)
        threads.append(th)
        th.start()
        deadline = time.monotonic() + WAIT_S
        while slots.snapshot()["waiting"] < n and time.monotonic() < deadline:
            time.sleep(0.002)
        assert slots.snapshot()["waiting"] == n, "positive control: waiter queued"
    slots.release()                                   # first_org leaves
    for k in range(len(waiters)):
        deadline = time.monotonic() + WAIT_S
        while len(order) <= k and time.monotonic() < deadline:
            time.sleep(0.002)
        if len(order) <= k:
            break
        gates[order[k]].set()
    for th in threads:
        th.join(WAIT_S)
    return order


FIFO_CASE = ("a", [("a", "a1"), ("a", "a2"), ("a", "a3"), ("a", "a4")])
FIFO_WANT = ["a1", "a2", "a3", "a4"]
# org a (served last: it held the slot) has four waiters queued BEFORE b's
# and c's single ones. Fair = the next org after a in the ring, then onward.
FAIR_CASE = ("a", [("a", "a1"), ("a", "a2"), ("a", "a3"), ("b", "b1"),
                   ("c", "c1"), ("a", "a4")])
FAIR_WANT = ["b1", "c1", "a1", "a2", "a3", "a4"]


class FairSlotsOrdering(unittest.TestCase):
    def test_fifo_within_one_org(self):
        self.assertEqual(admission_order(turnslots.FairSlots(1), *FIFO_CASE), FIFO_WANT)

    def test_round_robin_across_orgs(self):
        order = admission_order(turnslots.FairSlots(1), *FAIR_CASE)
        self.assertEqual(order, FAIR_WANT)
        # the plain-language property: a quiet org's only waiter is not held
        # behind a busy org's backlog
        self.assertLess(order.index("b1"), order.index("a1"))
        self.assertLess(order.index("c1"), order.index("a1"))


class MutantsAreCaught(unittest.TestCase):
    """The ordering checks above must FAIL on a broken scheduler."""

    def test_lifo_mutant_breaks_fifo(self):
        self.assertNotEqual(admission_order(LifoSlots(1), *FIFO_CASE), FIFO_WANT)

    def test_lifo_mutant_breaks_fairness(self):
        self.assertNotEqual(admission_order(LifoSlots(1), *FAIR_CASE), FAIR_WANT)

    def test_org_blind_fifo_mutant_breaks_fairness(self):
        order = admission_order(OrgBlindSlots(1), *FAIR_CASE)
        self.assertNotEqual(order, FAIR_WANT)
        self.assertLess(order.index("a1"), order.index("b1"),
                        "the org-blind mutant really does starve b behind a")


class FairSlotsBehaviour(unittest.TestCase):
    def test_cancel_is_prompt_leaves_queue_and_leaks_nothing(self):
        slots = turnslots.FairSlots(1)
        slots.acquire("a")
        flag = threading.Event()
        out = []

        def waiter():
            try:
                slots.acquire("b", cancelled=flag.is_set, max_wait=30)
                out.append("entered")
            except turnslots.Cancelled:
                out.append("cancelled")

        th = threading.Thread(target=waiter, daemon=True)
        th.start()
        deadline = time.monotonic() + WAIT_S
        while slots.snapshot()["waiting"] < 1 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(slots.snapshot()["waiting"], 1, "positive control: queued")
        t0 = time.monotonic()
        flag.set()
        slots.wake()
        th.join(WAIT_S)
        # woken by wake(), not by the 30 s safety net: nothing polls
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertEqual(out, ["cancelled"])
        self.assertEqual(slots.snapshot(), {"limit": 1, "held": 1, "waiting": 0,
                                            "waiting_by_org": {}})
        slots.release()
        self.assertEqual(slots.snapshot()["held"], 0)

    def test_granted_and_cancelled_at_once_hands_the_slot_on(self):
        slots = turnslots.FairSlots(0)
        flag = threading.Event()
        out = []

        def first():
            try:
                slots.acquire("a", cancelled=flag.is_set, max_wait=30)
                out.append("a entered")
            except turnslots.Cancelled:
                out.append("a cancelled")

        def second():
            slots.acquire("b", max_wait=30)
            out.append("b entered")

        ta = threading.Thread(target=first, daemon=True); ta.start()
        deadline = time.monotonic() + WAIT_S
        while slots.snapshot()["waiting"] < 1 and time.monotonic() < deadline:
            time.sleep(0.002)
        tb = threading.Thread(target=second, daemon=True); tb.start()
        while slots.snapshot()["waiting"] < 2 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(slots.snapshot()["waiting"], 2, "positive control")
        # grant a's ticket AND cancel it inside one critical section, so a
        # wakes to a ticket that is both granted and cancelled
        with slots._cond:
            flag.set()
            slots._limit = 1
            slots._dispatch()
            slots._cond.notify_all()
        ta.join(WAIT_S); tb.join(WAIT_S)
        self.assertEqual(sorted(out), ["a cancelled", "b entered"])
        self.assertEqual(slots.snapshot()["held"], 1, "b holds the slot a handed on")
        slots.release()
        self.assertEqual(slots.snapshot()["held"], 0)

    def test_live_limit_raise_admits_and_lower_does_not_preempt(self):
        slots = turnslots.FairSlots(1)
        slots.acquire("a")
        entered = threading.Semaphore(0)
        threads = [threading.Thread(target=lambda o=o: (slots.acquire(o), entered.release()),
                                    daemon=True) for o in ("b", "c")]
        for th in threads:
            th.start()
        deadline = time.monotonic() + WAIT_S
        while slots.snapshot()["waiting"] < 2 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(slots.snapshot()["waiting"], 2, "positive control")
        slots.set_limit(3)
        self.assertTrue(entered.acquire(timeout=WAIT_S))
        self.assertTrue(entered.acquire(timeout=WAIT_S))
        self.assertEqual(slots.snapshot()["held"], 3)
        slots.set_limit(1)                            # never preempts
        self.assertEqual(slots.snapshot()["held"], 3)
        slots.release(); slots.release()
        late = []
        th = threading.Thread(target=lambda: (slots.acquire("d"), late.append(1)), daemon=True)
        th.start()
        time.sleep(0.2)
        self.assertEqual(late, [], "still at the (lowered) limit: nobody new admitted")
        slots.release()
        th.join(WAIT_S)
        self.assertEqual(late, [1])

    def test_no_lost_wakeups_and_limit_never_exceeded(self):
        slots = turnslots.FairSlots(3)
        lock = threading.Lock()
        live = [0]; peak = [0]; done = [0]

        def worker(org):
            for _ in range(20):
                slots.acquire(org)
                with lock:
                    live[0] += 1; peak[0] = max(peak[0], live[0])
                time.sleep(0.0005)
                with lock:
                    live[0] -= 1
                slots.release()
            with lock:
                done[0] += 1

        threads = [threading.Thread(target=worker, args=(f"org{i % 4}",), daemon=True)
                   for i in range(24)]
        for th in threads:
            th.start()
        for th in threads:
            th.join(60)
        self.assertEqual(done[0], 24, "every worker finished: no waiter was stranded")
        self.assertLessEqual(peak[0], 3)
        self.assertGreater(peak[0], 1, "positive control: there was real concurrency")
        self.assertEqual(slots.snapshot()["held"], 0)
        self.assertEqual(slots.snapshot()["waiting"], 0)

    def test_release_without_acquire_is_refused(self):
        with self.assertRaises(RuntimeError):
            turnslots.FairSlots(1).release()


class SupervisorWiring(unittest.TestCase):
    """The real admission wrapper: queued_for_slot, prompt interrupt, and the
    live limit reached through the setting."""

    @classmethod
    def setUpClass(cls):
        from orgtree import appsettings, ledger, store, supervisor
        cls.appsettings, cls.store, cls.sup = appsettings, store, supervisor
        org = store.create_org("slots-wiring")
        org.hire(ledger.USER, None, "haiku", 0, "worker")
        store.save_org(org)

    @classmethod
    def tearDownClass(cls):
        cls.store._POOL.close_all("slots-wiring")

    def setUp(self):
        self.old = self.sup._turn_slots
        self.st = self.sup.state("slots-wiring", "worker")
        with self.sup._state_lock:
            self.st.clear()
            self.st.update({"busy": True, "waiting": False, "queue": [],
                            "steer": [], "responding": False})

    def tearDown(self):
        self.sup._turn_slots = self.old

    def _queue_one(self, out):
        def admit():
            try:
                with self.sup._InterruptibleTurnSlot(self.st, "slots-wiring"):
                    out.append("entered")
                    out.append(self.st.get("queued_for_slot"))
            except self.sup._AdmissionCancelled:
                out.append("cancelled")
        th = threading.Thread(target=admit, daemon=True)
        th.start()
        deadline = time.monotonic() + WAIT_S
        while not self.st.get("queued_for_slot") and time.monotonic() < deadline:
            time.sleep(0.005)
        return th

    def test_queued_flag_set_while_waiting_and_cleared_on_admission(self):
        self.sup._turn_slots = turnslots.FairSlots(0)
        out = []
        th = self._queue_one(out)
        q = self.st.get("queued_for_slot")
        self.assertIsInstance(q, dict, "positive control: the node says it is queued")
        self.assertEqual(q["limit"], 0)
        self.assertEqual(q["waiting"], 1)
        self.assertIn("queued_for_slot", self.sup._TREE_STATE_KEYS)
        self.sup.set_turn_limit(1)                    # the live setting path
        th.join(WAIT_S)
        self.assertEqual(out, ["entered", None])
        self.assertNotIn("queued_for_slot", self.st)
        self.assertEqual(self.sup._turn_slots.snapshot()["held"], 0)

    def test_interrupt_wakes_a_queued_turn_at_once(self):
        self.sup._turn_slots = turnslots.FairSlots(0)
        out = []
        th = self._queue_one(out)
        self.assertTrue(self.st.get("queued_for_slot"), "positive control")
        t0 = time.monotonic()
        res = self.sup.interrupt_turn("slots-wiring", "worker")
        th.join(WAIT_S)
        self.assertLess(time.monotonic() - t0, 2.0, "woken, not left to the safety timeout")
        self.assertEqual(res.get("reason"), "turn waiting for a turn slot")
        self.assertEqual(out, ["cancelled"])
        self.assertNotIn("queued_for_slot", self.st)
        self.assertEqual(self.sup._turn_slots.snapshot()["waiting"], 0)

    def test_setting_bounds_and_round_trip(self):
        a = self.appsettings
        self.assertIsNone(a.max_concurrent_turns())
        for bad in (0, 513, "16", 2.5, True):
            with self.assertRaises(ValueError):
                a.set_max_concurrent_turns(bad)
        a.set_max_concurrent_turns(40)
        self.assertEqual(a.max_concurrent_turns(), 40)
        self.assertEqual(self.sup._initial_turn_limit(), 40)


if __name__ == "__main__":
    unittest.main()
