import unittest

from engine.winservice import scm
from engine.winservice.bridge_monitor import BridgeMonitor
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
