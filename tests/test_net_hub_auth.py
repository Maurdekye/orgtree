from __future__ import annotations

import os
import tempfile
import unittest


class NetHubAuthTests(unittest.TestCase):
    def test_private_hub_headers_and_status_secrecy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orgtree-v2-net-") as root:
            os.environ["ORGTREE_DATA"] = root
            os.environ["ORGTREE_V2_HUB_ADDRESS"] = "http://127.0.0.1:1"
            from engine.backend.orgtree import net

            local = net._hub_headers(
                {"id": "local", "address": "http://127.0.0.1:1", "token": "owner-secret"}, [("a", "s")]
            )
            self.assertEqual(local["X-Hub-Token"], "owner-secret")
            self.assertNotIn("X-Hub-Peer-Token", local)

            remote = net._hub_headers(
                {"id": "remote", "peer_token": "peer-secret"}, [("a", "s")]
            )
            self.assertEqual(remote["X-Hub-Peer-Token"], "peer-secret")
            self.assertNotIn("X-Hub-Token", remote)

            visible = net.status_block(
                {
                    "slug": "org",
                    "net_identity": {"slug": "org.user.abc123"},
                    "net_hubs": [
                        {"id": "local", "address": "http://127.0.0.1:1",
                         "enabled": True, "token": "owner-secret"}
                    ],
                }
            )
            self.assertNotIn("token", visible["hubs"][0])


if __name__ == "__main__":
    unittest.main()
