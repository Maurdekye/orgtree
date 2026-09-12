"""W09 endpoint controls: authorization and durable transaction wiring."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix="w09-reservations-")
_data = Path(_root.name) / "data"; _data.mkdir()
_home = Path(_root.name) / "home"; _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN="operator")
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from orgtree import agentauth, ledger, store  # noqa: E402


class ReservationEndpointTests(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        org = store.create_org(f"w09-endpoint-{self.seq}")
        self.slug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 0, "owner")
        org.hire(ledger.USER, None, "haiku", 0, "peer")
        item = org.work_create("owner", "Reservation scope", "scope",
                               owner="owner", participants=["peer"])
        self.item = str(item["slug"])
        store.save_org(org)
        self.client = TestClient(app)
        self.tokens = {n: agentauth.child_env(self.slug, n)["ORGTREE_AGENT_TOKEN"]
                       for n in ("owner", "peer")}

    def tearDown(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)

    def call(self, node: str, **args: object):
        return self.client.post("/api/agent", json={
            "org": self.slug, "node": node, "tool": "orgtree_reservation",
            "args": args}, headers={"X-Orgtree-Agent-Token": self.tokens[node]})

    def test_scoped_visibility_and_no_filesystem_access(self):
        c = self.call("owner", action="acquire", resource="main",
                      item=self.item, candidate="a" * 40, base="b" * 40,
                      paths=["engine/api.py"])
        self.assertEqual(c.status_code, 200, c.text)
        row = c.json()["reservation"]
        listed = self.call("peer", action="list")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["reservations"][0]["id"], row["id"])
        overlap = self.call("peer", action="overlap", item=self.item,
                            paths=["engine/api.py"])
        self.assertEqual(overlap.status_code, 200, overlap.text)
        self.assertEqual(overlap.json()["count"], 1)
        self.assertNotIn("content", overlap.text)

    def test_release_notifies_one_authorized_successor(self):
        c = self.call("owner", action="acquire", resource="main",
                      item=self.item, candidate="a" * 40, base="b" * 40)
        rid = c.json()["reservation"]["id"]
        # The real post-commit drive starts a peer turn.  Stub only that
        # transport in this fixture so teardown cannot race a worker; the
        # durable release mail is still written by the endpoint itself.
        with patch("orgtree.api.supervisor.send_message",
                   return_value={"delivered": True}):
            released = self.call("owner", action="release", reservation=rid,
                                 successor="peer")
        self.assertEqual(released.status_code, 200, released.text)
        self.assertEqual(released.json()["notified"], "peer")
        org = store.load_org(self.slug)
        # One durable release notice is posted; the normal post-commit drive
        # may add its transport prompt, but it must not fan out to peers.
        peer_mail = org.d.get("mail", {}).get("peer", [])
        self.assertEqual(sum("release receipt" in str(m.get("body") or "")
                             for m in peer_mail), 1)


if __name__ == "__main__":
    unittest.main()
