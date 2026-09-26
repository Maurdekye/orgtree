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
TOOLS = ("orgtree_move", "orgtree_swap", "orgtree_self_subjugate",
         "orgtree_retire", "orgtree_dissolve", "orgtree_rehire",
         "orgtree_retool")
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
        v = ({k: (v["parent"], v["grant"], v["state"])
              for k, v in o.nodes.items()},
             [(e["op"], e["detail"]) for e in o.d["events"]][-4:])
        # a scope event carries the org's own workspace path: compare the
        # two orgs modulo their slug
        return repr(v).replace(slug, "<slug>")

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
        """The result without its per-call reference, compared modulo the
        org's own slug (a scope carries the org's workspace path)."""
        r = dict(r)
        for k in ("ref", "reference", "warnings"):
            r.pop(k, None)
        return repr(r).replace(self.slug, "<slug>").replace(self.twin, "<slug>")

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

    def test_retire_matches_the_cycle_and_carries_the_archive_warnings(self):
        # the turn interrupt runs in agent_call BEFORE the door (no lock
        # held); its warnings must reach the result on both paths
        with patch.object(supervisor, "interrupt_before_archive",
                          lambda slug, org, nid: ["still settling: x1"]):
            mine, legacy = self.both("boss", "orgtree_retire", {"node": "x"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertIn("still settling: x1", mine.get("warnings") or [])
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["state"],
                         store.load_org(self.twin).nodes["x"]["state"])
        self.assertNotEqual(store.load_org(self.slug).nodes["x"]["state"], "live")

    def test_dissolve_matches_the_cycle(self):
        with patch.object(supervisor, "interrupt_before_archive",
                          lambda slug, org, nid: []):
            mine, legacy = self.both("boss", "orgtree_dissolve", {"node": "x"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertNotEqual(store.load_org(self.slug).nodes["x1"]["state"], "live")

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

    def attempts(self, node, tool, args):
        """How many org_tx transactions the door opened for one call."""
        real, opened = pgdoor._org_tx, []

        def counting():
            tx = real()

            def opener(*a, **k):
                opened.append(sorted(map(str, k.get("sections") or ())))
                return tx(*a, **k)
            return opener
        with patch.object(pgdoor, "_org_tx", counting):
            self.call(self.slug, node, tool, args)
        return opened

    def grant(self, grantee, grantor):
        org = store.load_org(self.slug)
        org.d.setdefault("audiences", []).append(
            {"grantee": grantee, "grantor": grantor})
        store.save_org(org)

    def test_every_door_tool_commits_in_one_attempt(self):
        # lead decision 40: auto-widen hides an incomplete spec, so each
        # converted tool must commit on its FIRST transaction. Each case
        # writes the sections its spec declares (an audience the change
        # revokes, a parent's notice) so a missing one would force a re-run.
        cases = [
            ("batch", "boss", "orgtree_move",
             {"moves": [{"node": "x", "new_parent": "b"},
                        {"node": "b1", "new_parent": "a"}]}, ("x1", "a")),
            ("swap", "boss", "orgtree_swap", {"a": "a", "b": "b"}, ("x", "a")),
            ("self_subjugate", "x", "orgtree_self_subjugate",
             {"target": "x1"}, None),
            ("retire", "boss", "orgtree_retire", {"node": "x"}, None),
            ("dissolve", "boss", "orgtree_dissolve", {"node": "b"}, None),
        ]
        for name, node, tool, args, aud in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                if aud:
                    self.grant(*aud)
                with patch.object(supervisor, "interrupt_before_archive",
                                  lambda slug, org, nid: []):
                    opened = self.attempts(node, tool, args)
                self.assertEqual(len(opened), 1, (name, opened))

    # ------------------------------------------------------------ rehire

    def archive(self, nid):
        for slug in (self.slug, self.twin):
            org = store.load_org(slug)
            org.retire(U, nid)
            store.save_org(org)

    def item(self):
        """A docket item on both orgs, returned by slug (same on both)."""
        slugs = []
        for slug in (self.slug, self.twin):
            org = store.load_org(slug)
            w = org.work_create(U, "rehire item", "why it exists", owner="boss")
            store.save_org(org)
            slugs.append(w["created"])
        self.assertEqual(slugs[0], slugs[1])
        return slugs[0]

    def test_the_rehire_scope_fields_are_the_seat_finish_fields(self):
        self.assertEqual(set(lifecycle_door._REHIRE_SCOPE),
                         set(api._SEAT_SCOPE_REHIRE))

    def test_rehire_matches_the_cycle(self):
        self.archive("x")
        mine, legacy = self.both("boss", "orgtree_rehire", {"node": "x"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["state"], "live")

    def test_rehire_into_a_new_parent_matches_the_cycle(self):
        self.archive("x")
        mine, legacy = self.both("boss", "orgtree_rehire",
                                 {"node": "x", "target": "b"})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["parent"], "b")

    def test_rehire_with_scope_and_kickoff_matches_the_cycle(self):
        self.archive("x")
        args = {"node": "x", "charter": "new charter", "kickoff": "go"}
        mine, legacy = self.both("boss", "orgtree_rehire", args)
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"].get("charter"),
                         "new charter")

    def test_rehire_with_a_work_item_matches_the_cycle(self):
        self.archive("x")
        slug = self.item()
        mine, legacy = self.both("boss", "orgtree_rehire",
                                 {"node": "x", "work_item": slug})
        self.assertEqual(self.strip(mine), self.strip(legacy))
        owner = lambda s: [(i.get("owner") or {}).get("node")
                           for i in store.load_org(s).d["work_items"]
                           if i.get("slug") == slug]
        self.assertEqual(owner(self.slug), ["x"])
        self.assertEqual(owner(self.slug), owner(self.twin))

    def test_a_refused_rehire_after_a_rename_says_the_rename_stands(self):
        # the rename runs before the door, in its own transaction; a refusal
        # after it must name the new id, on both paths, word for word
        self.archive("x")
        args = {"node": "x", "name": "xx", "target": "nobody"}
        with self.assertRaises(HTTPException) as door:
            self.call(self.slug, "boss", "orgtree_rehire", dict(args))
        with patch.object(pgdoor, "enabled", lambda: False):
            with self.assertRaises(HTTPException) as cyc:
                self.call(self.twin, "boss", "orgtree_rehire", dict(args))
        self.assertIn("The RENAME already happened", door.exception.detail)
        self.assertEqual(door.exception.detail, cyc.exception.detail)
        self.assertEqual(store.load_org(self.slug).nodes["xx"]["state"],
                         store.load_org(self.twin).nodes["xx"]["state"])

    def test_every_rehire_shape_commits_in_one_attempt(self):
        cases = [("plain", {"node": "x"}),
                 ("placed", {"node": "x", "target": "b"}),
                 ("scoped+kickoff", {"node": "x", "charter": "c2",
                                     "tools": {"bash": False}, "kickoff": "go"}),
                 ("work_item", None)]
        for name, args in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                self.archive("x")
                if args is None:
                    args = {"node": "x", "work_item": self.item()}
                opened = self.attempts("boss", "orgtree_rehire", args)
                self.assertEqual(len(opened), 1, (name, opened))

    def test_rehire_audience_grants_commit_in_one_attempt(self):
        # review f3: Org.audience_grant resolves an open request
        # (audience_requests) and, for the user's ear, writes the user inbox
        # and its log. Each form must be declared, not healed by a widen.
        def pending(org):
            org.d["audience_requests"].append({"from": "x", "target": "boss"})
        cases = [("user", ["user"], None),
                 ("pending request", ["boss"], pending)]
        for name, aud, seed in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                self.archive("x")
                if seed:
                    org = store.load_org(self.slug)
                    seed(org)
                    store.save_org(org)
                opened = self.attempts("boss", "orgtree_rehire",
                                       {"node": "x", "audiences": aud})
                self.assertEqual(len(opened), 1, (name, opened))
                o = store.load_org(self.slug)
                self.assertEqual(o.d["audience_requests"], [])
                self.assertEqual(o.nodes["x"]["state"], "live")

    def test_a_rehire_account_rebind_commits_in_one_attempt(self):
        # a provider-crossing rebind (luna seat, account changed, a session
        # that ran) archives the session in place (folded notices, the
        # docket reconcile) in the generic door step. Its rows are
        # supervisor._ASSIGN_*, declared whole: a retired seat's asks and
        # requests were already mooted by the retire, so those rows are not
        # written here today and only the plan pins them.
        spec = lifecycle_door.rehire_rows(store.load_org(self.slug), "boss",
                                          {"node": "x", "account": "primary"})
        self.assertLessEqual(set(supervisor._ASSIGN_SECTIONS),
                             set(spec.sections))
        self.assertLessEqual(set(supervisor._ASSIGN_SHARE),
                             set(spec.sections) | set(spec.share_sections))
        self.assertLessEqual(set(supervisor._ASSIGN_LOGS), set(spec.logs))
        self.archive("x")
        org = store.load_org(self.slug)
        org.nodes["x"]["account"] = "old-review-account"
        org.nodes["x"]["session_unrun"] = False
        store.save_org(org)
        exported = []
        with patch.object(supervisor, "export_predecessor_transcript",
                          lambda *a, **k: exported.append(k.get("reason"))):
            opened = self.attempts("boss", "orgtree_rehire",
                                   {"node": "x", "account": "primary"})
        self.assertEqual(len(opened), 1, opened)
        self.assertEqual(exported, ["account_assign"])   # the crossing ran
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["x"]["state"], "live")
        self.assertIsNone(o.nodes["x"].get("account"))

    def test_an_account_refusal_after_a_rename_says_the_rename_stands(self):
        # review f4: the account binding runs in the generic door step AFTER
        # the family body; its refusal must carry the same rename warning
        # as the cycle's, once
        self.archive("x")
        args = {"node": "x", "name": "xx", "account": "primary"}
        with patch.object(supervisor, "assign_account",
                          side_effect=ValueError("binding refused")):
            with self.assertRaises(HTTPException) as door:
                self.call(self.slug, "boss", "orgtree_rehire", dict(args))
            with patch.object(pgdoor, "enabled", lambda: False):
                with self.assertRaises(HTTPException) as cyc:
                    self.call(self.twin, "boss", "orgtree_rehire", dict(args))
        self.assertIn("The RENAME already happened", door.exception.detail)
        self.assertEqual(door.exception.detail.count("RENAME"), 1)
        self.assertEqual(door.exception.detail, cyc.exception.detail)
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["xx"]["state"], "archived")
        self.assertNotIn("x", o.nodes)

    # ------------------------------------------------------------ retool

    def test_retool_fields_are_the_set_scope_fields_retool_passes(self):
        import inspect
        src = inspect.getsource(api._retool_seat)
        for f in lifecycle_door.RETOOL_FIELDS:
            self.assertIn(f"{f}=", src, f)

    def test_retool_matches_the_cycle(self):
        args = {"node": "x", "charter": "retooled", "tools": {"bash": False}}
        mine, legacy = self.both("a", "orgtree_retool", args)
        self.assertEqual(self.strip(mine), self.strip(legacy))
        self.assertEqual(self.view(self.slug), self.view(self.twin))
        self.assertEqual(store.load_org(self.slug).nodes["x"].get("charter"),
                         "retooled")

    def test_retool_effort_is_sent_live_after_the_commit(self):
        sent = []

        def live(org, nid, previous=None):
            # the level must already be COMMITTED when the send runs
            committed = store.load_org(org.d["slug"]).effective_effort(nid)
            sent.append((org.d["slug"], nid, committed))
            return {"sent": True}
        with patch.object(supervisor, "send_live_effort", live):
            mine, legacy = self.both("a", "orgtree_retool",
                                     {"node": "x", "effort": "low"})
        self.assertEqual(mine.get("effort_delivery"), {"sent": True})
        self.assertEqual(mine.get("effort_delivery"), legacy.get("effort_delivery"))
        self.assertEqual([t for t in sent if t[0] == self.slug],
                         [(self.slug, "x", "low")])

    def test_choosing_your_own_account_is_the_same_403_on_both_paths(self):
        for slug, door in ((self.slug, True), (self.twin, False)):
            with patch.object(pgdoor, "enabled", lambda d=door: d):
                with self.assertRaises(HTTPException) as e:
                    self.call(slug, "x", "orgtree_retool",
                              {"node": "x", "account": "claude-9"})
                self.assertEqual(e.exception.status_code, 403)

    def _account(self):
        from orgtree import registry
        row = registry.create_account(
            "claude", "t", {"kind": "managed",
                            "path": os.path.join(_root.name, f"acct-{self.slug}")})
        for slug in (self.slug, self.twin):
            org = store.load_org(slug)
            org.node("x")["model"] = "opus"
            store.save_org(org)
        return row["id"]

    def test_retool_with_an_account_matches_the_cycle(self):
        rid = self._account()
        mine, legacy = self.both("a", "orgtree_retool",
                                 {"node": "x", "account": rid})
        self.assertEqual(store.load_org(self.slug).nodes["x"].get("account"), rid)
        self.assertEqual(store.load_org(self.slug).nodes["x"].get("account"),
                         store.load_org(self.twin).nodes["x"].get("account"))
        self.assertEqual(mine.get("account"), legacy.get("account"))

    def test_every_retool_shape_commits_in_one_attempt(self):
        cases = [("scope", {"node": "x", "charter": "c3", "tools": {"bash": False},
                            "add_dirs": []}),
                 ("effort", {"node": "x", "effort": "low"}),
                 ("account", None)]
        for name, args in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                if args is None:
                    args = {"node": "x", "account": self._account()}
                with patch.object(supervisor, "send_live_effort",
                                  lambda *a, **k: {}):
                    opened = self.attempts("a", "orgtree_retool", args)
                self.assertEqual(len(opened), 1, (name, opened))

    def test_a_provider_crossing_retool_moots_in_one_attempt(self):
        # a live luna seat whose session ran, rebound to another account:
        # assign_account archives the session in place and moots the seat's
        # open ask and pending scope request (supervisor._ASSIGN_* rows)
        org = store.load_org(self.slug)
        org.nodes["x"]["account"] = "old-review-account"
        org.nodes["x"]["session_unrun"] = False
        org.d["audiences"].append({"grantee": "x", "grantor": U})
        org.ask_user("x", "a question?")
        org.request_scope(
            "x", [{"kind": "dir", "path": tempfile.mkdtemp(dir=_root.name)}],
            "why")
        store.save_org(org)
        o = store.load_org(self.slug)             # the seed really is open
        self.assertEqual([q["status"] for q in o.d["asks"]
                          if q["node"] == "x"], ["open"])
        self.assertEqual([r["status"] for r in o.d["scope_requests"]
                          if r["node"] == "x"], ["pending"])
        exported = []
        with patch.object(supervisor, "export_predecessor_transcript",
                          lambda *a, **k: exported.append(k.get("reason"))):
            opened = self.attempts("a", "orgtree_retool",
                                   {"node": "x", "account": "primary"})
        self.assertEqual(len(opened), 1, opened)
        self.assertEqual(exported, ["account_assign"])   # the crossing ran
        o = store.load_org(self.slug)
        self.assertEqual([q["status"] for q in o.d["asks"]
                          if q["node"] == "x"], ["moot"])
        self.assertEqual([r["status"] for r in o.d["scope_requests"]
                          if r["node"] == "x"], ["moot"])


if __name__ == "__main__":
    unittest.main()
