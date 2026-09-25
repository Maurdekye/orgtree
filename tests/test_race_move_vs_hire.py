"""PYPG race test 7: a move racing a hire under the same parent (PG-3a x PG-3b).

The children cap (`max_children`, №34 runaway insurance) is decided on the
parent's children, and both writers can add one: a hire creates a child, a
move re-parents one in. Under DOC_LOCK the one lock serialized the two cap
checks. Under PYPG both lock the NEW PARENT'S ROW FOR UPDATE — the move via
`lifecycle_tx._move_rows`, the hire via WS3a's `staffdoor.hire_rows` (its row
set is reproduced below: the destination chain FOR UPDATE, the new node's row,
the settings FOR SHARE) — so the second one to commit counts the first one's
child and refuses at the cap. These arms force both orders with org_tx's pause
hooks:

  (i)  move first — the move holds the parent row; the hire must WAIT (proved
       from the lock table, not from timing alone), then see the moved child
       and refuse;
  (ii) hire first — the hire holds the parent row; the move must wait, then
       refuse.

In both, the parent ends with exactly `max_children` children. Each arm runs
with the transition fence (halt._FENCE) on and off; the hire takes NO fence,
so the order is the row lock's in both. A PAUSE COUNTER must prove the pause
held a transaction and the lock table must show the other writer WAITING on
the parent row, or the arm fails.

Run:  python tools/run-python-verification.py tests/test_race_move_vs_hire.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-rt7-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_ORGTX_TEST_HOOKS"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, lifecycle_tx, orgtx, store  # noqa: E402
from orgtree.ledger import USER, LedgerError, slugify  # noqa: E402

WAIT = 5.0
# WS3a's staffdoor (pypg/pg-3b-staffing b02ef50), reproduced so this test
# does not depend on that branch: what a hire decides on and writes
HIRE_SETTINGS = ("tiers", "max_depth", "max_children", "max_top_grant",
                 "default_top_grant", "cascade_hire", "dirs", "default_tools",
                 "default_visibility", "permission_mode", "default_effort",
                 "kiosk", "default_account", "slug", "fable_lock")
HIRE_LOGS = ("events", "notice_log", "mail_log")
HIRE_SECTIONS = ("notices", "mail", "audiences", "lifecycle")


def hire_rows(org, actor, dest, name):
    out, cur, seen = [], dest, set()
    while cur is not None and cur != USER and cur not in seen and cur in org.nodes:
        out.append(cur)
        seen.add(cur)
        if cur == actor:
            break
        cur = org.nodes[cur].get("parent")
    base = slugify(name)
    nid, i = base, 2
    while nid in org.nodes:
        nid, i = f"{base}-{i}", i + 1
    return out + [nid]


def hire(slug, dest, name):
    """A hire as one row transaction with staffdoor's row set (no fence)."""
    rows = hire_rows(store.cached_org(slug), USER, dest, name)
    with orgtx.org_tx(slug, nodes=rows, sections=HIRE_SECTIONS,
                      share_sections=HIRE_SETTINGS, logs=HIRE_LOGS) as tx:
        return tx.org.hire(USER, dest, "luna", 0, name)


class Pause:
    def __init__(self, thread_name, point):
        self.thread_name, self.point = thread_name, point
        self.held, self.release = threading.Event(), threading.Event()
        self.fired = 0
        self.seen = []
        self._lock = threading.Lock()

    def __call__(self, point, tx):
        name = threading.current_thread().name
        with self._lock:
            self.seen.append((name, point))
        if name == self.thread_name and point == self.point and not self.held.is_set():
            with self._lock:
                self.fired += 1
            self.held.set()
            if not self.release.wait(WAIT):
                raise AssertionError("pause was never released")

    def points(self, name):
        with self._lock:
            return [p for n, p in self.seen if n == name]


