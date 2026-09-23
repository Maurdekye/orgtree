import io
import struct
import unittest

from engine.winservice.bridge_transport import MAX_FRAME, read_frame, write_frame


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


if __name__ == "__main__":
    unittest.main()
