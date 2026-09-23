import tempfile
import unittest
from pathlib import Path

from engine.winservice.bridge_policy import allows_google_subscription


class BridgePolicyTests(unittest.TestCase):
    def test_service_accepts_only_subscription_cli_at_the_pinned_profile_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary)
            binary = profile / "AppData" / "Local" / "agy" / "bin" / "agy.exe"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"test executable path")
            cwd = str(profile / "agent")
            argv = [str(binary), "-p=", "--input-format", "stream-json",
                    "--output-format", "stream-json", "--add-dir", cwd,
                    "--model", "gemini-test", "--dangerously-skip-permissions"]
            env = {"AGY_CLI_DISABLE_AUTO_UPDATE": "true"}
            self.assertTrue(allows_google_subscription(profile, argv, cwd, env))
            self.assertFalse(allows_google_subscription(profile, ["C:\\Windows\\System32\\cmd.exe"] + argv[1:], cwd, env))
            self.assertFalse(allows_google_subscription(profile, argv, cwd,
                                                        {**env, "GEMINI_API_KEY": "key"}))
            self.assertFalse(allows_google_subscription(profile, argv + ["--execute", "cmd"], cwd, env))


if __name__ == "__main__":
    unittest.main()
