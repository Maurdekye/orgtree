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


class LandingSlotEndToEndTests(unittest.TestCase):
    """Two agents contending for `main` in an isolated org, over the endpoint.

    The two hold different tickets and can read nothing of each other's work,
    which is the real shape of the problem: the pair queueing to land are not
    collaborators, so nothing about the other's reservation is visible to them
    by ordinary item authorization.
    """

    seq = 0
    MAIN = "1" * 40
    BRANCH_A = "2" * 40
    BRANCH_B = "3" * 40

    def setUp(self):
        type(self).seq += 1
        org = store.create_org(f"landing-slot-{self.seq}")
        self.slug = str(org.d["slug"])
        for node in ("agent-a", "agent-b"):
            org.hire(ledger.USER, None, "haiku", 0, node)
        self.items = {}
        for node in ("agent-a", "agent-b"):
            item = org.work_create(node, f"Ticket for {node}", "scope",
                                   owner=node)
            self.items[node] = str(item["slug"])
        store.save_org(org)
        self.client = TestClient(app)
        self.tokens = {n: agentauth.child_env(self.slug, n)["ORGTREE_AGENT_TOKEN"]
                       for n in ("agent-a", "agent-b")}

    def tearDown(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)

    def call(self, node: str, **args: object):
        return self.client.post("/api/agent", json={
            "org": self.slug, "node": node, "tool": "orgtree_reservation",
            "args": args}, headers={"X-Orgtree-Agent-Token": self.tokens[node]})

    def test_empty_store_lists_cleanly_before_anyone_has_reserved(self):
        # The reported symptom: `list` is the first thing anyone runs, and on
        # a fresh org it used to answer "reservation records are malformed".
        listed = self.call("agent-a", action="list")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["count"], 0)
        self.assertNotIn("malformed", listed.text)

    def test_two_agents_contend_for_the_landing_slot(self):
        first = self.call("agent-a", action="acquire", resource="main",
                          item=self.items["agent-a"], candidate=self.BRANCH_A,
                          base=self.MAIN, paths=["engine/backend/orgtree/ledger.py"])
        self.assertEqual(first.status_code, 200, first.text)
        rid = first.json()["reservation"]["id"]

        # The second agent is refused, and the refusal names the holder.
        second = self.call("agent-b", action="acquire", resource="main",
                           item=self.items["agent-b"], candidate=self.BRANCH_B,
                           base=self.MAIN)
        self.assertNotEqual(second.status_code, 200)
        self.assertIn("agent-a", second.text)
        self.assertIn(rid, second.text)

        # And it can see who holds it without asking anyone.
        seen = self.call("agent-b", action="list", resource="main")
        self.assertEqual(seen.status_code, 200, seen.text)
        self.assertEqual(seen.json()["count"], 1)
        row = seen.json()["reservations"][0]
        self.assertEqual(row["owner"], "agent-a")
        self.assertEqual(row["base"], self.MAIN)
        self.assertEqual(row["view"], "contention")
        # Without being shown the holder's declared paths or its ticket.
        self.assertNotIn("paths", row)
        self.assertNotIn("ledger.py", seen.text)

        # The holder releases, and the second agent acquires.
        released = self.call("agent-a", action="release", reservation=rid)
        self.assertEqual(released.status_code, 200, released.text)
        third = self.call("agent-b", action="acquire", resource="main",
                          item=self.items["agent-b"], candidate=self.BRANCH_B,
                          base=self.MAIN)
        self.assertEqual(third.status_code, 200, third.text)
        self.assertEqual(third.json()["reservation"]["owner"], "agent-b")

    def test_the_lease_survives_a_restart_of_the_process(self):
        # A lease that lives only in one process's memory is not a mechanism.
        self.call("agent-a", action="acquire", resource="main",
                  item=self.items["agent-a"], candidate=self.BRANCH_A,
                  base=self.MAIN)
        store._POOL.close_all(self.slug)
        reloaded = store.load_org(self.slug)
        rows = reloaded.d["reservations"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["owner"], "agent-a")
        self.assertEqual(rows[0]["state"], "held")
        self.assertEqual(rows[0]["base"], self.MAIN)

    def test_an_unfiltered_list_does_not_expose_another_agents_reservation(self):
        self.call("agent-a", action="acquire", resource="main",
                  item=self.items["agent-a"], candidate=self.BRANCH_A,
                  base=self.MAIN)
        listed = self.call("agent-b", action="list")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["count"], 0)


if __name__ == "__main__":
    unittest.main()
