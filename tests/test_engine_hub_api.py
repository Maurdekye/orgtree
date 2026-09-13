import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from starlette.requests import Request


_temp = tempfile.TemporaryDirectory(prefix="v2-hub-api-")
os.environ["ORGTREE_DATA"] = _temp.name
os.environ["HOME"] = _temp.name
os.environ["USERPROFILE"] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

from engine.hub_runtime import HubRuntime
from orgtree import api, net, store


def tearDownModule():
    for slug in ("client-org", "legacy-org"):
        store._POOL.close_all(slug)
    _temp.cleanup()


class HubAPITests(unittest.TestCase):
    def setUp(self):
        self.request = Request({"type": "http", "headers": [], "state": {}})

    def _create_org(self, slug):
        org = store.create_org(slug)
        net.mint_identity(org)
        org.d["net_hubs"] = []
        store.save_org(org)
        return org

    def test_connects_a_reachable_hub_by_address_only(self):
        runtime = HubRuntime(_temp.name)
        runtime.start()
        try:
            self._create_org("client-org")
            address = os.environ["ORGTREE_V2_HUB_ADDRESS"]
            connected = api.connect_net_hub(
                "client-org", api.NetConnection(address=address), self.request
            )
            self.assertTrue(connected["connected"])
            self.assertEqual(connected["address"], address)
            public = api.org_net("client-org", self.request)
            self.assertEqual([hub["address"] for hub in public["hubs"]], [address])
            self.assertNotIn("token", json.dumps(public))
            self.assertNotIn("peer", json.dumps(public))
        finally:
            runtime.stop()

    def test_legacy_connection_fields_are_removed_when_settings_are_read(self):
        org = self._create_org("legacy-org")
        org.d["net_hubs"] = [{
            "id": "legacy", "address": "https://hub.example", "enabled": True,
            "peer_token": "old-token", "peer_slug": "old.address",
        }]
        store.save_org(org)
        visible = api.org_net("legacy-org", self.request)
        self.assertEqual(visible["hubs"], [{
            "id": "legacy", "address": "https://hub.example", "enabled": True,
        }])
        saved = store.load_org("legacy-org").d["net_hubs"][0]
        self.assertNotIn("peer_token", saved)
        self.assertNotIn("peer_slug", saved)


if __name__ == "__main__":
    unittest.main()
