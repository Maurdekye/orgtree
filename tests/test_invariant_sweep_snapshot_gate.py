"""scale: the 30 s invariant sweep gates on the shared snapshot.

`_invariant_sweep_org` used to open `_computed_tx` for every org on every
tick, and its lock-free pre-read is a whole-org `orgtx.org_read`. Now a pass
that finds nothing on `store.cached_org` returns without that read; a pass
that finds something takes the old locked path unchanged.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="sweep-gate-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import ledger, orgtx, store, supervisor  # noqa: E402

TOOLS = {"bash": True, "web": True, "edit": True, "subagents": True,
         "mcp": []}


def _fresh(slug):
    org = ledger.Org.create(slug)
    nid = org._new_node("opus", None, 0, "root", [], TOOLS, "full", "c")
    store.save_org(org)
    return nid


class _Count:
    """Counts whole-org pre-reads and locked sweep transactions."""

    def __enter__(self):
        self.reads = 0
        self.txs = 0
        real_read, real_tx = orgtx.org_read, supervisor._computed_tx

        def read(*a, **k):
            self.reads += 1
            return real_read(*a, **k)

        def tx(*a, **k):
            self.txs += 1
            return real_tx(*a, **k)
        self._p = [patch.object(orgtx, "org_read", read),
                   patch.object(supervisor, "_computed_tx", tx)]
        for p in self._p:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._p:
            p.stop()


class SnapshotGateTests(unittest.TestCase):

    def test_clean_org_takes_no_whole_org_read(self):
        slug = "gate-clean"
        _fresh(slug)
        store.cached_org(slug)                     # the shared snapshot, warm
        with _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual((c.reads, c.txs), (0, 0))

    def test_saved_bad_freeze_after_a_clean_pass_is_still_repaired(self):
        slug = "gate-freeze"
        nid = _fresh(slug)
        store.cached_org(slug)
        supervisor._invariant_sweep_org(slug)      # clean pass, gated
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["frozen"] = {"error": "x", "bogus_kind": True,
                                       "at": "2026-09-26T00:00:00Z"}
            store.save_org(org)
        with _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual(c.txs, 1)                 # the old locked path ran
        fz = store.load_org(slug).node(nid)["frozen"]
        self.assertEqual(fz.get("_quarantined", {}).get("bogus_kind"), True)
        with _Count() as c:
            supervisor._invariant_sweep_org(slug)  # repaired: gated again
        self.assertEqual((c.reads, c.txs), (0, 0))

    def test_dead_remote_driver_is_seen_through_the_gate(self):
        # pid death is the one input that changes without a save
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        slug = "gate-rc"
        nid = _fresh(slug)
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["remote_controlled"] = {"at": "x", "pid": p.pid}
            store.save_org(org)
        with patch.object(supervisor, "send_message", return_value={}), \
                _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual(c.txs, 1)
        self.assertIsNone(
            store.load_org(slug).node(nid).get("remote_controlled"))

    def test_orphan_is_announced_once_then_gated(self):
        slug = "gate-orphan"
        org = ledger.Org.create(slug)
        boss = org._new_node("opus", None, 0, "boss", [], TOOLS, "full", "c")
        kid = org._new_node("haiku", boss, 0, "kid", [], TOOLS, "full", "c")
        org.nodes[boss]["state"] = "archived"
        store.save_org(org)
        with _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual(c.txs, 1)
        self.assertIn((slug, kid, "orphan"), supervisor._invariant_announced)
        with _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual((c.reads, c.txs), (0, 0))

    def test_unreadable_snapshot_falls_back_to_the_locked_path(self):
        slug = "gate-nosnap"
        _fresh(slug)
        with patch.object(store, "cached_org", side_effect=RuntimeError), \
                _Count() as c:
            supervisor._invariant_sweep_org(slug)
        self.assertEqual(c.txs, 1)


if __name__ == "__main__":
    unittest.main()