def waiting_on(slug, row):
    """Is anyone waiting for `row` in the fake's lock table right now? (Read
    from the lock manager itself, so a pass cannot come from timing.)"""
    locks = orgtx.backend().locks
    with locks._cv:
        key = (slug, "node", row)
        holder = locks._x.get(key)
        return holder is not None and any(holder in b for b in locks._waits.values())


class RaceMoveVsHire(unittest.TestCase):
    FENCE = True

    def setUp(self):
        self.slug = "rt7-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(USER, None, "luna", 0, "root")
        org.hire(USER, "root", "luna", 0, "p")       # the contested parent
        org.hire(USER, "root", "luna", 0, "q")
        org.hire(USER, "p", "luna", 0, "c1")         # p's first child
        org.hire(USER, "q", "luna", 0, "x")          # the node that moves
        org.d["max_children"] = 2
        store.save_org(org)
        self.enterContext(patch.object(halt, "_FENCE", self.FENCE))
        self.addCleanup(orgtx.set_pause_hook, None)
        self.threads = []
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        for t in self.threads:
            t.join(WAIT)
        store._POOL.close_all(self.slug)

    def spawn(self, name, fn, *args):
        out = {}

        def run():
            try:
                out["result"] = fn(*args)
            except BaseException as e:      # noqa: BLE001
                out["error"] = e
        t = threading.Thread(target=run, name=name, daemon=True)
        self.threads.append(t)
        t.start()
        return t, out

    def kids(self):
        return sorted(store.load_org(self.slug).org_children("p"))

    def wait_until(self, pred):
        deadline = time.monotonic() + WAIT
        while not pred() and time.monotonic() < deadline:
            time.sleep(0.01)
        return pred()

    def test_i_move_first_then_the_hire_refuses_at_the_cap(self):
        pause = Pause("rt7-move", "before_commit")
        orgtx.set_pause_hook(pause)
        mt, mv = self.spawn("rt7-move", lifecycle_tx.move, self.slug, USER, "x", "p")
        self.assertTrue(pause.held.wait(WAIT), "the move never reached its commit")
        ht, hr = self.spawn("rt7-hire", hire, self.slug, "p", "y")
        self.assertTrue(self.wait_until(lambda: waiting_on(self.slug, "p")),
                        "the hire is not waiting on the parent row")
        self.assertNotIn("after_lock", pause.points("rt7-hire"))
        pause.release.set()
        mt.join(WAIT)
        ht.join(WAIT)
        self.assertNotIn("error", mv, mv)
        self.assertIsInstance(hr.get("error"), LedgerError, hr)
        self.assertIn("cap", str(hr["error"]))
        self.assertEqual(self.kids(), ["c1", "x"])
        self.assertEqual(pause.fired, 1)

    def test_ii_hire_first_then_the_move_refuses_at_the_cap(self):
        pause = Pause("rt7-hire", "before_commit")
        orgtx.set_pause_hook(pause)
        ht, hr = self.spawn("rt7-hire", hire, self.slug, "p", "y")
        self.assertTrue(pause.held.wait(WAIT), "the hire never reached its commit")
        mt, mv = self.spawn("rt7-move", lifecycle_tx.move, self.slug, USER, "x", "p")
        self.assertTrue(self.wait_until(lambda: waiting_on(self.slug, "p")),
                        "the move is not waiting on the parent row")
        self.assertNotIn("after_lock", pause.points("rt7-move"))
        pause.release.set()
        ht.join(WAIT)
        mt.join(WAIT)
        self.assertNotIn("error", hr, hr)
        self.assertIsInstance(mv.get("error"), LedgerError, mv)
        self.assertIn("cap", str(mv["error"]))
        self.assertEqual(self.kids(), ["c1", "y"])
        self.assertEqual(store.load_org(self.slug).node("x")["parent"], "q")
        self.assertEqual(pause.fired, 1)


class RaceMoveVsHireNoFence(RaceMoveVsHire):
    FENCE = False


if __name__ == "__main__":
    unittest.main()
