"""Removing a secondary account by rebinding its agents (user ticket
2026-09-21).

What is asserted here, in the ticket's own order: the coordinated operation
moves EVERY stored binding — live, halted, frozen, archived, the queued
intents and the org default — to the provider's primary and then removes the
row; the in-flight-turn boundary is enforced in both directions (a rebind that
owes no session boundary moves now, one that does refuses while the turn
runs); a forced failure leaves NOTHING rebound and the account registered;
an unused secondary still removes and a primary account still does not.
"""
import asyncio
import os
import sys
import tempfile
import unittest


import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


class AccountRemovalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-acctrm-")
        os.environ["ORGTREE_DATA"] = cls.root
        # the session-archive path prints; a cp1252 console would turn that
        # pre-existing print into an error unrelated to what is asserted
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="replace")
        from engine.backend.orgtree import (account_removal, api, ledger,
                                            registry, store, supervisor)
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.removal = account_removal
        cls.api = api
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor

    def setUp(self):
        # Each test starts with NO organizations: these assertions are about
        # which bindings a removal finds across the whole fleet, so an org
        # another test left behind would be counted by this one. The registry
        # is deliberately NOT reset — its id counter only goes up, and that is
        # what keeps every test's account id unique across the shared data
        # root.
        orgs = self.store._orgs_dir()
        for name in os.listdir(orgs) if os.path.isdir(orgs) else []:
            if name.endswith((".json", ".db")):
                try:
                    os.unlink(os.path.join(orgs, name))
                except OSError:
                    pass

    _seq = 0

    def _row(self, provider="claude"):
        AccountRemovalTests._seq += 1
        return self.registry.create_account(
            provider, "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"rm-{self._seq}")})

    def _node(self, model="opus", account=None, state="live", **extra):
        node = {"state": state, "parent": None, "generation": 1,
                "model": model, "grant": 50, "free": 50,
                "session_id": "sid-0", "scope": {}, **extra}
        if account:
            node["account"] = account
        return node

    def _org(self, slug, nodes=None, save=True, **doc):
        org = self.ledger.Org.create(slug)
        for nid, node in (nodes or {"root": self._node()}).items():
            org.nodes[nid] = node
        org.d.update(doc)
        if save:
            self.store.save_org(org)
        return org

    def _remove(self, account_id, actor="USER"):
        return self.removal.remove_account_rebinding_agents(
            account_id, actor=actor)

    # ------------------------------------------------- the main coordinated act
    def test_every_stored_binding_moves_to_primary_and_the_row_goes(self):
        row = self._row()
        self._org("rm-main", {
            "root": self._node(account=row["id"]),
            "halted": self._node(account=row["id"],
                                 halt={"phase": "halted", "at": "now"}),
            "bearer": self._node(account=row["id"], state="archived"),
            "other": self._node(),
        })
        out = self._remove(row["id"])
        self.assertEqual(out["removed"], row["id"])
        self.assertEqual({r["node"] for r in out["rebound"]},
                         {"root", "halted", "bearer"})
        org = self.store.load_org("rm-main")
        for nid in ("root", "halted", "bearer"):
            node = org.node(nid)
            self.assertNotIn("account", node, nid)
            self.assertTrue(node.get("account_primary"), nid)
        # untouched neighbours stay untouched, and the halt is not a rebind
        # side effect to be cleared
        self.assertTrue(org.node("halted").get("halt"))
        self.assertNotIn("account", org.node("other"))
        with self.assertRaises(self.registry.UnknownAccount):
            self.registry.get_account(row["id"])

    def test_archived_binding_moves_so_a_rehire_comes_back_on_primary(self):
        # rehire does not touch `account`: an archived binding left behind
        # would be a live binding again the moment the bearer is rehired
        row = self._row()
        self._org("rm-bearer", {
            "root": self._node(),
            "kid": self._node(account=row["id"], state="archived",
                              parent="root", bearer_state="knowledge"),
        })
        self._remove(row["id"])
        node = self.store.load_org("rm-bearer").node("kid")
        self.assertNotIn("account", node)
        self.assertTrue(node.get("account_primary"))
        self.assertEqual(node["state"], "archived")   # lifecycle untouched
        self.assertEqual(node.get("bearer_state"), "knowledge")

    def test_agent_identity_and_placement_survive_the_rebind(self):
        row = self._row()
        self._org("rm-keep", {
            "root": self._node(),
            "kid": self._node(account=row["id"], parent="root",
                              charter="do the thing",
                              scope={"add_dirs": [], "tools": {}}),
        })
        before = dict(self.store.load_org("rm-keep").node("kid"))
        self._remove(row["id"])
        after = self.store.load_org("rm-keep").node("kid")
        self.assertEqual(after.get("parent"), before.get("parent"))
        self.assertEqual(after.get("charter"), before.get("charter"))
        self.assertEqual(after.get("generation"), before.get("generation"))
        self.assertEqual(after.get("session_id"), before.get("session_id"))
        self.assertEqual(after.get("grant"), before.get("grant"))

    # ------------------------------------------------------ lifecycle parity
    def test_auth_freeze_is_thawed_and_a_usage_limit_freeze_is_kept(self):
        row = self._row()
        self._org("rm-frozen", {
            "auth": self._node(account=row["id"],
                               frozen={"cause": "auth", "at": "now"}),
            "limit": self._node(account=row["id"],
                                frozen={"cause": "limit", "limit": True,
                                        "at": "now"}),
        })
        out = self._remove(row["id"])
        org = self.store.load_org("rm-frozen")
        # the auth freeze named a dead credential the rebind replaced
        self.assertIsNone(org.node("auth").get("frozen"))
        self.assertIn(("rm-frozen", "auth_thaw", "auth"), out["wakes"])
        # a usage-limit freeze is NOT cleared by moving the binding — the
        # node is rebound and stays frozen, exactly as a hand rebind leaves it
        self.assertTrue(org.node("limit").get("frozen"))
        self.assertNotIn("account", org.node("limit"))
        self.assertNotIn("account", org.node("auth"))

    def test_account_park_is_cleared_and_the_node_is_woken(self):
        row = self._row()
        self._org("rm-park", {
            "root": self._node(account=row["id"],
                               frozen={"cause": "account", "limit": True}),
        })
        out = self._remove(row["id"])
        org = self.store.load_org("rm-park")
        self.assertIsNone(org.node("root").get("frozen"))
        self.assertIn(("rm-park", "unpark", "root"), out["wakes"])

    def test_codex_rebind_takes_the_session_boundary(self):
        row = self._row(provider="openai")
        self._org("rm-codex", {
            "root": self._node(model="astra", account=row["id"],
                               codex_thread="thr-1", codex_account=row["id"]),
        })
        self._remove(row["id"])
        org = self.store.load_org("rm-codex")
        node = org.node("root")
        # the provider handles are gone and a knowledge bearer was archived
        self.assertNotIn("codex_thread", node)
        self.assertNotIn("codex_account", node)
        self.assertNotIn("account", node)
        bearers = [nid for nid, n in org.d["nodes"].items()
                   if n.get("state") == "archived"
                   and n.get("successor") == "root"]
        self.assertEqual(len(bearers), 1, org.d["nodes"].keys())
        self.assertEqual(org.d["nodes"][bearers[0]].get("bearer_state"),
                         "knowledge")

    # --------------------------------------------------- the in-flight turn
    def test_in_flight_claude_turn_rebinds_now_and_is_not_interrupted(self):
        # no session boundary is owed, so the binding moves while the turn
        # runs: the running process keeps the credential its spawn resolved
        # and the NEXT turn resolves primary. Nothing is queued and the turn's
        # own markers are untouched.
        row = self._row()
        self._org("rm-live", {
            "root": self._node(account=row["id"],
                               inflight={"op": "turn", "at": "now"}),
        })
        st = self.supervisor.state("rm-live", "root")
        st["busy"] = True
        try:
            out = self._remove(row["id"])
        finally:
            st["busy"] = False
        node = self.store.load_org("rm-live").node("root")
        self.assertNotIn("account", node)
        self.assertTrue(node.get("account_primary"))
        self.assertNotIn("pending_account", node)     # nothing deferred
        self.assertTrue(node.get("inflight"))         # the turn is untouched
        self.assertTrue(any(r["in_flight_turn"] for r in out["rebound"]))

    def test_in_flight_codex_turn_blocks_the_whole_removal(self):
        # the rebind owes an in-place session archive and that cannot be done
        # to a running turn — so the operation refuses ENTIRELY rather than
        # removing the row while a binding still names it
        row = self._row(provider="openai")
        self._org("rm-busy", {
            "root": self._node(model="astra", account=row["id"],
                               codex_thread="thr-1"),
            "idle": self._node(model="astra", account=row["id"]),
        })
        st = self.supervisor.state("rm-busy", "root")
        st["responding"] = True
        try:
            with self.assertRaises(self.removal.RemovalRefused) as ctx:
                self._remove(row["id"])
        finally:
            st["responding"] = False
        msg = str(ctx.exception)
        self.assertIn("rm-busy/root", msg)
        self.assertIn("session boundary", msg)
        # NOTHING moved — not even the idle sibling that could have moved
        org = self.store.load_org("rm-busy")
        self.assertEqual(org.node("root").get("account"), row["id"])
        self.assertEqual(org.node("idle").get("account"), row["id"])
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])
        # and once the turn ends the same call succeeds
        self._remove(row["id"])
        org = self.store.load_org("rm-busy")
        self.assertNotIn("account", org.node("idle"))

    # ------------------------------------------------------ queued intents
    def test_queued_intents_and_the_org_default_are_rebound_too(self):
        row = self._row()
        codex = self._row(provider="openai")
        self._org("rm-queued", {
            "qacct": self._node(pending_account={"account": row["id"],
                                                 "from": "primary",
                                                 "by": "USER", "at": "now"}),
            "qsame": self._node(pending_switch={"tier": "sonnet",
                                                "account": row["id"],
                                                "from": "opus", "by": "USER"}),
            "qcross": self._node(pending_switch={"tier": "astra",
                                                 "account": row["id"],
                                                 "from": "opus", "by": "USER"}),
        }, default_account=row["id"])
        self.assertTrue(codex["id"])
        self._remove(row["id"])
        org = self.store.load_org("rm-queued")
        self.assertEqual(org.node("qacct")["pending_account"]["account"],
                         "claude/primary")
        self.assertEqual(org.node("qsame")["pending_switch"]["account"],
                         "claude/primary")
        # the queued switch's TIER decides the provider whose primary replaces
        # the removed account
        self.assertEqual(org.node("qcross")["pending_switch"]["account"],
                         "openai/primary")
        self.assertEqual(org.d.get("default_account"), "claude/primary")

    # ----------------------------------------------------------- atomicity
    def test_a_forced_migration_failure_rebinds_nothing_and_keeps_the_row(self):
        row = self._row()
        self._org("rm-fail", {
            "a": self._node(account=row["id"]),
            "b": self._node(account=row["id"]),
            "c": self._node(account=row["id"], state="archived"),
        })
        real = self.supervisor.assign_account
        calls: list[str] = []

        def boom(slug, nid, account_id, **kw):
            calls.append(nid)
            if len(calls) > 1:
                raise RuntimeError("forced migration failure")
            return real(slug, nid, account_id, **kw)

        self.supervisor.assign_account = boom
        try:
            with self.assertRaises(RuntimeError) as ctx:
                self._remove(row["id"])
        finally:
            self.supervisor.assign_account = real
        self.assertIn("forced migration failure", str(ctx.exception))
        # the account is still registered and NO binding moved — not even the
        # one the first (successful) call had already applied in memory
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])
        org = self.store.load_org("rm-fail")
        for nid in ("a", "b", "c"):
            self.assertEqual(org.node(nid).get("account"), row["id"], nid)
            self.assertFalse(org.node(nid).get("account_primary"), nid)

    def test_a_forced_save_failure_keeps_the_account_registered(self):
        row = self._row()
        self._org("rm-save", {"a": self._node(account=row["id"])})
        real = self.store.save_org

        def boom(org):
            raise OSError("disk went away")

        self.store.save_org = boom
        try:
            with self.assertRaises(self.removal.RemovalRefused) as ctx:
                self._remove(row["id"])
        finally:
            self.store.save_org = real
        self.assertIn("Nothing was changed", str(ctx.exception))
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])
        self.assertEqual(
            self.store.load_org("rm-save").node("a").get("account"),
            row["id"])

    def test_an_unreadable_org_refuses_rather_than_reading_as_unbound(self):
        row = self._row()
        self._org("rm-ok", {"a": self._node(account=row["id"])})
        broken = os.path.join(self.store._orgs_dir(), "rm-broken.json")
        with open(broken, "w", encoding="utf-8") as f:
            f.write("{not json")
        try:
            with self.assertRaises(self.removal.RemovalRefused) as ctx:
                self._remove(row["id"])
        finally:
            os.unlink(broken)
        self.assertIn("rm-broken", str(ctx.exception))
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])
        self.assertEqual(
            self.store.load_org("rm-ok").node("a").get("account"), row["id"])

    # ------------------------------------------------------ the two edges
    def test_an_unused_secondary_still_removes(self):
        row = self._row()
        self._org("rm-none", {"root": self._node()})
        out = self._remove(row["id"])
        self.assertEqual(out["removed"], row["id"])
        self.assertEqual(out["rebound"], [])
        with self.assertRaises(self.registry.UnknownAccount):
            self.registry.get_account(row["id"])

    def test_a_primary_account_is_refused(self):
        row = self._row()
        doc = self.registry.load(strict=True)
        doc["aliases"]["primary"] = row["id"]
        self.registry.save(doc)
        try:
            with self.assertRaises(self.removal.RemovalRefused) as ctx:
                self._remove(row["id"])
        finally:
            doc = self.registry.load(strict=True)
            doc["aliases"].pop("primary", None)
            self.registry.save(doc)
        self.assertIn("primary", str(ctx.exception))
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])

    def test_an_unknown_account_is_not_found(self):
        with self.assertRaises(self.registry.UnknownAccount):
            self._remove("claude-999")

    # ------------------------------------------------------- the HTTP door
    def test_http_door_reports_what_moved_and_maps_the_refusals(self):
        from fastapi import HTTPException
        row = self._row()
        self._org("rm-http", {"root": self._node(account=row["id"])})
        out = asyncio.run(self.api.accounts_remove(row["id"]))
        self.assertEqual(out["removed"], row["id"])
        self.assertEqual(out["rebound"],
                         [{"org": "rm-http", "node": "root",
                           "state": "live", "in_flight_turn": False}])
        self.assertEqual(out["orgs"], ["rm-http"])
        self.assertNotIn("account", self.store.load_org("rm-http").node("root"))
        # the list endpoint no longer reports the row or its bindings
        listed = asyncio.run(self.api.accounts_list())
        self.assertNotIn(row["id"], [r["id"] for r in listed["accounts"]])
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(self.api.accounts_remove(row["id"]))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_http_door_refusal_is_a_422_naming_the_agent(self):
        from fastapi import HTTPException
        row = self._row(provider="openai")
        self._org("rm-http422", {
            "root": self._node(model="astra", account=row["id"],
                               codex_thread="thr-9"),
        })
        st = self.supervisor.state("rm-http422", "root")
        st["busy"] = True
        try:
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(self.api.accounts_remove(row["id"]))
        finally:
            st["busy"] = False
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("rm-http422/root", str(ctx.exception.detail))

    # --------------------------------------- PG-3f: one org_tx_multi, no DOC_LOCK
    # These use archived seats, queued intents and the org default only: a
    # LIVE seat goes through supervisor.assign_account, whose own DOC_LOCK is
    # PG-3e-B's to remove (it is lock-free with a caller-owned org there).
    def _settled_org(self, slug, nodes, **doc):
        self._org(slug, nodes, **doc)
        # the fixture writes raw node rows; one load+save reaches the fixed
        # point stored orgs sit at, so the org_tx writes only what it locks
        self.store.save_org(self.store.load_org(slug))

    def _in_thread(self, fn, timeout):
        import threading
        out: list = []

        def go():
            try:
                out.append(fn())
            except BaseException as e:                       # noqa: BLE001
                out.append(e)
        t = threading.Thread(target=go, daemon=True)
        t.start()
        t.join(timeout)
        return (not t.is_alive()), out, t

    def _hold(self, cm_factory):
        import threading
        entered, release = threading.Event(), threading.Event()

        def run():
            with cm_factory():
                entered.set()
                release.wait(30)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        self.assertTrue(entered.wait(10), "holder never entered")
        return release, t

    def _offline_bindings(self, slug, aid):
        self._settled_org(slug, {
            "root": self._node(),
            "old": self._node(account=aid, state="archived"),
            "q": self._node(pending_account={"account": aid, "from": "primary"}),
        }, default_account=aid)

    def test_removal_never_waits_on_the_document_lock(self):
        row = self._row()
        self._offline_bindings("rm-nolock", row["id"])
        release, holder = self._hold(lambda: self.store.DOC_LOCK)
        try:
            done, out, _ = self._in_thread(
                lambda: self._remove(row["id"]), 5.0)
        finally:
            release.set()
            holder.join(10)
        self.assertTrue(done, "removal waited on DOC_LOCK")
        self.assertNotIsInstance(out[0], BaseException, out)
        org = self.store.load_org("rm-nolock")
        self.assertNotIn("account", org.node("old"))
        self.assertEqual(org.node("q")["pending_account"]["account"],
                         "claude/primary")
        self.assertEqual(org.d["default_account"], "claude/primary")
        with self.assertRaises(self.registry.UnknownAccount):
            self.registry.get_account(row["id"])

    def test_removal_waits_for_a_bound_seat_held_by_another_tx(self):
        from engine.backend.orgtree import orgtx
        row = self._row()
        self._offline_bindings("rm-rowlock", row["id"])
        release, holder = self._hold(
            lambda: orgtx.org_tx("rm-rowlock", nodes=["old"]))
        try:
            done, _, t = self._in_thread(lambda: self._remove(row["id"]), 0.5)
            self.assertFalse(done, "removal did not wait for the seat row")
            # nothing has moved and the row is still registered while it waits
            self.assertEqual(
                self.store.load_org("rm-rowlock").node("old")["account"],
                row["id"])
            self.assertEqual(self.registry.get_account(row["id"])["id"],
                             row["id"])
        finally:
            release.set()
            holder.join(10)
        t.join(10)
        self.assertFalse(t.is_alive(), "removal never finished")
        self.assertNotIn("account", self.store.load_org("rm-rowlock").node("old"))

    def test_an_unrelated_seat_does_not_stop_the_removal(self):
        from engine.backend.orgtree import orgtx
        row = self._row()
        self._offline_bindings("rm-unrel", row["id"])
        release, holder = self._hold(
            lambda: orgtx.org_tx("rm-unrel", nodes=["root"]))
        try:
            done, out, _ = self._in_thread(lambda: self._remove(row["id"]), 5.0)
        finally:
            release.set()
            holder.join(10)
        self.assertTrue(done, "an unrelated seat row blocked the removal")
        self.assertNotIsInstance(out[0], BaseException, out)

    def test_a_binding_made_during_the_removal_keeps_the_account(self):
        # the phantom: an org the transaction did not lock gains a binding
        # after the plan was made. Removing the row then would strand it.
        row = self._row()
        self._offline_bindings("rm-ph-a", row["id"])
        self._settled_org("rm-ph-b", {"root": self._node()})
        real = self.removal._migrate_in_one_tx

        def and_bind_elsewhere(plan, actor):
            out = real(plan, actor)
            org = self.store.load_org("rm-ph-b")
            org.node("root")["account"] = row["id"]
            self.store.save_org(org)
            return out

        self.removal._migrate_in_one_tx = and_bind_elsewhere
        try:
            with self.assertRaises(self.removal.RemovalIncomplete) as ctx:
                self._remove(row["id"])
        finally:
            self.removal._migrate_in_one_tx = real
        self.assertIn("rm-ph-b", str(ctx.exception))
        self.assertEqual(self.registry.get_account(row["id"])["id"], row["id"])
        # what was migrated stays migrated, and a retry finishes the job
        self.assertNotIn("account", self.store.load_org("rm-ph-a").node("old"))
        out = self._remove(row["id"])
        self.assertEqual(out["orgs"], ["rm-ph-b"])
        with self.assertRaises(self.registry.UnknownAccount):
            self.registry.get_account(row["id"])

    def test_a_binding_that_moves_under_the_plan_is_replanned(self):
        # between the lock-free plan and the transaction, a seat the plan did
        # not name becomes bound: the transaction must not commit a migration
        # that misses it — it rolls back, plans again and moves both
        row = self._row()
        self._offline_bindings("rm-moved", row["id"])
        self._settled_org("rm-moved-x", {"root": self._node()})
        real = self.removal.plan_removal
        calls: list[int] = []

        def plan_then_bind(account_id):
            plan = real(account_id)
            if not calls:
                org = self.store.load_org("rm-moved")
                org.node("root")["pending_account"] = {
                    "account": row["id"], "from": "primary"}
                self.store.save_org(org)
            calls.append(1)
            return plan

        self.removal.plan_removal = plan_then_bind
        try:
            out = self._remove(row["id"])
        finally:
            self.removal.plan_removal = real
        self.assertGreaterEqual(len(calls), 3, "the plan was not re-made")
        org = self.store.load_org("rm-moved")
        self.assertEqual(org.node("root")["pending_account"]["account"],
                         "claude/primary")
        self.assertEqual(org.node("q")["pending_account"]["account"],
                         "claude/primary")
        self.assertEqual(out["removed"], row["id"])


if __name__ == "__main__":
    unittest.main()
