"""S6 C2-A: the switch queued behind a turn is applied on a row transaction.

`_run_one_turn`'s finally used to apply a queued model switch / account
rebind (`_apply_pending_switch_locked`) with `_node_write(whole_org=True)`:
DOC_LOCK and the whole document, with the predecessor transcript copied
inside it. `supervisor._apply_queued_switch` now runs it through
`pgdoor.run` over `switch_rows` (the one spec p03-ws3b's switch_model door
shares) and copies transcripts only after the commit (`export_after_commit`).

  * a same-provider switch: ONE org_tx commit, no transcript copy;
  * a provider crossing with its own account: the copy runs after the
    commit (no transaction open), once per archived session;
  * a plan too narrow for the writes widens and re-runs: the wake lists and
    the copies are refilled, never duplicated.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                            # noqa: BLE001
    pass
_root = tempfile.TemporaryDirectory(prefix="s6-queued-switch-",
                                    ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_STORE"] = "sqlite"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
import import_provenance  # noqa: F401,E402
from orgtree import ledger, orgtx, pgdoor, registry, store, supervisor  # noqa: E402

U = ledger.USER
T1 = "2026-09-26T00:00:01.000Z"
_N = [0]


class QueuedSwitch(unittest.TestCase):

    def setUp(self):
        _N[0] += 1
        self.slug = f"s6qs{_N[0]}"
        self.commits: list[orgtx.Committed] = []
        orgtx.commit_listeners.append(self.commits.append)
        self.copies: list[tuple] = []

        def copy(slug, org, nid, old_sid, why):
            self.copies.append((nid, old_sid, why, orgtx.current_tx(slug)))
        self.p = patch.object(supervisor, "export_after_commit", copy)
        self.p.start()

    def tearDown(self):
        self.p.stop()
        orgtx.commit_listeners.remove(self.commits.append)
        store._POOL.close_all(self.slug)

    def account(self, provider, label):
        row = registry.create_account(
            provider, label,
            {"kind": "managed",
             "path": os.path.join(_root.name, f"{provider}-{label}-{_N[0]}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def worker(self, pending, account=None):
        org = store.create_org(self.slug)
        org.hire(U, None, "opus", 10, "worker")
        n = org.node("worker")
        if account:
            n["account"] = account
        n["session_id"] = "old-session"
        n.pop("session_unrun", None)
        n["pending_switch"] = pending
        store.save_org(org)

    def mine(self):
        return [c for c in self.commits if c.slug == self.slug]

    def apply(self):
        wake, account_wake = [], []
        supervisor._apply_queued_switch(self.slug, "worker", wake,
                                        account_wake)
        return wake, account_wake

    def test_a_same_provider_switch_is_one_row_transaction(self):
        self.worker({"tier": "sonnet", "from": "opus", "by": U,
                     "crossing": False, "at": T1})
        self.commits.clear()
        self.apply()
        n = store.load_org(self.slug).node("worker")
        self.assertEqual(n["model"], "sonnet")
        self.assertNotIn("pending_switch", n)
        self.assertEqual(len(self.mine()), 1)
        self.assertEqual(self.copies, [])

    def test_a_crossing_copies_its_transcript_after_the_commit(self):
        src = self.account("claude", "src")
        dst = self.account("openai", "dst")
        self.worker({"tier": "astra", "from": "opus", "by": U,
                     "crossing": True, "at": T1, "account": dst["id"]},
                    account=src["id"])
        self.apply()
        n = store.load_org(self.slug).node("worker")
        self.assertEqual(n["model"], "astra")
        self.assertEqual(n.get("account"), dst["id"])
        self.assertTrue(self.copies, "the crossing owed a transcript copy")
        self.assertEqual({c[1] for c in self.copies}, {"old-session"})
        for c in self.copies:
            self.assertIsNone(c[3], "copied inside the transaction")

    def test_a_widened_rerun_does_not_duplicate_copies(self):
        src = self.account("claude", "src")
        dst = self.account("openai", "dst")
        self.worker({"tier": "astra", "from": "opus", "by": U,
                     "crossing": True, "at": T1, "account": dst["id"]},
                    account=src["id"])
        runs = []
        real = supervisor._apply_pending_switch_locked

        def counted(*a, **k):
            runs.append(1)
            return real(*a, **k)
        narrow = pgdoor.TxSpec(nodes=("worker",))
        with patch.object(supervisor, "switch_rows",
                          lambda *a, **k: narrow), \
                patch.object(supervisor, "_apply_pending_switch_locked",
                             counted):
            self.apply()
        self.assertGreater(len(runs), 1, "the narrow plan never widened")
        self.assertEqual(store.load_org(self.slug).node("worker")["model"],
                         "astra")
        self.assertEqual(len(self.copies), len(set(self.copies)))
        self.assertEqual({c[1] for c in self.copies}, {"old-session"})

    def test_switch_rows_names_the_seat_bearer_and_per_owner_notices(self):
        self.worker({"tier": "sonnet", "from": "opus", "by": U, "at": T1})
        org = store.load_org(self.slug)
        spec = supervisor.switch_rows(org, U, "worker", rebind=False)
        self.assertIn("worker", spec.nodes)
        self.assertIn("worker@0", spec.nodes)
        self.assertIn(("notices", "worker"), spec.sections)
        self.assertNotIn("notices", spec.sections)
        self.assertIn("asks", spec.sections)
        rb = supervisor.switch_rows(org, U, "worker", rebind=True)
        self.assertIn("work_items", rb.sections)


if __name__ == "__main__":
    unittest.main()
