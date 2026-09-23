import unittest
from unittest.mock import patch
from pathlib import Path
import sys
import types

from engine import service_main


class ServiceConfigurationTests(unittest.TestCase):
    def test_no_service_mode_fails_before_spawning(self):
        with patch.object(service_main, "read_boot_record", side_effect=RuntimeError("mode off")):
            with patch.object(service_main.lifecycle, "supervise") as supervise:
                self.assertEqual(service_main.service_body(object()), service_main.EXIT_CONFIG)
                supervise.assert_not_called()

    def test_service_uses_supervisor_with_resolved_operator(self):
        guard = types.SimpleNamespace(check_installed_payload=lambda *_args:
                                      types.SimpleNamespace(ok=True, problems=[], checked=4))
        with patch.dict(sys.modules, {"engine.winservice.payload_guard": guard}):
          with patch.object(service_main, "read_boot_record", return_value=("S-1-5-21-1", Path("C:/protected"), "a" * 64)):
            with patch.object(service_main, "account_for_sid", return_value=("operator", "MACHINE")):
                with patch.object(service_main, "WindowsWtsSource"):
                    with patch.object(service_main, "BridgeMonitor") as monitor:
                        with patch.object(service_main.lifecycle, "supervise", return_value=0) as supervise:
                            self.assertEqual(service_main.service_body(object()), 0)
                            self.assertEqual(supervise.call_count, 1)
                            monitor.return_value.start.assert_called_once()
                            monitor.return_value.stop.assert_called_once()

    def test_payload_guard_refusal_prevents_operator_token_and_spawn(self):
        guard = types.SimpleNamespace(check_installed_payload=lambda *_args:
                                      types.SimpleNamespace(ok=False, problems=["bad ACL"], checked=1))
        with patch.dict(sys.modules, {"engine.winservice.payload_guard": guard}):
          with patch.object(service_main, "read_boot_record", return_value=("S-1-5-21-1", Path("C:/protected"), "a" * 64)):
            with patch.object(service_main, "account_for_sid") as account:
              with patch.object(service_main.lifecycle, "supervise") as supervise:
                self.assertEqual(service_main.service_body(object()), service_main.EXIT_CONFIG)
                account.assert_not_called()
                supervise.assert_not_called()


if __name__ == "__main__":
    unittest.main()
