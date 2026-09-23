import io
import struct
import unittest
import ctypes
from ctypes import wintypes as w

from engine.winservice.bridge_transport import (
    MAX_FRAME, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    WindowsPipeAPI, read_frame, write_frame,
)


class FrameTests(unittest.TestCase):
    def test_one_bounded_json_object_round_trip(self):
        stream = io.BytesIO()
        write_frame(stream, {"kind": "state", "nonce": "a" * 64})
        stream.seek(0)
        self.assertEqual(read_frame(stream), {"kind": "state", "nonce": "a" * 64})

    def test_large_or_truncated_frame_fails_before_dispatch(self):
        with self.assertRaises(ValueError):
            read_frame(io.BytesIO(struct.pack("<I", MAX_FRAME + 1)))
        with self.assertRaises(EOFError):
            read_frame(io.BytesIO(struct.pack("<I", 8) + b"{}"))
        with self.assertRaises(ValueError):
            read_frame(io.BytesIO(struct.pack("<I", 2) + b"[]"))


class ClientIdentityTests(unittest.TestCase):
    def test_checks_connected_instance_before_exposing_a_stream(self):
        class FakeKernel:
            def __init__(self):
                self.closed = []
                self.flags = None

            def CreateFileW(self, _name, _access, _share, _attrs, _mode, flags, _template):
                self.flags = flags
                return 22

            def GetNamedPipeServerProcessId(self, _handle, output):
                ctypes.cast(output, ctypes.POINTER(w.ULONG))[0] = 91
                return True

            def CloseHandle(self, handle):
                self.closed.append(int(handle.value))

        pipe = WindowsPipeAPI.__new__(WindowsPipeAPI)
        pipe.kernel = FakeKernel()
        exposed = []
        pipe.stream = lambda handle: exposed.append(handle) or io.BytesIO()
        with self.assertRaises(PermissionError):
            pipe.open_client(90)
        self.assertEqual(exposed, [])
        self.assertEqual(pipe.kernel.closed, [22])
        self.assertEqual(pipe.kernel.flags,
                         SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        with pipe.open_client(91):
            pass
        self.assertEqual(exposed, [22])


if __name__ == "__main__":
    unittest.main()
