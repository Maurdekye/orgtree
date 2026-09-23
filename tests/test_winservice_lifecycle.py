"""Service supervision: restart ladder, crash budget, restart control, stop.

Drives ``lifecycle.supervise`` with fake hosts and a fake clock. The rule every
test also checks: a new host is never spawned while the previous host's job
still holds processes (single engine).
"""

import queue
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.winservice import EXIT_CRASH_BUDGET, EXIT_SPAWN, lifecycle, scm


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class FakeHost:
    """Exits with `code` after `runs_for` seconds, or on request_stop."""

    def __init__(self, world, pid, code=None, runs_for=0.0, obeys_stop=True, empties=True):
        self.world, self.pid, self.code, self.runs_for = world, pid, code, runs_for
        self.obeys_stop, self.empties = obeys_stop, empties
        self.started = world.clock()
        self.exited = None
        self.alive_in_job = True
        self.stop_requested = self.terminated = self.closed = False

    def wait(self, timeout):
        self.world.clock.now += timeout
        if self.exited is None and self.code is not None and self.world.clock() - self.started >= self.runs_for:
            self.exited = self.code
        return self.exited

    def request_stop(self):
        self.stop_requested = True
        if self.obeys_stop:
            self.exited = 0

    def terminate(self, code):
        self.terminated = True
        if self.exited is None:
            self.exited = code
        if self.empties:
            self.alive_in_job = False

    def wait_empty(self, timeout):
        self.world.clock.now += 0.01
        return not self.alive_in_job

    def close(self):
        self.closed = True


class World:
    def __init__(self, plans, controls_at=()):
        self.clock = Clock()
        self.plans = list(plans)
        self.hosts = []
        self.spawn_times = []
        self.statuses = []
        self.log = []
        self.context = scm.ServiceContext(scm.StatusReporter(lambda s: self.statuses.append(s.dwCurrentState)))
        # (at_spawn_index, control): queued when that host is spawned.
        self.controls_at = dict(controls_at)

    def spawn(self):
        for host in self.hosts:
            assert not host.alive_in_job, "a new host was spawned while an old tree was alive"
        if not self.plans:
            raise AssertionError("more spawns than planned")
        plan = self.plans.pop(0)
        if isinstance(plan, Exception):
            raise plan
        host = FakeHost(self, len(self.hosts) + 100, **plan)
        self.hosts.append(host)
        self.spawn_times.append(self.clock())
        control = self.controls_at.get(len(self.hosts) - 1)
        if control:
            self.context.controls.put(control)
        return host

    def run(self, policy=lifecycle.Policy()):
        return lifecycle.supervise(self.context, self.spawn, policy, clock=self.clock, log=self.log.append)


class DelayQueue(queue.Queue):
    """Advances the fake clock by the requested wait instead of sleeping."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def get(self, block=True, timeout=None):
        if timeout:
            try:
                return super().get_nowait()
            except queue.Empty:
                self.clock.now += timeout
                raise
        return super().get(block, timeout)


def world(plans, controls_at=()):
    w = World(plans, controls_at)
    w.context.controls = DelayQueue(w.clock)
    return w


class SupervisionTests(unittest.TestCase):
    def test_orderly_stop_reports_pending_and_returns_zero(self):
        w = world([dict()], controls_at={0: scm.STOP})
        self.assertEqual(w.run(), 0)
        host = w.hosts[0]
        self.assertTrue(host.stop_requested and host.terminated and host.closed)
        self.assertEqual(w.statuses[0], scm.SERVICE_RUNNING)
        self.assertIn(scm.SERVICE_STOP_PENDING, w.statuses)

    def test_host_ignoring_stop_is_killed_after_the_grace(self):
        policy = lifecycle.Policy(stop_grace=5.0)
        w = world([dict(obeys_stop=False)], controls_at={0: scm.STOP})
        self.assertEqual(w.run(policy), 0)
        host = w.hosts[0]
        self.assertTrue(host.terminated)
        self.assertGreaterEqual(w.clock() - w.spawn_times[0], 5.0)
        pending = [s for s in w.statuses if s == scm.SERVICE_STOP_PENDING]
        self.assertGreater(len(pending), 2, "a long stop must keep advancing the checkpoint")

    def test_crashes_climb_the_backoff_ladder_then_exhaust_the_budget(self):
        w = world([dict(code=1)] * 5)
        self.assertEqual(w.run(), EXIT_CRASH_BUDGET)
        gaps = [round(b - a) for a, b in zip(w.spawn_times, w.spawn_times[1:])]
        self.assertEqual(gaps, [1, 5, 30, 30])
        self.assertTrue(all(h.terminated and h.closed for h in w.hosts),
                        "every crashed host's tree is killed and confirmed before the next")

    def test_old_failures_leave_the_window(self):
        # Crashes spaced beyond the window never add up to the budget.
        policy = lifecycle.Policy(budget=2, window=10.0, backoff=(20.0,))
        w = world([dict(code=1)] * 3 + [dict()], controls_at={3: scm.STOP})
        self.assertEqual(w.run(policy), 0)
        self.assertEqual(len(w.hosts), 4)

    def test_root_owned_and_clean_exits_never_spend_the_budget(self):
        policy = lifecycle.Policy(budget=1)
        plans = [dict(code=lifecycle.EXIT_ROOT_OWNED)] * 3 + [dict(code=0)] * 2 + [dict()]
        w = world(plans, controls_at={5: scm.STOP})
        self.assertEqual(w.run(policy), 0)
        self.assertEqual(len(w.hosts), 6)

    def test_a_healthy_run_resets_the_ladder(self):
        w = world([dict(code=1), dict(code=1, runs_for=120.0), dict(code=1), dict()],
                  controls_at={3: scm.STOP})
        self.assertEqual(w.run(), 0)
        gaps = [round(b - a) for a, b in zip(w.spawn_times, w.spawn_times[1:])]
        # 120s run + a 1s delay (not 5s): the healthy run reset the ladder,
        # and the next quick crash climbs it again.
        self.assertEqual(gaps, [1, 121, 5])

    def test_restart_control_replaces_the_host_without_delay_or_failure(self):
        policy = lifecycle.Policy(budget=1)
        w = world([dict(), dict()], controls_at={0: scm.RESTART, 1: scm.STOP})
        self.assertEqual(w.run(policy), 0)
        first, second = w.hosts
        self.assertTrue(first.stop_requested and first.terminated and first.closed)
        self.assertLess(w.spawn_times[1] - w.spawn_times[0], 1.0)
        self.assertEqual(w.statuses.count(scm.SERVICE_RUNNING), 1, "a restart is not a new service start")

    def test_stop_during_a_restart_delay_is_immediate(self):
        w = world([dict(code=1)])
        # STOP arrives during the 1s restart delay.
        original = w.context.controls.get
        def get(block=True, timeout=None):
            if timeout:
                return scm.STOP
            return original(block, timeout)
        w.context.controls.get = get
        self.assertEqual(w.run(), 0)
        self.assertEqual(len(w.hosts), 1)

    def test_spawn_failure_is_a_service_specific_error(self):
        w = world([OSError(5, "denied")])
        self.assertEqual(w.run(), EXIT_SPAWN)
        self.assertNotIn(scm.SERVICE_RUNNING, w.statuses)

    def test_a_tree_that_will_not_empty_stops_the_service_instead_of_doubling(self):
        w = world([dict(code=1, empties=False), dict()])
        self.assertEqual(w.run(), EXIT_SPAWN)
        self.assertEqual(len(w.hosts), 1, "no second host while the first tree is alive")


if __name__ == "__main__":
    unittest.main()
