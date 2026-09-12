"""steer_attempts as a KEYED lazy dict log (perf-redesign 2026-09-12).

The section is a dict of per-delivery attempt dicts mutated in place, so it
cannot ride the owner→list machinery directly: it is stored as ordinary
`log_d` rows whose val is a `[delivery_id, attempt]` pair and presented to
consumers as an `AttemptMap` — a dict view whose entry objects ARE the pair
halves, so the steering code's nested `att["resolved"] = …` edits reach the
rows through the same re-serialize-and-compare every other dict log uses.

Pinned here, each with the failure it guards against:
  * the legacy eager doc blob converts to rows on its first save (no
    operator migration), with the settled-view strip applied once;
  * a migrated document is NEVER rematerialized by Org construction (the
    marker check runs before the section is touched);
  * nested edits, id deletes/adds and consecutive saves keep row identity
    (the save-adoption path must unwrap AttemptMap to reach its log);
  * reconstruct_full/export_json rebuild the DOCUMENT shape
    {owner: {id: entry}} — list() on the dict view enumerates its KEYS, and
    that exact bug shipped in the first draft;
  * the §6.3 migration verifier round-trips a JSON document carrying the
    section.
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix='v2-steer-lazy-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name,
                  ORGTREE_MIGRATE="1")   # the JSON-era fixture below migrates
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store                # noqa: E402
from orgtree.ledger import Org           # noqa: E402
if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    # `DATA_ROOT` binds at import time (see tests/test_lazydoc_bool.py).
    raise unittest.SkipTest(
        "store.DATA_ROOT already bound elsewhere in this process; "
        "run this file on its own")

_slugs: set[str] = set()


def tearDownModule():
    for slug in _slugs:
        store._POOL.close_all(slug)
    _root.cleanup()


def _att(i: int, *, open_: bool = False, views: bool = False) -> dict:
    a: dict = {"at": f"2026-09-12T00:00:{i:02d}Z", "tool_use_id": f"tu{i}",
               "toks": [f"tok{i}"], "mail_ids": [f"m{i}"], "texts_n": 1}
    if not open_:
        a["recorded_at"] = "2026-09-12T01:00:00Z"
    if views:
        a["views"] = ["view text " * 5]
        a["view_segments"] = [[i, i + 1]]
    return a


class SteerAttemptsLazyTests(unittest.TestCase):
    def _fresh(self, name: str) -> tuple:
        org = store.create_org(name)
        slug = org.d["slug"]
        _slugs.add(slug)
        return org, slug

    @staticmethod
    def _rows(slug: str) -> list:
        con = sqlite3.connect(store._db_path(slug))
        try:
            return con.execute(
                "SELECT seq, owner, val FROM log_d "
                "WHERE sect='steer_attempts' ORDER BY seq").fetchall()
        finally:
            con.close()

    def _seqs(self, slug: str) -> dict:
        return {json.loads(val)[0]: seq for seq, _, val in self._rows(slug)}

    def _seeded(self, name: str) -> tuple:
        """An org whose steer_attempts is already rows-backed: seeded through
        the same plain-dict path a fresh org's first attempt takes."""
        org, slug = self._fresh(name)
        sect = org.d.setdefault("steer_attempts", {})
        sect.setdefault("n1", {})["d1"] = _att(1)
        sect["n1"]["d2"] = _att(2, open_=True, views=True)
        sect.setdefault("n2", {})["d3"] = _att(3)
        store.save_org(org)
        return store.load_org(slug), slug

    # -- migration lifecycle ----------------------------------------------

    def test_legacy_blob_strips_settled_views_then_converts_to_rows(self):
        org, slug = self._fresh("Steer Legacy Blob")
        legacy = {
            "nodeA": {"d1": _att(1, views=True),               # settled
                      "d2": _att(2, open_=True, views=True)},  # open
            "nodeB": {"d3": dict(_att(3, views=True),
                                 resolved="superseded")},
        }
        del legacy["nodeB"]["d3"]["recorded_at"]
        store._POOL.close_all(slug)
        con = sqlite3.connect(store._db_path(slug))
        try:
            # exactly what an old build left behind: the section as an eager
            # doc blob, and no strip marker yet
            con.execute("INSERT INTO doc(key,val) VALUES('steer_attempts',?)",
                        (json.dumps(legacy),))
            row = con.execute(
                "SELECT val FROM doc WHERE key='_migrations'").fetchone()
            migs = json.loads(row[0]) if row else {}
            migs.pop(Org.STEER_VIEW_STRIP_MIGRATION, None)
            con.execute(
                "INSERT INTO doc(key,val) VALUES('_migrations',?) "
                "ON CONFLICT(key) DO UPDATE SET val=excluded.val",
                (json.dumps(migs),))
            con.commit()
        finally:
            con.close()

        org2 = store.load_org(slug)
        sect = org2.d["steer_attempts"]        # the eager legacy dict
        self.assertNotIsInstance(sect, store.SectionMap)
        # the strip is EXACT, proven against the pre-construction original
        # (`legacy` was never handed to the loader): a settled attempt loses
        # precisely views/view_segments, an open one is byte-identical
        self.assertEqual(sect["nodeA"]["d1"],
                         {k: v for k, v in legacy["nodeA"]["d1"].items()
                          if k not in ("views", "view_segments")})
        self.assertEqual(sect["nodeB"]["d3"],
                         {k: v for k, v in legacy["nodeB"]["d3"].items()
                          if k not in ("views", "view_segments")})
        self.assertEqual(sect["nodeA"]["d2"], legacy["nodeA"]["d2"])
        self.assertIn("views", sect["nodeA"]["d2"])             # open: kept
        self.assertIn(Org.STEER_VIEW_STRIP_MIGRATION, org2.d["_migrations"])
        store.save_org(org2)

        con = sqlite3.connect(store._db_path(slug))
        try:
            self.assertIsNone(con.execute(
                "SELECT val FROM doc WHERE key='steer_attempts'").fetchone())
        finally:
            con.close()
        rows = self._rows(slug)
        self.assertEqual([(owner, json.loads(val)[0]) for _, owner, val in rows],
                         [("nodeA", "d1"), ("nodeA", "d2"), ("nodeB", "d3")])

        org3 = store.load_org(slug)
        s3 = org3.d["steer_attempts"]
        self.assertIsInstance(s3, store.SectionMap)
        self.assertFalse(dict.__contains__(s3, "nodeA"),
                         "an owner was materialized before it was read")
        self.assertEqual(dict(s3["nodeA"]), sect["nodeA"])
        self.assertEqual(dict(s3["nodeB"]), sect["nodeB"])

    def test_migrated_document_is_not_rematerialized_by_construction(self):
        _, slug = self._seeded("Steer Marker Guard")
        org = store.load_org(slug)             # Org.__init__ ran its repairs
        self.assertIn("steer_attempts", org.d._present)
        self.assertFalse(
            dict.__contains__(org.d, "steer_attempts"),
            "Org construction materialized steer_attempts on a document "
            "whose strip marker says there is nothing left to strip")

    def test_json_migration_verifier_accepts_the_keyed_section(self):
        _, slug = self._seeded("Steer Json Era")
        exported = json.loads(Path(store.export_json(slug))
                              .read_text(encoding="utf-8"))
        slug2 = "steer-json-migrated"
        exported["slug"] = slug2
        _slugs.add(slug2)
        Path(store._json_path(slug2)).write_text(
            json.dumps(exported), encoding="utf-8")

        org = store.load_org(slug2)   # migrates; §6.3 verifier raises on any
        # round-trip mismatch, which is exactly what a list-shaped
        # reconstruction of the keyed section produced
        self.assertEqual(dict(org.d["steer_attempts"]["n1"]),
                         exported["steer_attempts"]["n1"])
        con = sqlite3.connect(store._db_path(slug2))
        try:
            self.assertIsNone(con.execute(
                "SELECT val FROM doc WHERE key='steer_attempts'").fetchone())
        finally:
            con.close()
        self.assertTrue(self._rows(slug2))

    # -- the dict view over rows --------------------------------------------

    def test_nested_edit_persists_and_keeps_row_identity(self):
        org, slug = self._seeded("Steer Nested Edit")
        before = self._seqs(slug)
        m = org.d["steer_attempts"]["n1"]
        self.assertIsInstance(m, dict)
        self.assertEqual(list(m), ["d1", "d2"])
        m["d1"]["resolved"] = "unconfirmable"   # nested: no dict method sees it
        store.save_org(org)
        self.assertEqual(self._seqs(slug), before,
                         "a nested edit must UPDATE its row, not rewrite the owner")
        fresh = store.load_org(slug)
        self.assertEqual(fresh.d["steer_attempts"]["n1"]["d1"]["resolved"],
                         "unconfirmable")
        self.assertIn("views", fresh.d["steer_attempts"]["n1"]["d2"])

    def test_consecutive_saves_keep_appended_row_identity(self):
        """The save-adoption regression: the backing log of an AttemptMap must
        adopt its committed seqs, or every later save deletes and re-inserts
        the rows it appended (churn, and an order hazard behind it)."""
        org, slug = self._seeded("Steer Adoption")
        m = org.d["steer_attempts"]["n1"]
        m["d9"] = _att(9)
        store.save_org(org)
        first = self._seqs(slug)
        m["d9"]["resolved"] = "superseded"      # nested edit, same org object
        store.save_org(org)
        self.assertEqual(self._seqs(slug), first,
                         "the second save re-inserted rows the first one wrote")

    def test_delete_and_add_ids_round_trip(self):
        org, slug = self._seeded("Steer Del Add")
        m = org.d["steer_attempts"]["n1"]
        del m["d1"]
        m["d4"] = _att(4)
        self.assertEqual(m.pop("nope", "absent"), "absent")
        store.save_org(org)
        fresh = store.load_org(slug)
        self.assertEqual(dict(fresh.d["steer_attempts"]["n1"]),
                         {"d2": m["d2"], "d4": m["d4"]})
        self.assertEqual(list(fresh.d["steer_attempts"]["n1"]), ["d2", "d4"])
        self.assertNotIn("d1", {json.loads(val)[0]
                                for _, _, val in self._rows(slug)})

    def test_owner_delete_round_trips(self):
        org, slug = self._seeded("Steer Owner Del")
        del org.d["steer_attempts"]["n1"]
        store.save_org(org)
        fresh = store.load_org(slug)
        self.assertNotIn("n1", fresh.d["steer_attempts"])
        self.assertEqual(dict(fresh.d["steer_attempts"]["n2"]),
                         {"d3": _att(3)})
        self.assertEqual({owner for _, owner, _ in self._rows(slug)}, {"n2"})

    # -- eager reconstruction -------------------------------------------------

    def test_reconstruct_full_and_export_keep_document_shape(self):
        org, slug = self._seeded("Steer Reconstruct")
        expected = {"n1": dict(org.d["steer_attempts"]["n1"]),
                    "n2": dict(org.d["steer_attempts"]["n2"])}
        with store._POOL.acquire(slug) as conn:
            rec = store.reconstruct_full(conn)
        self.assertEqual(rec["steer_attempts"], expected)
        for per_node in rec["steer_attempts"].values():
            self.assertIsInstance(per_node, dict)   # NOT the pair/keys list
        doc = json.loads(Path(store.export_json(slug))
                         .read_text(encoding="utf-8"))
        self.assertEqual(doc["steer_attempts"], expected)


if __name__ == "__main__":
    unittest.main()
