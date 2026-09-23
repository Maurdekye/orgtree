"""No host service or account is touched by these bridge lifetime tests."""

import threading
import unittest

from engine.winservice.bridge_state import BridgeState


class BridgeStateTests(unittest.TestCase):
    def setUp(self):
        self.bridge = BridgeState[str]()
        self.closed = []

    def sign_in(self, session, token):
        self.bridge.signed_in(session, token, self.closed.append)

    def test_sign_out_closes_admission_but_running_turn_retains_token(self):
        self.sign_in(7, "real-session-7")
        self.assertEqual(self.bridge.begin_turn("a"), "real-session-7")
        resumed = []
        self.assertTrue(self.bridge.commit_turn("a", lambda: resumed.append(True)))
        self.assertEqual(resumed, [True])
        self.assertTrue(self.bridge.signed_out(7))
        self.assertIsNone(self.bridge.begin_turn("b"))
        self.assertEqual(self.closed, [])
        self.assertTrue(self.bridge.finish_turn("a"))
        self.assertEqual(self.closed, ["real-session-7"])
        self.assertFalse(self.bridge.finish_turn("a"))

    def test_candidate_created_before_logoff_cannot_resume_after_it(self):
        self.sign_in(7, "token")
        self.assertEqual(self.bridge.begin_turn("candidate"), "token")
        self.bridge.signed_out(7)
        resumed = []
        self.assertFalse(self.bridge.commit_turn("candidate", lambda: resumed.append(True)))
        self.assertEqual(resumed, [])
        self.assertEqual(self.closed, [])
        self.bridge.finish_turn("candidate")
        self.assertEqual(self.closed, ["token"])

    def test_reconnect_never_admits_against_the_retired_session(self):
        self.sign_in(7, "old")
        self.assertEqual(self.bridge.begin_turn("old-turn"), "old")
        self.sign_in(8, "new")
        self.assertFalse(self.bridge.signed_out(7))
        self.assertEqual(self.bridge.begin_turn("new-turn"), "new")
        self.assertTrue(self.bridge.signed_out(8))
        self.assertEqual(self.closed, [])
        self.bridge.finish_turn("new-turn")
        self.bridge.finish_turn("old-turn")
        self.assertCountEqual(self.closed, ["old", "new"])

    def test_invalid_session_closes_token_and_duplicate_turn_is_refused(self):
        with self.assertRaises(ValueError):
            self.sign_in(0, "bad")
        self.assertEqual(self.closed, ["bad"])
        self.sign_in(2, "good")
        self.assertEqual(self.bridge.begin_turn("t"), "good")
        with self.assertRaises(ValueError):
            self.bridge.begin_turn("t")
        self.bridge.stop_admitting()
        self.assertIsNone(self.bridge.begin_turn("u"))
        self.bridge.finish_turn("t")
        self.assertEqual(self.closed, ["bad", "good"])

    def test_sign_out_and_admission_are_serialized(self):
        self.sign_in(3, "token")
        barrier = threading.Barrier(2)
        acquired = []

        def attempt():
            barrier.wait()
            acquired.append(self.bridge.begin_turn("race"))

        thread = threading.Thread(target=attempt)
        thread.start()
        barrier.wait()
        self.bridge.signed_out(3)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        if acquired == ["token"]:
            self.assertEqual(self.closed, [])
            self.bridge.finish_turn("race")
        else:
            self.assertEqual(acquired, [None])
        self.assertEqual(self.closed, ["token"])


if __name__ == "__main__":
    unittest.main()
