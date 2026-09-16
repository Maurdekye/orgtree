"""Switch-reliability regression guard (ticket
`make-model-provider-and-account-switching-on-liv`).

HISTORY. This file first REPRODUCED the org-verified stranded state — a bare
account rebind on a usage-limit-frozen agent moved the binding to a healthy
account yet left it frozen, mail-refused, and still naming the abandoned
account (that reproduction is preserved in git at commit 56ce407). The fix
(coordinator ruling 2026-09-16, build (a)) makes that half-moved state
IMPOSSIBLE: a bare rebind on a movable usage-limit freeze is refused and the
agent is left exactly as it was, so it either recovers cleanly through
/continue-on or nothing happens.

This file now guards that property directly (acceptance conditions #2 and #7):
after a refused bare rebind, the WHOLE observable state — binding, freeze,
session, mailbox — is byte-identical to before. No stranded half-state is
observable.
"""
import copy
import os
import sys
import tempfile
import unittest

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-switch-repro-")
os.environ["ORGTREE_DATA"] = _ROOT
from engine.backend.orgtree import ledger, registry, store, supervisor  # noqa: E402
if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
    raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")


class NoStrandedHalfMove(unittest.TestCase):
    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label):
        NoStrandedHalfMove._seq += 1
        row = registry.create_account(
            "claude", label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"claude-{label}-{self._seq}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def _frozen_org(self, slug, source):
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["frozen"] = {"at": "2026-09-14T00:00:00Z", "limit": True,
                       "until_ts": 9999999999.0, "provider": "claude",
                       "account": source["id"], "resource_pool": "haiku+sonnet+opus",
                       "resume_texts": ["finish the original task"]}
        st = supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        store.save_org(org)
        return org

    def test_refused_bare_rebind_leaves_the_agent_byte_identical(self):
        source, target = self._account("source"), self._account("target")
        slug = "repro-no-strand"
        org = self._frozen_org(slug, source)
        before = copy.deepcopy(org.node("worker"))

        with self.assertRaises(RuntimeError) as ctx:
            supervisor.assign_account(slug, "worker", target["id"], actor="USER")
        # the refusal is actionable — it names the supported recovery path
        self.assertIn("/continue-on", str(ctx.exception))

        # NO half-move: the entire node is exactly as it was — same binding,
        # same freeze (still naming its own account), same session. There is
        # no observable in-between state.
        after = store.load_org(slug).node("worker")
        self.assertEqual(after, before)
        self.assertEqual(after["account"], source["id"])
        self.assertEqual(after["frozen"]["account"], source["id"])

    def test_the_supported_recovery_path_does_move_it(self):
        # the flip side: what the bare door refuses, the recovery opt-in
        # (allow_frozen — what /continue-on and auto-fallback pass) performs,
        # so the agent is never actually stuck on the frozen account.
        source, target = self._account("source"), self._account("target")
        slug = "repro-recovery-moves"
        self._frozen_org(slug, source)
        out = supervisor.assign_account(slug, "worker", target["id"],
                                        actor="USER", allow_frozen=True)
        self.assertEqual(out["account"], target["id"])
        self.assertEqual(store.load_org(slug).node("worker")["account"],
                         target["id"])


if __name__ == "__main__":
    unittest.main()
