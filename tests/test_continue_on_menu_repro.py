"""REPRODUCTION — `Continue on <account>` is absent for every frozen agent
(docket `restore-continue-on-in-agent-context-menus`).

THE REPORT. An agent frozen on an exhausted provider account offers no
`Continue on` entry in its context menu, so the operator cannot move it to an
account that has room. The hand workaround observed in this org's own log on
2026-09-19 (09:11:19Z → 09:13:27Z, five agents) was
``halt → unstick → set_scope → account_assign(claude-4) → unhalt`` — the manual
action performed in the UNSAFE order (release before switch) that
``api._continue_on_account``'s docstring exists to prevent.

HISTORY. This file first REPRODUCED that state: six assertions showing the
action absent end to end on unmodified `main` (preserved in git at the commit
before the fix). It now guards the FIX, and keeps the measurement that made the
diagnosis — `capacity`, the automatic path's rule, still refuses the very board
the manual path now accepts — so the two tests below that pass cannot pass by
the fixture having drifted into something easy.

WHAT WAS WRONG. The renderer is not at fault: it builds one entry
per id in ``node["continue_accounts"]``, and both surfaces pass the handler. The
list is empty because ``account_fallback.available()`` — through its inner
``clear()`` — calls a usage window "no room" when

  (a) its ``resets_at`` is missing or unparseable, or
  (b) its ``is_active`` flag is set,

whatever percentage the window actually reports. The Claude readout observed on
the affected machine carries a ``session`` window with NO ``resets_at`` on every
signed-in account, and on the account that had room that window is ALSO
``is_active`` at 0% used. Either condition alone is enough, so no Claude account
can qualify and the list is empty for every agent.

⚠ THE BOARD SHAPE HERE IS THE MEASURED ONE, not an invention. It is the shape
``limits.snapshot_for_key('acct:<id>')`` returned for the two signed-in Claude
accounts at 2026-09-19T09:14:43Z, read off the agent turn envelope that
``turnusage`` renders from that exact call.

⚠ AND THE MENU WAS NOT THE ONLY VICTIM. ``api._continue_on_account`` re-decides
eligibility with the SAME predicate against a forced live read, so the action
would have refused the move even if the entry had been shown by hand. Both
gates are asserted below, because a fix to either one alone delivers nothing.

THE FIX (docket ruling recorded on the item): the MANUAL path asks whether the
account is POSITIVELY known to be full — ``account_fallback.offered`` /
``offerable`` / ``exhausted`` — while the AUTOMATIC scheduler keeps ``capacity``
unchanged, because it moves agents with nobody watching and must prove room
first. What still refuses the operator is asserted here too: a window actually
reported at 100%, a capacity mark this org recorded, and an agent whose owner
opted into automatic moves.
"""
import asyncio
import copy
import datetime
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-continue-menu-repro-")
os.environ["ORGTREE_DATA"] = _ROOT

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import (account_fallback, api, ledger,  # noqa: E402
                                    registry, store, supervisor)

if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
    raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")


