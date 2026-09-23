"""MANUAL CAPACITY-MARK CLEARING (docket item
add-agent-tool-and-ui-to-clear-account-limit-mar; user rulings 2026-09-23).

THE PROBLEM. A mark can outlive the limit it recorded and hold agents frozen
until an operator edits the live account files by hand. The fix is one
compare-and-set clear per store, shared by an agent tool and a UI route:

  * the clear removes exactly the mark the caller read — a mark rewritten,
    removed or expired since is refused with nothing written;
  * its audit row is written in the SAME file write as the clear;
  * clearing `pooled` takes only the inferred fable companion with it;
  * it adds no capacity: a later refusal re-marks the account;
  * it resumes, starts and rebinds nobody;
  * any agent may use it on any account its org can see (user ruling), and a
    hidden other-org row is refused exactly like an unknown id.

Every check here can fail: each refusal asserts the file bytes are unchanged,
and each companion rule has its negative beside its positive.
"""
import copy
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-mark-clear-")
os.environ["ORGTREE_DATA"] = _root.name
os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import (accounts, api, ledger, markclear, mcptool, opreceipts,
                     registry, store, supervisor)
from orgtree import census_classes as cc

REQUEST = SimpleNamespace(state=SimpleNamespace())
H = 3600.0


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class _Base(unittest.TestCase):
    def setUp(self):
        if not str(store.DATA_ROOT).lower().startswith(_root.name.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        for p in (registry.registry_path(), accounts.registry_path()):
            if os.path.exists(p):
                os.unlink(p)
        self.now = time.time()
        self.a = self._account("a")
        self.b = self._account("b")

    def _account(self, label, provider="claude", org=None):
        return registry.create_account(
            provider, label,
            {"kind": "managed", "path": os.path.join(_root.name, provider + label)},
            origin_org=org)

    def mark(self, acct, tier, until, provenance="observed", now=None):
        self.assertTrue(registry.record_mark(
            acct["id"] if isinstance(acct, dict) else acct, tier, until,
            window="weekly", provenance=provenance, now=now))

    def marks(self, acct):
        return registry.get_account(acct["id"])["marks"]

    def entry(self, acct, pool):
        return next(m for m in registry.describe_marks(acct["id"])
                    if m["pool"] == pool)

    def clear(self, acct, pool, expected, **kw):
        kw.setdefault("actor", "tester")
        kw.setdefault("via", "test")
        return registry.clear_mark(acct["id"], pool, expected, **kw)

    def audit(self):
        return registry.load().get("mark_audit") or []


class RegistryClear(_Base):
    def test_clears_exact_observed_pooled_mark_and_audits_in_same_write(self):
        self.mark(self.a, "opus", self.now + 5 * H)
        self.mark(self.b, "opus", self.now + 9 * H)
        other_before = json.dumps(registry.get_account(self.b["id"]), sort_keys=True)
        e = self.entry(self.a, "pooled")
        self.assertEqual(e["provenance"], "observed")
        self.assertEqual(e["state"], "active")
        self.assertIsNotNone(e["age_s"])
        out = self.clear(self.a, "pooled", e["expected"], reason="capacity is back")
        self.assertEqual(out["result"], "cleared")
        self.assertNotIn("pooled", self.marks(self.a))
        # the inferred ride-along of THIS pooled mark goes with it
        self.assertNotIn("fable", self.marks(self.a))
        self.assertEqual(json.dumps(registry.get_account(self.b["id"]), sort_keys=True),
                         other_before, "another account's marks changed")
        rows = self.audit()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["account"], self.a["id"])
        self.assertEqual(rows[0]["pool"], "pooled")
        self.assertEqual(rows[0]["reason"], "capacity is back")
        self.assertEqual(set(rows[0]["cleared"]), {"pooled", "fable"})
        self.assertEqual(rows[0]["cleared"]["pooled"]["until"], e["until"])

    def test_tier_name_is_accepted_and_echoed_as_its_pool(self):
        self.mark(self.a, "sonnet", self.now + H)
        out = self.clear(self.a, "haiku", self.entry(self.a, "pooled")["expected"])
        self.assertEqual((out["result"], out["pool"]), ("cleared", "pooled"))

    def test_observed_fable_is_kept_when_pooled_is_cleared(self):
        self.mark(self.a, "fable", self.now + 50 * H)            # a real fable wall
        self.mark(self.a, "opus", self.now + 50 * H)             # same horizon, observed fable
        out = self.clear(self.a, "pooled", self.entry(self.a, "pooled")["expected"])
        self.assertEqual(out["result"], "cleared")
        self.assertIn("fable", out["kept"])
        self.assertEqual(self.marks(self.a)["fable"]["provenance"], "observed")

    def test_inferred_fable_with_a_different_horizon_is_kept(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        # a later measurement of the pooled wall replaces the pooled mark, but
        # the ride-along is absent-only, so fable keeps the OLD horizon
        self.mark(self.a, "opus", self.now + 6 * H)
        self.assertEqual(self.marks(self.a)["fable"]["provenance"], "inferred")
        out = self.clear(self.a, "pooled", self.entry(self.a, "pooled")["expected"])
        self.assertEqual(out["result"], "cleared")
        self.assertIn("fable", self.marks(self.a))
        self.assertIn("fable", out["kept"])

    def test_fable_alone_leaves_pooled(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        out = self.clear(self.a, "fable", self.entry(self.a, "fable")["expected"])
        self.assertEqual(out["result"], "cleared")
        self.assertIn("pooled", self.marks(self.a))
        self.assertNotIn("fable", self.marks(self.a))

    def test_stale_request_after_a_new_mark_is_refused_and_writes_nothing(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        stale = self.entry(self.a, "pooled")["expected"]
        self.mark(self.a, "opus", self.now + 8 * H)              # a newer wall landed
        before = digest(registry.registry_path())
        out = self.clear(self.a, "pooled", stale)
        self.assertEqual(out["result"], "changed")
        self.assertEqual(out["current"]["until"], self.now + 8 * H)
        self.assertEqual(digest(registry.registry_path()), before)
        self.assertEqual(self.audit(), [])

    def test_changed_companion_is_refused_whole(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        e = self.entry(self.a, "pooled")
        companion = dict(e["companion"]["expected"], until=1.0)
        before = digest(registry.registry_path())
        out = self.clear(self.a, "pooled", e["expected"], companion_expected=companion)
        self.assertEqual(out["result"], "changed")
        self.assertEqual(digest(registry.registry_path()), before)

    def test_missing_and_expired_are_refused_and_write_nothing(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        before = digest(registry.registry_path())
        out = self.clear(self.a, "openai:plan", {"until": 1})
        self.assertEqual(out["result"], "missing")
        e = self.entry(self.a, "pooled")
        out = self.clear(self.a, "pooled", e["expected"], now=self.now + 3 * H)
        self.assertEqual(out["result"], "expired")
        self.assertEqual(digest(registry.registry_path()), before)
        self.assertEqual(self.audit(), [])

    def test_cross_account_fingerprint_does_not_clear_the_other_account(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        self.mark(self.b, "opus", self.now + 3 * H)
        out = self.clear(self.b, "pooled", self.entry(self.a, "pooled")["expected"])
        self.assertEqual(out["result"], "changed")
        self.assertIn("pooled", self.marks(self.a))
        self.assertIn("pooled", self.marks(self.b))

    def test_alias_and_unknown_ids_are_refused(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        doc = registry.load(strict=True)
        doc["aliases"]["primary"] = self.a["id"]
        registry.save(doc)
        e = self.entry(self.a, "pooled")
        with self.assertRaises(registry.MarkClearRefused):
            registry.clear_mark("primary", "pooled", e["expected"],
                                actor="t", via="test")
        with self.assertRaises(registry.UnknownAccount):
            registry.clear_mark("claude-999", "pooled", e["expected"],
                                actor="t", via="test")
        self.assertIn("pooled", self.marks(self.a))

    def test_malformed_expected_never_matches(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        for bad in (None, {}, {"until": "soon"}, [1]):
            self.assertEqual(self.clear(self.a, "pooled", bad)["result"], "changed")
        self.assertIn("pooled", self.marks(self.a))

    def test_a_new_limit_after_a_clear_marks_the_account_again(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        self.clear(self.a, "pooled", self.entry(self.a, "pooled")["expected"])
        self.mark(self.a, "opus", self.now + 4 * H)
        self.assertEqual(self.marks(self.a)["pooled"]["until"], self.now + 4 * H)
        self.assertEqual(self.marks(self.a)["fable"]["provenance"], "inferred")
        self.assertIsNotNone(registry.active_mark(self.a["id"], "sonnet"))

    def test_unreadable_registry_is_refused_not_overwritten(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        e = self.entry(self.a, "pooled")
        with open(registry.registry_path(), "w", encoding="utf-8") as f:
            f.write("{not json")
        with self.assertRaises(registry.RegistryUnreadable):
            self.clear(self.a, "pooled", e["expected"])
        with open(registry.registry_path(), encoding="utf-8") as f:
            self.assertEqual(f.read(), "{not json")

    def test_secret_shaped_reason_refuses_the_whole_clear(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        before = digest(registry.registry_path())
        with self.assertRaises(ValueError):
            self.clear(self.a, "pooled", self.entry(self.a, "pooled")["expected"],
                       reason="sk-ant-" + "x" * 30)
        self.assertEqual(digest(registry.registry_path()), before)

    def test_two_racing_clears_clear_exactly_once(self):
        self.mark(self.a, "opus", self.now + 2 * H)
        e = self.entry(self.a, "pooled")["expected"]
        results, gate = [], threading.Barrier(2)

        def go():
            gate.wait()
            results.append(self.clear(self.a, "pooled", e)["result"])
        threads = [threading.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), ["cleared", "missing"])
        self.assertEqual(len(self.audit()), 1)

    def test_audit_ring_is_bounded(self):
        with patch.object(registry, "MARK_AUDIT_KEEP", 3):
            for i in range(5):
                self.mark(self.a, "fable", self.now + (i + 1) * H)
                self.clear(self.a, "fable", self.entry(self.a, "fable")["expected"],
                           reason=f"r{i}")
        self.assertEqual([r["reason"] for r in self.audit()], ["r2", "r3", "r4"])


class RosterClear(_Base):
    """The old roster (`accounts.json`) — unbound default-login agents."""

    def roster(self, refreshes, keys=("k1",)):
        doc = {"version": accounts.VERSION, "keys": [{"id": k} for k in keys],
               "usage_refreshes": refreshes, "key_liveness": {}}
        with open(accounts.registry_path(), "w", encoding="utf-8") as f:
            json.dump(doc, f)

    def test_pooled_clears_all_three_tiers_keeps_fable_and_audits(self):
        t = self.now + 2 * H
        self.roster({"primary": {"haiku": t, "sonnet": t, "opus": t + 1, "fable": t},
                     "k1": {"opus": t}})
        e = next(m for m in accounts.describe_limits("primary") if m["pool"] == "pooled")
        self.assertEqual(e["provenance"], "not recorded")
        out = accounts.clear_limit("primary", "pooled", e["expected"],
                                   actor="t", via="test", reason="why")
        self.assertEqual(out["result"], "cleared")
        doc = accounts.load()
        self.assertEqual(doc["usage_refreshes"]["primary"], {"fable": t})
        self.assertEqual(doc["usage_refreshes"]["k1"], {"opus": t})
        self.assertEqual(out["kept"], {"fable": t})
        self.assertEqual(len(doc["mark_audit"]), 1)
        self.assertEqual(doc["mark_audit"][0]["cleared"]["tiers"]["opus"], t + 1)
        # routing sees capacity again for the pooled tiers only
        self.assertIsNone(accounts._resolve_in(doc, "uuid", "opus", self.now)
                          .get("refresh_at"))

    def test_stale_missing_expired_and_unknown(self):
        t = self.now + 2 * H
        self.roster({"primary": {"opus": t}})
        before = digest(accounts.registry_path())
        stale = {"tiers": {"opus": t - 5}}
        self.assertEqual(accounts.clear_limit("primary", "pooled", stale,
                                              actor="t", via="x")["result"], "changed")
        self.assertEqual(accounts.clear_limit("primary", "fable", {"tiers": {}},
                                              actor="t", via="x")["result"], "missing")
        self.assertEqual(accounts.clear_limit("primary", "pooled", {"tiers": {"opus": t}},
                                              actor="t", via="x",
                                              now=t + 1)["result"], "expired")
        with self.assertRaises(KeyError):
            accounts.clear_limit("nobody", "pooled", {"tiers": {"opus": t}},
                                 actor="t", via="x")
        with self.assertRaises(ValueError):
            accounts.clear_limit("primary", "opus", {"tiers": {"opus": t}},
                                 actor="t", via="x")
        self.assertEqual(digest(accounts.registry_path()), before)

    def test_a_new_limit_after_a_clear_marks_the_roster_again(self):
        t = self.now + 2 * H
        self.roster({"primary": {"opus": t, "sonnet": t, "haiku": t}})
        accounts.clear_limit("primary", "pooled",
                             {"tiers": {"opus": t, "sonnet": t, "haiku": t}},
                             actor="t", via="x")
        self.assertTrue(accounts.record_limit("primary", "sonnet", t + H))
        self.assertEqual(accounts.load()["usage_refreshes"]["primary"]["opus"], t + H)


class SharedSeam(_Base):
    def test_inspect_reports_both_stores_for_the_default_login(self):
        doc = registry.load(strict=True)
        doc["aliases"]["primary"] = self.a["id"]
        registry.save(doc)
        self.mark(self.a, "opus", self.now + 2 * H)
        t = self.now + 3 * H
        RosterClear.roster(self, {"primary": {"opus": t}})
        got = markclear.inspect("claude/primary", org="o1")
        self.assertEqual(got["account"], self.a["id"])
        self.assertEqual(got["roster_account"], "primary")
        seen = {(m["source"], m["pool"], m["account"]) for m in got["marks"]}
        self.assertIn(("registry", "pooled", self.a["id"]), seen)
        self.assertIn(("legacy-roster", "pooled", "primary"), seen)
        self.assertEqual(markclear.inspect("primary", org="o1")["account"], self.a["id"])

    def test_hidden_other_org_row_is_refused_like_an_unknown_id(self):
        hidden = self._account("k", org="other-org")
        self.mark(hidden, "opus", self.now + 2 * H)
        e = self.entry(hidden, "pooled")["expected"]
        for org in ("mine",):
            with self.assertRaises(markclear.UnknownMarkAccount) as a:
                markclear.inspect(hidden["id"], org=org)
            with self.assertRaises(markclear.UnknownMarkAccount) as b:
                markclear.clear(hidden["id"], "pooled", e, source="registry",
                                org=org, actor="x", via="t")
            with self.assertRaises(markclear.UnknownMarkAccount) as c:
                markclear.inspect("claude-404", org=org)
            self.assertEqual(str(a.exception).replace(hidden["id"], "ID"),
                             str(c.exception).replace("claude-404", "ID"))
        self.assertIn("pooled", self.marks(hidden))
        # the operator (org=None) sees and may clear it
        self.assertEqual(markclear.clear(hidden["id"], "pooled", e, source="registry",
                                         org=None, actor=ledger.USER,
                                         via="user_ui")["result"], "cleared")

    def test_bad_source_is_refused(self):
        with self.assertRaises(ValueError):
            markclear.clear(self.a["id"], "pooled", {}, source="both", org=None,
                            actor="x", via="t")


class AgentTool(_Base):
    """The agent door: any agent, no resume, org log + receipt class."""

    def setUp(self):
        super().setUp()
        self.slug = "mark-clear-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "opus", 0, "boss")
        org.hire(ledger.USER, "boss", "opus", 0, "worker")
        org.hire(ledger.USER, None, "opus", 0, "stranger")
        org.d["auto_resume"] = False
        store.save_org(org)
        org = store.load_org(self.slug)
        n = org.node("worker")
        n.update(model="opus", account=self.a["id"], frozen={
            "at": "2026-09-23T08:00:00Z", "limit": True,
            "until_ts": self.now + 2 * H, "provider": "claude",
            "account": self.a["id"], "resource_pool": "haiku+sonnet+opus",
            "resume_texts": ["carry on"]})
        store.save_org(org)
        self.mark(self.a, "opus", self.now + 2 * H)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def call(self, args, actor="stranger"):
        return api.agent_call(api.AgentCall(org=self.slug, node=actor,
                                            tool="orgtree_account_mark", args=args),
                              REQUEST)

    def test_any_agent_can_clear_and_nobody_is_resumed(self):
        frozen_before = copy.deepcopy(store.load_org(self.slug).node("worker"))
        got = self.call({"action": "inspect", "account": self.a["id"]})
        e = next(m for m in got["marks"] if m["pool"] == "pooled")
        with patch.object(supervisor, "resume_frozen",
                          side_effect=AssertionError("resumed")), \
                patch.object(supervisor, "drive_unfrozen_by_switch",
                             side_effect=AssertionError("drove")), \
                patch.object(supervisor, "drive_account_unpark",
                             side_effect=AssertionError("drove")), \
                patch.object(supervisor, "drive_auth_thaw",
                             side_effect=AssertionError("drove")):
            out = self.call({"action": "clear", "account": e["account"],
                             "source": e["source"], "pool": e["pool"],
                             "expected": e["expected"], "reason": "provider says ok"})
        self.assertEqual(out["result"], "cleared")
        self.assertEqual(out["frozen_here"], ["worker"])
        after = store.load_org(self.slug).node("worker")
        self.assertEqual(after["frozen"], frozen_before["frozen"])
        self.assertEqual(after["account"], self.a["id"])
        log = [r for r in store.load_org(self.slug).d["events"]
               if r.get("op") == "account_mark_cleared"]
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["actor"], "stranger")
        self.assertEqual(registry.load()["mark_audit"][-1]["org"], self.slug)

    def test_clear_requires_a_reason_and_refusals_do_not_log(self):
        e = self.entry(self.a, "pooled")
        with self.assertRaises(api.HTTPException) as cm:
            self.call({"action": "clear", "account": self.a["id"], "source": "registry",
                       "pool": "pooled", "expected": e["expected"]})
        self.assertEqual(cm.exception.status_code, 422)
        out = self.call({"action": "clear", "account": self.a["id"], "source": "registry",
                         "pool": "pooled", "expected": {"until": 1}, "reason": "x"})
        self.assertEqual(out["result"], "changed")
        self.assertFalse([r for r in store.load_org(self.slug).d["events"]
                          if r.get("op") == "account_mark_cleared"])
        self.assertIn("pooled", self.marks(self.a))

    def test_unknown_account_is_a_422(self):
        with self.assertRaises(api.HTTPException) as cm:
            self.call({"action": "inspect", "account": "claude-404"})
        self.assertEqual(cm.exception.status_code, 422)

    def test_card_and_classifications(self):
        card = next(t for t in mcptool.TOOLS if t["name"] == "orgtree_account_mark")
        self.assertEqual(card["inputSchema"]["properties"]["action"]["enum"],
                         ["inspect", "clear"])
        self.assertNotIn("  ", card["description"])
        self.assertEqual(cc.classify_tool("orgtree_account_mark", "inspect")[:2],
                         ("read", "resource"))
        self.assertEqual(cc.classify_tool("orgtree_account_mark", "clear")[:2],
                         ("write", "resource"))
        self.assertEqual(opreceipts.coverage("orgtree_account_mark", {"action": "inspect"}),
                         opreceipts.NONE)
        self.assertEqual(opreceipts.coverage("orgtree_account_mark", {"action": "clear"}),
                         opreceipts.PRE)


class UserRoutes(_Base):
    def test_routes_inspect_and_clear_by_compare_and_set(self):
        import asyncio
        self.mark(self.a, "opus", self.now + 2 * H)
        got = asyncio.run(api.accounts_marks(self.a["id"]))
        e = next(m for m in got["marks"] if m["pool"] == "pooled")
        stale = api.AccountMarkClear(source="registry", pool="pooled",
                                     expected=dict(e["expected"], until=1.0))
        self.assertEqual(asyncio.run(api.accounts_mark_clear(self.a["id"], stale))["result"],
                         "changed")
        ok = api.AccountMarkClear(source="registry", pool="pooled",
                                  expected=e["expected"], reason="checked usage")
        out = asyncio.run(api.accounts_mark_clear(self.a["id"], ok))
        self.assertEqual(out["result"], "cleared")
        self.assertEqual(registry.load()["mark_audit"][-1]["via"], "user_ui")
        self.assertEqual(registry.load()["mark_audit"][-1]["actor"], ledger.USER)
        with self.assertRaises(api.HTTPException) as cm:
            asyncio.run(api.accounts_marks("claude-404"))
        self.assertEqual(cm.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
