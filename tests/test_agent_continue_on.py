"""AN AGENT CAN SWITCH A FROZEN REPORT'S ACCOUNT AND RELEASE IT TOGETHER
(user ruling 2026-09-17 21:37: "need the ability for you to switch accounts and
unstick at the same time, similar to how i can"; docket item
`agents-cannot-switch-a-frozen-report-s-account-a`).

THE PROBLEM. The user has `/continue-on <account>`, one operator action that
moves a frozen agent's binding and then releases the freeze, with a live
capacity check on the target. An agent had no equivalent and could not build
one out of the two verbs it owned:

  * `orgtree_retool account=` is REFUSED while the target carries a usage-limit
    freeze — moving the binding cannot clear a limit, and the refusal used to
    name `/continue-on`, a command no agent can run.
  * `orgtree_unstick` releases the freeze and starts a turn AT ONCE, on the
    account that just hit its wall, so the agent re-freezes within seconds.
  * Both in one message: `unstick` wins the race, and `retool` then refuses the
    now mid-turn node ("reassignment is a session boundary").

`DeadlockThisTicketRemoves` pins all three of those refusals so the fix is
measured against a reproduction rather than against a description of one.
`AgentContinueOnTests` pins the new verb.

⚠ ONE IMPLEMENTATION, TWO DOORS. The agent verb and the user's HTTP route run
the SAME helper (`api._continue_on_account`) — same gates, same order, same
live capacity read. These tests therefore pin what is DIFFERENT about the agent
door (authority, result wording, receipt class) and leave the shared rules to
tests/test_continue_frozen.py, which already measures them. The one shared
property re-asserted here is the ORDER, because it is the ticket's whole point.
"""
import copy
import datetime
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-agent-continue-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import (account_fallback, api, ledger, opreceipts, mcptool,
                     registry, store, supervisor)

REQUEST = SimpleNamespace(state=SimpleNamespace())


