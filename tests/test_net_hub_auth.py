from __future__ import annotations

import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import net


class NetHubAddressTests(unittest.TestCase):
    def test_multiplexed_hub_headers_name_every_route_without_tokens(self) -> None:
        headers = net._group_headers(
            {"one": {"token": "legacy-owner"}},
            {"one": "route.one.aaaaaa", "two": "route.two.bbbbbb"},
            [("route.one.aaaaaa", "old-secret"), ("route.two.bbbbbb", "old-secret")],
        )
        self.assertEqual(headers, {"X-Org-Address": "route.one.aaaaaa route.two.bbbbbb"})
        self.assertNotIn("Token", " ".join(headers))


if __name__ == "__main__":
    unittest.main()
