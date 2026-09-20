"""Halt is a HARD PROCESS BOUNDARY that always reaches a terminal state.

Docket: fix-agents-stuck-halting-and-non-json-stop-error, user ruling
2026-09-20 — "halt must immediately terminate the agent's active
CLI/provider process, wait until that process is confirmed gone, clean up the
turn/session execution state, and only then report the node as halted."

WHAT WENT WRONG, AND WHAT EACH TEST HERE PINS. Eleven agents were halted in
parallel on the live org on 2026-09-20. Six settled. Five Luna (codex) agents
were still `halting` and still mid-turn twenty-seven minutes later, every
later stop returned `Internal Server Error`, and retire and dissolve both
returned a bare `[Errno 22] Invalid argument`. Four defects, one chain:

  R1  `CodexTurn.wait()` waits on an Event that only a `turn/completed`
      notification sets. `AppServerClient.on_exit` existed but nothing ever
      assigned it, so a killed or crashed app-server woke nobody and the turn
      sat in a four-hour `TURN_TIMEOUT`, holding its halt worker registration.
  R2  `halt._halt` published `halted` only from inside its own 20-second
      loop. Miss that window and nothing re-checked until a backend restart.
  R3  `CodexTurn.interrupt()` guarded only `CodexServerError`, so a write to
      the killed server's pipe escaped as a raw `OSError` through
      `interrupt_turn` and `interrupt_before_archive` into retire/dissolve.
  R4  an exception escaping a FastAPI handler answers `Internal Server Error`
      as `text/plain`, which the desktop then fed to `JSON.parse`.

EVERY TEST IS BOUNDED AND ISOLATED. An isolated `ORGTREE_DATA` temp root, and
the only processes spawned are synthetic children of this interpreter that
sleep or read stdin. No agent CLI, no provider, no live data root.

NEGATIVE CONTROLS ARE MARKED `test_negative_control_*`. Each one reconstructs
the pre-fix shape and asserts the SYMPTOM appears, so the passing tests
beside it are not passing vacuously.
"""
from contextlib import ExitStack
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-halt-settle-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import codexrun, halt, ledger, store, supervisor as sup, warmpool


#: a synthetic child that just blocks. Stands in for an agent CLI or a
#: provider app-server: it owns a real pid, a real stdin pipe and a real
#: process handle, which is all the halt machinery ever looks at.
BLOCKER = "import sys\nsys.stdin.buffer.read()\n"


