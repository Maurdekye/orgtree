"""Mailhub requests use routing addresses, not credentials."""

import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import net


class AddressHeaderTests(unittest.TestCase):
    def test_single_hub_header_ignores_legacy_credentials(self):
        headers = net._hub_headers(
            {"id": net.LOCAL_HUB_ID, "token": "legacy-token", "peer_token": "old"},
            [("route.user.aaaaaa", "legacy-secret")],
        )
        self.assertEqual(headers, {"X-Org-Address": "route.user.aaaaaa"})


if __name__ == "__main__":
    unittest.main()
