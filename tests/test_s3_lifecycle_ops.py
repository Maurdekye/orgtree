"""S3 (fence-off): the lifecycle operator ops of `POST /api/orgs/{slug}/ops`
on the row-transaction door (`pgdoor.op_tx` through `api._op_door`).

Through the real `api.org_op` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1). For each op declared by `lifecycle_door`:

  · it is routed, and on the door it never enters the DOC_LOCK cycle
    (`_org_op_locked` is made to explode);
  · it gives the same result and the same tree as the cycle on a twin org;
  · it commits on its FIRST transaction (lead decision 40: auto-widening
    would otherwise hide an incomplete declaration);
  · its after-commit work (delete's runtime forget, cheap_compact's
    transcript copy) runs once, after the commit.

Run:  python tools/run-python-verification.py tests/test_s3_lifecycle_ops.py
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="s3-ops-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_STORE"] = "sqlite"
os.environ["ORGTREE_PGDOOR"] = "1"
os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
OPS = ("retire", "dissolve", "rescind", "delete", "move", "promote", "demote",
       "cheap_compact", "reseed", "rehire", "revoke_dir")
_N = [0]


class LifecycleOps(unittest.TestCase):
    def build(self, slug):
        org = store.create_org(slug)
        org.hire(U, None, "luna", 20, "boss")
        org.hire(U, "boss", "luna", 4, "a")
        org.hire(U, "boss", "luna", 4, "b")
        org.hire(U, "a", "luna", 1, "x")
        org.hire(U, "x", "luna", 0, "x1")
        org.hire(U, "b", "luna", 0, "b1")
        for n in ("a", "x", "x1"):
            org.nodes[n]["scope"]["add_dirs"] = [{"path": "C:/shared",
                                                  "mode": "rw"}]
        store.save_org(org)

    def setUp(self):
        _N[0] += 1
        self.slug, self.twin = f"s3ops{_N[0]}", f"s3twin{_N[0]}"
        self.build(self.slug)
        self.build(self.twin)
        self.p = [patch.object(supervisor, "send_message", lambda *a, **k: {}),
                  patch.object(supervisor, "interrupt_before_archive",
                               lambda *a, **k: []),
                  patch.object(supervisor, "remote_reap", lambda *a, **k: None),
                  patch.object(supervisor, "export_predecessor_transcript_deferred",
                               lambda *a, **k: (None, None)),
                  patch.object(api, "hub_changed", lambda *a, **k: None),
                  patch.object(api, "provider_hire_gate", lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)
        store._POOL.close_all(self.twin)

    def op(self, slug, **kw):
        return api.org_op(slug, api.Op(**kw), REQUEST)

    def door(self, **kw):
        with patch.object(api, "_org_op_locked",
                          side_effect=AssertionError("entered the DOC_LOCK cycle")):
            return self.op(self.slug, **kw)

    def cycle(self, **kw):
        with patch.object(pgdoor, "enabled", lambda: False):
            return self.op(self.twin, **kw)

    def view(self, slug, *sids):
        o = store.load_org(slug)
        v = repr(sorted((k, n.get("parent"), n.get("grant"), n.get("state"),
                         n.get("generation", 0),
                         sorted(d["path"] for d in n["scope"].get("add_dirs", [])))
                        for k, n in o.nodes.items()))
        return v.replace(slug, "<slug>")

    @staticmethod
    def strip(r, slug):
        r = dict(r)
        for k in ("ref", "reference", "warnings", "old_session"):
            r.pop(k, None)
        return repr(r).replace(slug, "<slug>")

    def attempts(self, **kw):
        real, opened = pgdoor._org_tx, []

        def counting():
            tx = real()

            def opener(*a, **k):
                opened.append(k)
                return tx(*a, **k)
            return opener
        with patch.object(pgdoor, "_org_tx", counting), \
                patch.object(api, "_org_op_locked",
                             side_effect=AssertionError("entered the cycle")):
            r = self.op(self.slug, **kw)
        return r, opened

    def unrecoverable(self, nid):
        for slug in (self.slug, self.twin):
            org = store.load_org(slug)
            org.mark_unrecoverable(nid, "test: its session is gone")
            store.save_org(org)

    def archive(self, nid):
        for slug in (self.slug, self.twin):
            org = store.load_org(slug)
            org.retire(U, nid)
            store.save_org(org)

    # ------------------------------------------------------------------ cases
    def cases(self):
        """(name, setup, op kwargs). Every case is valid on this tree."""
        return [
            ("retire", None, dict(op="retire", node="x")),
            ("dissolve", None, dict(op="dissolve", node="b")),
            ("delete", None, dict(op="delete", node="x")),
            ("move", None, dict(op="move", node="x", new_parent="b")),
            ("promote", None, dict(op="promote", node="x1", new_parent="a")),
            ("demote", None, dict(op="demote", node="x", new_parent="b")),
            ("cheap_compact", None, dict(op="cheap_compact", node="x")),
            ("rehire", lambda: self.archive("x"), dict(op="rehire", node="x")),
            ("reseed", lambda: self.unrecoverable("x"),
             dict(op="reseed", node="x")),
            ("revoke_dir", None, dict(op="revoke_dir", node="x",
                                      dir="C:/shared")),
        ]

    def test_the_lifecycle_ops_are_declared_and_routed(self):
        for op in OPS:
            self.assertTrue(pgdoor.declared(op), op)
            self.assertTrue(pgdoor.routed(op), op)

    def test_each_op_matches_the_cycle(self):
        for name, setup, kw in self.cases():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                if setup:
                    setup()
                mine, legacy = self.door(**kw), self.cycle(**kw)
                self.assertEqual(self.strip(mine, self.slug),
                                 self.strip(legacy, self.twin))
                self.assertEqual(self.view(self.slug), self.view(self.twin))

    def test_each_op_commits_in_one_attempt(self):
        for name, setup, kw in self.cases():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                if setup:
                    setup()
                before = self.view(self.slug)
                _, opened = self.attempts(**kw)
                self.assertEqual(len(opened), 1,
                                 (name, [sorted(k.get("nodes") or ())
                                         for k in opened]))
                self.assertNotEqual(self.view(self.slug), before, name)

    def test_revoke_dir_reaches_the_whole_subtree(self):
        r = self.door(op="revoke_dir", node="x", dir="C:/shared")
        self.assertEqual(sorted(r["removed_from"]), ["x", "x1"])
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["a"]["scope"]["add_dirs"][0]["path"], "C:/shared")

    def test_delete_forgets_the_runtime_once_after_the_commit(self):
        seen = []
        real = supervisor.forget

        def spy(slug, ids):
            from orgtree import pgdoor as _pg
            seen.append((sorted(ids), _pg.current(slug) is None))
            return real(slug, ids)
        with patch.object(supervisor, "forget", spy):
            self.door(op="delete", node="x")
        self.assertEqual(len(seen), 1, seen)
        self.assertIn("x", seen[0][0])
        self.assertTrue(seen[0][1], "forget ran inside the transaction")

    def test_cheap_compact_copies_the_transcript_once_after_the_commit(self):
        seen = []

        def spy(org, nid, old_sid=None, reason=None, **_):
            seen.append((nid, reason, pgdoor.current(self.slug) is None))
            return None, None
        with patch.object(supervisor, "export_predecessor_transcript_deferred",
                          spy):
            r = self.door(op="cheap_compact", node="x")
        self.assertTrue(r.get("old_session"), r)
        self.assertEqual(seen, [("x", "cheap_compact", True)])

    def test_cheap_compact_if_idle_refuses_a_busy_seat_and_commits_nothing(self):
        before = self.view(self.slug)
        st = supervisor.state(self.slug, "x")
        st["busy"] = True
        try:
            with self.assertRaises(HTTPException) as e:
                self.door(op="cheap_compact", node="x", if_idle=True)
        finally:
            st["busy"] = False
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(self.view(self.slug), before)

    def test_reseed_mints_its_session_id_once_before_the_transaction(self):
        # the fresh session id is minted in the before-step (outside the
        # transaction), so every attempt of the body uses the same one
        self.unrecoverable("x")
        minted = []
        real = pgdoor.BEFORE["reseed"]

        def spy(body, a):
            self.assertIsNone(pgdoor.current(self.slug))
            out = real(body, a)
            minted.append(out["reseed_session"])
            return out
        with patch.dict(pgdoor.BEFORE, {"reseed": spy}):
            self.door(op="reseed", node="x")
        self.assertEqual(len(minted), 1)
        o = store.load_org(self.slug)
        self.assertEqual(o.nodes["x"]["session_id"], minted[0])
        self.assertEqual(o.nodes["x"]["generation"], 1)

    def test_a_refused_op_is_a_422_and_commits_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(HTTPException) as e:
            self.door(op="demote", node="x", new_parent="x1")   # a cycle
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual(self.view(self.slug), before)

    def test_the_legacy_path_is_still_reached_with_the_door_off(self):
        with patch.dict(os.environ, {"ORGTREE_PGDOOR": "0"}):
            self.assertFalse(pgdoor.routed("retire"))


if __name__ == "__main__":
    unittest.main()
