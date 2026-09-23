import ctypes
import unittest

from engine.winservice.process import _environment_block, _environment_map


class EnvironmentTests(unittest.TestCase):
    def test_round_trip_and_secret_key_refusal(self):
        block = _environment_block({"USERPROFILE": r"C:\Users\test",
                                    "ORGTREE_V2_DATA": r"C:\Users\test\AppData\Roaming\Orgtree v2\data"})
        self.assertEqual(_environment_map(ctypes.addressof(block)),
                         {"ORGTREE_V2_DATA": r"C:\Users\test\AppData\Roaming\Orgtree v2\data",
                          "USERPROFILE": r"C:\Users\test"})
        with self.assertRaises(ValueError):
            _environment_block({"BAD=KEY": "x"})
        with self.assertRaises(ValueError):
            _environment_block({"SECRET": "a\x00b"})


if __name__ == "__main__":
    unittest.main()
