"""PG-3a's topology tools on the row-transaction door (lifecycle_door.py).

Through the real `api.agent_call` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1):

  · orgtree_move (one move and a batch), orgtree_swap and
    orgtree_self_subjugate are declared, and each one run on the door gives
    the same result and the same tree as the DOC_LOCK cycle on a twin org;
  · a door call never enters the resident cycle (`store.write_org` is made
    to explode);
  · a spec computed from a STALE snapshot (a report hired after it was taken)
    widens and still commits the whole move;
  · a malformed `moves` batch is the same 422 on both paths, and commits
    nothing.

Run:  python tools/run-python-verification.py tests/test_pg3a_door.py
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="pg3a-door-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_STORE"] = "sqlite"
os.environ["ORGTREE_PGDOOR"] = "1"
os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import (api, ledger, lifecycle_door, lifecycle_tx, orgtx,  # noqa: E402
                     pgdoor, store, supervisor)

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
TOOLS = ("orgtree_move", "orgtree_swap", "orgtree_self_subjugate")
_N = [0]


class Door(unittest.TestCase):
    def build(self, slug):
        org = store.create_org(slug)
        org.hire(U, None, "luna", 20, "boss")
        org.hire(U, "boss", "luna", 4, "a")
        org.hire(U, "boss", "luna", 4, "b")
        org.hire(U, "a", "luna", 1, "x")
        org.hire(U, "x", "luna", 0, "x1")
        org.hire(U, "b", "luna", 0, "b1")
        store.save_org(org)

    def setUp(self):
        _N[0] += 1
        self.slug = f"pg3adoor{_N[0]}"
        self.twin = f"pg3atwin{_N[0]}"
        self.build(self.slug)
        self.build(self.twin)
        self.p = [patch.object(supervisor, "send_message",
                               lambda *a, **k: {}),
                  patch.object(api, "hub_changed", lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)
        store._POOL.close_all(self.twin)

    def call(self, slug, node, tool, args):
        return api.agent_call(api.AgentCall(org=slug, node=node, tool=tool,
                                            args=args), REQUEST)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["state"])
                 for k, v in o.nodes.items()},
                [(e["op"], e["detail"]) for e in o.d["events"]][-4:])

    def both(self, node, tool, args):
        """The tool on the door (self.slug, write_org exploding) and on the
        DOC_LOCK cycle (self.twin, the door off). Returns both results."""
        def boom(*a, **k):
            raise AssertionError("a door tool entered the DOC_LOCK cycle")
        with patch.object(store, "write_org", boom):
            mine = self.call(self.slug, node, tool, args)
        with patch.object(pgdoor, "enabled", lambda: False):
            legacy = self.call(self.twin, node, tool, args)
        return mine, legacy

    def strip(self, r):
        r = dict(r)
        for k in ("ref", "reference", "warnings"):
            r.pop(k, None)
        return r

    def test_the_topology_tools_are_declared_and_routed(self):
        for t in TOOLS:
            self.assertTrue(pgdoor.declared(t), t)
            self.assertTrue(pgdoor.routed(t, {}), t)
        with patch.dict(os.environ, {"ORGTREE_PGDOOR": "0"}):
            self.assertFalse(pgdoor.routed("orgtree_move", {}))

    def test_move_matches_the_cycle(self):
        mine, legacy = self.both("boss", "orgtree_move",
                                 {"node": "x", "new_parent": "b"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["parent"], "b")

    def test_move_batch_matches_the_cycle(self):
        args = {"moves": [{"node": "x", "new_parent": "b"},
                          {"node": "b1", "new_parent": "a"}]}
        mine, legacy = self.both("boss", "orgtree_move", args)
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        o = store.load_org(self.slug)
        self.assertEqual((o.nodes["x"]["parent"], o.nodes["b1"]["parent"]),
                         ("b", "a"))

    def test_swap_matches_the_cycle(self):
        mine, legacy = self.both("boss", "orgtree_swap", {"a": "a", "b": "b"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))

    def test_self_subjugate_matches_the_cycle(self):
        mine, legacy = self.both("x", "orgtree_self_subjugate", {"target": "x1"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["parent"], "x1")

    def test_a_stale_snapshot_widens_and_moves_the_whole_subtree(self):
        # the spec is computed from a snapshot taken BEFORE x2 was hired
        # under x; the body finds x2 on the locked document and widens
        stale = store.load_org(self.slug)
        stale = type(stale)(copy.deepcopy(stale.d))
        org = store.load_org(self.slug)
        org.hire(U, "x", "luna", 0, "x2")
        store.save_org(org)
        widened = []
        real = pgdoor._run

        def spy(slug, spec, step):
            widened.append(spec)
            return real(slug, spec, step)
        with patch.object(pgdoor, "_snapshot", lambda slug: stale), \
                patch.object(pgdoor, "_run", spy):
            r = self.call(self.slug, "boss", "orgtree_move",
                          {"node": "x", "new_parent": "b"})
        self.assertTrue(r)
        self.assertNotIn("x2", widened[0].nodes)       # the stale plan missed it
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["x"]["parent"], "b")
        self.assertEqual(o.nodes["x2"]["parent"], "x")   # moved WITH x

    def test_a_malformed_batch_is_the_same_422_on_both_paths(self):
        for bad in (["x"], [{"node": "x"}], "x"):
            before = self.view(self.slug)
            with self.assertRaises(HTTPException) as door:
                self.call(self.slug, "boss", "orgtree_move", {"moves": bad})
            with patch.object(pgdoor, "enabled", lambda: False):
                with self.assertRaises(HTTPException) as cyc:
                    self.call(self.twin, "boss", "orgtree_move", {"moves": bad})
            self.assertEqual(door.exception.status_code, 422, bad)
            self.assertEqual(door.exception.detail, cyc.exception.detail, bad)
            self.assertEqual(self.view(self.slug), before, bad)

    def test_a_refused_move_is_a_422_and_commits_nothing(self):
        before = (self.view(self.slug), orgtx.backend().revision(self.slug))
        with self.assertRaises(HTTPException) as e:
            # an agent may not promote to the top level (user only)
            self.call(self.slug, "boss", "orgtree_move",
                      {"node": "x", "new_parent": ""})
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual((self.view(self.slug),
                          orgtx.backend().revision(self.slug)), before)

    def test_a_move_commits_in_one_attempt_on_its_declared_rows(self):
        # The door HEALS an incomplete spec: a write to an unlocked row is
        # refused by org_tx and re-run holding it. So "the move landed"
        # proves nothing about the spec; exactly ONE attempt does. An
        # audience grant that the move revokes makes the sweep write
        # `audiences`, the section a spec without it would miss.
        org = store.load_org(self.slug)
        org.d.setdefault("audiences", []).append(
            {"grantee": "x1", "grantor": "a"})
        store.save_org(org)
        real_run, attempts = pgdoor._org_tx, []

        def counting():
            tx = real_run()

            def opened(*a, **k):
                attempts.append(k)
                return tx(*a, **k)
            return opened
        with patch.object(pgdoor, "_org_tx", counting):
            self.call(self.slug, "boss", "orgtree_move",
                      {"node": "x", "new_parent": "b"})
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["x"]["parent"], "b")
        self.assertNotIn(("x1", "a"), [(g["grantee"], g["grantor"])
                                       for g in o.d.get("audiences") or []])
        self.assertEqual(len(attempts), 1, [sorted(k["sections"]) for k in attempts])
        self.assertIn("audiences", attempts[0]["sections"])

if __name__ == "__main__":
    unittest.main()
