"""S4 pre-slot account gate: durable freeze from marks, equality invariant,
no-loop, and the gate-writes-nothing negative. All observables are ON-DOC
(the durable state), driven through the REAL _run_one_turn admission path —
the gate and the in-slot frozen refusal both fire before any CLI spawn, so
no provider process is ever launched here.
"""
import os
import tempfile
import unittest


class WaitGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-waitgate-")
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

    def _fixture(self, slug, until=None, provenance="observed", spend=False):
        WaitGateTests._seq += 1
        row = self.registry.create_account(
            "claude", "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"wg-{self._seq}")})
        org = self.ledger.Org.create(slug)
        org.nodes["root"] = {"state": "live", "parent": None,
                             "generation": 1, "model": "opus",
                             "account": row["id"]}
        if spend:
            org.d["spend_frozen"] = True
        self.store.save_org(org)
        if until is not None:
            import time as _t
            ok = self.registry.record_mark(
                row["id"], "opus", until=_t.time() + until,
                provenance=provenance)
            self.assertTrue(ok)
        return row

    def _drive(self, slug):
        try:
            self.supervisor._run_one_turn(slug, "root", "hello")
        except Exception:
            pass  # refusal paths raise; the assertions read the DOC

    def _frozen(self, slug):
        return (self.store.load_org(slug).node("root") or {}).get("frozen")

    def test_live_mark_freezes_durably_with_mark_horizon_and_provenance(self):
        row = self._fixture("wg-live", until=86400.0, provenance="observed")
        self._drive("wg-live")
        fz = self._frozen("wg-live")
        self.assertIsInstance(fz, dict)
        mark = self.registry.active_mark(row["id"], "opus")
        # THE EQUALITY INVARIANT: one wait, one timestamp
        self.assertEqual(fz["until_ts"], mark["until"])
        self.assertEqual(fz["provenance"], "observed")
        self.assertEqual(fz["account"], row["id"])
        self.assertEqual(fz["reset_src"], "account-mark")
        self.assertTrue(fz["limit"])

    def test_inferred_mark_carries_inferred_provenance(self):
        row = self._fixture("wg-inferred")
        import time as _t
        # a pooled limit rides onto fable as inferred; bind a fable node
        self.registry.record_mark(row["id"], "sonnet",
                                  until=_t.time() + 3600.0)
        org = self.store.load_org("wg-inferred")
        org.node("root")["model"] = "fable"
        self.store.save_org(org)
        self._drive("wg-inferred")
        fz = self._frozen("wg-inferred")
        self.assertEqual(fz["provenance"], "inferred")

    def test_no_mark_writes_no_freeze(self):
        # spend_frozen stops the turn INSIDE the slot for an unrelated
        # reason, so this proves the GATE wrote nothing (a freeze here
        # would be the gate firing without a mark)
        self._fixture("wg-none", until=None, spend=True)
        self._drive("wg-none")
        self.assertIsNone(self._frozen("wg-none"))

    def test_expired_mark_writes_no_freeze(self):
        row = self._fixture("wg-expired", spend=True)
        import time as _t
        self.registry.record_mark(row["id"], "opus", until=_t.time() + 0.05)
        _t.sleep(0.1)
        self._drive("wg-expired")
        self.assertIsNone(self._frozen("wg-expired"))

    def test_second_attempt_does_not_churn_the_freeze(self):
        # no-loop shape: an already-frozen node skips the gate (the frozen
        # check owns it) — the record is written ONCE and its horizon is
        # stable across repeated admission attempts
        self._fixture("wg-loop", until=86400.0)
        self._drive("wg-loop")
        first = dict(self._frozen("wg-loop"))
        self._drive("wg-loop")
        second = self._frozen("wg-loop")
        self.assertEqual(second["until_ts"], first["until_ts"])
        self.assertEqual(second["reset_src"], "account-mark")

    # ── THE ONE-SHOT PASS, THROUGH THE REAL ADMISSION PATH ────────────────
    # (user ruling 2026-09-12; coordinator's narrowest path; identity binding
    # from review round 4.) A wake at a conclusive 429's own stated time gets
    # ONE real attempt instead of being re-frozen on the spot by an older,
    # longer mark. `spend_frozen` stops every one of these inside the slot for
    # an unrelated reason, so a pass that WORKS still launches nothing — and
    # the freeze record is the observable either way, exactly as above.
    def _pass_fixture(self, slug, pass_, spend=True):
        row = self._fixture(slug, until=86400.0, spend=spend)
        org = self.store.load_org(slug)
        org.node("root")["admit_once"] = pass_(row)
        self.store.save_org(org)
        return row

    def _admit_once(self, slug):
        return (self.store.load_org(slug).node("root") or {}).get("admit_once")

    def test_a_bound_pass_carries_the_wake_through_the_gate(self):
        import time as _t
        self._pass_fixture("wg-pass-ok",
                           lambda row: {"at": _t.time(),
                                        "account": row["id"],
                                        "model": "opus"})
        self._drive("wg-pass-ok")
        self.assertIsNone(self._frozen("wg-pass-ok"),
                          "the live mark re-froze the wake it was owed")
        # ⚠ AND THE PASS IS STILL THERE, on purpose (round 5). `spend_frozen`
        # kills this turn inside the slot, before the provider seam — so no
        # real attempt happened and the pass is still owed one. Spending it
        # here is the bug this fixture now guards: it would leave the next
        # admission to meet the same mark with nothing.
        node = self.store.load_org("wg-pass-ok").node("root")
        self.assertTrue(self.supervisor._admit_once_valid(node),
                        "the pass was burned without a provider attempt")

    def test_a_pass_from_another_identity_does_not_open_the_gate(self):
        """Round 4: the pass is for the wall it was earned against. Rebind the
        seat, or run it on another model, and the gate is the gate again."""
        import time as _t
        for slug, pass_ in (
                ("wg-pass-acct",
                 lambda row: {"at": _t.time(), "account": "someone-else",
                              "model": "opus"}),
                ("wg-pass-model",
                 lambda row: {"at": _t.time(), "account": row["id"],
                              "model": "fable"}),
                ("wg-pass-legacy", lambda row: _t.time()),
                ("wg-pass-stale",
                 lambda row: {"at": _t.time() - 600, "account": row["id"],
                              "model": "opus"})):
            with self.subTest(slug):
                self._pass_fixture(slug, pass_)
                self._drive(slug)
                fz = self._frozen(slug)
                self.assertIsInstance(
                    fz, dict, "the account gate must still have fired")
                self.assertEqual(fz["reset_src"], "account-mark")
                # Round 5: a refused pass is no longer CLEARED here — the
                # provider seam owns clearing — and it does not need to be.
                # It can never validate again, and ADMIT_ONCE_TTL takes it out
                # of play within two minutes regardless.
                self.assertFalse(
                    self.supervisor._admit_once_valid(
                        self.store.load_org(slug).node("root")),
                    "a refused pass must never open the gate")

    def test_a_pass_survives_an_abort_before_any_provider_attempt(self):
        """⚠ ROUND 5. The gate used to CHECK AND CLEAR in one step, so a turn
        that died between the gate and a real attempt — an interrupted slot,
        the deployment or storage gates, a halt — burned the pass without ever
        reaching a provider, and the next admission met the same live mark
        with nothing to show for it. The promise the user ruled for is ONE
        REAL ATTEMPT, so the pass is spent at the provider seam instead."""
        import time as _t
        from unittest.mock import patch
        self._pass_fixture("wg-pass-abort",
                           lambda row: {"at": _t.time(),
                                        "account": row["id"],
                                        "model": "opus"})

        class InterruptedSlot:
            def __init__(self, *a, **kw):
                pass

            def __enter__(self):
                raise RuntimeError("interrupted before any provider attempt")

            def __exit__(self, *a):
                return False

        with patch.object(self.supervisor, "_InterruptibleTurnSlot",
                          InterruptedSlot):
            self._drive("wg-pass-abort")
        self.assertIsNone(self._frozen("wg-pass-abort"),
                          "the gate re-froze a node that still holds its pass")
        node = self.store.load_org("wg-pass-abort").node("root")
        self.assertTrue(self.supervisor._admit_once_valid(node),
                        "the pass was burned without a provider attempt")
        # …and the seam, when a turn does get there, spends it exactly once
        o = self.store.load_org("wg-pass-abort")
        self.assertTrue(self.supervisor._spend_admit_once(o, "root"))
        self.store.save_org(o)
        self.assertFalse(self.supervisor._spend_admit_once(
            self.store.load_org("wg-pass-abort"), "root"))

    def test_a_pass_survives_a_failure_after_the_inflight_stamp(self):
        """⚠ ROUND 6. The `inflight` stamp LOOKS like the point of no return
        and is not: the whole prompt assembly — `_envelope_state_block` and
        the rest — still runs after it and can raise, on a turn that never
        reached a provider. Spending the pass there burned it for exactly the
        reason round 5 moved it out of the gate.

        This turn is NOT `spend_frozen`, so it runs past the slot and past the
        inflight stamp, and then the envelope build fails. Popen is stubbed as
        a backstop so no provider process can start even if the seam moves."""
        import time as _t
        from unittest.mock import patch
        self._pass_fixture("wg-pass-late",
                           lambda row: {"at": _t.time(),
                                        "account": row["id"],
                                        "model": "opus"},
                           spend=False)

        def _boom(*a, **kw):
            raise RuntimeError("synthetic failure during prompt assembly")

        with patch.object(self.supervisor, "_envelope_state_block", _boom), \
                patch.object(self.supervisor.subprocess, "Popen", _boom):
            self._drive("wg-pass-late")
        node = self.store.load_org("wg-pass-late").node("root")
        self.assertTrue(
            self.supervisor._admit_once_valid(node),
            "the pass was spent on a turn that never reached a provider")

    def test_stateless_over_durable_state(self):
        # the wait re-derives from the DOC + registry alone: wipe the
        # per-process runtime state (the restart-shaped in-memory loss) and
        # the gate still refuses from durable marks
        self._fixture("wg-restart", until=86400.0)
        self._drive("wg-restart")
        self.assertIsNotNone(self._frozen("wg-restart"))
        with self.supervisor._state_lock:
            self.supervisor._state.pop(("wg-restart", "root"), None)
        # freeze survives on doc; a fresh attempt still refuses (raises
        # inside the slot) and does not clear or alter the record
        before = dict(self._frozen("wg-restart"))
        self._drive("wg-restart")
        self.assertEqual(self._frozen("wg-restart")["until_ts"],
                         before["until_ts"])


if __name__ == "__main__":
    unittest.main()
