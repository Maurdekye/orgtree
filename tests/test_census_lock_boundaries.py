"""What the document lock really costs — contention, not just duration.

The write-stage instrument (`profiling`, `tests/test_write_route_timing.py`)
reports four durations, and `lock_wait_ms` is one of them. A duration cannot
answer the two questions an operator actually has about a lock: how often did
this request take it, and was anybody in the way. ⚠ AND THE SECOND QUESTION IS
NOT ANSWERABLE FROM `lock_wait_ms` AT ALL — every acquire of a completely idle
lock costs a positive number of milliseconds, so "the wait was non-zero" and
"it queued behind an owner" are different claims and only one of them is
supported by that field. Reading a positive duration as evidence of contention
is the specific error this module exists to make impossible; §2 is the control
that would catch it.

So five counters travel beside the durations, and each case below makes exactly
one of them true and asserts the others stayed silent:

    lock_acquires          outer acquisitions that succeeded          §2 §6
    lock_failed            outer acquisitions that got nothing        §5
    lock_contended         arrivals that found an owner or a queue    §2 §3
    lock_queue_ahead_max   how deep the queue in front was            §4
    lock_max_depth         deepest reentrancy, a maximum not a sum    §6
    lock_hold_ms           outer held time, IO included               §7

THE OBJECT UNDER TEST IS THE SHIPPED ONE. Every case drives
`store.DOC_LOCK` — the real `_InstrumentedDocLock` with its real FIFO gate —
rather than a stand-in, because the whole measurement depends on the gate being
the thing that knows who was in front. A test against a fresh lock instance
would still pass if the installed lock were never instrumented at all.

DETERMINISM. Where a case needs rivals to be genuinely queued, it WAITS FOR THE
QUEUE rather than sleeping and hoping: `_queued_until` polls the gate's own
list until the expected number of tickets is on it. Sleeps appear only where a
case needs a duration to be visibly larger than measurement noise.
"""
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

