"""Slice D (v3 scale, 2026-09-26): the per-load/save path names `orgs/`
without a `makedirs`, and a creator still makes the directory.

At 20 active seats `store._orgs_dir()` (a `makedirs` reached from
`_safe_slug`, `_db_path` and `_json_path`, up to three times per load) was
the top non-idle leaf of the scale-runtime stack profile. The hot path now
uses `_orgs_path()` (root guard + join); `_orgs_dir()` keeps creating the
directory for the cold callers and for every site that creates a file there.
"""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-orgs-path-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store  # noqa: E402

_real_makedirs = os.makedirs


class OrgsPath(unittest.TestCase):
    def _counting(self):
        calls: list[str] = []

        def fake(path, *a, **k):
            calls.append(os.path.normcase(os.path.abspath(path)))
            return _real_makedirs(path, *a, **k)
        return calls, patch.object(store.os, "makedirs", side_effect=fake)

    def test_a_creating_an_org_makes_a_missing_orgs_dir(self):
        """Runs first, on the module's fresh root: with `orgs/` gone, only a
        creator can bring it back (naming a path no longer does)."""
        d = os.path.join(store.DATA_ROOT, "orgs")
        if os.path.isdir(d):
            self.assertEqual(os.listdir(d), [], "the fresh root already holds orgs")
            os.rmdir(d)
        self.assertFalse(os.path.isdir(d))
        store._safe_slug("probe-org")               # names it: creates nothing
        store._db_path("probe-org")
        self.assertFalse(os.path.isdir(d), "naming a path created orgs/")
        slug = "od-" + str(time.time_ns())
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        store.save_org(org)
        self.assertTrue(os.path.isdir(d))
        self.assertIn("boss", store.load_org(slug).nodes)

    def test_load_and_name_make_no_directory(self):
        slug = "ol-" + str(time.time_ns())
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        store.save_org(org)
        calls, p = self._counting()
        with p:
            for _ in range(5):
                store._safe_slug(slug)
                store._db_path(slug)
                store._json_path(slug)
                store.load_org(slug)
                store.load_org_snapshot(slug, ())
        self.assertEqual(calls, [], "the load path called makedirs")

    def test_orgs_dir_still_creates_for_cold_callers(self):
        calls, p = self._counting()
        with p:
            d = store._orgs_dir()
        self.assertEqual(calls, [os.path.normcase(os.path.abspath(d))])
        self.assertEqual(d, store._orgs_path())

    def test_orgs_path_keeps_the_root_guard(self):
        with patch.object(store, "_assert_synced_data_root",
                          side_effect=store.DataRootDesync("desync")) as g:
            with self.assertRaises(store.DataRootDesync):
                store._safe_slug("any-org")
        g.assert_called_once()


if __name__ == "__main__":
    unittest.main()
