import ctypes
import unittest

from engine.winservice.process import _environment_block, _environment_map, no_prompt_git


class EnvironmentTests(unittest.TestCase):
    def test_service_and_bridge_git_never_open_hidden_prompts(self):
        env = {"GCM_INTERACTIVE": "always", "GIT_ASKPASS": "credential-window",
               "SSH_ASKPASS": "credential-window"}
        no_prompt_git(env)
        self.assertEqual({key: env[key] for key in (
            "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GIT_ASKPASS",
            "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE")},
            {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never",
             "GIT_ASKPASS": "", "SSH_ASKPASS": "",
             "SSH_ASKPASS_REQUIRE": "never"})

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
