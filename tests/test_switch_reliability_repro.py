"""Deliberate reproductions of the switch-reliability symptoms (ticket
`make-model-provider-and-account-switching-on-liv`).

The ticket requires each named failure mode be reproduced BEFORE any fix is
designed. These tests assert the CURRENT (defective) behaviour so they are a
faithful record of the symptom; the accompanying fix flips the assertion in
`test_switch_reliability_fix.py`. Kept separate from the fix suite so the two
never share a fixture that could mask a regression.

Symptom under test here: a bare account rebind on a USAGE-LIMIT-FROZEN agent is
accepted and moves the binding, yet leaves the freeze in place — the agent is
now on a healthy account and still refuses all mail ("NOT delivered: <nid> is
frozen"). That is the org-verified stranded half-state: the switch neither
completed cleanly (the agent cannot run) nor did-not-happen (the binding did
move). Only `orgtree_unstick` / `/continue-on` releases it.
"""
import os
import tempfile
import time
import unittest


class FrozenRebindStrandsTheAgent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-switch-repro-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger, registry, store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label, provider="claude"):
        FrozenRebindStrandsTheAgent._seq += 1
        row = self.registry.create_account(
            provider, label,
            {"kind": "managed",
             "path": os.path.join(self.root, f"{provider}-{label}-{self._seq}")})
        self.registry.set_auth(row["id"], "authenticated")
        return self.registry.get_account(row["id"])

    def _frozen_org(self, slug, source_account, tier="opus",
                    provider="claude", pool="haiku+sonnet+opus"):
        org = self.ledger.Org.create(slug)
        org.hire(self.ledger.USER, None, tier, 0, "worker")
        org.d["auto_resume"] = False
        n = org.node("worker")
        n["account"] = source_account["id"]
        # a genuine usage-limit freeze: limit=True, NO `cause` — the exact
        # shape the classifier writes (supervisor.py:19800/19832)
        n["frozen"] = {
            "at": "2026-09-14T00:00:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": provider,
            "account": source_account["id"], "resource_pool": pool,
            "resume_texts": ["finish the original task"]}
        st = self.supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        self.store.save_org(org)
        return org

    def test_bare_rebind_moves_binding_but_leaves_agent_frozen(self):
        source = self._account("source")
        target = self._account("target")
        slug = "repro-strand"
        self._frozen_org(slug, source)

        # the binding move is ACCEPTED (assign_account's only refusal is busy)
        disclosure = self.supervisor.assign_account(
            slug, "worker", target["id"], actor="USER")
        self.assertEqual(disclosure["account"], target["id"])

        fresh = self.store.load_org(slug)
        node = fresh.node("worker")
        # THE STRANDED STATE: binding moved to the healthy account …
        self.assertEqual(node["account"], target["id"],
                         "the rebind did happen — this is not a no-op")
        # … yet the freeze survives, so the agent is still unusable
        self.assertIn("frozen", node,
                      "SYMPTOM: bare rebind left the usage-limit freeze in "
                      "place — the switch stranded the agent half-moved")
        self.assertTrue(node["frozen"].get("limit"))

    def test_frozen_agent_still_refuses_all_mail_after_rebind(self):
        source = self._account("source")
        target = self._account("target")
        slug = "repro-mail-refused"
        self._frozen_org(slug, source)
        self.supervisor.assign_account(slug, "worker", target["id"], actor="USER")

        # the mail gate inspects only truthiness of `frozen`, so a message
        # sent right after the rebind is refused exactly as the org saw
        result = self.supervisor.send_message(slug, "worker", "please continue")
        self.assertTrue(result.get("frozen"),
                        "SYMPTOM: mail refused as frozen after a rebind onto a "
                        "healthy account (org-verified starting evidence)")
        self.assertEqual(result.get("queued"), 0)

    def test_freeze_still_names_the_abandoned_account(self):
        # the scheduling layer keys admission on the freeze's OWN account, so a
        # freeze left in place after a rebind still points at the account the
        # node no longer uses — the switch left an invalid reference behind.
        source = self._account("source")
        target = self._account("target")
        slug = "repro-stale-ref"
        self._frozen_org(slug, source)
        self.supervisor.assign_account(slug, "worker", target["id"], actor="USER")
        node = self.store.load_org(slug).node("worker")
        self.assertEqual(node["frozen"]["account"], source["id"],
                         "SYMPTOM: the surviving freeze still names the "
                         "abandoned account, so the scheduler acts on a lane "
                         "the node has left")


if __name__ == "__main__":
    unittest.main()
