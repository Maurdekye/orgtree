import io
import unittest
from unittest.mock import patch

from engine import service_host
from engine.winservice.bridge_transport import write_frame


class BridgeRegistrationTests(unittest.TestCase):
    def test_wrong_pipe_owner_receives_no_host_secret(self):
        opened = []

        class FakePipe:
            def open_client(self, expected_server_pid):
                opened.append(expected_server_pid)
                raise PermissionError("wrong service PID")

        with patch("engine.winservice.bridge_transport.WindowsPipeAPI", return_value=FakePipe()):
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                service_host.register_bridge_engine("s" * 64, 17, 23, timeout=0)
        self.assertEqual(opened, [17])

    def test_exact_service_reply_registers_only_the_new_engine_pid(self):
        reply = io.BytesIO()
        write_frame(reply, {"ok": True})
        sent = bytearray()

        class Stream:
            def __enter__(self):
                self.reader = io.BytesIO(reply.getvalue())
                return self

            def __exit__(self, *_args):
                return False

            def read(self, n):
                return self.reader.read(n)

            def write(self, data):
                sent.extend(data)

            def flush(self):
                pass

        class FakePipe:
            def open_client(self, expected_server_pid):
                self.expected = expected_server_pid
                return Stream()

        pipe = FakePipe()
        with patch("engine.winservice.bridge_transport.WindowsPipeAPI", return_value=pipe):
            service_host.register_bridge_engine("s" * 64, 17, 23, timeout=0)
        self.assertEqual(pipe.expected, 17)
        self.assertIn(b'"enginePid":23', sent)


if __name__ == "__main__":
    unittest.main()
