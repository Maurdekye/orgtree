import unittest
from unittest.mock import patch

from engine import service_main


class ServiceConfigurationTests(unittest.TestCase):
    def test_no_service_mode_fails_before_spawning(self):
        with patch.object(service_main, "read_boot_record", side_effect=RuntimeError("mode off")):
            with patch.object(service_main.lifecycle, "supervise") as supervise:
                self.assertEqual(service_main.service_body(object()), service_main.EXIT_CONFIG)
                supervise.assert_not_called()

    def test_service_uses_supervisor_with_resolved_operator(self):
        with patch.object(service_main, "read_boot_record", return_value=("S-1-5-21-1", None)):
            with patch.object(service_main, "account_for_sid", return_value=("operator", "MACHINE")):
                with patch.object(service_main, "WindowsWtsSource"):
                    with patch.object(service_main, "BridgeMonitor") as monitor:
                        with patch.object(service_main.lifecycle, "supervise", return_value=0) as supervise:
                            self.assertEqual(service_main.service_body(object()), 0)
                            self.assertEqual(supervise.call_count, 1)
                            monitor.return_value.start.assert_called_once()
                            monitor.return_value.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