class HaltBase(unittest.TestCase):
    def setUp(self):
        self.slug = "haltset-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.nid = "worker"
        self.st = sup.state(self.slug, self.nid)
        self.procs: list[subprocess.Popen] = []
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "_cancel_working_cache"))
        self.stack.enter_context(patch.object(warmpool, "kill_node"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.assertEqual(Path(store.DATA_ROOT).resolve(),
                         Path(_root.name).resolve())

    def tearDown(self):
        # drop any settle operation before the processes go, so a background
        # settler cannot outlive the test that started it
        with store.DOC_LOCK:
            halt._settlers.pop((self.slug, self.nid), None)
            halt._workers.pop((self.slug, self.nid), None)
            halt._worker_states.pop((self.slug, self.nid), None)
            halt._halt_states.pop((self.slug, self.nid), None)
        for p in self.procs:
            try:
                if p.poll() is None:
                    p.kill()
                p.wait(timeout=5)
            except Exception:                            # noqa: BLE001
                pass
            for pipe in (p.stdin, p.stdout, p.stderr):
                try:
                    if pipe is not None:
                        pipe.close()
                except Exception:                        # noqa: BLE001
                    pass
        self.stack.close()
        store._POOL.close_all(self.slug)

    # ── helpers ──────────────────────────────────────────────────────────
    def spawn(self) -> subprocess.Popen:
        p = subprocess.Popen(
            [sys.executable, "-c", BLOCKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0))
        self.procs.append(p)
        return p

    def org(self):
        return store.load_org(self.slug)

    def phase(self) -> str:
        rec = self.org().node(self.nid).get("halt") or {}
        return str(rec.get("phase") or "")

    def await_phase(self, want: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.phase() == want:
                return True
            time.sleep(0.05)
        return self.phase() == want

    def held_worker(self):
        """A registered halt worker that stays registered until released —
        the shape of a turn whose provider call has not returned."""
        entered, release = threading.Event(), threading.Event()

        @halt.worker
        def active(slug, nid):
            self.st["busy"] = True
            entered.set()
            release.wait(30)
            self.st["busy"] = False

        thread = threading.Thread(target=active, args=(self.slug, self.nid),
                                  daemon=True)
        thread.start()
        self.assertTrue(entered.wait(3), "the fake turn never registered")
        return thread, release


class HaltReachesATerminalState(HaltBase):
    """R2: a halt that misses its window must still finish, by itself."""

    def test_halt_kills_the_cli_and_confirms_it_before_reporting_halted(self):
        proc = self.spawn()
        self.st["proc"] = proc
        self.assertIsNone(proc.poll(), "the synthetic CLI must start alive")
        result = halt.halt(self.slug, self.nid)
        self.assertTrue(result["halted"])
        self.assertTrue(result["settled"])
        # the ruling's exact words: confirmed gone, not merely asked to go
        self.assertIsNotNone(proc.poll(),
                             "halt reported halted with the CLI still running")
        self.assertEqual(self.phase(), "halted")

    def test_a_surviving_cli_keeps_halt_from_claiming_halted(self):
        """The other half of the same ruling. A kill that cannot land must
        produce `halting` with the pid named — never `halted`."""
        proc = self.spawn()
        self.st["proc"] = proc
        with patch.object(sup, "_wd_kill_tree"):     # the kill cannot land
            result = halt.halt(self.slug, self.nid, timeout=0.4)
            self.assertFalse(result["halted"])
            self.assertTrue(result["halting"])
            self.assertEqual(self.phase(), "halting")
            kinds = {r["kind"] for r in result["surviving_processes"]}
            pids = {r["pid"] for r in result["surviving_processes"]}
            self.assertIn("cli", kinds)
            self.assertIn(proc.pid, pids)
            self.assertTrue(any("still running" in b
                                for b in result["blocking"]))
        # with the kill restored the settle operation finishes it — and
        # nobody calls halt a second time
        self.assertTrue(self.await_phase("halted", 20),
                        f"still {self.phase()}; blocking="
                        f"{halt.blocking(self.slug, self.nid)}")
        self.assertIsNotNone(proc.poll())

    def test_a_late_settling_turn_is_finished_by_the_named_operation(self):
        proc = self.spawn()
        self.st["proc"] = proc
        thread, release = self.held_worker()
        try:
            result = halt.halt(self.slug, self.nid, timeout=0.4)
            self.assertFalse(result["halted"])
            operation = result["operation"]
            self.assertTrue(str(operation["operation_id"]).startswith("halt-"))
            self.assertEqual(operation["state"], "settling")
            self.assertTrue(result["blocking"])
            # durable, so the operation is not only in this reply
            settling = self.org().node(self.nid)["halt"]["settling"]
            self.assertEqual(settling["operation_id"],
                             operation["operation_id"])
            # the CLI was killed before halt answered, even though the turn
            # bookkeeping had not finished
            self.assertIsNotNone(proc.poll())
            self.assertEqual(self.phase(), "halting")
        finally:
            release.set()
            thread.join(10)
        self.assertTrue(self.await_phase("halted", 20),
                        f"still {self.phase()}; blocking="
                        f"{halt.blocking(self.slug, self.nid)}")
        self.assertNotIn("settling", self.org().node(self.nid)["halt"])
        self.assertIsNone(halt.operation(self.slug, self.nid))

    def test_a_disagreeing_settle_check_cannot_spin_past_the_deadline(self):
        """`ed54b13` (2026-09-20) made the settle poll check `_settled`
        lock-free and re-check it under the lock. When those two disagree — a
        worker registering in between, which a provider event stream
        re-entering `halt.callback` does routinely — the arm `continue`d
        straight back to the top, skipping both the deadline test and the
        sleep. The call then spins hot and never honours its own timeout,
        which matches the coordinator's report that later halts did not
        return within 60 s. Before that commit the settled check only ever
        ran under the lock, so this path did not exist."""
        calls: list[bool] = []

        def flapping(slug, nid, st):
            # ⚠ KEYED ON THE LOCK, NOT ON A CALL COUNTER. An alternating
            # counter looked equivalent and was not: the background settler
            # calls `_settled` too, so a second caller shifted the parity and
            # the foreground could see the same answer twice. This says
            # exactly what the disagreement IS — settled to a caller that
            # does not hold the document lock, not settled to the one
            # re-checking under it — and it says it the same way however many
            # threads ask.
            answer = not store.DOC_LOCK._is_owned()   # noqa: SLF001
            calls.append(answer)
            return answer

        answered: list[dict] = []
        # `_start_settler` is stubbed out: this test is about the FOREGROUND
        # loop honouring its deadline, and a real settler would put a second
        # thread into the same patched predicate for no added coverage. The
        # settler's own behaviour is covered by the tests above.
        thread = threading.Thread(
            target=lambda: answered.append(
                halt.halt(self.slug, self.nid, timeout=0.3)), daemon=True)
        with patch.object(halt, "_settled", side_effect=flapping), \
             patch.object(halt, "_start_settler",
                          return_value={"operation_id": "halt-stub",
                                        "state": "settling"}):
            thread.start()
            thread.join(20)
            spinning = thread.is_alive()
        # the patch is gone before the assertion, so a spinning loop can
        # escape rather than staying hot for the rest of the module
        thread.join(15)
        self.assertFalse(spinning,
                         "the settle loop never reached its deadline")
        self.assertTrue(answered)
        self.assertFalse(answered[0]["halted"])
        self.assertTrue(answered[0]["halting"])
        # it really did exercise the disagreement, many times over
        self.assertIn(True, calls)
        self.assertIn(False, calls)
        self.assertGreater(len(calls), 3)

    def test_negative_control_without_the_settler_it_stays_halting(self):
        """THE PRE-FIX SHAPE. With the handoff removed, the foreground loop is
        again the only thing that can publish `halted` — so a turn that
        settles one moment after the window leaves the node halting forever.
        This is the defect the test above proves is gone."""
        proc = self.spawn()
        self.st["proc"] = proc
        thread, release = self.held_worker()
        try:
            with patch.object(halt, "_start_settler", return_value={}):
                result = halt.halt(self.slug, self.nid, timeout=0.4)
            self.assertFalse(result["halted"])
        finally:
            release.set()
            thread.join(10)
        # everything really has settled…
        self.assertTrue(halt._settled(self.slug, self.nid, self.st))
        # …and the node is still `halting` anyway, because nothing re-checks
        self.assertFalse(self.await_phase("halted", 3))
        self.assertEqual(self.phase(), "halting")
        # and the fix, applied by hand, finishes it — proving the only thing
        # missing was somebody to look again
        halt._start_settler(self.slug, self.nid)
        self.assertTrue(self.await_phase("halted", 20))


class RepeatLifecycleCallsAreStructural(HaltBase):
    """Acceptance: repeat halt/interrupt/retire/dissolve during settlement is
    idempotent or returns a structured, actionable error."""

    def test_a_second_halt_joins_the_running_operation(self):
        self.st["proc"] = self.spawn()
        thread, release = self.held_worker()
        try:
            first = halt.halt(self.slug, self.nid, timeout=0.3)
            second = halt.halt(self.slug, self.nid, timeout=0.3)
            self.assertEqual(first["operation"]["operation_id"],
                             second["operation"]["operation_id"],
                             "a repeat halt started a second operation")
            self.assertEqual(second["operation"]["state"], "settling")
            live = halt.operation(self.slug, self.nid)
            self.assertEqual(live["operation_id"],
                             first["operation"]["operation_id"])
            self.assertTrue(live["blocking"])
        finally:
            release.set()
            thread.join(10)
        self.assertTrue(self.await_phase("halted", 20))

    def test_interrupt_reports_a_dead_lane_instead_of_raising(self):
        class DeadLane:
            def interrupt(self):
                raise OSError(22, "Invalid argument")

        # the negative control, first: the stub really does raise, so the
        # assertion below is about the guard and not about a tame stub
        with self.assertRaises(OSError):
            DeadLane().interrupt()

        self.st["responding"] = True
        self.st["codex_turn"] = DeadLane()
        try:
            result = sup.interrupt_turn(self.slug, self.nid)
        finally:
            self.st.pop("codex_turn", None)
            self.st.pop("responding", None)
        self.assertFalse(result["interrupted"])
        self.assertIn("Invalid argument", result["reason"])
        self.assertIn("codex", result["reason"])

    def test_an_archive_is_not_cancelled_by_an_interrupt_that_raises(self):
        """retire/dissolve/rescind all reach `interrupt_before_archive`. On
        2026-09-20 an already-killed app-server turned both verbs into a bare
        `[Errno 22] Invalid argument` and the seats could not be freed."""
        org = self.org()
        boom = OSError(22, "Invalid argument")
        with patch.object(sup, "interrupt_turn", side_effect=boom):
            warnings = sup.interrupt_before_archive(
                self.slug, org, self.nid, timeout=0.2)
        self.assertTrue(any("could not be sent an interrupt" in w
                            for w in warnings), warnings)
        self.assertTrue(any("Invalid argument" in w for w in warnings),
                        warnings)
        # the negative control: unguarded, that same call raises
        with patch.object(sup, "interrupt_turn", side_effect=boom):
            with self.assertRaises(OSError):
                sup.interrupt_turn(self.slug, self.nid)

    def test_a_busy_turn_is_reaped_even_when_the_interrupt_is_refused(self):
        """The stuck agents' exact shape: the provider process is already
        gone, so the interrupt is REFUSED — but the turn is still busy and
        still holds cleanup. It used to be skipped by the reap entirely."""
        proc = self.spawn()
        self.st["proc"] = proc
        self.st["busy"] = True
        reaped: list[str] = []
        org = self.org()
        try:
            with patch.object(sup, "interrupt_turn",
                              return_value={"interrupted": False,
                                            "reason": "the turn was already over"}), \
                 patch.object(halt, "cut_for_archive",
                              side_effect=lambda s, n: reaped.append(n)):
                warnings = sup.interrupt_before_archive(
                    self.slug, org, self.nid, timeout=0.2)
        finally:
            self.st["busy"] = False
        self.assertIn(self.nid, reaped,
                      "a busy turn whose interrupt was refused was not reaped")
        self.assertTrue(warnings)


class CodexProcessDeathEndsTheTurn(HaltBase):
    """R1 and R3, against a REAL `AppServerClient` over a synthetic child."""

    def client(self) -> codexrun.AppServerClient:
        c = codexrun.AppServerClient([sys.executable, "-c", BLOCKER],
                                     cwd=str(Path(_root.name)))
        self.procs.append(c.proc)
        self.addCleanup(c.close)
        return c

    def turn(self, client) -> codexrun.CodexTurn:
        t = codexrun.CodexTurn([sys.executable], cwd=str(Path(_root.name)),
                               model=None, effort=None, thread_id="th-1",
                               client=client)
        # a turn the server has acknowledged: this is what `interrupt()` and
        # `wait()` both require before they will do anything at all
        t.turn_id = "tu-1"
        return t

    @staticmethod
    def kill(proc) -> None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, timeout=15,
                           creationflags=subprocess.CREATE_NO_WINDOW)  # type: ignore[attr-defined]
        else:
            proc.kill()
        proc.wait(timeout=10)

    def test_an_externally_killed_app_server_ends_the_turns_wait(self):
        """Covers the coordinator's 2026-09-20 measurement directly: they
        killed the app-server tree by hand, confirmed every pid gone, and the
        nodes stayed mid-turn. Nothing was listening for the death."""
        client = self.client()
        turn = self.turn(client)
        self.kill(client.proc)
        self.assertTrue(turn._done.wait(10),
                        "the turn is still waiting for a server that is gone")
        self.assertEqual(turn.status, codexrun.STATUS_INTERRUPTED)
        self.assertTrue(turn.server_gone)
        self.assertTrue(client.exited())

    def test_negative_control_unwired_the_turn_waits_for_a_dead_server(self):
        """THE PRE-FIX SHAPE: `on_exit` declared, never assigned. With this
        turn's listener removed the process death reaches nobody, which is
        the four-hour `TURN_TIMEOUT` park the live agents were sitting in."""
        client = self.client()
        turn = self.turn(client)
        with client._lock:
            client._exit_listeners.clear()
        self.kill(client.proc)
        self.assertFalse(turn._done.wait(2),
                         "the negative control was not actually unwired")
        self.assertIsNone(turn.status)

    def test_a_turn_binding_an_already_dead_client_still_ends(self):
        """The late-registration arm. A turn can be constructed against a
        pooled client a halt has ALREADY killed; a listener that only fired
        on a future transition would never fire at all."""
        client = self.client()
        self.kill(client.proc)
        deadline = time.monotonic() + 10
        while not client.exited() and time.monotonic() < deadline:
            time.sleep(0.05)
        turn = self.turn(client)
        self.assertTrue(turn._done.wait(5))
        self.assertTrue(turn.server_gone)

    def test_writing_to_a_dead_app_server_is_typed_not_a_bare_oserror(self):
        client = self.client()
        self.kill(client.proc)
        with self.assertRaises(codexrun.CodexServerGone) as caught:
            client.notify("turn/interrupt", {"threadId": "th-1"})
        # CodexServerGone is a CodexServerError, which is what every caller
        # on the request path already guards
        self.assertIsInstance(caught.exception, codexrun.CodexServerError)
        # THE NEGATIVE CONTROL, and it is a measurement: the raw pipe still
        # raises, and on Windows it raises errno 22 — the exact bare
        # `[Errno 22] Invalid argument` retire and dissolve returned. The fix
        # is the typing, not the pipe having healed.
        with self.assertRaises((OSError, ValueError)) as raw:
            client.proc.stdin.write(b"{}\n")
            client.proc.stdin.flush()
        if os.name == "nt" and isinstance(raw.exception, OSError):
            self.assertEqual(raw.exception.errno, 22)
            self.assertIn("Invalid argument", str(raw.exception))

    def test_interrupting_a_dead_app_server_returns_false_and_never_raises(self):
        client = self.client()
        turn = self.turn(client)
        self.kill(client.proc)
        self.assertFalse(turn.interrupt())

    def test_interrupt_turn_over_a_real_dead_server_is_a_result(self):
        """The whole chain end to end on real handles: a killed app-server,
        a live `CodexTurn` bound to it, and the verb retire/dissolve/⏸ all
        call. It must answer, not raise."""
        client = self.client()
        turn = self.turn(client)
        self.kill(client.proc)
        self.st["responding"] = True
        self.st["codex_turn"] = turn
        try:
            result = sup.interrupt_turn(self.slug, self.nid)
        finally:
            self.st.pop("codex_turn", None)
            self.st.pop("responding", None)
        self.assertFalse(result["interrupted"])
        self.assertTrue(result["reason"])


if __name__ == "__main__":
    unittest.main()
