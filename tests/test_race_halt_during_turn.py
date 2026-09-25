"""PYPG race test 5: halt during a turn (PG-3a halt.py x PG-3e admission).

User invariant (docs/v2-user-decisions.md, 12 September 2026): "A turn
cannot run while its agent is halted." Under PYPG the ordering that used to
come from DOC_LOCK comes from the agent's NODE ROW: admission holds it FOR
UPDATE across the blocked decision and its body, and a halt commits
`halting` on the same row before it kills anything. These arms force the two
orders with org_tx's test pause hooks and check the order that was achieved:

  (i)   admission first — admission holds the row; halt must not commit
        `halting` until admission is done; the turn it admitted then either
        runs (and `halted` waits for it) or is refused with its carrier
        retained — never runs under `halted`, never lost;
  (ii)  halt first — halt holds the row; admission must wait, then see the
        halt and start NO turn body;
  (iii) halt during a running turn — once `halting` has committed, neither a
        fresh admission nor a fresh worker (a provider callback, a follow-up)
        may start a body, and `halted` is published only after the running
        body has left.

Every arm runs twice: with the transition fence (DOC_LOCK before the row,
halt._FENCE=True, what ships now) and without it (the end state, where only
the row orders them). A PAUSE COUNTER must prove each pause actually held a
transaction, or the arm fails: a race test whose interleaving never happened
proves nothing.

Run:  python tools/run-python-verification.py tests/test_race_halt_during_turn.py
"""
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-rt5-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_ORGTX_TEST_HOOKS"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, orgtx, store, supervisor as sup, warmpool  # noqa: E402

WAIT = 5.0


class Pause:
    """An org_tx pause hook that holds ONE named thread's transaction at one
    point until released, and counts every time it actually held one."""

    def __init__(self, thread_name: str, point: str, nid: str):
        self.thread_name, self.point, self.nid = thread_name, point, nid
        self.held = threading.Event()
        self.release = threading.Event()
        self.fired = 0
        self.seen: list[tuple[str, str]] = []   # (thread, point) for every tx on nid
        self._lock = threading.Lock()

    def __call__(self, point: str, tx: orgtx.OrgTx) -> None:
        if self.nid not in (tx.lock_nodes | tx.share_nodes):
            return
        name = threading.current_thread().name
        with self._lock:
            self.seen.append((name, point))
        if name == self.thread_name and point == self.point and not self.held.is_set():
            with self._lock:
                self.fired += 1
            self.held.set()
            if not self.release.wait(WAIT):
                raise AssertionError("pause was never released")

    def points(self, thread_name: str) -> list[str]:
        with self._lock:
            return [p for n, p in self.seen if n == thread_name]


