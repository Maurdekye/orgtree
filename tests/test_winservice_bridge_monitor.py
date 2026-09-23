import unittest

from engine.winservice import scm
from engine.winservice.bridge_monitor import (BridgeMonitor, WtsSessionInfo,
                                              signed_in_sessions)
from engine.winservice.bridge_state import BridgeState


class FakeSource:
    def __init__(self):
        self.sessions = []
        self.owners = {}
        self.closed = []

    def active_sessions(self):
        return self.sessions

    def query_verified(self, session_id, sid):
        if self.owners.get(session_id) != sid:
            raise PermissionError("foreign logon")
        return session_id + 100

    def close(self, token):
        self.closed.append(token)


class MonitorTests(unittest.TestCase):
    def test_disconnected_real_logon_remains_eligible_until_logoff(self):
        rows = [WtsSessionInfo(7, None, 4), WtsSessionInfo(8, None, 0),
                WtsSessionInfo(9, None, 6), WtsSessionInfo(0, None, 0)]
        self.assertEqual(signed_in_sessions(rows), [8, 7])
        context = scm.ServiceContext(scm.StatusReporter(lambda _status: None))
        state = BridgeState[int]()
        source = FakeSource()
        source.sessions = [7]
        source.owners = {7: "operator"}
        monitor = BridgeMonitor("operator", context, state, source)
        monitor.reconcile()
        self.assertEqual(state.status()["sessionId"], 7)
        self.assertEqual(state.begin_turn("from-disconnected"), 107)
        source.sessions = [8, 7]  # another attached session sorts first
        source.owners[8] = "foreign"
        monitor.reconcile()
        self.assertEqual(state.status()["sessionId"], 7)
        self.assertEqual(source.closed, [])  # old turn still owns its token
        state.finish_turn("from-disconnected")
        self.assertEqual(source.closed, [])  # stable session retains its token
        source.sessions = [7]
        monitor.reconcile()
        context.on_session_logoff(7)
        self.assertIsNone(state.begin_turn("after-logoff"))

    def test_logoff_during_token_query_never_reopens_admission(self):
        context = scm.ServiceContext(scm.StatusReporter(lambda _status: None))
        state = BridgeState[int]()
        source = FakeSource()
        source.sessions = [7]
        source.owners = {7: "operator"}
        original_query = source.query_verified

        def query_then_logoff(session_id, sid):
            token = original_query(session_id, sid)
            context.on_session_logoff(session_id)
            return token

        source.query_verified = query_then_logoff
        monitor = BridgeMonitor("operator", context, state, source)
        monitor.reconcile()
        self.assertIsNone(state.begin_turn("after-race"))
        self.assertEqual(source.closed, [107])

    def test_foreign_session_cannot_activate_bridge_and_logoff_is_immediate(self):
        context = scm.ServiceContext(scm.StatusReporter(lambda _status: None))
        state = BridgeState[int]()
        source = FakeSource()
        monitor = BridgeMonitor("operator", context, state, source)
        source.sessions = [1, 2]
        source.owners = {1: "foreign", 2: "operator"}
        monitor.reconcile()
        self.assertEqual(state.status()["sessionId"], 2)
        self.assertEqual(state.begin_turn("active"), 102)
        context.on_session_logoff(2)
        self.assertIsNone(state.begin_turn("late"))
        monitor.reconcile()
        self.assertIsNone(state.begin_turn("still-late"),
                          "a lagging WTS list must not reopen a signed-out session")
        self.assertEqual(source.closed, [])
        state.finish_turn("active")
        self.assertEqual(source.closed, [102])


if __name__ == "__main__":
    unittest.main()