class _Base(unittest.TestCase):
    """A boss, a frozen report beneath it, and two registered accounts."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        account_fallback._scanned.clear()
        self.slug = "agent-continue-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "opus", 0, "boss")
        org.hire(ledger.USER, "boss", "opus", 0, "worker")
        org.hire(ledger.USER, None, "opus", 0, "stranger")   # boss's peer
        org.d["auto_resume"] = False
        store.save_org(org)
        self.org = store.load_org(self.slug)
        self.pristine = copy.deepcopy(self.org.node("worker"))
        self.source = self._account("source")
        self.target = self._account("target")

    def tearDown(self):
        store._POOL.close_all(self.slug)

    # ---------------------------------------------------------------- fixtures
    def _account(self, label, provider="claude", auth="authenticated"):
        row = registry.create_account(
            provider, label,
            {"kind": "managed", "path": os.path.join(_root.name, provider + label)})
        registry.set_auth(row["id"], auth)
        return registry.get_account(row["id"])

    def _freeze(self, *, fallback_on=False, pool="haiku+sonnet+opus"):
        self.org = store.load_org(self.slug)
        self.org.nodes["worker"] = copy.deepcopy(self.pristine)
        n = self.org.node("worker")
        n.update(model="opus", account=self.source["id"], frozen={
            "at": "2026-09-17T21:19:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": "claude",
            "account": self.source["id"], "resource_pool": pool,
            "resume_texts": ["finish the original task"]})
        n["scope"]["account_fallback"] = fallback_on
        st = supervisor.state(self.slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        store.save_org(self.org)
        return n

    def _board(self, exhausted=False):
        reset = datetime.datetime.fromtimestamp(
            time.time() + 7200, datetime.timezone.utc).isoformat()
        return {"available": True, "lane": "subscription", "limits": [
            {"kind": kind, "group": kind,
             "percent": 100 if exhausted else 10, "resets_at": reset,
             "model": None}
            for kind in ("session", "weekly_all")]}

    def node(self, nid="worker"):
        return store.load_org(self.slug).node(nid)

    def call(self, tool, args, actor="boss", **kw):
        return api.agent_call(api.AgentCall(org=self.slug, node=actor,
                                            tool=tool, args=args, **kw), REQUEST)


class DeadlockThisTicketRemoves(_Base):
    """The three refusals quoted in the docket item, reproduced."""

    def test_retool_refuses_to_rebind_a_limit_frozen_report(self):
        self._freeze()
        with self.assertRaises(api.HTTPException) as caught:
            self.call("orgtree_retool", {"node": "worker",
                                         "account": self.target["id"]})
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("frozen by a usage limit", str(caught.exception.detail))
        # nothing moved: still on the exhausted account, still frozen
        self.assertEqual(self.node()["account"], self.source["id"])
        self.assertIn("frozen", self.node())

    def test_unstick_alone_starts_a_turn_on_the_account_that_walled_it(self):
        self._freeze()
        with patch.object(supervisor, "send_message",
                          return_value={"accepted": True}) as sent, \
             patch.object(supervisor, "notify") as notified:
            out = self.call("orgtree_unstick", {"node": "worker"})
        self.assertIn("frozen", out["released"])
        # released — and driven, with the binding UNCHANGED. That is the loop:
        # the replayed turn runs on the very account that just refused it.
        self.assertEqual(self.node()["account"], self.source["id"])
        self.assertTrue(sent.called)
        self.assertIn(("turn_started",),
                      [c.args[2:] for c in notified.call_args_list])

    def test_a_rebind_after_that_unstick_queues_for_the_turn_boundary(self):
        # ⚠ CONTRACT REVERSED (user, 2026-09-20, `queue-account-rebinds-for-
        # mid-turn-agents`): this used to assert the mid-turn refusal. A valid
        # account rebind against a busy node is now ACCEPTED AS QUEUED, in
        # parity with queued model/provider switches — the active turn keeps
        # its account, and the intent is durable until the boundary applies it.
        self._freeze()
        with patch.object(supervisor, "send_message",
                          return_value={"accepted": True}), \
             patch.object(supervisor, "notify"):
            self.call("orgtree_unstick", {"node": "worker"})
        supervisor.state(self.slug, "worker")["busy"] = True
        try:
            out = self.call("orgtree_retool", {"node": "worker",
                                               "account": self.target["id"]})
        finally:
            supervisor.state(self.slug, "worker")["busy"] = False
        self.assertTrue((out.get("account_binding") or {}).get("queued"),
                        f"a valid mid-turn rebind queues, not refuses: {out}")
        fresh = self.node()
        self.assertEqual(fresh["account"], self.source["id"],
                         "the active turn keeps its account")
        self.assertEqual(fresh["pending_account"]["account"],
                         self.target["id"], "the queued intent is durable")


class AgentContinueOnTests(_Base):
    """The verb that replaces all three of the above with one call."""

    def _continue(self, account=None, actor="boss", node="worker", board=None,
                  **kw):
        args = {"node": node,
                "account": self.target["id"] if account is None else account}
        with patch.object(account_fallback, "read_board",
                          return_value=self._board() if board is None else board), \
             patch.object(supervisor, "send_message",
                          return_value={"accepted": True}) as self.sent, \
             patch.object(supervisor, "notify") as self.notified:
            return self.call("orgtree_continue_on", args, actor=actor, **kw)

    # ------------------------------------------------------- the whole point
    def test_one_call_switches_the_account_and_releases_the_freeze(self):
        self._freeze()
        order = []
        real_assign = supervisor.assign_account
        real_unstick = ledger.Org.unstick

        def assign(*a, **kw):
            order.append("switch")
            return real_assign(*a, **kw)

        def unstick(org_self, *a, **kw):
            order.append("release")
            return real_unstick(org_self, *a, **kw)

        with patch.object(supervisor, "assign_account", side_effect=assign), \
             patch.object(ledger.Org, "unstick", unstick):
            out = self._continue()
        self.assertEqual(out["state"], "continued")
        self.assertTrue(out["switched"] and out["resumed"])
        # ⚠ THE ORDER IS THE SAFETY PROPERTY: releasing first would resume the
        # agent onto the account that just hit its wall
        self.assertEqual(order, ["switch", "release"])
        fresh = self.node()
        self.assertEqual(fresh["account"], self.target["id"])
        self.assertNotIn("frozen", fresh)
        events = [e for e in store.load_org(self.slug).d["events"]
                  if e["op"] == "account_assign"]
        self.assertEqual(events[-1]["detail"]["via"], "agent_continue")

    def test_the_replayed_turn_starts_only_after_the_binding_has_moved(self):
        """Acceptance 4: no halt, and the agent lands on the NEW account first."""
        self._freeze()
        seen = []

        def record(slug, nid, *a, **kw):
            seen.append(("message", store.load_org(slug).node(nid).get("account")))
            return {"accepted": True}

        def note(slug, nid, kind, *a, **kw):
            seen.append((kind, store.load_org(slug).node(nid).get("account")))

        with patch.object(account_fallback, "read_board",
                          return_value=self._board()), \
             patch.object(supervisor, "send_message", side_effect=record), \
             patch.object(supervisor, "notify", side_effect=note):
            out = self.call("orgtree_continue_on",
                            {"node": "worker", "account": self.target["id"]})
        self.assertEqual(out["state"], "continued")
        # every wake-shaped side effect happened with the NEW binding in place
        self.assertTrue(seen, "nothing drove the released agent")
        for what, account in seen:
            self.assertEqual(account, self.target["id"], what)
        self.assertIn("turn_started", [w for w, _ in seen])
        # …and nothing halted it to get there
        self.assertFalse(self.node().get("halt"))

    def test_the_result_says_whether_the_agent_is_running_or_idle(self):
        """Acceptance 5: deterministic, in the tool's own words."""
        self._freeze()
        out = self._continue()
        self.assertEqual(out["agent"], "running")
        self.assertIn("RUNNING", out["status"])
        # the same answer for a freeze recorded differently — the resume texts
        # are what an unstick replays, and their absence is not a different
        # outcome, only a different banner
        self._freeze()
        n = store.load_org(self.slug)
        n.node("worker")["frozen"].pop("resume_texts")
        store.save_org(n)
        out = self._continue()
        self.assertEqual(out["agent"], "running")
        self.assertTrue(self.sent.called)

    def test_a_hold_the_release_cannot_clear_is_not_reported_as_running(self):
        """A freeze is not the only hold on a seat.

        `send_message` answers `{"deferred": "halted"}` for a halted node
        (tests/test_agent_halt.py pins that shape), so the replay is queued and
        no turn starts. The result must say IDLE — claiming "running" here is
        the one error the `agent` field exists to prevent.
        """
        self._freeze()
        with patch.object(account_fallback, "read_board",
                          return_value=self._board()), \
             patch.object(supervisor, "send_message",
                          return_value={"deferred": "halted"}), \
             patch.object(supervisor, "notify"):
            out = self.call("orgtree_continue_on",
                            {"node": "worker", "account": self.target["id"]})
        self.assertEqual(out["state"], "continued")   # the freeze DID go
        self.assertEqual(out["agent"], "idle")
        self.assertEqual(out["held"], "halted")
        self.assertIn("IDLE", out["status"])
        self.assertEqual(self.node()["account"], self.target["id"])

    def test_the_release_is_recorded_under_the_agent_that_made_it(self):
        self._freeze()
        self._continue()
        self.assertEqual(self.node()["unstuck"]["by"], "boss")

    def test_a_release_that_fails_is_reported_as_idle_with_a_message_owed(self):
        self._freeze()
        with patch.object(ledger.Org, "unstick",
                          side_effect=ledger.LedgerError("nothing to release")):
            out = self._continue()
        self.assertEqual(out["state"], "switched_not_resumed")
        self.assertEqual(out["agent"], "idle")
        self.assertIn("orgtree_unstick", out["retry"])
        self.assertIn("IDLE", out["status"])
        self.assertFalse(out["resumed"])
        # the honest middle state: moved, still frozen — and SAID so
        self.assertEqual(self.node()["account"], self.target["id"])
        self.assertIn("frozen", self.node())

    # --------------------------------------------------------- atomicity
    def test_a_target_with_no_capacity_refuses_and_changes_nothing(self):
        """Acceptance 2: the live read decides, not the cached bar."""
        self._freeze()
        with patch.object(account_fallback, "cached_board",
                          return_value=self._board()):
            self.assertEqual(account_fallback.alternatives(self.org, "worker"),
                             [self.target["id"]])
        with patch.object(supervisor, "assign_account") as assign:
            with self.assertRaises(api.HTTPException) as caught:
                self._continue(board=self._board(exhausted=True))
        self.assertEqual(caught.exception.status_code, 409)
        assign.assert_not_called()
        self.assertEqual(self.node()["account"], self.source["id"])
        self.assertIn("frozen", self.node())

    def test_a_failed_switch_never_releases_the_freeze(self):
        """Acceptance 3: no path leaves it released onto the old account."""
        self._freeze()
        with patch.object(supervisor, "assign_account",
                          side_effect=RuntimeError("mid-turn")), \
             patch.object(ledger.Org, "unstick") as unstick:
            with self.assertRaises(api.HTTPException) as caught:
                self._continue()
        self.assertEqual(caught.exception.status_code, 422)
        # ⚠ NAMED, not merely 422: "unknown orgtree tool" is also a 422, so a
        # code-only assertion would pass on a build without this verb at all
        self.assertIn("account switch failed", str(caught.exception.detail))
        unstick.assert_not_called()
        self.assertEqual(self.node()["account"], self.source["id"])
        self.assertIn("frozen", self.node())

    def test_an_account_that_is_not_an_alternative_is_refused(self):
        self._freeze()
        elsewhere = self._account("codex", provider="openai")
        for account in (self.source["id"], elsewhere["id"], "nope", ""):
            with patch.object(supervisor, "assign_account") as assign:
                with self.assertRaises(api.HTTPException) as caught:
                    self._continue(account=account)
            self.assertEqual(caught.exception.status_code, 422, account)
            self.assertIn("is not an alternative account",
                          str(caught.exception.detail), account)
            assign.assert_not_called()

    def test_a_node_the_scheduler_owns_is_refused(self):
        self._freeze(fallback_on=True)      # automatic fallback is on
        with patch.object(supervisor, "assign_account") as assign:
            with self.assertRaises(api.HTTPException) as caught:
                self._continue()
        self.assertEqual(caught.exception.status_code, 409)
        assign.assert_not_called()

    def test_one_move_at_a_time_per_node(self):
        self._freeze()
        lock = api._continue_lock(self.slug, "worker")
        lock.acquire()
        try:
            with patch.object(supervisor, "assign_account") as assign:
                with self.assertRaises(api.HTTPException) as caught:
                    self._continue()
            self.assertEqual(caught.exception.status_code, 409)
            assign.assert_not_called()
        finally:
            lock.release()
        self.assertTrue(lock.acquire(blocking=False))
        lock.release()

    # --------------------------------------------------------- authority
    def test_authority_is_downward_only(self):
        """Acceptance 6: self, peers and superiors are refused."""
        for actor, target in (("boss", "boss"),        # itself
                              ("worker", "boss"),      # its superior
                              ("stranger", "worker"),  # not in its subtree
                              ("worker", "stranger")):
            self._freeze()
            # the SUBJECT of the refusal must be frozen either way, so a pass
            # can never come from "there was nothing to move"
            with patch.object(supervisor, "assign_account") as assign:
                with self.assertRaises(api.HTTPException) as caught:
                    self._continue(actor=actor, node=target)
            self.assertIn(caught.exception.status_code, (403, 422),
                          f"{actor} -> {target}")
            # the refusal must be ABOUT authority — a 422 for an unknown verb
            # would otherwise satisfy every case here
            self.assertRegex(str(caught.exception.detail),
                             "authority is downward only|your own account",
                             f"{actor} -> {target}")
            assign.assert_not_called()
        # …and the one relationship that IS allowed still works
        self._freeze()
        self.assertEqual(self._continue(actor="boss", node="worker")["state"],
                         "continued")

    # ------------------------------------------------- catalogue + receipts
    def test_the_verb_is_offered_and_its_receipt_class_is_honest(self):
        names = {t["name"] for t in mcptool.TOOLS}
        self.assertIn("orgtree_continue_on", names)
        self.assertIn("orgtree_continue_on", mcptool.MANAGED_WAIT_TOOLS)
        # PRE: the switch is already durable before the receipt is written, so
        # a missing receipt may NOT be reported as "nothing happened"
        self.assertEqual(opreceipts.coverage("orgtree_continue_on", {}),
                         opreceipts.PRE)
        self.assertFalse(opreceipts.provable_absence(
            opreceipts.coverage("orgtree_continue_on", {})))

    def test_a_replayed_key_does_not_move_the_account_twice(self):
        self._freeze()
        epoch = self.call(opreceipts.OP_EPOCH, {})["epoch"]
        args = {"tool": "orgtree_continue_on",
                "args": {"node": "worker", "account": self.target["id"]},
                "op_key": opreceipts.mint_key(), "op_epoch": epoch}
        with patch.object(account_fallback, "read_board",
                          return_value=self._board()), \
             patch.object(supervisor, "send_message",
                          return_value={"accepted": True}), \
             patch.object(supervisor, "notify"):
            first = self.call(opreceipts.OP_CALL, args)
            self.assertEqual(first["state"], "continued")
            with patch.object(supervisor, "assign_account") as assign:
                again = self.call(opreceipts.OP_CALL, args)
        self.assertTrue(again["replayed"])
        assign.assert_not_called()
        self.assertEqual(again["receipt"]["result"]["agent"], "running")

    # ------------------------------------------- the refusal that misdirected
    def test_the_retool_refusal_now_names_a_verb_the_agent_can_call(self):
        """Acceptance 7."""
        self._freeze()
        with self.assertRaises(api.HTTPException) as caught:
            self.call("orgtree_retool", {"node": "worker",
                                         "account": self.target["id"]})
        detail = str(caught.exception.detail)
        self.assertIn("orgtree_continue_on", detail)
        self.assertNotIn("/continue-on", detail)
        # …and the USER's door still names the user's command
        with self.assertRaises(RuntimeError) as raised:
            supervisor.assign_account(self.slug, "worker", self.target["id"],
                                      actor=ledger.USER)
        self.assertIn("/continue-on", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
