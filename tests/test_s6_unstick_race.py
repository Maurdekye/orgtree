"""S6 (p01 plan review, Q3): unstick is ordered against the Fable weekly-limit
escalation by the `fable_lock` row, not by locking every other node.

`orgtree_unstick` on the door locks the target, `fable_lock`, the target's
notices row and the authority chain — NOT every other node FOR SHARE
(`api.unstick_rows` does). Its "is anyone else still limit_locked?" decision
reads the other nodes; the argument that this is safe is that every writer of
`limit_locked` also writes `fable_lock` (runtimedoor.unstick_spec), so the
fable_lock lock orders unstick after any such writer, and org_tx reads the
other rows only after its locks are granted.

The race, forced with racekit on the SQLite seam (transition fence off, both
racers are org_tx paths):

  A — the escalation (`supervisor._fable_limit_escalate`): sets `fable_lock`
      and `limit_locked` on the live Fable node `buddy`, HELD at before_commit;
  B — `orgtree_unstick` of `worker` through the real agent_call door. B must
      be proved WAITING on a row lock (racekit reads the lock manager's
      wait-for table) while A holds, and must take its locks only after A
      committed. It then sees buddy limit-locked and keeps `fable_lock`.

`worker` and `buddy` share no row but `fable_lock` (different parents, no
peers in common), so B's wait is the fable_lock row's. The CONTROL runs the
same race with `fable_lock` taken out of unstick's spec: B no longer waits,
and `race.blocked` fails — the lock is what orders the two.

What the control does NOT show: a wrong unstick DECISION. Without the lock B
runs first, finds no `fable_lock` yet (A has not committed) and has nothing
to release, so its outcome is still right. The escalation writes the lock and
every `limit_locked` in ONE commit, so no interleaving shows B a lock without
its holders; the lock's job here is the ordering the co-write argument relies
on, and that is what this test pins.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="s6-unstick-race-",
                                    ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_STORE"] = "sqlite"
os.environ["ORGTREE_PGDOOR"] = "1"
os.environ["ORGTREE_ORGTX_TEST_HOOKS"] = "1"
os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
import import_provenance  # noqa: F401,E402
import racekit  # noqa: E402
from orgtree import (api, ledger, orgtx, pgdoor, runtimedoor,  # noqa: E402
                     store, supervisor)

# both racers are org_tx paths: DOC_LOCK must not order them
orgtx.TRANSITION_FENCE = False

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


class UnstickVsEscalation(unittest.TestCase):

    def setUp(self):
        _N[0] += 1
        self.slug = f"s6ur{_N[0]}"
        org = store.create_org(self.slug)
        org.hire(U, None, "luna", 20, "boss")
        org.hire(U, None, "luna", 20, "other")
        org.hire("boss", "boss", "luna", 0, "worker", add_dirs=[], tools=T,
                 org_visibility="full", charter="c")
        org.hire("other", "other", "luna", 0, "buddy", add_dirs=[], tools=T,
                 org_visibility="full", charter="c")
        org.node("buddy")["model"] = "fable"
        org.node("worker")["frozen"] = {"at": "x", "resume_texts": ["go on"],
                                        "resume_views": ["go on"]}
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.p = [patch.object(supervisor, "send_message",
                               lambda *a, **k: {}),
                  patch.object(supervisor, "notify", lambda *a, **k: None),
                  patch.object(api, "hub_changed", lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def unstick(self):
        return api.agent_call(api.AgentCall(
            org=self.slug, node="boss", tool="orgtree_unstick",
            args={"node": "worker"}), REQUEST)

    def escalate(self):
        supervisor._fable_limit_escalate(self.slug, "buddy", "weekly", None)

    def race(self):
        with racekit.Race(pair="converted") as race:
            a = race.actor("A", self.escalate)
            b = race.actor("B", self.unstick)
            ga = race.hold(a, "before_commit")
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.blocked(b)
            race.release(ga)
            race.join(a, b)
            race.expect_order("A.after_commit", "B.after_lock")
        return race

    def test_unstick_waits_for_the_escalation_and_keeps_its_lock(self):
        self.race()
        org = store.load_org(self.slug)
        self.assertNotIn("frozen", org.node("worker"))
        self.assertTrue(org.node("buddy").get("limit_locked"))
        self.assertTrue(org.d.get("fable_lock"),
                        "unstick released a lock another node still holds")

    def test_control_without_the_fable_lock_row_nothing_orders_them(self):
        real = runtimedoor.unstick_spec

        def no_lock(snapshot, call, a):
            s = real(snapshot, call, a)
            return pgdoor.TxSpec(
                nodes=s.nodes,
                sections=tuple(x for x in s.sections if x != "fable_lock"),
                share_nodes=s.share_nodes, share_sections=s.share_sections,
                logs=s.logs)
        with patch.dict(pgdoor.LOCKS, {runtimedoor.UNSTICK: no_lock}):
            with self.assertRaisesRegex(racekit.RaceFailure,
                                        "never seen waiting on a row lock"):
                self.race()


if __name__ == "__main__":
    unittest.main()