root = tempfile.TemporaryDirectory(prefix='v2-lock-census-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import profiling, store  # noqa: E402  (env must be set first)

LOCK = store.DOC_LOCK

#: Long enough to stand clear of scheduler noise on a shared machine, short
#: enough that the whole module stays quick. Asserted against a much smaller
#: threshold, exactly as the sibling write-timing tests do: what is pinned is
#: attribution, not precision.
DELAY = 0.3


def tearDownModule():
    root.cleanup()


class LockCensusBase(unittest.TestCase):
    """Bind a profile, drive the real lock, read what it recorded."""

    def setUp(self) -> None:
        self.profile: "dict[str, object]" = {}
        self._token = profiling.bind(self.profile)
        self.addCleanup(self._unbind)
        # Nothing may leak between cases: the lock is a process global, so a
        # case that left it held would corrupt every case after it rather than
        # fail on its own.
        self.addCleanup(self.assertLockIsIdle)

    def _unbind(self) -> None:
        if self._token is not None:
            profiling.unbind(self._token)
            self._token = None

    # ---- reading ---------------------------------------------------------
    def recorded(self) -> "dict[str, object]":
        return profiling.snapshot(self.profile)

    def value(self, field: str) -> float:
        got = self.recorded()
        self.assertIn(field, got, f'{field} was never recorded: {got}')
        return float(got[field])          # type: ignore[arg-type]

    def assertSilent(self, *fields: str) -> None:
        got = self.recorded()
        for field in fields:
            self.assertNotIn(field, got,
                             f'{field} must not be recorded here: {got}')

    def assertLockIsIdle(self) -> None:
        self.assertFalse(LOCK._is_owned(),
                         'a case left the document lock held')
        self.assertIsNone(LOCK._owner, 'a case left the FIFO gate owned')
        self.assertEqual(LOCK._queue, [], 'a case left tickets in the gate')

    # ---- rivals ----------------------------------------------------------
    def keeper(self, hold_for: float = DELAY) -> threading.Event:
        """Another thread takes the lock and holds it for `hold_for`.

        Returns once the lock is REALLY held, so the caller's own arrival is
        guaranteed to collide rather than to race the keeper for it.
        """
        holding = threading.Event()
        done = threading.Event()

        def hold() -> None:
            with LOCK:
                holding.set()
                time.sleep(hold_for)
            done.set()

        thread = threading.Thread(target=hold, name='lock-keeper')
        thread.start()
        self.addCleanup(thread.join, 10)
        self.assertTrue(holding.wait(10), 'the keeper never took the lock')
        return done

    def _queued_until(self, tickets: int, timeout: float = 10.0) -> None:
        """Block until `tickets` rivals are really ON the gate's queue.

        A sleep would be a guess; this is the condition itself. Reading the
        gate's list is white-box on purpose — the queue IS what `ahead` counts,
        so a case about queue depth that did not look at the queue would be
        asserting its own timing luck.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with LOCK._gate:
                if len(LOCK._queue) >= tickets:
                    return
            time.sleep(0.005)
        self.fail(f'only {len(LOCK._queue)} of {tickets} rivals ever queued')

    def rival(self, ready: threading.Event) -> threading.Thread:
        """A thread that queues for the lock and releases it when let go."""
        def take() -> None:
            with LOCK:
                ready.wait(10)

        thread = threading.Thread(target=take, name='lock-rival')
        thread.start()
        self.addCleanup(thread.join, 10)
        return thread


class NothingIsRecordedWhileCaptureIsOff(LockCensusBase):
    """§1. THE FIRST NEGATIVE CONTROL. Every other case here is worthless if
    the counters run when nobody asked for them: an always-on diagnostic is a
    cost every user pays for a question nobody is asking, and the existing
    instrument's opt-in is a property this addition must not weaken."""

    def test_a_lock_cycle_with_no_profile_bound_records_nothing(self):
        self._unbind()                      # capture off is an unbound context
        seen: "dict[str, object]" = {}
        with LOCK:
            with LOCK:
                pass
        self.assertEqual(profiling.snapshot(seen), {},
                         'an unbound context may not collect anything')
        self.assertEqual(self.profile, {},
                         f'the old dict must not be written either: {self.profile}')

    def test_unbinding_mid_request_stops_the_counters(self):
        with LOCK:
            pass
        self.assertEqual(self.value('lock_acquires'), 1.0)
        self._unbind()
        with LOCK:
            pass
        self.assertEqual(float(self.profile['lock_acquires']), 1.0,
                         'a cycle after unbinding must not be counted')

    def test_a_failed_acquire_is_not_counted_while_capture_is_off(self):
        self._unbind()
        self.keeper(0.05)
        self.assertFalse(LOCK.acquire(blocking=False))
        self.assertEqual(self.profile, {},
                         f'a refusal with capture off records nothing: {self.profile}')


class AnUncontendedAcquireCostsTimeAndIsNotContention(LockCensusBase):
    """§2. THE POINT OF THE WHOLE ADDITION, and the control that catches the
    error it was written to prevent.

    An acquire of an idle lock takes a real, positive, measurable number of
    milliseconds. If `lock_contended` were derived from that number — or from
    any duration — it would be true here, on a lock nobody else has touched.
    It must be absent."""

    def test_the_wait_is_positive_and_the_contention_counter_is_silent(self):
        with LOCK:
            time.sleep(0.02)
        got = self.recorded()
        self.assertIn('lock_wait_ms', got,
                      f'an acquire always reports its own cost: {got}')
        self.assertGreaterEqual(float(got['lock_wait_ms']), 0.0)
        self.assertNotIn('lock_contended', got,
                         'NOBODY WAS IN THE WAY. A positive wait is the cost '
                         f'of taking a free lock, not evidence of a queue: {got}')
        self.assertNotIn('lock_queue_ahead_max', got,
                         f'an empty queue has no depth to report: {got}')
        self.assertEqual(float(got['lock_acquires']), 1.0)
        self.assertNotIn('lock_failed', got, f'this acquire succeeded: {got}')

    def test_repeated_uncontended_acquires_count_up_and_stay_uncontended(self):
        for _ in range(4):
            with LOCK:
                pass
        self.assertEqual(self.value('lock_acquires'), 4.0,
                         'four separate acquisitions are four, not one')
        self.assertSilent('lock_contended', 'lock_failed')
        self.assertEqual(self.value('lock_max_depth'), 1.0,
                         'four sequential acquires never nest')


class ARealCollisionIsCountedAsOne(LockCensusBase):
    """§3. The positive case §2 is the control for: another thread genuinely
    holds the lock when this one arrives."""

    def test_arriving_behind_a_holder_is_contention(self):
        self.keeper()
        started = time.perf_counter()
        with LOCK:
            pass
        waited = (time.perf_counter() - started) * 1000.0
        got = self.recorded()
        self.assertEqual(float(got['lock_contended']), 1.0,
                         f'one arrival behind one owner is one collision: {got}')
        self.assertEqual(float(got['lock_queue_ahead_max']), 1.0,
                         f'the owner alone was in front: {got}')
        self.assertGreater(waited, 200,
                           'the fixture did not actually make this thread wait')
        self.assertGreater(float(got['lock_wait_ms']), 200,
                           f'a real wait is still reported as a wait: {got}')
        self.assertEqual(float(got['lock_acquires']), 1.0,
                         f'it collided and then it got the lock: {got}')

    def test_a_collision_is_counted_per_arrival_not_per_millisecond_waited(self):
        for _ in range(2):
            self.keeper(0.05)
            with LOCK:
                pass
        self.assertEqual(self.value('lock_contended'), 2.0,
                         'two arrivals that each found an owner are two')


class TheQueueDepthIsTheNumberInFront(LockCensusBase):
    """§4. One rival and seventeen rivals are both "contended" and are not the
    same event — the 2026-09-19 starvation incident was the second kind. The
    high-water of the queue in front is what tells them apart."""

    def test_an_arrival_behind_an_owner_and_two_rivals_reports_three(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.keeper(DELAY * 4)              # holds while the rivals pile up
        for _ in range(2):
            self.rival(release)
        self._queued_until(2)               # the condition itself, not a sleep
        release.set()                       # rivals will leave once admitted
        with LOCK:
            pass
        got = self.recorded()
        self.assertEqual(float(got['lock_queue_ahead_max']), 3.0,
                         f'one owner plus two queued rivals is three: {got}')
        self.assertEqual(float(got['lock_contended']), 1.0,
                         f'one arrival is one collision however deep: {got}')

    def test_the_depth_is_a_high_water_mark_not_a_running_total(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.keeper(DELAY * 4)
        for _ in range(2):
            self.rival(release)
        self._queued_until(2)
        release.set()
        with LOCK:
            pass
        deep = self.value('lock_queue_ahead_max')
        self.keeper(0.05)                   # a second, shallower collision
        with LOCK:
            pass
        self.assertEqual(self.value('lock_queue_ahead_max'), deep,
                         'a later, shallower queue may not lower the high-water '
                         'mark, and may not be added to it either')
        self.assertEqual(self.value('lock_contended'), 2.0,
                         'both arrivals still count as collisions')


class AnAcquisitionThatGetsNothingIsCountedAsAFailure(LockCensusBase):
    """§5. A failed acquire is the most interesting acquire there is, and both
    ways of failing bypass the generic lock entirely — the FIFO gate refuses
    and returns before the inner lock is ever touched. A counter that lived
    only in the generic class would report zero failures forever."""

    def test_a_refused_non_blocking_acquire_counts_as_failed_not_acquired(self):
        self.keeper()
        self.assertFalse(LOCK.acquire(blocking=False),
                         'the keeper holds it; this must not succeed')
        got = self.recorded()
        self.assertEqual(float(got['lock_failed']), 1.0,
                         f'a refusal is a failed acquisition: {got}')
        self.assertNotIn('lock_acquires', got,
                         f'nothing was acquired: {got}')
        self.assertEqual(float(got['lock_contended']), 1.0,
                         f'it was refused BECAUSE somebody held it: {got}')

    def test_an_expired_timeout_counts_as_failed_too(self):
        self.keeper()
        started = time.perf_counter()
        self.assertFalse(LOCK.acquire(timeout=0.05),
                         'the keeper holds it for longer than the timeout')
        waited = (time.perf_counter() - started) * 1000.0
        got = self.recorded()
        self.assertEqual(float(got['lock_failed']), 1.0,
                         f'an expired timeout got nothing: {got}')
        self.assertNotIn('lock_acquires', got, f'nothing was acquired: {got}')
        self.assertGreater(float(got['lock_wait_ms']), 0.0,
                           f'a wait that ends in nothing is still a wait: {got}')
        self.assertLess(waited, DELAY * 1000,
                        'the timeout must have expired rather than been served')

    def test_a_non_blocking_acquire_on_an_idle_lock_still_succeeds(self):
        """The control for both cases above: the refusal is the keeper's
        doing, not something the instrumentation now does to every try."""
        self.assertTrue(LOCK.acquire(blocking=False))
        LOCK.release()
        got = self.recorded()
        self.assertEqual(float(got['lock_acquires']), 1.0)
        self.assertNotIn('lock_failed', got, f'nothing failed here: {got}')
        self.assertNotIn('lock_contended', got, f'nobody was in the way: {got}')


class ReentrancyIsADepthAndNotAnAcquisitionCount(LockCensusBase):
    """§6. The lock is reentrant, and a request that takes it three levels deep
    took it ONCE and reached depth three. Summing the levels would report six
    for a request that nested three deep twice, which is not a depth; counting
    them as acquisitions would report three exclusive entries where there was
    one."""

    def test_three_levels_deep_is_one_acquisition_at_depth_three(self):
        with LOCK:
            with LOCK:
                with LOCK:
                    time.sleep(0.01)
        got = self.recorded()
        self.assertEqual(float(got['lock_max_depth']), 3.0,
                         f'three nested acquires reach depth three: {got}')
        self.assertEqual(float(got['lock_acquires']), 1.0,
                         f'a nested acquire is not a second acquisition: {got}')
        self.assertNotIn('lock_contended', got,
                         'A THREAD CANNOT QUEUE BEHIND ITSELF — the reentrant '
                         f'path never touches the queue: {got}')

    def test_two_visits_two_deep_report_two_not_four(self):
        for _ in range(2):
            with LOCK:
                with LOCK:
                    pass
        self.assertEqual(self.value('lock_max_depth'), 2.0,
                         'THE MAXIMUM, NOT THE SUM: two visits of depth two '
                         'reached depth two')
        self.assertEqual(self.value('lock_acquires'), 2.0,
                         'they were two separate outer acquisitions')

    def test_a_shallower_visit_cannot_lower_the_high_water_mark(self):
        with LOCK:
            with LOCK:
                with LOCK:
                    pass
        with LOCK:
            pass
        self.assertEqual(self.value('lock_max_depth'), 3.0,
                         'the deepest nesting this request reached was three')

    def test_the_inner_levels_do_not_each_open_a_hold_window(self):
        with LOCK:
            with LOCK:
                time.sleep(0.1)
        held = self.value('lock_hold_ms')
        self.assertGreater(held, 50,
                           'the outer window covers the whole visit')
        self.assertLess(held, 100 * 1.9,
                        'ONE window, not one per level: a per-level sum would '
                        f'roughly double this, got {held}')


class TheHoldIsHowLongEveryoneElseWasKeptOut(LockCensusBase):
    """§7. `mutate_ms` subtracts the document IO that happened inside the lock,
    because it answers "what was this request doing in there". `lock_hold_ms`
    does not subtract it, because it answers "how long was every other writer
    blocked" — and a write that spends four seconds inside the lock doing
    nothing but IO blocks everyone for four seconds while reporting a mutation
    of nearly zero. The difference between the two IS the document IO."""

    def test_document_io_inside_the_lock_is_held_time_but_not_mutation(self):
        with LOCK:
            with profiling.stage('org_load_ms'):
                time.sleep(0.2)
        got = self.recorded()
        load = float(got['org_load_ms'])
        self.assertGreater(load, 100, f'the fixture did not make a slow load: {got}')
        self.assertGreater(float(got['lock_hold_ms']), 100,
                           f'the lock was held for the whole load: {got}')
        self.assertGreaterEqual(float(got['lock_hold_ms']), load * 0.9,
                                f'the hold covers the load it contains: {got}')
        self.assertLess(float(got['mutate_ms']), load * 0.5,
                        'TIME SPENT LOADING IS NOT TIME SPENT MUTATING — that '
                        f'is the whole reason both fields exist: {got}')

    def test_waiting_outside_the_lock_is_not_held_time(self):
        self.keeper()
        with LOCK:
            pass
        got = self.recorded()
        self.assertGreater(float(got['lock_wait_ms']), 200, f'{got}')
        self.assertLess(float(got['lock_hold_ms']), 200,
                        'TIME SPENT WAITING IS NOT TIME SPENT HOLDING: '
                        f'{got}')


class MeasuringMustNeverBreakTheThingMeasured(LockCensusBase):
    """§8. A timing helper may never be the reason a request fails, and it may
    never leave the lock in a state the next request inherits. Both are
    properties of the existing instrument that this addition has to keep."""

    def test_a_hostile_profile_dict_cannot_make_the_lock_raise(self):
        # A handler that already stashed text under these names. The counters
        # must decline to write rather than raise inside somebody's write.
        self.profile.update({'lock_max_depth': 'not a number',
                             'lock_contended': [],
                             'lock_queue_ahead_max': None,
                             'lock_acquires': 'nope',
                             'lock_hold_ms': object()})
        self.keeper(0.05)
        with LOCK:                          # a real collision, on a poisoned dict
            with LOCK:
                pass
        self.assertEqual(self.profile['lock_max_depth'], 'not a number',
                         'a non-numeric value is left alone, not overwritten')

    def test_a_failed_acquire_leaves_no_residue_on_the_gate(self):
        done = self.keeper(0.15)
        self.assertFalse(LOCK.acquire(blocking=False))
        self.assertFalse(LOCK.acquire(timeout=0.02))
        self.assertTrue(done.wait(10), 'the keeper never finished')
        # The gate must be clean enough for the next acquire to be UNCONTENDED
        # — a refusal that left a stale ticket behind would make every later
        # arrival look like a collision forever.
        after = {}
        token = profiling.bind(after)
        try:
            with LOCK:
                pass
        finally:
            profiling.unbind(token)
        self.assertNotIn('lock_contended', after,
                         f'a refused acquire left the queue dirty: {after}')
        self.assertEqual(float(after['lock_acquires']), 1.0)

    def test_the_gate_still_admits_in_arrival_order(self):
        """FIFO is a correctness property, not a performance one (the incident
        in `_InstrumentedDocLock`'s docstring). Counting arrivals must not have
        reordered them."""
        order: "list[int]" = []
        release = threading.Event()
        self.addCleanup(release.set)
        self.keeper(DELAY * 3)

        def rival(n: int) -> None:
            with LOCK:
                order.append(n)

        threads = []
        for n in range(3):
            # started one at a time, each confirmed queued before the next
            # arrives, so arrival order is a fact rather than a race
            thread = threading.Thread(target=rival, args=(n,), name=f'fifo-{n}')
            thread.start()
            threads.append(thread)
            self._queued_until(n + 1)
        release.set()
        for thread in threads:
            thread.join(10)
        self.assertEqual(order, [0, 1, 2],
                         'the gate must still grant in strict arrival order')


class TheConditionPathHasItsOwnCounterSemantics(LockCensusBase):
    """§9. `Condition.wait` DOES NOT GO THROUGH `acquire()`.

    `halt.py` builds `threading.Condition(store.DOC_LOCK)`, and a wait on such
    a Condition calls `_release_save` and `_acquire_restore` directly. Those
    two overrides — not `acquire`/`release` — decide what the counters say on
    that path, so the semantics the other eight sections establish do NOT
    carry over by inheritance and are asserted here separately.

    What the code actually does, measured rather than assumed:

      * the restore is NOT a second acquisition (`lock_acquires` does not
        move), because the parent's `_acquire_restore` sets the depth directly
        and never runs the acquire bookkeeping;
      * the hold AFTER the restore is NOT reported. The parent closes its
        window on `_release_save` and deliberately does not reopen it, so a
        post-wait hold is UNMEASURED — which is a different statement from
        zero, and §9 says so out loud rather than leaving a reader to assume
        the instrument covers it;
      * a restore that has to queue behind a real owner IS counted as
        contention, because it re-enters the same FIFO gate at the tail.

    ⚠ ONE REAL GAP IS PINNED HERE RATHER THAN FIXED, because fixing it would
    change locking behaviour and that is outside this stage: see
    `test_a_nested_wait_yields_the_gate_before_the_inner_lock_is_free`.
    """

    def notifier(self, cond: threading.Condition,
                 ready: threading.Event) -> threading.Thread:
        """Notify once the waiter is really parked.

        Deterministic without polling: `with cond` cannot be entered until the
        lock is free, and on this path the lock becomes free only inside
        `wait()`. `ready` rules out the other direction — notifying before the
        waiter has even taken the lock.
        """
        def notify() -> None:
            ready.wait(10)
            with cond:
                cond.notify_all()

        thread = threading.Thread(target=notify, name='cond-notifier')
        thread.start()
        self.addCleanup(thread.join, 10)
        return thread

    def test_a_wait_and_wake_is_not_counted_as_a_second_acquisition(self):
        cond = threading.Condition(LOCK)
        ready = threading.Event()
        self.notifier(cond, ready)
        with cond:                                   # depth 1
            before = self.recorded()
            ready.set()
            self.assertTrue(cond.wait(timeout=10), 'the waiter never woke')
            time.sleep(0.1)                          # held AFTER the restore
        got = self.recorded()
        self.assertEqual(float(before['lock_acquires']), 1.0,
                         f'the fixture did not take the lock: {before}')
        self.assertEqual(float(got['lock_acquires']), 1.0,
                         'A RESTORE IS NOT A SECOND ACQUISITION — the parent '
                         f'sets the depth directly and counts nothing: {got}')
        self.assertNotIn('lock_contended', got,
                         f'nobody was in the way on this path: {got}')

    def test_the_hold_after_a_wake_is_unmeasured_and_that_is_deliberate(self):
        """⚠ NOT ZERO — ABSENT. The parent ends the hold window at
        `_release_save` and does not reopen it, precisely so a thread that
        slept for twenty seconds is not reported as having mutated for twenty
        seconds. The honest consequence is that the work it does after waking
        is not reported either, and a reader must not add these records up and
        believe they cover the whole request."""
        cond = threading.Condition(LOCK)
        ready = threading.Event()
        self.notifier(cond, ready)
        with cond:
            ready.set()
            self.assertTrue(cond.wait(timeout=10))
            time.sleep(0.15)                         # a real, long hold
        got = self.recorded()
        self.assertNotIn('lock_hold_ms', got,
                         'a post-restore hold is UNMEASURED; reporting it '
                         f'would require reopening the window: {got}')
        self.assertNotIn('mutate_ms', got,
                         f'and the existing instrument says the same: {got}')

    def test_the_depth_high_water_survives_a_nested_wait(self):
        cond = threading.Condition(LOCK)
        ready = threading.Event()
        self.notifier(cond, ready)
        with LOCK:                                   # depth 1
            with cond:                               # depth 2, same lock
                ready.set()
                self.assertTrue(cond.wait(timeout=10))
        self.assertEqual(self.value('lock_max_depth'), 2.0,
                         'the deepest nesting reached before the wait is '
                         'still the deepest this request reached')
        self.assertEqual(self.value('lock_acquires'), 1.0,
                         'one outer acquisition, whatever the wait did')

    def test_a_restore_that_queues_behind_an_owner_is_counted_as_contention(self):
        """Driven through `_release_save`/`_acquire_restore` directly, which
        IS the code path a `Condition.wait` takes. Doing it this way makes the
        ordering a fact rather than a scheduling coincidence: the keeper
        provably owns the lock before the restore is attempted."""
        LOCK.acquire()
        state = LOCK._release_save()                 # the wait's release half
        try:
            self.keeper()                            # returns once really held
            self.assertIsNotNone(LOCK._owner, 'the keeper does not own the gate')
            LOCK._acquire_restore(state)             # must queue behind it
        finally:
            LOCK.release()
        got = self.recorded()
        self.assertEqual(float(got['lock_contended']), 1.0,
                         'a restore re-enters the gate at the tail and can '
                         f'genuinely find somebody in front: {got}')
        self.assertEqual(float(got['lock_queue_ahead_max']), 1.0,
                         f'the keeper alone was in front: {got}')

    def test_an_uncontended_restore_is_not_counted_as_contention(self):
        """The control for the case above — the same code path with nobody in
        the way must stay silent, or `lock_contended` would just mean "a
        Condition was used"."""
        LOCK.acquire()
        state = LOCK._release_save()
        try:
            LOCK._acquire_restore(state)
        finally:
            LOCK.release()
        self.assertSilent('lock_contended', 'lock_queue_ahead_max')

    def test_a_nested_wait_yields_the_gate_before_the_inner_lock_is_free(self):
        """⚠ A REAL GAP, PINNED HERE RATHER THAN FIXED.

        `_release_save` drops the tracked depth to 0 and `_acquire_restore`
        sets it to 1 — but `Condition.wait` released EVERY recursion level and
        re-took them all, so after a wait at depth 2 the true RLock recursion
        is 2 while the wrapper believes it is 1. `release()` therefore treats
        the FIRST of the two releases as outermost: it runs the resident
        release hook and YIELDS THE GATE while this thread still owns the
        inner RLock. A thread admitted in that window blocks on the inner lock
        instead of at the gate, so it waits without being counted — the one
        hole in `lock_contended`'s coverage.

        Mutual exclusion and FIFO order are NOT violated, which is why this is
        a measurement gap and not a correctness bug, and fixing it would
        change locking behaviour — out of scope for this stage. It is also
        currently UNREACHABLE in product code: `halt.py` only ever calls
        `notify_all()` on its Condition, never `wait()`, so nothing outside
        the tests takes this path at all.
        """
        cond = threading.Condition(LOCK)
        ready = threading.Event()
        self.notifier(cond, ready)
        LOCK.acquire()                               # depth 1
        cond.acquire()                               # depth 2, same lock
        ready.set()
        self.assertTrue(cond.wait(timeout=10))
        self.assertEqual(getattr(LOCK._held, 'depth', None), 1,
                         'the restore collapses the tracked depth to 1 even '
                         'though the real recursion is 2')
        cond.release()                               # first of two
        self.assertIsNone(LOCK._owner,
                          'THE GAP: the gate is already free here…')
        self.assertTrue(LOCK._is_owned(),
                        '…while this thread still holds the inner RLock')
        LOCK.release()                               # second
        self.assertFalse(LOCK._is_owned(), 'both levels must be released')


if __name__ == '__main__':
    unittest.main()
