"""Discriminating controls: real handlers deliberately broken in disposable children."""
import os
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
from tests import test_wire_contract as contract


class WireControls(unittest.TestCase):
    def test_each_defect_fails_its_public_scenario(self):
        cases = {
            "live_identity_bypass": "test_http_authentication_and_live_identity_binding",
            "receipt_admission_bypass": "test_receipt_replay_conflict_and_single_effect",
            "reversed_gallery": "test_document_pagination_order_and_body_boundary",
            "constant_stream_revision": "test_websocket_ordering_and_legacy_reconnect_snapshot",
            "stale_snapshot_revision": "test_websocket_ordering_and_legacy_reconnect_snapshot",
            "mcp_wrong_id": "test_mcp_initialize_list_and_correlation",
        }
        for control, method in cases.items():
            with self.subTest(control=control), patch.dict(os.environ, {
                "ORGTREE_WIRE_FACTORY": "tests.wire_contract.python_target:create_unsafe_target",
                "ORGTREE_WIRE_UNSAFE_CONTROL": control,
            }):
                suite = unittest.TestSuite([contract.WireContract(method)])
                result = unittest.TestResult()
                suite.run(result)
                self.assertEqual(result.testsRun, 1)
                self.assertEqual(result.errors, [], "A crash is not a discriminating assertion failure")
                self.assertEqual(result.skipped, [])
                self.assertGreater(len(result.failures), 0, f"Unsafe control survived: {control}")
                self.assertTrue(all(method in test.id() for test, _ in result.failures))


if __name__ == "__main__":
    unittest.main()
