import unittest
import threading
from unittest.mock import patch

from engine.winservice.bridge_server import BridgeServer
from engine.winservice.bridge_state import BridgeState


class ServerDispatchTests(unittest.TestCase):
    def test_secret_required_even_for_state(self):
        server = BridgeServer("S-1-5-21-1", 1, "a" * 64, BridgeState[int]())
        with self.assertRaises(PermissionError):
            server._dispatch({"op": "state", "secret": "b" * 64}, 1)
        self.assertEqual(server._dispatch({"op": "state", "secret": "a" * 64}, 1),
                         {"ok": True, "bridge": "off", "sessionId": None,
                          "activeTurns": 0})

    def test_logoff_during_suspended_creation_prevents_resume(self):
        state = BridgeState[str]()
        closed = []
        state.signed_in(7, "user-token", closed.append)

        class Candidate:
            def __init__(self):
                self.resumed = False
                self.closed = False

            def resume(self):
                self.resumed = True

            def close(self):
                self.closed = True

        candidate = Candidate()

        class Spawner:
            def create_suspended(self, token, _argv, _cwd, _env):
                self_token = token
                assert self_token == "user-token"
                state.signed_out(7)
                return candidate

        server = BridgeServer("S-1-5-21-1", 1, "a" * 64, state,
                              spawner=Spawner())
        result = server._spawn({"turnId": "race", "argv": ["program"],
                                "cwd": "C:\\", "env": {}}, 1)
        self.assertEqual(result, {"ok": False, "code": "signed-out-before-spawn"})
        self.assertFalse(candidate.resumed)
        self.assertTrue(candidate.closed)
        self.assertEqual(closed, ["user-token"])

    def test_failed_reply_terminates_orphaned_spawn(self):
        state = BridgeState[int]()
        server = BridgeServer("S-1-5-21-1", 1, "a" * 64, state)

        class Child:
            terminated = False

            def terminate(self):
                self.terminated = True

        child = Child()
        server._turns["orphan"] = child

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class Pipe:
            def stream(self, _handle):
                return Stream()

        class Kernel:
            def CloseHandle(self, _handle):
                pass

        server.pipe = Pipe()
        server.kernel = Kernel()
        server._peer = lambda _pid: 1
        server._slots = threading.BoundedSemaphore(1)
        server._slots.acquire()
        with patch("engine.winservice.bridge_server.read_frame",
                   return_value={"op": "spawn", "turnId": "orphan"}), \
             patch.object(server, "_dispatch", return_value={"ok": True}), \
             patch("engine.winservice.bridge_server.write_frame", side_effect=OSError):
            server._serve_connection(2, 3)
        self.assertTrue(child.terminated)


if __name__ == "__main__":
    unittest.main()
