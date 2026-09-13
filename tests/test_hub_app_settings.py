"""Installation mailhub settings keep only operational transport controls."""

import tempfile
import unittest
from pathlib import Path

from engine.hub_runtime import HubRuntime


class HubAppSettingsTests(unittest.TestCase):
    def test_runtime_status_has_no_peer_or_credential_administration(self):
        with tempfile.TemporaryDirectory(prefix="v2-hub-settings-") as folder:
            runtime = HubRuntime(Path(folder))
            runtime.start()
            try:
                status = runtime.status()
                self.assertNotIn("peers", status)
                self.assertNotIn("warning", status)
                self.assertNotIn("token", status)
                self.assertIn("address", status["status"])
            finally:
                runtime.stop()


if __name__ == "__main__":
    unittest.main()
