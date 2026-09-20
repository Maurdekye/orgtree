"""Fix verification for the switch-reliability ticket
(`make-model-provider-and-account-switching-on-liv`). Separate from the
reproduction suite so a shared fixture can never mask a regression.

Covered here:
- D: the queued-switch drop at the turn boundary (an account that no longer
  validates) now emits a lifecycle.switch_dropped EVENT to the requester and
  the live superior, not just a log row — matching ledger.apply_pending_switch,
  so "a queued switch is never silently forgotten" holds on every drop path,
  including the one the multi-account feature introduced.
- A: the frozen-node rebind policy (coordinator ruling 2026-09-16, build (a)).
  A bare rebind on a MOVABLE usage-limit freeze is REFUSED and leaves the agent
  EXACTLY as it was; a bare rebind on an AUTH/CREDENTIAL freeze succeeds and
  thaws; recovery paths (allow_frozen) bypass the refusal.
- B: the phantom-wake drop. A crossing that clears a stale freeze now (1)
  preserves the freeze's replay record as the node's `switch_resume` marker
  instead of destroying it with the pop, and (2) wakes the node with REAL
  carriers — the old mail_ping shape was dropped whenever the mailbox was
  empty, leaving the node live, unfrozen and idle with its interrupted work
  discarded.
- E: the "context is intact" narration. A same-provider switch no longer
  claims blanket context intactness (the prompt cache is namespaced per model
  and per account, and an account move on a session-boundary lane archives the
  session outright); the archive case mints lifecycle.session_rebound, which
  warns that retained context is replay, not turns that ran.
- R1 (queued-rebind review, 2026-09-20): a queued account rebind and a queued
  model switch are composed BY REQUEST ORDER at the boundary. An older rebind
  never overwrites a newer explicit model/account choice, a rebind that rides
  a switch is validated against the switch TARGET, and the door refuses a
  rebind that cannot run an already-queued switch target.
- R2 (same review): a queued STANDALONE rebind applied at the boundary keeps
  `assign_account`'s frozen-node policy — an auth/credential freeze is thawed
  in the same transaction and woken exactly once after persistence; a movable
  usage-limit freeze turns the rebind into a recorded drop, never a strand.
- R1a (re-review, 2026-09-20): the composition order is the ACCEPTANCE order —
  a durable per-node sequence both queue writers allocate under DOC_LOCK —
  never the wall clock. Two acceptances inside one millisecond, or a clock
  stepping backwards between them, must not reverse newest-valid-wins; records
  from a pre-seq build fall back to the documented stamp rule (tie keeps the
  switch's complete choice).
- R1b (same re-review): the account door validates a busy-queue rebind against
  the EFFECTIVE destination — the queued switch target when one exists — so
  the reverse cross-provider order composes instead of being refused against
  the current model; naming the CURRENT account remains the explicit
  cancellation whatever the queued destination.
- R2 continuation (same re-review): an account change carried BY the queued
  switch keeps the standalone rebind's auth recovery on the FINAL binding —
  same-provider composed changes thaw the dead credential's freeze in the
  same transaction with exactly ONE wake after persistence; a crossing keeps
  its single ledger-side clear/wake, and usage-limit holds stay untouched.
"""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

# ONE data root for the whole module, bound BEFORE the first import — store
# binds DATA_ROOT at import time, so every class in this module must share the
# same root (each module already runs in its own process). supervisor prints
# switch outcomes with non-ASCII (→); the packaged engine runs utf-8 stdout,
# but a dev cp1252 console would crash on it.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-switch-fix-")
os.environ["ORGTREE_DATA"] = _ROOT

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import ledger, registry, store, supervisor  # noqa: E402
if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
    raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")


class BoundarySwitchDropIsAnnounced(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _ROOT
        cls.ledger = ledger
        cls.store = store
        cls.supervisor = supervisor

    def _org_with_boss_and_worker(self, slug):
        org = self.ledger.Org.create(slug)
        # a live node named as the REQUESTER so the drop event has a real
        # recipient — the ledger's own switch_dropped audience is
        # {requester, parent} filtered to live nodes, and a top-level node
        # requested by USER (not a node) has neither. Both are top-level hires
        # (a subordinate hire demands full explicit scope we do not need here);
        # naming `boss` as the pending switch's `by` is what puts it in scope.
        org.hire(self.ledger.USER, None, "opus", 0, "boss")
        org.hire(self.ledger.USER, None, "opus", 0, "worker")
        return org

    def test_boundary_drop_emits_switch_dropped_event(self):
        slug = "fix-drop-event"
        org = self._org_with_boss_and_worker(slug)
        node = org.node("worker")
        # a BOUND node (a real-looking claude account id) with a queued
        # CROSS-PROVIDER switch that carries NO account — exactly the shape
        # check_switch_account refuses at the boundary ("queued before this
        # feature, or against a binding that appeared meanwhile").
        node["account"] = "claude-acct-x"
        node["pending_switch"] = {"tier": "astra", "from": "opus",
                                  "by": "boss", "crossing": True,
                                  "at": "2026-09-16T00:00:00Z"}

        changed = self.supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=[])
        self.assertTrue(changed, "the drop is a recorded change, not a no-op")

        # the switch did NOT land: the node stays whole on its old tier …
        self.assertEqual(org.node("worker")["model"], "opus")
        self.assertNotIn("pending_switch", org.node("worker"))

        # … and the drop is ANNOUNCED to the live superior, not merely logged
        rows = [r for r in org.d.get("notice_log", [])
                if r.get("node") == "boss" and "DROPPED" in str(r.get("text"))]
        self.assertEqual(len(rows), 1,
                         "the boundary drop must emit lifecycle.switch_dropped "
                         "to the live superior (parity with the ledger drop)")
        self.assertIn("astra", rows[0]["text"])
        self.assertIn("worker", rows[0]["text"])

        # the node itself is never notified of its own dropped switch
        self.assertEqual(
            [r for r in org.d.get("notice_log", [])
             if r.get("node") == "worker" and "DROPPED" in str(r.get("text"))],
            [])

        # the audit log row is still there too — the event is ADDED, not a swap
        logs = [e for e in org.d["events"]
                if e.get("op") == "switch_queue_dropped"]
        self.assertEqual(len(logs), 1)

    def test_a_valid_queued_switch_is_not_dropped(self):
        # control: a SAME-provider queued switch needs no account, so the
        # boundary applies it and emits no drop.
        slug = "fix-no-drop"
        org = self._org_with_boss_and_worker(slug)
        org.node("worker")["pending_switch"] = {
            "tier": "sonnet", "from": "opus", "by": "boss",
            "crossing": False, "at": "2026-09-16T00:00:00Z"}
        self.supervisor._apply_pending_switch_locked(org, slug, "worker", wake=[])
        self.assertEqual(org.node("worker")["model"], "sonnet")
        self.assertNotIn("pending_switch", org.node("worker"))
        dropped = [r for r in org.d.get("notice_log", [])
                   if "DROPPED" in str(r.get("text"))]
        self.assertEqual(dropped, [])


class FrozenRebindPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _ROOT
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label):
        FrozenRebindPolicy._seq += 1
        row = self.registry.create_account(
            "claude", label,
            {"kind": "managed",
             "path": os.path.join(self.root, f"claude-{label}-{self._seq}")})
        self.registry.set_auth(row["id"], "authenticated")
        return self.registry.get_account(row["id"])

    def _frozen_org(self, slug, source, frozen):
        org = self.ledger.Org.create(slug)
        org.hire(self.ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["frozen"] = frozen
        st = self.supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        self.store.save_org(org)
        return org

    def test_bare_rebind_on_usage_limit_freeze_refuses_and_changes_nothing(self):
        source, target = self._account("source"), self._account("target")
        slug = "policy-refuse"
        frozen = {"at": "2026-09-14T00:00:00Z", "limit": True,
                  "account": source["id"], "resume_texts": ["resume the task"]}
        org = self._frozen_org(slug, source, frozen)
        before_sid = org.node("worker")["session_id"]

        with self.assertRaises(RuntimeError) as ctx:
            self.supervisor.assign_account(slug, "worker", target["id"],
                                           actor=self.supervisor.USER)
        # the refusal names the supported recovery path — and WHICH one
        # depends on who asked (2026-09-17): the user's command for the user,
        # the agent verb for an agent, because pointing an agent at a slash
        # command it cannot run is what made it halt its own report instead
        self.assertIn("/continue-on", str(ctx.exception))

        # NOTHING half-applied: same account, same freeze, same session
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], source["id"])
        self.assertEqual(fresh.get("frozen"), frozen)
        self.assertEqual(fresh["session_id"], before_sid)

    def test_bare_rebind_on_auth_freeze_succeeds_and_thaws(self):
        source, target = self._account("source"), self._account("target")
        slug = "policy-auth-thaw"
        frozen = {"at": "2026-09-14T00:00:00Z", "cause": "auth",
                  "account": source["id"], "resume_texts": ["resume the task"]}
        self._frozen_org(slug, source, frozen)

        with patch.object(self.supervisor, "send_message") as send:
            disclosure = self.supervisor.assign_account(
                slug, "worker", target["id"], actor="USER")

        self.assertTrue(disclosure.get("auth_thawed"))
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], target["id"], "the rebind applied")
        self.assertNotIn("frozen", fresh, "the auth freeze was thawed")
        # the node was woken so it can actually run again
        send.assert_called()

    def test_untrusted_credential_freeze_also_thaws(self):
        # a rejected credential can present as `untrusted` rather than a
        # cause string — it is still the auth kind and rebinding is its fix
        source, target = self._account("source"), self._account("target")
        slug = "policy-untrusted"
        self._frozen_org(slug, source, {"at": "2026-09-14T00:00:00Z",
                                        "untrusted": True,
                                        "account": source["id"]})
        with patch.object(self.supervisor, "send_message"):
            out = self.supervisor.assign_account(slug, "worker", target["id"],
                                                 actor="USER")
        self.assertTrue(out.get("auth_thawed"))
        self.assertNotIn("frozen", self.store.load_org(slug).node("worker"))

    def test_recovery_path_may_rebind_a_usage_limit_freeze(self):
        # allow_frozen=True is the /continue-on and auto-fallback opt-in: the
        # refusal does not apply, and the freeze is NOT auto-thawed here (the
        # recovery path releases it separately, in its own save window)
        source, target = self._account("source"), self._account("target")
        slug = "policy-recovery"
        frozen = {"at": "2026-09-14T00:00:00Z", "limit": True,
                  "account": source["id"], "resume_texts": ["resume the task"]}
        self._frozen_org(slug, source, frozen)
        out = self.supervisor.assign_account(slug, "worker", target["id"],
                                             actor="USER", allow_frozen=True)
        self.assertEqual(out["account"], target["id"])
        self.assertFalse(out.get("auth_thawed"))
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], target["id"])
        self.assertIn("frozen", fresh, "recovery path leaves the freeze for its "
                                       "own release step")


class SwitchThawPreservesReplay(unittest.TestCase):
    """B: the crossing freeze-clear keeps the interrupted work and the wake
    actually starts a turn."""

    def test_crossing_pop_stashes_replay_and_drive_delivers_it(self):
        slug = "b-replay-preserved"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["frozen"] = {"at": "2026-09-14T00:00:00Z", "limit": True,
                       "provider": "claude", "resource_pool": "haiku+sonnet+opus",
                       "resume_texts": ["finish the original task"],
                       "resume_views": ["finish the original task (view)"]}
        store.save_org(org)

        r = org.switch_model(ledger.USER, "worker", "sol", busy=False)
        self.assertEqual(r.get("resume_stale_freeze"), ["worker"])
        # the replay record survived the pop, durably on the node
        marker = org.node("worker").get("switch_resume")
        self.assertEqual(marker, {"texts": ["finish the original task"],
                                  "views": ["finish the original task (view)"]})
        store.save_org(org)

        with patch.object(supervisor, "send_message") as send:
            supervisor.drive_unfrozen_by_switch(slug, ["worker"])
        # first the accurate wake, then the replayed work — and NONE of it as
        # a droppable mail_ping (an empty mailbox is the normal state here)
        sent = [(c.args, c.kwargs) for c in send.call_args_list]
        self.assertEqual(len(sent), 2)
        self.assertIn("freeze", sent[0][0][2])
        self.assertFalse(sent[0][1].get("mail_ping"))
        self.assertEqual(sent[1][0][2], "finish the original task")
        self.assertFalse(sent[1][1].get("mail_ping"))
        # the marker was consumed, so a second drive cannot double-replay
        self.assertNotIn("switch_resume", store.load_org(slug).node("worker"))

    def test_wake_starts_a_turn_on_an_empty_mailbox(self):
        # the phantom-wake regression: an idle, unfrozen node with an EMPTY
        # mailbox must still get a real turn out of the wake — the old ping
        # shape was dropped at the carrier gate before the turn ever ran
        slug = "b-no-phantom"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        st = supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        store.save_org(org)

        with patch.object(supervisor, "_start_turn_worker") as start:
            supervisor.drive_unfrozen_by_switch(slug, ["worker"])
        start.assert_called_once()
        carrier = start.call_args.args[2]
        self.assertFalse(supervisor._carrier_is_ping(carrier),
                         "the wake must be a real carrier, not a droppable "
                         "mail pointer")


