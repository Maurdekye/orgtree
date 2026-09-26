"""The auto-wake tick opens a transaction ONLY for a seat whose decision writes.

SCALE (v3 scale gate): the 20 s tick ran one full transaction per live idle
seat — the docket reminder an `org_tx` (worktx.tx), the working checkup a
halt transaction (halt.txn, PG-3e-A) — whether or not the seat was owed anything, which is
O(N) transactions of O(N) cost each. Both passes now ask the SAME decision
function of the shared snapshot first (`_idle_docket_reminder_decision`,
`_working_checkup_decision`) and reserve only the seats it says write.

Through the real fleet passes, over one in-memory org whose four seats cover
every decision:
  · gated   — owes an item and is due, but the durable gate refuses it;
  · nothing — passes the gate but owes no actionable item;
  · recent  — owes an item but its clock is inside the 20 minutes;
  · due     — owes an item and is past the 20 minutes.
Only `due` may open a transaction, and it is still woken exactly once. The
reservation still re-decides on its own load (the snapshot is never the one
it writes).

Run:  python tools/run-python-verification.py tests/test_auto_wake_precheck.py
"""
import contextlib
import os
import tempfile
import types
import unittest
from unittest import mock

_data = tempfile.TemporaryDirectory(prefix="orgtree-auto-wake-precheck-")
os.environ["ORGTREE_DATA"] = _data.name

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import appsettings, halt, ledger, store, supervisor, worktx  # noqa: E402
assert str(store.DATA_ROOT).lower().startswith(_data.name.lower())

NOW = 1_800_000_000.0


def iso(t):
    return supervisor._iso_ts(t)


class AutoWakePrecheck(unittest.TestCase):
    def build(self):
        org = ledger.Org.create("precheck")
        old, fresh = iso(NOW - 3600), iso(NOW - 60)
        for nid, at in (("gated", old), ("nothing", old), ("recent", fresh),
                        ("due", old)):
            org.nodes[nid] = {
                "state": "live", "parent": None, "generation": 1,
                "last_status": {"status": "working", "at": at},
                "working_activity_at": at, "docket_reminder_at": at}
            if nid != "nothing":
                org.work_create(nid, f"Task for {nid}", "test", owner=nid)
        return org

    def sweep(self, which):
        """Run one pass; return (transactions opened per seat, woken seats)."""
        snap = self.build()
        opened = []

        def fresh_load(slug):
            # the reservation's OWN load: a distinct copy, as a real load is,
            # so a test cannot pass by writing through the snapshot
            return ledger.Org(__import__("copy").deepcopy(snap.d))

        def tx(slug, fn, **kw):
            org = fresh_load(slug)
            opened.append(org)
            return fn(org)

        def txn(slug, **kw):
            org = fresh_load(slug)
            opened.append(org)
            return contextlib.nullcontext(types.SimpleNamespace(org=org))

        wake = mock.Mock(return_value={"accepted": True})
        with mock.patch.object(appsettings, "blocked_docket_reminders_enabled",
                               return_value=False), \
             mock.patch.object(store, "cached_list",
                               return_value=[{"slug": snap.d["slug"]}]), \
             mock.patch.object(store, "cached_org", return_value=snap), \
             mock.patch.object(halt, "txn", side_effect=txn), \
             mock.patch.object(worktx, "tx", side_effect=tx), \
             mock.patch.object(supervisor, "state", return_value={}), \
             mock.patch.object(supervisor, "mail_spark"), \
             mock.patch.object(supervisor, "_auto_wake_gates_clear",
                               side_effect=lambda org, nid: nid != "gated"), \
             mock.patch.object(supervisor, "_working_cache_idle", return_value=True):
            if which == "reminder":
                supervisor._idle_docket_reminder_pass(
                    wake=wake, now=NOW, mode_enabled=True)
            else:
                supervisor._working_checkup_pass(
                    wake=wake, now=NOW, mode_enabled=True)
        return len(opened), [c.args[1] for c in wake.call_args_list]

    def test_reminder_opens_a_transaction_only_for_the_due_seat(self):
        opened, woken = self.sweep("reminder")
        self.assertEqual(woken, ["due"])
        self.assertEqual(opened, 1,
                         "a transaction opened for a seat whose snapshot "
                         "decision writes nothing (gated / nothing / recent)")

    def test_checkup_opens_a_transaction_only_for_the_due_seat(self):
        opened, woken = self.sweep("checkup")
        self.assertEqual(woken, ["due"])
        self.assertEqual(opened, 1,
                         "a halt transaction opened for a seat whose snapshot "
                         "decision writes nothing (gated / nothing / recent)")

    def test_the_locked_recheck_still_decides(self):
        """A snapshot that says due is not enough: the reservation re-decides
        on its own load, so a seat that stopped being due since is left
        alone (the transaction opens and writes nothing)."""
        snap = self.build()
        changed = ledger.Org(__import__("copy").deepcopy(snap.d))
        changed.node("due")["docket_reminder_at"] = iso(NOW - 5)
        self.assertEqual(supervisor._idle_docket_reminder_decision(snap, "due", NOW)[0],
                         "remind")
        self.assertIsNone(supervisor._idle_docket_reminder_reserve_body(changed, "due", NOW))
        self.assertEqual(changed.node("due")["docket_reminder_at"], iso(NOW - 5))

    def test_decisions_match_the_seats(self):
        snap = self.build()
        with mock.patch.object(supervisor, "_auto_wake_gates_clear",
                               side_effect=lambda org, nid: nid != "gated"), \
             mock.patch.object(appsettings, "blocked_docket_reminders_enabled",
                               return_value=False):
            got = {nid: (supervisor._idle_docket_reminder_decision(snap, nid, NOW)[0],
                         supervisor._working_checkup_decision(snap, nid, NOW))
                   for nid in ("gated", "nothing", "recent", "due")}
        self.assertEqual(got, {"gated": ("none", "none"),
                               "nothing": ("none", "none"),
                               "recent": ("none", "none"),
                               "due": ("remind", "checkup")})


if __name__ == "__main__":
    unittest.main()