def _iso(epoch: float) -> str:
    return datetime.datetime.fromtimestamp(
        epoch, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class ContinueOnMenuRepro(unittest.TestCase):
    """The affected state, reproduced end to end from a real hire."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        account_fallback._scanned.clear()
        self.slug = "continue-menu-repro"
        self.org = ledger.Org.create(self.slug)
        # a REAL hire: the tree projection reads fields only the ledger mints
        self.org.hire(ledger.USER, None, "opus", 0, "worker")
        self.org.d["auto_resume"] = False
        self.pristine = copy.deepcopy(self.org.node("worker"))

    # ---------------------------------------------------------------- helpers
    def _account(self, label, provider="claude", auth="authenticated"):
        row = registry.create_account(
            provider, label,
            {"kind": "managed", "path": os.path.join(_ROOT, provider + label)})
        registry.set_auth(row["id"], auth)
        return registry.get_account(row["id"])

    def _freeze(self, source_id, *, tier="opus", fallback_on=False):
        """A usage-limit freeze of exactly the shape the claude lane writes.

        `source_id` is `accounts.PRIMARY` for the UNBOUND agents the report
        describes (`supervisor` line 20543 writes `accounts.PRIMARY` into
        `frozen["account"]` on the subscription lane), or a registry id for a
        bound one. Both are exercised, because the defect must be shown to be
        the board rather than the binding.
        """
        self.org.nodes["worker"] = copy.deepcopy(self.pristine)
        n = self.org.node("worker")
        bound = None if source_id == "primary" else source_id
        n.update(model=tier, frozen={
            "at": "2026-09-19T09:00:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": "claude",
            "account": source_id, "resource_pool": "haiku+sonnet+opus",
            "resume_texts": ["finish the original task"]})
        if bound is None:
            n.pop("account", None)
        else:
            n["account"] = bound
        n["scope"]["account_fallback"] = fallback_on
        st = supervisor.state(self.slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        store.save_org(self.org)
        return n

    def _observed_board(self, *, session_reset=False, session_active=True,
                        weekly_percent=0.0):
        """The measured claude readout: a `session` window with no reset stamp
        and the active flag set, beside a healthy `weekly_all`."""
        return {"available": True, "lane": "subscription", "limits": [
            {"kind": "session", "group": "session", "percent": 0.0,
             "severity": "normal",
             "resets_at": _iso(time.time() + 3600) if session_reset else None,
             "is_active": session_active, "model": None},
            {"kind": "weekly_all", "group": "weekly_all",
             "percent": weekly_percent, "severity": "normal",
             "resets_at": _iso(time.time() + 604800),
             "is_active": False, "model": None},
        ]}

    def _tree(self):
        request = SimpleNamespace(state=SimpleNamespace(), headers={},
                                  url=SimpleNamespace(path=f"/api/orgs/{self.slug}"))
        with patch.object(api, "_public_slug", return_value=None):
            tree = api.org_tree(self.slug, request)

        def walk(nodes):
            for n in nodes:
                yield n
                yield from walk(n.get("children") or [])
        return next(n for n in walk(tree["roots"]) if n["id"] == "worker")

    # ------------------------------------------------------- the reproduction
    def test_the_freeze_itself_is_movable_so_the_menu_should_be_offered(self):
        """The precondition holds: nothing about the agent disqualifies it.

        Without this the reproduction below would be indistinguishable from
        "the menu is correctly hidden for an agent that cannot be moved".
        """
        for source in ("primary", self._account("source")["id"]):
            self._account(f"target-{source}")
            self._freeze(source)
            self.assertTrue(account_fallback.movable(self.org, "worker"), source)
            self.assertTrue(account_fallback.manual_only(self.org, "worker"), source)

    def test_the_target_account_is_identity_eligible(self):
        """…and a signed-in same-provider account is a candidate on identity.

        `replacements` is the identity half of the question and it ANSWERS —
        so whatever empties the offered list is the capacity half.
        """
        target = self._account("target")
        self._freeze("primary")
        offered = [r["id"] for r in account_fallback.replacements(self.org, "worker")]
        self.assertEqual(offered, [target["id"]])

    def test_the_strict_rule_still_rejects_the_measured_board(self):
        """⭐ THE DEFECT ITSELF, kept as a live measurement rather than a
        memory: on the board that reproduces the report, the account has 0%
        used on every window and `capacity` — the AUTOMATIC path's rule — still
        judges it to have none. That is why the list the menu reads was empty.

        This assertion is what makes the two below meaningful: it shows they
        pass because the manual path asks a different question, not because the
        fixture drifted into something easy.
        """
        target = self._account("target")
        for source in ("primary", self._account("source")["id"]):
            self._freeze(source)
            with patch.object(account_fallback, "cached_board",
                              return_value=self._observed_board()):
                self.assertEqual(
                    account_fallback.alternatives(self.org, "worker"), [],
                    f"{target['id']} passed the strict rule for {source}")

    def test_each_disqualifier_fires_on_its_own_under_the_strict_rule(self):
        """Two independent causes, either enough on its own.

        (a) no `resets_at` on the session window, active flag cleared;
        (b) the active flag alone, with a perfectly good reset stamp.
        """
        self._account("target")
        self._freeze("primary")
        for label, board in (
                ("missing resets_at", self._observed_board(session_active=False)),
                ("is_active", self._observed_board(session_reset=True))):
            with patch.object(account_fallback, "cached_board", return_value=board):
                self.assertEqual(
                    account_fallback.alternatives(self.org, "worker"), [], label)
        # …and with BOTH cleared the same account passes even the strict rule,
        # which is what makes the two assertions above measurements rather than
        # tautologies about a fixture nothing could ever satisfy
        with patch.object(account_fallback, "cached_board", return_value=
                          self._observed_board(session_reset=True,
                                               session_active=False)):
            self.assertEqual(len(account_fallback.alternatives(self.org, "worker")), 1)

    def test_the_payload_the_menu_reads_now_names_the_account(self):
        """⭐ THE FIX, at the surface that was reported broken.

        `agentMenuEntries` emits one `Continue on <id>` entry per id in this
        list (canvas/agentmenu.tsx:160), so a non-empty list here IS the menu
        entry — for the unbound agent the report describes and for a bound one.
        """
        target = self._account("target")
        source = self._account("source")
        # an UNBOUND agent is on the ambient profile, so the registered
        # `source` row is an alternative for it too — only the account a node
        # is actually bound to drops out. Both cases are named exactly.
        for src, expect in (("primary", [target["id"], source["id"]]),
                            (source["id"], [target["id"]])):
            self._freeze(src)
            with patch.object(account_fallback, "cached_board",
                              return_value=self._observed_board()):
                node = self._tree()
            self.assertEqual(node["continue_accounts"], expect, src)
            # the agent IS frozen and live in that same payload
            self.assertTrue(node.get("frozen"))
            self.assertEqual(node["state"], "live")

    def test_the_action_now_switches_and_releases_on_the_measured_board(self):
        """⭐ …and the action accepts it, so the operator's click completes.

        The order is still the safety property — switch, then release — and the
        agent ends up on the new account with its freeze gone.
        """
        target = self._account("target")
        self._freeze("primary")
        body = api.ContinueOn(account=target["id"])
        order: list[str] = []
        real_assign = supervisor.assign_account
        real_unstick = ledger.Org.unstick

        def assign(*a, **kw):
            order.append("switch")
            return real_assign(*a, **kw)

        def unstick(self_org, *a, **kw):
            order.append("release")
            return real_unstick(self_org, *a, **kw)

        with patch.object(account_fallback, "read_board",
                          return_value=self._observed_board()), \
             patch.object(supervisor, "assign_account", side_effect=assign), \
             patch.object(ledger.Org, "unstick", unstick), \
             patch.object(supervisor, "send_message",
                          return_value={"accepted": True}), \
             patch.object(supervisor, "notify"), \
             patch.object(api.hub, "changed", new=_noop_async):
            out = asyncio.run(api.node_continue_on(self.slug, "worker", body))
        self.assertEqual(out["state"], "continued")
        self.assertEqual(order, ["switch", "release"])
        fresh = store.load_org(self.slug)
        self.assertEqual(fresh.node("worker")["account"], target["id"])
        self.assertNotIn("frozen", fresh.node("worker"))

    # ------------------------------------------------ what stays unavailable
    def test_an_account_reported_full_is_neither_offered_nor_accepted(self):
        """The one thing that must still refuse: POSITIVE evidence of a wall.

        Both halves, because the menu and the action are separate gates and a
        fix that opened one of them would be worse than the defect.
        """
        target = self._account("target")
        self._freeze("primary")
        full = self._observed_board(weekly_percent=100.0)
        with patch.object(account_fallback, "cached_board", return_value=full):
            self.assertEqual(account_fallback.offered(self.org, "worker"), [])
            self.assertEqual(self._tree()["continue_accounts"], [])
        with patch.object(account_fallback, "read_board", return_value=full), \
             patch.object(supervisor, "assign_account") as assign, \
             patch.object(api.hub, "changed", new=_noop_async):
            with self.assertRaises(api.HTTPException) as caught:
                asyncio.run(api.node_continue_on(
                    self.slug, "worker", api.ContinueOn(account=target["id"])))
        self.assertEqual(caught.exception.status_code, 409)
        assign.assert_not_called()
        fresh = store.load_org(self.slug)
        self.assertIsNone(fresh.node("worker").get("account"))
        self.assertIn("frozen", fresh.node("worker"))

    def test_a_recorded_wall_on_the_account_still_hides_it(self):
        """…and so does this org's own capacity mark, which is evidence the
        board may not carry yet. The mark is honoured by both rules, so the
        manual path never walks past a wall the automatic path recorded."""
        target = self._account("target")
        self._freeze("primary")
        registry.record_mark(target["id"], "opus", time.time() + 3600)
        with patch.object(account_fallback, "cached_board",
                          return_value=self._observed_board()):
            self.assertEqual(account_fallback.offered(self.org, "worker"), [])
            self.assertEqual(self._tree()["continue_accounts"], [])

    def test_the_rule_itself_honours_the_mark_not_only_its_caller(self):
        """⚠ ASSERTED ON `offerable` DIRECTLY, and a mutation run is why.

        `alternatives` screens marked rows before it ever calls the rule, so a
        `offerable` that had quietly stopped checking `marked` passed every
        test that went through the list — the mutation survived. It is a public
        predicate and the two are NOT redundant: the caller screens on the
        combined pool string, this screens each pool choice on its own, which
        for a Codex `reserve+plan` freeze is a different question.
        """
        row = self._account("marked-row")
        board = self._observed_board()
        self.assertTrue(account_fallback.offerable(row, board, "opus",
                                                   "haiku+sonnet+opus"))
        registry.record_mark(row["id"], "opus", time.time() + 3600)
        self.assertFalse(account_fallback.offerable(row, board, "opus",
                                                    "haiku+sonnet+opus"))
        # …and the mark is consulted PER POOL, not as "has this row ever been
        # marked": an untouched row on the same board is still offered, and so
        # is one whose only wall belongs to a different pool
        clean = self._account("clean-row")
        self.assertTrue(account_fallback.offerable(clean, board, "opus",
                                                   "haiku+sonnet+opus"))
        registry.record_mark(clean["id"], "fable", time.time() + 3600)
        self.assertTrue(account_fallback.offerable(clean, board, "opus",
                                                   "haiku+sonnet+opus"))
        self.assertFalse(account_fallback.offerable(clean, board, "fable",
                                                    "fable"))

    def test_a_reading_that_failed_is_not_evidence_of_a_wall(self):
        """A board that errored, and one nobody has ever fetched, say NOTHING.

        This is the exact conflation that caused the defect, so it is asserted
        in its own right rather than left implied: `available: False` is "no
        reading", which is neither zero nor full, and turning it into "full"
        would rebuild the bug behind a new name.
        """
        target = self._account("target")
        self._freeze("primary")
        for label, board in (
                ("errored", {**self._observed_board(), "error": "read failed"}),
                ("never fetched", {"available": False, "limits": [],
                                   "observed_at": None, "age": None,
                                   "stale": False}),
                ("no limits key", {"available": True, "lane": "subscription"})):
            with patch.object(account_fallback, "cached_board", return_value=board):
                self.assertEqual(account_fallback.offered(self.org, "worker"),
                                 [target["id"]], label)
        # …and an ERRORED board that ALSO reports a full window is still a
        # wall: the percentage is evidence whatever else failed beside it
        broken_and_full = {**self._observed_board(weekly_percent=100.0),
                           "error": "read failed"}
        with patch.object(account_fallback, "cached_board",
                          return_value=broken_and_full):
            self.assertEqual(account_fallback.offered(self.org, "worker"),
                             [target["id"]],
                             "an errored board is not read for evidence at all")

    def test_a_window_belonging_to_another_model_does_not_hide_the_account(self):
        """A full Fable-scoped pool says nothing about an opus agent, and the
        reverse. `lane_applies` is what keeps the two apart, on this rule as on
        the strict one."""
        target = self._account("target")
        self._freeze("primary")                       # opus
        board = self._observed_board(session_reset=True, session_active=False)
        board["limits"].append(
            {"kind": "weekly_scoped", "group": "weekly_scoped", "percent": 100.0,
             "severity": "normal", "resets_at": _iso(time.time() + 604800),
             "is_active": True, "model": "Claude Fable 5"})
        with patch.object(account_fallback, "cached_board", return_value=board):
            self.assertEqual(account_fallback.offered(self.org, "worker"),
                             [target["id"]])
        # the control: make the FULL window the one that describes this agent
        # and the account disappears, so the assertion above is a filter
        # working rather than a percentage being ignored
        board["limits"][1]["percent"] = 100.0          # weekly_all
        with patch.object(account_fallback, "cached_board", return_value=board):
            self.assertEqual(account_fallback.offered(self.org, "worker"), [])

    def test_a_codex_pool_is_judged_on_its_own_windows(self):
        """The same rule for the other provider: a full PLAN window hides an
        account for a plan-pool freeze and says nothing about a reserve one."""
        source = self._account("codex-source", provider="openai")
        target = self._account("codex-target", provider="openai")
        self.org.nodes["worker"] = copy.deepcopy(self.pristine)
        n = self.org.node("worker")
        n.update(model="astra", account=source["id"], frozen={
            "at": "2026-09-19T09:00:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": "openai",
            "account": source["id"], "resource_pool": "plan",
            "resume_texts": ["finish the original task"]})
        n["scope"]["account_fallback"] = False
        supervisor.state(self.slug, "worker").update(
            busy=False, responding=False, queue=[])
        store.save_org(self.org)
        self.assertTrue(account_fallback.manual_only(self.org, "worker"))
        full_plan = {"available": True, "lane": "subscription", "limits": [
            {"kind": "provider_window", "group": "codex", "percent": 100.0,
             "severity": "normal", "resets_at": _iso(time.time() + 3600),
             "is_active": True, "model": None}]}
        with patch.object(account_fallback, "cached_board", return_value=full_plan):
            self.assertEqual(account_fallback.offered(self.org, "worker"), [])
        # the SAME full window is no evidence at all about the reserve pool —
        # a different bucket, so the account is offered for a reserve freeze
        n["frozen"]["resource_pool"] = "reserve"
        store.save_org(self.org)
        with patch.object(account_fallback, "cached_board", return_value=full_plan):
            self.assertEqual(account_fallback.offered(self.org, "worker"),
                             [target["id"]])
        # …and a board describing some OTHER lane describes no pool of this
        # account's at all, so it is no evidence either. A mutation run caught
        # this branch being unguarded: turning that `return False` into `True`
        # hid every codex account whose readout was not a subscription one.
        n["frozen"]["resource_pool"] = "plan"
        store.save_org(self.org)
        with patch.object(account_fallback, "cached_board",
                          return_value={**full_plan, "lane": "apikey"}):
            self.assertEqual(account_fallback.offered(self.org, "worker"),
                             [target["id"]])

    def test_automatic_fallback_still_owns_an_opted_in_agent(self):
        """An agent whose operator asked for automatic moves offers no manual
        entry — two mechanisms must not race for one binding. Unchanged by this
        fix, asserted here because it is the gate the menu leans on."""
        self._account("target")
        self._freeze("primary", fallback_on=True)
        with patch.object(account_fallback, "cached_board",
                          return_value=self._observed_board()):
            self.assertEqual(self._tree()["continue_accounts"], [])

    def test_the_automatic_scheduler_s_own_rule_is_untouched(self):
        """⭐ THE BLAST RADIUS. `capacity` is what the background scheduler
        moves agents on, unasked, and this fix must not have widened it: on the
        measured board it still refuses, and `eligible` — the scheduler's gate
        — still refuses with it."""
        target = self._account("target")
        self._freeze("primary", fallback_on=True)
        board = self._observed_board()
        self.assertFalse(account_fallback.capacity(target, board, "opus",
                                                   "haiku+sonnet+opus"))
        self.assertFalse(account_fallback.available(board, "claude", "opus",
                                                    "opus", time.time()))
        # the freeze itself IS the scheduler's to move — so the refusal above
        # is the capacity rule talking, not the freeze gate
        self.assertTrue(account_fallback.eligible(self.org, "worker"))
        with patch.object(account_fallback, "read_board", return_value=board):
            self.assertEqual(account_fallback.candidates(self.org), {})


async def _noop_async(*_a, **_kw):
    return None


if __name__ == "__main__":
    unittest.main()
