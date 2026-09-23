"""SCM protocol: status/checkpoint rules and control dispatch, with a fake SCM.

No service is installed or started: ``scm.run`` takes an adapter, and the fake
here calls ServiceMain synchronously the way StartServiceCtrlDispatcher would
on its own thread.
"""

import ctypes
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.winservice import CONTROL_RESTART_ENGINE, scm


class FakeScm:
    def __init__(self, controls_during_body=()):
        self.statuses = []
        self.registered = []
        self.controls_during_body = controls_during_body
        self.handler_results = []
        self.HandlerEx = lambda function: function
        self.ServiceMain = lambda function: function

    def dispatch(self, name, service_main):
        self.dispatched = name
        service_main(0, None)

    def register(self, name, handler):
        self.registered.append((name, handler))
        return "handle"

    def set_status(self, handle, status):
        assert handle == "handle"
        self.statuses.append((status.dwCurrentState, status.dwControlsAccepted, status.dwWin32ExitCode,
                              status.dwServiceSpecificExitCode, status.dwCheckPoint, status.dwWaitHint))

    def send(self, control):
        handler = self.registered[-1][1]
        self.handler_results.append(handler(control, 0, None, None))


class StatusReporterTests(unittest.TestCase):
    def test_service_status_matches_the_win32_layout(self):
        self.assertEqual(ctypes.sizeof(scm.ServiceStatus), 28)

    def test_pending_states_advance_the_checkpoint_and_others_reset_it(self):
        seen = []
        reporter = scm.StatusReporter(seen.append)
        reporter.start_pending(3000)
        reporter.start_pending(3000)
        reporter.running()
        reporter.stop_pending(5000)
        reporter.stop_pending(5000)
        reporter.stopped()
        self.assertEqual([(s.dwCurrentState, s.dwCheckPoint, s.dwWaitHint) for s in seen],
                         [(scm.SERVICE_START_PENDING, 1, 3000), (scm.SERVICE_START_PENDING, 2, 3000),
                          (scm.SERVICE_RUNNING, 0, 0),
                          (scm.SERVICE_STOP_PENDING, 1, 5000), (scm.SERVICE_STOP_PENDING, 2, 5000),
                          (scm.SERVICE_STOPPED, 0, 0)])

    def test_only_running_accepts_controls_and_never_plain_shutdown(self):
        seen = []
        reporter = scm.StatusReporter(seen.append)
        reporter.start_pending()
        reporter.running()
        reporter.stop_pending()
        self.assertEqual([s.dwControlsAccepted for s in seen],
                         [0, scm.SERVICE_ACCEPT_STOP | scm.SERVICE_ACCEPT_PRESHUTDOWN, 0])

    def test_nonzero_exit_is_a_service_specific_error(self):
        seen = []
        reporter = scm.StatusReporter(seen.append)
        reporter.stopped(3)
        reporter.stopped(0)
        self.assertEqual([(s.dwWin32ExitCode, s.dwServiceSpecificExitCode) for s in seen],
                         [(scm.ERROR_SERVICE_SPECIFIC_ERROR, 3), (scm.NO_ERROR, 0)])


class ControlTests(unittest.TestCase):
    def test_stop_and_preshutdown_queue_stop_restart_queues_restart(self):
        context = scm.ServiceContext(scm.StatusReporter(lambda _s: None))
        results = [scm.handle_control(context, control, CONTROL_RESTART_ENGINE)
                   for control in (scm.SERVICE_CONTROL_STOP, scm.SERVICE_CONTROL_PRESHUTDOWN,
                                   CONTROL_RESTART_ENGINE, scm.SERVICE_CONTROL_INTERROGATE, 0x3, 200)]
        self.assertEqual(results, [scm.NO_ERROR] * 4 + [scm.ERROR_CALL_NOT_IMPLEMENTED] * 2)
        queued = []
        while not context.controls.empty():
            queued.append(context.controls.get_nowait())
        self.assertEqual(queued, [scm.STOP, scm.STOP, scm.RESTART],
                         "interrogate and unknown controls must not queue anything")


class RunTests(unittest.TestCase):
    def test_run_reports_start_pending_then_stopped_with_the_body_code(self):
        fake = FakeScm()
        def body(context):
            context.status.running()
            fake.send(scm.SERVICE_CONTROL_STOP)
            self.assertEqual(context.controls.get_nowait(), scm.STOP)
            return 0
        scm.run("OrgtreeEngine", body, restart_control=CONTROL_RESTART_ENGINE, api=fake)
        self.assertEqual(fake.dispatched, "OrgtreeEngine")
        self.assertEqual([s[0] for s in fake.statuses],
                         [scm.SERVICE_START_PENDING, scm.SERVICE_RUNNING, scm.SERVICE_STOPPED])
        self.assertEqual(fake.statuses[-1][2:4], (scm.NO_ERROR, 0))
        self.assertEqual(fake.handler_results, [scm.NO_ERROR])

    def test_body_error_code_is_reported(self):
        fake = FakeScm()
        scm.run("OrgtreeEngine", lambda _context: 3, restart_control=CONTROL_RESTART_ENGINE, api=fake)
        self.assertEqual(fake.statuses[-1][:4],
                         (scm.SERVICE_STOPPED, 0, scm.ERROR_SERVICE_SPECIFIC_ERROR, 3))

    def test_a_crashing_body_still_reports_stopped(self):
        fake = FakeScm()
        def body(_context):
            raise ValueError("boom")
        with self.assertRaises(ValueError):
            scm.run("OrgtreeEngine", body, restart_control=CONTROL_RESTART_ENGINE, api=fake)
        self.assertEqual(fake.statuses[-1][:4],
                         (scm.SERVICE_STOPPED, 0, scm.ERROR_SERVICE_SPECIFIC_ERROR, 0xFFFF))

    def test_a_control_before_the_body_runs_is_not_lost(self):
        fake = FakeScm()
        original = fake.register
        def register(name, handler):
            handle = original(name, handler)
            handler(scm.SERVICE_CONTROL_STOP, 0, None, None)  # arrives immediately
            return handle
        fake.register = register
        got = []
        scm.run("OrgtreeEngine", lambda context: got.append(context.controls.get_nowait()) or 0,
                restart_control=CONTROL_RESTART_ENGINE, api=fake)
        self.assertEqual(got, [scm.STOP])

    def test_outside_the_scm_the_real_dispatcher_refuses(self):
        # Negative control against the REAL advapi32 binding: a process the
        # SCM did not start cannot connect (ERROR_FAILED_SERVICE_CONTROLLER_CONNECT).
        import os
        if os.name != "nt":
            raise unittest.SkipTest("Windows-only")
        with self.assertRaises(OSError) as caught:
            scm.run("OrgtreeEngineTestNeverInstalled", lambda _context: 0,
                    restart_control=CONTROL_RESTART_ENGINE)
        self.assertEqual(caught.exception.winerror, scm.ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)


if __name__ == "__main__":
    unittest.main()