class SessionReboundNarration(unittest.TestCase):
    """E: honest continuity narration on non-crossed switches."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label):
        SessionReboundNarration._seq += 1
        row = registry.create_account(
            "openai", label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"openai-{label}-{self._seq}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def test_same_provider_account_move_mints_session_rebound(self):
        a1, a2 = self._account("one"), self._account("two")
        slug = "e-rebound-event"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "astra", 0, "worker")
        n = org.node("worker")
        n["account"] = a1["id"]
        # a session that actually RAN — the archive branch, not the
        # unrun-uuid one
        n.pop("session_unrun", None)
        old_sid = n["session_id"]

        supervisor.finish_switch_binding(org, slug, "worker", a2["id"], "USER")

        fresh = org.node("worker")
        self.assertEqual(fresh["account"], a2["id"])
        self.assertNotEqual(fresh["session_id"], old_sid,
                            "the account move archived the session")
        rows = org.d.get("notices", {}).get("worker", [])
        rebound = [r for r in rows if "REPLAY" in str(r.get("text", ""))]
        self.assertTrue(rebound,
                        "the archive must be narrated: retained context is "
                        "replay, not turns that ran")
        self.assertIn("account move", rebound[-1]["text"])

    def test_google_account_move_via_switch_takes_a_session_boundary(self):
        # C: finish_switch_binding used to be openai-only, so a Gemini
        # account move riding a model switch took NO session boundary —
        # diverging from assign_account, the one writer, which archives on
        # openai|google alike. Google forbids secondary selection outright,
        # so the reachable move is bound → primary.
        slug = "e-google-boundary"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "pro", 0, "worker")
        n = org.node("worker")
        n["account"] = "google-legacy-binding"
        n.pop("session_unrun", None)   # a session that actually RAN
        old_sid = n["session_id"]

        out = supervisor.finish_switch_binding(org, slug, "worker",
                                               "primary", "USER")

        fresh = org.node("worker")
        self.assertNotIn("account", fresh)
        self.assertTrue(fresh.get("account_primary"))
        self.assertNotEqual(fresh["session_id"], old_sid,
                            "a google account move is a session boundary, "
                            "same as assign_account")
        self.assertFalse(out.get("unparked"))

    def test_switch_account_choice_clears_account_park(self):
        # C: SH-2 parity — a real account landing WITH the switch clears an
        # account park in the same transaction, exactly as assign_account does
        a1 = self._account("parked-target")
        slug = "e-switch-unpark"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "astra", 0, "worker")
        n = org.node("worker")
        n["account"] = "missing:openai"
        n["frozen"] = {"at": "2026-09-14T00:00:00Z", "limit": True,
                       "cause": "account"}

        out = supervisor.finish_switch_binding(org, slug, "worker",
                                               a1["id"], "USER")

        self.assertTrue(out.get("unparked"))
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], a1["id"])
        self.assertNotIn("frozen", fresh)


class DurableInflightGuardsRebind(unittest.TestCase):
    """F: the seat's durable inflight marker refuses a bare rebind — the
    in-memory busy gate dies with the process, the marker does not."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    def _account(self, label):
        row = registry.create_account(
            "claude", label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"claude-inflight-{label}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def test_rebind_queues_on_a_recorded_inflight_turn(self):
        source, target = self._account("src"), self._account("tgt")
        slug = "f-inflight-refuse"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["inflight"] = {"at": "2026-09-16T00:00:00Z", "text": "mid-turn work"}
        st = supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])   # process died
        store.save_org(org)

        out = supervisor.assign_account(slug, "worker", target["id"],
                                        actor="USER")
        self.assertTrue(out["queued"])
        self.assertEqual(out["pending_account"], target["id"])
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], source["id"], "active turn unchanged")
        self.assertEqual(fresh["pending_account"]["account"], target["id"])
        self.assertIn("inflight", fresh)

    def test_queued_rebind_replaces_and_current_account_cancels(self):
        source, first, second = (self._account("src3"), self._account("tgt3"),
                                 self._account("tgt4"))
        slug = "f-inflight-replace"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["inflight"] = {"at": "2026-09-16T00:00:00Z", "text": "work"}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                  queue=[])
        store.save_org(org)
        supervisor.assign_account(slug, "worker", first["id"], actor="USER")
        out = supervisor.assign_account(slug, "worker", second["id"], actor="USER")
        self.assertTrue(out["queued"])
        self.assertEqual(out["replaced"], first["id"])
        out = supervisor.assign_account(slug, "worker", source["id"], actor="USER")
        self.assertFalse(out["queued"])
        self.assertEqual(out["cancelled"], second["id"])
        self.assertNotIn("pending_account", store.load_org(slug).node("worker"))

    def test_queued_rebind_applies_through_the_boundary_writer(self):
        source, target = self._account("src5"), self._account("tgt5")
        slug = "f-inflight-apply"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["inflight"] = {"at": "2026-09-16T00:00:00Z", "text": "work"}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                  queue=[])
        store.save_org(org)
        supervisor.assign_account(slug, "worker", target["id"], actor="USER")
        with store.DOC_LOCK:
            live = store.load_org(slug)
            live.node("worker").pop("inflight", None)
            changed = supervisor._apply_pending_switch_locked(live, slug,
                                                               "worker")
            self.assertTrue(changed)
            self.assertEqual(live.node("worker")["account"], target["id"])
            self.assertNotIn("pending_account", live.node("worker"))
            store.save_org(live)

    def test_invalid_rebind_does_not_replace_a_valid_queue(self):
        source, target = self._account("src6"), self._account("tgt6")
        slug = "f-inflight-invalid"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["inflight"] = {"at": "2026-09-16T00:00:00Z", "text": "work"}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                  queue=[])
        store.save_org(org)
        supervisor.assign_account(slug, "worker", target["id"], actor="USER")
        with self.assertRaises(Exception):
            supervisor.assign_account(slug, "worker", "not-an-account",
                                      actor="USER")
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], source["id"])
        self.assertEqual(fresh["pending_account"]["account"], target["id"])

    def test_recovery_path_still_proceeds_over_a_stale_marker(self):
        # allow_frozen (what /continue-on and auto-fallback pass) owns the
        # release and the replay, so the marker must not wall the recovery
        source, target = self._account("src2"), self._account("tgt2")
        slug = "f-inflight-recovery"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["inflight"] = {"at": "2026-09-16T00:00:00Z", "text": "mid-turn work"}
        st = supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        store.save_org(org)

        out = supervisor.assign_account(slug, "worker", target["id"],
                                        actor="USER", allow_frozen=True)
        self.assertEqual(store.load_org(slug).node("worker")["account"],
                         target["id"])
        self.assertEqual(out["previous_account"], source["id"])

