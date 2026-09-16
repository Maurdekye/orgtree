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
                                           actor="USER")
        # the refusal names the supported recovery path
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


if __name__ == "__main__":
    unittest.main()
