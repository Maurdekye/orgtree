import unittest

from engine.winservice.bridge_spawn import BridgeSpawnAPI


class BridgeSpawnValidationTests(unittest.TestCase):
    def test_relative_or_missing_program_refused_without_process_creation(self):
        api = BridgeSpawnAPI()
        for argv in ([], ["cmd.exe"], [r"C:\missing\provider.exe"]):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                api.create_suspended(1, argv, "C:\\", {})


if __name__ == "__main__":
    unittest.main()