class NonCrossedNarrationHonesty(unittest.TestCase):
    """E: the same-provider switch notice no longer claims blanket context
    intactness."""

    def test_non_crossed_switch_narration_is_honest_about_the_cache(self):
        org = ledger.Org.create("e-narration")
        org.hire(ledger.USER, None, "opus", 0, "worker")
        from engine.backend.orgtree import events
        ev = ledger._mint(
            "lifecycle.model_switched", ledger.actor_of("USER"),
            org.node_ref("worker"), node="worker", relation="self",
            old="opus", new="sonnet", seat_old=5.0, seat_new=2.0, by="USER",
            queued=False, crossed=False, old_provider=None, new_provider=None,
            predecessor=None)
        text = events.render_agent(ev)
        self.assertNotIn("context is intact", text)
        self.assertIn("cache namespace", text)
        self.assertIn("local restart", text)


class BoundaryAccountSwitchComposition(unittest.TestCase):
    """R1: the queued rebind and the queued switch compose by REQUEST ORDER,
    validated against the switch TARGET — never by which door wrote first."""

    T1 = "2026-09-20T00:00:01.000Z"
    T2 = "2026-09-20T00:00:02.000Z"

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, provider, label):
        BoundaryAccountSwitchComposition._seq += 1
        row = registry.create_account(
            provider, label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"{provider}-{label}-{self._seq}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def _worker(self, slug, source_id, grant=10):
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", grant, "worker")
        org.node("worker")["account"] = source_id
        return org

    def _events(self, org, op):
        return [e for e in org.d["events"] if e.get("op") == op]

    def test_older_rebind_rides_a_newer_accountless_switch(self):
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        org = self._worker("r1-merge", src["id"])
        n = org.node("worker")
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1}
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T2, "crossing": False}
        supervisor._apply_pending_switch_locked(org, "r1-merge", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], b["id"],
                         "the rebind account rides the switch's atomic finish")
        self.assertNotIn("pending_account", fresh)
        self.assertNotIn("pending_switch", fresh)
        self.assertEqual(len(self._events(org, "account_queue_into_switch")), 1)
        self.assertEqual(self._events(org, "account_queue_dropped"), [])

    def test_newer_switch_with_account_supersedes_older_rebind(self):
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        org = self._worker("r1-supersede", src["id"])
        n = org.node("worker")
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1}
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T2, "crossing": False,
                               "account": c["id"]}
        supervisor._apply_pending_switch_locked(org, "r1-supersede", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], c["id"],
                         "the newer explicit model/account choice wins")
        drops = self._events(org, "account_queue_dropped")
        self.assertEqual(len(drops), 1)
        self.assertEqual(drops[0]["detail"].get("superseded_by_switch"),
                         "sonnet")

    def test_older_claude_rebind_never_breaks_a_newer_cross_provider_switch(self):
        # the review's exact reproduction: the older Claude rebind used to
        # overwrite the OpenAI account and take the whole Astra switch down
        # with a provider mismatch
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        d = self._account("openai", "d")
        org = self._worker("r1-crossing", src["id"])
        n = org.node("worker")
        n.pop("session_unrun", None)
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1}
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T2, "crossing": True,
                               "account": d["id"]}
        supervisor._apply_pending_switch_locked(org, "r1-crossing", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "astra", "the later switch applied")
        self.assertEqual(fresh["account"], d["id"],
                         "on ITS OWN OpenAI account, not the older rebind's")
        self.assertEqual(self._events(org, "switch_queue_dropped"), [],
                         "the cross-provider switch must not be dropped")
        self.assertEqual(len(self._events(org, "account_queue_dropped")), 1)

    def test_newer_rebind_overrides_the_queued_switch_account(self):
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        org = self._worker("r1-override", src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "account": c["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T2}
        supervisor._apply_pending_switch_locked(org, "r1-override", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], b["id"],
                         "the newer rebind is the newest account intent")
        merged = self._events(org, "account_queue_into_switch")
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["detail"].get("replaced"), c["id"])

    def test_newer_incompatible_rebind_drops_and_the_switch_proceeds(self):
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        d = self._account("openai", "d")
        org = self._worker("r1-incompatible", src["id"])
        n = org.node("worker")
        n.pop("session_unrun", None)
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": True,
                               "account": d["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T2}
        supervisor._apply_pending_switch_locked(org, "r1-incompatible",
                                                "worker", wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "astra")
        self.assertEqual(fresh["account"], d["id"],
                         "the valid queued switch is not disturbed")
        drops = self._events(org, "account_queue_dropped")
        self.assertEqual(len(drops), 1)
        self.assertIn("cannot run the queued switch target astra",
                      drops[0]["detail"]["reason"])

    def test_door_refuses_a_rebind_incompatible_with_the_queued_switch(self):
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        d = self._account("openai", "d")
        slug = "r1-door"
        org = self._worker(slug, src["id"])
        n = org.node("worker")
        n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": True,
                               "account": d["id"]}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                queue=[])
        store.save_org(org)
        with self.assertRaises(RuntimeError) as ctx:
            supervisor.assign_account(slug, "worker", b["id"], actor="USER")
        self.assertIn("queued switch", str(ctx.exception))
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], src["id"], "active binding untouched")
        self.assertNotIn("pending_account", fresh)
        self.assertEqual(fresh["pending_switch"]["account"], d["id"],
                         "the already-valid queued switch is untouched")

    # ------------------------------------------------------------- R1a
    def test_equal_stamps_do_not_reverse_acceptance_order(self):
        # the re-review's exact reproduction: switch accepted FIRST, rebind
        # accepted SECOND, both stamped the same millisecond — the rebind is
        # the newer intent and must win, not read as "superseded by the later
        # switch"
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        org = self._worker("r1a-tie", src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "seq": 1, "account": c["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1, "seq": 2}
        supervisor._apply_pending_switch_locked(org, "r1a-tie", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], b["id"],
                         "acceptance order decides, not the equal stamps")
        self.assertEqual(self._events(org, "account_queue_dropped"), [])
        self.assertEqual(len(self._events(org, "account_queue_into_switch")), 1)

    def test_clock_rollback_does_not_reverse_acceptance_order(self):
        # same shape with the wall clock stepping BACKWARDS between the two
        # acceptances: the rebind's stamp is older than the switch's, and the
        # sequence still names it the newer intent
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        org = self._worker("r1a-rollback", src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T2, "crossing": False,
                               "seq": 1, "account": c["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1, "seq": 2}
        supervisor._apply_pending_switch_locked(org, "r1a-rollback", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], b["id"],
                         "a rolled-back clock cannot demote the later acceptance")
        self.assertEqual(self._events(org, "account_queue_dropped"), [])

    def test_legacy_ties_use_stamps_but_a_sequenced_record_beats_legacy(self):
        # BOTH-legacy is the one genuinely ambiguous pair (round 3): neither
        # record carries an acceptance number, so the documented old stamp
        # rule applies — tie keeps the switch's own complete choice.
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        org = self._worker("r1a-legacy", src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "account": c["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1}
        supervisor._apply_pending_switch_locked(org, "r1a-legacy", "worker",
                                                wake=[])
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], c["id"],
                         "legacy tie keeps the switch's complete choice")
        drops = self._events(org, "account_queue_dropped")
        self.assertEqual(len(drops), 1)
        # A MIXED pair's order is KNOWN (round 3, R1a-upgrade): a sequenced
        # record was accepted by a post-upgrade writer and a record without
        # one predates the upgrade — stamps must not overrule that, in
        # EITHER direction, whatever they claim.
        org2 = self._worker("r1a-mixed-rebind", src["id"])
        n2 = org2.node("worker")
        n2["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                                "at": self.T2, "crossing": False,
                                "account": c["id"]}
        n2["pending_account"] = {"account": b["id"], "from": src["id"],
                                 "by": "USER", "at": self.T1, "seq": 1}
        supervisor._apply_pending_switch_locked(org2, "r1a-mixed-rebind",
                                                "worker", wake=[])
        self.assertEqual(org2.node("worker")["account"], b["id"],
                         "the sequenced rebind is the post-upgrade acceptance")
        org3 = self._worker("r1a-mixed-switch", src["id"])
        n3 = org3.node("worker")
        n3["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                                "at": self.T1, "crossing": False,
                                "seq": 1, "account": c["id"]}
        n3["pending_account"] = {"account": b["id"], "from": src["id"],
                                 "by": "USER", "at": self.T2}
        supervisor._apply_pending_switch_locked(org3, "r1a-mixed-switch",
                                                "worker", wake=[])
        self.assertEqual(org3.node("worker")["account"], c["id"],
                         "the sequenced switch is the post-upgrade acceptance")
        self.assertEqual(len(self._events(org3, "account_queue_dropped")), 1)

    def test_writers_sequence_a_legacy_counterpart_before_their_own(self):
        # R1a-upgrade, through the REAL doors: a record persisted by a
        # pre-seq build is ordered FIRST by whichever writer runs next, so
        # the pair leaves the door fully sequenced even when the new
        # acceptance arrives under a rolled-back clock.
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        # direction 1: legacy SWITCH, then the account door accepts a rebind
        slug = "r1a-upg-rebind"
        org = self._worker(slug, src["id"])
        n = org.node("worker")
        n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T2, "crossing": False,
                               "account": c["id"]}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                queue=[])
        store.save_org(org)
        with patch.object(supervisor, "now_iso", return_value=self.T1):
            out = supervisor.assign_account(slug, "worker", b["id"],
                                            actor="USER")
        self.assertTrue(out.get("queued"))
        o2 = store.load_org(slug)
        n2 = o2.node("worker")
        self.assertEqual(n2["pending_switch"].get("seq"), 1,
                         "the earlier legacy acceptance is ordered first")
        self.assertEqual(n2["pending_account"].get("seq"), 2)
        supervisor._apply_pending_switch_locked(o2, slug, "worker", wake=[])
        self.assertEqual(o2.node("worker")["account"], b["id"],
                         "the door-accepted rebind wins despite its older stamp")
        # direction 2: legacy REBIND, then the ledger switch door accepts
        slug2 = "r1a-upg-switch"
        org2 = self._worker(slug2, src["id"])
        n3 = org2.node("worker")
        n3["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        n3["pending_account"] = {"account": b["id"], "from": src["id"],
                                 "by": "USER", "at": self.T2}
        store.save_org(org2)
        with patch.object(ledger, "now", return_value=self.T1):
            with store.DOC_LOCK:
                o3 = store.load_org(slug2)
                r = o3.switch_model(ledger.USER, "worker", "sonnet",
                                    account=c["id"])
                store.save_org(o3)
        self.assertTrue(r.get("queued"))
        o4 = store.load_org(slug2)
        n4 = o4.node("worker")
        self.assertEqual(n4["pending_account"].get("seq"), 1)
        self.assertEqual(n4["pending_switch"].get("seq"), 2)
        supervisor._apply_pending_switch_locked(o4, slug2, "worker", wake=[])
        fresh = o4.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], c["id"],
                         "the newer switch's complete choice supersedes")
        self.assertEqual(len(self._events(o4, "account_queue_dropped")), 1)

    def test_real_writers_stamp_acceptance_order_immune_to_the_clock(self):
        # the re-review's probe, through the ACTUAL doors: freeze the wall
        # clock so both acceptances stamp the same millisecond, then roll it
        # backwards for the second acceptance — the boundary outcome follows
        # the acceptance order either way
        for label, sw_clock, reb_clock in (("tie", self.T1, self.T1),
                                           ("rollback", self.T2, self.T1)):
            with self.subTest(case=label):
                src = self._account("claude", f"src-{label}")
                b = self._account("claude", f"b-{label}")
                c = self._account("claude", f"c-{label}")
                slug = f"r1a-doors-{label}"
                org = self._worker(slug, src["id"])
                n = org.node("worker")
                n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
                supervisor.state(slug, "worker").update(
                    busy=False, responding=False, queue=[])
                store.save_org(org)
                with patch.object(ledger, "now", return_value=sw_clock):
                    with store.DOC_LOCK:
                        o2 = store.load_org(slug)
                        r = o2.switch_model(ledger.USER, "worker", "sonnet",
                                            account=c["id"])
                        store.save_org(o2)
                self.assertTrue(r.get("queued"))
                with patch.object(supervisor, "now_iso",
                                  return_value=reb_clock):
                    out = supervisor.assign_account(slug, "worker", b["id"],
                                                    actor="USER")
                self.assertTrue(out.get("queued"))
                o3 = store.load_org(slug)
                n3 = o3.node("worker")
                self.assertEqual(n3["pending_switch"].get("seq"), 1,
                                 "first acceptance under the lock")
                self.assertEqual(n3["pending_account"].get("seq"), 2,
                                 "second acceptance under the lock")
                supervisor._apply_pending_switch_locked(o3, slug, "worker",
                                                        wake=[])
                fresh = o3.node("worker")
                self.assertEqual(fresh["model"], "sonnet")
                self.assertEqual(fresh["account"], b["id"],
                                 "the later-accepted rebind wins under a "
                                 "tied or rolled-back clock")

    # ------------------------------------------------------------- R1b
    def test_door_accepts_a_rebind_for_the_queued_destination_provider(self):
        # the re-review's exact reproduction, reverse request order: with the
        # Astra switch already queued, an OpenAI account is valid for the
        # node's EFFECTIVE destination and used to be refused against the
        # CURRENT Claude tier before the target check could run
        src = self._account("claude", "src")
        d = self._account("openai", "d")
        e = self._account("openai", "e")
        slug = "r1b-reverse"
        org = self._worker(slug, src["id"])
        n = org.node("worker")
        n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                queue=[])
        store.save_org(org)
        # queue the switch through the REAL ledger door, so both acceptance
        # sequences come from the actual writers
        with store.DOC_LOCK:
            o1 = store.load_org(slug)
            r = o1.switch_model(ledger.USER, "worker", "astra",
                                account=d["id"])
            store.save_org(o1)
        self.assertTrue(r.get("queued"))
        out = supervisor.assign_account(slug, "worker", e["id"], actor="USER")
        self.assertTrue(out.get("queued"),
                        "accepted as queued for the effective destination")
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], src["id"], "active binding untouched")
        self.assertEqual(fresh["pending_account"]["account"], e["id"])
        self.assertEqual(fresh["pending_switch"]["account"], d["id"],
                         "the queued switch record itself is untouched")
        # and the boundary composes the pair: the newer rebind rides the
        # switch to its OpenAI destination
        o2 = store.load_org(slug)
        o2.node("worker").pop("session_unrun", None)
        supervisor._apply_pending_switch_locked(o2, slug, "worker", wake=[])
        landed = o2.node("worker")
        self.assertEqual(landed["model"], "astra")
        self.assertEqual(landed["account"], e["id"])

    def test_primary_rebind_for_the_destination_is_not_a_cancellation(self):
        # round 3, R1b-primary, the review's exact case: a node running on
        # its CURRENT provider's ambient has previous == "", and the
        # destination's ambient also resolves to id "" — the two are
        # different accounts on different providers, and comparing bare ids
        # turned the explicit openai/primary request into a false
        # cancellation that let the switch keep its own account.
        d = self._account("openai", "d")
        for selector in ("openai/primary", "primary"):
            with self.subTest(selector=selector):
                slug = f"r1b-ambient-{selector.replace('/', '-')}"
                org = ledger.Org.create(slug)
                org.hire(ledger.USER, None, "opus", 10, "worker")
                n = org.node("worker")   # UNBOUND: the claude ambient
                n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
                n["config_seq"] = 1
                n["pending_switch"] = {"tier": "astra", "from": "opus",
                                       "by": "USER", "at": self.T1,
                                       "crossing": True, "seq": 1,
                                       "account": d["id"]}
                supervisor.state(slug, "worker").update(
                    busy=False, responding=False, queue=[])
                store.save_org(org)
                out = supervisor.assign_account(slug, "worker", selector,
                                                actor="USER")
                self.assertTrue(out.get("queued"),
                                "the destination's ambient is a DIFFERENT "
                                "account, never the current-account cancel")
                self.assertNotIn("cancelled", out)
                o2 = store.load_org(slug)
                n2 = o2.node("worker")
                self.assertEqual(n2["pending_account"]["account"],
                                 "openai/primary",
                                 "stored QUALIFIED so the choice keeps its provider")
                self.assertNotIn("account", n2, "active binding untouched")
                # and the boundary lands the switch on the ambient the user
                # named, not on the switch's own earlier account choice
                n2.pop("session_unrun", None)
                supervisor._apply_pending_switch_locked(o2, slug, "worker",
                                                        wake=[])
                landed = o2.node("worker")
                self.assertEqual(landed["model"], "astra")
                self.assertNotIn("account", landed,
                                 "ambient binding: no registry account bound")
                self.assertTrue(landed.get("account_primary"))

    def test_current_ambient_still_cancels_a_queued_rebind(self):
        # POSITIVE CONTROL for the identity fix: naming the node's ACTUAL
        # current ambient — claude/primary on a claude tier — is still the
        # explicit cancellation of a queued rebind, judged on the current
        # binding even under a queued crossing.
        d = self._account("openai", "d")
        e = self._account("openai", "e")
        slug = "r1b-ambient-cancel"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 10, "worker")
        n = org.node("worker")   # UNBOUND: the claude ambient
        n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        n["config_seq"] = 2
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": True,
                               "seq": 1, "account": d["id"]}
        n["pending_account"] = {"account": e["id"], "from": "primary",
                                "by": "USER", "at": self.T1, "seq": 2}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                queue=[])
        store.save_org(org)
        out = supervisor.assign_account(slug, "worker", "claude/primary",
                                        actor="USER")
        self.assertFalse(out.get("queued"))
        self.assertEqual(out.get("cancelled"), e["id"])
        fresh = store.load_org(slug).node("worker")
        self.assertNotIn("pending_account", fresh)
        self.assertNotIn("account", fresh, "binding untouched")
        self.assertEqual(fresh["pending_switch"]["account"], d["id"],
                         "cancellation touches nothing but the rebind queue")

    def test_door_current_account_cancellation_survives_a_queued_crossing(self):
        # naming the account the node is bound to RIGHT NOW is the explicit
        # cancellation of the queued rebind — judged on the current binding
        # even though that account cannot run the queued destination
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        d = self._account("openai", "d")
        slug = "r1b-cancel"
        org = self._worker(slug, src["id"])
        n = org.node("worker")
        n["inflight"] = {"at": "2026-09-20T00:00:00Z", "text": "work"}
        n["config_seq"] = 2     # the two hand-written records' allocations
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": True,
                               "seq": 1, "account": d["id"]}
        n["pending_account"] = {"account": b["id"], "from": src["id"],
                                "by": "USER", "at": self.T1, "seq": 2}
        supervisor.state(slug, "worker").update(busy=False, responding=False,
                                                queue=[])
        store.save_org(org)
        out = supervisor.assign_account(slug, "worker", src["id"],
                                        actor="USER")
        self.assertFalse(out.get("queued"))
        self.assertEqual(out.get("cancelled"), b["id"])
        fresh = store.load_org(slug).node("worker")
        self.assertNotIn("pending_account", fresh)
        self.assertEqual(fresh["account"], src["id"])
        self.assertEqual(fresh["pending_switch"]["account"], d["id"],
                         "cancellation touches nothing but the rebind queue")


