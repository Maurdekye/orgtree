"""CONTINUE A FROZEN AGENT ON ANOTHER ACCOUNT (user requirement 2026-09-14,
docket `continue-frozen-agents-on-another-account`).

THE PROBLEM. A frozen agent stays unusable even when another signed-in account
for the same provider has room, because with automatic account fallback off
nothing in the interface moves it. The recovery is a context-menu entry per
eligible account that switches the binding and then releases the freeze.

⚠ WHERE THE RULES LIVE. Every gate is `account_fallback`'s, the module the
AUTOMATIC path already uses — same freeze conditions, same per-model allowance,
same capacity marks. The manual path differs in exactly one thing: who decides
to move. So these tests pin the SPLIT (`movable` / `eligible` / `manual_only`)
rather than re-asserting the shared rules a second time.

⚠ AND THE TWO EVIDENCE PATHS ARE NOT THE SAME. Menu visibility is decided on
cache-only evidence, because the payload is recomposed per node on a 6 s
heartbeat and a forced provider read there is the per-node IO D-239 forbids.
The ACTION re-decides it against a forced read. The test that matters most for
that split is `test_stale_menu_capacity_is_rechecked_and_refuses_to_switch`:
the cached board says yes, the live one says no, and nothing moves.
"""
import asyncio
import copy
import datetime
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch


import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

class ContinueFrozenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-continue-frozen-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import (account_fallback, api, ledger,
                                            registry, store, supervisor)
        assert os.path.realpath(store.DATA_ROOT) == os.path.realpath(cls.root)
        cls.api, cls.ledger, cls.store = api, ledger, store
        cls.fallback, cls.registry, cls.supervisor = (account_fallback, registry,
                                                      supervisor)

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        self.fallback._scanned.clear()
        self.slug = "continue-frozen"
        self.org = self.ledger.Org.create(self.slug)
        # a REAL hire, not a hand-built dict: the API tree projection reads
        # fields (session_id, created, ui_order…) that only the ledger mints,
        # and a fixture missing one tests the fixture rather than the feature
        self.org.hire(self.ledger.USER, None, "opus", 0, "worker")
        self.org.d["auto_resume"] = False
        # the pristine seat, restored before each freeze so one case's
        # mutation can never decide the next case's control
        self.pristine = copy.deepcopy(self.org.node("worker"))

    # ---------------------------------------------------------------- helpers
    def _account(self, label, provider="claude", auth="authenticated",
                 kind="managed"):
        row = self.registry.create_account(
            provider, label,
            {"kind": kind, "path": os.path.join(self.root, provider + label)})
        self.registry.set_auth(row["id"], auth)
        return self.registry.get_account(row["id"])

    def _freeze(self, source, *, tier="opus", provider="claude",
                pool="haiku+sonnet+opus", fallback_on=False):
        self.org.nodes["worker"] = copy.deepcopy(self.pristine)
        n = self.org.node("worker")
        n.update(model=tier, account=source["id"], frozen={
            "at": "2026-09-14T00:00:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": provider,
            "account": source["id"], "resource_pool": pool,
            "resume_texts": ["finish the original task"]})
        n["scope"]["account_fallback"] = fallback_on
        st = self.supervisor.state(self.slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        self.store.save_org(self.org)
        return n

    def _board(self, provider="claude", exhausted=False, kinds=None,
               model=None):
        reset = datetime.datetime.fromtimestamp(
            time.time() + 7200, datetime.timezone.utc).isoformat()
        return {"available": True, "lane": "subscription", "limits": [
            {"kind": kind, "group": "codex" if provider == "openai" else kind,
             "percent": 100 if exhausted else 10, "resets_at": reset,
             # a weekly_scoped lane belongs to the model it NAMES
             # (limits.lane_applies), so the fable board has to say so
             "model": model if kind == "weekly_scoped" else None}
            for kind in (kinds or ("session", "weekly_all"))]}

    # ------------------------------------------------- the one-question split
    def test_the_manual_and_automatic_paths_ask_the_same_freeze_question(self):
        source = self._account("source")
        self._account("target")
        self._freeze(source, fallback_on=False)
        # fallback OFF: the operator moves it by hand, the scheduler does not
        self.assertTrue(self.fallback.movable(self.org, "worker"))
        self.assertTrue(self.fallback.manual_only(self.org, "worker"))
        self.assertFalse(self.fallback.eligible(self.org, "worker"))
        # fallback ON: the automatic path owns it and the manual entries go
        # away, so two mechanisms never race for one binding
        self.org.node("worker")["scope"]["account_fallback"] = True
        self.assertTrue(self.fallback.eligible(self.org, "worker"))
        self.assertFalse(self.fallback.manual_only(self.org, "worker"))

    def test_a_freeze_no_other_account_could_clear_is_movable_by_neither(self):
        source = self._account("source")
        self._account("target")
        # each case starts from a freeze that IS movable, so every assertion
        # below measures its own mutation and not the previous one's leftovers
        for mutation in (
                {"frozen": None},                                  # not frozen
                {"frozen_patch": {"limit": False}},                 # not a limit
                {"frozen_patch": {"untrusted": True}},              # auth freeze
                {"frozen_patch": {"on_fallback": True}},            # already moved
                {"frozen_patch": {"cause": "spend"}},               # not capacity
                {"frozen_patch": {
                    "error": "rate limit: 40 requests per minute"}},
                {"pending_switch": {"tier": "sonnet"}},             # mid-change
                {"remote_controlled": True},
                {"inflight": "x"},
                {"bearer_state": "archived"}):
            self._freeze(source)
            node = self.org.node("worker")
            self.assertTrue(self.fallback.manual_only(self.org, "worker"),
                            "the control case is not movable")
            patch_frozen = mutation.pop("frozen_patch", None)
            if patch_frozen:
                node["frozen"] = {**node["frozen"], **patch_frozen}
            node.update(mutation)
            self.assertFalse(self.fallback.manual_only(self.org, "worker"),
                             f"still movable with {patch_frozen or mutation}")
            self.assertFalse(self.fallback.eligible(self.org, "worker"))
        # …and a busy node is not moved out from under its own live turn
        self._freeze(source)
        self.supervisor.state(self.slug, "worker")["busy"] = True
        self.assertFalse(self.fallback.manual_only(self.org, "worker"))
        self.supervisor.state(self.slug, "worker")["busy"] = False
        self.assertTrue(self.fallback.manual_only(self.org, "worker"))

    # ------------------------------------------------------- which rows offer
    def test_replacements_exclude_current_wrong_provider_and_signed_out(self):
        source = self._account("source")
        target = self._account("target")
        other_provider = self._account("codex", provider="openai")
        signed_out = self._account("out", auth="unauthenticated")
        self._freeze(source)
        offered = [r["id"] for r in self.fallback.replacements(self.org, "worker")]
        self.assertEqual(offered, [target["id"]])
        self.assertNotIn(source["id"], offered, "the bound account was offered")
        self.assertNotIn(other_provider["id"], offered)
        self.assertNotIn(signed_out["id"], offered)

    def test_alternatives_need_cached_capacity_for_this_exact_model(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"),
                             [target["id"]])
        # an account with nothing observed is NOT eligible: absence of
        # evidence is not evidence of capacity
        with patch.object(self.fallback, "cached_board", return_value={}):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"), [])
        # …nor is one at 100%
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board(exhausted=True)):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"), [])
        # …nor one carrying an active capacity mark for this tier
        self.registry.record_mark(target["id"], "opus", time.time() + 3600)
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"), [])

    def test_the_allowance_rule_is_the_exact_model_s_own(self):
        # a fable tier spends its OWN weekly window, so a board that only
        # establishes the standard one cannot make it eligible
        source = self._account("source")
        self._account("target")
        self._freeze(source, tier="fable", pool="fable")
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"), [])
        with patch.object(self.fallback, "cached_board", return_value=self._board(
                kinds=("session", "weekly_scoped"), model="fable")):
            self.assertEqual(len(self.fallback.alternatives(self.org, "worker")), 1)

    # ----------------------------------------------------- the payload itself
    def _tree(self, public=False):
        request = SimpleNamespace(state=SimpleNamespace(), headers={},
                                  url=SimpleNamespace(path=f"/api/orgs/{self.slug}"))
        with patch.object(self.api, "_public_slug",
                          return_value=self.slug if public else None):
            return self.api.org_tree(self.slug, request)

    def _worker(self, tree):
        def walk(nodes):
            for n in nodes:
                yield n
                yield from walk(n.get("children") or [])
        return next(n for n in walk(tree["roots"]) if n["id"] == "worker")

    def test_the_payload_offers_the_accounts_and_only_where_it_should(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(self._worker(self._tree())["continue_accounts"],
                             [target["id"]])
            # ⚠ a kiosk visitor is told nothing: this names accounts (D-145)
            self.assertEqual(
                self._worker(self._tree(public=True))["continue_accounts"], [])
            # automatic fallback on -> the scheduler owns it, no manual entry
            self.org.node("worker")["scope"]["account_fallback"] = True
            self.store.save_org(self.org)
            self.assertEqual(self._worker(self._tree())["continue_accounts"], [])

    def test_an_unfrozen_agent_costs_no_account_work_at_all(self):
        # the 6s heartbeat recomposes every node; the frozen gate is read
        # FIRST so a healthy org pays nothing (D-239)
        self._account("source")
        self._account("target")
        self.store.save_org(self.org)
        with patch.object(self.fallback, "cached_board") as board, \
             patch.object(self.fallback, "manual_only") as manual:
            self.assertEqual(self._worker(self._tree())["continue_accounts"], [])
            board.assert_not_called()
            manual.assert_not_called()

    # ------------------------------------------------------------- the action
    def _continue(self, account, board=None):
        body = self.api.ContinueOn(account=account)
        with patch.object(self.fallback, "read_board",
                          return_value=self._board() if board is None else board), \
             patch.object(self.api.hub, "changed", new=_noop_async), \
             patch.object(self.supervisor, "send_message",
                          return_value={"accepted": True}), \
             patch.object(self.supervisor, "notify"):
            return asyncio.run(self.api.node_continue_on(self.slug, "worker", body))

    def test_it_switches_the_binding_and_then_releases_the_freeze(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        order = []
        real_assign = self.supervisor.assign_account
        real_unstick = self.ledger.Org.unstick

        def assign(*a, **kw):
            order.append("switch")
            return real_assign(*a, **kw)

        def unstick(self_org, *a, **kw):
            order.append("release")
            return real_unstick(self_org, *a, **kw)

        with patch.object(self.supervisor, "assign_account", side_effect=assign), \
             patch.object(self.ledger.Org, "unstick", unstick):
            out = self._continue(target["id"])
        self.assertEqual(out["state"], "continued")
        self.assertTrue(out["switched"] and out["resumed"])
        # ⚠ THE ORDER IS THE SAFETY PROPERTY: releasing first would resume the
        # agent onto the account that just hit its wall
        self.assertEqual(order, ["switch", "release"])
        fresh = self.store.load_org(self.slug)
        self.assertEqual(fresh.node("worker")["account"], target["id"])
        self.assertNotIn("frozen", fresh.node("worker"))
        events = [e for e in fresh.d["events"] if e["op"] == "account_assign"]
        self.assertEqual(events[-1]["detail"]["via"], "manual_continue")

    def test_a_failed_switch_leaves_the_agent_frozen_and_unmoved(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        with patch.object(self.supervisor, "assign_account",
                          side_effect=RuntimeError("mid-turn")), \
             patch.object(self.ledger.Org, "unstick") as unstick:
            with self.assertRaises(self.api.HTTPException) as caught:
                self._continue(target["id"])
        self.assertEqual(caught.exception.status_code, 422)
        unstick.assert_not_called()
        fresh = self.store.load_org(self.slug)
        self.assertEqual(fresh.node("worker")["account"], source["id"])
        self.assertIn("frozen", fresh.node("worker"))

    def test_a_switch_whose_release_fails_is_reported_as_exactly_that(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        with patch.object(self.ledger.Org, "unstick",
                          side_effect=self.ledger.LedgerError("nothing to release")):
            out = self._continue(target["id"])
        # NOT a continuation and NOT a failure — the real middle state
        self.assertEqual(out["state"], "switched_not_resumed")
        self.assertTrue(out["switched"])
        self.assertFalse(out["resumed"])
        self.assertIn("STILL", out["status"])
        self.assertTrue(out["retry"].endswith("/unstick"))
        fresh = self.store.load_org(self.slug)
        self.assertEqual(fresh.node("worker")["account"], target["id"])
        self.assertIn("frozen", fresh.node("worker"))

    def test_stale_menu_capacity_is_rechecked_and_refuses_to_switch(self):
        # the menu's cache-only evidence said yes; the live read says no
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        with patch.object(self.fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(self.fallback.alternatives(self.org, "worker"),
                             [target["id"]])
        with patch.object(self.supervisor, "assign_account") as assign:
            with self.assertRaises(self.api.HTTPException) as caught:
                self._continue(target["id"], board=self._board(exhausted=True))
        self.assertEqual(caught.exception.status_code, 409)
        assign.assert_not_called()
        self.assertIn("frozen", self.store.load_org(self.slug).node("worker"))

    def test_an_account_that_was_never_offered_is_refused(self):
        source = self._account("source")
        self._account("target")
        elsewhere = self._account("codex", provider="openai")
        self._freeze(source)
        for account in (source["id"], elsewhere["id"], "no-such-account", ""):
            with patch.object(self.supervisor, "assign_account") as assign:
                with self.assertRaises(self.api.HTTPException) as caught:
                    self._continue(account)
            self.assertEqual(caught.exception.status_code, 422, account)
            assign.assert_not_called()

    def test_it_refuses_when_the_agent_is_no_longer_manually_movable(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source, fallback_on=True)      # the scheduler owns it
        with patch.object(self.supervisor, "assign_account") as assign:
            with self.assertRaises(self.api.HTTPException) as caught:
                self._continue(target["id"])
        self.assertEqual(caught.exception.status_code, 409)
        assign.assert_not_called()

    def test_a_second_activation_while_the_first_runs_changes_nothing_twice(self):
        source = self._account("source")
        target = self._account("target")
        self._freeze(source)
        lock = self.api._continue_lock(self.slug, "worker")
        lock.acquire()
        try:
            with patch.object(self.supervisor, "assign_account") as assign:
                with self.assertRaises(self.api.HTTPException) as caught:
                    self._continue(target["id"])
            self.assertEqual(caught.exception.status_code, 409)
            assign.assert_not_called()
        finally:
            lock.release()
        # …and the lock is released for the next honest attempt
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    # -------------------------------------------------------- the public wall
    def test_a_kiosk_visitor_cannot_reach_the_route_at_all(self):
        denied = self.api._public_denied(
            "POST", f"/api/orgs/{self.slug}/nodes/worker/continue-on", self.slug)
        self.assertIsNotNone(denied, "a share-token holder could move accounts")
        # the same wall /unstick sits behind, for the same reason
        self.assertEqual(
            denied[0],
            self.api._public_denied(
                "POST", f"/api/orgs/{self.slug}/nodes/worker/unstick",
                self.slug)[0])


async def _noop_async(*_a, **_kw):
    return None


if __name__ == "__main__":
    unittest.main()