class RaceHaltDuringTurn(unittest.TestCase):
    FENCE = True

    def setUp(self):
        self.slug = "rt5-" + str(time.time_ns())
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
        self.stack.enter_context(patch.object(halt, "_FENCE", self.FENCE))
        self.stack.callback(orgtx.set_pause_hook, None)
        self.log: list[str] = []
        self.log_lock = threading.Lock()
        self.bodies = 0
        self.body_entered = threading.Event()
        self.body_may_leave = threading.Event()
        self.threads: list[threading.Thread] = []
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        self.body_may_leave.set()
        for t in self.threads:
            t.join(WAIT)
        self.stack.close()
        store._POOL.close_all(self.slug)

    # ---------------------------------------------------------- the fixture
    def note(self, what: str) -> None:
        with self.log_lock:
            self.log.append(what)

    def durable_phase(self) -> str | None:
        return (store.load_org(self.slug).node(self.nid).get("halt") or {}).get("phase")

    def make_turn(self):
        """A turn owner exactly as supervisor registers one: `@halt.worker`
        around the body. The body records that it ran and, while running,
        whether the durable record already said `halted` (a violation)."""
        test = self

        @halt.worker
        def _run_turn(slug, nid, carrier):
            with sup._state_lock:
                test.st["busy"] = True
            test.bodies += 1
            test.note("body-enter")
            if test.durable_phase() == "halted":
                test.note("VIOLATION body ran while halted")
            test.body_entered.set()
            test.body_may_leave.wait(WAIT)
            if test.durable_phase() == "halted":
                test.note("VIOLATION halted published before the body left")
            test.note("body-leave")
            with sup._state_lock:
                test.st["busy"] = False
        return _run_turn

    def make_send(self, turn):
        """The send door as supervisor shapes it: `@halt.admission` around a
        body that starts the turn worker (on its own thread, like
        `_start_turn_worker`)."""
        test = self

        @halt.admission
        def send(slug, nid, text, **kw):
            test.note("admitted")
            t = threading.Thread(target=turn, args=(slug, nid, {"text": text}),
                                 name="rt5-turn", daemon=True)
            test.threads.append(t)
            t.start()
            return {"accepted": True}
        return send

    def spawn(self, name, fn, *args, **kw):
        out: dict = {}

        def run():
            try:
                out["result"] = fn(*args, **kw)
            except BaseException as e:          # noqa: BLE001
                out["error"] = e
        t = threading.Thread(target=run, name=name, daemon=True)
        self.threads.append(t)
        t.start()
        return t, out

    def halt_in_thread(self, **kw):
        def run():
            r = halt.halt(self.slug, self.nid, **kw)
            self.note("halt-returned")
            return r
        return self.spawn("rt5-halt", run)

    def assert_clean(self):
        self.assertEqual([x for x in self.log if x.startswith("VIOLATION")], [])

    # ---------------------------------------------------------- the arms
    def test_i_admission_first_then_halt_waits_for_the_admitted_turn(self):
        pause = Pause("rt5-admit", "after_lock", self.nid)
        orgtx.set_pause_hook(pause)
        turn = self.make_turn()
        send = self.make_send(turn)
        admit_t, admit = self.spawn("rt5-admit", send, self.slug, self.nid, "work")
        self.assertTrue(pause.held.wait(WAIT), "admission never reached its locks")
        halt_t, halted = self.halt_in_thread(timeout=WAIT)
        time.sleep(0.3)
        # admission holds the row: the halt has not locked it, let alone
        # committed `halting`
        self.assertNotIn("after_lock", pause.points("rt5-halt"))
        self.assertIsNone(self.durable_phase())
        pause.release.set()
        admit_t.join(WAIT)
        self.assertEqual(admit.get("result"), {"accepted": True})
        # The admitted message started its turn worker on another thread, and
        # that worker and the halt now race. Both outcomes keep the invariant,
        # and which one happens is scheduling: with the fence the worker
        # usually queues behind the halt on DOC_LOCK, exactly as before PYPG.
        #   ran:     the body entered before `halting` committed, and `halted`
        #            waits for it to leave;
        #   refused: the worker saw `halting`, ran nothing, and its carrier
        #            is retained for after unhalt.
        if self.body_entered.wait(1.0):
            deadline = time.monotonic() + WAIT
            while self.durable_phase() != "halting" and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(self.durable_phase(), "halting")
            time.sleep(0.3)
            self.assertEqual(self.durable_phase(), "halting")
            self.body_may_leave.set()
            halt_t.join(WAIT + 2)
            self.assertEqual(self.bodies, 1)
            self.assertLess(self.log.index("body-leave"), self.log.index("halt-returned"))
            outcome = "ran"
        else:
            halt_t.join(WAIT + 2)
            for t in self.threads:
                t.join(WAIT)
            self.assertEqual(self.bodies, 0)
            outcome = "refused"
        self.assertFalse(halt_t.is_alive())
        self.assertTrue(halted["result"]["halted"], halted)
        self.assertEqual(self.durable_phase(), "halted")
        texts = [c.get("text") for c in
                 store.load_org(self.slug).node(self.nid).get("halt_queue") or []]
        # the admitted carrier is never lost: retained whether it ran (its
        # input was never confirmed by a provider) or was refused
        self.assertIn("work", texts, outcome)
        self.assertEqual(pause.fired, 1, "the pause never held admission's transaction")
        self.assert_clean()

    def test_ii_halt_first_then_admission_starts_no_body(self):
        pause = Pause("rt5-halt", "after_lock", self.nid)
        orgtx.set_pause_hook(pause)
        turn = self.make_turn()
        send = self.make_send(turn)
        halt_t, halted = self.halt_in_thread(timeout=WAIT)
        self.assertTrue(pause.held.wait(WAIT), "halt never reached its locks")
        admit_t, admit = self.spawn("rt5-admit", send, self.slug, self.nid, "work")
        time.sleep(0.3)
        # halt holds the row: admission has not locked it
        self.assertNotIn("after_lock", pause.points("rt5-admit"))
        self.assertNotIn("admitted", self.log)
        pause.release.set()
        halt_t.join(WAIT)
        admit_t.join(WAIT)
        self.assertTrue(halted["result"]["halted"], halted)
        r = admit.get("result")
        self.assertIsNotNone(r, admit)
        self.assertEqual(r["deferred"], "halted")
        self.assertNotIn("admitted", self.log)
        self.assertEqual(self.bodies, 0)
        # the refused command is retained for after unhalt, not lost
        queue = store.load_org(self.slug).node(self.nid).get("halt_queue") or []
        self.assertEqual([c.get("text") for c in queue], ["work"])
        self.assertEqual(pause.fired, 1, "the pause never held the halt's transaction")
        self.assert_clean()

    def test_iii_halt_during_a_running_turn_admits_no_new_work(self):
        # the pause holds the halt's `halted` publication open (its SECOND
        # transaction on the row) so the arm can probe the halting window
        turn = self.make_turn()
        send = self.make_send(turn)
        self.assertEqual(send(self.slug, self.nid, "first"), {"accepted": True})
        self.assertTrue(self.body_entered.wait(WAIT))
        halt_t, halted = self.halt_in_thread(timeout=WAIT)
        deadline = time.monotonic() + WAIT
        while self.durable_phase() != "halting" and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.durable_phase(), "halting")
        probes = 0
        # a fresh admission: deferred and retained, no body
        r = send(self.slug, self.nid, "second")
        probes += 1
        self.assertEqual(r["deferred"], "halted")
        self.assertTrue(r["halting"])
        # a fresh turn worker (a follow-up turn): returns without running,
        # its carrier retained
        ran = []

        @halt.worker
        def _run_one_turn(slug, nid, carrier):
            ran.append(carrier)
        self.assertIsNone(_run_one_turn(self.slug, self.nid, {"text": "third"}))
        probes += 1
        # a provider callback: returns without running; its arguments are not
        # user input, so nothing is retained for it

        @halt.worker
        def on_event(slug, nid, event):
            ran.append(event)
        self.assertIsNone(on_event(self.slug, self.nid, {"text": "event"}))
        probes += 1
        # PG-3e-A: the REAL turn-admission gate (supervisor's slot gate, the
        # point of no return). Opened on its own row set and decided on the
        # rows it locked, it refuses before any mail is drained. The halt is
        # waiting for the running body here, holding no row lock, so this
        # transaction is granted rather than blocked.
        with self.assertRaises(halt.Cancelled):
            with halt.txn(self.slug,
                          **sup._admission_rows(self.slug, self.nid)) as tx:
                sup._admission_gates(self.slug, tx.org, self.nid)
        probes += 1
        self.assertEqual(ran, [])
        self.assertEqual(self.bodies, 1)
        self.assertEqual(probes, 4)
        # still halting while the first body is inside
        self.assertEqual(self.durable_phase(), "halting")
        self.body_may_leave.set()
        halt_t.join(WAIT + 2)
        self.assertFalse(halt_t.is_alive())
        self.assertTrue(halted["result"]["halted"], halted)
        self.assertEqual(self.bodies, 1)
        self.assertLess(self.log.index("body-leave"), self.log.index("halt-returned"))
        texts = [c.get("text") for c in
                 store.load_org(self.slug).node(self.nid).get("halt_queue") or []]
        self.assertIn("second", texts)
        self.assertIn("third", texts)
        self.assertNotIn("event", texts)
        self.assert_clean()


class RaceHaltDuringTurnNoFence(RaceHaltDuringTurn):
    """The same arms with the transition fence off: only the node row orders
    admission against halt (the end state, once DOC_LOCK is gone)."""
    FENCE = False


if __name__ == "__main__":
    unittest.main()