class BoundaryRebindFreezeParity(unittest.TestCase):
    """R2: the boundary apply of a standalone queued rebind keeps
    `assign_account`'s frozen-node policy, and its wake fires exactly once,
    after persistence."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label):
        BoundaryRebindFreezeParity._seq += 1
        row = registry.create_account(
            "claude", label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"claude-r2-{label}-{self._seq}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def test_boundary_rebind_thaws_an_auth_freeze_and_reports_the_wake(self):
        src, tgt = self._account("src"), self._account("tgt")
        org = ledger.Org.create("r2-thaw")
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = src["id"]
        n["frozen"] = {"at": "2026-09-20T00:00:00Z", "cause": "auth",
                       "account": src["id"]}
        n["pending_account"] = {"account": tgt["id"], "from": src["id"],
                                "by": "USER", "at": "2026-09-20T00:00:01.000Z"}
        wake, account_wake = [], []
        supervisor._apply_pending_switch_locked(
            org, "r2-thaw", "worker", wake=wake, account_wake=account_wake)
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], tgt["id"], "the rebind applied")
        self.assertNotIn("frozen", fresh, "the auth freeze was thawed")
        self.assertEqual(account_wake, [("auth_thaw", "worker")],
                         "the caller is told to wake the node after its save")
        self.assertEqual(wake, [])
        logs = [e for e in org.d["events"] if e.get("op") == "account_assign"
                and e.get("detail", {}).get("via") == "queued_retool"]
        self.assertEqual(len(logs), 1)
        self.assertTrue(logs[0]["detail"].get("auth_thawed"))

    def test_boundary_rebind_on_a_usage_limit_freeze_is_a_recorded_drop(self):
        src, tgt = self._account("src"), self._account("tgt")
        org = ledger.Org.create("r2-limit")
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = src["id"]
        frozen = {"at": "2026-09-20T00:00:00Z", "limit": True,
                  "account": src["id"], "resume_texts": ["resume"]}
        n["frozen"] = frozen
        n["pending_account"] = {"account": tgt["id"], "from": src["id"],
                                "by": "USER", "at": "2026-09-20T00:00:01.000Z"}
        account_wake = []
        supervisor._apply_pending_switch_locked(
            org, "r2-limit", "worker", wake=[], account_wake=account_wake)
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], src["id"],
                         "a bare rebind cannot clear a usage limit — parity "
                         "with the immediate door's refusal")
        self.assertEqual(fresh.get("frozen"), frozen, "freeze untouched")
        self.assertNotIn("pending_account", fresh, "intent consumed exactly once")
        self.assertEqual(account_wake, [])
        drops = [e for e in org.d["events"]
                 if e.get("op") == "account_queue_dropped"]
        self.assertEqual(len(drops), 1)
        self.assertIn("usage limit", drops[0]["detail"]["reason"])

    def test_startup_reconcile_wakes_a_thawed_rebind_exactly_once(self):
        src, tgt = self._account("src"), self._account("tgt")
        slug = "r2-reconcile"
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = src["id"]
        n["frozen"] = {"at": "2026-09-20T00:00:00Z", "cause": "auth",
                       "account": src["id"]}
        n["pending_account"] = {"account": tgt["id"], "from": src["id"],
                                "by": "USER", "at": "2026-09-20T00:00:01.000Z"}
        store.save_org(org)
        with patch.object(supervisor, "drive_auth_thaw") as thaw, \
                patch.object(supervisor, "drive_account_unpark") as unpark, \
                patch.object(supervisor, "drive_unfrozen_by_switch") as sw, \
                patch.object(supervisor, "send_message") as send:
            supervisor.reconcile(slug)
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], tgt["id"])
        self.assertNotIn("frozen", fresh)
        self.assertNotIn("pending_account", fresh)
        thaw.assert_called_once_with(slug, "worker")
        unpark.assert_not_called()
        sw.assert_not_called()
        # no generic restart revive doubles the thaw wake for this node
        self.assertEqual([c for c in send.call_args_list
                          if c.args[:2] == (slug, "worker")], [],
                         "the thaw wake is the ONE drive this node gets")


class BoundaryComposedAuthRecovery(unittest.TestCase):
    """R2 continuation (re-review 2026-09-20): an account change carried BY
    the queued switch keeps the standalone rebind's auth recovery on the
    FINAL resolved binding — with exactly one wake after persistence, no
    duplicate against the crossing's own ledger-side clear, and usage-limit
    holds untouched."""

    T1 = "2026-09-20T00:00:01.000Z"
    T2 = "2026-09-20T00:00:02.000Z"

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, provider, label):
        BoundaryComposedAuthRecovery._seq += 1
        row = registry.create_account(
            provider, label,
            {"kind": "managed",
             "path": os.path.join(_ROOT, f"{provider}-r2c-{label}-{self._seq}")})
        registry.set_auth(row["id"], "authenticated")
        return registry.get_account(row["id"])

    def _frozen_worker(self, slug, src_id, cause="auth"):
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "opus", 10, "worker")
        n = org.node("worker")
        n["account"] = src_id
        fz = {"at": "2026-09-20T00:00:00.500Z", "account": src_id,
              "text": "fixture replay"}
        if cause == "limit":
            fz["limit"] = True
        else:
            fz["cause"] = cause
            fz["limit"] = True  # the probe's exact shape: cause wins over flag
        n["frozen"] = fz
        return org

    def test_composed_rebind_thaws_the_auth_freeze_exactly_once(self):
        # the re-review's exact reproduction: Opus/A frozen for auth, queued
        # Sonnet/B (same provider), newer rebind to C — the boundary landed
        # Sonnet/C but left A's dead-credential freeze standing with no wake
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        slug = "r2c-thaw"
        org = self._frozen_worker(slug, src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "seq": 1, "account": b["id"]}
        n["pending_account"] = {"account": c["id"], "from": src["id"],
                                "by": "USER", "at": self.T2, "seq": 2}
        wake, account_wake = [], []
        supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=wake, account_wake=account_wake)
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], c["id"])
        self.assertNotIn("frozen", fresh,
                         "the dead credential's freeze thawed with the landing")
        self.assertEqual(wake, [], "no crossing — no ledger-side clear")
        self.assertEqual(account_wake, [("auth_thaw", "worker")],
                         "exactly one wake, driven after the caller's save")
        rows = [e for e in org.d["events"] if e.get("op") == "account_assign"
                and e.get("detail", {}).get("via") == "queued_switch"]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["detail"].get("auth_thawed"))
        # a REPEATED boundary call finds both queues consumed: no change, no
        # second recovery, no second wake
        wake2, account_wake2 = [], []
        again = supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=wake2, account_wake=account_wake2)
        self.assertFalse(again)
        self.assertEqual((wake2, account_wake2), ([], []))

    def test_composed_crossing_wakes_via_the_switch_clear_not_twice(self):
        # CONTROL for the one-wake contract: a CROSSING pops the stale freeze
        # on the ledger side and reports it in `resume_stale_freeze` — the
        # composed recovery must see nothing left to thaw and add no second
        # wake for the same node
        src = self._account("claude", "src")
        d = self._account("openai", "d")
        e = self._account("openai", "e")
        slug = "r2c-crossing"
        org = self._frozen_worker(slug, src["id"])
        n = org.node("worker")
        n.pop("session_unrun", None)
        n["pending_switch"] = {"tier": "astra", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": True,
                               "seq": 1, "account": d["id"]}
        n["pending_account"] = {"account": e["id"], "from": src["id"],
                                "by": "USER", "at": self.T2, "seq": 2}
        wake, account_wake = [], []
        supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=wake, account_wake=account_wake)
        fresh = org.node("worker")
        self.assertEqual(fresh["model"], "astra")
        self.assertEqual(fresh["account"], e["id"])
        self.assertNotIn("frozen", fresh)
        self.assertEqual(wake, ["worker"],
                         "the crossing's own clear reports the wake")
        self.assertEqual(account_wake, [],
                         "and the composed recovery adds no second one")

    def test_composed_rebind_preserves_a_usage_limit_freeze(self):
        # holds the recovery must NOT touch: a usage-limit freeze names
        # capacity, not a credential — the composed landing proceeds and the
        # freeze stays exactly as it was, with no wake pretending otherwise
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        slug = "r2c-limit"
        org = self._frozen_worker(slug, src["id"], cause="limit")
        n = org.node("worker")
        kept = dict(n["frozen"])
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "seq": 1, "account": b["id"]}
        n["pending_account"] = {"account": c["id"], "from": src["id"],
                                "by": "USER", "at": self.T2, "seq": 2}
        wake, account_wake = [], []
        supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=wake, account_wake=account_wake)
        fresh = org.node("worker")
        self.assertEqual(fresh["account"], c["id"])
        self.assertEqual(fresh.get("frozen"), kept,
                         "a capacity hold is not a credential recovery's to clear")
        self.assertEqual((wake, account_wake), ([], []))

    def test_composed_thaw_via_reconcile_wakes_exactly_once(self):
        # the startup path exercises the SAME helper and must show the same
        # single-wake contract after ITS save
        src = self._account("claude", "src")
        b = self._account("claude", "b")
        c = self._account("claude", "c")
        slug = "r2c-reconcile"
        org = self._frozen_worker(slug, src["id"])
        n = org.node("worker")
        n["pending_switch"] = {"tier": "sonnet", "from": "opus", "by": "USER",
                               "at": self.T1, "crossing": False,
                               "seq": 1, "account": b["id"]}
        n["pending_account"] = {"account": c["id"], "from": src["id"],
                                "by": "USER", "at": self.T2, "seq": 2}
        store.save_org(org)
        with patch.object(supervisor, "drive_auth_thaw") as thaw, \
                patch.object(supervisor, "drive_account_unpark") as unpark, \
                patch.object(supervisor, "drive_unfrozen_by_switch") as sw, \
                patch.object(supervisor, "send_message") as send:
            supervisor.reconcile(slug)
        fresh = store.load_org(slug).node("worker")
        self.assertEqual(fresh["model"], "sonnet")
        self.assertEqual(fresh["account"], c["id"])
        self.assertNotIn("frozen", fresh)
        self.assertNotIn("pending_switch", fresh)
        self.assertNotIn("pending_account", fresh)
        thaw.assert_called_once_with(slug, "worker")
        unpark.assert_not_called()
        sw.assert_not_called()
        self.assertEqual([k for k in send.call_args_list
                          if k.args[:2] == (slug, "worker")], [],
                         "no generic revive doubles the composed thaw wake")


if __name__ == "__main__":
    unittest.main()
